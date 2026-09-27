import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { CsvSource } from '../src/csv-source';

describe('CsvSource', () => {
  let dir: string;

  const writeCsv = async (content: string): Promise<string> => {
    const file = join(dir, 'source.csv');
    await writeFile(file, content, 'utf8');
    return file;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'migrator-csv-'));
  });

  it('parses rows and builds a stable manifest', async () => {
    const file = await writeCsv('id,name\n1,Ana\n2,Bruno\n');
    const first = await new CsvSource(file).load();
    const second = await new CsvSource(file).load();

    expect(first.rows).toHaveLength(2);
    expect(first.manifest.rowCount).toBe(2);
    expect(first.manifest.columns).toEqual(['id', 'name']);
    expect(first.manifest.contentHash).toBe(second.manifest.contentHash);
  });

  it('changes the content hash when data changes', async () => {
    const file = await writeCsv('id,name\n1,Ana\n');
    const before = (await new CsvSource(file).load()).manifest.contentHash;

    await writeCsv('id,name\n1,Ana Maria\n');
    const after = (await new CsvSource(file).load()).manifest.contentHash;

    expect(after).not.toBe(before);
  });

  it('fails when the id column is missing', async () => {
    const file = await writeCsv('name\nAna\n');
    await expect(new CsvSource(file).load()).rejects.toThrow(/id column/);
  });

  it('fails on duplicate ids', async () => {
    const file = await writeCsv('id,name\n1,Ana\n1,Bruno\n');
    await expect(new CsvSource(file).load()).rejects.toThrow(/Duplicate id/);
  });

  it('fails on an empty id value', async () => {
    const file = await writeCsv('id,name\n,Ana\n');
    await expect(new CsvSource(file).load()).rejects.toThrow(/empty "id"/);
  });
});
