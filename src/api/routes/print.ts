import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PrinterService } from '../../domain/PrinterService.js';
import { CommandExecutionError } from '../../domain/commands/PrinterCommandService.js';

const startPrintSchema = z.object({
  fileId: z.string({ required_error: 'fileId or project identifier is required' }),
  useAms: z.boolean().optional().default(true),
  trayMapping: z.array(z.number()).optional(),
  plateIndex: z.number().optional().default(1),
});

export async function printRoutes(
  fastify: FastifyInstance,
  options: { printerService: PrinterService }
): Promise<void> {
  const { printerService } = options;

  const handleCommandError = (err: unknown, reply: any) => {
    if (err instanceof CommandExecutionError) {
      return reply.status(err.statusCode).send({
        success: false,
        error: err.errorCode,
        message: err.message,
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({ success: false, error: 'INTERNAL_ERROR', message });
  };

  // 1. GET /api/print/current - Current Print Job Status
  fastify.get('/api/print/current', async () => {
    const state = printerService.stateStore.getState();
    return {
      state: state.state,
      jobName: state.job?.name ?? null,
      progress: state.progress,
      currentLayer: state.job?.currentLayer ?? 0,
      totalLayers: state.job?.totalLayers ?? 0,
      remainingTimeMinutes: state.job?.remainingTimeMinutes ?? null,
      online: state.online,
    };
  });

  // 2. POST /api/printer/actions/pause & POST /api/print/pause
  const handlePause = async (request: any, reply: any) => {
    try {
      const res = await printerService.commandService.pausePrint();
      return reply.send({ success: true, action: 'pause', commandId: res.commandId, message: res.message });
    } catch (err) {
      return handleCommandError(err, reply);
    }
  };
  fastify.post('/api/printer/actions/pause', handlePause);
  fastify.post('/api/print/pause', handlePause);

  // 3. POST /api/printer/actions/resume & POST /api/print/resume
  const handleResume = async (request: any, reply: any) => {
    try {
      const res = await printerService.commandService.resumePrint();
      return reply.send({ success: true, action: 'resume', commandId: res.commandId, message: res.message });
    } catch (err) {
      return handleCommandError(err, reply);
    }
  };
  fastify.post('/api/printer/actions/resume', handleResume);
  fastify.post('/api/print/resume', handleResume);

  // 4. POST /api/printer/actions/stop, /api/print/stop & /api/print/cancel
  const handleStop = async (request: any, reply: any) => {
    try {
      const res = await printerService.commandService.stopPrint();
      return reply.send({ success: true, action: 'stop', commandId: res.commandId, message: res.message });
    } catch (err) {
      return handleCommandError(err, reply);
    }
  };
  fastify.post('/api/printer/actions/stop', handleStop);
  fastify.post('/api/print/stop', handleStop);
  fastify.post('/api/print/cancel', handleStop);

  // 5. POST /api/print/start
  fastify.post('/api/print/start', async (request, reply) => {
    const parseResult = startPrintSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        success: false,
        error: 'INVALID_PAYLOAD',
        message: 'Invalid start print request',
        details: parseResult.error.issues,
      });
    }

    // Check capability status (SUPPORTED vs UNKNOWN)
    const cap = printerService.capabilityRegistry.getCapability('print.start');
    if (!cap || cap.status !== 'SUPPORTED') {
      return reply.status(501).send({
        success: false,
        error: 'NOT_SUPPORTED',
        message: 'Starting print jobs over raw LAN MQTT requires precise SD card project file verification (Status: UNKNOWN). To prevent unintended printer moves, print start is marked UNKNOWN.',
      });
    }

    return reply.status(501).send({ success: false, error: 'NOT_IMPLEMENTED' });
  });
}
