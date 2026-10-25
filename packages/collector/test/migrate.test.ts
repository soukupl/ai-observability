import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { turnSummaryEvent } from '../src/events.js';
import { writeJsonAtomic } from '../src/fsutil.js';
import { tryLock } from '../src/lock.js';
import { migrateHome, needsMigration } from '../src/migrate.js';
import type { AiObsPaths } from '../src/paths.js';
import type { IngestEvent } from '../src/protocol-types.js';
import { ulid } from '../src/ulid.js';
import { COLLECTOR_VERSION } from '../src/version.js';
import { runWorker } from '../src/worker.js';
import { bearerOf, cleanupHomes, okResponder, startServer, tmpHome } from './helpers.js';
import { queueStore } from './queue-helpers.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
  cleanupHomes();
});

function capture() {
  const lines: string[] = [];
  return { text: () => lines.join('\n'), io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) } };
}

const PK = 'github.com/acme/billing';
const events = (n: number, start = 0): IngestEvent[] =>
  Array.from({ length: n }, (_, i) => turnSummaryEvent({ harness: 'claude-code', turnId: `t${start + i}`, summary: 'x', at: 1_700_000_000_000 })!);

function legacyStream(parent: string, name: string, meta: Record<string, unknown>, evs: IngestEvent[]): void {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stream.json'), JSON.stringify(meta));
  writeFileSync(join(dir, `${ulid()}.ndjson`), evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

/** A home as collector 0.4 left it: config v2 (a user token and a company token), projects.json, o- / t- streams, caches. */
function home04(endpoint: string): AiObsPaths {
  const paths = tmpHome();
  mkdirSync(paths.root, { recursive: true });
  writeJsonAtomic(paths.config, {
    v: 2,
    endpoint,
    machine_id: 'machine-04',
    created_at: '2026-01-01T00:00:00.000Z',
    git_email: 'dev@acme.com',
    tokens: [
      { name: 'acme', company: { name: 'Acme', slug: 'acme' }, email: 'dev@acme.com', endpoint, token: 'aiobs_u_acme', added_at: '2026-02-01T00:00:00.000Z' },
      { name: 'globex', company: { name: 'Globex', slug: 'globex' }, endpoint: 'https://obs.globex.io', token: 'aiobs_c_globex1234567', added_at: '2026-03-01T00:00:00.000Z' },
    ],
    invalid_tokens: [],
    routing_epochs: [{ since: '2026-01-01T00:00:00.000Z', single: null }],
  });
  writeJsonAtomic(paths.legacyProjects, { [PK]: { token: 'acme', endpoint, company_slug: 'acme', token_fp: 'x', assigned_at: '2026-02-01T00:00:00.000Z' } });
  legacyStream(paths.queueProjects, `t-${'1'.repeat(32)}`, { pk: PK, bind: { kind: 'token', id: { endpoint, company_slug: 'acme', token_fp: 'f' }, name: 'acme' } }, events(2));
  legacyStream(paths.queueProjects, `o-${'2'.repeat(32)}`, { pk: 'github.com/acme/web', bind: { kind: 'open' } }, events(1, 10));
  mkdirSync(paths.deadPreUpgrade, { recursive: true });
  writeFileSync(join(paths.deadPreUpgrade, `${ulid()}.ndjson`), `${JSON.stringify(events(1)[0])}\n`);
  mkdirSync(paths.collectorConfigDir, { recursive: true });
  writeFileSync(join(paths.collectorConfigDir, 'acme.json'), '{}');
  return paths;
}

describe('migrating a 0.4 home', () => {
  it('config v2 → v3, projects.json → projects.json.v2, o- / t- streams → s- streams; queue/dead/pre-upgrade untouched; idempotent', () => {
    const endpoint = 'http://localhost:3000';
    const paths = home04(endpoint);
    expect(needsMigration(paths)).toBe(true);
    const notes = migrateHome(paths);
    expect(notes.join('\n')).toContain('config.json migrated to version 3: 1 server (http://localhost:3000)');
    expect(notes.join('\n')).toContain('company token globex (aiobs_c_…4567) dropped');
    expect(notes.join('\n')).toContain(`kept as ${paths.legacyProjects}.v2`);
    expect(notes.join('\n')).toContain('3 queued events in 2 streams converted');
    const raw = JSON.parse(readFileSync(paths.config, 'utf8'));
    expect(raw).toEqual({
      version: 3,
      machine_id: 'machine-04',
      created_at: '2026-01-01T00:00:00.000Z',
      servers: [{ endpoint, token: 'aiobs_u_acme', email: 'dev@acme.com', deployment: null, label: null, expires_at: null, source: null, added_at: '2026-02-01T00:00:00.000Z' }],
    });
    expect(existsSync(paths.legacyProjects)).toBe(false);
    expect(existsSync(`${paths.legacyProjects}.v2`)).toBe(true);
    expect(readdirSync(paths.queueProjects).every((d) => d.startsWith('s-'))).toBe(true);
    const streams = queueStore(paths).stats().streams.map((s) => [s.stream.pk, s.stream.endpoint, s.stream.team, s.events]);
    expect(streams).toEqual(
      expect.arrayContaining([
        [PK, endpoint, '', 2],
        ['github.com/acme/web', endpoint, '', 1], // open stream, one server left: that server
      ]),
    );
    expect(readdirSync(paths.deadPreUpgrade)).toHaveLength(1);
    expect(readdirSync(paths.collectorConfigDir)).toEqual([]);
    expect(needsMigration(paths)).toBe(false);
    expect(migrateHome(paths)).toEqual([]);
  });

  it('keeps the v2 config.json as config.json.v2 (0600), never overwriting an earlier copy', () => {
    const paths = home04('http://localhost:3000');
    const original = readFileSync(paths.config, 'utf8');
    const notes = migrateHome(paths).join('\n');
    expect(readFileSync(`${paths.config}.v2`, 'utf8')).toBe(original);
    expect(statSync(`${paths.config}.v2`).mode & 0o777).toBe(0o600);
    expect(notes).toContain(`the old config.json is kept as ${paths.config}.v2`);
    const again = home04('http://localhost:3000');
    writeFileSync(`${again.config}.v2`, 'older');
    migrateHome(again);
    expect(readFileSync(`${again.config}.v2`, 'utf8')).toBe('older');
    expect(readdirSync(again.root).filter((f) => f.startsWith('config.json.v2.'))).toHaveLength(1);
  });

  it('an older copied hook runtime is refreshed before config v3 is written; if it cannot be, nothing is migrated', async () => {
    const stale = (paths: AiObsPaths) => {
      mkdirSync(join(paths.app, 'bin'), { recursive: true });
      writeFileSync(join(paths.app, 'bin', 'ai-obs.js'), '// 0.3');
      writeFileSync(join(paths.app, 'package.json'), JSON.stringify({ version: '0.3.0' }));
    };
    // a 0.5 `status` (read-only) must not leave a v3 config next to a 0.3 runtime, which would drop every hook job
    const paths = home04('http://localhost:3000');
    stale(paths);
    const order: string[] = [];
    const refresh = (p: AiObsPaths) => {
      order.push(`runtime (config v${JSON.parse(readFileSync(p.config, 'utf8')).version ?? 2})`);
      writeFileSync(join(p.app, 'package.json'), JSON.stringify({ version: COLLECTOR_VERSION }));
      return { entry: join(p.app, 'bin', 'ai-obs.js'), node: process.execPath, copied: true };
    };
    const c = capture();
    expect(await main(['status'], c.io, { paths, env: {}, installRuntime: refresh, resolveProjectKey: async () => PK })).toBe(0);
    expect(order).toEqual(['runtime (config v2)']);
    expect(JSON.parse(readFileSync(paths.config, 'utf8')).version).toBe(3);
    expect(c.text()).toContain('ai-obs: config.json migrated to version 3');

    const stuck = home04('http://localhost:3000');
    stale(stuck);
    const s = capture();
    const noop = (p: AiObsPaths) => ({ entry: join(p.app, 'bin', 'ai-obs.js'), node: process.execPath, copied: false });
    expect(await main(['status'], s.io, { paths: stuck, env: {}, installRuntime: noop, resolveProjectKey: async () => PK })).toBe(0);
    expect(s.text()).toContain(`not migrated yet: the hook runtime in ${stuck.app} is 0.3.0 and could not be updated`);
    expect(JSON.parse(readFileSync(stuck.config, 'utf8')).v).toBe(2);
    expect(existsSync(stuck.legacyProjects)).toBe(true);
    expect(readdirSync(stuck.queueProjects).some((d) => d.startsWith('t-'))).toBe(true);
  });

  it('an existing projects.json.v2 is not overwritten', () => {
    const paths = home04('http://localhost:3000');
    writeFileSync(`${paths.legacyProjects}.v2`, 'older');
    migrateHome(paths);
    expect(readFileSync(`${paths.legacyProjects}.v2`, 'utf8')).toBe('older');
    expect(readdirSync(paths.root).filter((f) => f.startsWith('projects.json.v2.'))).toHaveLength(1);
  });

  it('the worker migrates before it works, then sends the converted streams with the user token', async () => {
    const srv = await startServer(okResponder());
    closers.push(srv.close);
    const paths = home04(srv.url);
    const r = await runWorker({ paths, adapters: [], summaries: false });
    expect(r.ran).toBe(true);
    const ingests = srv.received.filter((x) => x.url === '/api/v1/ingest');
    expect(ingests.flatMap((x) => (x.json as { events: unknown[] }).events)).toHaveLength(3);
    expect(ingests.every((x) => bearerOf(x) === 'aiobs_u_acme')).toBe(true);
    expect(queueStore(paths).stats().events).toBe(0);
    // the first fetch taught the config the token's expiry source and deployment
    expect(loadConfig(paths)!.servers[0]).toMatchObject({ deployment: { slug: 'spectado' }, source: 'device' });
    expect(readFileSync(paths.logFile, 'utf8')).toContain('migrate: company token globex');
  });

  it('a CLI command migrates when the worker lock is free and says what changed; with the lock taken it leaves it to the worker', async () => {
    const busy = home04('http://localhost:3000');
    const release = tryLock(busy.workerLock)!;
    const b = capture();
    expect(await main(['status'], b.io, { paths: busy, env: {}, resolveProjectKey: async () => PK })).toBe(0);
    expect(b.text()).not.toContain('migrated');
    expect(b.text()).toContain('recorded by ai-obs 0.4 or older; converted on the next worker run');
    expect(JSON.parse(readFileSync(busy.config, 'utf8')).v).toBe(2);
    release();
    const c = capture();
    expect(await main(['status'], c.io, { paths: busy, env: {}, resolveProjectKey: async () => PK })).toBe(0);
    expect(c.text()).toContain('ai-obs: config.json migrated to version 3');
    expect(c.text()).toContain('ai-obs: company token globex');
    expect(JSON.parse(readFileSync(busy.config, 'utf8')).version).toBe(3);
  });

  it('several servers: an open 0.4 stream waits for `ai-obs link` (shown by status)', async () => {
    const paths = tmpHome();
    mkdirSync(paths.root, { recursive: true });
    writeJsonAtomic(paths.config, {
      v: 2,
      machine_id: 'm',
      tokens: [
        { name: 'a', endpoint: 'https://obs.a.io', token: 'aiobs_u_a', added_at: '2026-02-01T00:00:00.000Z' },
        { name: 'b', endpoint: 'https://obs.b.io', token: 'aiobs_u_b', added_at: '2026-02-01T00:00:00.000Z' },
      ],
    });
    legacyStream(paths.queueProjects, `o-${'2'.repeat(32)}`, { pk: PK, bind: { kind: 'open' } }, events(4));
    expect(migrateHome(paths).join('\n')).toContain('4 of them wait for a server (several are registered): run `ai-obs link` in their repository');
    const c = capture();
    await main(['status'], c.io, { paths, env: {}, resolveProjectKey: async () => PK });
    expect(c.text()).toContain('4 events of repositories without a server (several are registered): run `ai-obs link --server <url>` in each');
  });
});
