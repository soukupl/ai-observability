import { table } from '../commands/common.js';
import type { LiveSession } from './monitor.js';

/** Pure frame rendering for `ai-obs live` (ADR-0027): no TTY, no clock, no IO, so frames are unit-tested exactly. */

export interface RenderOptions {
  /** epoch ms: the clock in the header and every elapsed time */
  now: number;
  /** terminal columns: every line is cut to this */
  width: number;
  /** the directory `--cwd` narrowed to, null = every session on the machine */
  scope: string | null;
  /** terminal rows: sessions that do not fit are left out and counted in the footer (default: no limit) */
  rows?: number;
}

/** Control characters (C0, DEL, C1) never reach the terminal: a directory or tool name could carry escape sequences. */
const safe = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
/** Lines around the table: header, blank, column heads, blank, footer. */
const FRAME_LINES = 5;

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 45s, 3m12s, 1h04m (negative durations count as 0). */
export function formatElapsed(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${pad2(s % 60)}s`;
  return `${Math.floor(s / 3600)}h${pad2(Math.floor((s % 3600) / 60))}m`;
}

/** 950, 12.3k, 1.2M */
export function formatTokens(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v < 1000) return String(v);
  const k = v / 1000;
  if (k < 999.95) return `${k.toFixed(1)}k`;
  return `${(v / 1_000_000).toFixed(1)}M`;
}

/** ≈ $0.42, ≈ $0.42+ (some models have no price), n/a (none has) */
export function formatCost(c: { usd: number | null; partial: boolean }): string {
  if (c.usd === null) return 'n/a';
  return `≈ $${c.usd.toFixed(2)}${c.partial ? '+' : ''}`;
}

const clip = (s: string, max: number) => (s.length <= max ? s : max <= 1 ? s.slice(0, max) : `${s.slice(0, max - 1)}…`);
const HEAD = ['STATUS', 'HARNESS', 'PROJECT', 'TITLE', 'TOKENS', '≈COST', 'TOOLS', 'AGENTS', 'LAST TOOL'];
const TITLE = 3;
/** Columns kept on a narrow terminal: status, harness, project, title, tokens, cost. */
const MIN_COLS = 6;
const MIN_TITLE = 8;
const WANT_TITLE = 20;
const MAX_TITLE = 60;
const MAX_NAME = 24;
const NARROW_NAME = 14;

/** Widest cell of each of the first `n` columns. */
const widths = (matrix: readonly (readonly string[])[], n: number): number[] =>
  Array.from({ length: n }, (_, i) => Math.max(...matrix.map((r) => r[i]!.length)));

/** The frame as lines (no trailing newlines): header, table or "No sessions running", footer. */
export function renderFrame(rows: readonly LiveSession[], o: RenderOptions): string[] {
  const shown = rows.filter((r) => r.status !== 'stale');
  const stale = rows.length - shown.length;
  const d = new Date(o.now);
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const lines = [`ai-obs live · ${shown.length} running${o.scope ? ` in ${safe(o.scope)}` : ''} · ${clock} · q quits`, ''];
  // On a short terminal the header and footer stay; the sessions that do not fit are counted instead.
  const listed = o.rows === undefined ? shown : shown.slice(0, Math.max(0, o.rows - FRAME_LINES));
  const more = shown.length - listed.length;

  if (!shown.length) lines.push('No sessions running');
  else if (listed.length) {
    const layout = (projectMax: number) => {
      const matrix = [
        HEAD,
        ...listed.map((r) => [
          `${r.status} ${formatElapsed(o.now - r.since)}`,
          safe(r.harness),
          clip(safe(r.project || '-'), projectMax),
          safe(r.title ?? '-'),
          formatTokens(r.tokens),
          formatCost(r.cost),
          String(r.tools),
          String(r.subagents),
          clip(safe(r.lastTool ?? '-'), MAX_NAME),
        ]),
      ];
      // What the other columns leave for the title when the first `n` columns are shown.
      const room = (n: number) => {
        const w = widths(matrix, n);
        return o.width - (w.reduce((a, b) => a + b, 0) - w[TITLE]!) - 2 * (n - 1);
      };
      // On a narrow terminal the least important columns (last tool, agents, tools) go first.
      let cols = HEAD.length;
      while (cols > MIN_COLS && room(cols) < WANT_TITLE) cols--;
      return { matrix, cols, room: room(cols) };
    };
    let l = layout(MAX_NAME);
    if (l.room < WANT_TITLE) l = layout(NARROW_NAME); // still no room for a title: shorten the project names too
    const titleMax = Math.min(MAX_TITLE, Math.max(MIN_TITLE, l.room));
    lines.push(...table(l.matrix.map((r) => r.slice(0, l.cols).map((c, i) => (i === TITLE ? clip(c, titleMax) : c)))));
  }

  lines.push('', [...(more ? [`${more} more not shown`] : []), ...(stale ? [`${stale} stale hidden`] : []), '≈ at default list prices'].join(' · '));
  return lines.map((l) => (l.length > o.width ? l.slice(0, Math.max(0, o.width)).trimEnd() : l));
}
