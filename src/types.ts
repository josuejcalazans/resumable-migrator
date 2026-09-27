export interface Manifest {
  rowCount: number;
  headerHash: string;
  contentHash: string;
  columns: string[];
}

export interface SourceRow {
  id: string;
  values: Record<string, string>;
}

export interface LoadedSource {
  manifest: Manifest;
  rows: SourceRow[];
}

export interface Source {
  load(): Promise<LoadedSource>;
}

export interface BatchPayload {
  batchIndex: number;
  idempotencyKey: string;
  rows: SourceRow[];
}

export interface TargetStats {
  count: number;
  distinctIds: number;
  committedBatches: number;
}

export interface Target {
  sendBatch(payload: BatchPayload): Promise<void>;
  stats(): Promise<TargetStats>;
}

export type Phase = 'discover' | 'transfer' | 'verify' | 'complete';

export interface MigrationState {
  version: number;
  phase: Phase;
  manifest: Manifest;
  batchesCompleted: number;
  totalBatches: number;
  startedAt: string;
  updatedAt: string;
}

export interface StateStore {
  load(): Promise<MigrationState | null>;
  save(state: MigrationState): Promise<void>;
  clear(): Promise<void>;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}
