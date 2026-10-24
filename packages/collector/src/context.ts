import { resolve as resolvePath } from 'node:path';
import type { CollectorContext, HarnessAdapter, StreamHolder } from './adapters/types.js';
import { stageDigests } from './analysis/summaries.js';
import { loadConfig, type CollectorConfig } from './config.js';
import { lookupDotFile, type DotFileValue } from './dotfile.js';
import type { Logger } from './log.js';
import { harnessStateDir, type AiObsPaths } from './paths.js';
import { rememberPk } from './pk-cache.js';
import { loadPathSecret, localRef, resolveProjectKey, RESOLVE_TIMEOUT_MS } from './project-key.js';
import type { ProjectRef } from './protocol-types.js';
import type { QueueStore } from './queue.js';
import { targetFor, upgradeStreamKey, type StreamKey, type StreamTarget } from './routing.js';
import { SessionStateStore } from './state.js';

export interface ContextDeps {
  adapter: HarnessAdapter;
  config: CollectorConfig;
  paths: AiObsPaths;
  queue: Pick<QueueStore, 'enqueue'>;
  log: Logger;
  now?: () => Date;
  /** override project-key resolution (tests): the plain key of a cwd, null when git timed out */
  resolveProject?: (cwd: string) => Promise<string | null>;
  /** override the config read (tests); default a fresh loadConfig(paths) per pinning decision (C17) */
  currentConfig?: () => CollectorConfig | null;
  /** override the dot-file lookup (tests); default lookupDotFile with the state/dot-files.json cache */
  dotFile?: (cwd: string) => DotFileValue;
}

/**
 * Builds the CollectorContext handed to an adapter. Events are queued with PLAIN project keys and
 * usage names: naming and hashing happen at send time for the receiving server (C3).
 */
export function createContext(deps: ContextDeps): CollectorContext {
  const keys = new Map<string, Promise<string | null>>();
  const resolve = deps.resolveProject ?? ((cwd: string) => resolveProjectKey(cwd, { timeoutMs: RESOLVE_TIMEOUT_MS }));
  const currentConfig = deps.currentConfig ?? (() => loadConfig(deps.paths));
  const dotFile = deps.dotFile ?? ((cwd: string) => lookupDotFile(cwd, { cache: deps.paths, write: true }));
  /** The target a session takes now: dot file, else the only server, else none (''). */
  const targetOf = (config: CollectorConfig, cwd: string): StreamTarget => {
    let dot: DotFileValue = {};
    try {
      const d = dotFile(cwd);
      dot = { ...(d.server ? { server: d.server } : {}), ...(d.team ? { team: d.team } : {}) };
    } catch (err) {
      deps.log.warn('context: dot-file lookup failed', { error: String(err).slice(0, 200) });
    }
    return targetFor(config, dot);
  };
  let pathSecret: string | null | undefined;

  /** The plain key of a cwd, once per context; successful resolutions feed the hook's key cache (§4.2). */
  const keyOf = (cwd: string): Promise<string | null> => {
    let p = keys.get(cwd);
    if (!p) {
      p = resolve(cwd).then(
        (pk) => {
          if (pk) rememberPk(deps.paths, cwd, pk);
          return pk;
        },
        (err: unknown) => {
          deps.log.warn('context: project key resolution failed', { error: String(err).slice(0, 200) });
          return null;
        },
      );
      keys.set(cwd, p);
    }
    return p;
  };

  const ctx: CollectorContext = {
    harness: deps.adapter.name,
    config: deps.config,
    paths: deps.paths,
    queue: deps.queue,
    state: new SessionStateStore(harnessStateDir(deps.paths, deps.adapter.name)),
    log: deps.log,
    now: deps.now ?? (() => new Date()),
    async projectKey(cwd): Promise<ProjectRef> {
      pathSecret ??= loadPathSecret(deps.paths.projectSecret);
      const pk = await keyOf(cwd);
      return localRef(pk ?? resolvePath(cwd), pathSecret);
    },
    async streamFor(holder: StreamHolder, _capturedAt: number): Promise<StreamKey | null> {
      const config = currentConfig();
      // a pin stored by 0.2 – 0.4 (`bind`) is converted like its stream (brief appendix E)
      const pinned = holder.stream ? upgradeStreamKey(holder.stream, config) : null;
      if (pinned && holder.stream !== pinned) holder.stream = pinned;
      const cwd = holder.pkCwd ?? null;
      if (pinned?.kind === 'project') {
        if (pinned.endpoint !== '' || !config || cwd === null) return pinned;
        // Recorded while no server was chosen: the session joins the repository's server from its next event
        // (a dot file written by `ai-obs link`, or only one server left); a chosen server is never changed (C12).
        const t = targetOf(config, cwd);
        if (t.endpoint === '') return pinned;
        holder.stream = { kind: 'project', pk: pinned.pk, ...t };
        return holder.stream;
      }
      if (pinned?.kind === 'unresolved') {
        const pk = await keyOf(pinned.cwd);
        if (pk === null) return pinned;
        const t = pinned.endpoint === '' && config ? targetOf(config, pinned.cwd) : { endpoint: pinned.endpoint, team: pinned.team };
        holder.stream = { kind: 'project', pk, ...(t.endpoint === '' ? { endpoint: '', team: pinned.team } : t) };
        return holder.stream;
      }
      if (cwd === null) return null; // no cwd at all (C16): caller drops + logs
      if (!config || !config.servers.length) return null; // not logged in anywhere: nothing is recorded (C6)
      const pk = await keyOf(cwd);
      const t = targetOf(config, cwd);
      holder.stream = pk === null ? { kind: 'unresolved', cwd, ...t } : { kind: 'project', pk, ...t };
      return holder.stream;
    },
    scheduleSummaries(digests, key) {
      try {
        stageDigests(deps.paths.state, deps.adapter.name, digests, key, ctx.now().getTime(), deps.log);
        return true;
      } catch (err) {
        deps.log.error('summaries: cannot stage digests', { error: String(err).slice(0, 200) });
        return false;
      }
    },
  };
  return ctx;
}
