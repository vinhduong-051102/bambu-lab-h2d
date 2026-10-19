import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { env } from '../config/env';
import { logger } from '../logger/logger';

export const TARGET_PRINTER = 'Bambu Lab H2D';

export interface SliceProfiles {
  machine: string;
  process: string;
  filaments: string[];
}

export interface SliceResult {
  data: Uint8Array;
  sourcePrinter: string | null;
  nozzle: string;
  /** Build plate the G-code was sliced for (bed temperatures depend on it) */
  bedType: string | null;
  /** System presets swapped in for a project made for another printer; null when its own settings were used */
  profiles: SliceProfiles | null;
  warnings: string[];
  durationMs: number;
}

/** Duck-typed like CommandExecutionError/PrintJobError so commandErrorResponse maps it to JSON */
export class SlicerError extends Error {
  constructor(message: string, public statusCode: number, public errorCode: string, public details?: unknown) {
    super(message);
    this.name = 'SlicerError';
  }
}

export interface SlicerRunRequest {
  workDir: string;
  inputName: string;
  outputName: string;
  nozzle: string | null;
  bedType: string | null;
  timeoutMs: number;
}

export interface SlicerRunOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type SlicerRunner = (req: SlicerRunRequest) => Promise<SlicerRunOutput>;

const MAX_CAPTURE = 64 * 1024;

/**
 * Runs slicer/slice.py in the SLICER_DOCKER_IMAGE container: no network, the gateway's uid/gid,
 * with only the job's work directory mounted. The container is named so a timeout can kill it
 * (killing the `docker run` client alone would leave the container running).
 */
export const dockerSlicerRunner: SlicerRunner = (req) =>
  new Promise((resolve, reject) => {
    const containerName = `bambu-h2d-slice-${randomUUID().slice(0, 8)}`;
    const user = typeof process.getuid === 'function' ? [`--user`, `${process.getuid()}:${process.getgid?.()}`] : [];
    const args = [
      'run', '--rm', '--name', containerName, '--network', 'none', ...user,
      '-v', `${req.workDir}:/work`,
      env.SLICER_DOCKER_IMAGE!,
      '--input', `/work/${req.inputName}`,
      '--output', `/work/${req.outputName}`,
      '--printer', TARGET_PRINTER,
      ...(req.nozzle ? ['--nozzle', req.nozzle] : []),
      ...(req.bedType ? ['--bed-type', req.bedType] : []),
    ];

    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => (stdout = (stdout + chunk).slice(-MAX_CAPTURE)));
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-MAX_CAPTURE)));

    const timer = setTimeout(() => {
      timedOut = true;
      spawn('docker', ['kill', containerName], { stdio: 'ignore' }).on('error', () => undefined);
      child.kill('SIGTERM');
    }, req.timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    });
  });

/**
 * Slices unsliced project .3mf files for the H2D with headless Bambu Studio, one at a time
 * (each slice can use every CPU core for minutes).
 */
export class BambuSlicer {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private runner: SlicerRunner = dockerSlicerRunner,
    public workRoot = path.join(os.tmpdir(), 'bambu-h2d-gateway', 'slicing')
  ) {}

  public isEnabled(): boolean {
    return !!env.SLICER_DOCKER_IMAGE && env.SLICER_DOCKER_IMAGE.trim() !== '';
  }

  /** `extension` is the input's file type: ".3mf" (default) or a bare model (".stl", ".obj", ".step", ".stp") */
  public slice(project: Uint8Array, options: { nozzle?: string | null; extension?: string } = {}): Promise<SliceResult> {
    const run = this.queue.then(() => this.sliceNow(project, options.nozzle ?? null, options.extension ?? '.3mf'));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async sliceNow(project: Uint8Array, nozzle: string | null, extension: string): Promise<SliceResult> {
    if (!this.isEnabled()) {
      throw new SlicerError('Gateway chưa bật slice tự động (SLICER_DOCKER_IMAGE).', 501, 'SLICER_DISABLED');
    }

    await fs.mkdir(this.workRoot, { recursive: true });
    const workDir = await fs.mkdtemp(path.join(this.workRoot, 'job-'));
    const startedAt = Date.now();
    try {
      const inputName = `input${extension}`;
      await fs.writeFile(path.join(workDir, inputName), project);
      logger.info({ workDir, nozzle, image: env.SLICER_DOCKER_IMAGE }, 'Slicing project with Bambu Studio');

      let output: SlicerRunOutput;
      try {
        output = await this.runner({
          workDir,
          inputName,
          outputName: 'output.gcode.3mf',
          nozzle,
          bedType: env.SLICER_BED_TYPE ?? null,
          timeoutMs: env.SLICER_TIMEOUT_MS,
        });
      } catch (err) {
        throw new SlicerError(
          `Không chạy được slicer (docker): ${err instanceof Error ? err.message : String(err)}`,
          500,
          'SLICER_UNAVAILABLE'
        );
      }

      if (output.timedOut) {
        throw new SlicerError(`Slice quá thời gian cho phép (${Math.round(env.SLICER_TIMEOUT_MS / 1000)}s).`, 504, 'SLICE_TIMEOUT');
      }

      const outcome = parseOutcome(output.stdout);
      if (!outcome?.ok) {
        logger.warn({ exitCode: output.exitCode, stderr: output.stderr.slice(-2000), outcome }, 'Slicing failed');
        const message = typeof outcome?.message === 'string'
          ? outcome.message
          : `Slicer lỗi (exit code ${output.exitCode}): ${output.stderr.trim().split('\n').pop() ?? ''}`;
        const code = typeof outcome?.error === 'string' ? outcome.error : 'SLICE_FAILED';
        throw new SlicerError(message, code === 'INVALID_3MF' ? 422 : 500, code);
      }

      const data = new Uint8Array(await fs.readFile(path.join(workDir, 'output.gcode.3mf')));
      const durationMs = Date.now() - startedAt;
      logger.info({ durationMs, profiles: outcome.profiles ?? null }, 'Slicing finished');
      return {
        data,
        sourcePrinter: typeof outcome.sourcePrinter === 'string' ? outcome.sourcePrinter : null,
        nozzle: String(outcome.nozzle ?? nozzle ?? ''),
        bedType: typeof outcome.bedType === 'string' ? outcome.bedType : null,
        profiles: (outcome.profiles as SliceProfiles | null) ?? null,
        warnings: Array.isArray(outcome.warnings) ? outcome.warnings.filter((w): w is string => typeof w === 'string') : [],
        durationMs,
      };
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }
}

/** slice.py prints exactly one JSON line; anything else on stdout is ignored */
function parseOutcome(stdout: string): Record<string, unknown> | null {
  const lines = stdout.trim().split('\n').reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && 'ok' in parsed) return parsed;
    } catch {
      /* not the outcome line */
    }
  }
  return null;
}
