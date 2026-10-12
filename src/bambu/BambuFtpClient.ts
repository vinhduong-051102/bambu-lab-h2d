import { Client, FTPError, type FileInfo } from 'basic-ftp';
import { promises as fs } from 'fs';
import path from 'path';
import { logger } from '../logger/logger';

export interface PrinterFileEntry {
  name: string;
  path: string;
  size: number;
  isDirectory: boolean;
  modifiedAt: string | null;
}

export interface BambuFtpClientOptions {
  host: string;
  accessCode: string;
  port?: number;
  timeoutMs?: number;
}

export interface PrinterFileStorage {
  list(dir?: string): Promise<PrinterFileEntry[]>;
  upload(localPath: string, remotePath: string, onProgress?: (bytes: number) => void): Promise<void>;
  download(remotePath: string, localPath: string): Promise<void>;
  remove(remotePath: string): Promise<void>;
}

/**
 * FTPS client for the printer's storage: implicit TLS on port 990, user `bblp`, password = LAN
 * access code. Bambu's server requires the data connection to resume the control connection's
 * TLS session, which basic-ftp does; TLS is pinned to 1.2 so the session exists as soon as the
 * handshake completes (TLS 1.3 tickets arrive later and can race the first PASV transfer).
 */
export class BambuFtpClient implements PrinterFileStorage {
  private readonly port: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: BambuFtpClientOptions) {
    this.port = options.port ?? 990;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  private async withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client(this.timeoutMs);
    try {
      await client.access({
        host: this.options.host,
        port: this.port,
        user: 'bblp',
        password: this.options.accessCode,
        secure: 'implicit',
        secureOptions: {
          // The printer presents a self-signed certificate issued per device
          rejectUnauthorized: false,
          checkServerIdentity: () => undefined,
          maxVersion: 'TLSv1.2',
          // Printer certificates use small keys that OpenSSL 3's default security level rejects
          ciphers: 'DEFAULT@SECLEVEL=0',
        },
      });
      return await fn(client);
    } finally {
      client.close();
    }
  }

  public list(dir = '/'): Promise<PrinterFileEntry[]> {
    return this.withClient(async (client) => {
      const items = await client.list(dir);
      return items.map((item: FileInfo) => ({
        name: item.name,
        path: path.posix.join(dir, item.name),
        size: item.size,
        isDirectory: item.isDirectory,
        modifiedAt: item.modifiedAt ? item.modifiedAt.toISOString() : item.rawModifiedAt || null,
      }));
    });
  }

  public upload(localPath: string, remotePath: string, onProgress?: (bytes: number) => void): Promise<void> {
    return this.withClient(async (client) => {
      const { size: expectedSize } = await fs.stat(localPath);
      if (onProgress) client.trackProgress((info) => onProgress(info.bytes));

      try {
        await client.uploadFrom(localPath, remotePath);
      } catch (err) {
        // Some Bambu firmwares answer 426 when the TLS data channel is closed after the last
        // byte even though the file was stored; the size check below decides.
        if (!(err instanceof FTPError && err.code === 426)) throw err;
        logger.warn({ remotePath }, 'FTPS upload ended with 426, verifying remote size');
      } finally {
        client.trackProgress();
      }

      const remoteSize = await client.size(remotePath);
      if (remoteSize !== expectedSize) {
        throw new Error(`Upload verification failed: printer has ${remoteSize} bytes, expected ${expectedSize}`);
      }
    });
  }

  public download(remotePath: string, localPath: string): Promise<void> {
    return this.withClient((client) => client.downloadTo(localPath, remotePath).then(() => undefined));
  }

  public remove(remotePath: string): Promise<void> {
    return this.withClient((client) => client.remove(remotePath).then(() => undefined));
  }
}
