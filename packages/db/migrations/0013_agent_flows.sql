-- =============================== hand-written part ===============================
-- Agent flows view (docs/briefs/agent-flows-view.md, ADR-0020 amendment 2026-10-08). No column changes: flows are
-- computed in the query layer from runs and run_links. This migration adds the aggregates-only read path of the
-- /flows list (agg_flow_runs / agg_flow_links) and appends skills / mcp to agg_turn_runs, so the aggregate turn and
-- flow detail paths can show the skills and MCP calls per step like the raw path.
SET ROLE app_definer;
--> statement-breakpoint
-- The result type changes (skills, mcp appended after orchestration_id, so existing positions stay), hence DROP +
-- CREATE. Same scope as before: own turns, admins the company, leads their led teams. Never user_id.
DROP FUNCTION agg_turn_runs(uuid);
--> statement-breakpoint
CREATE FUNCTION agg_turn_runs(p_turn_id uuid)
RETURNS TABLE (id uuid, parent_run_id uuid, agent_type text, depth integer, model text, effort text,
  started_at timestamptz, ended_at timestamptz, duration_ms bigint, input_tokens bigint, output_tokens bigint,
  cache_read_tokens bigint, cache_write_tokens bigint, reasoning_tokens bigint, phases_ms jsonb, tools jsonb,
  outcome outcome, agent_group text, stage_index integer, flow_key text, orchestration_id text, skills jsonb, mcp jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.parent_run_id, r.agent_type, r.depth, r.model, r.effort, r.started_at, r.ended_at, r.duration_ms,
    r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens, r.reasoning_tokens,
    r.phases_ms, r.tools, r.outcome, r.agent_group, r.stage_index, r.flow_key, r.orchestration_id, r.skills, r.mcp
  FROM turns t JOIN runs r ON r.turn_id = t.id AND r.company_id = t.company_id
  WHERE t.id = p_turn_id AND t.company_id = app_company()
    AND (t.user_id = app_user() OR app_is_admin() OR t.team_id = ANY (app_led_teams()))
  ORDER BY r.started_at
$$;
--> statement-breakpoint
-- Flow list, runs: every run of the turns that STARTED in [p_from, p_to) (agg_scope_turns, like the other range views;
-- a flow belongs to its turn, so runs that outlive the window stay with it), with the turn's start, project, harness,
-- summary and is_mine. Never user_id. Ordered by the run's start; the limit is capped at 20001 (the default + 1, so a
-- caller can detect truncation either way).
CREATE FUNCTION agg_flow_runs(p_from timestamptz, p_to timestamptz, p_team_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL, p_harness text DEFAULT NULL, p_model text DEFAULT NULL, p_limit integer DEFAULT 20000)
RETURNS TABLE (id uuid, turn_id uuid, parent_run_id uuid, agent_type text, agent_group text, orchestration_id text,
  stage_index integer, flow_key text, depth integer, model text, effort text, started_at timestamptz,
  ended_at timestamptz, duration_ms bigint, input_tokens bigint, output_tokens bigint, cache_read_tokens bigint,
  cache_write_tokens bigint, reasoning_tokens bigint, outcome outcome, turn_started_at timestamptz,
  turn_project_id uuid, turn_harness text, turn_summary text, turn_is_mine boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.turn_id, r.parent_run_id, r.agent_type, r.agent_group, r.orchestration_id, r.stage_index, r.flow_key,
    r.depth, r.model, r.effort, r.started_at, r.ended_at, r.duration_ms, r.input_tokens, r.output_tokens,
    r.cache_read_tokens, r.cache_write_tokens, r.reasoning_tokens, r.outcome,
    t.started_at, t.project_id, t.harness, t.summary, t.user_id IS NOT DISTINCT FROM app_user()
  FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, p_model) t
  JOIN runs r ON r.turn_id = t.id AND r.company_id = t.company_id
  ORDER BY r.started_at, r.id
  LIMIT least(greatest(p_limit, 0), 20001)
$$;
--> statement-breakpoint
-- Flow list, links: resolved links (both run ids set) whose target run is in the agg_flow_runs scope; the source is a
-- run of the same turn. Ordered by the target's start; the limit is capped at 20001. Run ids only, never user_id.
CREATE FUNCTION agg_flow_links(p_from timestamptz, p_to timestamptz, p_team_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL, p_harness text DEFAULT NULL, p_model text DEFAULT NULL, p_limit integer DEFAULT 20000)
RETURNS TABLE (from_run_id uuid, to_run_id uuid, kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.from_run_id, l.to_run_id, l.kind
  FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, p_model) t
  JOIN runs r ON r.turn_id = t.id AND r.company_id = t.company_id
  JOIN run_links l ON l.to_run_id = r.id AND l.company_id = r.company_id
  JOIN runs f ON f.id = l.from_run_id AND f.company_id = l.company_id AND f.turn_id = t.id
  ORDER BY r.started_at, r.id, l.from_run_id, l.kind
  LIMIT least(greatest(p_limit, 0), 20001)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION agg_turn_runs(uuid),
  agg_flow_runs(timestamptz, timestamptz, uuid, uuid, text, text, integer),
  agg_flow_links(timestamptz, timestamptz, uuid, uuid, text, text, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION agg_turn_runs(uuid),
  agg_flow_runs(timestamptz, timestamptz, uuid, uuid, text, text, integer),
  agg_flow_links(timestamptz, timestamptz, uuid, uuid, text, text, integer) TO app_definer, app_web;
--> statement-breakpoint
RESET ROLE;
