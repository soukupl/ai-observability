import { resolve } from 'node:path';
import { claudeDir } from '../adapters/claude-code/settings.js';
import { gitTopLevel } from '../git.js';
import { inScope, LiveMonitor, type LiveSession } from '../live/monitor.js';
import { renderFrame } from '../live/render.js';
import { nowOf, parseOptions, type CliDeps, type Io } from './common.js';

/** The terminal `ai-obs live` draws on (tests pass a fake one). */
export interface LiveTerminal {
  isTTY: boolean;
  columns(): number;
  /** terminal rows (default: no limit) */
  rows?(): number;
  write(s: string): void;
  /** Starts delivering key presses; the returned function stops it and restores the terminal input. */
  onKey(fn: (key: string) => void): () => void;
}

export const LIVE_REFRESH_MS = 1000;

const ENTER = '\x1b[?1049h\x1b[?25l';
const LEAVE = '\x1b[?25h\x1b[?1049l';
/** Output that is not a terminal (a pipe, a script) is not cut to 80 columns. */
const PIPE_WIDTH = 200;

function stdTerminal(): LiveTerminal {
  const out = process.stdout;
  const inp = process.stdin;
  return {
    isTTY: Boolean(out.isTTY && inp.isTTY),
    columns: () => out.columns || 80,
    rows: () => out.rows || 24,
    write: (s) => void out.write(s),
    onKey(fn) {
      const onData = (d: string | Buffer) => fn(String(d));
      try {
        inp.setRawMode?.(true);
        inp.setEncoding('utf8');
        inp.resume();
      } catch (err) {
        try {
          inp.setRawMode?.(false);
        } catch {
          /* not a usable terminal */
        }
        throw err;
      }
      inp.on('data', onData);
      return () => {
        inp.off('data', onData);
        inp.setRawMode?.(false);
        inp.pause();
      };
    },
  };
}

/**
 * `ai-obs live [--cwd] [--once]` (ADR-0027): the sessions running on this machine, redrawn in place about once a
 * second (q quits). Local only: no network, nothing written. `--cwd` narrows to the current repository; `--once`
 * (or a stdin / stdout that is not a terminal) prints one frame and exits.
 */
export async function liveCommand(
  args: readonly string[],
  io: Io,
  deps: CliDeps & { terminal?: LiveTerminal; claudeDir?: string; refreshMs?: number },
): Promise<number> {
  const { values } = parseOptions(args, { cwd: { type: 'boolean' }, once: { type: 'boolean' } });
  const cwd = deps.cwd ?? process.cwd();
  const scope = values.cwd ? ((await gitTopLevel(cwd, 2000)) ?? resolve(cwd)) : null;
  const terminal = deps.terminal ?? stdTerminal();
  const monitor = new LiveMonitor({ paths: deps.paths, claudeDir: deps.claudeDir ?? claudeDir(deps.env ?? process.env), now: () => nowOf(deps) });

  const frame = async (inPlace: boolean): Promise<string[]> => {
    const all = await monitor.refresh();
    const rows: LiveSession[] = scope ? all.filter((r) => inScope(r.cwd, scope)) : all;
    if (!inPlace) return renderFrame(rows, { now: nowOf(deps), width: terminal.isTTY ? terminal.columns() : PIPE_WIDTH, scope });
    // Redrawn in place: one column short (a full-width line followed by erase-to-end would lose its last character),
    // and no taller than the terminal (it would scroll the header away).
    const height = terminal.rows?.();
    return renderFrame(rows, { now: nowOf(deps), width: terminal.columns() - 1, scope, ...(height ? { rows: height } : {}) });
  };

  if (values.once || !terminal.isTTY) {
    io.out((await frame(false)).join('\n'));
    return 0;
  }

  terminal.write(ENTER);
  return new Promise<number>((done, fail) => {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let off = () => {};
    const detach = () => {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
      process.off('exit', onExit);
    };
    // the terminal is restored whatever happens: a key, a signal, a throw, or the process exiting under us
    const onExit = () => {
      if (!stopped) terminal.write(LEAVE);
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      try {
        off();
      } finally {
        detach();
        terminal.write(LEAVE);
        done(0);
      }
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    process.once('exit', onExit);
    try {
      off = terminal.onKey((key) => {
        if (key === 'q' || key === 'Q' || key === '\u0003') stop();
      });
    } catch (err) {
      stopped = true;
      detach();
      terminal.write(LEAVE);
      fail(err);
      return;
    }
    const tick = async () => {
      try {
        const lines = await frame(true);
        if (!stopped) terminal.write(`\x1b[H${lines.join('\x1b[K\r\n')}\x1b[J`);
      } catch {
        /* a failed read shows the previous frame; the next tick retries */
      }
      if (!stopped) timer = setTimeout(() => void tick(), deps.refreshMs ?? LIVE_REFRESH_MS);
    };
    void tick();
  });
}
