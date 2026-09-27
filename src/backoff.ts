export interface BackoffOptions {
  baseMs: number;
  capMs: number;
  jitterRatio?: number;
  rand?: () => number;
}

export function computeBackoff(attempt: number, options: BackoffOptions): number {
  const { baseMs, capMs, jitterRatio = 0.25, rand = Math.random } = options;
  const exponential = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(exponential + rand() * jitterRatio * exponential);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
