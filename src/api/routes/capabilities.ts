import { FastifyInstance } from 'fastify';
import { CapabilityRegistry } from '../../domain/capabilities/CapabilityRegistry.js';

export async function capabilitiesRoutes(
  fastify: FastifyInstance,
  options: { capabilityRegistry: CapabilityRegistry }
): Promise<void> {
  const { capabilityRegistry } = options;

  fastify.get('/api/capabilities', async () => {
    return {
      printer: 'Bambu Lab H2D',
      capabilities: capabilityRegistry.getAllCapabilities(),
    };
  });
}
