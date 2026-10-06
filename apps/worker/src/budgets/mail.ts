import type { BudgetKind, Threshold } from './evaluate.js';

export interface BudgetMailInput {
  threshold: Threshold;
  kind: BudgetKind;
  used: number;
  limit: number;
  /** 'YYYY-MM-01' */
  period: string;
  companyName: string;
  /** Team name and/or user label this budget applies to, e.g. "team Platform" or "alice@acme.test". */
  scope: string;
  appUrl: string;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

export const formatValue = (kind: BudgetKind, n: number): string =>
  kind === 'cost' ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `${formatTokens(n)} tokens`;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const periodLabel = (period: string): string => `${MONTHS[Number(period.slice(5, 7)) - 1] ?? period.slice(5, 7)} ${period.slice(0, 4)}`;

/** Plain-text + simple HTML budget alert. Nothing here is user-controlled markup: all values are escaped. */
export function buildBudgetEmail(i: BudgetMailInput): { subject: string; text: string; html: string } {
  const pct = i.limit > 0 ? Math.round((i.used / i.limit) * 100) : 0;
  const month = periodLabel(i.period);
  const what = i.kind === 'cost' ? 'estimated cost budget' : 'token budget';
  const headline =
    i.threshold === 100
      ? `The ${what} for ${i.scope} has been reached (${pct} %).`
      : `The ${what} for ${i.scope} is at ${pct} % of its limit.`;
  const usedLine = `Used in ${month}: ${formatValue(i.kind, i.used)} of ${formatValue(i.kind, i.limit)}`;
  const note = [
    i.kind === 'cost' ? 'Cost is an estimate at API list prices, not an invoice.' : null,
    'Budgets only notify; nothing is blocked.',
  ].filter(Boolean) as string[];
  const link = `${i.appUrl}/overview`;
  const subject = `[ai-obs] ${i.threshold === 100 ? 'Budget reached' : 'Budget at 80 %'}: ${i.scope} (${i.companyName})`;

  const text = [headline, '', usedLine, ...note, '', `Open the dashboard: ${link}`, '', `-- ai-obs, ${i.companyName}`].join('\n');
  const color = i.threshold === 100 ? '#b42318' : '#b54708';
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1f2937;line-height:1.5">
<h2 style="margin:0 0 12px;color:${color}">${esc(headline)}</h2>
<p style="margin:0 0 4px"><strong>${esc(usedLine)}</strong></p>
<div style="background:#e5e7eb;border-radius:4px;height:8px;width:320px;max-width:100%;margin:8px 0 12px"><div style="background:${color};height:8px;border-radius:4px;width:${Math.min(100, pct)}%"></div></div>
${note.map((n) => `<p style="margin:0 0 4px;color:#6b7280">${esc(n)}</p>`).join('\n')}
<p style="margin:16px 0"><a href="${esc(link)}">Open the dashboard</a></p>
<p style="margin:0;color:#9ca3af;font-size:12px">ai-obs, ${esc(i.companyName)}</p>
</body></html>`;
  return { subject, text, html };
}
