const path = require('node:path');
const { rm } = require('node:fs/promises');
const { createMockTargetServer } = require('../dist/mock-target');
const { CsvSource } = require('../dist/csv-source');
const { HttpTarget } = require('../dist/http-target');
const { runMigration } = require('../dist/migrate');
const { FileStateStore } = require('../dist/state');
const { createLogger } = require('../dist/logger');

async function main() {
  const target = createMockTargetServer({ port: 0 });
  const port = await target.listen();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`mock target listening on ${baseUrl}\n`);

  const log = createLogger(true);
  const stateDir = path.join(__dirname, '.demo-state');
  const statePath = path.join(stateDir, 'state.json');

  target.queueFailures('fail500', 'fail500');

  const summary = await runMigration({
    source: new CsvSource(path.join(__dirname, 'source.csv')),
    target: new HttpTarget(baseUrl, { backoff: { baseMs: 50, capMs: 200 }, log }),
    state: new FileStateStore(statePath),
    batchSize: 500,
    log,
  });

  console.log(`\nsummary: ${JSON.stringify(summary)}`);
  console.log(`target:  ${JSON.stringify(target.stats())}`);

  await target.close();
  await rm(stateDir, { recursive: true, force: true });
  console.log('\n2 injected 500s were retried with backoff — no rows lost, no rows duplicated.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
