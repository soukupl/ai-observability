CREATE TABLE "runaway_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid,
	"project_id" uuid,
	"harness" text NOT NULL,
	"model" text,
	"started_at" timestamp with time zone NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 4),
	"duration_ms" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone,
	CONSTRAINT "runaway_alerts_company_turn_uq" UNIQUE("company_id","turn_id")
);
--> statement-breakpoint
ALTER TABLE "companies" DROP CONSTRAINT "companies_settings_valid";--> statement-breakpoint
ALTER TABLE "runaway_alerts" ADD CONSTRAINT "runaway_alerts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runaway_alerts" ADD CONSTRAINT "runaway_alerts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runaway_alerts" ADD CONSTRAINT "runaway_alerts_company_id_turn_id_turns_company_id_id_fk" FOREIGN KEY ("company_id","turn_id") REFERENCES "public"."turns"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runaway_alerts" ADD CONSTRAINT "runaway_alerts_company_id_user_id_users_company_id_id_fk" FOREIGN KEY ("company_id","user_id") REFERENCES "public"."users"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runaway_alerts_company_started_idx" ON "runaway_alerts" USING btree ("company_id","started_at");--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_settings_valid" CHECK ("companies"."settings"->>'individualVisibility' in ('aggregates-only', 'full')
        and "companies"."settings"->>'projectNaming' in ('plain', 'hashed')
        and jsonb_typeof("companies"."settings"->'retentionDays') = 'number'
        and ("companies"."settings"->>'retentionDays')::numeric between 30 and 730
        and ("companies"."settings"->'runawayCostUsd' is null or (jsonb_typeof("companies"."settings"->'runawayCostUsd') = 'number'
          and ("companies"."settings"->>'runawayCostUsd')::numeric between 1 and 100000))
        and ("companies"."settings"->'runawayHours' is null or (jsonb_typeof("companies"."settings"->'runawayHours') = 'number'
          and ("companies"."settings"->>'runawayHours')::numeric between 0.5 and 72)));--> statement-breakpoint

-- =============================== hand-written part ===============================
-- Runaway alerts (docs/briefs/runaway-alerts.md, ADR-0018). Written by the worker's `runaways` job after a turn
-- ended; the same read rules as turns (own rows, or the led teams / company in full mode).
ALTER TABLE runaway_alerts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE runaway_alerts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON runaway_alerts TO app_definer;
--> statement-breakpoint
CREATE POLICY definer_all ON runaway_alerts TO app_definer USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT ON runaway_alerts TO app_web;
--> statement-breakpoint
CREATE POLICY web_select ON runaway_alerts FOR SELECT TO app_web USING (
  company_id = (SELECT app_company())
  AND (user_id = (SELECT app_user())
       OR ((SELECT app_full_visibility())
           AND ((SELECT app_is_admin()) OR team_id = ANY ((SELECT app_led_teams())::uuid[])))));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON runaway_alerts TO app_worker;
--> statement-breakpoint
CREATE POLICY worker_all ON runaway_alerts TO app_worker USING (true) WITH CHECK (true);
--> statement-breakpoint
SET ROLE app_definer;
--> statement-breakpoint
-- Runaway turns of the caller's visible scope without attribution (aggregates-only leads / admins): never user_id;
-- is_mine marks the caller's own.
CREATE OR REPLACE FUNCTION agg_runaways(p_from timestamptz, p_to timestamptz, p_team_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL, p_harness text DEFAULT NULL, p_model text DEFAULT NULL)
RETURNS TABLE (turn_id uuid, started_at timestamptz, team_id uuid, project_id uuid, harness text, model text,
  reasons jsonb, tokens bigint, cost_usd numeric, duration_ms bigint, is_mine boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.turn_id, a.started_at, a.team_id, a.project_id, a.harness, a.model, a.reasons, a.tokens, a.cost_usd,
    a.duration_ms, a.user_id IS NOT DISTINCT FROM app_user()
  FROM runaway_alerts a
  WHERE a.company_id = app_company()
    AND a.started_at >= p_from AND a.started_at < p_to
    AND (a.user_id = app_user() OR app_is_admin() OR a.team_id = ANY (app_led_teams()))
    AND (p_team_id IS NULL OR a.team_id = p_team_id)
    AND (p_project_id IS NULL OR a.project_id = p_project_id)
    AND (p_harness IS NULL OR a.harness = p_harness)
    AND (p_model IS NULL OR a.model = p_model)
  ORDER BY a.started_at DESC
  LIMIT 200
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION agg_runaways(timestamptz, timestamptz, uuid, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION agg_runaways(timestamptz, timestamptz, uuid, uuid, text, text) TO app_definer, app_web;
--> statement-breakpoint
RESET ROLE;
