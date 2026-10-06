import { createHash } from 'node:crypto';
import type { Outcome, OutcomeSignal } from '../protocol-types.js';
import { splitShellCommand } from './phases.js';

/** Signals observed inside one turn (BRIEF §5.5). */
export interface TurnSignals {
  /** the turn ended with an API / harness error (Claude Code `StopFailure`, …) */
  stopFailure?: boolean;
  /** the user interrupted the turn */
  interrupted?: boolean;
  /** the LAST test or validate command of the turn, with its exit code */
  lastCheck?: { kind: 'testing' | 'validating'; exitCode: number } | null;
}

/** What the next prompt / next turn revealed about this turn. */
export interface FollowUp {
  /** the next prompt looks like a correction (see corrections.ts) */
  correction?: boolean;
  /** the next turn reverted this turn's edits (see detectRevert / isRevertCommand) */
  revert?: boolean;
  /** true when there is no next prompt (session ended) */
  sessionEnded?: boolean;
}

const uniq = (s: readonly string[]) => [...new Set(s)];

/**
 * Provisional outcome sent with the `turn` event at Stop. Precedence: stop failure > interrupt >
 * last test/validate result > unknown (waits for the next prompt).
 */
export function provisionalOutcome(s: TurnSignals): Outcome {
  if (s.stopFailure) return { status: 'failed', signals: ['stop_failure'], provisional: true };
  if (s.interrupted) return { status: 'abandoned', signals: ['user_interrupt'], provisional: true };
  if (s.lastCheck) {
    const passed = s.lastCheck.exitCode === 0;
    const signal: OutcomeSignal =
      s.lastCheck.kind === 'testing' ? (passed ? 'tests_passed' : 'tests_failed') : passed ? 'validate_passed' : 'validate_failed';
    return { status: passed ? 'success' : 'failed', signals: [signal], provisional: true };
  }
  return { status: 'unknown', signals: [], provisional: true };
}

/**
 * Final outcome once the follow-up is known; sent as a `turn_outcome` patch (provisional: false).
 * - a revert or correction makes a turn `failed` retroactively (an interrupted turn stays `abandoned`);
 * - an `unknown` turn followed by a normal prompt becomes `success` (`no_failure_signal`);
 * - an `unknown` last turn of a session stays `unknown`.
 */
export function finalOutcome(provisional: Outcome, follow: FollowUp): Outcome {
  const signals = [...provisional.signals];
  if (follow.revert || follow.correction) {
    if (follow.revert) signals.push('next_turn_revert');
    if (follow.correction) signals.push('next_prompt_correction');
    const status = provisional.status === 'abandoned' ? 'abandoned' : 'failed';
    return { status, signals: uniq(signals), provisional: false };
  }
  if (provisional.status === 'unknown' && !follow.sessionEnded) {
    return { status: 'success', signals: uniq([...signals, 'no_failure_signal']), provisional: false };
  }
  return { status: provisional.status, signals: uniq(signals), provisional: false };
}

/** Whether a patch event is worth sending (anything changed beyond `provisional`). */
export function outcomeChanged(before: Outcome, after: Outcome): boolean {
  return before.status !== after.status || before.signals.join(',') !== after.signals.join(',') || before.provisional !== after.provisional;
}

// ---------------------------------------------------------------- revert detection (hook point)

/** Shell commands that throw away work (`git checkout -- f`, `git restore`, `git revert`, `git reset --hard`, `git stash`). */
export function isRevertCommand(command: string | readonly string[]): boolean {
  const line = typeof command === 'string' ? command : command.join(' ');
  return splitShellCommand(line).some((c) =>
    /^git (checkout (--|\S+ --) |checkout \.$|restore\b(?! --staged\b)|revert\b|reset --hard\b|stash( push| save)?$|clean -\w*f)/.test(c),
  );
}

/**
 * Fingerprint of a turn's edits: hashes of `path\0line` for added and removed lines. Kept in local
 * session state only (hashes, no content); used to see whether the next turn undid this one.
 */
export interface EditFingerprint {
  added: string[];
  removed: string[];
}

const lineHash = (path: string, line: string) =>
  createHash('sha256').update(`${path}\0${line.trim()}`).digest('base64url').slice(0, 16);

export function editFingerprint(edits: ReadonlyArray<{ filePath: string; added: readonly string[]; removed: readonly string[] }>): EditFingerprint {
  const added = new Set<string>();
  const removed = new Set<string>();
  for (const e of edits) {
    for (const l of e.added) if (l.trim()) added.add(lineHash(e.filePath, l));
    for (const l of e.removed) if (l.trim()) removed.add(lineHash(e.filePath, l));
  }
  return { added: [...added].slice(0, 5000), removed: [...removed].slice(0, 5000) };
}

/**
 * True when `next` removes at least `threshold` (default 80 %) of the lines `prev` added (min. 3
 * lines), i.e. the next turn reverted this one.
 */
export function detectRevert(prev: EditFingerprint, next: EditFingerprint, threshold = 0.8): boolean {
  if (prev.added.length < 3) return false;
  const removed = new Set(next.removed);
  const undone = prev.added.filter((h) => removed.has(h)).length;
  return undone / prev.added.length >= threshold;
}
