ALTER TABLE "runs" ADD COLUMN "agent_group" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "orchestration_id" text;--> statement-breakpoint

-- =============================== hand-written part ===============================
-- Agent groups and the agent timeline (docs/briefs/agent-groups-and-timeline.md, ADR-0019): runs.agent_group /
-- runs.orchestration_id (protocol v1, optional), agg_agents per agent_type × agent_group, and the aggregates-only read
-- path of the timeline (agg_timeline_turns / agg_timeline_runs). app_ingest has table-level INSERT on runs (0001);
-- UPDATE is per column, so the new columns need their own grant.
GRANT UPDATE (agent_group, orchestration_id) ON runs TO app_ingest;
--> statement-breakpoint
SET ROLE app_definer;
--> statement-breakpoint
-- The result type changes (agent_group), so CREATE OR REPLACE is not enough. Same arguments as before.
DROP FUNCTION agg_agents(timestamptz, timestamptz, uuid, uuid, text, text);
--> statement-breakpoint
-- Sub-agent usage by agent type × stored agent group (runs of visible turns). agent_group is null for runs from
-- collectors that do not send it; the dashboard derives the group from agent_type then (agentGroupOf).
CREATE FUNCTION agg_agents(p_from timestamptz, p_to timestamptz, p_team_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL, p_harness text DEFAULT NULL, p_model text DEFAULT NULL)
RETURNS TABLE (agent_type text, agent_group text, runs bigint, success bigint, failed bigint, abandoned bigint,
  unknown bigint, duration_ms bigint, input_tokens bigint, output_tokens bigint, cache_read_tokens bigint,
  cache_write_tokens bigint, reasoning_tokens bigint, avg_depth numeric, max_depth integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.agent_type, r.agent_group, count(*),
    count(*) FILTER (WHERE r.outcome = 'success'), count(*) FILTER (WHERE r.outcome = 'failed'),
    count(*) FILTER (WHERE r.outcome = 'abandoned'), count(*) FILTER (WHERE r.outcome = 'unknown'),
    sum(r.duration_ms)::bigint, sum(r.input_tokens)::bigint, sum(r.output_tokens)::bigint,
    sum(r.cache_read_tokens)::bigint, sum(r.cache_write_tokens)::bigint, sum(r.reasoning_tokens)::bigint,
    avg(r.depth), max(r.depth)
  FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, p_model) t
  JOIN runs r ON r.turn_id = t.id AND r.company_id = t.company_id
  GROUP BY r.agent_type, r.agent_group
$$;
--> statement-breakpoint
-- Timeline window, turns: visible turns that OVERLAP [p_from, p_to) (started_at < p_to AND ended_at > p_from), plus
-- the parent turns of runs that overlap it (background workflow agents keep running long after the turn that launched
-- them ended; their branch is drawn on the parent turn's lane). agg_scope_turns selects by started_at, so it is called
-- with a one-day look-back. Never user_id or names; is_mine marks the caller's own turns (like agg_turn_list).
-- session_id is a per-window pseudonym (md5 of the session id and the window), never the stored id: it groups the
-- turns of one session into a lane inside this window but cannot be correlated across windows, days or other reads.
-- The limit is capped at 1001 (the default + 1, so a caller can detect truncation either way).
CREATE OR REPLACE FUNCTION agg_timeline_turns(p_from timestamptz, p_to timestamptz, p_team_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL, p_harness text DEFAULT NULL, p_model text DEFAULT NULL, p_limit integer DEFAULT 1000)
RETURNS TABLE (id uuid, session_id uuid, project_id uuid, harness text, model text, started_at timestamptz,
  ended_at timestamptz, duration_ms bigint, input_tokens bigint, output_tokens bigint, cache_read_tokens bigint,
  cache_write_tokens bigint, reasoning_tokens bigint, outcome outcome, summary text, is_mine boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, md5(t.session_id::text || '|' || p_from::text || '|' || p_to::text)::uuid, t.project_id, t.harness,
    t.model, t.started_at, t.ended_at, t.duration_ms,
    t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_write_tokens, t.reasoning_tokens,
    t.outcome, t.summary, t.user_id IS NOT DISTINCT FROM app_user()
  FROM agg_scope_turns(p_from - interval '1 day', p_to, p_team_id, p_project_id, p_harness, p_model) t
  WHERE t.ended_at > p_from
    OR EXISTS (SELECT 1 FROM runs r WHERE r.turn_id = t.id AND r.company_id = t.company_id
      AND r.started_at < p_to AND r.ended_at > p_from)
  ORDER BY t.started_at, t.id
  LIMIT least(greatest(p_limit, 0), 1001)
$$;
--> statement-breakpoint
-- Timeline window, runs: runs of the same turn scope (incl. the look-back) that overlap [p_from, p_to). Never user_id.
-- The limit is capped at 5001 (the default + 1).
CREATE OR REPLACE FUNCTION agg_timeline_runs(p_from timestamptz, p_to timestamptz, p_team_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL, p_harness text DEFAULT NULL, p_model text DEFAULT NULL, p_limit integer DEFAULT 5000)
RETURNS TABLE (id uuid, turn_id uuid, parent_run_id uuid, agent_type text, agent_group text, orchestration_id text,
  depth integer, model text, started_at timestamptz, ended_at timestamptz, duration_ms bigint, input_tokens bigint,
  output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint, reasoning_tokens bigint, outcome outcome)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.turn_id, r.parent_run_id, r.agent_type, r.agent_group, r.orchestration_id, r.depth, r.model,
    r.started_at, r.ended_at, r.duration_ms, r.input_tokens, r.output_tokens, r.cache_read_tokens,
    r.cache_write_tokens, r.reasoning_tokens, r.outcome
  FROM agg_scope_turns(p_from - interval '1 day', p_to, p_team_id, p_project_id, p_harness, p_model) t
  JOIN runs r ON r.turn_id = t.id AND r.company_id = t.company_id
  WHERE r.started_at < p_to AND r.ended_at > p_from
  ORDER BY r.started_at, r.id
  LIMIT least(greatest(p_limit, 0), 5001)
$$;
--> statement-breakpoint
-- Turn detail draws the same graph as the timeline, so its runs need the stored agent_group too. The result type
-- changes (agent_group appended last, so existing column positions stay), hence DROP + CREATE.
DROP FUNCTION agg_turn_runs(uuid);
--> statement-breakpoint
CREATE FUNCTION agg_turn_runs(p_turn_id uuid)
RETURNS TABLE (id uuid, parent_run_id uuid, agent_type text, depth integer, model text, effort text,
  started_at timestamptz, ended_at timestamptz, duration_ms bigint, input_tokens bigint, output_tokens bigint,
  cache_read_tokens bigint, cache_write_tokens bigint, reasoning_tokens bigint, phases_ms jsonb, tools jsonb,
  outcome outcome, agent_group text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.parent_run_id, r.agent_type, r.depth, r.model, r.effort, r.started_at, r.ended_at, r.duration_ms,
    r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens, r.reasoning_tokens,
    r.phases_ms, r.tools, r.outcome, r.agent_group
  FROM turns t JOIN runs r ON r.turn_id = t.id AND r.company_id = t.company_id
  WHERE t.id = p_turn_id AND t.company_id = app_company()
    AND (t.user_id = app_user() OR app_is_admin() OR t.team_id = ANY (app_led_teams()))
  ORDER BY r.started_at
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION agg_agents(timestamptz, timestamptz, uuid, uuid, text, text),
  agg_timeline_turns(timestamptz, timestamptz, uuid, uuid, text, text, integer),
  agg_timeline_runs(timestamptz, timestamptz, uuid, uuid, text, text, integer), agg_turn_runs(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION agg_agents(timestamptz, timestamptz, uuid, uuid, text, text),
  agg_timeline_turns(timestamptz, timestamptz, uuid, uuid, text, text, integer),
  agg_timeline_runs(timestamptz, timestamptz, uuid, uuid, text, text, integer), agg_turn_runs(uuid) TO app_definer, app_web;
--> statement-breakpoint
RESET ROLE;
