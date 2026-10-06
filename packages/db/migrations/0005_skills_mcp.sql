CREATE TABLE "daily_skill_mcp_rollups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"day" date NOT NULL,
	"team_id" uuid,
	"user_id" uuid,
	"project_id" uuid,
	"harness" text NOT NULL,
	"model" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"tool" text DEFAULT '' NOT NULL,
	"calls" bigint DEFAULT 0 NOT NULL,
	"model_calls" bigint DEFAULT 0 NOT NULL,
	"user_calls" bigint DEFAULT 0 NOT NULL,
	"turns" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_skill_mcp_rollups_kind" CHECK ("daily_skill_mcp_rollups"."kind" in ('skill', 'mcp'))
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "skills" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "mcp" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "skills" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "mcp" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_skill_mcp_rollups" ADD CONSTRAINT "daily_skill_mcp_rollups_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_skill_mcp_rollups" ADD CONSTRAINT "daily_skill_mcp_rollups_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_skill_mcp_rollups" ADD CONSTRAINT "daily_skill_mcp_rollups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_skill_mcp_rollups" ADD CONSTRAINT "daily_skill_mcp_rollups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_skill_mcp_rollups_company_day_idx" ON "daily_skill_mcp_rollups" USING btree ("company_id","day");--> statement-breakpoint
CREATE INDEX "daily_skill_mcp_rollups_company_team_day_idx" ON "daily_skill_mcp_rollups" USING btree ("company_id","team_id","day");--> statement-breakpoint
CREATE INDEX "daily_skill_mcp_rollups_user_idx" ON "daily_skill_mcp_rollups" USING btree ("user_id");--> statement-breakpoint

-- =============================== hand-written part ===============================
-- Skill and MCP usage (docs/briefs/skills-and-mcp-stats.md, ADR-0016). turns / runs get `skills` and `mcp`
-- (names follow the company's project-naming mode); daily_skill_mcp_rollups is written by the worker in
-- the same slice transaction as daily_rollups and follows its rules (packages/db README).

-- Tenant table: RLS enabled and forced, the same policies as daily_rollups.
ALTER TABLE daily_skill_mcp_rollups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE daily_skill_mcp_rollups FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON daily_skill_mcp_rollups TO app_definer;
--> statement-breakpoint
CREATE POLICY definer_all ON daily_skill_mcp_rollups TO app_definer USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT ON daily_skill_mcp_rollups TO app_web;
--> statement-breakpoint
CREATE POLICY web_select ON daily_skill_mcp_rollups FOR SELECT TO app_web USING (
  company_id = (SELECT app_company())
  AND (user_id = (SELECT app_user())
       OR ((SELECT app_full_visibility())
           AND ((SELECT app_is_admin()) OR team_id = ANY ((SELECT app_led_teams())::uuid[])))));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON daily_skill_mcp_rollups TO app_worker;
--> statement-breakpoint
CREATE POLICY worker_all ON daily_skill_mcp_rollups TO app_worker USING (true) WITH CHECK (true);
--> statement-breakpoint

-- app_ingest's UPDATE grants on turns / runs are per column (0001) and do not cover columns added later.
GRANT UPDATE (skills, mcp) ON turns, runs TO app_ingest;
--> statement-breakpoint

SET ROLE app_definer;
--> statement-breakpoint

-- Skill / MCP use of the caller's visible turns (each turn plus its runs), never user_id. Rows by `level`:
--   'name' (kind, name), 'tool' (MCP server × tool) and 'day' (day × kind × name). `turns` / `users` are
--   distinct counts at that level. MCP calls are always the model's: model_calls = calls, user_calls = 0.
CREATE OR REPLACE FUNCTION agg_skill_mcp(p_from timestamptz, p_to timestamptz, p_team_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL, p_harness text DEFAULT NULL, p_model text DEFAULT NULL)
RETURNS TABLE (level text, day date, kind text, name text, tool text, calls bigint, model_calls bigint,
  user_calls bigint, turns bigint, users bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH uses AS (
    SELECT t.id AS turn_id, t.user_id, (t.started_at AT TIME ZONE 'UTC')::date AS day, u.skills, u.mcp
    FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, p_model) t
    CROSS JOIN LATERAL (
      SELECT t.skills, t.mcp
      UNION ALL
      SELECT r.skills, r.mcp FROM runs r WHERE r.turn_id = t.id AND r.company_id = t.company_id
    ) u
  ), flat AS (
    SELECT x.turn_id, x.user_id, x.day, 'skill'::text AS kind, s.key AS name, ''::text AS tool,
      coalesce((s.value->>'model')::bigint, 0) AS model_calls, coalesce((s.value->>'user')::bigint, 0) AS user_calls
    FROM uses x CROSS JOIN LATERAL jsonb_each(x.skills) s
    UNION ALL
    SELECT x.turn_id, x.user_id, x.day, 'mcp', m.key, tl.key, (tl.value #>> '{}')::bigint, 0
    FROM uses x CROSS JOIN LATERAL jsonb_each(x.mcp) m CROSS JOIN LATERAL jsonb_each(m.value) tl
  )
  SELECT 'name', NULL::date, kind, name, '', sum(model_calls + user_calls)::bigint, sum(model_calls)::bigint,
    sum(user_calls)::bigint, count(DISTINCT turn_id), count(DISTINCT user_id)
  FROM flat GROUP BY kind, name
  UNION ALL
  SELECT 'tool', NULL::date, kind, name, tool, sum(model_calls + user_calls)::bigint, sum(model_calls)::bigint,
    sum(user_calls)::bigint, count(DISTINCT turn_id), count(DISTINCT user_id)
  FROM flat WHERE kind = 'mcp' GROUP BY kind, name, tool
  UNION ALL
  SELECT 'day', day, kind, name, '', sum(model_calls + user_calls)::bigint, sum(model_calls)::bigint,
    sum(user_calls)::bigint, count(DISTINCT turn_id), count(DISTINCT user_id)
  FROM flat GROUP BY day, kind, name
$$;
--> statement-breakpoint
-- The same rows from daily_skill_mcp_rollups (long ranges). A turn lands in exactly one rollup group, so
-- summing `turns` over groups is still a distinct count; `users` counts the rows' (non-null) user_id.
CREATE OR REPLACE FUNCTION agg_skill_mcp_rollups(p_from date, p_to date, p_team_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL, p_harness text DEFAULT NULL, p_model text DEFAULT NULL)
RETURNS TABLE (level text, day date, kind text, name text, tool text, calls bigint, model_calls bigint,
  user_calls bigint, turns bigint, users bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH d AS (
    SELECT * FROM daily_skill_mcp_rollups d
    WHERE d.company_id = app_company()
      AND d.day >= p_from AND d.day < p_to
      AND (d.user_id = app_user() OR app_is_admin() OR d.team_id = ANY (app_led_teams()))
      AND (p_team_id IS NULL OR d.team_id = p_team_id)
      AND (p_project_id IS NULL OR d.project_id = p_project_id)
      AND (p_harness IS NULL OR d.harness = p_harness)
      AND (p_model IS NULL OR d.model = p_model)
  )
  SELECT 'name', NULL::date, kind, name, '', sum(calls)::bigint, sum(model_calls)::bigint, sum(user_calls)::bigint,
    sum(turns)::bigint, count(DISTINCT user_id)
  FROM d WHERE tool = '' GROUP BY kind, name
  UNION ALL
  SELECT 'tool', NULL::date, kind, name, tool, sum(calls)::bigint, sum(model_calls)::bigint, sum(user_calls)::bigint,
    sum(turns)::bigint, count(DISTINCT user_id)
  FROM d WHERE tool <> '' GROUP BY kind, name, tool
  UNION ALL
  SELECT 'day', day, kind, name, '', sum(calls)::bigint, sum(model_calls)::bigint, sum(user_calls)::bigint,
    sum(turns)::bigint, count(DISTINCT user_id)
  FROM d WHERE tool = '' GROUP BY day, kind, name
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION agg_skill_mcp(timestamptz, timestamptz, uuid, uuid, text, text),
  agg_skill_mcp_rollups(date, date, uuid, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION agg_skill_mcp(timestamptz, timestamptz, uuid, uuid, text, text),
  agg_skill_mcp_rollups(date, date, uuid, uuid, text, text) TO app_definer, app_web;
--> statement-breakpoint
RESET ROLE;
