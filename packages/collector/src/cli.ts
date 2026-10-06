/**
 * ai-obs CLI entry. ZERO runtime dependencies: only node: built-ins may be imported here and in
 * anything this file imports. Command modules are imported lazily so the `hook` fast path loads as
 * little code as possible (< 100 ms budget).
 */
import { aiObsPaths, resolveHome } from './paths.js';
import type { CliDeps, Io } from './commands/common.js';

export type { CliDeps, Io } from './commands/common.js';

export const COMMANDS = ['init', 'doctor', 'status', 'flush', 'uninstall', 'hook'] as const;
export type Command = (typeof COMMANDS)[number];

const defaultIo: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

export const USAGE = `Usage: ai-obs <command> [options]

Commands:
  init --token <token> --endpoint <url> [--project] [--project-dir <dir>] [--harness claude-code,codex] [--git-email <email>]
                                     configure every detected harness (user-level hooks; --project: repo-level)
  doctor                             check config, server, token, harnesses, hooks and queue
  status                             show queue and last delivery
  flush [--wait <seconds>]           send queued events now
  uninstall [--purge] [--project-dir <dir>]
                                     remove hooks (--purge: also delete ~/.ai-obs)
  hook <harness> <hook>              (internal) called by harness hooks; always exits 0

Global options:
  --home <dir>                       collector home (default ~/.ai-obs, or $AI_OBS_HOME)

Environment:
  AI_OBS_HOME, AI_OBS_ENDPOINT (overrides the configured endpoint), AI_OBS_SUMMARIZING (internal guard)`;

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
  const { UsageError } = await import('./commands/common.js');
  try {
    switch (command) {
      case 'init':
        return await (await import('./commands/init.js')).initCommand(args, io, full);
      case 'doctor':
        return await (await import('./commands/doctor.js')).doctorCommand(args, io, full);
      case 'status':
        return await (await import('./commands/status.js')).statusCommand(args, io, full);
      case 'flush':
        return await (await import('./commands/flush.js')).flushCommand(args, io, full);
      case 'uninstall':
        return await (await import('./commands/uninstall.js')).uninstallCommand(args, io, full);
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
