import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { provisionalOutcome } from '../../analysis/outcome.js';
import { primaryModel } from '../../analysis/tokens.js';
import { runEvent } from '../../events.js';
import { readJsonFile } from '../../fsutil.js';
import type { Outcome, RunEvent, UsageEntry } from '../../protocol-types.js';
import { analyzeEntries, isWorkflowKey, workflowKey } from './analyze.js';
import { readWholeTranscript } from './transcript.js';

/**
 * Sub-agent transcripts: <project dir>/<session id>/subagents/agent-<id>.jsonl with a sibling
 * agent-<id>.meta.json { agentType, toolUseId, parentAgentId?, spawnDepth, … }. `toolUseId` is the
 * Agent / Task tool_use in the parent transcript (the main session, or the parent sub-agent when
 * `parentAgentId` is set).
 *
 * Workflow-tool sub-agents live one level deeper, subagents/workflows/<wf_id>/agent-<id>.jsonl, with
 * meta { agentType: "workflow-subagent", description (label), workflowPhase, spawnDepth: 1 } and no
 * `toolUseId`. They are linked to the Workflow launch through the synthetic key `wf:<wf_id>` (see
 * `workflowKey`). A `journal.jsonl` next to them records `started` / `result` / `failed` per agent, and
 * `<session>/workflows/<wf_id>.json` gets a terminal `status` when the whole workflow is over.
 */
export interface AgentMeta {
  agentId: string;
  agentType: string | null;
  toolUseId: string | null;
  parentAgentId: string | null;
  spawnDepth: number | null;
  file: string;
  /** Workflow tool run this agent belongs to (`wf_…`) */
  workflowId: string | null;
  /** workflow label (meta `description`) and phase; local use only, sanitized in `workflowAgentType` */
  label: string | null;
  workflowPhase: string | null;
  /** 0-based order of first appearance of the agent's phase among the journal's `started` records */
  stageIndex: number | null;
  /** the workflow journal says this agent returned (`result`) or errored (`failed`) */
  finished: boolean;
  failed: boolean;
}

export function subagentsDir(transcriptPath: string): string {
  return join(dirname(transcriptPath), basename(transcriptPath, '.jsonl'), 'subagents');
}

const FILE_RE = /^agent-([A-Za-z0-9_-]+)\.jsonl$/;

const WF_DIR_RE = /^wf_[A-Za-z0-9_-]{1,64}$/;
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

function readDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readMeta(dir: string, agentId: string): Record<string, unknown> {
  return readJsonFile<Record<string, unknown>>(join(dir, `agent-${agentId}.meta.json`)) ?? {};
}

interface Journal {
  finished: Set<string>;
  failed: Set<string>;
  /** phase → 0-based order of its first `started` record (launch order) */
  phaseOrder: Map<string, number>;
}

const emptyJournal = (): Journal => ({ finished: new Set(), failed: new Set(), phaseOrder: new Map() });

/**
 * Agents the workflow journal reports as returned / failed, and the order in which phases started.
 * Only `type`, `agentId` and `phase` are looked at.
 */
function readJournal(dir: string): Journal {
  const out = emptyJournal();
  const { finished, failed, phaseOrder } = out;
  let text = '';
  try {
    text = readFileSync(join(dir, 'journal.jsonl'), 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    if (!line.includes('"agentId"') || !(line.includes('"result"') || line.includes('"failed"') || line.includes('"started"'))) continue;
    try {
      const j = JSON.parse(line) as Record<string, unknown>;
      const id = str(j.agentId);
      if (!id) continue;
      if (j.type === 'result') finished.add(id);
      else if (j.type === 'failed') (finished.add(id), failed.add(id));
      else if (j.type === 'started') {
        const phase = str(j.phase);
        if (phase && !phaseOrder.has(phase)) phaseOrder.set(phase, phaseOrder.size);
      }
    } catch {
      /* partial last line */
    }
  }
  return out;
}

/** All sub-agents of a session, by agent id: direct ones and those of Workflow runs. */
export function listAgents(transcriptPath: string): Map<string, AgentMeta> {
  const dir = subagentsDir(transcriptPath);
  const out = new Map<string, AgentMeta>();
  for (const n of readDir(dir)) {
    const m = FILE_RE.exec(n);
    if (!m?.[1]) continue;
    const agentId = m[1];
    const meta = readMeta(dir, agentId);
    out.set(agentId, {
      agentId,
      agentType: str(meta.agentType),
      toolUseId: str(meta.toolUseId),
      parentAgentId: str(meta.parentAgentId),
      spawnDepth: typeof meta.spawnDepth === 'number' ? meta.spawnDepth : null,
      file: join(dir, n),
      workflowId: null,
      label: null,
      workflowPhase: null,
      stageIndex: null,
      finished: false,
      failed: false,
    });
  }
  const wfRoot = join(dir, 'workflows');
  for (const wf of readDir(wfRoot)) {
    if (!WF_DIR_RE.test(wf)) continue;
    const wfDir = join(wfRoot, wf);
    const names = readDir(wfDir);
    const journal = names.includes('journal.jsonl') ? readJournal(wfDir) : emptyJournal();
    for (const n of names) {
      const m = FILE_RE.exec(n);
      if (!m?.[1] || out.has(m[1])) continue;
      const agentId = m[1];
      const meta = readMeta(wfDir, agentId);
      const phase = str(meta.workflowPhase);
      out.set(agentId, {
        agentId,
        agentType: str(meta.agentType),
        toolUseId: workflowKey(wf),
        parentAgentId: str(meta.parentAgentId),
        spawnDepth: typeof meta.spawnDepth === 'number' ? meta.spawnDepth : null,
        file: join(wfDir, n),
        workflowId: wf,
        label: str(meta.description),
        workflowPhase: phase,
        stageIndex: phase ? (journal.phaseOrder.get(phase) ?? null) : null,
        finished: journal.finished.has(agentId),
        failed: journal.failed.has(agentId),
      });
    }
  }
  return out;
}

/**
 * Whether the Workflow run is over (`<session>/workflows/<wf_id>.json` has a `status` other than
 * `running`). Reads only that field; the file also holds the workflow script and results.
 */
export function workflowOver(transcriptPath: string, workflowId: string): boolean {
  if (!WF_DIR_RE.test(workflowId)) return false;
  const file = join(dirname(transcriptPath), basename(transcriptPath, '.jsonl'), 'workflows', `${workflowId}.json`);
  const j = readJsonFile<{ status?: unknown }>(file);
  return typeof j?.status === 'string' && j.status !== 'running';
}

const slug = (s: string, max: number) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);

const FLOW_LABEL_RE = /^([^:]+):(.+)$/s;

/**
 * The item a workflow agent works on, from the label convention `<stage>:<item>` (ADR-0020): a slug of
 * `<item>` (≤ 64), or null when the label does not follow the convention or the slug is empty.
 */
export function flowKeyOf(label: string | null): string | null {
  const m = label ? FLOW_LABEL_RE.exec(label) : null;
  const key = m ? slug(m[2]!, 64) : '';
  return key || null;
}

/** `workflow:<label>` (a slug of the agent's label), or the meta agent type, or `workflow-subagent`. */
export function workflowAgentType(a: AgentMeta): string {
  const l = a.label ? slug(a.label, 48) : '';
  return l ? `workflow:${l}` : (a.agentType ?? 'workflow-subagent');
}

/**
 * The dashboard's read-time grouping rule for a stored `agent_type` (agentGroupOf in
 * apps/web/src/lib/queries/agent-groups.ts, ADR-0019): `workflow:<label>` → `workflow:<verb>` (first token
 * split on `[-:._/ ]`, lower-cased, trailing digits stripped; `workflow` without one), anything else → itself.
 * Kept identical so rows with and without a stored group land in the same group (parity test in workflows.test.ts).
 */
export function groupOfAgentType(agentType: string): string {
  const m = /^workflow:(.*)$/s.exec(agentType);
  if (!m) return agentType;
  const verb = (m[1]!.split(/[-:._/\s]+/)[0] ?? '').toLowerCase().replace(/\d+$/, '');
  return verb ? `workflow:${verb}` : 'workflow';
}

/**
 * `agent_group` of a workflow agent: `workflow:<phase slug>` when the phase is known, else the group the
 * dashboard derives from the stored agent type (`workflow:<verb of the label slug>`). The verb comes from the
 * slug, not the raw label, because the server only ever sees the slug (`Fix(m8) brief` → `workflow:fix`).
 */
export function workflowAgentGroup(a: AgentMeta): string {
  const phase = a.workflowPhase ? slug(a.workflowPhase, 48) : '';
  if (phase) return `workflow:${phase}`;
  return groupOfAgentType(workflowAgentType(a));
}

/** Agents spawned by these tool_use ids, plus all their descendants (nested sub-agents). */
export function agentsOfToolUses(agents: ReadonlyMap<string, AgentMeta>, toolUseIds: Iterable<string>): AgentMeta[] {
  const ids = new Set(toolUseIds);
  const picked = new Map<string, AgentMeta>();
  for (const a of agents.values()) if (a.toolUseId && ids.has(a.toolUseId) && !a.parentAgentId) picked.set(a.agentId, a);
  for (let grew = true; grew; ) {
    grew = false;
    for (const a of agents.values()) {
      if (!picked.has(a.agentId) && a.parentAgentId && picked.has(a.parentAgentId)) {
        picked.set(a.agentId, a);
        grew = true;
      }
    }
  }
  return [...picked.values()];
}

export function depthOf(a: AgentMeta, agents: ReadonlyMap<string, AgentMeta>): number {
  let depth = 1;
  const seen = new Set([a.agentId]);
  for (let p = a.parentAgentId; p && !seen.has(p); p = agents.get(p)?.parentAgentId ?? null) {
    seen.add(p);
    depth++;
  }
  if (isWorkflowKey(a.toolUseId) && !a.parentAgentId) return 1; // spawned by the main agent's Workflow call
  return a.parentAgentId ? depth : (a.spawnDepth ?? 1);
}

export interface BuiltRun {
  event: RunEvent;
  usage: UsageEntry[];
}

/** One `run` event for a sub-agent transcript (null when it has no model activity yet). */
export function buildRun(
  a: AgentMeta,
  agents: ReadonlyMap<string, AgentMeta>,
  input: { harness: string; turnId: string; agentTypeHint?: string | null; idSalt?: string },
): BuiltRun | null {
  const agg = analyzeEntries(readWholeTranscript(a.file));
  if (!agg.active) return null;
  const primary = primaryModel(agg.usage);
  const outcome: Outcome = provisionalOutcome({ interrupted: agg.interrupted, lastCheck: agg.lastCheck });
  const final: Outcome =
    a.failed
      ? { status: 'failed', signals: ['stop_failure'], provisional: false }
      : outcome.status === 'unknown' ? { status: 'success', signals: ['no_failure_signal'], provisional: false } : { ...outcome, provisional: false };
  const event = runEvent({
    harness: input.harness,
    ...(input.idSalt ? { idSalt: input.idSalt } : {}),
    turnId: input.turnId,
    runId: a.agentId,
    parentRunId: a.parentAgentId,
    agentType: a.workflowId ? workflowAgentType(a) : (a.agentType ?? input.agentTypeHint ?? 'unknown'),
    ...(a.workflowId
      ? { agentGroup: workflowAgentGroup(a), orchestrationId: a.workflowId, stageIndex: a.stageIndex, flowKey: flowKeyOf(a.label) }
      : (() => {
          const t = a.agentType ?? input.agentTypeHint ?? null;
          return t && t !== 'unknown' ? { agentGroup: t } : {};
        })()),
    depth: depthOf(a, agents),
    startedAt: agg.startedAt,
    endedAt: agg.endedAt,
    ...(primary ? { model: primary.model, effort: primary.effort } : {}),
    usage: agg.usage,
    phases: agg.phases,
    tools: agg.tools,
    skills: agg.skills,
    mcp: agg.mcp,
    mcpStats: agg.mcpStats,
    outcome: final,
    ...(a.workflowId
      ? { ext: { workflow_id: a.workflowId, ...(a.workflowPhase ? { workflow_phase: slug(a.workflowPhase, 48) } : {}), ...(a.label ? { workflow_label: slug(a.label, 48) } : {}) } }
      : {}),
  });
  return { event, usage: agg.usage };
}
