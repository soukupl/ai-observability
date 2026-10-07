-- Hand-written (no schema change). Effort advisor (docs/briefs/effort-advisor.md, ADR-0017): per project ×
-- primary model × effort, the turn counts, success and the medians of ≈ cost per turn and duration, from raw
-- turns. Never returns user_id. A turn's ≈ cost is the sum of its usage rows priced on the turn's UTC day
-- (estimate_cost_usd); a turn with an unpriced usage row (tokens > 0) has no cost and is left out of the cost
-- median (priced_turns counts the rest). Owned by app_definer like every agg_* function.
SET ROLE app_definer;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_effort_cells(p_from timestamptz, p_to timestamptz, p_team_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL, p_harness text DEFAULT NULL, p_model text DEFAULT NULL)
RETURNS TABLE (project_id uuid, model text, effort text, turns bigint, decided bigint, success bigint,
  priced_turns bigint, median_cost_usd double precision, median_duration_ms double precision)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH scope AS (
    SELECT t.id, t.company_id, t.project_id, t.model, t.effort, t.outcome, t.duration_ms,
      (t.started_at AT TIME ZONE 'UTC')::date AS day
    FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, p_model) t
    WHERE t.model IS NOT NULL AND t.effort IS NOT NULL
  ), cost AS (
    SELECT s.id,
      CASE WHEN bool_or(c.usd IS NULL AND u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens > 0)
           THEN NULL ELSE coalesce(sum(c.usd), 0) END AS usd
    FROM scope s
    JOIN usage u ON u.turn_id = s.id AND u.company_id = s.company_id
    CROSS JOIN LATERAL (SELECT estimate_cost_usd(u.model, s.day, u.input_tokens, u.output_tokens,
      u.cache_read_tokens, u.cache_write_tokens) AS usd) c
    GROUP BY s.id
  )
  SELECT s.project_id, s.model, s.effort, count(*), count(*) FILTER (WHERE s.outcome <> 'unknown'),
    count(*) FILTER (WHERE s.outcome = 'success'), count(c.usd),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY c.usd::double precision),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY s.duration_ms)
  FROM scope s LEFT JOIN cost c ON c.id = s.id
  GROUP BY 1, 2, 3
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION agg_effort_cells(timestamptz, timestamptz, uuid, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION agg_effort_cells(timestamptz, timestamptz, uuid, uuid, text, text) TO app_definer, app_web;
--> statement-breakpoint
RESET ROLE;
