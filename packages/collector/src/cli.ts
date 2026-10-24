/**
 * ai-obs CLI entry. ZERO runtime dependencies: only node: built-ins may be imported here and in
 * anything this file imports. Command modules are imported lazily so the `hook` fast path loads as
 * little code as possible (< 100 ms budget).
 */
import { aiObsPaths, resolveHome } from './paths.js';
import type { CliDeps, Io } from './commands/common.js';

export type { CliDeps, Io } from './commands/common.js';

export const COMMANDS = ['init', 'login', 'link', 'token', 'doctor', 'status', 'flush', 'uninstall', 'live', 'hook'] as const;
export type Command = (typeof COMMANDS)[number];

const defaultIo: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

export const USAGE = `Usage: ai-obs <command> [options]

Commands:
  login [--server <url>] [--token <token>|-] [--no-browser] [--label <name>] [--keep-queue]
                                     log this machine in to an ai-obs server: approve a code in the browser,
                                     or paste a token (- reads it from stdin). One token per server; queued
                                     events of another account are set aside (--keep-queue: sent as you)
  init [--project] [--project-dir <dir>] [--harness claude-code,codex] [--token <token> --endpoint <url> [--label <name>]]
                                     install the harness hooks (user level; --project: this repository);
                                     with --token: log in without a browser first
  link --team <slug> [--server <url>] [--local] [--project-dir <dir>]
                                     write .ai-obs.json at the repository root (--local: .ai-obs.local.json,
                                     git-ignored): the server and team this repository reports to
  token list                         servers, accounts, token expiry and state
  token remove <server>              forget a server's token (its queued events stay on this machine)
  doctor                             check servers, tokens, this repository, harnesses, hooks and queue
  status                             show servers, this repository's server and team, queue and last send
  live [--cwd] [--once]              watch this machine's running sessions: status, elapsed, tokens, ≈ cost (local only; q quits)
  flush [--wait <seconds>]           send queued events now (also retries a refused token)
  uninstall [--purge [--yes]] [--project-dir <dir>]
                                     remove hooks (--purge: also delete ~/.ai-obs: tokens and queue)
  hook <harness> <hook>              (internal) called by harness hooks; always exits 0

Global options:
  --home <dir>                       collector home (default ~/.ai-obs, or $AI_OBS_HOME)

Environment:
  AI_OBS_HOME, AI_OBS_ENDPOINT (default --server for login / init --token), AI_OBS_SUMMARIZING (internal guard)`;

const isCommand = (s: string | undefined): s is Command => COMMANDS.includes(s as Command);

/** Removes `--home <dir>` / `--home=<dir>` from argv. */
export function extractHome(argv: readonly string[]): { home: string | undefined; rest: string[] } {
  const rest: string[] = [];
  let home: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--home') home = argv[++i];
    else if (a.startsWith('--home=')) home = a.slice(7);
    else rest.push(a);
  }
  return { home, rest };
}

/** Dispatches a subcommand and resolves to the process exit code. */
export async function main(argv: string[], io: Io = defaultIo, deps: Partial<CliDeps> = {}): Promise<number> {
  if (process.env.AI_OBS_SUMMARIZING) return 0; // recursion guard, see bin/ai-obs.js
  const { home, rest } = extractHome(argv);
  const [command, ...args] = rest;
  const paths = deps.paths ?? aiObsPaths(resolveHome(home));
  if (home) process.env.AI_OBS_HOME = paths.root; // children (worker) inherit it

  if (command === 'hook') {
    // Fast path: no other command modules, never fails the harness.
    const { runHook } = await import('./hook.js');
    return runHook(args, { paths, ...(deps.env ? { env: deps.env } : {}) });
  }
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    io.out(USAGE);
    return command ? 0 : 1;
  }
  if (command === '--version' || command === '-v') {
    const { COLLECTOR_VERSION } = await import('./version.js');
    io.out(COLLECTOR_VERSION);
    return 0;
  }
  if (!isCommand(command)) {
    io.err(`ai-obs: unknown command "${command}"\n\n${USAGE}`);
    return 2;
  }
  const full: CliDeps = { ...deps, paths };
  const { UsageError, upgradeBanner, migrateNow } = await import('./commands/common.js');
  try {
    // A 0.2 – 0.4 home is migrated by the first command that finds the worker lock free (else by the worker),
    // together with the copied hook runtime (an older one would drop every hook job on the new config).
    if (command !== 'live' && command !== 'uninstall') migrateNow(full, io);
    // C6: while nothing can be recorded, say so first (init and login say it themselves).
    if (command !== 'init' && command !== 'login' && command !== 'live') {
      const { loadConfig } = await import('./config.js');
      const banner = upgradeBanner(loadConfig(paths));
      if (banner) io.err(banner);
    }
    switch (command) {
      case 'init':
        return await (await import('./commands/init.js')).initCommand(args, io, full);
      case 'login':
        return await (await import('./commands/login.js')).loginCommand(args, io, full);
      case 'link':
        return await (await import('./commands/link.js')).linkCommand(args, io, full);
      case 'token':
        return await (await import('./commands/token.js')).tokenCommand(args, io, full);
      case 'doctor':
        return await (await import('./commands/doctor.js')).doctorCommand(args, io, full);
      case 'status':
        return await (await import('./commands/status.js')).statusCommand(args, io, full);
      case 'flush':
        return await (await import('./commands/flush.js')).flushCommand(args, io, full);
      case 'uninstall':
        return await (await import('./commands/uninstall.js')).uninstallCommand(args, io, full);
      case 'live':
        return await (await import('./commands/live.js')).liveCommand(args, io, full);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`ai-obs ${command}: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    io.err(`ai-obs ${command}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  return 2;
}
