import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * SYNTHETIC Claude Code transcripts with the real shape (FORMAT.md): one JSONL entry per content
 * block, each repeating its API response's usage; tool results as user entries with a parallel
 * `toolUseResult`. All content is made up.
 */
export const SESSION = '11111111-2222-4333-8444-555555555555';
export const CWD = '/work/acme-billing';
const VERSION = '2.1.289';
const T0 = Date.parse('2026-10-01T10:00:00.000Z');

/** ms timestamp `s` seconds after the fixture start */
export const at = (s: number) => T0 + s * 1000;
const iso = (s: number) => new Date(at(s)).toISOString();

export interface Usage {
  in: number;
  out: number;
  cr?: number;
  cw?: number;
  think?: number;
}

type Block = Record<string, unknown>;

export class TranscriptBuilder {
  readonly lines: Record<string, unknown>[] = [];
  private n = 0;
  constructor(
    readonly sessionId: string = SESSION,
    readonly extra: Record<string, unknown> = {},
  ) {}

  private base(s: number, type: string) {
    this.n++;
    return {
      parentUuid: null,
      isSidechain: Boolean(this.extra.agentId),
      userType: 'external',
      cwd: CWD,
      sessionId: this.sessionId,
      version: VERSION,
      gitBranch: 'main',
      ...this.extra,
      type,
      uuid: `${this.extra.agentId ?? 'm'}-entry-${this.n}`,
      timestamp: iso(s),
    };
  }

  prompt(s: number, uuid: string, text: string, extra: Record<string, unknown> = {}): this {
    this.lines.push({ ...this.base(s, 'user'), uuid, promptId: `p-${uuid}`, message: { role: 'user', content: text }, ...extra });
    return this;
  }

  /** One API response written as one entry per block (all repeating the same usage). */
  assistant(s: number | number[], msgId: string, model: string, u: Usage, blocks: Block[], effort: string | null = 'xhigh'): this {
    const times = Array.isArray(s) ? s : blocks.map(() => s);
    blocks.forEach((b, i) => {
      this.lines.push({
        ...this.base(times[i] ?? times.at(-1)!, 'assistant'),
        requestId: `req_${msgId}`,
        effort,
        perTurnEffort: effort,
        message: {
          id: msgId,
          type: 'message',
          role: 'assistant',
          model,
          content: [b],
          stop_reason: b.type === 'tool_use' ? 'tool_use' : 'end_turn',
          usage: {
            input_tokens: u.in,
            cache_creation_input_tokens: u.cw ?? 0,
            cache_read_input_tokens: u.cr ?? 0,
            output_tokens: u.out,
            output_tokens_details: { thinking_tokens: u.think ?? 0 },
            server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
            service_tier: 'standard',
            cache_creation: { ephemeral_1h_input_tokens: u.cw ?? 0, ephemeral_5m_input_tokens: 0 },
          },
        },
      });
    });
    return this;
  }

  toolResult(s: number, toolUseId: string, content: string, isError = false, toolUseResult: unknown = { stdout: '', stderr: '', interrupted: false, isImage: false }): this {
    this.lines.push({
      ...this.base(s, 'user'),
      message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content, ...(isError ? { is_error: true } : { is_error: false }) }] },
      toolUseResult,
    });
    return this;
  }

  interrupt(s: number): this {
    this.lines.push({ ...this.base(s, 'user'), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
    return this;
  }

  raw(obj: Record<string, unknown>): this {
    this.lines.push(obj);
    return this;
  }

  /** Entries Claude Code writes that the adapter must ignore. */
  noise(s: number): this {
    this.lines.push({ type: 'file-history-snapshot', messageId: 'x', snapshot: {}, isSnapshotUpdate: false });
    this.lines.push({ ...this.base(s, 'attachment'), attachment: { type: 'hook_success' } });
    this.lines.push({ ...this.base(s, 'user'), isMeta: true, message: { role: 'user', content: 'meta caveat' } });
    this.lines.push({ ...this.base(s, 'system'), subtype: 'stop_hook_summary', hookCount: 1, stopReason: '' });
    return this;
  }

  text(): string {
    return this.lines.map((l) => `${JSON.stringify(l)}\n`).join('');
  }
}

export const thinking = (): Block => ({ type: 'thinking', thinking: '', signature: 'sig' });
export const text = (t: string): Block => ({ type: 'text', text: t });
export const toolUse = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: 'tool_use', id, name, input });
export const bashOk = { stdout: 'ok', stderr: '', interrupted: false, isImage: false, noOutputExpected: false };

const OPUS = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-4-5';

/**
 * The 3-turn session:
 *  1. Read → Agent (Explore sub-agent a1, which spawns nested a2) → Edit → answer
 *  2. Bash `npm test` interrupted by the user (no Stop)
 *  3. correction prompt → Edit → failing tests → docs Write → passing tests → answer
 * `turn1End` = number of main lines that belong to turn 1 (the "first half").
 */
export function threeTurnSession() {
  const m = new TranscriptBuilder();
  m.prompt(0, 'cc-fixture-turn-1', 'Find where auth tokens are refreshed and fix the expiry check');
  m.assistant([2, 3], 'msg_1', OPUS, { in: 10, out: 50, cr: 1000, cw: 200, think: 20 }, [thinking(), toolUse('tu_read1', 'Read', { file_path: '/work/acme-billing/src/auth.ts' })]);
  m.toolResult(5, 'tu_read1', 'file text', false, { type: 'text', file: { filePath: '/work/acme-billing/src/auth.ts' } });
  m.assistant(8, 'msg_2', OPUS, { in: 5, out: 30, cr: 1200, cw: 100 }, [toolUse('tu_agent1', 'Agent', { description: 'find refresh', prompt: 'look', subagent_type: 'Explore' })]);
  m.toolResult(21, 'tu_agent1', 'agent report', false, { status: 'completed', agentId: 'a1', agentType: 'Explore', totalTokens: 1 });
  m.assistant(25, 'msg_3', OPUS, { in: 3, out: 80, cr: 1300, cw: 50 }, [
    toolUse('tu_edit1', 'Edit', { file_path: '/work/acme-billing/src/auth.ts', old_string: 'a\nb', new_string: 'a\nc\nd', replace_all: false }),
  ]);
  m.toolResult(26, 'tu_edit1', 'updated', false, {
    filePath: '/work/acme-billing/src/auth.ts',
    oldString: 'a\nb',
    newString: 'a\nc\nd',
    structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' a', '-b', '+c', '+d'] }],
  });
  m.assistant(30, 'msg_4', OPUS, { in: 2, out: 20, cr: 1400, cw: 0 }, [text('Fixed the expiry check.')]);
  m.noise(31);
  const turn1End = m.lines.length;

  m.prompt(300, 'cc-fixture-turn-2', 'Now add retry to the HTTP client');
  m.assistant(303, 'msg_5', OPUS, { in: 4, out: 40, cr: 1500, cw: 10 }, [toolUse('tu_bash1', 'Bash', { command: 'npm test', description: 'run tests' })]);
  m.toolResult(310, 'tu_bash1', '[Request interrupted by user for tool use]', true, { stdout: '', stderr: '', interrupted: true, isImage: false });
  m.interrupt(310);
  const turn2End = m.lines.length;

  m.prompt(360, 'cc-fixture-turn-3', "no, that's wrong - use exponential backoff");
  m.assistant(364, 'msg_6', OPUS, { in: 6, out: 60, cr: 1600, cw: 20 }, [
    toolUse('tu_edit2', 'Edit', { file_path: '/work/acme-billing/src/client.ts', old_string: 'x', new_string: 'y\nz', replace_all: false }),
  ]);
  m.toolResult(365, 'tu_edit2', 'updated', false, {
    filePath: '/work/acme-billing/src/client.ts',
    structuredPatch: [{ oldStart: 4, oldLines: 1, newStart: 4, newLines: 2, lines: ['-x', '+y', '+z'] }],
  });
  m.assistant(368, 'msg_7', OPUS, { in: 1, out: 25, cr: 1700, cw: 0 }, [toolUse('tu_bash2', 'Bash', { command: 'pnpm vitest run', description: 'tests' })]);
  m.toolResult(380, 'tu_bash2', 'Exit code 1\n1 test failed', true);
  m.assistant(385, 'msg_8', OPUS, { in: 1, out: 70, cr: 1800, cw: 30 }, [toolUse('tu_write1', 'Write', { file_path: '/work/acme-billing/docs/retry.md', content: 'line1\nline2\n' })]);
  m.toolResult(386, 'tu_write1', 'created', false, { type: 'create', filePath: '/work/acme-billing/docs/retry.md', content: 'line1\nline2\n', structuredPatch: [] });
  m.assistant(390, 'msg_9', OPUS, { in: 1, out: 15, cr: 1900, cw: 0 }, [toolUse('tu_bash3', 'Bash', { command: 'pnpm vitest run', description: 'tests' })]);
  m.toolResult(400, 'tu_bash3', 'all passed', false, bashOk);
  m.assistant(405, 'msg_10', OPUS, { in: 2, out: 30, cr: 2000, cw: 0 }, [text('Retry with backoff added; tests pass.')]);
  m.noise(406);

  const a1 = new TranscriptBuilder(SESSION, { agentId: 'a1' });
  a1.prompt(9, 'a1-prompt', 'Find the token refresh code');
  a1.assistant(12, 'msg_s1', HAIKU, { in: 100, out: 40, cr: 0, cw: 500 }, [toolUse('tu_s_grep', 'Grep', { pattern: 'refresh' })], 'xhigh');
  a1.toolResult(14, 'tu_s_grep', 'matches');
  a1.assistant(15, 'msg_s2', HAIKU, { in: 8, out: 12, cr: 500, cw: 0 }, [toolUse('tu_nested', 'Agent', { description: 'n', prompt: 'p', subagent_type: 'Explore' })], 'xhigh');
  a1.toolResult(19, 'tu_nested', 'nested report', false, { status: 'completed', agentId: 'a2' });
  a1.assistant([20, 20], 'msg_s3', HAIKU, { in: 20, out: 60, cr: 520, cw: 0 }, [thinking(), text('Refresh lives in auth.')], 'xhigh');

  const a2 = new TranscriptBuilder(SESSION, { agentId: 'a2' });
  a2.prompt(16, 'a2-prompt', 'Look deeper');
  a2.assistant(18, 'msg_n1', HAIKU, { in: 7, out: 9, cr: 0, cw: 0 }, [text('Found it.')], null);

  return {
    main: m,
    turn1End,
    turn2End,
    subagents: {
      a1: { builder: a1, meta: { agentType: 'Explore', description: 'find refresh', toolUseId: 'tu_agent1', spawnDepth: 1 } },
      a2: { builder: a2, meta: { agentType: 'Explore', description: 'n', toolUseId: 'tu_nested', parentAgentId: 'a1', spawnDepth: 2 } },
    },
  };
}

/** Writes main lines [0, upTo) and (optionally) the sub-agent files to `<dir>/<session>.jsonl`. */
export function writeSession(
  dir: string,
  fx: ReturnType<typeof threeTurnSession>,
  opts: { upTo?: number; partialNext?: boolean; subagents?: boolean } = {},
): string {
  const path = join(dir, `${SESSION}.jsonl`);
  const lines = fx.main.lines.slice(0, opts.upTo ?? fx.main.lines.length).map((l) => `${JSON.stringify(l)}\n`);
  let body = lines.join('');
  const next = opts.upTo !== undefined ? fx.main.lines[opts.upTo] : undefined;
  if (opts.partialNext && next) body += JSON.stringify(next).slice(0, 40); // half-written line
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  if (opts.subagents !== false) {
    for (const [id, a] of Object.entries(fx.subagents)) {
      const sub = join(dir, SESSION, 'subagents');
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, `agent-${id}.jsonl`), a.builder.text());
      writeFileSync(join(sub, `agent-${id}.meta.json`), JSON.stringify(a.meta));
    }
  }
  return path;
}
