# resumable-migrator

> Resumable, exactly-once bulk data migration from CSV to a REST API — with atomic
> checkpointing, retries with backoff, and a verification phase that refuses to call a
> migration "done" until the target actually matches the source.

[![CI](https://github.com/josuejcalazans/resumable-migrator/actions/workflows/ci.yml/badge.svg)](https://github.com/josuejcalazans/resumable-migrator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![Open in GitHub Codespaces](https://github.com/codespaces/badge/main)](https://github.com/codespaces/new?hide_repo_select=1&ref=main&repo=1391188963)

> **Try it in the browser:** **Open in Codespaces** boots a ready-to-run Node 22
> environment (~30s) — run `npm run demo` in the terminal and watch the migration
> recover from injected failures live.

## Why

Migrating data between systems fails mid-run: the network resets, the API returns a 503,
the laptop sleeps. If you re-run a naive script, the target ends up with duplicate rows —
or worse, a silent partial import that nobody notices until production reports are wrong.

**resumable-migrator** makes any batch-level failure safely resumable:

- every batch is **checkpointed atomically** (write-temp + rename) after it commits,
- every batch carries an **idempotency key**, so a replayed request is a no-op on the target,
- a final **verify phase** compares the target against the source manifest and exits with a
  dedicated exit code on mismatch — so CI and cron jobs can't silently ignore a bad migration.

## Features

- **Resumable by default** — re-running the same command continues where it stopped
- **Exactly-once delivery** — idempotency keys per batch; verified row counts at the end
- **Atomic checkpoints** — state file is written with `write tmp → rename`, never half-written
- **Retries with exponential backoff + jitter** on 5xx/network errors; fast-fail on 4xx
- **Manifest guard** — detects a source file that changed between runs and refuses to continue
- **Verification phase** — `exit 2` when the target count doesn't match the source
- **`--dry-run`** — prints the exact plan (rows, batches, resume point) without touching anything
- **Zero-config demo** — `npm run demo` runs a full migration against an in-process mock target,
  including injected failures and retries

## Architecture

```
                 ┌────────────────────────── state.json (atomic) ─────────────────────────┐
                 │   { phase, manifest, batchesCompleted, totalBatches, startedAt, ... }   │
                 └───────────────▲───────────────────────┬────────────────────────────────┘
                                 │ save after each       │ load on start
                                 │ committed batch       ▼
┌──────────┐   load()   ┌─────────────────┐    ┌──────────────────────┐
│  CSV     │───────────▶│     Source      │    │   discover phase     │
│ source   │            │  (CsvSource)    │    │  manifest = sha256   │
└──────────┘            └─────────────────┘    │  (header + content)  │
                                               └──────────┬───────────┘
                                                          │ manifest must match
                                                          │ existing state (else abort)
                                                          ▼
┌──────────┐  POST /items  ┌─────────────────┐   ┌──────────────────────┐
│  REST    │◀─────────────│    HttpTarget    │◀──│  transfer phase      │
│  target  │  idempotency  │  retry/backoff  │   │  batches of N rows   │
└──────────┘  -key header  └─────────────────┘   │  checkpoint / batch  │
      │                                          └──────────┬───────────┘
      │ GET /items/stats                                    ▼
      └──────────────────────────────────────▶ ┌──────────────────────┐
                                               │  verify phase        │
                                               │  target == manifest? │
                                               │  ok → exit 0         │
                                               │  mismatch → exit 2   │
                                               └──────────────────────┘
```

## Quickstart

```bash
git clone https://github.com/josuejcalazans/resumable-migrator.git
cd resumable-migrator
npm install
npm test          # 22 tests — no network, no Docker required
```

Run the built-in demo (starts a mock target, migrates `examples/source.csv` with two
injected `500` errors, shows retries, verifies the result):

```bash
npm run demo
```

Real usage — two terminals:

```bash
# terminal 1 — a target API (any server exposing POST /items + GET /items/stats)
node dist/mock-target.js          # listens on :3000

# terminal 2 — migrate
npx resumable-migrator \
  --source examples/source.csv \
  --target http://127.0.0.1:3000 \
  --batch-size 500

# kill it mid-run, then run the exact same command again — it resumes
```

## CLI flags

| Flag                  | Default                | Description                                   |
| --------------------- | ---------------------- | --------------------------------------------- |
| `-s, --source <path>` | _(required)_           | Path to the source CSV file                   |
| `-t, --target <url>`  | _(required)_           | Base URL of the target REST API               |
| `--state <path>`      | `.migrator/state.json` | Checkpoint file location                      |
| `--batch-size <n>`    | `500`                  | Rows per batch and per checkpoint             |
| `--id-column <name>`  | `id`                   | CSV column used as the unique record id       |
| `--max-attempts <n>`  | `3`                    | Attempts per batch before failing             |
| `--dry-run`           | off                    | Print the plan; write nothing                 |
| `--reset`             | off                    | Discard the checkpoint and start from scratch |
| `--verbose`           | off                    | Debug logging (shows every retry)             |

**Exit codes:** `0` success · `1` error (network exhausted, 4xx, corrupt state, source
changed) · `2` verification mismatch.

## Design notes

- **Batch checkpoints, not row-level.** Row-level checkpoints turn every insert into an
  `fsync`; at 2.5M rows that dominates the runtime. Batches of 500 bound both the replay
  window and the fsync count, and the idempotency key makes the replay itself harmless.
- **Exactly-once is a property of the pair, not the client.** The client can't prevent a
  response from getting lost after the target commits — so each batch sends a deterministic
  `idempotency-key` (`manifestHash:batchIndex`) and the target is expected to dedupe on it.
  The `commitThenFail500` test proves the nasty case: commit succeeds, response is lost,
  retry replays, final count is still exact.
- **Atomic state via `write tmp → rename`.** `rename(2)` on the same filesystem is atomic in
  POSIX — readers see either the old state or the new state, never a truncated JSON.
- **Backoff with jitter** (`base · 2^n`, capped, +25% random jitter) — synchronized retries
  from parallel workers are the classic thundering-herd; jitter decorrelates them.
- **The manifest is the contract.** Content hash over header + every row means a source file
  edited between runs is detected before a single row is sent, instead of merging two
  incompatible datasets.
- **Exit-code contract.** `2` for "ran fine but data doesn't match" lets orchestration
  distinguish "retry later" from "investigate the target" without parsing logs.

## Project structure

```
src/
├── cli.ts            # commander wiring + exit codes
├── migrate.ts        # orchestrator: discover → transfer → verify
├── csv-source.ts     # CSV parsing, id validation, manifest input
├── http-target.ts    # POST batches with retry/backoff + idempotency key
├── state.ts          # FileStateStore — atomic JSON checkpoint
├── manifest.ts       # sha256 manifest + change detection
├── backoff.ts        # exponential backoff + jitter
├── mock-target.ts    # in-process target with failure injection (demo + tests)
├── errors.ts         # typed errors mapped to exit codes
└── logger.ts         # leveled stdout logging
test/
├── migrate.test.ts   # happy path, resume, idempotency, dry-run, verify
├── state.test.ts     # atomicity, corruption, version guard
├── csv-source.test.ts
└── backoff.test.ts
examples/
├── source.csv        # 2,000-row sample dataset
└── demo.cjs          # end-to-end demo with injected failures
```

## Testing

```bash
npm test          # vitest — 22 tests
npm run test:cov  # with coverage
```

The suite runs against an in-process `node:http` mock target with scripted failure modes
(`fail500`, `fail400`, socket `destroy`, `commitThenFail500`) — no Docker, no network, no
flaky sleeps (backoff is 1–2 ms in tests).

## License

[MIT](LICENSE) © 2026 Josue Jhonatas Calazans
