/**
 * The ONE grouping rule for sub-agents (ADR-0019). A run's group is the `agent_group` the collector
 * stored, else it is derived from `agent_type`:
 *   - `workflow:<label>` -> `workflow:<verb>`, verb = first token of the label (split on - : . _ / and
 *     whitespace), lower-cased, trailing digits stripped (`impl-m08-t02b` -> `workflow:impl`,
 *     `fix1-m8-brief` -> `workflow:fix`); `workflow` when the label has no verb;
 *   - anything else -> the type itself (`Explore`, `general-purpose`).
 * The collector sends the same shape (`workflow:<phase slug>` or `workflow:<label verb>`), so old rows
 * (no stored group) and new rows land in the same groups. No backfill.
 */
const WORKFLOW = /^workflow:(.*)$/s;
const TOKEN_SEP = /[-:._/\s]+/;

export function agentGroupOf(agentType: string, stored?: string | null): string {
  const s = typeof stored === 'string' ? stored.trim() : '';
  if (s) return s;
  const m = WORKFLOW.exec(agentType);
  if (!m) return agentType;
  const verb = (m[1]!.split(TOKEN_SEP)[0] ?? '').toLowerCase().replace(/\d+$/, '');
  return verb ? `workflow:${verb}` : 'workflow';
}

/**
 * Short display label of a run in the timeline graphs: the label part of a `workflow:<label>` type (the group already
 * says it is a workflow agent), else the type itself.
 */
export function agentRunLabel(agentType: string): string {
  const m = WORKFLOW.exec(agentType);
  if (!m) return agentType;
  return m[1]!.trim() || 'workflow';
}
