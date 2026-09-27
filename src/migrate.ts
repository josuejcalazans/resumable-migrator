import { assertSameManifest } from './manifest';
import { VerificationError } from './errors';
import { STATE_VERSION } from './state';
import type { Logger, MigrationState, Source, StateStore, Target } from './types';

export interface RunMigrationOptions {
  source: Source;
  target: Target;
  state: StateStore;
  batchSize: number;
  dryRun?: boolean;
  reset?: boolean;
  log: Logger;
}

export interface MigrationSummary {
  status: 'completed' | 'dry-run';
  rowCount: number;
  totalBatches: number;
  resumedFromBatch: number;
  durationMs: number;
}

export async function runMigration(options: RunMigrationOptions): Promise<MigrationSummary> {
  const { source, target, state, batchSize, dryRun = false, reset = false, log } = options;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error('batchSize must be a positive integer');
  }

  if (reset) {
    await state.clear();
    log.debug('existing checkpoint cleared');
  }

  log.info('discover: loading source…');
  const { manifest, rows } = await source.load();
  const totalBatches = Math.ceil(manifest.rowCount / batchSize);
  const existing = await state.load();

  if (existing) {
    assertSameManifest(existing.manifest, manifest);
  }

  if (dryRun) {
    const resumeFrom = existing ? existing.batchesCompleted : 0;
    log.info(`dry-run: ${manifest.rowCount} rows → ${totalBatches} batches of ${batchSize}`);
    if (resumeFrom > 0 && resumeFrom < totalBatches) {
      log.info(`dry-run: would resume at batch ${resumeFrom}/${totalBatches}`);
    }
    return {
      status: 'dry-run',
      rowCount: manifest.rowCount,
      totalBatches,
      resumedFromBatch: resumeFrom,
      durationMs: 0,
    };
  }

  const resumedFromBatch = existing ? Math.min(existing.batchesCompleted, totalBatches) : 0;
  const startedAt = existing?.startedAt ?? new Date().toISOString();
  const now = () => new Date().toISOString();
  const checkpoint = (phase: MigrationState['phase'], batchesCompleted: number): Promise<void> =>
    state.save({
      version: STATE_VERSION,
      phase,
      manifest,
      batchesCompleted,
      totalBatches,
      startedAt,
      updatedAt: now(),
    });

  let batchesCompleted = resumedFromBatch;
  await checkpoint('transfer', batchesCompleted);
  if (resumedFromBatch > 0 && resumedFromBatch < totalBatches) {
    log.info(`transfer: resuming at batch ${resumedFromBatch}/${totalBatches}`);
  }

  const started = Date.now();
  for (let batchIndex = batchesCompleted; batchIndex < totalBatches; batchIndex++) {
    const slice = rows.slice(batchIndex * batchSize, (batchIndex + 1) * batchSize);
    const idempotencyKey = `${manifest.contentHash.slice(0, 16)}:${batchIndex}`;
    await target.sendBatch({ batchIndex, idempotencyKey, rows: slice });
    batchesCompleted = batchIndex + 1;
    await checkpoint('transfer', batchesCompleted);
    const rowsSoFar = Math.min(batchesCompleted * batchSize, manifest.rowCount);
    log.info(
      `transfer: batch ${batchesCompleted}/${totalBatches} committed (${rowsSoFar}/${manifest.rowCount} rows)`,
    );
  }

  log.info('verify: comparing target against source manifest…');
  const stats = await target.stats();
  if (stats.count !== manifest.rowCount || stats.distinctIds !== manifest.rowCount) {
    await checkpoint('verify', totalBatches);
    throw new VerificationError(
      `Verification failed: source has ${manifest.rowCount} rows but the target reports ` +
        `${stats.count} rows (${stats.distinctIds} distinct ids). The target may already ` +
        `contain foreign data. State was saved — fix the target and re-run to retry verification.`,
    );
  }

  await checkpoint('complete', totalBatches);
  const durationMs = Date.now() - started;
  log.info(`complete: ${manifest.rowCount} rows migrated and verified in ${durationMs}ms`);

  return {
    status: 'completed',
    rowCount: manifest.rowCount,
    totalBatches,
    resumedFromBatch,
    durationMs,
  };
}
