import tls from 'tls';
import { EventEmitter } from 'events';
import { logger } from '../logger/logger.js';

export interface CameraInfo {
  host: string;
  accessCodeConfigured: boolean;
  rtspsUrl322: string;
  rtspsUrl554: string;
  port6000Active: boolean;
  lastFrameAt: string | null;
}

export class BambuCameraService extends EventEmitter {
  private host: string;
  private accessCode: string;
  private socket: tls.TLSSocket | null = null;
  private latestFrame: Buffer | null = null;
  private lastFrameAt: string | null = null;
  private isConnected = false;
  private isConnecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private buffer = Buffer.alloc(0);

  constructor(host: string, accessCode: string) {
    super();
    this.host = host;
    this.accessCode = accessCode;
  }

  public getCameraInfo(): CameraInfo {
    const maskedCode = this.accessCode ? '****' : '';
    return {
      host: this.host,
      accessCodeConfigured: Boolean(this.accessCode),
      rtspsUrl322: `rtsps://bblp:${this.accessCode}@${this.host}:322/streaming/live/1`,
      rtspsUrl554: `rtsps://bblp:${this.accessCode}@${this.host}:0554/live/0`,
      port6000Active: this.isConnected,
      lastFrameAt: this.lastFrameAt,
    };
  }

  public getLatestFrame(): Buffer | null {
    return this.latestFrame;
  }

  public start(): void {
    this.connect();
  }

  public stop(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.isConnected = false;
    this.isConnecting = false;
  }

  private connect(): void {
    if (this.isConnecting || this.isConnected || !this.host) return;

    this.isConnecting = true;
    logger.info({ host: this.host, port: 6000 }, 'Attempting Chamber Camera TLS connection (Port 6000)...');

    const socket = tls.connect(
      {
        host: this.host,
        port: 6000,
        rejectUnauthorized: false,
        timeout: 5000,
      },
      () => {
        this.isConnecting = false;
        this.isConnected = true;
        logger.info({ host: this.host }, 'Chamber Camera TLS port 6000 connected');
        this.sendAuthHandshake(socket);
      }
    );

    this.socket = socket;

    socket.on('data', (data: Buffer) => {
      this.handleData(data);
    });

    socket.on('error', (err: Error) => {
      logger.debug({ error: err.message }, 'Camera TLS port 6000 connection error/unavailable');
      this.cleanup();
    });

    socket.on('close', () => {
      this.cleanup();
    });

    socket.on('timeout', () => {
      socket.destroy();
      this.cleanup();
    });
  }

  private cleanup(): void {
    this.isConnected = false;
    this.isConnecting = false;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 10000);
  }

  private sendAuthHandshake(socket: tls.TLSSocket): void {
    try {
      const usernameBuf = Buffer.from('bblp\0', 'utf8');
      const passwordBuf = Buffer.from(`${this.accessCode}\0`, 'utf8');
      const payloadBuf = Buffer.concat([usernameBuf, passwordBuf]);

      const header = Buffer.alloc(16);
      header.writeUInt32LE(0x40000000, 0); // Magic
      header.writeUInt32LE(0x30000000, 4); // Cmd
      header.writeUInt32LE(payloadBuf.length, 8); // Payload len
      header.writeUInt32LE(0, 12); // Reserved

      socket.write(Buffer.concat([header, payloadBuf]));
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Failed to send camera auth handshake');
    }
  }

  private handleData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);

    // Parse JPEG frames (0xFFD8 start of image, 0xFFD9 end of image)
    while (this.buffer.length > 0) {
      const startIndex = this.buffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (startIndex === -1) {
        // Discard data before JPEG header
        if (this.buffer.length > 1024 * 1024) {
          this.buffer = Buffer.alloc(0);
        }
        break;
      }

      const endIndex = this.buffer.indexOf(Buffer.from([0xff, 0xd9]), startIndex);
      if (endIndex === -1) {
        // Incomplete frame, wait for more data
        if (startIndex > 0) {
          this.buffer = this.buffer.subarray(startIndex);
        }
        break;
      }

      // Extract complete JPEG frame
      const frame = this.buffer.subarray(startIndex, endIndex + 2);
      this.buffer = this.buffer.subarray(endIndex + 2);

      if (frame.length > 100) {
        this.latestFrame = frame;
        this.lastFrameAt = new Date().toISOString();
        this.emit('frame', frame);
      }
    }
  }
}
