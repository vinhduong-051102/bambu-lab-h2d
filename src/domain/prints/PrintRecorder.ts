import { logger } from '../../logger/logger';
import type { PrinterState } from '../PrinterState';
import type { PrinterStateStore } from '../PrinterStateStore';
import type { PrintJournal, PrintRecord } from './PrintJournal';

export interface FrameSource {
  getLatestFrame(): Buffer | null;
}

export interface PrintRecorderOptions {
  /** Wait after the print ends before the camera shot, so the toolhead has parked */
  photoDelayMs?: number;
  now?: () => Date;
}

/**
 * Opens a print record when the printer starts a job (with the settings Studio sent for it) and, when
 * the job finishes or fails, closes it and keeps a photo from the printer camera. A print that ended while
 * the gateway wasn't running is closed when the gateway starts again: with the outcome the printer still
 * shows for it, or as unknown once the printer shows another job.
 */
export class PrintRecorder {
  private current: PrintRecord | null = null;
  private lastStatus: PrinterState['state'] | null = null;
  /** The last ended job checked for a record left open ("finished:Plate01") */
  private missedChecked: string | null = null;
  // State changes arrive faster than the disk work they start: run that work one step at a time
  private queue: Promise<unknown> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;
  private readonly photoDelayMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly journal: PrintJournal,
    private readonly stateStore: PrinterStateStore,
    private readonly camera: FrameSource | undefined,
    options: PrintRecorderOptions = {}
  ) {
    this.photoDelayMs = options.photoDelayMs ?? 8000;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    this.unsubscribe = this.stateStore.subscribe((state) => this.onState(state));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Resolves once every step started so far is done (for tests) */
  idle(): Promise<unknown> {
    return this.queue;
  }

  private enqueue(step: () => Promise<void>): void {
    this.queue = this.queue.then(step).catch((err) => {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, '[PRINT HISTORY] Recording a print failed');
    });
  }

  private onState(state: PrinterState): void {
    const status = state.state;
    const jobName = state.job.name?.trim() || null;
    const previous = this.lastStatus;
    this.lastStatus = status;

    if ((status === 'RUNNING' || status === 'PAUSED') && jobName) {
      // A first RUNNING after another state is a new job; RUNNING while we track nothing (gateway
      // restarted mid-print, or the job name only just arrived) picks the print up where it is
      const isNewJob = previous !== 'RUNNING' && previous !== 'PAUSED' && previous !== null;
      if (!this.current || this.current.job_name !== jobName) this.enqueue(() => this.open(jobName, isNewJob));
      return;
    }
    if (status === 'FINISHED' || status === 'FAILED') {
      const ended = status === 'FINISHED' ? 'finished' : 'failed';
      if (previous === 'RUNNING' || previous === 'PAUSED') {
        this.enqueue(() => this.close(ended));
        return;
      }
      // The print ended while the gateway wasn't running: the printer still shows how, but not when.
      // Checked once per job and outcome, the printer repeats its state every few seconds.
      const missed = `${ended}:${jobName}`;
      if (!this.current && jobName && this.missedChecked !== missed) {
        this.missedChecked = missed;
        this.enqueue(() => this.closeMissed(jobName, ended));
      }
    }
  }

  private async open(jobName: string, startedNow: boolean): Promise<void> {
    if (this.current?.job_name === jobName) return;
    const records = await this.closeOthers(jobName);
    // After a gateway restart, keep filling the record already open for this job
    const open = records.find((r) => r.status === 'printing' && r.job_name === jobName);
    if (open) {
      this.current = open;
      return;
    }
    const setup = await this.journal.takePendingSetup(jobName, this.now());
    this.current = await this.journal.create(jobName, startedNow ? this.now() : null, setup, this.now());
    logger.info({ id: this.current.id, jobName, withSettings: !!setup }, '[PRINT HISTORY] Print started');
  }

  private async close(status: 'finished' | 'failed'): Promise<void> {
    const record = this.current;
    if (!record) return;
    this.current = null;
    const endedAt = this.now();
    await this.journal.update(record.id, (r) => {
      r.status = status;
      r.ended_at = endedAt.toISOString();
    });
    logger.info({ id: record.id, status }, '[PRINT HISTORY] Print ended');

    if (!this.camera) return;
    await new Promise((resolve) => setTimeout(resolve, this.photoDelayMs));
    const frame = this.camera.getLatestFrame();
    if (!frame) {
      logger.warn({ id: record.id }, '[PRINT HISTORY] No camera frame to keep for this print');
      return;
    }
    await this.journal.addPhoto(record.id, frame, 'camera', '.jpg', this.now());
  }

  /**
   * Prints still open under another name than the printer's job ended while the gateway wasn't running:
   * closed as unknown. Returns the recent records, as they were before.
   */
  private async closeOthers(jobName: string): Promise<PrintRecord[]> {
    const records = await this.journal.list(20);
    for (const stale of records.filter((r) => r.status === 'printing' && r.job_name !== jobName)) {
      await this.journal.update(stale.id, (r) => {
        r.status = 'unknown';
      });
      logger.info({ id: stale.id, jobName: stale.job_name }, '[PRINT HISTORY] Print ended unseen, outcome unknown');
    }
    return records;
  }

  /** Closes the record still open for this job with the printer's outcome; no end time and no photo */
  private async closeMissed(jobName: string, status: 'finished' | 'failed'): Promise<void> {
    const open = (await this.closeOthers(jobName)).find((r) => r.status === 'printing' && r.job_name === jobName);
    if (!open) return;
    await this.journal.update(open.id, (r) => {
      r.status = status;
    });
    logger.info({ id: open.id, status }, '[PRINT HISTORY] Print ended while the gateway was off');
  }
}
