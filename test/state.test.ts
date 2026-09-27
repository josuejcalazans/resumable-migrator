import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { StateError } from '../src/errors';
import { FileStateStore } from '../src/state';
import type { MigrationState } from '../src/types';

const sample: MigrationState = {
  version: 1,
  phase: 'transfer',
  manifest: { rowCount: 10, headerHash: 'header', contentHash: 'content', columns: ['id'] },
  batchesCompleted: 2,
  totalBatches: 4,
  startedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z',
};

describe('FileStateStore', () => {
  let dir: string;
  let path: string;
  let store: FileStateStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'migrator-state-'));
    path = join(dir, 'nested', 'state.json');
    store = new FileStateStore(path);
  });

  it('returns null when no state file exists', async () => {
    expect(await store.load()).toBeNull();
  });

  it('round-trips state', async () => {
    await store.save(sample);
    expect(await store.load()).toEqual(sample);
  });

  it('writes atomically — no temp files left behind', async () => {
    await store.save(sample);
    const files = await readdir(join(dir, 'nested'));
    expect(files).toEqual(['state.json']);
  });

  it('rejects invalid JSON with a --reset hint', async () => {
    await store.save(sample);
    await writeFile(path, '{not json', 'utf8');
    await expect(store.load()).rejects.toThrow(/--reset/);
  });

  it('rejects an incompatible state version', async () => {
    await store.save(sample);
    const raw = JSON.parse(await readFile(path, 'utf8')) as MigrationState;
    raw.version = 99;
    await writeFile(path, JSON.stringify(raw), 'utf8');
    await expect(store.load()).rejects.toThrow(StateError);
  });

  it('clear() is idempotent', async () => {
    await store.save(sample);
    await store.clear();
    await store.clear();
    expect(await store.load()).toBeNull();
  });
});
