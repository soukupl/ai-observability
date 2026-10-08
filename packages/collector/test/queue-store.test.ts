import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TokenEntry } from '../src/config.js';
import { readDropped, writeTokenDelivery } from '../src/delivery.js';
import { assignmentFor, loadRouting, resolveStream, streamDirName, unresolvedDirName } from '../src/projects.js';
import type { IngestEvent } from '../src/protocol-types.js';
import { EventQueue, identityOfRef, type StreamKey } from '../src/queue.js';
import { ulid, ulidFrom } from '../src/ulid.js';
import { cleanupHomes, tmpHome, writeProjects, writeTestConfig, writeTestTokens } from './helpers.js';
import { bound, enqueueFor, OPEN, queueStore } from './queue-helpers.js';

afterEach(cleanupHomes);

const PK = 'github.com/acme/billing';
const DAY = 24 * 3600_000;
const ACME = bound('acme', 'http://127.0.0.1:9', 'acme', 'aiobs_u_testtoken');
const ACME_LABEL = { name: 'Acme', slug: 'acme' };

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

function setup() {
  const paths = tmpHome();
  const config = writeTestConfig(paths);
  return { paths, config, store: queueStore(paths) };
}

describe('QueueStore streams', () => {
  it('keeps one stream per (project key, binding), each with its stream.json; o- / t- prefixes', () => {
    const { paths, store } = setup();
    enqueueFor(store, PK, ACME, evs(2));
    enqueueFor(store, PK, OPEN, evs(1));
    enqueueFor(store, 'github.com/acme/web', ACME, evs(1));
    const dirs = readdirSync(paths.queueProjects).sort();
    expect(dirs).toEqual([streamDirName(PK, ACME), streamDirName(PK, OPEN), streamDirName('github.com/acme/web', ACME)].sort());
    expect(dirs.filter((d) => d.startsWith('t-'))).toHaveLength(2);
    expect(dirs.filter((d) => d.startsWith('o-'))).toHaveLength(1);
    const meta = JSON.parse(readFileSync(join(paths.queueProjects, streamDirName(PK, OPEN), 'stream.json'), 'utf8'));
    expect(meta).toMatchObject({ pk: PK, bind: { kind: 'open' } });
    expect(typeof meta.created_at).toBe('string');
    const stats = store.stats();
    expect(stats.events).toBe(4);
    expect(stats.streams.map((s) => s.stream.kind)).toEqual(['project', 'project', 'project']);
    expect(identityOfRef(stats.streams[0]!.stream)).toMatchObject({ kind: 'project', pk: PK });
  });

  it('no API writes the root (the frozen pre-upgrade stream)', () => {
    const { paths, store } = setup();
    enqueueFor(store, PK, ACME, evs(1));
    store.enqueue(evs(1), { kind: 'unresolved', cwd: '/work/x', bind: OPEN });
    store.enqueue(evs(1), null);
    expect(readdirSync(paths.queue).filter((f) => f.endsWith('.ndjson'))).toEqual([]);
    expect(readdirSync(paths.queueUnresolved)).toEqual([unresolvedDirName('/work/x', OPEN)]);
  });

  it('lists root segments as the pre-upgrade stream', () => {
    const { paths, store } = setup();
    new EventQueue(paths.queue).enqueue(evs(2));
    expect(store.streams()).toEqual([{ kind: 'pre-upgrade', dir: paths.queue }]);
    expect(identityOfRef(store.streams()[0]!)).toEqual({ kind: 'pre-upgrade' });
  });

  it('drops events with no key, and events of an opted-out project (`use --none`)', () => {
    const { paths, store } = setup();
    store.enqueue(evs(2), null);
    writeProjects(paths, { [PK]: { token: null, none: true, assigned_at: new Date().toISOString() } });
    enqueueFor(store, PK, ACME, evs(2));
    expect(store.stats().events).toBe(0);
    expect(existsSync(paths.queueProjects)).toBe(false);
  });

  it('crash window: a .tmp dir is ignored; a stream dir without stream.json, or whose stream.json does not hash to its name, is unknown', () => {
    const { paths, store } = setup();
    mkdirSync(join(paths.queueProjects, '.tmp-abc'), { recursive: true });
    writeFileSync(join(paths.queueProjects, '.tmp-abc', `${ulid()}.ndjson`), `${JSON.stringify(ev(0))}\n`);
    const bare = join(paths.queueProjects, `t-${'0'.repeat(32)}`);
    mkdirSync(bare);
    writeFileSync(join(bare, `${ulid()}.ndjson`), `${JSON.stringify(ev(1))}\n`);
    enqueueFor(store, PK, ACME, evs(1, 5));
    const forged = join(paths.queueProjects, streamDirName(PK, ACME));
    writeFileSync(join(forged, 'stream.json'), JSON.stringify({ pk: 'github.com/other/repo', bind: ACME }));
    const kinds = store.streams().map((s) => s.kind);
    expect(kinds).toEqual(['unknown', 'unknown']);
    expect(store.streams().map(identityOfRef)).toEqual([{ kind: 'unknown' }, { kind: 'unknown' }]);
  });

  it('never appends into a directory of the right name that is not this stream', () => {
    const { paths, store } = setup();
    const dir = join(paths.queueProjects, streamDirName(PK, ACME));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'stream.json'), '{garbage');
    enqueueFor(store, PK, ACME, evs(1));
    expect(readdirSync(dir)).toEqual(['stream.json']);
  });

  it('adopt: an unresolved stream moves into its project stream (single token at capture → bound)', () => {
    const { paths, store } = setup();
    store.enqueue(evs(2), { kind: 'unresolved', cwd: '/work/billing', bind: ACME });
    const [ref] = store.streams();
    store.adopt(ref!, PK);
    expect(existsSync(join(paths.queueUnresolved, unresolvedDirName('/work/billing', ACME)))).toBe(false);
    const streams = store.stats().streams;
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({ events: 2, stream: { kind: 'project', pk: PK, bind: ACME } });
  });

  it('adopt: open stays open; an explicit choice binds it; --none keeps it (held opted-out)', () => {
    const paths = tmpHome();
    const config = writeTestTokens(paths, [{ name: 'acme' }, { name: 'globex' }]);
    const store = queueStore(paths);
    const key = (cwd: string): StreamKey => ({ kind: 'unresolved', cwd, bind: OPEN });
    store.enqueue(evs(1), key('/a'));
    store.adopt(store.streams()[0]!, 'github.com/x/a');
    expect(store.streams()[0]).toMatchObject({ kind: 'project', pk: 'github.com/x/a', bind: OPEN });

    const globex = config.tokens[1] as TokenEntry;
    writeProjects(paths, {
      'github.com/x/b': { token: 'globex', endpoint: globex.endpoint, company_slug: 'globex', token_fp: 'whatever', assigned_at: new Date().toISOString() },
      'github.com/x/c': { token: null, none: true, assigned_at: new Date().toISOString() },
    });
    store.enqueue(evs(1), key('/b'));
    store.adopt(store.streams().find((s) => s.kind === 'unresolved')!, 'github.com/x/b');
    expect(store.streams().find((s) => s.pk === 'github.com/x/b')).toMatchObject({ bind: { kind: 'token', name: 'globex' } });

    store.enqueue(evs(3), key('/c'));
    store.enqueue(evs(2), { kind: 'unresolved', cwd: '/c', bind: ACME });
    for (const u of store.streams().filter((s) => s.kind === 'unresolved')) store.adopt(u, 'github.com/x/c');
    expect(store.streams().filter((s) => s.kind === 'unresolved')).toEqual([]);
    expect(store.stats().events).toBe(7); // nothing deleted: `use --none` keeps queued data until --discard-queued
    const c = store.stats().streams.filter((s) => s.stream.pk === 'github.com/x/c');
    expect(c.map((s) => [s.stream.bind?.kind, s.events]).sort()).toEqual([
      ['open', 3],
      ['token', 2],
    ]);
    for (const s of c) expect(resolveStream(loadRouting(paths)!, identityOfRef(s.stream))).toMatchObject({ kind: 'held', reason: 'opted-out' });
  });

  it('adopt: data bound at capture keeps its token after `use <other>` (C12)', () => {
    const paths = tmpHome();
    const config = writeTestTokens(paths, [{ name: 'acme' }, { name: 'globex' }]);
    const store = queueStore(paths);
    const acme = bound('acme');
    store.enqueue(evs(2), { kind: 'unresolved', cwd: '/b', bind: acme });
    const globex = config.tokens[1] as TokenEntry;
    writeProjects(paths, { [PK]: { token: 'globex', endpoint: globex.endpoint, company_slug: 'globex', token_fp: 'whatever', assigned_at: new Date().toISOString() } });
    store.adopt(store.streams()[0]!, PK);
    expect(store.streams()).toEqual([expect.objectContaining({ kind: 'project', pk: PK, bind: acme })]);
  });

  it('rebind (--move-queued) merges the key’s other token-bound streams, keeping time order; open data stays', () => {
    const { store } = setup();
    const OTHER = bound('globex');
    enqueueFor(store, PK, ACME, evs(2, 0));
    enqueueFor(store, PK, OPEN, evs(1, 10));
    enqueueFor(store, PK, OTHER, evs(1, 20));
    enqueueFor(store, 'github.com/acme/web', ACME, evs(1, 30));
    expect(store.rebind(PK, OTHER)).toBe(2);
    const byDir = store.stats().streams.map((s) => [s.stream.pk, s.stream.bind?.kind === 'token' ? s.stream.bind.name : 'open', s.events]);
    expect(byDir).toEqual(
      expect.arrayContaining([
        [PK, 'globex', 3],
        [PK, 'open', 1],
        ['github.com/acme/web', 'acme', 1],
      ]),
    );
    const target = store.streams().find((s) => s.pk === PK && s.bind?.kind === 'token')!;
    const ids: string[] = [];
    const q = store.stream(target);
    for (let b = q.readBatch(); b; b = null) ids.push(...b.events.map((e) => (e as { turn_id: string }).turn_id));
    expect(ids).toEqual(['t0', 't1', 't20']);
  });

  it('dropKey (--discard-queued) deletes every stream of the key and returns the count', () => {
    const { store } = setup();
    enqueueFor(store, PK, ACME, evs(2));
    enqueueFor(store, PK, OPEN, evs(1));
    enqueueFor(store, 'github.com/acme/web', ACME, evs(1));
    expect(store.dropKey(PK)).toBe(3);
    expect(store.stats().events).toBe(1);
  });

  it('prune removes empty stream dirs and stale .tmp dirs', () => {
    const { paths, store } = setup();
    enqueueFor(store, PK, ACME, evs(1));
    const ref = store.streams()[0]!;
    const q = store.stream(ref);
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
  it('the 30-day age cap drops only sendable streams; held, blocked, unknown and pre-upgrade streams are kept', () => {
    const paths = tmpHome();
    const config = writeTestTokens(paths, [{ name: 'acme' }, { name: 'globex' }]);
    const old = Date.now() - 40 * DAY;
    const store = queueStore(paths);
    enqueueFor(store, PK, bound('acme'), evs(2)); // sendable
    enqueueFor(store, 'github.com/g/web', bound('globex'), evs(1)); // blocked below
    enqueueFor(store, 'github.com/x/held', OPEN, evs(1)); // unassigned
    for (const d of readdirSync(paths.queueProjects)) {
      age(join(paths.queueProjects, d), old);
      sendableSince(join(paths.queueProjects, d), old); // a held stream's stale mark is cleared, never trusted
    }
    writeFileSync(join(paths.queue, `${ulidFrom('pre', old)}.ndjson`), `${JSON.stringify(ev(8))}\n`); // pre-upgrade
    const unknown = join(paths.queueProjects, `o-${'f'.repeat(32)}`);
    mkdirSync(unknown);
    writeFileSync(join(unknown, `${ulidFrom('u', old)}.ndjson`), `${JSON.stringify(ev(9))}\n`);
    writeTokenDelivery(paths, config.tokens[1] as TokenEntry, { blocked: { status: 401, at: new Date().toISOString(), message: 'x' } });

    const r = queueStore(paths).enforceCap();
    expect(r).toMatchObject({ droppedFiles: 1, droppedEvents: 2, droppedHeldEvents: 0 });
    const left = queueStore(paths).stats();
    expect(left.events).toBe(4);
    expect(left.streams.some((s) => s.stream.pk === PK)).toBe(false);
    expect(readDropped(paths)).toMatchObject({ held_events: 0, sendable_events: 2 });
  });

  it('released data gets its 30 days from the release, not from when it was recorded (C13)', () => {
    const paths = tmpHome();
    const config = writeTestTokens(paths, [{ name: 'acme' }, { name: 'globex' }]);
    let t = Date.now();
    const store = queueStore(paths, undefined, { now: () => t });
    enqueueFor(store, PK, OPEN, evs(2)); // recorded while the repository had no choice (held: unassigned)
    const dir = join(paths.queueProjects, streamDirName(PK, OPEN));
    age(dir, t - 31 * DAY);
    expect(store.enforceCap().droppedFiles).toBe(0); // held: exempt
    writeProjects(paths, { [PK]: assignmentFor(config.tokens[0] as TokenEntry, ACME_LABEL, new Date(t)) }); // `ai-obs use acme`
    store.enqueue(evs(1, 50), { kind: 'project', pk: 'github.com/acme/web', bind: OPEN }); // the worker's next enqueue caps
    expect(store.stats().streams.find((x) => x.stream.pk === PK)?.events).toBe(2);
    for (let day = 1; day <= 29; day++) {
      t += DAY;
      expect(store.enforceCap().droppedFiles).toBe(0);
    }
    t += 2 * DAY; // 31 days of being sendable without being sent
    expect(store.enforceCap()).toMatchObject({ droppedEvents: 2, droppedHeldEvents: 0 });
    expect(readDropped(paths)).toMatchObject({ held_events: 0, sendable_events: 2 });
  });

  it('a token blocked for more than 30 days keeps its data once it works again; an unobserved gap starts a new period', () => {
    const paths = tmpHome();
    const config = writeTestTokens(paths, [{ name: 'acme' }, { name: 'globex' }]);
    let t = Date.now();
    const store = queueStore(paths, undefined, { now: () => t });
    const acme = config.tokens[0] as TokenEntry;
    enqueueFor(store, PK, bound('acme'), evs(2));
    const dir = join(paths.queueProjects, streamDirName(PK, bound('acme')));
    age(dir, t - 40 * DAY);
    sendableSince(dir, t - 40 * DAY, t - 39 * DAY); // seen sendable once, 39 days ago
    writeTokenDelivery(paths, acme, { blocked: { status: 401, at: new Date(t).toISOString(), message: 'x' } });
    expect(store.enforceCap().droppedFiles).toBe(0); // blocked: exempt, and the stream is marked held
    writeTokenDelivery(paths, acme, { blocked: null }); // a manual flush worked again
    expect(store.enforceCap().droppedFiles).toBe(0);
    // never seen held, but not seen for 39 days either: the hold could not be seen, so a new period starts
    const other = join(paths.queueProjects, streamDirName('github.com/acme/web', bound('acme')));
    enqueueFor(store, 'github.com/acme/web', bound('acme'), evs(1, 10));
    age(other, t - 40 * DAY);
    sendableSince(other, t - 40 * DAY, t - 39 * DAY);
    expect(store.enforceCap().droppedFiles).toBe(0);
    expect(store.stats().events).toBe(3);
  });

  it('the size cap drops the globally oldest segments (held ones too), never the one just written, and counts them', () => {
    const { paths } = setup();
    const t0 = Date.now() - 10_000;
    let clock = t0;
    const store = queueStore(paths, undefined, { now: () => clock, maxBytes: 1_000, segmentBytes: 1 });
    enqueueFor(store, 'github.com/x/held', OPEN, evs(4)); // oldest, held
    clock += 1000;
    enqueueFor(store, PK, ACME, evs(4, 10)); // sendable
    clock += 1000;
    enqueueFor(store, PK, ACME, evs(4, 20)); // just written: over the cap
    const st = store.stats();
    expect(st.bytes).toBeLessThanOrEqual(1_000);
    const d = readDropped(paths);
    expect(d.held_events).toBe(4);
    expect(d.last_at).toBeTruthy();
    expect(st.streams.some((s) => s.stream.pk === 'github.com/x/held')).toBe(false);
    // the newest segment of the stream just written survives
    const ids: string[] = [];
    const q = store.stream(store.streams().find((s) => s.pk === PK)!);
    for (let b = q.readBatch(); b; b = null) ids.push(...b.events.map((e) => (e as { turn_id: string }).turn_id));
    expect(ids).toContain('t23');
  });
});
