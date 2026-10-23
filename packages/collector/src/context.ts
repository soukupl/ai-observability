import { resolve as resolvePath } from 'node:path';
import type { CollectorContext, HarnessAdapter, StreamHolder } from './adapters/types.js';
import { stageDigests } from './analysis/summaries.js';
import type { CollectorConfig } from './config.js';
import type { Logger } from './log.js';
import { harnessStateDir, type AiObsPaths } from './paths.js';
import { rememberPk } from './pk-cache.js';
import { loadPathSecret, localRef, resolveProjectKey, RESOLVE_TIMEOUT_MS } from './project-key.js';
import { adoptKey, captureBinding, explicitBinding, loadRouting, type RoutingView } from './projects.js';
import type { ProjectRef } from './protocol-types.js';
import type { QueueStore, StreamKey } from './queue.js';
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
  /** override the routing read (tests); default a fresh loadRouting(paths) per binding decision (C17) */
  routing?: () => RoutingView | null;
}

/**
 * Builds the CollectorContext handed to an adapter. Events are queued with PLAIN project keys and
 * usage names: naming and hashing happen at send time for the receiving token (C3, contract §5.5).
 */
export function createContext(deps: ContextDeps): CollectorContext {
  const keys = new Map<string, Promise<string | null>>();
  const resolve = deps.resolveProject ?? ((cwd: string) => resolveProjectKey(cwd, { timeoutMs: RESOLVE_TIMEOUT_MS }));
  const routing = deps.routing ?? (() => loadRouting(deps.paths));
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
    async streamFor(holder: StreamHolder, capturedAt: number): Promise<StreamKey | null> {
      const pinned = holder.stream;
      if (pinned?.kind === 'project') {
        if (pinned.bind.kind !== 'open') return pinned;
        // An open session joins the project's choice from its next event on (C12): what it records after
        // `use <name>` stays with <name>; what it recorded before follows the choice as open data.
        const view = routing();
        const bind = view ? explicitBinding(view, pinned.pk) : null;
        if (!bind) return pinned;
        holder.stream = { kind: 'project', pk: pinned.pk, bind };
        return holder.stream;
      }
      if (pinned?.kind === 'unresolved') {
        const pk = await keyOf(pinned.cwd);
        if (pk === null) return pinned;
        const view = routing();
        if (!view) return pinned;
        // bound data keeps its token; `--none` keeps the pin (QueueStore.enqueue drops the later events, C19)
        holder.stream = { kind: 'project', pk, bind: adoptKey(view, pk, pinned.bind).bind };
        return holder.stream;
      }
      if (holder.pkCwd === null || holder.pkCwd === undefined) return null; // no cwd at all (C16): caller drops + logs
      const pk = await keyOf(holder.pkCwd);
      const view = routing();
      if (!view) return null;
      const d = captureBinding(view, pk, capturedAt);
      if (d.kind === 'drop') return null; // `use --none` (or no token): not recorded, the stream stays unset
      holder.stream = pk === null ? { kind: 'unresolved', cwd: holder.pkCwd, bind: d.bind } : { kind: 'project', pk, bind: d.bind };
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
