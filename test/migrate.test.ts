import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CsvSource } from '../src/csv-source';
import { SourceChangedError, VerificationError } from '../src/errors';
import { HttpTarget } from '../src/http-target';
import { silentLogger } from '../src/logger';
import { runMigration, type RunMigrationOptions } from '../src/migrate';
import { createMockTargetServer, type MockTargetServer } from '../src/mock-target';
import { FileStateStore } from '../src/state';

const FAST_BACKOFF = { baseMs: 1, capMs: 2 };

function makeCsv(rowCount: number): string {
  const lines = ['id,email,company'];
  for (let i = 1; i <= rowCount; i++) {
    lines.push(`${i},user${i}@example.com,Acme ${i % 7}`);
  }
  return `${lines.join('\n')}\n`;
}

describe('runMigration', () => {
  let dir: string;
  let csvPath: string;
  let statePath: string;
  let target: MockTargetServer;
  let store: FileStateStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'migrator-e2e-'));
    csvPath = join(dir, 'source.csv');
    statePath = join(dir, 'state', 'state.json');
    target = createMockTargetServer();
    await target.listen();
    store = new FileStateStore(statePath);
  });

  afterEach(async () => {
    await target.close();
  });

  const setup = (overrides: Partial<RunMigrationOptions> = {}): RunMigrationOptions => ({
    source: new CsvSource(csvPath),
    target: new HttpTarget(target.baseUrl(), { backoff: FAST_BACKOFF }),
    state: store,
    batchSize: 300,
    log: silentLogger,
    ...overrides,
  });

  it('migrates every row exactly once and marks state complete', async () => {
    await writeFile(csvPath, makeCsv(1000), 'utf8');

    const summary = await runMigration(setup());

    expect(summary.status).toBe('completed');
    expect(summary.totalBatches).toBe(4);
    expect(summary.resumedFromBatch).toBe(0);

    const stats = target.stats();
    expect(stats.count).toBe(1000);
    expect(stats.distinctIds).toBe(1000);
    expect(stats.committedBatches).toBe(4);

    expect((await store.load())?.phase).toBe('complete');
  });

  it('resumes from the checkpoint after the target keeps failing', async () => {
    await writeFile(csvPath, makeCsv(1000), 'utf8');
    target.failAfterCommits(2, 'fail500');

    const failing = new HttpTarget(target.baseUrl(), {
      backoff: FAST_BACKOFF,
      maxAttempts: 2,
    });
    await expect(runMigration(setup({ target: failing }))).rejects.toThrow(/HTTP 500/);

    const failedState = await store.load();
    expect(failedState?.phase).toBe('transfer');
    expect(failedState?.batchesCompleted).toBe(2);

    target.clearFailures();
    const summary = await runMigration(setup());

    expect(summary.resumedFromBatch).toBe(2);
    const stats = target.stats();
    expect(stats.count).toBe(1000);
    expect(stats.distinctIds).toBe(1000);
    expect(stats.committedBatches).toBe(4);
  });

  it('does not duplicate rows when the target commits but the response is lost', async () => {
    await writeFile(csvPath, makeCsv(600), 'utf8');
    target.queueFailures('commitThenFail500', 'commitThenFail500');

    const summary = await runMigration(
      setup({
        target: new HttpTarget(target.baseUrl(), { backoff: FAST_BACKOFF, maxAttempts: 3 }),
      }),
    );

    expect(summary.status).toBe('completed');
    expect(target.stats().count).toBe(600);
    expect(target.stats().distinctIds).toBe(600);
    expect(target.requestCount()).toBeGreaterThan(3);
  });

  it('fails fast on non-retryable 4xx responses', async () => {
    await writeFile(csvPath, makeCsv(100), 'utf8');
    target.queueFailures('fail400');

    const http = new HttpTarget(target.baseUrl(), { backoff: FAST_BACKOFF, maxAttempts: 3 });
    await expect(runMigration(setup({ target: http }))).rejects.toThrow(/HTTP 400/);

    expect(target.requestCount()).toBe(1);
    expect((await store.load())?.batchesCompleted).toBe(0);
  });

  it('dry-run touches neither the target nor the state file', async () => {
    await writeFile(csvPath, makeCsv(500), 'utf8');

    const summary = await runMigration(setup({ dryRun: true }));

    expect(summary.status).toBe('dry-run');
    expect(summary.rowCount).toBe(500);
    expect(target.stats().committedBatches).toBe(0);
    expect(await store.load()).toBeNull();
  });

  it('detects a source that changed between runs', async () => {
    await writeFile(csvPath, makeCsv(500), 'utf8');
    await runMigration(setup());

    await writeFile(csvPath, makeCsv(400), 'utf8');
    await expect(runMigration(setup())).rejects.toThrow(SourceChangedError);
  });

  it('verification fails when the target already holds foreign rows', async () => {
    await writeFile(csvPath, makeCsv(300), 'utf8');
    const http = new HttpTarget(target.baseUrl(), { backoff: FAST_BACKOFF });
    await http.sendBatch({
      batchIndex: 99,
      idempotencyKey: 'foreign',
      rows: [{ id: 'foreign-1', values: { id: 'foreign-1' } }],
    });

    await expect(runMigration(setup())).rejects.toThrow(VerificationError);
    expect((await store.load())?.phase).toBe('verify');
  });

  it('re-running after completion re-verifies without re-transferring', async () => {
    await writeFile(csvPath, makeCsv(300), 'utf8');
    await runMigration(setup());

    const again = await runMigration(setup());

    expect(again.status).toBe('completed');
    expect(target.stats().count).toBe(300);
    expect(target.stats().committedBatches).toBe(1);
  });
});
