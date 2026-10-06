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
    /** endpoint, token, random machine_id (mode 0600) */
    config: join(home, 'config.json'),
    /** random local secret for path-based project keys (mode 0600; never sent) */
    projectSecret: join(home, 'project-secret'),
    /** per-session cursors (state/<harness>/<session>.json), delivery + collector-config caches */
    state,
    /** cached GET /api/v1/collector-config */
    collectorConfigCache: join(state, 'collector-config.json'),
    /** last delivery attempt / success / backoff */
    delivery: join(state, 'delivery.json'),
    /** *.ndjson event queue, capped ~50 MB / 30 days */
    queue: join(home, 'queue'),
    /** batches the server refused as a whole (HTTP 400), kept locally for inspection */
    deadLetter: join(home, 'queue', 'dead'),
    /** hook invocations waiting for the detached worker */
    jobs: join(home, 'jobs'),
    /** collector log (errors from hooks and the worker go here, never to the harness) */
    logDir: join(home, 'log'),
    logFile: join(home, 'log', 'collector.log'),
    /** stable copy of the collector that installed hooks point to */
    app: join(home, 'app'),
    /** held by the single worker / flush process */
    workerLock: join(home, 'worker.lock'),
  } as const;
}

export type AiObsPaths = ReturnType<typeof aiObsPaths>;

/** Directory for one harness's session state. */
export function harnessStateDir(paths: AiObsPaths, harness: string): string {
  return join(paths.state, harness);
}
