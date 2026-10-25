import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findServer, loadConfig, tryNormalizeEndpoint } from '../config.js';
import { DOT_FILE, LOCAL_DOT_FILE, lookupDotFile, parseDotFile } from '../dotfile.js';
import { errorMessage, writeFileAtomic } from '../fsutil.js';
import { gitTopLevel } from '../git.js';
import { defaultSpawnWorker } from '../hook.js';
import { resolveProjectKey, RESOLVE_TIMEOUT_MS } from '../project-key.js';
import { openStore, parseOptions, UsageError, withWriteLock, type CliDeps, type Io } from './common.js';

export const LINK_OPTIONS = {
  server: { type: 'string' },
  local: { type: 'boolean', default: false },
  'project-dir': { type: 'string' },
} as const;

const looksLikeToken = (v: string) => /aiobs_[a-z]_/i.test(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Adds `name` to `<dir>/.gitignore` unless a line already ignores it. Returns true when it appended. */
export function ensureGitignored(dir: string, name: string): boolean {
  const file = join(dir, '.gitignore');
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(name) || lines.includes(`/${name}`)) return false;
  appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${name}\n`, { mode: 0o644 });
  return true;
}

/**
 * `ai-obs link [--server URL] [--local] [--project-dir <dir>]`: writes the repository's dot file at its git top
 * level (`.ai-obs.json`, to commit; with --local `.ai-obs.local.json`, git-ignored), naming the server its
 * sessions report to. The team is not chosen here: an admin maps projects to teams on the server (ADR-0035), and
 * a leftover `team` key is removed. Never writes a token. Events of this repository recorded while no server was
 * chosen move to the linked server.
 */
export async function linkCommand(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  if (args.some((a) => a === '--team' || a.startsWith('--team='))) {
    throw new UsageError('--team is gone: an admin assigns projects to teams on the server (dashboard → Admin → Projects)');
  }
  const { values } = parseOptions(args, LINK_OPTIONS);
  if (values.server && looksLikeToken(values.server)) {
    io.err('✗ that looks like a token: tokens never go into a dot file (they stay in ~/.ai-obs/config.json). Nothing was written.');
    return 2;
  }
  const cwd = deps.cwd ?? process.cwd();
  // the dot file lives at the git top level, also when --project-dir names a subdirectory (the nudge passes the session's cwd)
  const given = values['project-dir'] ? resolve(values['project-dir']) : null;
  const dir = given ? ((await gitTopLevel(given)) ?? given) : await gitTopLevel(cwd);
  if (!dir) {
    io.err('✗ not inside a git repository: run it in the repository, or pass --project-dir <its root>. Nothing was written.');
    return 1;
  }

  // the server: --server, else the one the repository's dot file names, else the only registered one
  const config = loadConfig(deps.paths);
  const current = lookupDotFile(dir);
  let server: string | null;
  if (values.server) {
    server = tryNormalizeEndpoint(values.server);
    if (!server) throw new UsageError(`--server must be an http(s) URL: ${values.server}`);
  } else {
    server = current.server ?? (config?.servers.length === 1 ? config.servers[0]!.endpoint : null);
    if (!server) {
      throw new UsageError(
        config?.servers.length
          ? `--server is required: ${config.servers.length} servers are registered (${config.servers.map((s) => s.endpoint).join(', ')})`
          : '--server is required (no server is registered yet: run `ai-obs login --server <url>` first)',
      );
    }
  }

  if (!(config && findServer(config, server))) {
    io.out(`! this machine is not logged in to ${server}: data waits on this machine until you run \`ai-obs login --server ${server}\``);
  }

  // write the file, keeping unknown keys of an existing one; never a token
  const file = join(dir, values.local ? LOCAL_DOT_FILE : DOT_FILE);
  let obj: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (isObject(raw)) obj = raw;
      else io.out(`! ${file} was not a JSON object: replaced`);
    } catch {
      io.out(`! ${file} was not valid JSON: replaced`);
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'token' || (typeof v === 'string' && looksLikeToken(v))) {
      delete obj[k];
      io.out(`! removed "${k}" from ${file}: tokens never go into a dot file`);
    }
  }
  if ('team' in obj) {
    delete obj.team;
    io.out(`! removed "team" from ${file}: an admin assigns projects to teams on the server`);
  }
  obj = { ...obj, server };
  const text = `${JSON.stringify(obj, null, 2)}\n`;
  if (!parseDotFile(text).ok || looksLikeToken(text)) {
    io.err(`✗ refusing to write ${file}. Nothing was written.`);
    return 1;
  }
  try {
    writeFileAtomic(file, text, 0o644);
  } catch (err) {
    io.err(`✗ cannot write ${file}: ${errorMessage(err)}`);
    return 1;
  }
  io.out(`✓ wrote ${file}: server ${server}`);
  if (values.local) {
    try {
      if (ensureGitignored(dir, LOCAL_DOT_FILE)) io.out(`✓ added ${LOCAL_DOT_FILE} to ${join(dir, '.gitignore')}`);
    } catch (err) {
      io.out(`! could not add ${LOCAL_DOT_FILE} to .gitignore (${errorMessage(err)}): keep it out of git yourself`);
    }
  } else {
    io.out(`  commit ${DOT_FILE} so everyone's sessions in this repository report to this server`);
  }
  const after = lookupDotFile(dir);
  if (after.root && after.server !== server) {
    io.out(`! ${LOCAL_DOT_FILE} overrides it here: sessions report to ${after.server ?? '(no server)'}`);
  }
  io.out('  sessions that are already running keep the server they started with');
  io.out('  the team is set on the server: an admin maps this project to a team, else your primary team is used');

  // events recorded while no server was chosen follow the link
  if (!config?.servers.length || !after.server) return 0;
  const pk = await (deps.resolveProjectKey ?? ((c: string, o: { timeoutMs: number }) => resolveProjectKey(c, o)))(dir, { timeoutMs: RESOLVE_TIMEOUT_MS });
  if (pk === null) return 0;
  const target = { endpoint: after.server, team: '' };
  const locked = await withWriteLock(deps, io, () => openStore(deps.paths).retarget(pk, target));
  if (locked?.value) {
    io.out(`✓ ${locked.value} queued events of this repository recorded without a server now go to ${after.server}`);
    (deps.spawnWorker ?? defaultSpawnWorker)(deps.paths);
  }
  return 0;
}
