import type { Logger } from './types';

export function createLogger(verbose = false): Logger {
  const stamp = () => new Date().toISOString();
  return {
    info: (message) => console.log(`[${stamp()}] INFO  ${message}`),
    warn: (message) => console.warn(`[${stamp()}] WARN  ${message}`),
    error: (message) => console.error(`[${stamp()}] ERROR ${message}`),
    debug: (message) => {
      if (verbose) console.log(`[${stamp()}] DEBUG ${message}`);
    },
  };
}

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};
