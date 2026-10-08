import { cacheInfo, dropCache, readCache, writeCache } from '../cc-cache.js';
import { findToken, identityMatches, loadConfig, maskToken, removeToken, saveConfig, tokenKind, type TokenEntry } from '../config.js';
import { clearBlocked, dropTokenDelivery, readDelivery, tokenDelivery } from '../delivery.js';
import { defaultSpawnWorker } from '../hook.js';
import { installRuntime } from '../runtime.js';
import { assignedKeys, effectiveCompany, loadRouting, routable, type RoutingView } from '../projects.js';
import { listSome, nowOf, openStore, parseOptions, summarizeQueue, table, UsageError, withWriteLock, type CliDeps, type Io } from './common.js';
import { endpointOf } from './init.js';
import { afterRegistration, effOf, probeRefusal, probeToken, registerToken } from './register.js';

const NOT_CONFIGURED = 'not configured — run `ai-obs init --token … --endpoint …`';

/** `ai-obs token add | list | confirm | remove` (design §2.4). */
export async function tokenCommand(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'add':
      return tokenAdd(rest, io, deps);
    case 'list':
      return tokenList(rest, io, deps);
    case 'confirm':
      return tokenConfirm(rest, io, deps);
    case 'remove':
      return tokenRemove(rest, io, deps);
    default:
      throw new UsageError(sub ? `unknown token command "${sub}" (add, list, confirm, remove)` : 'token needs a command: add, list, confirm or remove');
  }
}

/** `token add --token T [--endpoint U] [--name N]`: registration without hook changes (the runtime is refreshed, C25). */
async function tokenAdd(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  const { values } = parseOptions(args, { token: { type: 'string' }, endpoint: { type: 'string' }, name: { type: 'string' } });
  if (!values.token) throw new UsageError('--token is required (create one in the dashboard: My tokens or Settings → Tokens)');
  const existing = loadConfig(deps.paths);
  const ep = endpointOf(values.endpoint, deps, existing?.endpoint);
  const outcome = await registerToken(
    { token: values.token, ...ep, ...(values.name !== undefined ? { name: values.name } : {}) },
    io,
    { ...deps, refreshRuntime: () => void (deps.installRuntime ?? installRuntime)(deps.paths) },
  );
  if (!outcome.ok) return outcome.code;
  if (!existing) io.out('! hooks are not installed yet: run `ai-obs init`');
  await afterRegistration(outcome, io, deps);
  return 0;
}

/** STATE column / status line of a token (no network). */
export function tokenState(view: RoutingView, deps: CliDeps, t: TokenEntry, nowMs: number): { short: string; problem: boolean } {
  const st = tokenDelivery(readDelivery(deps.paths), t);
  const cache = view.caches[t.name];
  if (st.blocked?.status === 401) return { short: 'rejected (401): new token needed; `ai-obs flush` retries', problem: true };
  if (st.blocked?.status === 403) return { short: `suspended (${st.blocked.message || 'company is suspended'}); \`ai-obs flush\` retries`, problem: true };
  const r = routable(t, cache);
  if (r !== 'ok') {
    const says = cache?.company ? `server says "${cache.company.slug}"; ` : '';
    return { short: `unconfirmed: ${says}run \`ai-obs token confirm ${t.name}\``, problem: true };
  }
  if (st.next_attempt_at && Date.parse(st.next_attempt_at) > nowMs) return { short: `retrying (${st.last_error ?? 'send failed'})`, problem: true };
  if (!st.last_success_at) return { short: 'never sent', problem: false };
  return { short: 'ok', problem: false };
}

/** `token list` (no network). */
async function tokenList(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  parseOptions(args, {});
  const view = loadRouting(deps.paths);
  if (!view) {
    io.err(NOT_CONFIGURED);
    return 1;
  }
  if (!view.config.tokens.length) return 1; // the banner said it
  const q = summarizeQueue(openStore(deps.paths).stats(), view);
  const nowMs = nowOf(deps);
  const rows: string[][] = [['NAME', 'COMPANY', 'KIND', 'ACCOUNT', 'ENDPOINT', 'TOKEN', 'ADDED', 'PROJECTS', 'QUEUED', 'STATE']];
  for (const t of view.config.tokens) {
    const eff = effectiveCompany(t, view.caches[t.name]);
    rows.push([
      t.name,
      eff?.name ?? '(unconfirmed)',
      tokenKind(t.token) ?? '?',
      t.email ?? '–',
      t.endpoint,
      maskToken(t.token),
      t.added_at.slice(0, 10),
      view.projects.status === 'ok' ? String(assignedKeys(view, t).length) : '?',
      String(q.perToken[t.name] ?? 0),
      tokenState(view, deps, t, nowMs).short,
    ]);
  }
  for (const line of table(rows)) io.out(line);
  if (view.config.invalidTokens.length) io.out(`! ${view.config.invalidTokens.length} malformed entries in config.json: \`ai-obs token remove --invalid\``);
  return 0;
}

/** `token confirm <name>`: checks an unverified token's company and starts sending with it. */
async function tokenConfirm(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  const { positionals } = parseOptions(args, {}, true);
  if (positionals.length !== 1) throw new UsageError('token confirm needs one token name');
  const name = positionals[0]!;
  const config = loadConfig(deps.paths);
  if (!config) {
    io.err(NOT_CONFIGURED);
    return 1;
  }
  const entry = findToken(config, name);
  if (!entry) {
    io.err(`✗ no token named ${name}; registered: ${config.tokens.map((t) => t.name).join(', ') || 'none'}`);
    return 1;
  }
  const cached = cacheInfo(readCache(deps.paths, entry));
  if (entry.company && (!cached.company || cached.company.slug === entry.company.slug) && cached.fetched) {
    io.out(`✓ ${name} is ${entry.company.name} (${entry.company.slug}), nothing to confirm`);
    return 0;
  }
  const check = await probeToken(deps, entry.endpoint, entry.token);
  const refusal = probeRefusal(entry.endpoint, entry.token, check);
  if (refusal) {
    io.err(refusal);
    return 1;
  }
  if (!check.tokenValid || !check.value) {
    io.err(`! cannot reach ${entry.endpoint} (${check.error ?? `HTTP ${check.status}`}): try again when it is reachable. Nothing was changed.`);
    return 1;
  }
  const value = check.value;
  const company = value.company ?? { name, slug: name };
  const other = config.tokens.find((t) => t.name !== name && t.endpoint === entry.endpoint && effOf(deps.paths, t)?.slug === company.slug);
  if (other) {
    io.err(`✗ ${other.name} is already ${company.slug} at ${entry.endpoint}: \`ai-obs token remove\` one of them first. Nothing was changed.`);
    return 1;
  }
  const locked = await withWriteLock(deps, io, () => {
    const now = new Date(nowOf(deps));
    const fresh = loadConfig(deps.paths);
    const i = fresh ? fresh.tokens.findIndex((t) => t.name === name && t.token === entry.token && t.endpoint === entry.endpoint) : -1;
    if (!fresh || i < 0) return false;
    const { provisional_name: _p, ...rest } = fresh.tokens[i]!;
    const email = value.user?.email;
    const next: TokenEntry = { ...rest, company, ...(email ? { email } : {}) };
    fresh.tokens[i] = next;
    saveConfig(deps.paths, fresh, now);
    writeCache(deps.paths, next, { fetched_at: now.toISOString(), value, failed_at: undefined });
    clearBlocked(deps.paths, next);
    return true;
  });
  if (!locked) return 1;
  if (!locked.value) {
    io.err(`✗ token ${name} changed while confirming it; run the command again. Nothing was changed.`);
    return 1;
  }
  const view = loadRouting(deps.paths);
  const queued = view ? (summarizeQueue(openStore(deps.paths).stats(), view).perToken[name] ?? 0) : 0;
  io.out(
    value.company
      ? `✓ ${name} confirmed: ${company.name} (${company.slug}); ${queued} queued events will be sent`
      : `✓ ${name} confirmed by you (the server does not report its company); ${queued} queued events will be sent`,
  );
  (deps.spawnWorker ?? defaultSpawnWorker)(deps.paths);
  return 0;
}

/** `token remove <name>` | `token remove --invalid`. Queue and projects.json are left as they are (C18, C23). */
async function tokenRemove(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  const { values, positionals } = parseOptions(args, { invalid: { type: 'boolean', default: false } }, true);
  if (values.invalid ? positionals.length !== 0 : positionals.length !== 1) throw new UsageError('token remove needs one token name, or --invalid');
  const before = loadRouting(deps.paths);
  if (!before) {
    io.err(NOT_CONFIGURED);
    return 1;
  }

  if (values.invalid) {
    const locked = await withWriteLock(deps, io, () => {
      const config = loadConfig(deps.paths);
      if (!config || !config.invalidTokens.length) return [] as unknown[];
      const removed = config.invalidTokens;
      saveConfig(deps.paths, { ...config, invalidTokens: [] }, new Date(nowOf(deps)));
      return removed;
    });
    if (!locked) return 1;
    if (!locked.value.length) {
      io.out('no malformed token entries in config.json');
      return 0;
    }
    for (const raw of locked.value) io.out(`✓ removed malformed entry ${describeRaw(raw)}`);
    io.out('  events recorded while config.json had malformed entries keep waiting for a choice (`ai-obs use <name>` in each repository)');
    return 0;
  }

  const name = positionals[0]!;
  const entry = findToken(before.config, name);
  if (!entry) {
    io.err(`✗ no token named ${name}; registered: ${before.config.tokens.map((t) => t.name).join(', ') || 'none'}`);
    return 1;
  }
  const eff = effectiveCompany(entry, before.caches[name]);
  const keys = assignedKeys(before, entry);
  const locked = await withWriteLock(deps, io, () => {
    const config = loadConfig(deps.paths);
    if (!config || !findToken(config, name)) return null;
    const next = removeToken(config, name);
    saveConfig(deps.paths, next, new Date(nowOf(deps)));
    dropCache(deps.paths, name);
    dropTokenDelivery(deps.paths, name);
    return next;
  });
  if (!locked) return 1;
  const next = locked.value;
  if (!next) {
    io.err(`✗ no token named ${name} any more. Nothing was changed.`);
    return 1;
  }
  let bound = 0;
  for (const st of openStore(deps.paths).stats().streams) {
    const b = st.stream.bind;
    if (b?.kind === 'token' && identityMatches(b.id, entry, eff)) bound += st.events;
  }
  const company = eff?.name ?? name;
  io.out(`✓ token ${name} (${company}) removed`);
  if (bound) {
    io.out(
      `! ${bound} queued events recorded with ${name} stay on this machine. Registering a new ${company} token (\`ai-obs token add\`) sends them to ${company}; \`ai-obs use <other> --move-queued\` in a repository sends that repository's events to <other> instead`,
    );
  }
  if (keys.length) io.out(`! ${keys.length} repositories were assigned to ${name}: their next sessions ask again (\`ai-obs use <other>\` in each): ${listSome(keys, 10)}`);
  if (next.tokens.length === 1) {
    io.out(`  events recorded while several tokens were registered keep waiting for a choice; new sessions report to ${next.tokens[0]!.name} (the only token)`);
  } else if (!next.tokens.length) {
    io.out('! no tokens left: nothing is recorded until you run `ai-obs init --token …`');
  }
  return 0;
}

function describeRaw(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) return '(unreadable entry)';
  const r = raw as { name?: unknown; token?: unknown };
  const name = typeof r.name === 'string' ? r.name.replace(/[^\x20-\x7e]/g, '?').slice(0, 63) : '?';
  const token = typeof r.token === 'string' ? maskToken(r.token) : 'no token';
  return `${name} (${token})`;
}
