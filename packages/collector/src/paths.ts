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
    /** registered tokens, default endpoint, random machine_id, routing epochs (mode 0600) */
    config: join(home, 'config.json'),
    /** per-repo token choice, keyed by the plain project key (mode 0600; written only by `ai-obs use`) */
    projects: join(home, 'projects.json'),
    /** random local secret for path-based project keys (mode 0600; never sent) */
    projectSecret: join(home, 'project-secret'),
    /** per-session cursors (state/<harness>/<session>.json), delivery + collector-config caches */
    state,
    /** single collector-config cache of the 0.1.x collector; deleted by the first registration (per-token caches: collectorConfigDir) */
    collectorConfigCache: join(state, 'collector-config.json'),
    /** cached GET /api/v1/collector-config, one file per token: <name>.json */
    collectorConfigDir: join(state, 'collector-config'),
    /** cwd → plain project key, written by the worker and `use`, read by the hook */
    projectKeyCache: join(state, 'project-keys.json'),
    /** SessionStart nudge markers, one file per session id */
    nudged: join(state, 'nudged'),
    /** size-cap drop counters */
    dropped: join(state, 'dropped.json'),
    /** per-token delivery state: last attempt / success / backoff / blocked */
    delivery: join(state, 'delivery.json'),
    /** event queue, capped ~50 MB / 30 days; root *.ndjson = pre-upgrade stream (frozen, never sent) */
    queue: join(home, 'queue'),
    /** project streams p/o-<id>/ (open) and p/t-<id>/ (token-bound) */
    queueProjects: join(home, 'queue', 'p'),
    /** unresolved streams u/o-<id>/, u/t-<id>/ (git timed out at capture) */
    queueUnresolved: join(home, 'queue', 'u'),
    /** batches the server refused as a whole (HTTP 400), kept locally for inspection */
    deadLetter: join(home, 'queue', 'dead'),
    /** pre-upgrade root segments, moved here by the first registration and never sent (tokens were reset) */
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

/** Per-token collector-config cache file. Token names are validated (TOKEN_NAME_RE) before they reach here. */
export function collectorConfigPath(paths: Pick<AiObsPaths, 'collectorConfigDir'>, name: string): string {
  if (!/^[a-z0-9-]{1,63}$/.test(name)) throw new Error(`invalid token name: ${JSON.stringify(name)}`);
  return join(paths.collectorConfigDir, `${name}.json`);
}

/** Nudge marker of one session; null unless the id is a plain token (no path tricks). */
export function nudgeMarkerPath(paths: Pick<AiObsPaths, 'nudged'>, sessionId: unknown): string | null {
  return typeof sessionId === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(sessionId) ? join(paths.nudged, sessionId) : null;
}

/** Directory for one harness's session state. */
export function harnessStateDir(paths: AiObsPaths, harness: string): string {
  return join(paths.state, harness);
}
