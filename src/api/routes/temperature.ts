import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PrinterService } from '../../domain/PrinterService.js';
import { CommandExecutionError } from '../../domain/commands/PrinterCommandService.js';

const nozzleTempSchema = z.object({
  target: z
    .number({ required_error: 'target temperature is required' })
    .finite('target must be a finite number')
    .min(0, 'Target temperature cannot be negative')
    .max(300, 'Target Hotend temperature cannot exceed 300°C'),
});

const bedTempSchema = z.object({
  target: z
    .number({ required_error: 'target temperature is required' })
    .finite('target must be a finite number')
    .min(0, 'Target temperature cannot be negative')
    .max(120, 'Target Heatbed temperature cannot exceed 120°C'),
});

export async function temperatureRoutes(
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

  // POST /api/printer/temperature/nozzle
  fastify.post('/api/printer/temperature/nozzle', async (request, reply) => {
    const parseResult = nozzleTempSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        success: false,
        error: 'INVALID_PAYLOAD',
        message: 'Invalid target temperature parameter',
        details: parseResult.error.issues,
      });
    }

    try {
      const res = await printerService.commandService.setNozzleTemperature(parseResult.data.target, 0);
      return reply.send({
        success: true,
        action: 'set_nozzle_temp',
        target: parseResult.data.target,
        commandId: res.commandId,
        message: res.message,
      });
    } catch (err) {
      return handleCommandError(err, reply);
    }
  });

  // POST /api/printer/temperature/nozzle2 (Secondary Nozzle)
  fastify.post('/api/printer/temperature/nozzle2', async (request, reply) => {
    const parseResult = nozzleTempSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        success: false,
        error: 'INVALID_PAYLOAD',
        message: 'Invalid target temperature parameter',
        details: parseResult.error.issues,
      });
    }

    try {
      const res = await printerService.commandService.setNozzleTemperature(parseResult.data.target, 1);
      return reply.send({
        success: true,
        action: 'set_nozzle2_temp',
        target: parseResult.data.target,
        commandId: res.commandId,
        message: res.message,
      });
    } catch (err) {
      return handleCommandError(err, reply);
    }
  });

  // POST /api/printer/temperature/bed
  fastify.post('/api/printer/temperature/bed', async (request, reply) => {
    const parseResult = bedTempSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        success: false,
        error: 'INVALID_PAYLOAD',
        message: 'Invalid target temperature parameter',
        details: parseResult.error.issues,
      });
    }

    try {
      const res = await printerService.commandService.setBedTemperature(parseResult.data.target);
      return reply.send({
        success: true,
        action: 'set_bed_temp',
        target: parseResult.data.target,
        commandId: res.commandId,
        message: res.message,
      });
    } catch (err) {
      return handleCommandError(err, reply);
    }
  });
}
