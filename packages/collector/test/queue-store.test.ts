import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readDropped, writeServerDelivery } from '../src/delivery.js';
import type { IngestEvent } from '../src/protocol-types.js';
import { EventQueue, identityOfRef } from '../src/queue.js';
import { loadRouting, resolveStream, streamDirName, unresolvedDirName } from '../src/routing.js';
import { ulid, ulidFrom } from '../src/ulid.js';
import { cleanupHomes, tmpHome, writeTestConfig, writeTestServers } from './helpers.js';
import { enqueueFor, queueStore } from './queue-helpers.js';

afterEach(cleanupHomes);

const PK = 'github.com/acme/billing';
const DAY = 24 * 3600_000;
const EP = 'http://127.0.0.1:9';
const EP2 = 'http://127.0.0.1:10';

const ev = (i: number, pad = 0): IngestEvent => ({
  event_id: ulid(),
  type: 'turn_summary',
  harness: 'claude-code',
  turn_id: `t${i}`,
  summary: `s${i}${'x'.repeat(pad)}`.slice(0, 140),
});
const evs = (n: number, start = 0) => Array.from({ length: n }, (_, i) => ev(start + i));

/** Renames the segments of a stream dir as if they had been written at `at` (ULIDs are monotonic per process). */
function age(dir: string, at: number): void {
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ndjson'))) renameSync(join(dir, f), join(dir, `${ulidFrom(f, at)}.ndjson`));
}

/** stream.json as if the stream had been seen sendable since `since` (and was last seen at `seen`). */
function sendableSince(dir: string, since: number, seen = Date.now()): void {
  const file = join(dir, 'stream.json');
  const meta = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...meta, sendable_since: new Date(since).toISOString(), seen_at: new Date(seen).toISOString() }));
}

/** A 0.4 stream directory (`o-` / `t-`, stream.json {pk, bind}). */
function legacyStream(parent: string, name: string, meta: Record<string, unknown>, events: IngestEvent[]): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stream.json'), JSON.stringify(meta));
  writeFileSync(join(dir, `${ulid()}.ndjson`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return dir;
}

function setup() {
  const paths = tmpHome();
  const config = writeTestConfig(paths);
  return { paths, config, store: queueStore(paths) };
}

describe('QueueStore streams', () => {
  it('keeps one s- stream per (project key, server, team), each with its stream.json {key, endpoint, team}', () => {
    const { paths, store } = setup();
    enqueueFor(store, PK, EP, evs(2));
    enqueueFor(store, PK, EP, evs(1), 'platform');
    enqueueFor(store, PK, '', evs(1));
    enqueueFor(store, 'github.com/acme/web', EP, evs(1));
    const dirs = readdirSync(paths.queueProjects).sort();
    expect(dirs).toEqual([streamDirName(PK, EP, ''), streamDirName(PK, EP, 'platform'), streamDirName(PK, '', ''), streamDirName('github.com/acme/web', EP, '')].sort());
    expect(dirs.every((d) => /^s-[0-9a-f]{32}$/.test(d))).toBe(true);
    const meta = JSON.parse(readFileSync(join(paths.queueProjects, streamDirName(PK, EP, 'platform'), 'stream.json'), 'utf8'));
    expect(meta).toMatchObject({ key: PK, endpoint: EP, team: 'platform' });
    expect(typeof meta.created_at).toBe('string');
    expect(store.stats().events).toBe(5);
    expect(identityOfRef(store.stats().streams[0]!.stream)).toMatchObject({ kind: 'project', pk: PK });
  });

  it('no API writes the root (the frozen pre-upgrade stream); a null key drops', () => {
    const { paths, store } = setup();
    enqueueFor(store, PK, EP, evs(1));
    store.enqueue(evs(1), { kind: 'unresolved', cwd: '/work/x', endpoint: EP, team: '' });
    store.enqueue(evs(1), null);
    expect(readdirSync(paths.queue).filter((f) => f.endsWith('.ndjson'))).toEqual([]);
    expect(readdirSync(paths.queueUnresolved)).toEqual([unresolvedDirName('/work/x', EP, '')]);
    expect(store.stats().events).toBe(2);
  });

  it('lists root segments as the pre-upgrade stream (held, never sent)', () => {
    const { paths, store } = setup();
    new EventQueue(paths.queue).enqueue(evs(2));
    expect(store.streams()).toEqual([{ kind: 'pre-upgrade', dir: paths.queue }]);
    expect(resolveStream(loadRouting(paths)!, identityOfRef(store.streams()[0]!))).toEqual({ kind: 'held', reason: 'pre-upgrade' });
  });

  it('a key stored by 0.4 (`bind`) is converted on enqueue: token → its endpoint, open → the only server', () => {
    const { paths, store } = setup();
    store.enqueue(evs(1), { kind: 'project', pk: PK, bind: { kind: 'token', id: { endpoint: 'http://127.0.0.1:9/', token_fp: 'x' }, name: 'acme' } } as never);
    store.enqueue(evs(1), { kind: 'project', pk: PK, bind: { kind: 'open' } } as never);
    expect(readdirSync(paths.queueProjects)).toEqual([streamDirName(PK, EP, '')]);
    expect(store.stats().events).toBe(2);
  });

  it('crash window: a .tmp dir is ignored; a stream dir without stream.json, or whose stream.json does not hash to its name, is unknown', () => {
    const { paths, store } = setup();
    mkdirSync(join(paths.queueProjects, '.tmp-abc'), { recursive: true });
    writeFileSync(join(paths.queueProjects, '.tmp-abc', `${ulid()}.ndjson`), `${JSON.stringify(ev(0))}\n`);
    const bare = join(paths.queueProjects, `s-${'0'.repeat(32)}`);
    mkdirSync(bare);
    writeFileSync(join(bare, `${ulid()}.ndjson`), `${JSON.stringify(ev(1))}\n`);
    enqueueFor(store, PK, EP, evs(1, 5));
    const forged = join(paths.queueProjects, streamDirName(PK, EP, ''));
    writeFileSync(join(forged, 'stream.json'), JSON.stringify({ key: 'github.com/other/repo', endpoint: EP, team: '' }));
    expect(store.streams().map((s) => s.kind)).toEqual(['unknown', 'unknown']);
    expect(store.streams().map(identityOfRef)).toEqual([{ kind: 'unknown' }, { kind: 'unknown' }]);
  });

  it('never appends into a directory of the right name that is not this stream', () => {
    const { paths, store } = setup();
    const dir = join(paths.queueProjects, streamDirName(PK, EP, ''));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'stream.json'), '{garbage');
    enqueueFor(store, PK, EP, evs(1));
    expect(readdirSync(dir)).toEqual(['stream.json']);
  });

  it('adopt: an unresolved stream moves into its project stream with the same server and team', () => {
    const { paths, store } = setup();
    store.enqueue(evs(2), { kind: 'unresolved', cwd: '/work/billing', endpoint: EP, team: 'platform' });
    store.adopt(store.streams()[0]!, PK);
    expect(existsSync(join(paths.queueUnresolved, unresolvedDirName('/work/billing', EP, 'platform')))).toBe(false);
    expect(store.stats().streams).toEqual([expect.objectContaining({ events: 2, stream: expect.objectContaining({ kind: 'project', pk: PK, endpoint: EP, team: 'platform' }) })]);
  });

  it('retarget (link): only the key’s streams without a server move, keeping time order', () => {
    const { store } = setup();
    enqueueFor(store, PK, '', evs(2, 0));
    enqueueFor(store, PK, EP2, evs(1, 10)); // bound to a server at capture: stays
    enqueueFor(store, PK, EP, evs(1, 20), 'platform');
    enqueueFor(store, 'github.com/acme/web', '', evs(1, 30));
    expect(store.retarget(PK, { endpoint: EP, team: 'platform' })).toBe(2);
    const rows = store.stats().streams.map((s) => [s.stream.pk, s.stream.endpoint, s.stream.team, s.events]);
    expect(rows).toEqual(
      expect.arrayContaining([
        [PK, EP, 'platform', 3],
        [PK, EP2, '', 1],
        ['github.com/acme/web', '', '', 1],
      ]),
    );
    const target = store.streams().find((s) => s.pk === PK && s.endpoint === EP)!;
    const b = store.stream(target).readBatch()!;
    expect(b.events.map((e) => (e as { turn_id: string }).turn_id)).toEqual(['t0', 't1', 't20']);
    expect(store.retarget(PK, { endpoint: '', team: '' })).toBe(0);
  });

  it('migrateLegacy: 0.4 t- streams → their endpoint, o- streams → the only server; event order and ids kept', () => {
    const { paths, store } = setup();
    const t1 = evs(2, 0);
    legacyStream(paths.queueProjects, `t-${'1'.repeat(32)}`, { pk: PK, bind: { kind: 'token', id: { endpoint: EP, company_slug: 'acme', token_fp: 'f' }, name: 'acme' } }, t1);
    legacyStream(paths.queueProjects, `o-${'2'.repeat(32)}`, { pk: PK, bind: { kind: 'open' } }, evs(1, 5));
    legacyStream(paths.queueProjects, `t-${'3'.repeat(32)}`, { pk: PK, bind: { kind: 'token', id: { endpoint: 'https://gone.example.com', token_fp: 'g' }, name: 'globex' } }, evs(1, 9));
    legacyStream(paths.queueUnresolved, `o-${'4'.repeat(32)}`, { cwd: '/work/x', bind: { kind: 'open' } }, evs(1, 7));
    mkdirSync(join(paths.queueProjects, `t-${'5'.repeat(32)}`)); // no stream.json: left as is
    writeFileSync(join(paths.queueProjects, `t-${'5'.repeat(32)}`, `${ulid()}.ndjson`), `${JSON.stringify(ev(99))}\n`);
    expect(store.streams().filter((s) => s.kind === 'legacy')).toHaveLength(5);
    expect(resolveStream(loadRouting(paths)!, { kind: 'legacy' })).toEqual({ kind: 'held', reason: 'legacy' });

    const m = store.migrateLegacy(loadRouting(paths)!.config);
    expect(m).toEqual({ streams: 4, events: 5, unassignedEvents: 0 });
    const rows = store.stats().streams.map((s) => [s.stream.kind, s.stream.pk ?? s.stream.cwd ?? null, s.stream.endpoint ?? null, s.events]);
    expect(rows).toEqual(
      expect.arrayContaining([
        ['project', PK, EP, 3],
        ['project', PK, 'https://gone.example.com', 1],
        ['unresolved', '/work/x', EP, 1],
        ['legacy', null, null, 1],
      ]),
    );
    const sent = store.stream(store.streams().find((s) => s.endpoint === EP && s.kind === 'project')!).readBatch()!;
    expect(sent.events.slice(0, 2).map((e) => e.event_id)).toEqual(t1.map((e) => e.event_id));
    // a stream of a server this machine is not logged in to waits (held no-server)
    const gone = store.streams().find((s) => s.endpoint === 'https://gone.example.com')!;
    expect(resolveStream(loadRouting(paths)!, identityOfRef(gone))).toEqual({ kind: 'held', reason: 'no-server', endpoint: 'https://gone.example.com' });
  });

  it('migrateLegacy with several servers: o- streams wait for a server (endpoint "")', () => {
    const paths = tmpHome();
    writeTestServers(paths, [{ endpoint: EP }, { endpoint: EP2 }]);
    const store = queueStore(paths);
    legacyStream(paths.queueProjects, `o-${'2'.repeat(32)}`, { pk: PK, bind: { kind: 'open' } }, evs(3));
    expect(store.migrateLegacy(loadRouting(paths)!.config)).toEqual({ streams: 1, events: 3, unassignedEvents: 3 });
    const [ref] = store.streams();
    expect(ref).toMatchObject({ kind: 'project', pk: PK, endpoint: '', team: '' });
    expect(resolveStream(loadRouting(paths)!, identityOfRef(ref!))).toMatchObject({ kind: 'held', reason: 'no-server', endpoint: '' });
  });

  it('prune removes empty stream dirs and stale .tmp dirs', () => {
    const { paths, store } = setup();
    enqueueFor(store, PK, EP, evs(1));
    const q = store.stream(store.streams()[0]!);
    q.ack(q.readBatch()!);
    const stale = join(paths.queueProjects, '.tmp-old');
    mkdirSync(stale);
    const old = new Date(Date.now() - DAY);
    utimesSync(stale, old, old);
    mkdirSync(join(paths.queueProjects, '.tmp-new'));
    store.prune();
    expect(readdirSync(paths.queueProjects)).toEqual(['.tmp-new']);
  });
});

describe('QueueStore caps (C13)', () => {
  it('the 30-day age cap drops only sendable streams; no-server, refused, expired, unknown and pre-upgrade streams are kept', () => {
    const paths = tmpHome();
    const EP3 = 'http://127.0.0.1:11';
    const config = writeTestServers(paths, [{ endpoint: EP }, { endpoint: EP2 }, { endpoint: EP3, expiresAt: new Date(Date.now() - DAY).toISOString() }]);
    const old = Date.now() - 40 * DAY;
    const store = queueStore(paths);
    enqueueFor(store, PK, EP, evs(2)); // sendable
    enqueueFor(store, 'github.com/g/web', EP2, evs(1)); // refused below
    enqueueFor(store, 'github.com/g/exp', EP3, evs(1)); // expired token
    enqueueFor(store, 'github.com/x/held', 'https://not-logged-in.io', evs(1)); // no server
    for (const d of readdirSync(paths.queueProjects)) {
      age(join(paths.queueProjects, d), old);
      sendableSince(join(paths.queueProjects, d), old); // a held stream's stale mark is cleared, never trusted
    }
    writeFileSync(join(paths.queue, `${ulidFrom('pre', old)}.ndjson`), `${JSON.stringify(ev(8))}\n`); // pre-upgrade
    const unknown = join(paths.queueProjects, `s-${'f'.repeat(32)}`);
    mkdirSync(unknown);
    writeFileSync(join(unknown, `${ulidFrom('u', old)}.ndjson`), `${JSON.stringify(ev(9))}\n`);
    writeServerDelivery(paths, config.servers[1]!, { blocked: { status: 401, at: new Date().toISOString(), message: 'x' } });

    const r = queueStore(paths).enforceCap();
    expect(r).toMatchObject({ droppedFiles: 1, droppedEvents: 2, droppedHeldEvents: 0 });
    const left = queueStore(paths).stats();
    expect(left.events).toBe(5);
    expect(left.streams.some((s) => s.stream.pk === PK)).toBe(false);
    expect(readDropped(paths)).toMatchObject({ held_events: 0, sendable_events: 2 });
  });

  it('released data gets its 30 days from the release, not from when it was recorded (C13)', () => {
    const paths = tmpHome();
    writeTestServers(paths, [{ endpoint: EP }, { endpoint: EP2 }]);
    let t = Date.now();
    const store = queueStore(paths, undefined, { now: () => t });
    enqueueFor(store, PK, '', evs(2)); // recorded while no server was chosen (held: no-server)
    const dir = join(paths.queueProjects, streamDirName(PK, '', ''));
    age(dir, t - 31 * DAY);
    expect(store.enforceCap().droppedFiles).toBe(0); // held: exempt
    writeTestServers(paths, [{ endpoint: EP }]); // `ai-obs token remove` of the second: '' now resolves to the only server
    store.enqueue(evs(1, 50), { kind: 'project', pk: 'github.com/acme/web', endpoint: EP, team: '' }); // the worker's next enqueue caps
    expect(store.stats().streams.find((x) => x.stream.pk === PK)?.events).toBe(2);
    for (let day = 1; day <= 29; day++) {
      t += DAY;
      expect(store.enforceCap().droppedFiles).toBe(0);
    }
    t += 2 * DAY; // 31 days of being sendable without being sent
    expect(store.enforceCap()).toMatchObject({ droppedEvents: 2, droppedHeldEvents: 0 });
  });

  it('time while a server is refused (401) does not count; an unobserved gap starts a new period', () => {
    const paths = tmpHome();
    const config = writeTestConfig(paths);
    let t = Date.now();
    const store = queueStore(paths, undefined, { now: () => t });
    enqueueFor(store, PK, EP, evs(2));
    const dir = join(paths.queueProjects, streamDirName(PK, EP, ''));
    age(dir, t - 40 * DAY);
    sendableSince(dir, t - 40 * DAY, t - 39 * DAY); // seen sendable once, 39 days ago
    writeServerDelivery(paths, config.servers[0]!, { blocked: { status: 401, at: new Date(t).toISOString(), message: 'x' } });
    expect(store.enforceCap().droppedFiles).toBe(0); // refused: exempt, and the stream is marked held
    writeServerDelivery(paths, config.servers[0]!, { blocked: null }); // a new login / manual flush worked again
    expect(store.enforceCap().droppedFiles).toBe(0);
    const other = join(paths.queueProjects, streamDirName('github.com/acme/web', EP, ''));
    enqueueFor(store, 'github.com/acme/web', EP, evs(1, 10));
    age(other, t - 40 * DAY);
    sendableSince(other, t - 40 * DAY, t - 39 * DAY);
    expect(store.enforceCap().droppedFiles).toBe(0);
    expect(store.stats().events).toBe(3);
  });

  it('the size cap drops the globally oldest segments (held ones too), never the one just written, and counts them', () => {
    const { paths } = setup();
    let clock = Date.now() - 10_000;
    const store = queueStore(paths, undefined, { now: () => clock, maxBytes: 1_000, segmentBytes: 1 });
    enqueueFor(store, 'github.com/x/held', 'https://not-logged-in.io', evs(4)); // oldest, held
    clock += 1000;
    enqueueFor(store, PK, EP, evs(4, 10)); // sendable
    clock += 1000;
    enqueueFor(store, PK, EP, evs(4, 20)); // just written: over the cap
    const st = store.stats();
    expect(st.bytes).toBeLessThanOrEqual(1_000);
    const d = readDropped(paths);
    expect(d.held_events).toBe(4);
    expect(d.last_at).toBeTruthy();
    expect(st.streams.some((s) => s.stream.pk === 'github.com/x/held')).toBe(false);
    const ids = store.stream(store.streams().find((s) => s.pk === PK)!).readBatch()!.events.map((e) => (e as { turn_id: string }).turn_id);
    expect(ids).toContain('t23');
  });
});
