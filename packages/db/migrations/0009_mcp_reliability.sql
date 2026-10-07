ALTER TABLE "runs" ADD COLUMN "mcp_stats" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "mcp_stats" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_skill_mcp_rollups" ADD COLUMN "errors" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_skill_mcp_rollups" ADD COLUMN "denied" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_skill_mcp_rollups" ADD COLUMN "latency_ms" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_skill_mcp_rollups" ADD COLUMN "lat0" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_skill_mcp_rollups" ADD COLUMN "lat1" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_skill_mcp_rollups" ADD COLUMN "lat2" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_skill_mcp_rollups" ADD COLUMN "lat3" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_skill_mcp_rollups" ADD COLUMN "lat4" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint

-- =============================== hand-written part ===============================
-- MCP reliability (docs/briefs/mcp-reliability.md, ADR-0016 amendment 2026-10-07): turns.mcp_stats / runs.mcp_stats
-- ({server: {tool: {errors, denied, ms, buckets[5]}}}) and the matching counters on daily_skill_mcp_rollups MCP rows.
GRANT UPDATE (mcp_stats) ON turns, runs TO app_ingest;
--> statement-breakpoint
SET ROLE app_definer;
--> statement-breakpoint
-- Per MCP server ('name' rows, tool = '') and server × tool ('tool' rows) of the caller's visible turns and their
-- runs: errors, denied, latency total and histogram. Never user_id.
CREATE OR REPLACE FUNCTION agg_mcp_reliability(p_from timestamptz, p_to timestamptz, p_team_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL, p_harness text DEFAULT NULL, p_model text DEFAULT NULL)
RETURNS TABLE (level text, name text, tool text, errors bigint, denied bigint, latency_ms bigint, lat0 bigint, lat1 bigint,
  lat2 bigint, lat3 bigint, lat4 bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH uses AS (
    SELECT u.mcp_stats
    FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, p_model) t
    CROSS JOIN LATERAL (
      SELECT t.mcp_stats UNION ALL SELECT r.mcp_stats FROM runs r WHERE r.turn_id = t.id AND r.company_id = t.company_id
    ) u
  ), flat AS (
    SELECT m.key AS name, tl.key AS tool, (tl.value->>'errors')::bigint AS errors, (tl.value->>'denied')::bigint AS denied,
      (tl.value->>'ms')::bigint AS ms, (tl.value->'buckets'->>0)::bigint AS b0, (tl.value->'buckets'->>1)::bigint AS b1,
      (tl.value->'buckets'->>2)::bigint AS b2, (tl.value->'buckets'->>3)::bigint AS b3, (tl.value->'buckets'->>4)::bigint AS b4
    FROM uses x CROSS JOIN LATERAL jsonb_each(x.mcp_stats) m CROSS JOIN LATERAL jsonb_each(m.value) tl
  )
  SELECT 'name', name, '', sum(errors)::bigint, sum(denied)::bigint, sum(ms)::bigint, sum(b0)::bigint, sum(b1)::bigint,
    sum(b2)::bigint, sum(b3)::bigint, sum(b4)::bigint
  FROM flat GROUP BY name
  UNION ALL
  SELECT 'tool', name, tool, sum(errors)::bigint, sum(denied)::bigint, sum(ms)::bigint, sum(b0)::bigint, sum(b1)::bigint,
    sum(b2)::bigint, sum(b3)::bigint, sum(b4)::bigint
  FROM flat GROUP BY name, tool
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_mcp_reliability_rollups(p_from date, p_to date, p_team_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL, p_harness text DEFAULT NULL, p_model text DEFAULT NULL)
RETURNS TABLE (level text, name text, tool text, errors bigint, denied bigint, latency_ms bigint, lat0 bigint, lat1 bigint,
  lat2 bigint, lat3 bigint, lat4 bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN d.tool = '' THEN 'name' ELSE 'tool' END, d.name, d.tool, sum(d.errors)::bigint, sum(d.denied)::bigint,
    sum(d.latency_ms)::bigint, sum(d.lat0)::bigint, sum(d.lat1)::bigint, sum(d.lat2)::bigint, sum(d.lat3)::bigint, sum(d.lat4)::bigint
  FROM daily_skill_mcp_rollups d
  WHERE d.company_id = app_company() AND d.kind = 'mcp'
    AND d.day >= p_from AND d.day < p_to
    AND (d.user_id = app_user() OR app_is_admin() OR d.team_id = ANY (app_led_teams()))
    AND (p_team_id IS NULL OR d.team_id = p_team_id)
    AND (p_project_id IS NULL OR d.project_id = p_project_id)
    AND (p_harness IS NULL OR d.harness = p_harness)
    AND (p_model IS NULL OR d.model = p_model)
  GROUP BY 1, 2, 3
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION agg_mcp_reliability(timestamptz, timestamptz, uuid, uuid, text, text),
  agg_mcp_reliability_rollups(date, date, uuid, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION agg_mcp_reliability(timestamptz, timestamptz, uuid, uuid, text, text),
  agg_mcp_reliability_rollups(date, date, uuid, uuid, text, text) TO app_definer, app_web;
--> statement-breakpoint
RESET ROLE;
