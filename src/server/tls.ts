import { execFileSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { logger } from '../logger/logger';

/**
 * The HTTPS certificate and key, made self-signed with openssl the first time (like Studio's on 3101) for
 * localhost and `hostnames`. Delete both files to make a new one, e.g. after adding a host name.
 */
export function loadOrCreateCertificate(certFile: string, keyFile: string, hostnames: string[]): { cert: Buffer; key: Buffer } {
  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    const names = [...new Set(['localhost', '127.0.0.1', ...hostnames])];
    const san = names.map((name) => (net.isIP(name) ? `IP:${name}` : `DNS:${name}`)).join(',');
    fs.mkdirSync(path.dirname(certFile), { recursive: true });
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
      '-subj', '/CN=Bambu H2D Gateway',
      '-addext', `subjectAltName=${san}`,
      '-keyout', keyFile, '-out', certFile,
    ], { stdio: 'pipe' });
    logger.info({ certFile, names }, 'Created a self-signed HTTPS certificate');
  }
  return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
}
