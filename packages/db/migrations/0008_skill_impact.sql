-- Hand-written (no schema change). Skill impact (docs/briefs/skill-impact.md, ADR-0017): per skill × project ×
-- primary model cell, the turns that used the skill (with_skill, the turn or one of its runs) against the other
-- turns of the same cell. Never returns user_id. Medians come from raw turns only; the rollup form has outcome
-- counts (days written with the outcome split) and null medians.
SET ROLE app_definer;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_skill_impact(p_from timestamptz, p_to timestamptz, p_team_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL, p_harness text DEFAULT NULL, p_model text DEFAULT NULL)
RETURNS TABLE (skill text, project_id uuid, model text, with_skill boolean, turns bigint, decided bigint, success bigint,
  priced_turns bigint, median_cost_usd double precision, median_tokens double precision, median_duration_ms double precision)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH scope AS (
    SELECT t.id, t.company_id, t.project_id, coalesce(t.model, 'unknown') AS model, t.outcome, t.duration_ms, t.skills,
      t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_write_tokens AS tokens,
      (t.started_at AT TIME ZONE 'UTC')::date AS day
    FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, p_model) t
  ), used AS (
    SELECT DISTINCT x.id AS turn_id, s.key AS skill
    FROM scope x
    CROSS JOIN LATERAL (SELECT x.skills UNION ALL SELECT r.skills FROM runs r WHERE r.turn_id = x.id AND r.company_id = x.company_id) u
    CROSS JOIN LATERAL jsonb_each(u.skills) s
  ), cells AS (
    SELECT DISTINCT u.skill, x.project_id, x.model FROM used u JOIN scope x ON x.id = u.turn_id
  ), pairs AS (
    SELECT c.skill, x.*, EXISTS (SELECT 1 FROM used u WHERE u.turn_id = x.id AND u.skill = c.skill) AS with_skill
    FROM cells c JOIN scope x ON x.project_id IS NOT DISTINCT FROM c.project_id AND x.model = c.model
  ), cost AS (
    SELECT x.id,
      CASE WHEN bool_or(c.usd IS NULL AND u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens > 0)
           THEN NULL ELSE coalesce(sum(c.usd), 0) END AS usd
    FROM (SELECT DISTINCT id, company_id, day FROM pairs) x
    JOIN usage u ON u.turn_id = x.id AND u.company_id = x.company_id
    CROSS JOIN LATERAL (SELECT estimate_cost_usd(u.model, x.day, u.input_tokens, u.output_tokens,
      u.cache_read_tokens, u.cache_write_tokens) AS usd) c
    GROUP BY x.id
  )
  SELECT p.skill, p.project_id, p.model, p.with_skill, count(*), count(*) FILTER (WHERE p.outcome <> 'unknown'),
    count(*) FILTER (WHERE p.outcome = 'success'), count(c.usd),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY c.usd::double precision),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY p.tokens),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY p.duration_ms)
  FROM pairs p LEFT JOIN cost c ON c.id = p.id
  GROUP BY 1, 2, 3, 4
$$;
--> statement-breakpoint
-- Long ranges: skill rows of daily_skill_mcp_rollups against the cell totals of daily_rollups (turns per primary
-- model), both restricted to rows written with the outcome split. The comparison side is cell − skill.
CREATE OR REPLACE FUNCTION agg_skill_impact_rollups(p_from date, p_to date, p_team_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL, p_harness text DEFAULT NULL, p_model text DEFAULT NULL)
RETURNS TABLE (skill text, project_id uuid, model text, with_skill boolean, turns bigint, decided bigint, success bigint,
  priced_turns bigint, median_cost_usd double precision, median_tokens double precision, median_duration_ms double precision)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH s AS (
    SELECT d.name AS skill, d.project_id, d.model, sum(d.turns)::bigint AS turns,
      sum(d.turns - d.unknown)::bigint AS decided, sum(d.success)::bigint AS success
    FROM daily_skill_mcp_rollups d
    WHERE d.company_id = app_company() AND d.kind = 'skill' AND d.tool = '' AND d.outcome_split
      AND d.day >= p_from AND d.day < p_to
      AND (d.user_id = app_user() OR app_is_admin() OR d.team_id = ANY (app_led_teams()))
      AND (p_team_id IS NULL OR d.team_id = p_team_id)
      AND (p_project_id IS NULL OR d.project_id = p_project_id)
      AND (p_harness IS NULL OR d.harness = p_harness)
      AND (p_model IS NULL OR d.model = p_model)
    GROUP BY 1, 2, 3
  ), cell AS (
    SELECT d.project_id, d.model, sum(d.turns)::bigint AS turns, sum(d.turns - d.unknown)::bigint AS decided,
      sum(d.success)::bigint AS success
    FROM daily_rollups d
    WHERE d.company_id = app_company() AND d.outcome_split
      AND d.day >= p_from AND d.day < p_to
      AND (d.user_id = app_user() OR app_is_admin() OR d.team_id = ANY (app_led_teams()))
      AND (p_team_id IS NULL OR d.team_id = p_team_id)
      AND (p_project_id IS NULL OR d.project_id = p_project_id)
      AND (p_harness IS NULL OR d.harness = p_harness)
      AND (p_model IS NULL OR d.model = p_model)
    GROUP BY 1, 2
  )
  SELECT s.skill, s.project_id, s.model, true, s.turns, s.decided, s.success, 0::bigint, NULL::double precision,
    NULL::double precision, NULL::double precision
  FROM s
  UNION ALL
  SELECT s.skill, s.project_id, s.model, false, greatest(c.turns - s.turns, 0), greatest(c.decided - s.decided, 0),
    greatest(c.success - s.success, 0), 0::bigint, NULL::double precision, NULL::double precision, NULL::double precision
  FROM s JOIN cell c ON c.project_id IS NOT DISTINCT FROM s.project_id AND c.model = s.model
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION agg_skill_impact(timestamptz, timestamptz, uuid, uuid, text, text),
  agg_skill_impact_rollups(date, date, uuid, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION agg_skill_impact(timestamptz, timestamptz, uuid, uuid, text, text),
  agg_skill_impact_rollups(date, date, uuid, uuid, text, text) TO app_definer, app_web;
--> statement-breakpoint
RESET ROLE;
