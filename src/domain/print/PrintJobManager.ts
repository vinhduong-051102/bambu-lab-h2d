import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { env } from '../../config/env';
import { logger } from '../../logger/logger';
import { BambuFtpClient, type PrinterFileStorage } from '../../bambu/BambuFtpClient';
import { BambuCommandBuilder } from '../../bambu/commands/BambuCommandBuilder';
import { parseThreeMf, type ThreeMfInfo } from '../../bambu/ThreeMfParser';
import { BambuSlicer, TARGET_PRINTER, type SliceProfiles } from '../../bambu/BambuSlicer';
import type { PrinterService } from '../PrinterService';
import {
  buildAmsMappingPayload,
  listAvailableTrays,
  suggestMapping,
  validateMapping,
} from './amsMapping';

export type PrintJobStatus =
  | 'UPLOADING'
  | 'UPLOADED'
  | 'SENT'
  | 'ACCEPTED'
  | 'PREPARING'
  | 'PRINTING'
  | 'FAILED'
  | 'TIMEOUT';

export interface StagedPrintFile {
  id: string;
  fileName: string;
  remoteName: string;
  /** Set when the file already lives on the printer, so no upload is needed */
  remotePath: string | null;
  source: 'local' | 'printer';
  size: number;
  localPath: string;
  info: ThreeMfInfo;
  /** Set when the upload was an unsliced project that the gateway sliced itself */
  slicedByGateway: GatewaySlice | null;
  createdAt: string;
}

export interface GatewaySlice {
  sourceFileName: string;
  sourcePrinter: string | null;
  printer: string;
  nozzle: string;
  profiles: SliceProfiles | null;
  durationMs: number;
}

export interface PrintJobOptions {
  timelapse: boolean;
  bedLeveling: boolean;
  flowCalibration: boolean;
  vibrationCalibration: boolean;
  layerInspect: boolean;
}

export interface StartPrintRequest {
  stagedId: string;
  plateIndex: number;
  /** project filament index → absolute tray index (or 254 for the external spool) */
  assignment: Record<number, number | null>;
  options: PrintJobOptions;
}

export interface PrintJob {
  id: string;
  stagedId: string;
  fileName: string;
  remotePath: string;
  plateIndex: number;
  status: PrintJobStatus;
  message: string;
  createdAt: string;
  updatedAt: string;
  upload: { bytes: number; total: number; percent: number } | null;
  sequenceId: string | null;
  request: Record<string, unknown> | null;
  printerResponse: { result: string | null; reason: string | null } | null;
  gcodeState: string | null;
  printError: string | null;
  hmsErrors: string[];
  warnings: string[];
  history: { status: PrintJobStatus; at: string; message: string }[];
}

export class PrintJobError extends Error {
  constructor(message: string, public statusCode: number, public errorCode: string, public details?: unknown) {
    super(message);
    this.name = 'PrintJobError';
  }
}

interface PrinterSnapshot {
  gcodeState: string | null;
  fun: string | null;
  printError: number | null;
  subtaskName: string | null;
  hms: string[];
}

/** print.fun bit set when firmware only accepts signed MQTT commands (Developer Mode off) */
const MQTT_SIGNATURE_REQUIRED = 0x20000000;
const IDLE_GCODE_STATES = new Set(['IDLE', 'FINISH', 'FINISHED', 'FAILED', '']);
const ACTIVE_STATUSES = new Set<PrintJobStatus>(['UPLOADING', 'UPLOADED', 'SENT', 'ACCEPTED', 'PREPARING']);
const STAGED_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_JOBS = 20;

const globalForManager = globalThis as unknown as { __bambuPrintJobManager?: PrintJobManager };

/**
 * Runs LAN print jobs end to end: stage + inspect a sliced 3MF, upload it to the printer over
 * FTPS, send print.project_file over MQTT, then confirm from the printer's own reports
 * (command result, gcode_state PREPARE → RUNNING, print_error, HMS) rather than assuming success.
 */
export class PrintJobManager extends EventEmitter {
  private staged = new Map<string, StagedPrintFile>();
  private jobs = new Map<string, PrintJob>();
  private timers = new Map<string, NodeJS.Timeout>();
  private baselines = new Map<string, { gcodeState: string | null; printError: number | null; hms: Set<string>; sawTransition: boolean }>();
  private snapshot: PrinterSnapshot = { gcodeState: null, fun: null, printError: null, subtaskName: null, hms: [] };
  private storageFactory: () => PrinterFileStorage = () =>
    new BambuFtpClient({ host: env.BAMBU_HOST, port: env.BAMBU_FTP_PORT, accessCode: env.BAMBU_ACCESS_CODE });

  public ackTimeoutMs = 90_000;
  public startTimeoutMs = 10 * 60_000;
  public stagingDir = path.join(os.tmpdir(), 'bambu-h2d-gateway', 'staging');
  public slicer = new BambuSlicer();

  // Shared through globalThis: the custom server feeds MQTT reports in, Route Handlers start jobs
  public static getInstance(): PrintJobManager {
    if (!globalForManager.__bambuPrintJobManager) {
      globalForManager.__bambuPrintJobManager = new PrintJobManager();
    }
    return globalForManager.__bambuPrintJobManager;
  }

  public setStorageFactory(factory: () => PrinterFileStorage): void {
    this.storageFactory = factory;
  }

  public storage(): PrinterFileStorage {
    return this.storageFactory();
  }

  public getPrinterSnapshot(): Readonly<PrinterSnapshot> & { developerModeRequired: boolean | null } {
    return { ...this.snapshot, developerModeRequired: this.developerModeRequired() };
  }

  // ---------- Staging ----------

  public async stage(input: {
    fileName: string;
    data: Uint8Array;
    source: 'local' | 'printer';
    remotePath?: string;
    /** Installed nozzle diameter, used when an unsliced project has to be sliced */
    nozzle?: string | null;
  }): Promise<StagedPrintFile> {
    await this.expireStaged();

    let { fileName, data, remotePath } = input;
    let info: ThreeMfInfo;
    let slicedByGateway: GatewaySlice | null = null;
    try {
      info = parseThreeMf(data);
    } catch (err) {
      // Matched by name/code (see commandErrorResponse for why not instanceof)
      const notSliced = err instanceof Error && err.name === 'ThreeMfParseError' && (err as { code?: string }).code === 'NOT_SLICED';
      if (!notSliced || !this.slicer.isEnabled()) throw err;

      const sliced = await this.slicer.slice(data, { nozzle: input.nozzle });
      data = sliced.data;
      info = parseThreeMf(data);
      for (const plate of info.plates) plate.warnings = [...new Set([...plate.warnings, ...sliced.warnings])];
      slicedByGateway = {
        sourceFileName: input.fileName,
        sourcePrinter: sliced.sourcePrinter,
        printer: TARGET_PRINTER,
        nozzle: sliced.nozzle,
        profiles: sliced.profiles,
        durationMs: sliced.durationMs,
      };
      // The sliced output is a new file: upload it instead of printing the unsliced original on the printer
      fileName = toSlicedFileName(input.fileName);
      remotePath = undefined;
    }

    const id = randomUUID();
    await fs.mkdir(this.stagingDir, { recursive: true });
    const localPath = path.join(this.stagingDir, `${id}.3mf`);
    await fs.writeFile(localPath, data);

    const staged: StagedPrintFile = {
      id,
      fileName,
      remoteName: toRemoteName(fileName),
      remotePath: remotePath ?? null,
      source: input.source,
      size: data.byteLength,
      localPath,
      info,
      slicedByGateway,
      createdAt: new Date().toISOString(),
    };
    this.staged.set(id, staged);
    return staged;
  }

  public getStaged(id: string): StagedPrintFile | undefined {
    return this.staged.get(id);
  }

  public async deleteStaged(id: string): Promise<boolean> {
    const staged = this.staged.get(id);
    if (!staged) return false;
    this.staged.delete(id);
    await fs.rm(staged.localPath, { force: true });
    return true;
  }

  /** Inspection result for the UI: plates plus a suggested tray for each filament from live AMS */
  public describeStaged(staged: StagedPrintFile, printerService: PrinterService) {
    const trays = listAvailableTrays(printerService.stateStore.getState());
    return {
      id: staged.id,
      fileName: staged.fileName,
      remoteName: staged.remotePath ?? `/${staged.remoteName}`,
      source: staged.source,
      size: staged.size,
      createdAt: staged.createdAt,
      projectFilamentCount: staged.info.projectFilamentCount,
      printerModelId: staged.info.printerModelId,
      printerModel: staged.info.printerModel,
      nozzleDiameters: staged.info.nozzleDiameters,
      slicerVersion: staged.info.slicerVersion,
      slicedByGateway: staged.slicedByGateway,
      plates: staged.info.plates.map((plate) => ({
        index: plate.index,
        name: plate.name,
        predictionSeconds: plate.predictionSeconds,
        weightGrams: plate.weightGrams,
        thumbnail: plate.thumbnail,
        warnings: plate.warnings,
        filaments: plate.filaments,
        suggestedMapping: suggestMapping(plate.filaments, trays),
      })),
      trays,
    };
  }

  private async expireStaged(): Promise<void> {
    const now = Date.now();
    for (const staged of this.staged.values()) {
      const inUse = [...this.jobs.values()].some((j) => j.stagedId === staged.id && ACTIVE_STATUSES.has(j.status));
      if (!inUse && now - Date.parse(staged.createdAt) > STAGED_TTL_MS) {
        await this.deleteStaged(staged.id);
      }
    }
  }

  // ---------- Jobs ----------

  public getJobs(): PrintJob[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  public getJob(id: string): PrintJob | undefined {
    return this.jobs.get(id);
  }

  public getActiveJob(): PrintJob | undefined {
    return [...this.jobs.values()].find((j) => ACTIVE_STATUSES.has(j.status));
  }

  /** Validates everything the printer would reject, then runs upload + MQTT in the background */
  public startJob(printerService: PrinterService, req: StartPrintRequest): PrintJob {
    const staged = this.staged.get(req.stagedId);
    if (!staged) {
      throw new PrintJobError('File chưa được tải lên gateway hoặc đã hết hạn. Hãy chọn lại file.', 404, 'STAGED_FILE_NOT_FOUND');
    }
    const plate = staged.info.plates.find((p) => p.index === req.plateIndex);
    if (!plate) {
      throw new PrintJobError(`Plate ${req.plateIndex} không có G-code đã slice trong file này.`, 400, 'PLATE_NOT_FOUND');
    }

    const capability = printerService.capabilityRegistry.getCapability('print.start');
    if (!capability || capability.status !== 'SUPPORTED') {
      throw new PrintJobError("Capability 'print.start' is not supported", 501, 'NOT_SUPPORTED');
    }
    if (!env.BAMBU_REAL_PRINTER) {
      throw new PrintJobError(
        'Command execution blocked: BAMBU_REAL_PRINTER is set to false. Set BAMBU_REAL_PRINTER=true in .env to allow sending commands to real printer.',
        403,
        'TEST_MODE_RESTRICTED'
      );
    }
    if (!printerService.mqttClient?.isConnected() || !printerService.stateStore.isOnline()) {
      throw new PrintJobError('Máy in đang offline hoặc chưa kết nối MQTT.', 503, 'PRINTER_OFFLINE');
    }
    if (this.developerModeRequired()) {
      throw new PrintJobError(
        'Firmware máy in đang yêu cầu lệnh MQTT có chữ ký (print.fun). Bật "LAN Only Mode" và "Developer Mode" trên màn hình máy in để in qua LAN.',
        412,
        'DEVELOPER_MODE_REQUIRED'
      );
    }

    const gcodeState = (this.snapshot.gcodeState ?? '').toUpperCase();
    const coarseState = printerService.stateStore.getState().state;
    const idle = this.snapshot.gcodeState !== null
      ? IDLE_GCODE_STATES.has(gcodeState)
      : ['IDLE', 'FINISHED', 'FAILED'].includes(coarseState);
    if (!idle) {
      throw new PrintJobError(
        `Máy in đang bận (trạng thái ${this.snapshot.gcodeState ?? coarseState}). Chỉ có thể bắt đầu in khi máy ở IDLE/FINISH/FAILED.`,
        409,
        'PRINTER_BUSY'
      );
    }

    const active = this.getActiveJob();
    if (active) {
      throw new PrintJobError(`Đang có lệnh in khác (${active.fileName}) chưa hoàn tất.`, 409, 'PRINT_JOB_IN_PROGRESS', { jobId: active.id });
    }

    const trays = listAvailableTrays(printerService.stateStore.getState());
    const validation = validateMapping(plate.filaments, req.assignment, trays);
    if (validation.errors.length > 0) {
      throw new PrintJobError('Ánh xạ filament → khay AMS không hợp lệ.', 400, 'INVALID_AMS_MAPPING', validation);
    }

    const now = new Date().toISOString();
    const job: PrintJob = {
      id: `print_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      stagedId: staged.id,
      fileName: staged.fileName,
      remotePath: staged.remotePath ?? `/${staged.remoteName}`,
      plateIndex: plate.index,
      status: staged.remotePath ? 'UPLOADED' : 'UPLOADING',
      message: staged.remotePath ? 'File đã có sẵn trên máy in.' : 'Đang tải file lên máy in qua FTPS...',
      createdAt: now,
      updatedAt: now,
      upload: staged.remotePath ? null : { bytes: 0, total: staged.size, percent: 0 },
      sequenceId: null,
      request: null,
      printerResponse: null,
      gcodeState: this.snapshot.gcodeState,
      printError: null,
      hmsErrors: [],
      warnings: [...validation.warnings, ...plate.warnings],
      history: [],
    };
    job.history.push({ status: job.status, at: now, message: job.message });
    this.jobs.set(job.id, job);
    this.trimJobs();
    this.emitJob(job);

    void this.run(job, staged, plate.gcodeMd5, printerService, req).catch((err) => {
      this.update(job, 'FAILED', `Lỗi không xác định: ${err instanceof Error ? err.message : String(err)}`);
    });

    return job;
  }

  private async run(
    job: PrintJob,
    staged: StagedPrintFile,
    gcodeMd5: string,
    printerService: PrinterService,
    req: StartPrintRequest
  ): Promise<void> {
    if (job.status === 'UPLOADING') {
      let lastEmit = 0;
      try {
        await this.storage().upload(staged.localPath, job.remotePath, (bytes) => {
          job.upload = { bytes, total: staged.size, percent: Math.min(100, Math.round((bytes / staged.size) * 100)) };
          if (Date.now() - lastEmit > 500) {
            lastEmit = Date.now();
            job.updatedAt = new Date().toISOString();
            this.emitJob(job);
          }
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.update(job, 'FAILED', `Upload FTPS thất bại: ${reason}. Kiểm tra cổng FTPS ${env.BAMBU_FTP_PORT}, Access Code và chế độ LAN của máy in.`);
        return;
      }
      job.upload = { bytes: staged.size, total: staged.size, percent: 100 };
      // Later jobs on the same staged file can skip the upload
      staged.remotePath = job.remotePath;
      this.update(job, 'UPLOADED', 'Đã tải file lên máy in.');
    }

    const plate = staged.info.plates.find((p) => p.index === req.plateIndex)!;
    const mapping = buildAmsMappingPayload(staged.info.projectFilamentCount, plate.filaments, req.assignment);
    const payload = BambuCommandBuilder.buildProjectFilePayload({
      remotePath: job.remotePath,
      plateIndex: plate.index,
      gcodeMd5,
      subtaskName: subtaskNameOf(staged.fileName),
      amsMapping: mapping.amsMapping,
      amsMapping2: mapping.amsMapping2,
      useAms: mapping.useAms,
      timelapse: req.options.timelapse,
      bedLeveling: req.options.bedLeveling,
      flowCalibration: req.options.flowCalibration,
      vibrationCalibration: req.options.vibrationCalibration,
      layerInspect: req.options.layerInspect,
    });
    job.request = payload;
    job.sequenceId = String((payload.print as Record<string, unknown>).sequence_id);

    this.baselines.set(job.id, {
      gcodeState: this.snapshot.gcodeState,
      printError: this.snapshot.printError,
      hms: new Set(this.snapshot.hms),
      sawTransition: false,
    });

    if (env.BAMBU_DEBUG_PROTOCOL) {
      logger.info({ jobId: job.id, payload }, '[DEBUG PROTOCOL] Sending project_file');
    }
    const published = await printerService.mqttClient!.publishRequest(payload);
    if (!published) {
      this.update(job, 'FAILED', 'Không gửi được lệnh project_file qua MQTT (mất kết nối).');
      return;
    }

    this.update(job, 'SENT', 'Đã gửi lệnh in. Đang chờ máy in xác nhận...');
    this.armTimer(job, this.ackTimeoutMs, 'Máy in không phản hồi lệnh in trong thời gian chờ. Kiểm tra màn hình máy in.');
  }

  // ---------- Printer reports ----------

  /** Feed every MQTT report here (custom server). Tracks state and advances the active job. */
  public ingestReport(payload: Record<string, unknown>): void {
    const report = payload.print as Record<string, unknown> | undefined;
    if (!report || typeof report !== 'object') return;

    if (typeof report.gcode_state === 'string') this.snapshot.gcodeState = report.gcode_state;
    if (typeof report.fun === 'string') this.snapshot.fun = report.fun;
    if (typeof report.print_error === 'number') this.snapshot.printError = report.print_error;
    if (typeof report.subtask_name === 'string') this.snapshot.subtaskName = report.subtask_name;
    if (Array.isArray(report.hms)) this.snapshot.hms = report.hms.map(formatHms).filter((c): c is string => c !== null);

    const job = [...this.jobs.values()].find((j) => ['SENT', 'ACCEPTED', 'PREPARING', 'TIMEOUT'].includes(j.status) && j.sequenceId !== null);
    if (!job) return;
    const baseline = this.baselines.get(job.id);

    // 1. Direct answer to our command
    if (report.command === 'project_file' && (report.sequence_id === undefined || String(report.sequence_id) === job.sequenceId)) {
      const result = typeof report.result === 'string' ? report.result : null;
      const reason = typeof report.reason === 'string' ? report.reason : null;
      job.printerResponse = { result, reason };
      if (result?.toLowerCase() === 'success' && job.status === 'SENT') {
        this.update(job, 'ACCEPTED', 'Máy in đã chấp nhận lệnh in.');
        this.armTimer(job, this.startTimeoutMs, 'Máy in đã nhận lệnh nhưng chưa bắt đầu in. Kiểm tra màn hình máy in.');
      } else if (result && result.toLowerCase() !== 'success') {
        this.update(job, 'FAILED', `Máy in từ chối lệnh in: ${reason || result}.`);
        return;
      }
    }

    // 2. New HMS codes raised after the command was sent
    if (baseline && Array.isArray(report.hms)) {
      const fresh = this.snapshot.hms.filter((code) => !baseline.hms.has(code) && !job.hmsErrors.includes(code));
      if (fresh.length > 0) {
        job.hmsErrors.push(...fresh);
        job.updatedAt = new Date().toISOString();
        this.emitJob(job);
      }
    }

    // 3. gcode_state transitions (a stale FAILED/FINISH from the previous job is ignored)
    if (typeof report.gcode_state === 'string' && baseline) {
      const state = report.gcode_state.toUpperCase();
      job.gcodeState = report.gcode_state;
      if (state !== (baseline.gcodeState ?? '').toUpperCase()) baseline.sawTransition = true;

      if (state === 'PREPARE' || state === 'SLICING') {
        if (job.status !== 'PREPARING') {
          this.update(job, 'PREPARING', 'Máy in đang chuẩn bị (tải/đọc file)...');
          this.armTimer(job, this.startTimeoutMs, 'Máy in chuẩn bị quá lâu mà chưa chuyển sang in. Kiểm tra màn hình máy in.');
        }
      } else if (state === 'RUNNING') {
        this.update(job, 'PRINTING', 'Máy in đã bắt đầu in.');
      } else if (state === 'FAILED' && baseline.sawTransition) {
        this.failFromPrinter(job, report);
      }
    }

    if (typeof report.print_error === 'number' && report.print_error !== 0 && baseline && report.print_error !== baseline.printError) {
      job.printError = formatPrintError(report.print_error);
      if (job.status !== 'PRINTING') this.failFromPrinter(job, report);
    }
  }

  private failFromPrinter(job: PrintJob, report: Record<string, unknown>): void {
    if (job.status === 'FAILED') return;
    if (typeof report.print_error === 'number' && report.print_error !== 0) {
      job.printError = formatPrintError(report.print_error);
    }
    const codes = [job.printError, ...job.hmsErrors].filter(Boolean).join(', ');
    this.update(job, 'FAILED', `Máy in báo lỗi khi bắt đầu in${codes ? ` (${codes})` : ''}. Tra mã lỗi trên wiki.bambulab.com.`);
  }

  // ---------- Helpers ----------

  private developerModeRequired(): boolean | null {
    if (!this.snapshot.fun) return null;
    const value = parseInt(this.snapshot.fun, 16);
    return Number.isFinite(value) ? (value & MQTT_SIGNATURE_REQUIRED) !== 0 : null;
  }

  private update(job: PrintJob, status: PrintJobStatus, message: string): void {
    const at = new Date().toISOString();
    job.status = status;
    job.message = message;
    job.updatedAt = at;
    job.history.push({ status, at, message });
    if (status === 'PRINTING' || status === 'FAILED') this.clearTimer(job.id);
    logger.info({ jobId: job.id, status, message }, 'Print job updated');
    this.emitJob(job);
  }

  private armTimer(job: PrintJob, ms: number, message: string): void {
    this.clearTimer(job.id);
    const timer = setTimeout(() => {
      if (['SENT', 'ACCEPTED', 'PREPARING'].includes(job.status)) this.update(job, 'TIMEOUT', message);
    }, ms);
    timer.unref?.();
    this.timers.set(job.id, timer);
  }

  private clearTimer(jobId: string): void {
    const timer = this.timers.get(jobId);
    if (timer) clearTimeout(timer);
    this.timers.delete(jobId);
  }

  private emitJob(job: PrintJob): void {
    this.emit('job.updated', job);
  }

  private trimJobs(): void {
    const sorted = this.getJobs();
    for (const job of sorted.slice(MAX_JOBS)) {
      if (!ACTIVE_STATUSES.has(job.status)) {
        this.jobs.delete(job.id);
        this.baselines.delete(job.id);
      }
    }
  }

  /** Test helper */
  public reset(): void {
    for (const id of this.timers.keys()) this.clearTimer(id);
    this.staged.clear();
    this.jobs.clear();
    this.baselines.clear();
    this.snapshot = { gcodeState: null, fun: null, printError: null, subtaskName: null, hms: [] };
  }
}

/** FTPS-safe file name: ASCII only, no spaces, keeps the .gcode.3mf / .3mf suffix */
/** snoopy.3mf → snoopy.gcode.3mf */
export function toSlicedFileName(fileName: string): string {
  return fileName.replace(/(\.gcode)?\.3mf$/i, '') + '.gcode.3mf';
}

export function toRemoteName(fileName: string): string {
  const base = path.basename(fileName.replace(/\\/g, '/'));
  const ascii = base
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, (c) => (c === 'đ' ? 'd' : 'D'))
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9._()-]/g, '');
  const withExt = /\.3mf$/i.test(ascii) ? ascii : `${ascii || 'print'}.3mf`;
  if (withExt.length <= 120) return withExt;
  const suffix = /\.gcode\.3mf$/i.test(withExt) ? '.gcode.3mf' : '.3mf';
  return withExt.slice(0, 120 - suffix.length) + suffix;
}

function subtaskNameOf(fileName: string): string {
  return path.basename(fileName).replace(/(\.gcode)?\.3mf$/i, '');
}

function formatPrintError(code: number): string {
  const hex = (code >>> 0).toString(16).toUpperCase().padStart(8, '0');
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}

function formatHms(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return null;
  const { attr, code } = entry as { attr?: unknown; code?: unknown };
  if (typeof attr !== 'number' || typeof code !== 'number') return null;
  const a = (attr >>> 0).toString(16).toUpperCase().padStart(8, '0');
  const c = (code >>> 0).toString(16).toUpperCase().padStart(8, '0');
  return `${a.slice(0, 4)}-${a.slice(4)}-${c.slice(0, 4)}-${c.slice(4)}`;
}
