import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PrinterService } from '../../domain/PrinterService.js';
import { CommandExecutionError } from '../../domain/commands/PrinterCommandService.js';

const fanSpeedSchema = z.object({
  speed: z
    .number({ required_error: 'speed is required' })
    .finite('speed must be a finite number')
    .min(0, 'Speed percentage cannot be negative')
    .max(100, 'Speed percentage cannot exceed 100%'),
});

export async function fanRoutes(
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

  const createFanHandler = (fanType: 'part' | 'aux' | 'chamber') => {
    return async (request: any, reply: any) => {
      const parseResult = fanSpeedSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          success: false,
          error: 'INVALID_PAYLOAD',
          message: 'Invalid fan speed parameter',
          details: parseResult.error.issues,
        });
      }

      try {
        const res = await printerService.commandService.setFanSpeed(fanType, parseResult.data.speed);
        return reply.send({
          success: true,
          action: `set_${fanType}_fan_speed`,
          speed: parseResult.data.speed,
          commandId: res.commandId,
          message: res.message,
        });
      } catch (err) {
        return handleCommandError(err, reply);
      }
    };
  };

  // POST /api/printer/fans/part
  fastify.post('/api/printer/fans/part', createFanHandler('part'));

  // POST /api/printer/fans/aux
  fastify.post('/api/printer/fans/aux', createFanHandler('aux'));

  // POST /api/printer/fans/chamber
  fastify.post('/api/printer/fans/chamber', createFanHandler('chamber'));
}
