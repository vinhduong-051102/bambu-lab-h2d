import { env } from '../config/env';
import { BambuFtpClient, type PrinterFileStorage } from './BambuFtpClient';

// Shared through globalThis so the custom server and Next.js route bundles (and tests) use one factory
const globalForStorage = globalThis as unknown as { __bambuStorageFactory?: () => PrinterFileStorage };

const defaultFactory = (): PrinterFileStorage =>
  new BambuFtpClient({ host: env.BAMBU_HOST, port: env.BAMBU_FTP_PORT, accessCode: env.BAMBU_ACCESS_CODE });

/** The printer's storage over FTPS (port 990); a fresh client per call */
export function printerStorage(): PrinterFileStorage {
  return (globalForStorage.__bambuStorageFactory ?? defaultFactory)();
}

/** Test hook: swap the FTPS client for a fake; null restores the real one */
export function setPrinterStorageFactory(factory: (() => PrinterFileStorage) | null): void {
  globalForStorage.__bambuStorageFactory = factory ?? undefined;
}
