import { logger } from '../../logger/logger.js';

export type QueueTask<T> = () => Promise<T>;

export interface QueueItem<T> {
  id: string;
  commandName: string;
  task: QueueTask<T>;
  resolve: (value: T) => void;
  reject: (reason?: any) => void;
  timeoutMs: number;
}

export class CommandQueue {
  private queue: QueueItem<any>[] = [];
  private processing = false;

  public enqueue<T>(id: string, commandName: string, task: QueueTask<T>, timeoutMs = 10000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        id,
        commandName,
        task,
        resolve,
        reject,
        timeoutMs,
      });

      this.processNext();
    });
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;
    const item = this.queue.shift()!;

    let timeoutTimer: NodeJS.Timeout | null = null;
    let completed = false;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        if (!completed) {
          completed = true;
          reject(new Error(`Command '${item.commandName}' timed out after ${item.timeoutMs}ms`));
        }
      }, item.timeoutMs);
    });

    try {
      logger.info({ commandId: item.id, command: item.commandName }, 'Executing command in queue');
      const result = await Promise.race([item.task(), timeoutPromise]);
      completed = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      item.resolve(result);
    } catch (err) {
      completed = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      logger.error({ commandId: item.id, command: item.commandName, error: err }, 'Command execution error');
      item.reject(err);
    } finally {
      this.processing = false;
      // Process next queued command
      setImmediate(() => this.processNext());
    }
  }

  public getPendingCount(): number {
    return this.queue.length;
  }
}
