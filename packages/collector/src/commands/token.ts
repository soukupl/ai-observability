import { dropCache } from '../cc-cache.js';
import { endpointHost, loadConfig, matchServer, removeServer, saveConfig } from '../config.js';
import { dropServerDelivery, readDelivery, serverDelivery } from '../delivery.js';
import { loadRouting } from '../routing.js';
import { nowOf, openStore, parseOptions, serverState, summarizeQueue, table, terminalSafe, UsageError, withWriteLock, type CliDeps, type Io } from './common.js';

const NOT_CONFIGURED = 'not configured — run `ai-obs login --server <url>`';

/** `ai-obs token list | remove <server>`. Logging in (and replacing a token) is `ai-obs login`. */
export async function tokenCommand(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'list':
      return tokenList(rest, io, deps);
    case 'remove':
      return tokenRemove(rest, io, deps);
    default:
      throw new UsageError(
        sub ? `unknown token command "${sub}" (list, remove; log in with \`ai-obs login\`)` : 'token needs a command: list or remove (log in with `ai-obs login`)',
      );
  }
}

/** `token list` (no network): one row per server. */
async function tokenList(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  parseOptions(args, {});
  const nowMs = nowOf(deps);
  const view = loadRouting(deps.paths, nowMs);
  if (!view) {
    io.err(NOT_CONFIGURED);
    return 1;
  }
  if (!view.config.servers.length) return 1; // the banner said it
  const q = summarizeQueue(openStore(deps.paths).stats(), view);
  const delivery = readDelivery(deps.paths);
  const rows: string[][] = [['SERVER', 'E-MAIL', 'DEPLOYMENT', 'LABEL', 'EXPIRES', 'REPOSITORIES', 'QUEUED', 'STATE']];
  for (const s of view.config.servers) {
    rows.push(
      [
        s.endpoint,
        s.email ?? (s.source ? '(service user)' : '?'),
        s.deployment?.name ?? '?',
        s.label ?? '–',
        s.expires_at ? s.expires_at.slice(0, 10) : s.source ? 'never' : '?',
        String(Object.keys(serverDelivery(delivery, s).repos).length),
        String(q.perServer[s.endpoint] ?? 0),
        serverState(view, deps, s, nowMs).short,
      ].map(terminalSafe),
    );
  }
  for (const line of table(rows)) io.out(line);
  return 0;
}

/** `token remove <server>` (URL or host): forgets the server's token. Its queued events stay on this machine. */
async function tokenRemove(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  const { positionals } = parseOptions(args, {}, true);
  if (positionals.length !== 1) throw new UsageError('token remove needs one server (its URL or host)');
  const arg = positionals[0]!;
  const config = loadConfig(deps.paths);
  if (!config) {
    io.err(NOT_CONFIGURED);
    return 1;
  }
  const entry = matchServer(config, arg);
  if (!entry) {
    io.err(`✗ no server ${arg}; registered: ${config.servers.map((s) => s.endpoint).join(', ') || 'none'}`);
    return 1;
  }
  const queued = summarizeQueue(openStore(deps.paths).stats(), loadRouting(deps.paths, nowOf(deps))).perServer[entry.endpoint] ?? 0;
  const locked = await withWriteLock(deps, io, () => {
    const fresh = loadConfig(deps.paths);
    if (!fresh || !fresh.servers.some((s) => s.endpoint === entry.endpoint)) return null;
    const next = removeServer(fresh, entry.endpoint);
    saveConfig(deps.paths, next);
    dropCache(deps.paths, entry.endpoint);
    dropServerDelivery(deps.paths, entry.endpoint);
    return next;
  });
  if (!locked) return 1;
  const next = locked.value;
  if (!next) {
    io.err(`✗ no server ${arg} any more. Nothing was changed.`);
    return 1;
  }
  io.out(`✓ token for ${entry.endpoint} (${endpointHost(entry.endpoint)}) removed from this machine (revoke it in the dashboard under "My tokens" if it may have leaked)`);
  if (queued) io.out(`! ${queued} queued events for ${entry.endpoint} stay on this machine; \`ai-obs login --server ${entry.endpoint}\` sends them`);
  if (!next.servers.length) io.out('! no servers left: nothing is recorded until you run `ai-obs login --server <url>`');
  else if (next.servers.length === 1) io.out(`  repositories without a .ai-obs.json server now report to ${next.servers[0]!.endpoint} (the only server)`);
  return 0;
}
