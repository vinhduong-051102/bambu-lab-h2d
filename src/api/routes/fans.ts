import { z } from 'zod';
import { commandErrorResponse, handler, json, readJsonBody } from '../http';

const fanSpeedSchema = z.object({
  speed: z
    .number({ required_error: 'speed is required' })
    .finite('speed must be a finite number')
    .min(0, 'Speed percentage cannot be negative')
    .max(100, 'Speed percentage cannot exceed 100%'),
});

const FAN_TYPES = ['part', 'aux', 'chamber'] as const;
type FanType = (typeof FAN_TYPES)[number];

const isFanType = (value: string): value is FanType => (FAN_TYPES as readonly string[]).includes(value);

// POST /api/printer/fans/:fan (part | aux | chamber)
export const setFanSpeed = handler<{ fan: string }>(async ({ printerService, request, params }) => {
  const fanType = params.fan;
  if (!isFanType(fanType)) {
    return json({ error: 'Not Found', message: `Route POST /api/printer/fans/${fanType} not found` }, 404);
  }

  const parseResult = fanSpeedSchema.safeParse(await readJsonBody(request));
  if (!parseResult.success) {
    return json(
      {
        success: false,
        error: 'INVALID_PAYLOAD',
        message: 'Invalid fan speed parameter',
        details: parseResult.error.issues,
      },
      400
    );
  }

  try {
    const res = await printerService.commandService.setFanSpeed(fanType, parseResult.data.speed);
    return json({
      success: true,
      action: `set_${fanType}_fan_speed`,
      speed: parseResult.data.speed,
      commandId: res.commandId,
      message: res.message,
    });
  } catch (err) {
    return commandErrorResponse(err);
  }
});
