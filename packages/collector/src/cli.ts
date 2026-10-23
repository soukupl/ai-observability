/**
 * ai-obs CLI entry. ZERO runtime dependencies: only node: built-ins may be imported here and in
 * anything this file imports. Command modules are imported lazily so the `hook` fast path loads as
 * little code as possible (< 100 ms budget).
 */
import { aiObsPaths, resolveHome } from './paths.js';
import type { CliDeps, Io } from './commands/common.js';

export type { CliDeps, Io } from './commands/common.js';

export const COMMANDS = ['init', 'token', 'use', 'doctor', 'status', 'flush', 'uninstall', 'live', 'hook'] as const;
export type Command = (typeof COMMANDS)[number];

const defaultIo: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

export const USAGE = `Usage: ai-obs <command> [options]

Commands:
  init [--token <token>] [--endpoint <url>] [--name <name>] [--project] [--project-dir <dir>] [--harness claude-code,codex] [--git-email <email>]
                                     register a token and configure every detected harness (user-level hooks; --project: repo-level)
  token add --token <token> [--endpoint <url>] [--name <name>]
                                     register another company's token (no hook changes)
  token list                         registered tokens and their projects
  token confirm <name>               check an unconfirmed token's company and start sending with it
  token remove <name>                forget a token (events queued for it stay on this machine)
  token remove --invalid             delete malformed token entries from config.json
  use <name> [--project-dir <dir>]   send this repository's data with token <name>
  use <name> --move-queued [--project-dir <dir>]
                                     also send events queued for this repository's previous token with <name>
  use <name> --all-held              assign every repository that is waiting for a token
  use --none [--project-dir <dir>]   stop reporting this repository; its queued events are kept, not sent
  use --none --discard-queued [--project-dir <dir>]
                                     also delete its queued events
  use --clear [--project-dir <dir>]  remove this repository's choice
  use --reset-projects               set an unreadable projects.json aside and start an empty one
  doctor                             check config, tokens, server, project, harnesses, hooks and queue
  status                             show tokens, this project's token, queue and last delivery
  live [--cwd] [--once]              watch this machine's running sessions: status, elapsed, tokens, ≈ cost (local only; q quits)
  flush [--wait <seconds>]           send queued events now (also retries a rejected token)
  uninstall [--purge [--yes]] [--project-dir <dir>]
                                     remove hooks (--purge: also delete ~/.ai-obs: tokens, assignments, queue)
  hook <harness> <hook>              (internal) called by harness hooks; always exits 0

Global options:
  --home <dir>                       collector home (default ~/.ai-obs, or $AI_OBS_HOME)

Environment:
  AI_OBS_HOME, AI_OBS_ENDPOINT (default --endpoint for init / token add), AI_OBS_SUMMARIZING (internal guard)`;

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
  const { UsageError, upgradeBanner } = await import('./commands/common.js');
  try {
    // C6: while nothing can be recorded, say so first (init / token add say it only when they register nothing).
    if (command !== 'init' && !(command === 'token' && args[0] === 'add')) {
      const { loadConfig } = await import('./config.js');
      const banner = upgradeBanner(loadConfig(paths));
      if (banner) io.err(banner);
    }
    switch (command) {
      case 'init':
        return await (await import('./commands/init.js')).initCommand(args, io, full);
      case 'token':
        return await (await import('./commands/token.js')).tokenCommand(args, io, full);
      case 'use':
        return await (await import('./commands/use.js')).useCommand(args, io, full);
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
