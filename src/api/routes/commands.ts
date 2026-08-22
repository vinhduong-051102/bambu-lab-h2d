import { FastifyInstance } from 'fastify';
import { PrinterService } from '../../domain/PrinterService.js';

export async function commandRoutes(
  fastify: FastifyInstance,
  options: { printerService: PrinterService }
): Promise<void> {
  const { printerService } = options;

  // GET /api/commands - Audit Log list
  fastify.get('/api/commands', async () => {
    const log = printerService.commandService.getAuditLog();
    return {
      count: log.getEntries().length,
      commands: log.getEntries(),
    };
  });

  // GET /api/commands/:id - Get specific command entry by ID
  fastify.get('/api/commands/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const log = printerService.commandService.getAuditLog();
    const entry = log.getEntryById(id);

    if (!entry) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Command audit entry with id '${id}' not found`,
      });
    }

    return entry;
  });
}
