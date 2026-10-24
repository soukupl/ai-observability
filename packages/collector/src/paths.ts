import { homedir } from 'node:os';
import { join } from 'node:path';

/** Resolves the collector home: explicit arg, then AI_OBS_HOME, then ~/.ai-obs. */
export function resolveHome(home?: string): string {
  return home ?? process.env.AI_OBS_HOME ?? join(homedir(), '.ai-obs');
}

/** Local collector files (BRIEF §5.1). AI_OBS_HOME overrides the base dir (tests, sandboxes). */
export function aiObsPaths(home: string = resolveHome()) {
  const state = join(home, 'state');
  return {
    root: home,
    /** config v3: machine_id and one entry per server with its token (mode 0600) */
    config: join(home, 'config.json'),
    /** 0.2 – 0.4 per-repository token choice: no longer read; renamed to projects.json.v2 by the migration */
    legacyProjects: join(home, 'projects.json'),
    /** random local secret for path-based project keys (mode 0600; never sent) */
    projectSecret: join(home, 'project-secret'),
    /** per-session cursors (state/<harness>/<session>.json), delivery + collector-config caches */
    state,
    /** cached GET /api/v1/collector-config, one file per server: <host>.json (':' → '_') */
    collectorConfigDir: join(state, 'collector-config'),
    /** cwd → plain project key, written by the worker, read by the hook */
    projectKeyCache: join(state, 'project-keys.json'),
    /** cwd → dot-file lookup (.ai-obs.json / .ai-obs.local.json), written by the worker, read by the hook */
    dotFileCache: join(state, 'dot-files.json'),
    /** latest ingest warning per project key (team_not_member / team_unknown) */
    warnings: join(state, 'warnings.json'),
    /** SessionStart nudge markers, one file per session id */
    nudged: join(state, 'nudged'),
    /** size-cap drop counters */
    dropped: join(state, 'dropped.json'),
    /** per-server delivery state (keyed by host): last attempt / success / backoff / blocked / repositories */
    delivery: join(state, 'delivery.json'),
    /** event queue, capped ~50 MB / 30 days; root *.ndjson = pre-upgrade stream (frozen, never sent) */
    queue: join(home, 'queue'),
    /** project streams p/s-<id>/ keyed by (project key, server endpoint, team) */
    queueProjects: join(home, 'queue', 'p'),
    /** unresolved streams u/s-<id>/ (git timed out at capture) */
    queueUnresolved: join(home, 'queue', 'u'),
    /** batches the server refused as a whole (HTTP 400), kept locally for inspection */
    deadLetter: join(home, 'queue', 'dead'),
    /** pre-upgrade root segments moved here by 0.2 – 0.4 (never sent; left as is) */
    deadPreUpgrade: join(home, 'queue', 'dead', 'pre-upgrade'),
    /** hook invocations waiting for the detached worker */
    jobs: join(home, 'jobs'),
    /** collector log (errors from hooks and the worker go here, never to the harness) */
    logDir: join(home, 'log'),
    logFile: join(home, 'log', 'collector.log'),
    /** stable copy of the collector that installed hooks point to */
    app: join(home, 'app'),
    /** held by the single worker / flush process */
    workerLock: join(home, 'worker.lock'),
    /** held while turn summaries are written (worker summary phase after its flush, or `ai-obs flush`; ADR-0027) */
    summariesLock: join(home, 'summaries.lock'),
    /** digests due for summarising, staged/<harness>/<ulid>.json (local only, mode 0600; ADR-0027) */
    stagedSummaries: join(state, 'summaries', 'staged'),
  } as const;
}

export type AiObsPaths = ReturnType<typeof aiObsPaths>;

/** Per-server collector-config cache file: `<host>.json` with ':' → '_' (a host is never a path). */
export function collectorConfigPath(paths: Pick<AiObsPaths, 'collectorConfigDir'>, host: string): string {
  if (!/^[a-z0-9.\-\[\]:]{1,255}$/.test(host)) throw new Error(`invalid host: ${JSON.stringify(host)}`);
  return join(paths.collectorConfigDir, `${host.replace(/[:[\]]/g, '_')}.json`);
}

/** Nudge marker of one session; null unless the id is a plain token (no path tricks). */
export function nudgeMarkerPath(paths: Pick<AiObsPaths, 'nudged'>, sessionId: unknown): string | null {
  return typeof sessionId === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(sessionId) ? join(paths.nudged, sessionId) : null;
}

/** Directory for one harness's session state. */
export function harnessStateDir(paths: AiObsPaths, harness: string): string {
  return join(paths.state, harness);
}
