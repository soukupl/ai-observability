import { describe, expect, it } from 'vitest';
import { sortValue } from '../src/components/data-table-sort';
import { formatModel, formatModelEffort, modelLabels, modelProvider, modelTitle, parseModel } from '../src/lib/model-name';

describe('parseModel', () => {
  it.each([
    // Anthropic
    ['claude-opus-5-5', 'Anthropic', 'Opus 5.5'],
    ['claude-fable-5-1', 'Anthropic', 'Fable 5.1'],
    ['claude-sonnet-5', 'Anthropic', 'Sonnet 5'],
    ['claude-haiku-4-5', 'Anthropic', 'Haiku 4.5'],
    ['claude-opus-4-1', 'Anthropic', 'Opus 4.1'],
    ['claude-sonnet-4-5-20250929', 'Anthropic', 'Sonnet 4.5'],
    ['claude-opus-5-5[1m]', 'Anthropic', 'Opus 5.5 (1M)'],
    ['claude-sonnet-4-5-20250929[1m]', 'Anthropic', 'Sonnet 4.5 (1M)'],
    ['us.anthropic.claude-opus-5-5-v1:0', 'Anthropic', 'Opus 5.5'],
    ['anthropic.claude-haiku-4-5-20251001-v1:0', 'Anthropic', 'Haiku 4.5'],
    ['claude-opus-5-5@20260101', 'Anthropic', 'Opus 5.5'],
    ['claude-3-5-sonnet-20241022', 'Anthropic', 'Sonnet 3.5'],
    ['claude-mystic-2', 'Anthropic', 'Mystic 2'],
    ['claude-opus', 'Anthropic', 'Opus'],
    ['Claude-Opus-5-5', 'Anthropic', 'Opus 5.5'],
    // OpenAI
    ['gpt-5.5', 'OpenAI', 'GPT-5.5'],
    ['gpt-5.4-mini', 'OpenAI', 'GPT-5.4 mini'],
    ['gpt-5.4-nano', 'OpenAI', 'GPT-5.4 nano'],
    ['gpt-4o-2024-08-06', 'OpenAI', 'GPT-4o'],
    ['o3', 'OpenAI', 'o3'],
    ['o4-mini', 'OpenAI', 'o4-mini'],
    // Google
    ['gemini-2.5-pro', 'Google', 'Gemini 2.5 pro'],
    ['gemini-2.5-flash-lite', 'Google', 'Gemini 2.5 flash lite'],
  ])('%s -> %s / %s', (id, provider, name) => {
    expect(parseModel(id)).toEqual({ provider, name, id });
  });

  it.each(['mystery-1', '(unknown)', 'unknown model', 'other', 'claude', 'claude-', 'gpt-', 'gemini-', 'a', 'm', 'opus'])(
    'unknown id %j passes through verbatim with no provider',
    (id) => {
      expect(parseModel(id)).toEqual({ provider: null, name: id, id });
    },
  );

  it('empty string', () => {
    expect(parseModel('')).toEqual({ provider: null, name: '', id: '' });
  });

  it('never throws on odd input', () => {
    for (const id of ['[1m]', 'claude-[1m]', '@', 'us.anthropic.', '-v1:0', ' ', 'claude--', null as unknown as string, 42 as unknown as string]) {
      expect(() => parseModel(id)).not.toThrow();
    }
  });
});

describe('formatModel', () => {
  it('formats known ids and passes unknown ones through', () => {
    expect(formatModel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(formatModel('mystery-1')).toBe('mystery-1');
    expect(formatModel('(unknown)')).toBe('(unknown)');
    expect(formatModel('unknown model')).toBe('unknown model');
  });

  it.each([null, undefined, ''])('%j -> em dash', (id) => {
    expect(formatModel(id)).toBe('—');
  });

  it('is deterministic, so sorting by it is stable', () => {
    const ids = ['claude-sonnet-5', 'gpt-5.5', 'claude-opus-5-5', 'mystery-1', 'claude-opus-5-5[1m]', 'gemini-2.5-pro'];
    const sortByName = (xs: string[]) => [...xs].sort((a, b) => formatModel(a).toLowerCase().localeCompare(formatModel(b).toLowerCase()));
    const once = sortByName(ids);
    expect(sortByName([...ids].reverse())).toEqual(once);
    expect(once.map(formatModel)).toEqual(['Gemini 2.5 pro', 'GPT-5.5', 'mystery-1', 'Opus 5.5', 'Opus 5.5 (1M)', 'Sonnet 5']);
    expect(ids.map(formatModel)).toEqual(ids.map(formatModel));
  });

  it('modelTitle is the raw id only when the name differs', () => {
    expect(modelTitle('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(modelTitle('mystery-1')).toBeUndefined();
    expect(modelTitle('(unknown)')).toBeUndefined();
  });
});

describe('modelProvider', () => {
  it.each([
    ['claude-opus-5-5', 'Anthropic'],
    ['gpt-5.5', 'OpenAI'],
    ['gemini-2.5-pro', 'Google'],
    ['mystery-1', '—'],
    ['', '—'],
    [null, '—'],
    [undefined, '—'],
  ])('%j -> %s', (id, provider) => {
    expect(modelProvider(id)).toBe(provider);
  });
});

describe('formatModelEffort', () => {
  it.each([
    ['claude-opus-5-5', 'high', 'Opus 5.5 · high'],
    ['claude-opus-5-5', null, 'Opus 5.5'],
    [null, 'high', 'high'],
    [null, null, ''],
    ['m', 'low', 'm · low'],
  ])('%j + %j -> %j', (model, effort, out) => {
    expect(formatModelEffort(model, effort)).toBe(out);
  });
});

describe('DataTable model column', () => {
  it('sorts by display name, case-insensitive, and keeps empties last', () => {
    expect(sortValue('model', 'claude-opus-5-5')).toBe('opus 5.5');
    expect(sortValue('model', '(unknown)')).toBe('(unknown)');
    expect(sortValue('model', null)).toBeNull();
    expect(sortValue('model', '')).toBeNull();
    const ids = ['gpt-5.5', 'claude-sonnet-5', 'claude-haiku-4-5', 'Mystery'];
    const sorted = [...ids].sort((a, b) => String(sortValue('model', a)).localeCompare(String(sortValue('model', b))));
    expect(sorted).toEqual(['gpt-5.5', 'claude-haiku-4-5', 'Mystery', 'claude-sonnet-5']);
  });
});

describe('modelLabels', () => {
  it('maps raw ids to unique labels: friendly names, raw ids where names collide', () => {
    expect(modelLabels(['claude-opus-5-5', 'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929', 'other'])).toEqual({
      'claude-opus-5-5': 'Opus 5.5',
      'claude-sonnet-4-5': 'claude-sonnet-4-5',
      'claude-sonnet-4-5-20250929': 'claude-sonnet-4-5-20250929',
      other: 'other',
    });
    expect(modelLabels([])).toEqual({});
  });
});
