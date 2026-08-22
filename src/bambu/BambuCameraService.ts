import tls from 'tls';
import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { logger } from '../logger/logger.js';

export interface CameraStatus {
  connected: boolean;
  source: 'rtsp' | 'tls6000' | 'none';
  rtspUrl: string;
  lastFrameAt: string | null;
  frameWidth: number | null;
  frameHeight: number | null;
  fps: number;
  bytesReceived: number;
  framesReceived: number;
  lastError: string | null;
}

export class BambuCameraService extends EventEmitter {
  private host: string;
  private accessCode: string;
  private customRtspUrl: string | null = null;

  // Frame state
  private latestFrame: Buffer | null = null;
  private lastFrameAt: string | null = null;
  private frameWidth: number | null = null;
  private frameHeight: number | null = null;
  private bytesReceived = 0;
  private framesReceived = 0;
  private lastError: string | null = null;

  // FPS Tracking
  private frameTimestamps: number[] = [];
  private currentFps = 0;

  // Stream processes & timers
  private ffmpegProcess: ChildProcess | null = null;
  private ffmpegReconnectTimer: NodeJS.Timeout | null = null;
  private activeSource: 'rtsp' | 'tls6000' | 'none' = 'none';

  // TLS 6000 Diagnostic state
  private tlsSocket: tls.TLSSocket | null = null;
  private tlsConnected = false;
  private tlsBytesReceived = 0;
  private tlsFirstPacketHex = '';
  private tlsJpegStart = false;
  private tlsJpegEnd = false;

  constructor(host: string, accessCode: string) {
    super();
    this.host = host;
    this.accessCode = accessCode;
  }

  public updateRtspUrl(url: string | undefined): void {
    if (url && url !== this.customRtspUrl) {
      logger.info({ rawRtspUrl: this.redactUrl(url) }, 'Updating camera RTSP URL from MQTT telemetry');
      this.customRtspUrl = url;
      if (this.activeSource === 'rtsp') {
        this.restartFFmpeg();
      }
    }
  }

  public getStatus(): CameraStatus {
    const isConnected = (this.activeSource === 'rtsp' && this.ffmpegProcess !== null && this.framesReceived > 0) || this.tlsConnected;
    return {
      connected: isConnected,
      source: this.activeSource,
      rtspUrl: this.redactUrl(this.getEffectiveRtspUrl(false)),
      lastFrameAt: this.lastFrameAt,
      frameWidth: this.frameWidth,
      frameHeight: this.frameHeight,
      fps: this.currentFps,
      bytesReceived: this.bytesReceived,
      framesReceived: this.framesReceived,
      lastError: this.lastError,
    };
  }

  public getLatestFrame(): Buffer | null {
    return this.latestFrame;
  }

  public start(): void {
    logger.info('Starting BambuCameraService pipeline...');
    this.startFFmpegStream();
    this.startTls6000Diagnostic();
  }

  public stop(): void {
    logger.info('Stopping BambuCameraService pipeline...');
    this.stopFFmpeg();
    this.stopTls6000Diagnostic();
    this.activeSource = 'none';
  }

  public forceReconnect(): void {
    logger.info('Manual camera reconnection requested');
    this.stop();
    setTimeout(() => this.start(), 500);
  }

  // --- RTSP / RTSPS FFmpeg Pipeline ---

  private getEffectiveRtspUrl(includeAuth: boolean): string {
    if (this.customRtspUrl && this.customRtspUrl.startsWith('rtsps://')) {
      if (!includeAuth) return this.customRtspUrl;
      // Inject credential into rtsps://
      const match = this.customRtspUrl.match(/^rtsps:\/\/([^@]+@)?(.*)$/);
      if (match) {
        return `rtsps://bblp:${this.accessCode}@${match[2]}`;
      }
      return this.customRtspUrl;
    }

    if (includeAuth) {
      return `rtsps://bblp:${this.accessCode}@${this.host}:322/streaming/live/1`;
    }
    return `rtsps://bblp:****@${this.host}:322/streaming/live/1`;
  }

  private redactUrl(url: string): string {
    if (!url) return '';
    return url.replace(/rtsps:\/\/([^:]+):([^@]+)@/, 'rtsps://$1:****@');
  }

  private startFFmpegStream(): void {
    if (this.ffmpegProcess) return;

    const ffmpegBinary = ffmpegInstaller.path;
    const targetUrl = this.getEffectiveRtspUrl(true);
    const displayUrl = this.redactUrl(targetUrl);

    logger.info({ ffmpegBinary, targetUrl: displayUrl }, 'Spawning FFmpeg RTSPS Stream Transcoder...');

    const args = [
      '-rtsp_transport', 'tcp',
      '-i', targetUrl,
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-q:v', '5',
      '-r', '15',
      '-'
    ];

    try {
      const process = spawn(ffmpegBinary, args);
      this.ffmpegProcess = process;
      this.activeSource = 'rtsp';
      let buffer = Buffer.alloc(0);

      process.stdout.on('data', (chunk: Buffer) => {
        this.bytesReceived += chunk.length;
        buffer = Buffer.concat([buffer, chunk]);

        while (buffer.length > 0) {
          const startIndex = buffer.indexOf(Buffer.from([0xff, 0xd8]));
          if (startIndex === -1) {
            if (buffer.length > 1024 * 1024) buffer = Buffer.alloc(0);
            break;
          }

          const endIndex = buffer.indexOf(Buffer.from([0xff, 0xd9]), startIndex);
          if (endIndex === -1) {
            if (startIndex > 0) buffer = buffer.subarray(startIndex);
            break;
          }

          const frame = buffer.subarray(startIndex, endIndex + 2);
          buffer = buffer.subarray(endIndex + 2);

          if (frame.length > 100) {
            this.handleNewJpegFrame(frame);
          }
        }
      });

      process.stderr.on('data', (chunk: Buffer) => {
        const stderrText = chunk.toString('utf8');
        const redactedText = this.redactUrl(stderrText);

        // Detect resolution from FFmpeg log
        const resMatch = redactedText.match(/(\d{3,4}x\d{3,4})/);
        if (resMatch && (!this.frameWidth || !this.frameHeight)) {
          const [w, h] = resMatch[1].split('x').map(Number);
          if (w && h) {
            this.frameWidth = w;
            this.frameHeight = h;
          }
        }

        // Log FFmpeg errors/warnings without swallowing
        if (redactedText.toLowerCase().includes('error') || redactedText.toLowerCase().includes('fail')) {
          this.lastError = redactedText.trim().split('\n').pop() || 'FFmpeg error';
          logger.warn({ stderr: this.lastError }, '[FFmpeg RTSP Warning]');
        }
      });

      process.on('close', (code) => {
        logger.warn({ code }, '[FFmpeg RTSP Process Exited]');
        this.ffmpegProcess = null;
        if (this.activeSource === 'rtsp') {
          this.scheduleFFmpegReconnect();
        }
      });

      process.on('error', (err) => {
        this.lastError = `FFmpeg spawn error: ${err.message}`;
        logger.error({ error: err.message }, '[FFmpeg Spawn Failed]');
        this.ffmpegProcess = null;
        this.scheduleFFmpegReconnect();
      });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      logger.error({ error: this.lastError }, 'Failed to initialize FFmpeg stream');
      this.scheduleFFmpegReconnect();
    }
  }

  private handleNewJpegFrame(frame: Buffer): void {
    this.latestFrame = frame;
    this.lastFrameAt = new Date().toISOString();
    this.framesReceived++;
    this.lastError = null;

    // Parse width & height from JPEG SOF0 marker if missing
    if (!this.frameWidth || !this.frameHeight) {
      this.extractJpegDimensions(frame);
    }

    // FPS calculation
    const now = Date.now();
    this.frameTimestamps.push(now);
    this.frameTimestamps = this.frameTimestamps.filter((t) => now - t <= 2000);
    this.currentFps = Math.round((this.frameTimestamps.length / 2) * 10) / 10;

    this.emit('frame', frame);
  }

  private extractJpegDimensions(frame: Buffer): void {
    try {
      let offset = 2;
      while (offset < frame.length - 8) {
        if (frame[offset] === 0xff && (frame[offset + 1] === 0xc0 || frame[offset + 1] === 0xc2)) {
          this.frameHeight = frame.readUInt16BE(offset + 5);
          this.frameWidth = frame.readUInt16BE(offset + 7);
          break;
        }
        offset += 2 + frame.readUInt16BE(offset + 2);
      }
    } catch (err) {
      // Ignore dimension parse failure
    }
  }

  private restartFFmpeg(): void {
    this.stopFFmpeg();
    this.startFFmpegStream();
  }

  private stopFFmpeg(): void {
    if (this.ffmpegReconnectTimer) {
      clearTimeout(this.ffmpegReconnectTimer);
      this.ffmpegReconnectTimer = null;
    }
    if (this.ffmpegProcess) {
      this.ffmpegProcess.removeAllListeners();
      this.ffmpegProcess.kill('SIGKILL');
      this.ffmpegProcess = null;
    }
  }

  private scheduleFFmpegReconnect(): void {
    if (this.ffmpegReconnectTimer) return;
    this.ffmpegReconnectTimer = setTimeout(() => {
      this.ffmpegReconnectTimer = null;
      this.startFFmpegStream();
    }, 3000);
  }

  // --- TLS 6000 Experimental / Diagnostic Mode ---

  private startTls6000Diagnostic(): void {
    if (this.tlsSocket || !this.host) return;

    logger.info({ host: this.host, port: 6000 }, '[TLS 6000 Diagnostic] Initiating experimental TLS connection...');

    const socket = tls.connect(
      {
        host: this.host,
        port: 6000,
        rejectUnauthorized: false,
        timeout: 5000,
      },
      () => {
        this.tlsConnected = true;
        const cert = socket.getPeerCertificate();
        logger.info({
          host: this.host,
          authorized: socket.authorized,
          certSubject: cert ? cert.subject?.CN : 'Self-signed/None',
        }, '[TLS 6000 Diagnostic] Connected & Authenticated');

        this.sendTls6000Handshake(socket);
      }
    );

    this.tlsSocket = socket;

    socket.on('data', (data: Buffer) => {
      this.tlsBytesReceived += data.length;
      if (!this.tlsFirstPacketHex) {
        this.tlsFirstPacketHex = data.subarray(0, 64).toString('hex');
      }

      if (data.indexOf(Buffer.from([0xff, 0xd8])) !== -1) this.tlsJpegStart = true;
      if (data.indexOf(Buffer.from([0xff, 0xd9])) !== -1) this.tlsJpegEnd = true;

      logger.debug({
        bytesReceived: this.tlsBytesReceived,
        firstPacketHex: this.tlsFirstPacketHex.substring(0, 32),
        jpegStart: this.tlsJpegStart,
        jpegEnd: this.tlsJpegEnd,
      }, '[TLS 6000 Diagnostic] Data packet received');

      if (!this.tlsJpegStart) {
        logger.info('[TLS 6000 Diagnostic] Protocol mismatch: Non-JPEG binary packet received on TLS port 6000 (RTSP pipeline is active)');
      }
    });

    socket.on('error', (err: Error) => {
      logger.debug({ error: err.message }, '[TLS 6000 Diagnostic] TLS connection error/unavailable');
      this.cleanupTls6000();
    });

    socket.on('close', () => {
      logger.debug('[TLS 6000 Diagnostic] Connection closed by printer');
      this.cleanupTls6000();
    });
  }

  private sendTls6000Handshake(socket: tls.TLSSocket): void {
    try {
      const usernameBuf = Buffer.from('bblp\0', 'utf8');
      const passwordBuf = Buffer.from(`${this.accessCode}\0`, 'utf8');
      const payloadBuf = Buffer.concat([usernameBuf, passwordBuf]);

      const header = Buffer.alloc(16);
      header.writeUInt32LE(0x40, 0);
      header.writeUInt32LE(0x30, 4);
      header.writeUInt32LE(payloadBuf.length, 8);
      header.writeUInt32LE(0, 12);

      socket.write(Buffer.concat([header, payloadBuf]));
      logger.info({ payloadLen: payloadBuf.length }, '[TLS 6000 Diagnostic] Handshake sent');
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, '[TLS 6000 Diagnostic] Handshake failed');
    }
  }

  private cleanupTls6000(): void {
    this.tlsConnected = false;
    if (this.tlsSocket) {
      this.tlsSocket.removeAllListeners();
      this.tlsSocket.destroy();
      this.tlsSocket = null;
    }
  }

  private stopTls6000Diagnostic(): void {
    this.cleanupTls6000();
  }
}
