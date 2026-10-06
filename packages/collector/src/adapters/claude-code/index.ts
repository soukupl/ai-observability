import { tmpdir } from 'node:os';
import { summarizeWithCommand } from '../../analysis/summaries.js';
import type { HarnessAdapter } from '../types.js';
import { detectClaudeCode, probeClaudeVersion, type VersionProbe } from './detect.js';
import { handleHook, sweepCrashedSessions } from './handlers.js';
import { claudeDir as defaultClaudeDir, installHooksAt, ourCommandsAt, settingsPath, uninstallHooksAt } from './settings.js';

/**
 * Claude Code adapter. Hooks: SessionStart, UserPromptSubmit, Stop, StopFailure, SubagentStop,
 * SessionEnd (settings.json). Numbers come from the session transcript JSONL and the sub-agent
 * transcripts next to it; see FORMAT.md for the fields used and README.md for the rules.
 */
export interface ClaudeCodeAdapterOptions {
  /** ~/.claude (default: $CLAUDE_CONFIG_DIR or ~/.claude) */
  claudeDir?: string;
  /** version probe (default: `claude --version`) */
  probe?: VersionProbe;
  /** headless summary command (default: SUMMARY_ARGV) */
  summaryArgv?: readonly string[];
}

/**
 * Headless summary call: cheapest model, JSON envelope, no tools, no saved session. The prompt goes
 * on stdin; the core adds AI_OBS_SUMMARIZING=1 so our own hooks exit at once inside it.
 */
export const SUMMARY_ARGV = ['claude', '-p', '--model', 'haiku', '--output-format', 'json', '--no-session-persistence', '--tools', ''] as const;

/** `--output-format json` prints `{ "type": "result", "is_error": false, "result": "<text>", … }`. */
export function extractResultText(stdout: string): string {
  try {
    const o = JSON.parse(stdout) as { result?: unknown; is_error?: unknown };
    if (o.is_error === true) throw new Error('claude reported an error');
    return typeof o.result === 'string' ? o.result : '';
  } catch (err) {
    if (err instanceof SyntaxError) return stdout;
    throw err;
  }
}

export function createClaudeCodeAdapter(opts: ClaudeCodeAdapterOptions = {}): HarnessAdapter {
  const dir = () => opts.claudeDir ?? defaultClaudeDir();
  const probe = opts.probe ?? probeClaudeVersion;
  const argv = [...(opts.summaryArgv ?? SUMMARY_ARGV)];
  return {
    name: 'claude-code',
    displayName: 'Claude Code',
    sessionStartHooks: ['SessionStart'],
    detect: (d = {}) => detectClaudeCode({ ...d, claudeDir: dir(), probe }),
    async installedHookCommands(d = {}) {
      const paths = [settingsPath('user', { claudeDir: dir() }), ...(d.projectDir ? [settingsPath('project', { claudeDir: dir(), projectDir: d.projectDir })] : [])];
      return paths.flatMap(ourCommandsAt);
    },
    async installHooks(o) {
      const path = settingsPath(o.scope, { claudeDir: dir(), ...(o.projectDir ? { projectDir: o.projectDir } : {}) });
      installHooksAt(path, o.hookCommand, o.scope === 'project' ? 0o644 : 0o600);
    },
    async uninstallHooks(o) {
      uninstallHooksAt(settingsPath(o.scope, { claudeDir: dir(), ...(o.projectDir ? { projectDir: o.projectDir } : {}) }));
    },
    handleHook: (event, ctx) => handleHook(event, ctx, { claudeDir: dir(), probe }),
    sweepCrashedSessions: (ctx) => sweepCrashedSessions(ctx),
    summarize: (digests) =>
      summarizeWithCommand(digests, {
        command: (prompt) => ({ argv, input: prompt }),
        extractText: extractResultText,
        cwd: tmpdir(),
      }),
  };
}

export const adapter: HarnessAdapter = createClaudeCodeAdapter();
