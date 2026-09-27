import { readFile } from 'node:fs/promises';
import Papa from 'papaparse';
import { computeManifest } from './manifest';
import type { LoadedSource, Source } from './types';

export class CsvSource implements Source {
  constructor(
    private readonly path: string,
    private readonly idColumn = 'id',
  ) {}

  async load(): Promise<LoadedSource> {
    const text = await readFile(this.path, 'utf8');
    const parsed = Papa.parse<Record<string, string>>(text, {
      header: true,
      skipEmptyLines: true,
    });

    const fatalError = parsed.errors.find((error) => error.code !== 'UndetectableDelimiter');
    if (fatalError) {
      throw new Error(
        `Failed to parse ${this.path}: ${fatalError.message} (row ${fatalError.row ?? '?'})`,
      );
    }

    const columns = parsed.meta.fields ?? [];
    if (columns.length === 0) {
      throw new Error(`${this.path} has no header row`);
    }
    if (!columns.includes(this.idColumn)) {
      throw new Error(
        `${this.path} is missing the id column "${this.idColumn}" (found: ${columns.join(', ')})`,
      );
    }

    const rows = parsed.data.map((record, index) => {
      const id = (record[this.idColumn] ?? '').trim();
      if (!id) {
        throw new Error(`Row ${index + 2} has an empty "${this.idColumn}" value`);
      }
      return { id, values: record };
    });

    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.id)) {
        throw new Error(`Duplicate id "${row.id}" in ${this.path} — ids must be unique`);
      }
      seen.add(row.id);
    }

    return { manifest: computeManifest(columns, rows), rows };
  }
}
