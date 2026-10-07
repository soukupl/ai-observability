ALTER TABLE "daily_rollups" ADD COLUMN "wasted_input_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_rollups" ADD COLUMN "wasted_output_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_rollups" ADD COLUMN "wasted_cache_read_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_rollups" ADD COLUMN "wasted_cache_write_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_rollups" ADD COLUMN "unknown_input_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_rollups" ADD COLUMN "unknown_output_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_rollups" ADD COLUMN "unknown_cache_read_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_rollups" ADD COLUMN "unknown_cache_write_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_rollups" ADD COLUMN "outcome_split" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_skill_mcp_rollups" ADD COLUMN "success" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_skill_mcp_rollups" ADD COLUMN "failed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_skill_mcp_rollups" ADD COLUMN "abandoned" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_skill_mcp_rollups" ADD COLUMN "unknown" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_skill_mcp_rollups" ADD COLUMN "outcome_split" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- =============================== hand-written part ===============================
-- Outcome-split rollups (ADR-0017): daily_rollups keep the tokens of wasted (failed / abandoned) and of unknown-
-- outcome turns, daily_skill_mcp_rollups the outcome counts of the turns per row. Both are written by the worker
-- from now on (outcome_split = true). Every day that still has raw turns is re-queued below so the next rollup
-- pass rewrites it with the split; days whose raw turns are gone keep outcome_split = false ("n/a" in the views).
SET ROLE app_definer;
--> statement-breakpoint
UPDATE turns SET updated_at = now();
--> statement-breakpoint

-- Wasted spend (docs/briefs/wasted-spend.md) from raw rows: tokens per usage day × team × project × usage model ×
-- usage effort × outcome class of the turn ('wasted' = failed / abandoned, 'unknown', 'ok'). Never user_id.
-- The model filter applies to the usage row's model, as on every token view.
CREATE OR REPLACE FUNCTION agg_wasted(p_from timestamptz, p_to timestamptz, p_team_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL, p_harness text DEFAULT NULL, p_model text DEFAULT NULL)
RETURNS TABLE (day date, team_id uuid, project_id uuid, model text, effort text, class text, input_tokens bigint,
  output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (u.started_at AT TIME ZONE 'UTC')::date, t.team_id, t.project_id, u.model, u.effort,
    CASE WHEN t.outcome IN ('failed', 'abandoned') THEN 'wasted' WHEN t.outcome = 'unknown' THEN 'unknown' ELSE 'ok' END,
    sum(u.input_tokens)::bigint, sum(u.output_tokens)::bigint, sum(u.cache_read_tokens)::bigint, sum(u.cache_write_tokens)::bigint
  FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, NULL) t
  JOIN usage u ON u.turn_id = t.id AND u.company_id = t.company_id
  WHERE p_model IS NULL OR u.model = p_model
  GROUP BY 1, 2, 3, 4, 5, 6
  HAVING sum(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens) > 0
$$;
--> statement-breakpoint
-- The same from daily_rollups (long ranges). `split` = every token-carrying row of the group has the outcome split.
CREATE OR REPLACE FUNCTION agg_wasted_rollups(p_from date, p_to date, p_team_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL, p_harness text DEFAULT NULL, p_model text DEFAULT NULL)
RETURNS TABLE (day date, team_id uuid, project_id uuid, model text, effort text, split boolean, input_tokens bigint,
  output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint, wasted_input_tokens bigint,
  wasted_output_tokens bigint, wasted_cache_read_tokens bigint, wasted_cache_write_tokens bigint,
  unknown_input_tokens bigint, unknown_output_tokens bigint, unknown_cache_read_tokens bigint,
  unknown_cache_write_tokens bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.day, d.team_id, d.project_id, d.model, d.effort,
    coalesce(bool_and(d.outcome_split) FILTER (WHERE d.input_tokens + d.output_tokens + d.cache_read_tokens + d.cache_write_tokens > 0), true),
    sum(d.input_tokens)::bigint, sum(d.output_tokens)::bigint, sum(d.cache_read_tokens)::bigint, sum(d.cache_write_tokens)::bigint,
    sum(d.wasted_input_tokens)::bigint, sum(d.wasted_output_tokens)::bigint, sum(d.wasted_cache_read_tokens)::bigint,
    sum(d.wasted_cache_write_tokens)::bigint, sum(d.unknown_input_tokens)::bigint, sum(d.unknown_output_tokens)::bigint,
    sum(d.unknown_cache_read_tokens)::bigint, sum(d.unknown_cache_write_tokens)::bigint
  FROM daily_rollups d
  WHERE d.company_id = app_company()
    AND d.day >= p_from AND d.day < p_to
    AND (d.user_id = app_user() OR app_is_admin() OR d.team_id = ANY (app_led_teams()))
    AND (p_team_id IS NULL OR d.team_id = p_team_id)
    AND (p_project_id IS NULL OR d.project_id = p_project_id)
    AND (p_harness IS NULL OR d.harness = p_harness)
    AND (p_model IS NULL OR d.model = p_model)
  GROUP BY 1, 2, 3, 4, 5
  HAVING sum(d.input_tokens + d.output_tokens + d.cache_read_tokens + d.cache_write_tokens) > 0
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION agg_wasted(timestamptz, timestamptz, uuid, uuid, text, text),
  agg_wasted_rollups(date, date, uuid, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION agg_wasted(timestamptz, timestamptz, uuid, uuid, text, text),
  agg_wasted_rollups(date, date, uuid, uuid, text, text) TO app_definer, app_web;
--> statement-breakpoint
RESET ROLE;
