import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { TargetStats } from './types';

export type FailureMode = 'fail500' | 'fail400' | 'destroy' | 'commitThenFail500';

export interface MockTargetOptions {
  port?: number;
}

export interface MockTargetServer {
  listen(): Promise<number>;
  close(): Promise<void>;
  baseUrl(): string;
  stats(): TargetStats;
  requestCount(): number;
  queueFailures(...modes: FailureMode[]): void;
  failAfterCommits(afterCommits: number, mode: FailureMode): void;
  clearFailures(): void;
}

interface IncomingBatch {
  idempotencyKey: string;
  rows: Array<{ id: string; values: Record<string, string> }>;
}

export function createMockTargetServer(options: MockTargetOptions = {}): MockTargetServer {
  const rows = new Map<string, Record<string, string>>();
  const committedKeys = new Set<string>();
  let queue: FailureMode[] = [];
  let persistent: { afterCommits: number; mode: FailureMode } | null = null;
  let requests = 0;
  let port = options.port ?? 0;

  const decideMode = (): FailureMode | null => {
    if (queue.length > 0) return queue.shift() ?? null;
    if (persistent && committedKeys.size >= persistent.afterCommits) return persistent.mode;
    return null;
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '';

    if (req.method === 'GET' && url === '/items/stats') {
      const payload: TargetStats = {
        count: rows.size,
        distinctIds: rows.size,
        committedBatches: committedKeys.size,
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }

    if (req.method === 'POST' && url === '/items') {
      requests += 1;
      let raw = '';
      for await (const chunk of req) raw += chunk;

      const mode = decideMode();
      if (mode === 'destroy') {
        req.socket.destroy();
        return;
      }
      if (mode === 'fail500') {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('internal error');
        return;
      }
      if (mode === 'fail400') {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('bad batch');
        return;
      }

      let payload: IncomingBatch;
      try {
        payload = JSON.parse(raw) as IncomingBatch;
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('invalid json');
        return;
      }

      const replay = committedKeys.has(payload.idempotencyKey);
      if (!replay) {
        for (const row of payload.rows) rows.set(row.id, row.values);
        committedKeys.add(payload.idempotencyKey);
      }

      if (mode === 'commitThenFail500') {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('response lost after commit');
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, replay }));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });

  return {
    listen: () =>
      new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => {
          const address = server.address();
          if (address && typeof address === 'object') port = address.port;
          resolve(port);
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    baseUrl: () => `http://127.0.0.1:${port}`,
    stats: () => ({
      count: rows.size,
      distinctIds: rows.size,
      committedBatches: committedKeys.size,
    }),
    requestCount: () => requests,
    queueFailures: (...modes) => {
      queue.push(...modes);
    },
    failAfterCommits: (afterCommits, mode) => {
      persistent = { afterCommits, mode };
    },
    clearFailures: () => {
      queue = [];
      persistent = null;
    },
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 3000);
  const mock = createMockTargetServer({ port });
  void mock.listen().then((bound) => {
    console.log(`mock target listening on http://127.0.0.1:${bound}`);
    console.log('POST /items  ·  GET /items/stats');
  });
}
