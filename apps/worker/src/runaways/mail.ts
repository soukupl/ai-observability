import { formatTokens } from '../budgets/mail.js';
import type { RunawayReason } from './decide.js';

export interface RunawayMailItem {
  turnId: string;
  startedAt: Date;
  startedMs: number;
  teamName: string | null;
  projectName: string | null;
  /** null in an anonymous digest (aggregates-only mode) */
  person: string | null;
  tokens: number;
  costUsd: number | null;
  durationMs: number;
  reasons: RunawayReason[];
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const REASON_TEXT: Record<RunawayReason, string> = {
  tokens: 'far more tokens than usual',
  cost: '≈ cost above the deployment threshold',
  duration: 'ran for hours with above-normal tokens',
};
const hours = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : `${Math.round(ms / 60_000)} min`);

/**
 * A digest of runaway turns for one recipient. `anonymous`: no person and no turn links (aggregates-only admins);
 * otherwise each turn links to its detail page.
 */
export function buildRunawayEmail(i: { deploymentName: string; appUrl: string; anonymous: boolean; items: RunawayMailItem[] }): {
  subject: string;
  text: string;
  html: string;
} {
  const n = i.items.length;
  const subject = `[ai-obs] ${n === 1 ? 'A runaway turn' : `${n} runaway turns`} (${i.deploymentName})`;
  const line = (x: RunawayMailItem) => {
    const where = [x.projectName, x.teamName && `team ${x.teamName}`, x.person].filter(Boolean).join(' · ');
    const cost = x.costUsd === null ? 'n/a' : `≈ $${x.costUsd.toFixed(2)}`;
    return `${x.startedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC${where ? ` · ${where}` : ''}: ${formatTokens(x.tokens)} tokens, ${cost}, ${hours(x.durationMs)} (${x.reasons.map((r) => REASON_TEXT[r]).join('; ')})`;
  };
  const link = (x: RunawayMailItem) => `${i.appUrl}/turns/${x.turnId}?startedMs=${x.startedMs}`;
  const intro = 'These turns used far more than usual. ai-obs only notifies; nothing was stopped.';
  const text = [
    intro,
    '',
    ...i.items.map((x) => (i.anonymous ? `- ${line(x)}` : `- ${line(x)}\n  ${link(x)}`)),
    '',
    'Cost is an estimate at API list prices, not an invoice.',
    '',
    `-- ai-obs, ${i.deploymentName}`,
  ].join('\n');
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1f2937;line-height:1.5">
<h2 style="margin:0 0 12px;color:#b42318">${esc(n === 1 ? 'A runaway turn' : `${n} runaway turns`)}</h2>
<p style="margin:0 0 8px">${esc(intro)}</p>
<ul style="margin:0 0 12px;padding-left:18px">
${i.items.map((x) => `<li style="margin:0 0 6px">${esc(line(x))}${i.anonymous ? '' : ` <a href="${esc(link(x))}">Open</a>`}</li>`).join('\n')}
</ul>
<p style="margin:0 0 4px;color:#6b7280">Cost is an estimate at API list prices, not an invoice.</p>
<p style="margin:0;color:#9ca3af;font-size:12px">ai-obs, ${esc(i.deploymentName)}</p>
</body></html>`;
  return { subject, text, html };
}
