import { resolve as resolvePath } from 'node:path';
import { findToken, identityMatches, identityOf, loadConfig, type TokenEntry } from '../config.js';
import { defaultSpawnWorker } from '../hook.js';
import { rememberPk } from '../pk-cache.js';
import { isPathKey, resolveProjectKey, RESOLVE_TIMEOUT_MS } from '../project-key.js';
import {
  assignmentFor,
  assignmentIdentity,
  captureBinding,
  effectiveCompany,
  entryFor,
  isExplicit,
  loadProjects,
  loadRouting,
  resetProjects,
  resolveStream,
  routable,
  saveProjects,
  type Assignment,
  type Binding,
  type RoutingView,
} from '../projects.js';
import { identityOfRef } from '../queue.js';
import { nowOf, openStore, parseOptions, UsageError, withWriteLock, type CliDeps, type Io } from './common.js';

const USE_OPTIONS = {
  'project-dir': { type: 'string' },
  clear: { type: 'boolean', default: false },
  none: { type: 'boolean', default: false },
  'all-held': { type: 'boolean', default: false },
  'move-queued': { type: 'boolean', default: false },
  'discard-queued': { type: 'boolean', default: false },
  'reset-projects': { type: 'boolean', default: false },
} as const;

const NOT_CONFIGURED = 'not configured — run `ai-obs init --token … --endpoint …`';

/** Events of the key's streams: open, bound to `id` of `entry`, bound elsewhere (by binding name). */
function keyStreams(deps: CliDeps, view: RoutingView, pk: string, entry?: TokenEntry) {
  const out = { open: 0, all: 0, same: 0, other: new Map<string, number>() };
  const eff = entry ? effectiveCompany(entry, view.caches[entry.name]) : undefined;
  for (const st of openStore(deps.paths).stats().streams) {
    const ref = st.stream;
    if (ref.kind !== 'project' || ref.pk !== pk || !ref.bind) continue;
    out.all += st.events;
    if (ref.bind.kind === 'open') out.open += st.events;
    else if (entry && identityMatches(ref.bind.id, entry, eff)) out.same += st.events;
    else out.other.set(ref.bind.name, (out.other.get(ref.bind.name) ?? 0) + st.events);
  }
  return out;
}

/**
 * `ai-obs use <name> | --clear | --none | --all-held | --reset-projects` (design §2.5): the per-repository
 * token choice in projects.json. Only this command writes that file (C23).
 */
export async function useCommand(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  const { values, positionals } = parseOptions(args, USE_OPTIONS, true);
  if (positionals.length > 1) throw new UsageError('use takes one token name');
  const name = positionals[0];
  const { clear, none } = values;
  const allHeld = values['all-held'];
  const move = values['move-queued'];
  const discard = values['discard-queued'];
  const reset = values['reset-projects'];
  if (reset && (name !== undefined || clear || none || allHeld || move || discard || values['project-dir'] !== undefined)) {
    throw new UsageError('--reset-projects takes no other option');
  }
  if ((clear || none) && name !== undefined) throw new UsageError('--clear / --none take no token name');
  if (clear && none) throw new UsageError('use either --clear or --none');
  if (!reset && name === undefined && !clear && !none) throw new UsageError('use needs a token name, --clear, --none or --reset-projects');
  if (allHeld && (values['project-dir'] !== undefined || move)) throw new UsageError('--all-held takes no --project-dir or --move-queued');
  if (discard && !none) throw new UsageError('--discard-queued needs --none');
  if (move && name === undefined) throw new UsageError('--move-queued needs a token name');
  const now = new Date(nowOf(deps));

  if (reset) {
    const p = loadProjects(deps.paths);
    if (p.status === 'ok') {
      io.out('projects.json is fine; nothing to reset');
      return 0;
    }
    const aside = resetProjects(deps.paths, now);
    io.out(
      `✓ moved the unreadable file to ${aside} and started an empty projects.json. Repositories wait for a choice again (with one token they report to it); \`--none\` choices in the old file are no longer applied: run \`ai-obs use --none\` again where needed.`,
    );
    return 0;
  }

  const config = loadConfig(deps.paths);
  if (!config) {
    io.err(NOT_CONFIGURED);
    return 1;
  }
  const projects = loadProjects(deps.paths);
  if (projects.status !== 'ok') {
    io.err(
      `✗ ${deps.paths.projects} cannot be read (${projects.error}). Repair it, or run \`ai-obs use --reset-projects\` to set it aside and start an empty one. Nothing was changed.`,
    );
    return 1;
  }
  if (!config.tokens.length && !none && !clear) return 1; // the banner said it
  let token: TokenEntry | undefined;
  if (name !== undefined) {
    token = findToken(config, name);
    if (!token) throw new UsageError(`no token named ${name}; registered: ${config.tokens.map((t) => t.name).join(', ')}`);
  }
  const view0 = loadRouting(deps.paths);
  if (!view0) {
    io.err(NOT_CONFIGURED);
    return 1;
  }
  if (token && routable(token, view0.caches[token.name]) !== 'ok') {
    io.err(`✗ token ${token.name} is not confirmed: run \`ai-obs token confirm ${token.name}\` first. Nothing was changed.`);
    return 1;
  }
  const spawn = () => (deps.spawnWorker ?? defaultSpawnWorker)(deps.paths);

  if (allHeld) return useAllHeld(token!, view0, io, deps, now, spawn);

  // The repository's key (Q4): normalized remote, else the top-level path, else the directory.
  const dir = resolvePath(values['project-dir'] ?? deps.cwd ?? process.cwd());
  const resolveKey = deps.resolveProjectKey ?? ((cwd: string, o: { timeoutMs: number }) => resolveProjectKey(cwd, o));
  const key = await resolveKey(dir, { timeoutMs: RESOLVE_TIMEOUT_MS });
  if (key === null) {
    io.err('✗ git did not answer in time; try again. Nothing was changed.');
    return 1;
  }
  rememberPk(deps.paths, dir, key, now.getTime());
  if (isPathKey(key)) io.out(`(no git remote: assigned by its path ${key})`);
  const previous = Object.prototype.hasOwnProperty.call(projects.entries, key) ? projects.entries[key] : undefined;

  if (clear) {
    if (!previous) {
      io.out(`${key} had no choice`);
      return 0;
    }
    const entries = loadProjectsOk(deps); // re-read: another `use` may have written since (no lost update)
    delete entries[key];
    saveProjects(deps.paths, entries);
    io.out(`✓ ${key}: choice removed`);
    const view = loadRouting(deps.paths);
    const d = view ? captureBinding(view, key, now.getTime()) : null;
    io.out(d?.kind === 'bind' && d.bind.kind === 'token' ? `→ new sessions use ${d.bind.name} (the only token)` : '→ new sessions wait for a token');
    spawn();
    return 0;
  }

  if (none) {
    const optOut: Assignment = { token: null, none: true, assigned_at: now.toISOString() };
    // re-read right before the write: another `use` may have written since this command started
    const save = () => saveProjects(deps.paths, { ...loadProjectsOk(deps), [key]: optOut });
    if (discard) {
      const locked = await withWriteLock(deps, io, () => {
        save();
        return openStore(deps.paths).dropKey(key);
      });
      if (!locked) return 1;
      io.out(`✓ ${key} will not be reported; new sessions are not recorded`);
      io.out(`deleted ${locked.value} queued events of ${key}`);
      return 0;
    }
    save();
    const kept = keyStreams(deps, view0, key).all;
    io.out(
      `✓ ${key} will not be reported; new sessions are not recorded. ${kept} queued events of it are kept on this machine and not sent (\`ai-obs use <name>\` or \`ai-obs use --clear\` sends them again, \`--discard-queued\` deletes them)`,
    );
    return 0;
  }

  const t = token!;
  const eff = effectiveCompany(t, view0.caches[t.name]);
  const assign = () => saveProjects(deps.paths, { ...loadProjectsOk(deps), [key]: assignmentFor(t, eff, now) });
  if (move) {
    const to: Binding = { kind: 'token', id: identityOf(t, eff), name: t.name };
    const before = keyStreams(deps, view0, key, t);
    const locked = await withWriteLock(deps, io, () => {
      const moving = [...before.other.keys()];
      const total = [...before.other.values()].reduce((a, b) => a + b, 0);
      if (total) io.out(`moving ${total} queued events of ${key} from ${moving.join(', ')} to ${t.name}`);
      const moved = openStore(deps.paths).rebind(key, to);
      assign();
      return moved;
    });
    if (!locked) return 1;
    io.out(`✓ ${key} → ${t.name} (${eff?.name ?? t.name}); ${locked.value} queued events moved`);
  } else {
    assign();
    io.out(`✓ ${key} → ${t.name} (${eff?.name ?? t.name})`);
  }
  const after = keyStreams(deps, view0, key, t);
  if (after.open) io.out(`→ ${after.open} waiting events will be sent to ${t.name} (background); check with \`ai-obs status\``);
  for (const [old, n] of after.other) {
    io.out(`  ${n} events recorded while this repository used ${old} stay with ${old}; \`ai-obs use ${t.name} --move-queued\` sends them to ${t.name} instead`);
  }
  if (isExplicit(previous)) {
    const was = entryFor(view0, assignmentIdentity(previous));
    if (!was || was.name !== t.name) {
      io.out(`  sessions already running here keep reporting to ${previous.token} until they end; events already sent stay with ${previous.token}`);
    }
  }
  if (view0.blocked[t.name]) {
    io.out(`! ${t.name} is currently refused by its server (HTTP ${view0.blocked[t.name]!.status}); its events wait until it works again (\`ai-obs flush\` retries)`);
  }
  spawn();
  return 0;
}

/** projects.json entries re-read right before a write (it is readable: checked at the start). */
function loadProjectsOk(deps: CliDeps): Record<string, Assignment> {
  const p = loadProjects(deps.paths);
  if (p.status !== 'ok') throw new Error(`${deps.paths.projects} cannot be read (${p.error}); nothing was changed`);
  return { ...p.entries };
}

/** `use <name> --all-held` (C20): every repository whose open data waits for a choice gets `<name>`. */
function useAllHeld(t: TokenEntry, view: RoutingView, io: Io, deps: CliDeps, now: Date, spawn: () => void): number {
  const keys: string[] = [];
  let events = 0;
  for (const st of openStore(deps.paths).stats().streams) {
    const ref = st.stream;
    if (ref.kind !== 'project' || ref.pk === undefined || ref.bind?.kind !== 'open') continue;
    const r = resolveStream(view, identityOfRef(ref));
    if (r.kind !== 'held' || (r.reason !== 'unassigned' && r.reason !== 'dangling')) continue;
    if (!keys.includes(ref.pk)) keys.push(ref.pk);
    events += st.events;
  }
  if (!keys.length) {
    io.out('no repository is waiting for a token');
    return 0;
  }
  const eff = effectiveCompany(t, view.caches[t.name]);
  const entries = loadProjectsOk(deps);
  for (const k of keys) entries[k] = assignmentFor(t, eff, now);
  saveProjects(deps.paths, entries);
  io.out(`✓ ${keys.length} repositories → ${t.name} (${eff?.name ?? t.name}); ${events} waiting events will be sent (background)`);
  for (const k of keys.slice(0, 20)) io.out(`  ${k}`);
  if (keys.length > 20) io.out(`  … and ${keys.length - 20} more`);
  spawn();
  return 0;
}

