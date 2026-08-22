import tls from 'tls';
import { spawn } from 'child_process';
import dotenv from 'dotenv';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

dotenv.config();

const host = process.env.BAMBU_HOST || '192.168.5.100';
const accessCode = process.env.BAMBU_ACCESS_CODE || 'cc6aa0a8';
const ffmpegPath = ffmpegInstaller.path;

console.log('==================================================');
console.log('BAMBU CAMERA DIAGNOSTIC TOOL');
console.log(`Host: ${host}, AccessCode Configured: ${Boolean(accessCode)}`);
console.log(`FFmpeg Executable: ${ffmpegPath}`);
console.log('==================================================\n');

async function testTls6000(): Promise<void> {
  console.log('--- [A. TESTING TLS PORT 6000] ---');
  return new Promise((resolve) => {
    let connected = false;
    let bytesReceived = 0;
    let firstPacketHex = '';
    let jpegStartFound = false;
    let jpegEndFound = false;
    let socketClosed = false;

    const timeout = setTimeout(() => {
      console.log(`[TLS 6000 Results]:
- connected: ${connected}
- bytesReceived: ${bytesReceived}
- firstPacketHex: ${firstPacketHex || 'NONE'}
- jpegSOI (FFD8): ${jpegStartFound}
- jpegEOI (FFD9): ${jpegEndFound}
- socketClosedPrematurely: ${socketClosed}`);
      if (socket) socket.destroy();
      resolve();
    }, 5000);

    const socket = tls.connect(
      {
        host,
        port: 6000,
        rejectUnauthorized: false,
        timeout: 4000,
      },
      () => {
        connected = true;
        console.log('[TLS 6000] TCP/TLS Connected successfully');

        // Send auth handshake
        const usernameBuf = Buffer.from('bblp\0', 'utf8');
        const passwordBuf = Buffer.from(`${accessCode}\0`, 'utf8');
        const payloadBuf = Buffer.concat([usernameBuf, passwordBuf]);

        const header = Buffer.alloc(16);
        header.writeUInt32LE(0x40, 0); // Magic 0x40
        header.writeUInt32LE(0x30, 4); // Cmd 0x30
        header.writeUInt32LE(payloadBuf.length, 8);
        header.writeUInt32LE(0, 12);

        socket.write(Buffer.concat([header, payloadBuf]));
        console.log('[TLS 6000] Auth handshake sent (16-byte header + payload)');
      }
    );

    socket.on('data', (chunk: Buffer) => {
      bytesReceived += chunk.length;
      if (!firstPacketHex) {
        firstPacketHex = chunk.subarray(0, 64).toString('hex');
      }
      if (chunk.indexOf(Buffer.from([0xff, 0xd8])) !== -1) jpegStartFound = true;
      if (chunk.indexOf(Buffer.from([0xff, 0xd9])) !== -1) jpegEndFound = true;
    });

    socket.on('error', (err) => {
      console.log(`[TLS 6000 Error]: ${err.message}`);
    });

    socket.on('close', () => {
      socketClosed = true;
      console.log('[TLS 6000] Socket closed by remote host');
    });
  });
}

async function testFFmpegRtsp(url: string, label: string): Promise<void> {
  console.log(`\n--- [B & C. TESTING RTSPS WITH FFMPEG (${label})] ---`);
  console.log(`Target URL: ${url.replace(accessCode, '****')}`);

  return new Promise((resolve) => {
    const args = [
      '-rtsp_transport', 'tcp',
      '-i', url,
      '-vframes', '5',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-'
    ];

    console.log(`[FFmpeg Command]: ${ffmpegPath} ${args.join(' ').replace(accessCode, '****')}`);

    const process = spawn(ffmpegPath, args);
    let stdoutBytes = 0;
    let framesFound = 0;
    let stderrText = '';
    let buffer = Buffer.alloc(0);

    process.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length > 0) {
        const start = buffer.indexOf(Buffer.from([0xff, 0xd8]));
        if (start === -1) break;
        const end = buffer.indexOf(Buffer.from([0xff, 0xd9]), start);
        if (end === -1) break;
        framesFound++;
        buffer = buffer.subarray(end + 2);
      }
    });

    process.stderr.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString('utf8');
    });

    const timeout = setTimeout(() => {
      console.log('[FFmpeg Test] Timed out after 8s, killing process...');
      process.kill('SIGKILL');
    }, 8000);

    process.on('close', (code) => {
      clearTimeout(timeout);
      console.log(`[FFmpeg Exit Code]: ${code}`);
      console.log(`[FFmpeg Decoded Frames]: ${framesFound}`);
      console.log(`[FFmpeg Stdout Bytes]: ${stdoutBytes}`);

      // Extract resolution & codec from stderr
      const streamMatch = stderrText.match(/Stream #.*Video: (.*)/);
      const resMatch = stderrText.match(/(\d{3,4}x\d{3,4})/);

      console.log(`[FFmpeg Stream Info]: ${streamMatch ? streamMatch[1] : 'Not detected'}`);
      console.log(`[FFmpeg Resolution]: ${resMatch ? resMatch[1] : 'Not detected'}`);

      console.log('\n--- [FFmpeg Stderr Log Output] ---');
      const lines = stderrText.split('\n');
      console.log(lines.slice(-15).join('\n'));
      resolve();
    });
  });
}

async function runDiagnostics() {
  await testTls6000();
  const rtsp322 = `rtsps://bblp:${accessCode}@${host}:322/streaming/live/1`;
  const rtsp554 = `rtsps://bblp:${accessCode}@${host}:0554/live/0`;
  await testFFmpegRtsp(rtsp322, 'Port 322 /streaming/live/1');
  await testFFmpegRtsp(rtsp554, 'Port 554 /live/0');
  console.log('\n==================================================');
  console.log('DIAGNOSTIC COMPLETED');
  console.log('==================================================');
}

runDiagnostics();
