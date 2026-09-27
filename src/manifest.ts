import { createHash } from 'node:crypto';
import { SourceChangedError } from './errors';
import type { Manifest, SourceRow } from './types';

const FIELD_SEPARATOR = '\u0000';
const VALUE_SEPARATOR = '\u0001';

export function computeManifest(columns: string[], rows: SourceRow[]): Manifest {
  const headerHash = createHash('sha256').update(columns.join(FIELD_SEPARATOR)).digest('hex');
  const hash = createHash('sha256');
  for (const row of rows) {
    hash.update(row.id);
    hash.update(VALUE_SEPARATOR);
    for (const column of columns) {
      hash.update(row.values[column] ?? '');
      hash.update(VALUE_SEPARATOR);
    }
  }
  return { rowCount: rows.length, headerHash, contentHash: hash.digest('hex'), columns };
}

export function assertSameManifest(expected: Manifest, actual: Manifest): void {
  const unchanged =
    expected.rowCount === actual.rowCount &&
    expected.headerHash === actual.headerHash &&
    expected.contentHash === actual.contentHash;
  if (!unchanged) {
    throw new SourceChangedError(
      `Source changed since the migration started ` +
        `(expected ${expected.rowCount} rows / ${expected.contentHash.slice(0, 12)}, ` +
        `got ${actual.rowCount} rows / ${actual.contentHash.slice(0, 12)}). ` +
        `Re-run with --reset to start over.`,
    );
  }
}
