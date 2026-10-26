import { z } from 'zod';
import { commandErrorResponse, handler, json, readJsonBody } from '../http';

const nozzleTempSchema = z.object({
  target: z
    .number({ error: (issue) => (issue.input === undefined ? 'target temperature is required' : undefined) })
    .finite('target must be a finite number')
    .min(0, 'Target temperature cannot be negative')
    .max(300, 'Target Hotend temperature cannot exceed 300°C'),
});

const bedTempSchema = z.object({
  target: z
    .number({ error: (issue) => (issue.input === undefined ? 'target temperature is required' : undefined) })
    .finite('target must be a finite number')
    .min(0, 'Target temperature cannot be negative')
    .max(120, 'Target Heatbed temperature cannot exceed 120°C'),
});

const invalidPayload = (issues: z.core.$ZodIssue[]) =>
  json(
    {
      success: false,
      error: 'INVALID_PAYLOAD',
      message: 'Invalid target temperature parameter',
      details: issues,
    },
    400
  );

const createNozzleHandler = (nozzleIndex: 0 | 1, action: string) =>
  handler(async ({ printerService, request }) => {
    const parseResult = nozzleTempSchema.safeParse(await readJsonBody(request));
    if (!parseResult.success) {
      return invalidPayload(parseResult.error.issues);
    }

    try {
      const res = await printerService.commandService.setNozzleTemperature(parseResult.data.target, nozzleIndex);
      return json({
        success: true,
        action,
        target: parseResult.data.target,
        commandId: res.commandId,
        message: res.message,
      });
    } catch (err) {
      return commandErrorResponse(err);
    }
  });

// POST /api/printer/temperature/nozzle
export const setNozzleTemperature = createNozzleHandler(0, 'set_nozzle_temp');

// POST /api/printer/temperature/nozzle2 (Secondary Nozzle)
export const setNozzle2Temperature = createNozzleHandler(1, 'set_nozzle2_temp');

// POST /api/printer/temperature/bed
export const setBedTemperature = handler(async ({ printerService, request }) => {
  const parseResult = bedTempSchema.safeParse(await readJsonBody(request));
  if (!parseResult.success) {
    return invalidPayload(parseResult.error.issues);
  }

  try {
    const res = await printerService.commandService.setBedTemperature(parseResult.data.target);
    return json({
      success: true,
      action: 'set_bed_temp',
      target: parseResult.data.target,
      commandId: res.commandId,
      message: res.message,
    });
  } catch (err) {
    return commandErrorResponse(err);
  }
});
