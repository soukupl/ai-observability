/**
 * Definition of done of the multi-company collector (brief "In scope → Collector", design §6.2): two real
 * local servers, the real CLI, hook and worker over a temp AI_OBS_HOME and real git repositories. Only
 * the harness is faked (an adapter that enqueues one session per SessionStart / Stop).
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
import { cleanupHomes, fakeAdapter, gitRepo, startServer, tmpHome, tokenResponder, type TokenResponse } from './helpers.js';

const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  cleanupHomes();
});

const ACME = { name: 'Acme', slug: 'acme' };
const GLOBEX = { name: 'Globex', slug: 'globex' };
const SB = 'globex-salt-0123456789abcdef';
const BILLING = 'github.com/acme/billing';
const SHOP = 'github.com/acme/shop';
const WEB = 'github.com/acme/web';
const sidOf = (e: IngestEvent) => (e as { session_id?: string }).session_id;
const hashed = (salt: string, pk: string) => `sha256:${createHmac('sha256', salt).update(pk).digest('hex')}`;

/** A local server answering per bearer token; the map is read on every request, so a test can turn a token into a 401. */
async function server(map: Record<string, TokenResponse>) {
  const respond = tokenResponder(map);
  const s = await startServer((req) => respond(req));
  servers.push(s);
  const ingests = () => s.received.filter((r) => r.url === '/api/v1/ingest');
  const events = () => ingests().flatMap((r) => (r.json as { events: IngestEvent[] }).events);
  const keys = () => events().flatMap((e) => (e.type === 'session_start' && e.project ? [e.project.key] : []));
  return { ...s, ingests, events, keys };
}

/** The harness: one session_start on SessionStart, one session_end on Stop, each into the session's pinned stream. */
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
  const cli = async (argv: string[]) => {
    const lines: string[] = [];
    const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) };
    const code = await main(argv, io, {
      paths,
      env: {},
      adapters: [adapter],
      installRuntime: (p) => ({ entry: `${p.app}/bin/ai-obs.js`, node: process.execPath, copied: false }),
      spawnWorker: () => {},
    });
    return { code, text: lines.join('\n') };
  };
  /** The real hook fast path for one hook of a session; returns what it printed on stdout. */
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
      // real git, without the 40 ms hook bound (a loaded test machine must not make the question flaky)
      resolveProjectKey: (dir) => resolveProjectKey(dir, { timeoutMs: 5000 }),
    });
    expect(code).toBe(0);
    return out;
  };
  /** A whole session in `cwd` (SessionStart + Stop), then the worker processes and flushes it. */
  const session = async (cwd: string, sid: string) => {
    const nudge = await hook('SessionStart', cwd, sid);
    await hook('Stop', cwd, sid);
    const r = await runWorker({ paths, adapters: [adapter] });
    expect(r.failed).toBe(0);
    return { nudge, flush: r.flush };
  };
  /** Queued events per stream: `<pk> <open|token name>` → events. */
  const queued = () => {
    const out: Record<string, number> = {};
    for (const s of openStore(paths).stats().streams) {
      const bind = s.stream.bind;
      const tag = !bind ? s.stream.kind : bind.kind === 'open' ? 'open' : (bind.id.company_slug ?? bind.id.token_fp);
      out[`${s.stream.pk ?? s.stream.dir} ${tag}`] = s.events;
    }
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
  const out = JSON.parse(lines[0]!) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
  return out.hookSpecificOutput.additionalContext;
};

describe('DoD: several companies on one machine', () => {
  it('holds an unassigned repository, sends it only to the chosen token, and a 401 stops one token only', async () => {
    const aMap: Record<string, TokenResponse> = { aiobs_u_a: { company: ACME, user: { email: 'dev@acme.com' } } };
    const A = await server(aMap);
    const B = await server({ aiobs_c_b: { company: GLOBEX, naming: 'hashed', salt: SB, user: null } });
    const m = machine();

    expect((await m.cli(['init', '--token', 'aiobs_u_a', '--endpoint', A.url, '--git-email', 'dev@acme.com'])).code).toBe(0);
    const added = await m.cli(['token', 'add', '--token', 'aiobs_c_b', '--endpoint', B.url]);
    expect(added.code, added.text).toBe(0);
    expect(loadConfig(m.paths)!.tokens.map((t) => [t.name, t.endpoint])).toEqual([
      ['acme', A.url],
      ['globex', B.url],
    ]);

    // An unassigned repository: the session start asks, its events are kept and nothing reaches either server.
    const billing = gitRepo({ remote: 'git@github.com:acme/billing.git' });
    const s1 = await m.session(billing, 's1');
    const text = additionalContext(s1.nudge);
    expect(text).toContain(`"${BILLING}"`);
    expect(text).toContain('"acme"');
    expect(text).toContain('"globex"');
    expect(text).toContain(`ai-obs use <name> --project-dir ${billing}`);
    expect(text).not.toContain('aiobs_');
    expect(A.ingests()).toHaveLength(0);
    expect(B.ingests()).toHaveLength(0);
    expect(s1.flush?.held.events).toBe(2);
    expect(s1.flush?.held.byReason).toEqual({ unassigned: 2 });
    expect(m.queued()).toEqual({ [`${BILLING} open`]: 2 });
    // Same text again in the same session → not repeated.
    expect(await m.hook('SessionStart', billing, 's1')).toBe('');
    m.dropJobs(); // that repeated SessionStart is not part of the scenario

    // `use globex` → sent only to B, with B's token and B's naming (hashed with B's salt, no plain name).
    const use = await m.cli(['use', 'globex', '--project-dir', billing]);
    expect(use.code, use.text).toBe(0);
    const f1 = await m.cli(['flush']);
    expect(f1.code, f1.text).toBe(0);
    expect(A.ingests()).toHaveLength(0);
    expect(B.ingests().length).toBeGreaterThan(0);
    expect(B.ingests().every((r) => r.headers.authorization === 'Bearer aiobs_c_b')).toBe(true);
    expect(B.events().map((e) => sidOf(e))).toEqual(['s1', 's1']);
    const start = B.events().find((e) => e.type === 'session_start') as Extract<IngestEvent, { type: 'session_start' }>;
    expect(start.project).toEqual({ key: hashed(SB, BILLING) });
    expect(JSON.stringify(B.received)).not.toContain(BILLING);
    expect(m.queued()).toEqual({});
    // Assigned now: the next session start says nothing.
    expect(await m.hook('SessionStart', billing, 's1b')).toBe('');
    m.dropJobs();

    // A second repository assigned to acme; A starts answering 401.
    const shop = gitRepo({ remote: 'git@github.com:acme/shop.git' });
    expect((await m.cli(['use', 'acme', '--project-dir', shop])).code).toBe(0);
    aMap.aiobs_u_a!.status = 401;
    await m.hook('SessionStart', shop, 's2');
    await m.hook('Stop', shop, 's2');
    await m.hook('SessionStart', billing, 's3');
    await m.hook('Stop', billing, 's3');
    const w = await runWorker({ paths: m.paths, adapters: [m.adapter] });
    expect(w.flush?.tokens.acme?.status).toBe('auth_error');
    expect(w.flush?.tokens.globex?.status).toBe('ok'); // B keeps delivering in the same flush
    expect(B.events().filter((e) => sidOf(e) === 's3')).toHaveLength(2);
    expect(m.queued()).toEqual({ [`${SHOP} acme`]: 2 }); // A's stream is kept
    const status = await m.cli(['status']);
    expect(status.text).toMatch(/acme[^\n]*REJECTED \(HTTP 401\)/);
    expect(status.text).not.toMatch(/globex[^\n]*REJECTED/);
    const aRequests = A.received.length;
    expect((await runWorker({ paths: m.paths, adapters: [m.adapter] })).flush?.tokens.acme?.status).toBe('blocked');
    expect(A.received.length).toBe(aRequests); // an automatic flush skips the blocked token without a request

    // Choosing globex for that repository does not move what was captured for acme to B.
    expect((await m.cli(['use', 'globex', '--project-dir', shop])).code).toBe(0);
    const f2 = await m.cli(['flush']);
    expect(f2.text).toContain('acme: token rejected (HTTP 401)');
    expect(B.keys()).not.toContain(hashed(SB, SHOP));
    expect(JSON.stringify(B.received)).not.toContain(SHOP);
    expect(m.queued()).toEqual({ [`${SHOP} acme`]: 2 });

    // A third repository recorded while both tokens were registered stays kept after `token remove globex`.
    const web = gitRepo({ remote: 'git@github.com:acme/web.git' });
    const s4 = await m.session(web, 's4');
    expect(additionalContext(s4.nudge)).toContain(`"${WEB}"`);
    expect(m.queued()).toEqual({ [`${SHOP} acme`]: 2, [`${WEB} open`]: 2 });
    const removed = await m.cli(['token', 'remove', 'globex']);
    expect(removed.code, removed.text).toBe(0);
    delete aMap.aiobs_u_a!.status; // A accepts again
    const f3 = await m.cli(['flush']);
    expect(f3.code, f3.text).toBe(0);
    expect(A.keys()).toContain(SHOP); // acme's own captures, once A accepts again
    expect(A.keys()).not.toContain(WEB);
    expect(JSON.stringify(A.received)).not.toContain(WEB);
    expect(A.events().map((e) => sidOf(e))).not.toContain('s4');
    expect(m.queued()).toEqual({ [`${WEB} open`]: 2 });
  });

  it('single token: no question, events go to that token without `use`', async () => {
    const A = await server({ aiobs_u_a: { company: ACME, user: { email: 'dev@acme.com' } } });
    const m = machine();
    expect((await m.cli(['init', '--token', 'aiobs_u_a', '--endpoint', A.url, '--git-email', 'dev@acme.com'])).code).toBe(0);
    const billing = gitRepo({ remote: 'git@github.com:acme/billing.git' });
    const s = await m.session(billing, 's1');
    expect(s.nudge).toBe('');
    expect(s.flush?.status).toBe('ok');
    expect(s.flush?.held.events).toBe(0);
    expect(A.ingests().every((r) => r.headers.authorization === 'Bearer aiobs_u_a')).toBe(true);
    expect(A.events().map((e) => e.type)).toEqual(['session_start', 'session_end']);
    expect(A.events()[0]).toMatchObject({ project: { key: BILLING, name: 'billing' } });
    expect(m.queued()).toEqual({});
  });
});
