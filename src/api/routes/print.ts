import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import type { PrinterService } from '../../domain/PrinterService';
import { PrintJobManager } from '../../domain/print/PrintJobManager';
import { commandErrorResponse, handler, json, readJsonBody } from '../http';

const MAX_PROJECT_BYTES = 1024 * 1024 * 1024;

const startPrintSchema = z.object({
  stagedId: z.string({ required_error: 'stagedId is required (from POST /api/print/prepare)' }).min(1),
  plateIndex: z.number().int().min(1).default(1),
  // project filament index (0-based, as string key) → absolute tray index, 254 = external spool
  amsMapping: z.record(z.string().regex(/^\d+$/), z.number().int().min(-1).max(255).nullable()).default({}),
  options: z
    .object({
      timelapse: z.boolean().default(false),
      bedLeveling: z.boolean().default(true),
      flowCalibration: z.boolean().default(true),
      vibrationCalibration: z.boolean().default(true),
      layerInspect: z.boolean().default(true),
    })
    .default({}),
});

const prepareRemoteSchema = z.object({
  path: z
    .string({ required_error: 'path is required' })
    .regex(/^\/?[^\0]*\.3mf$/i, 'Only .3mf project files can be printed')
    .refine((p) => !p.split('/').includes('..'), 'Invalid path'),
});

/** Installed nozzle diameter from telemetry ("0.4"), used to pick presets when slicing on the gateway */
const installedNozzle = (printerService: PrinterService): string | null => {
  const diameter = printerService.stateStore.getState().temperatures.nozzles.find((n) => n.diameter)?.diameter;
  return diameter ? diameter.toFixed(1) : null;
};

const invalidPayload = (message: string, issues: z.ZodIssue[]) =>
  json({ success: false, error: 'INVALID_PAYLOAD', message, details: issues }, 400);

// ThreeMfParseError, matched by name (see commandErrorResponse for why not instanceof)
const parseErrorResponse = (err: unknown): Response | null => {
  if (err instanceof Error && err.name === 'ThreeMfParseError') {
    return json({ success: false, error: (err as { code?: string }).code, message: err.message }, 422);
  }
  return null;
};

// GET /api/print/current - Current Print Job Status
export const getCurrentPrint = handler(({ printerService }) => {
  const state = printerService.stateStore.getState();
  return json({
    state: state.state,
    jobName: state.job?.name ?? null,
    progress: state.progress,
    currentLayer: state.job?.currentLayer ?? 0,
    totalLayers: state.job?.totalLayers ?? 0,
    remainingTimeMinutes: state.job?.remainingTimeMinutes ?? null,
    online: state.online,
  });
});

// POST /api/printer/actions/pause & POST /api/print/pause
export const pausePrint = handler(async ({ printerService }) => {
  try {
    const res = await printerService.commandService.pausePrint();
    return json({ success: true, action: 'pause', commandId: res.commandId, message: res.message });
  } catch (err) {
    return commandErrorResponse(err);
  }
});

// POST /api/printer/actions/resume & POST /api/print/resume
export const resumePrint = handler(async ({ printerService }) => {
  try {
    const res = await printerService.commandService.resumePrint();
    return json({ success: true, action: 'resume', commandId: res.commandId, message: res.message });
  } catch (err) {
    return commandErrorResponse(err);
  }
});

// POST /api/printer/actions/stop, /api/print/stop & /api/print/cancel
export const stopPrint = handler(async ({ printerService }) => {
  try {
    const res = await printerService.commandService.stopPrint();
    return json({ success: true, action: 'stop', commandId: res.commandId, message: res.message });
  } catch (err) {
    return commandErrorResponse(err);
  }
});

// POST /api/print/prepare - multipart upload of a sliced 3MF to the gateway; returns plates + AMS suggestions
export const preparePrint = handler(async ({ printerService, request }) => {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_PROJECT_BYTES) {
    return json({ success: false, error: 'FILE_TOO_LARGE', message: 'File vượt quá 1 GB.' }, 413);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ success: false, error: 'INVALID_PAYLOAD', message: 'Expected multipart/form-data with a "file" field.' }, 400);
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return json({ success: false, error: 'INVALID_PAYLOAD', message: 'Missing "file" field.' }, 400);
  }
  if (!/\.3mf$/i.test(file.name)) {
    return json(
      {
        success: false,
        error: 'UNSUPPORTED_FILE_TYPE',
        message: 'Chỉ hỗ trợ file .3mf (project hoặc đã slice .gcode.3mf).',
      },
      415
    );
  }

  const manager = PrintJobManager.getInstance();
  try {
    const staged = await manager.stage({
      fileName: file.name,
      data: new Uint8Array(await file.arrayBuffer()),
      source: 'local',
      nozzle: installedNozzle(printerService),
    });
    return json({ success: true, staged: manager.describeStaged(staged, printerService) }, 201);
  } catch (err) {
    return parseErrorResponse(err) ?? commandErrorResponse(err);
  }
});

// POST /api/print/prepare-remote - inspect a 3MF already stored on the printer (downloaded via FTPS)
export const prepareRemotePrint = handler(async ({ printerService, request }) => {
  const parsed = prepareRemoteSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) return invalidPayload('Invalid remote file path', parsed.error.issues);

  const remotePath = parsed.data.path.startsWith('/') ? parsed.data.path : `/${parsed.data.path}`;
  const manager = PrintJobManager.getInstance();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bambu-h2d-download-'));
  const tempFile = path.join(tempDir, 'project.3mf');

  try {
    try {
      await manager.storage().download(remotePath, tempFile);
    } catch (err) {
      return json(
        { success: false, error: 'FTPS_ERROR', message: `Không tải được file từ máy in: ${err instanceof Error ? err.message : String(err)}` },
        502
      );
    }
    const staged = await manager.stage({
      fileName: path.posix.basename(remotePath),
      data: new Uint8Array(await fs.readFile(tempFile)),
      source: 'printer',
      remotePath,
      nozzle: installedNozzle(printerService),
    });
    return json({ success: true, staged: manager.describeStaged(staged, printerService) }, 201);
  } catch (err) {
    return parseErrorResponse(err) ?? commandErrorResponse(err);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

// GET /api/print/staged/:id
export const getStagedPrint = handler<{ id: string }>(({ printerService, params }) => {
  const manager = PrintJobManager.getInstance();
  const staged = manager.getStaged(params.id);
  if (!staged) {
    return json({ success: false, error: 'STAGED_FILE_NOT_FOUND', message: 'File không tồn tại hoặc đã hết hạn.' }, 404);
  }
  return json({ success: true, staged: manager.describeStaged(staged, printerService) });
});

// GET /api/print/staged/:id/file - the staged .gcode.3mf, for the browser-side 3D toolpath preview
export const getStagedFile = handler<{ id: string }>(async ({ params }) => {
  const staged = PrintJobManager.getInstance().getStaged(params.id);
  if (!staged) {
    return json({ success: false, error: 'STAGED_FILE_NOT_FOUND', message: 'File không tồn tại hoặc đã hết hạn.' }, 404);
  }
  const data = await fs.readFile(staged.localPath);
  return new Response(data, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(data.byteLength),
      'Cache-Control': 'no-store',
    },
  });
});

// DELETE /api/print/staged/:id
export const deleteStagedPrint = handler<{ id: string }>(async ({ params }) => {
  const removed = await PrintJobManager.getInstance().deleteStaged(params.id);
  if (!removed) {
    return json({ success: false, error: 'STAGED_FILE_NOT_FOUND', message: 'File không tồn tại hoặc đã hết hạn.' }, 404);
  }
  return json({ success: true });
});

// POST /api/print/start - upload (if needed) + print.project_file, tracked as a print job
export const startPrint = handler(async ({ printerService, request }) => {
  const parsed = startPrintSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) return invalidPayload('Invalid start print request', parsed.error.issues);

  const assignment: Record<number, number | null> = {};
  for (const [key, value] of Object.entries(parsed.data.amsMapping)) assignment[Number(key)] = value;

  try {
    const job = PrintJobManager.getInstance().startJob(printerService, {
      stagedId: parsed.data.stagedId,
      plateIndex: parsed.data.plateIndex,
      assignment,
      options: parsed.data.options,
    });
    return json({ success: true, job, message: job.message }, 202);
  } catch (err) {
    return commandErrorResponse(err);
  }
});

// GET /api/print/jobs
export const listPrintJobs = handler(() => {
  const manager = PrintJobManager.getInstance();
  return json({ jobs: manager.getJobs(), printer: manager.getPrinterSnapshot() });
});

// GET /api/print/jobs/:id
export const getPrintJob = handler<{ id: string }>(({ params }) => {
  const job = PrintJobManager.getInstance().getJob(params.id);
  if (!job) {
    return json({ success: false, error: 'PRINT_JOB_NOT_FOUND', message: `Print job '${params.id}' not found` }, 404);
  }
  return json({ success: true, job });
});
