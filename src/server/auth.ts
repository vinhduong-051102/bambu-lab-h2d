import { FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config/env.js';

export async function authenticateRequest(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // If GATEWAY_API_KEY is not set, running in open local development mode
  if (!env.GATEWAY_API_KEY || env.GATEWAY_API_KEY.trim() === '') {
    return;
  }

  // Exempt public static files & root health check
  if (request.url === '/' || request.url === '/health' || request.url.startsWith('/style.css') || request.url.startsWith('/app.js')) {
    return;
  }

  const authHeader = request.headers.authorization;
  if (!authHeader) {
    reply.status(401).send({
      error: 'Unauthorized',
      message: 'Missing Authorization header. Expected Bearer token.',
    });
    return;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    reply.status(401).send({
      error: 'Unauthorized',
      message: 'Invalid Authorization header format. Expected "Bearer <GATEWAY_API_KEY>".',
    });
    return;
  }

  const token = parts[1];
  if (token !== env.GATEWAY_API_KEY) {
    reply.status(401).send({
      error: 'Unauthorized',
      message: 'Invalid Gateway API Key.',
    });
    return;
  }
}
