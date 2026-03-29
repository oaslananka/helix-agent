import { PolicyDeniedError } from '../errors/index.js';
import { logger } from './logger.js';

export interface GlobalPolicy {
  maxConcurrentCalls: number;
  callTimeoutMs: number;
  redactionPatterns: RegExp[];
}

export class ConcurrencyController {
  private activeCalls = 0;
  private queue: Array<{
    requestId: string;
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];

  constructor(private maxConcurrent: number) {}

  async acquire(requestId: string): Promise<void> {
    if (this.activeCalls < this.maxConcurrent) {
      this.activeCalls++;
      logger.debug(
        { requestId, active: this.activeCalls, max: this.maxConcurrent },
        'Call acquired'
      );
      return;
    }

    // Queue the request
    return new Promise((resolve, reject) => {
      this.queue.push({ requestId, resolve, reject });
      logger.debug(
        { requestId, queued: this.queue.length, active: this.activeCalls },
        'Call queued'
      );
    });
  }

  release(requestId: string): void {
    this.activeCalls--;

    const next = this.queue.shift();
    if (next) {
      this.activeCalls++;
      logger.debug(
        { requestId: next.requestId, active: this.activeCalls },
        'Call dequeued and acquired'
      );
      next.resolve();
    }
  }

  rejectAll(reason: string): void {
    for (const item of this.queue) {
      item.reject(new PolicyDeniedError(reason));
    }
    this.queue = [];
    logger.info({ rejected: this.queue.length }, 'All queued calls rejected');
  }

  getStats(): { active: number; queued: number } {
    return { active: this.activeCalls, queued: this.queue.length };
  }
}
