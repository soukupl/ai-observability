/**
 * Definition of done of the per-user-token collector (brief "Collector", appendix B, C, E): real local
 * servers, the real CLI (login with the device flow, link), hook and worker over a temp AI_OBS_HOME and real
 * git repositories with dot files. Only the harness is faked (one session_start per SessionStart, one
 * session_end per Stop).
 */
import { createHmac } from 'node:crypto';
import { rmSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessAdapter, StreamHolder } from '../src/adapters/types.js';
import { main } from '../src/cli.js';
import { openStore } from '../src/commands/common.js';
import { loadConfig } from '../src/config.js';
import { sessionEndEvent, sessionStartEvent } from '../src/events.js';
import { runHook } from '../src/hook.js';
import { listJobs } from '../src/jobs.js';
import type { AiObsPaths } from '../src/paths.js';
import { resolveProjectKey } from '../src/project-key.js';
import type { IngestEvent } from '../src/protocol-types.js';
import { runWorker } from '../src/worker.js';
import { bearerOf, cleanupHomes, fakeAdapter, gitRepo, startServer, tmpHome, tokenResponder, writeDotFile, type Received, type ServerReply, type TokenResponse } from './helpers.js';

const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  cleanupHomes();
});

const SB = 'deployment-b-salt-0123456789';
const BILLING = 'github.com/acme/billing';
const SHOP = 'github.com/acme/shop';
const sidOf = (e: IngestEvent) => (e as { session_id?: string }).session_id;
const hashed = (salt: string, pk: string) => `sha256:${createHmac('sha256', salt).update(pk).digest('hex')}`;

/**
 * A local ai-obs server: device login minting `mint`, collector-config / ingest per bearer token (the map is
 * read on every request, so a test can turn a token into a 401).
 */
async function server(map: Record<string, TokenResponse>, mint?: string) {
  const respond = tokenResponder(map);
  const s = await startServer((req: Received): ServerReply => {
    if (req.url === '/api/v1/device/code') return { status: 200, body: { device_code: 'x'.repeat(43), user_code: 'WXYZ-ABCD', verification_uri: 'ignored', expires_in: 600, interval: 1 } };
    if (req.url === '/api/v1/device/token') return mint ? { status: 200, body: { token: mint, expires_at: '2027-01-22T10:00:00Z', label: 'mac-dev' } } : { status: 400, body: { error: 'access_denied' } };
    return respond(req);
  });
  servers.push(s);
  const ingests = () => s.received.filter((r) => r.url === '/api/v1/ingest');
  const events = () => ingests().flatMap((r) => (r.json as { events: IngestEvent[] }).events);
  const projects = () => events().flatMap((e) => (e.type === 'session_start' && e.project ? [e.project] : []));
  return { ...s, ingests, events, projects };
}

function sessionAdapter(): HarnessAdapter {
  const holders = new Map<string, StreamHolder>();
  return fakeAdapter({
    async handleHook(event, ctx) {
      const sid = (event.payload as { session_id: string }).session_id;
      const holder = holders.get(sid) ?? { pkCwd: event.cwd };
      holders.set(sid, holder);
      const at = Date.parse(event.receivedAt);
      const key = await ctx.streamFor(holder, at);
      const e =
        event.hook === 'SessionStart'
          ? sessionStartEvent({ harness: 'claude-code', sessionId: sid, at, project: await ctx.projectKey(event.cwd) })
          : sessionEndEvent({ harness: 'claude-code', sessionId: sid, reason: 'exit', at });
      ctx.queue.enqueue([e], key);
    },
  });
}

function machine() {
  const paths: AiObsPaths = tmpHome();
  const adapter = sessionAdapter();
  const cli = async (argv: string[], cwd = paths.root) => {
    const lines: string[] = [];
    const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) };
    const code = await main(argv, io, {
      paths,
      cwd,
      env: {},
      adapters: [adapter],
      installRuntime: (p) => ({ entry: `${p.app}/bin/ai-obs.js`, node: process.execPath, copied: false }),
      spawnWorker: () => {},
      sleep: async () => {},
      openBrowser: () => {},
      hostname: () => 'mac-dev',
    });
    return { code, text: lines.join('\n') };
  };
  const hook = async (name: 'SessionStart' | 'Stop', cwd: string, sid: string) => {
    let out = '';
    const stdin = new PassThrough();
    stdin.end(JSON.stringify({ session_id: sid, cwd, hook_event_name: name }));
    const code = await runHook(['claude-code', name], {
      paths,
      env: {},
      stdin,
      stdout: { write: (s: string) => (out += s) },
      spawnWorker: () => {},
      selfCommand: ['ai-obs'],
      resolveProjectKey: (dir) => resolveProjectKey(dir, { timeoutMs: 5000 }),
    });
    expect(code).toBe(0);
    return out;
  };
  const session = async (cwd: string, sid: string) => {
    const nudge = await hook('SessionStart', cwd, sid);
    await hook('Stop', cwd, sid);
    const r = await runWorker({ paths, adapters: [adapter] });
    expect(r.failed).toBe(0);
    return { nudge, flush: r.flush };
  };
  /** Queued events per stream: `<pk> <endpoint|-> <team|->` → events. */
  const queued = () => {
    const out: Record<string, number> = {};
    for (const s of openStore(paths).stats().streams) out[`${s.stream.pk ?? s.stream.dir} ${s.stream.endpoint || '-'} ${s.stream.team || '-'}`] = s.events;
    return out;
  };
  const dropJobs = () => {
    for (const j of listJobs(paths.jobs)) rmSync(j);
  };
  return { paths, adapter, cli, hook, session, queued, dropJobs };
}

const additionalContext = (stdout: string): string => {
  const lines = stdout.split('\n').filter(Boolean);
  expect(lines).toHaveLength(1);
  return (JSON.parse(lines[0]!) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
};

describe('DoD: one machine, several servers, per-user tokens and dot files', () => {
  it('logs in to two servers, holds a repository without a dot file until `link`, routes by dot file, a 401 stops one server only', async () => {
    const aMap: Record<string, TokenResponse> = { aiobs_u_a: {} };
    const A = await server(aMap, 'aiobs_u_a');
    const B = await server({ aiobs_u_b: { naming: 'hashed', salt: SB } });
    const C = await server({}); // a server this machine never logs in to
    const m = machine();

    const la = await m.cli(['login', '--server', A.url]);
    expect(la.code, la.text).toBe(0);
    expect(la.text).toContain(`Open ${A.url}/device and enter the code WXYZ-ABCD`);
    const lb = await m.cli(['login', '--server', B.url, '--token', 'aiobs_u_b']);
    expect(lb.code, lb.text).toBe(0);
    expect(loadConfig(m.paths)!.servers.map((s) => [s.endpoint, s.source])).toEqual([
      [A.url, 'device'],
      [B.url, 'device'],
    ]);
    expect((await m.cli(['init'])).code).toBe(0);

    // No dot file, two servers: the session start asks for `link`, events are kept, nothing reaches any server.
    const billing = gitRepo({ remote: 'git@github.com:acme/billing.git' });
    const s1 = await m.session(billing, 's1');
    const text = additionalContext(s1.nudge);
    expect(text).toContain(`ai-obs link --server <url> --team <team> --project-dir ${billing}`);
    expect(text).not.toContain('aiobs_');
    expect(A.ingests()).toHaveLength(0);
    expect(B.ingests()).toHaveLength(0);
    expect(s1.flush?.held).toMatchObject({ events: 2, byReason: { 'no-server': 2 } });
    expect(m.queued()).toEqual({ [`${BILLING} - -`]: 2 });
    expect(await m.hook('SessionStart', billing, 's1')).toBe(''); // same text, same session: not repeated
    m.dropJobs();

    // `ai-obs link` → B, team platform: the waiting events follow, hashed with B's salt, with the team.
    const link = await m.cli(['link', '--server', B.url, '--team', 'platform'], billing);
    expect(link.code, link.text).toBe(0);
    expect(link.text).toContain(`2 queued events of this repository recorded without a server now go to ${B.url}`);
    const f1 = await m.cli(['flush']);
    expect(f1.code, f1.text).toBe(0);
    expect(A.ingests()).toHaveLength(0);
    expect(B.ingests().every((r) => bearerOf(r) === 'aiobs_u_b')).toBe(true);
    expect(B.events().map(sidOf)).toEqual(['s1', 's1']);
    expect(B.projects()).toEqual([{ key: hashed(SB, BILLING), team: 'platform' }]);
    expect(JSON.stringify(B.received)).not.toContain(BILLING);
    expect(m.queued()).toEqual({});
    // linked now: the next session start says nothing and goes straight to B
    const s2 = await m.session(billing, 's2');
    expect(s2.nudge).toBe('');
    expect(B.events().filter((e) => sidOf(e) === 's2')).toHaveLength(2);

    // A committed dot file naming A routes another repository to A (plain naming, its team); A starts answering 401.
    const shop = gitRepo({ remote: 'git@github.com:acme/shop.git' });
    writeDotFile(shop, { server: A.url, team: 'spectado' });
    const s3 = await m.session(shop, 's3');
    expect(s3.nudge).toBe('');
    expect(A.projects()).toEqual([{ key: SHOP, name: 'shop', team: 'spectado' }]);
    aMap.aiobs_u_a!.status = 401;
    await m.hook('SessionStart', shop, 's4');
    await m.hook('Stop', shop, 's4');
    await m.hook('SessionStart', billing, 's5');
    await m.hook('Stop', billing, 's5');
    const w = await runWorker({ paths: m.paths, adapters: [m.adapter] });
    expect(w.flush?.servers[A.url]?.status).toBe('auth_error');
    expect(w.flush?.servers[B.url]?.status).toBe('ok'); // B keeps delivering in the same flush
    expect(m.queued()).toEqual({ [`${SHOP} ${A.url} spectado`]: 2 });
    const status = await m.cli(['status'], shop);
    expect(status.text).toContain(`REJECTED (401, expired or revoked): run \`ai-obs login --server ${A.url}\``);
    expect(additionalContext(await m.hook('SessionStart', shop, 's6'))).toContain(`login --server ${A.url}`);
    m.dropJobs();
    const aRequests = A.received.length;
    expect((await runWorker({ paths: m.paths, adapters: [m.adapter] })).flush?.servers[A.url]?.status).toBe('blocked');
    expect(A.received.length).toBe(aRequests); // an automatic flush skips the refused server without a request

    // A new login for A sends what waited, with the new token.
    aMap.aiobs_u_a2 = {};
    const relogin = await m.cli(['login', '--server', A.url, '--token', 'aiobs_u_a2']);
    expect(relogin.code, relogin.text).toBe(0);
    expect((await m.cli(['flush'])).code).toBe(0);
    const accepted = A.ingests().filter((r) => bearerOf(r) === 'aiobs_u_a2').flatMap((r) => (r.json as { events: IngestEvent[] }).events);
    expect(accepted.map(sidOf)).toEqual(['s4', 's4']);
    expect(m.queued()).toEqual({});

    // A dot file naming a server this machine is not logged in to: events wait, no token ever goes there.
    const other = gitRepo({ remote: 'git@github.com:acme/other.git' });
    writeDotFile(other, { server: C.url, team: 'platform' });
    const s7 = await m.session(other, 's7');
    expect(additionalContext(s7.nudge)).toContain(`login --server ${C.url}`);
    expect(m.queued()).toEqual({ [`github.com/acme/other ${C.url} platform`]: 2 });
    expect(C.received).toHaveLength(0);
    expect(A.events().map(sidOf)).not.toContain('s7');
    expect(B.events().map(sidOf)).not.toContain('s7');
  });

  it('single server: no question, events go to it without a dot file and without a team', async () => {
    const A = await server({ aiobs_u_a: {} });
    const m = machine();
    expect((await m.cli(['init', '--token', 'aiobs_u_a', '--endpoint', A.url])).code).toBe(0);
    const billing = gitRepo({ remote: 'git@github.com:acme/billing.git' });
    const s = await m.session(billing, 's1');
    expect(s.nudge).toBe('');
    expect(s.flush).toMatchObject({ status: 'ok', held: { events: 0 } });
    expect(A.ingests().every((r) => r.headers.authorization === 'Bearer aiobs_u_a')).toBe(true);
    expect(A.events().map((e) => e.type)).toEqual(['session_start', 'session_end']);
    expect(A.projects()).toEqual([{ key: BILLING, name: 'billing' }]);
    expect(m.queued()).toEqual({});
  });
});
