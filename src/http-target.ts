import { computeBackoff, sleep, type BackoffOptions } from './backoff';
import { NonRetryableError } from './errors';
import type { BatchPayload, Logger, Target, TargetStats } from './types';

export interface HttpTargetOptions {
  backoff: BackoffOptions;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  log?: Logger;
}

export class HttpTarget implements Target {
  private readonly baseUrl: string;
  private readonly backoff: BackoffOptions;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log?: Logger;

  constructor(baseUrl: string, options: HttpTargetOptions) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.backoff = options.backoff;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log;
  }

  async sendBatch(payload: BatchPayload): Promise<void> {
    let lastError: unknown;

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (attempt > 0) {
        const delay = computeBackoff(attempt - 1, this.backoff);
        this.log?.debug(
          `retry ${attempt}/${this.maxAttempts - 1} for batch ${payload.batchIndex} in ${delay}ms`,
        );
        await sleep(delay);
      }

      try {
        const response = await this.fetchImpl(`${this.baseUrl}/items`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': payload.idempotencyKey,
          },
          body: JSON.stringify(payload),
        });

        if (response.ok) return;

        const body = (await response.text()).slice(0, 300);
        const retryable = response.status >= 500 || response.status === 429;
        if (!retryable) {
          throw new NonRetryableError(
            `Target rejected batch ${payload.batchIndex} with HTTP ${response.status}: ${body}`,
          );
        }
        lastError = new Error(
          `HTTP ${response.status} from target for batch ${payload.batchIndex}: ${body}`,
        );
      } catch (error) {
        if (error instanceof NonRetryableError) throw error;
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async stats(): Promise<TargetStats> {
    const response = await this.fetchImpl(`${this.baseUrl}/items/stats`);
    if (!response.ok) {
      throw new Error(`Failed to read target stats: HTTP ${response.status}`);
    }
    return (await response.json()) as TargetStats;
  }
}
