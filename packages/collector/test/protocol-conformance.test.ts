import {
  schemas,
  validateBatch,
  type CollectorConfigResponse as ProtocolCollectorConfigResponse,
  type IngestBatchInput,
  type IngestEventInput,
  MAX_BATCH_BYTES,
  MAX_BATCH_EVENTS,
  MAX_RUN_LINKS,
  MAX_STAGE_INDEX,
  MAX_SUMMARY_LENGTH,
  PHASES,
  SCHEMA_VERSION,
  TOKEN_PREFIXES,
} from '@ai-obs/protocol';
import { describe, expect, it } from 'vitest';
import { provisionalOutcome } from '../src/analysis/outcome.js';
import { emptyPhaseTotals } from '../src/analysis/phases.js';
import { sumUsage } from '../src/analysis/tokens.js';
import { buildConfig } from '../src/config.js';
import { countTools, runEvent, sessionEndEvent, sessionStartEvent, sessionTitleEvent, turnEvent, turnOutcomeEvent, turnSummaryEvent } from '../src/events.js';
import * as local from '../src/protocol-types.js';
import { buildEnvelope } from '../src/sender.js';

const harness = 'claude-code';
const usage = sumUsage([{ responseId: 'r1', model: 'claude-opus-5-5', effort: 'high', input: 10, output: 20, cacheRead: 5 }]);
const phases = { ...emptyPhaseTotals(), thinking: 1000.4, coding: 2000, delegating: 5000 };

function allEvents(): local.IngestEvent[] {
  return [
    sessionStartEvent({ harness, sessionId: 's1', at: '2026-10-05T10:00:00Z', harnessVersion: '2.1.0', project: { key: 'github.com/acme/billing', name: 'billing' } }),
    turnEvent({
      harness, sessionId: 's1', turnId: 't1', startedAt: '2026-10-05T10:00:05Z', endedAt: '2026-10-05T10:04:05Z',
      model: 'claude-opus-5-5', effort: 'high', usage, phases, tools: countTools(['Edit', 'Edit', 'Bash', 'mcp__srv__x']),
      filesTouched: 2, linesAdded: 10, linesRemoved: 3, outcome: provisionalOutcome({}),
    }),
    runEvent({
      harness, turnId: 't1', runId: 'agent-1', parentRunId: null, agentType: 'Explore', depth: 1,
      startedAt: new Date('2026-10-05T10:01:00Z'), endedAt: Date.parse('2026-10-05T10:02:00Z'), model: 'claude-haiku-4-5', effort: null,
      usage, phases, outcome: provisionalOutcome({ lastCheck: { kind: 'testing', exitCode: 0 } }),
    }),
    runEvent({
      harness, turnId: 't1', runId: 'agent-2', parentRunId: null, agentType: 'workflow:verify-data', agentGroup: 'workflow:verify',
      orchestrationId: 'wf_1', stageIndex: 1, flowKey: 'data', links: [{ fromRunId: 'agent-1', kind: 'item' }, { fromRunId: 'agent-1', kind: 'sequence' }],
      depth: 1, startedAt: '2026-10-05T10:02:00Z', endedAt: '2026-10-05T10:03:00Z', usage, phases, outcome: provisionalOutcome({}),
    }),
    turnOutcomeEvent({ harness, turnId: 't1', outcome: { status: 'failed', signals: ['next_prompt_correction'], provisional: false }, at: '2026-10-05T10:05:00Z' }),
    turnSummaryEvent({ harness, turnId: 't1', summary: 'Added JWT refresh to auth middleware '.repeat(10), at: '2026-10-05T10:30:00Z' })!,
    sessionEndEvent({ harness, sessionId: 's1', reason: 'exit', at: '2026-10-05T10:30:00Z' }),
    sessionTitleEvent({ harness, sessionId: 's1', title: 'Auth middleware JWT refresh '.repeat(10), source: 'custom', at: '2026-10-05T10:30:00Z' })!,
  ];
}

describe('collector events conform to @ai-obs/protocol', () => {
  it('every builder output passes validateBatch', () => {
    const config = buildConfig({ endpoint: 'https://obs.example.com', token: 'aiobs_u_x', gitEmail: 'dev@acme.com' });
    const batch = buildEnvelope(config, allEvents());
    const r = validateBatch(JSON.parse(JSON.stringify(batch)));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rejected).toEqual([]);
      expect(r.events).toHaveLength(8);
      // the flow fields survive validation (ADR-0020)
      expect(r.events.find((e) => e.type === 'run' && e.run_id === 'agent-2')).toMatchObject({
        stage_index: 1,
        flow_key: 'data',
        links: [{ from_run_id: 'agent-1', kind: 'item' }, { from_run_id: 'agent-1', kind: 'sequence' }],
      });
    }
  });

  it('local types are assignable to the protocol input types (compile-time)', () => {
    const events: IngestEventInput[] = allEvents();
    const batch: IngestBatchInput = buildEnvelope(buildConfig({ endpoint: 'https://x.io', token: 'aiobs_c_x' }), allEvents());
    expect(events.length + batch.events.length).toBe(16);
  });

  it('token prefixes match the server: user and company tokens are accepted, the dropped team prefix is not (ADR-0022)', () => {
    expect([local.USER_TOKEN_PREFIX, local.COMPANY_TOKEN_PREFIX]).toEqual([TOKEN_PREFIXES.user, TOKEN_PREFIXES.company]);
    expect(Object.keys(TOKEN_PREFIXES).sort()).toEqual(['company', 'user']);
    expect(buildConfig({ endpoint: 'https://x.io', token: 'aiobs_c_abc' }).tokens[0]?.token).toBe('aiobs_c_abc');
    expect(() => buildConfig({ endpoint: 'https://x.io', token: `${local.LEGACY_TEAM_TOKEN_PREFIX}abc` })).toThrow(/aiobs_u_ or aiobs_c_/);
  });

  it('collector-config: the local response type (company, user) matches the protocol schema both ways', () => {
    const user: local.CollectorConfigResponse = {
      project_naming: 'hashed',
      min_collector_version: '0.2.0',
      project_salt: 'company-salt-0123456789',
      company: { name: 'Acme Corp', slug: 'acme' },
      user: { email: 'alice@acme.example' },
    };
    const company: local.CollectorConfigResponse = { project_naming: 'plain', min_collector_version: '0.2.0', company: { name: 'Globex', slug: 'globex' }, user: null };
    const older: local.CollectorConfigResponse = { project_naming: 'plain', min_collector_version: '0.1.0' };
    for (const v of [user, company, older]) {
      const asProtocol: ProtocolCollectorConfigResponse = v; // compile-time: local → protocol
      const back: local.CollectorConfigResponse = schemas.collectorConfigResponse.parse(asProtocol); // protocol → local
      expect(back).toEqual(v);
    }
  });

  it('constants match', () => {
    expect(local.SCHEMA_VERSION).toBe(SCHEMA_VERSION);
    expect(local.MAX_BATCH_EVENTS).toBe(MAX_BATCH_EVENTS);
    expect(local.MAX_BATCH_BYTES).toBe(MAX_BATCH_BYTES);
    expect(local.MAX_SUMMARY_LENGTH).toBe(MAX_SUMMARY_LENGTH);
    expect([...local.PHASES]).toEqual([...PHASES]);
    expect(local.MAX_RUN_LINKS).toBe(MAX_RUN_LINKS);
    expect(local.MAX_STAGE_INDEX).toBe(MAX_STAGE_INDEX);
  });

  it('drops delegating, rounds phases, clamps end ≥ start, truncates summary, collapses MCP tools', () => {
    const [, turn, , , , summary] = allEvents() as [unknown, local.TurnEvent, unknown, unknown, unknown, local.TurnSummaryEvent];
    expect(turn.phases_ms).toEqual({ thinking: 1000, coding: 2000 });
    expect(turn.tools).toEqual({ edit: 2, bash: 1, mcp: 1 });
    expect(summary.summary.length).toBeLessThanOrEqual(140);
    const t = turnEvent({ ...{ harness, sessionId: 's', turnId: 't', model: 'm', effort: null, usage: [], phases: {}, outcome: provisionalOutcome({}) }, startedAt: 2000, endedAt: 1000 });
    expect(t.ended_at).toBe(t.started_at);
  });

  it('event ids are deterministic: re-processing yields the same ids', () => {
    const a = allEvents().map((e) => e.event_id);
    const b = allEvents().map((e) => e.event_id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
    const salted = turnOutcomeEvent({ harness, turnId: 't1', outcome: provisionalOutcome({}), at: 0, idSalt: 'x' });
    expect(salted.event_id).not.toBe(turnOutcomeEvent({ harness, turnId: 't1', outcome: provisionalOutcome({}), at: 0 }).event_id);
  });

  it('rejects path-like project keys', () => {
    const e = sessionStartEvent({ harness, sessionId: 's', at: 0, project: { key: '/Users/dev/repo' } });
    expect(e.project).toBeUndefined();
  });
});
