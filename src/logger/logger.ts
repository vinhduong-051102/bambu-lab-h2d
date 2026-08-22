import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            ignore: 'pid,hostname',
            translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
          },
        }
      : undefined,
  redact: {
    paths: ['accessCode', 'password', 'BAMBU_ACCESS_CODE'],
    censor: '***REDACTED***',
  },
});
