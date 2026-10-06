-- Hand-written (no schema change). Two function fixes; CREATE OR REPLACE keeps owners and grants.

-- ≈ cost at API list prices with the model_prices row effective on p_day: the newest row with
-- effective_from <= p_day. A day before the model's earliest row falls back to that earliest row, so
-- history older than the first price (backfills, 12-month ranges, 24-month retention) is still costed
-- instead of showing n/a. NULL only for an unknown model or a NULL day. Reasoning tokens are part of
-- output tokens and are not billed again. Same rule as priceInEffect() in src/prices.ts.
CREATE OR REPLACE FUNCTION estimate_cost_usd(p_model text, p_day date, p_input bigint, p_output bigint,
  p_cache_read bigint, p_cache_write bigint) RETURNS numeric
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT (p_input * mp.input_per_mtok + p_output * mp.output_per_mtok
          + p_cache_read * mp.cache_read_per_mtok + p_cache_write * mp.cache_write_per_mtok) / 1000000
  FROM model_prices mp
  WHERE mp.model = p_model AND p_day IS NOT NULL
  ORDER BY (mp.effective_from <= p_day) DESC,
    CASE WHEN mp.effective_from <= p_day THEN mp.effective_from END DESC NULLS LAST,
    mp.effective_from ASC
  LIMIT 1
$$;
--> statement-breakpoint
-- agg_turn_list: tiebreak on id so OFFSET paging is stable when turns share a started_at (the direct
-- path already orders by started_at desc, id). Owned by app_definer, so replaced as app_definer (it
-- holds CREATE on public; see 0001).
SET ROLE app_definer;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_turn_list(p_from timestamptz, p_to timestamptz, p_team_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL, p_harness text DEFAULT NULL, p_model text DEFAULT NULL,
  p_outcome outcome DEFAULT NULL, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
RETURNS TABLE (id uuid, started_at timestamptz, ended_at timestamptz, duration_ms bigint, team_id uuid,
  project_id uuid, harness text, model text, effort text, input_tokens bigint, output_tokens bigint,
  cache_read_tokens bigint, cache_write_tokens bigint, reasoning_tokens bigint, outcome outcome,
  summary text, is_mine boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, t.started_at, t.ended_at, t.duration_ms, t.team_id, t.project_id, t.harness, t.model, t.effort,
    t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_write_tokens, t.reasoning_tokens,
    t.outcome, t.summary, t.user_id IS NOT DISTINCT FROM app_user()
  FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, p_model) t
  WHERE p_outcome IS NULL OR t.outcome = p_outcome
  ORDER BY t.started_at DESC, t.id
  LIMIT least(greatest(p_limit, 0), 1000) OFFSET greatest(p_offset, 0)
$$;
--> statement-breakpoint
RESET ROLE;
