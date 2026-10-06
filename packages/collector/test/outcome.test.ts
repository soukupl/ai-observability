import { describe, expect, it } from 'vitest';
import { detectRevert, editFingerprint, finalOutcome, isRevertCommand, outcomeChanged, provisionalOutcome } from '../src/analysis/outcome.js';

describe('provisionalOutcome', () => {
  it.each([
    [{ stopFailure: true, lastCheck: { kind: 'testing', exitCode: 0 } }, 'failed', ['stop_failure']],
    [{ interrupted: true }, 'abandoned', ['user_interrupt']],
    [{ lastCheck: { kind: 'testing', exitCode: 1 } }, 'failed', ['tests_failed']],
    [{ lastCheck: { kind: 'testing', exitCode: 0 } }, 'success', ['tests_passed']],
    [{ lastCheck: { kind: 'validating', exitCode: 2 } }, 'failed', ['validate_failed']],
    [{ lastCheck: { kind: 'validating', exitCode: 0 } }, 'success', ['validate_passed']],
    [{}, 'unknown', []],
  ] as const)('%j → %s', (signals, status, sig) => {
    const o = provisionalOutcome(signals);
    expect(o).toEqual({ status, signals: sig, provisional: true });
  });
});

describe('finalOutcome', () => {
  const passed = provisionalOutcome({ lastCheck: { kind: 'testing', exitCode: 0 } });
  const unknown = provisionalOutcome({});
  const abandoned = provisionalOutcome({ interrupted: true });

  it('correction makes the turn failed retroactively', () => {
    expect(finalOutcome(passed, { correction: true })).toEqual({
      status: 'failed',
      signals: ['tests_passed', 'next_prompt_correction'],
      provisional: false,
    });
  });
  it('revert makes the turn failed', () => {
    expect(finalOutcome(unknown, { revert: true }).status).toBe('failed');
    expect(finalOutcome(unknown, { revert: true }).signals).toContain('next_turn_revert');
  });
  it('unknown + a normal next prompt → success (no_failure_signal)', () => {
    expect(finalOutcome(unknown, {})).toEqual({ status: 'success', signals: ['no_failure_signal'], provisional: false });
  });
  it('unknown last turn of a session stays unknown', () => {
    expect(finalOutcome(unknown, { sessionEnded: true })).toEqual({ status: 'unknown', signals: [], provisional: false });
  });
  it('interrupted stays abandoned even after a correction', () => {
    expect(finalOutcome(abandoned, { correction: true }).status).toBe('abandoned');
  });
  it('outcomeChanged', () => {
    expect(outcomeChanged(passed, finalOutcome(passed, {}))).toBe(true); // provisional flag flips
    expect(outcomeChanged(passed, passed)).toBe(false);
  });
});

describe('revert detection', () => {
  it.each([
    ['git checkout -- src/a.ts', true],
    ['git checkout HEAD -- .', true],
    ['git restore src/a.ts', true],
    ['git restore --staged a.ts', false],
    ['git revert HEAD', true],
    ['git reset --hard', true],
    ['git stash', true],
    ['git stash pop', false],
    ['git checkout main', false],
    ['git status', false],
  ])('%s → %s', (cmd, expected) => {
    expect(isRevertCommand(cmd)).toBe(expected);
  });

  it('detects the next turn removing what this turn added', () => {
    const prev = editFingerprint([{ filePath: 'a.ts', added: ['const a = 1;', 'const b = 2;', 'export { a, b };'], removed: [] }]);
    const undo = editFingerprint([{ filePath: 'a.ts', added: [], removed: ['const a = 1;', 'const b = 2;', 'export { a, b };'] }]);
    const other = editFingerprint([{ filePath: 'b.ts', added: ['x'], removed: ['const a = 1;'] }]);
    expect(detectRevert(prev, undo)).toBe(true);
    expect(detectRevert(prev, other)).toBe(false);
    expect(JSON.stringify(prev)).not.toContain('const');
  });
});
