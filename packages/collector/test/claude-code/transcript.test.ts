import { describe, expect, it } from 'vitest';
import { lineDiff, slimEntry } from '../../src/adapters/claude-code/transcript.js';

const ts = '2026-10-01T10:00:00.000Z';
const user = (content: unknown, extra: Record<string, unknown> = {}) => slimEntry({ type: 'user', timestamp: ts, uuid: 'u', message: { role: 'user', content }, ...extra });

describe('claude-code transcript entries', () => {
  it('tells prompts from everything else a user entry can be', () => {
    expect(user('fix the bug')).toMatchObject({ k: 'prompt', human: true, uuid: 'u', command: null });
    expect(user('<command-message>code-review</command-message>\n<command-name>/code-review</command-name>\n<command-args>--fix</command-args>')).toMatchObject({ k: 'prompt', command: 'code-review' });
    expect(user([{ type: 'text', text: 'see image' }, { type: 'image', source: {} }])).toMatchObject({ k: 'prompt' });
    expect(user('<task-notification>\n<task-id>1</task-id>', { origin: { kind: 'task-notification' } })).toMatchObject({ k: 'prompt', human: false });
    expect(user('[Request interrupted by user]')).toEqual({ k: 'interrupt', at: Date.parse(ts) });
    expect(user('<local-command-stdout>ok</local-command-stdout>')).toBeNull();
    expect(user('<local-command-caveat>Caveat</local-command-caveat>')).toBeNull();
    expect(user('expanded skill text', { isMeta: true })).toEqual({ k: 'expansion', at: Date.parse(ts) });
    expect(user('Base directory for this skill: …', { isMeta: true, sourceToolUseID: 'toolu_1' })).toBeNull();
    expect(user('<local-command-caveat>Caveat</local-command-caveat>', { isMeta: true })).toBeNull();
    expect(user('<command-message>x</command-message>\n<command-name>x</command-name>', { isMeta: true })).toBeNull();
    expect(user('summary of earlier conversation', { isCompactSummary: true })).toBeNull();
    expect(user('summary of earlier conversation', { isCompactSummary: true, isMeta: true })).toBeNull();
    expect(user([{ type: 'tool_result', tool_use_id: 't', content: 'x' }])).toMatchObject({ k: 'tool_result' });
    expect(slimEntry({ type: 'system', subtype: 'stop_hook_summary', timestamp: ts })).toEqual({ k: 'stop', at: Date.parse(ts) });
    expect(slimEntry({ type: 'system', subtype: 'api_error', timestamp: ts })).toBeNull();
    expect(slimEntry({ type: 'user', timestamp: ts, sessionId: 'other', message: { content: 'x' } }, 'mine')).toBeNull();
  });

  it('reads Bash exit codes from tool results', () => {
    const r = (content: string, is_error: boolean) => {
      const e = user([{ type: 'tool_result', tool_use_id: 't', content, is_error }]);
      return e?.k === 'tool_result' ? e.results[0]!.exitCode : undefined;
    };
    expect(r('all good', false)).toBe(0);
    expect(r('Exit code 2\nboom', true)).toBe(2);
    expect(r('Permission denied', true)).toBeNull();
  });

  it('usage: input excludes cache, reasoning from output_tokens_details, synthetic error messages carry none', () => {
    const a = slimEntry({
      type: 'assistant', timestamp: ts, requestId: 'req', effort: 'high',
      message: { id: 'msg', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 3, output_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 7, output_tokens_details: { thinking_tokens: 4 } } },
    });
    expect(a).toMatchObject({ k: 'assistant', usage: { responseId: 'msg', model: 'claude-opus-5-5', effort: 'high', input: 3, output: 9, cacheRead: 100, cacheWrite: 7, reasoning: 4 } });
    const err = slimEntry({ type: 'assistant', timestamp: ts, isApiErrorMessage: true, message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }], usage: { input_tokens: 0, output_tokens: 0 } } });
    expect(err).toMatchObject({ k: 'assistant', synthetic: true, usage: null });
  });

  it('tool uses keep phase decisions, not paths in events', () => {
    const a = slimEntry({
      type: 'assistant', timestamp: ts,
      message: { id: 'm', model: 'x', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/r/README.md', old_string: 'a', new_string: 'a\nb' } }] },
    });
    expect(a).toMatchObject({ k: 'assistant', blocks: [{ t: 'tool_use', name: 'Edit', phase: 'documenting', edit: { added: 1, removed: 0 } }] });
  });

  it('lineDiff counts multiset differences', () => {
    expect(lineDiff(['a', 'b', 'b'], ['a', 'b', 'c'])).toEqual({ added: ['c'], removed: ['b'] });
    expect(lineDiff([], ['x', 'y'])).toEqual({ added: ['x', 'y'], removed: [] });
  });
});
