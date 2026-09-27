import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StateError } from './errors';
import type { MigrationState, Phase, StateStore } from './types';

export const STATE_VERSION = 1;

const VALID_PHASES: Phase[] = ['discover', 'transfer', 'verify', 'complete'];

function validateState(value: unknown): asserts value is MigrationState {
  const state = value as MigrationState | null;
  const valid =
    !!state &&
    typeof state === 'object' &&
    state.version === STATE_VERSION &&
    VALID_PHASES.includes(state.phase) &&
    !!state.manifest &&
    typeof state.manifest.rowCount === 'number' &&
    typeof state.manifest.contentHash === 'string' &&
    typeof state.manifest.headerHash === 'string' &&
    typeof state.batchesCompleted === 'number' &&
    typeof state.totalBatches === 'number' &&
    typeof state.startedAt === 'string';
  if (!valid) {
    throw new StateError(
      `State file is corrupt or was written by an incompatible version. Delete it or re-run with --reset.`,
    );
  }
}

export class FileStateStore implements StateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<MigrationState | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new StateError(
        `State file ${this.path} contains invalid JSON. Delete it or re-run with --reset.`,
      );
    }

    validateState(parsed);
    return parsed;
  }

  async save(state: MigrationState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await rename(tmp, this.path);
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
