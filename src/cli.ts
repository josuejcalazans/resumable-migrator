#!/usr/bin/env node
import { Command } from 'commander';
import { CsvSource } from './csv-source';
import { NonRetryableError, SourceChangedError, StateError, VerificationError } from './errors';
import { HttpTarget } from './http-target';
import { createLogger } from './logger';
import { runMigration } from './migrate';
import { FileStateStore } from './state';

interface CliOptions {
  source: string;
  target: string;
  state: string;
  batchSize: string;
  idColumn: string;
  maxAttempts: string;
  dryRun?: boolean;
  reset?: boolean;
  verbose?: boolean;
}

function parsePositiveInt(flag: string, value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('resumable-migrator')
    .description('Resumable, exactly-once bulk data migration from CSV to a REST API')
    .version('1.0.0')
    .requiredOption('-s, --source <path>', 'path to the source CSV file')
    .requiredOption('-t, --target <url>', 'base URL of the target REST API')
    .option('--state <path>', 'path to the checkpoint file', '.migrator/state.json')
    .option('--batch-size <n>', 'rows per batch and checkpoint', '500')
    .option('--id-column <name>', 'CSV column used as the unique record id', 'id')
    .option('--max-attempts <n>', 'attempts per batch before failing', '3')
    .option('--dry-run', 'print the migration plan without writing anything', false)
    .option('--reset', 'discard any existing checkpoint and start from scratch', false)
    .option('--verbose', 'debug logging (shows retries)', false)
    .parse();

  const opts = program.opts<CliOptions>();
  const batchSize = parsePositiveInt('--batch-size', opts.batchSize);
  const maxAttempts = parsePositiveInt('--max-attempts', opts.maxAttempts);
  const log = createLogger(opts.verbose);

  await runMigration({
    source: new CsvSource(opts.source, opts.idColumn),
    target: new HttpTarget(opts.target, {
      maxAttempts,
      backoff: { baseMs: 250, capMs: 4000 },
      log,
    }),
    state: new FileStateStore(opts.state),
    batchSize,
    dryRun: opts.dryRun,
    reset: opts.reset,
    log,
  });
}

main().catch((error: unknown) => {
  if (error instanceof VerificationError) {
    console.error(`ERROR ${error.message}`);
    process.exit(2);
  }
  if (
    error instanceof NonRetryableError ||
    error instanceof SourceChangedError ||
    error instanceof StateError
  ) {
    console.error(`ERROR ${error.message}`);
    process.exit(1);
  }
  console.error(`ERROR ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
