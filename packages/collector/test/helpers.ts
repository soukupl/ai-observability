import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { HarnessAdapter, HookInvocation } from '../src/adapters/types.js';
import { buildConfig, saveConfig, type CollectorConfig } from '../src/config.js';
import { aiObsPaths, type AiObsPaths } from '../src/paths.js';

const homes: string[] = [];

export function tmpHome(): AiObsPaths {
  const dir = mkdtempSync(join(tmpdir(), 'ai-obs-test-'));
  homes.push(dir);
  return aiObsPaths(join(dir, '.ai-obs'));
}

export function cleanupHomes(): void {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
}

export function writeTestConfig(paths: AiObsPaths, endpoint = 'http://127.0.0.1:9'): CollectorConfig {
  const config = buildConfig({ endpoint, token: 'aiobs_u_testtoken', gitEmail: 'dev@acme.com' });
  saveConfig(paths, config);
  return config;
}

export interface Received {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  json: unknown;
}

/** Local ingest server; `respond` decides each response. */
export async function startServer(
  respond: (req: Received, n: number) => { status: number; body?: unknown; headers?: Record<string, string>; delayMs?: number },
): Promise<{ url: string; received: Received[]; close: () => Promise<void>; server: Server }> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let raw = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') raw = gunzipSync(raw);
      let json: unknown = null;
      try {
        json = raw.length ? JSON.parse(raw.toString('utf8')) : null;
      } catch {
        /* not json */
      }
      const r: Received = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, json };
      received.push(r);
      const out = respond(r, received.length);
      const send = () => {
        res.writeHead(out.status, { 'content-type': 'application/json', ...out.headers });
        res.end(out.body === undefined ? '' : JSON.stringify(out.body));
      };
      if (out.delayMs) setTimeout(send, out.delayMs);
      else send();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    server,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** Accepting ingest + collector-config server. */
export function okResponder(naming: 'plain' | 'hashed' = 'plain') {
  return (req: Received) => {
    if (req.url === '/api/v1/collector-config') return { status: 200, body: { project_naming: naming, min_collector_version: '0.0.1' } };
    const events = (req.json as { events?: unknown[] } | null)?.events ?? [];
    return { status: 200, body: { accepted: events.length, duplicates: 0, rejected: [] } };
  };
}

export function fakeAdapter(overrides: Partial<HarnessAdapter> = {}): HarnessAdapter & { calls: HookInvocation[]; installs: unknown[]; uninstalls: unknown[] } {
  const calls: HookInvocation[] = [];
  const installs: unknown[] = [];
  const uninstalls: unknown[] = [];
  return {
    name: 'claude-code',
    displayName: 'Fake Claude',
    sessionStartHooks: ['SessionStart'],
    async detect() {
      return { installed: true, version: '2.1.0', versionSupported: true, hooksInstalled: { user: installs.length > 0, project: null } };
    },
    async installHooks(opts) {
      installs.push(opts);
    },
    async uninstallHooks(opts) {
      uninstalls.push(opts);
    },
    async handleHook(event) {
      calls.push(event);
    },
    async sweepCrashedSessions() {},
    async summarize() {
      return new Map();
    },
    ...overrides,
    calls,
    installs,
    uninstalls,
  };
}
