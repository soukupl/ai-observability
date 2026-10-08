CREATE TABLE "run_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"turn_id" uuid,
	"turn_external_id" text NOT NULL,
	"from_run_id" uuid,
	"to_run_id" uuid,
	"from_external_id" text NOT NULL,
	"to_external_id" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_links_edge_uq" UNIQUE("company_id","turn_external_id","from_external_id","to_external_id","kind"),
	CONSTRAINT "run_links_kind" CHECK ("run_links"."kind" in ('item', 'sequence'))
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "stage_index" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "flow_key" text;--> statement-breakpoint
ALTER TABLE "run_links" ADD CONSTRAINT "run_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_links" ADD CONSTRAINT "run_links_company_id_turn_id_turns_company_id_id_fk" FOREIGN KEY ("company_id","turn_id") REFERENCES "public"."turns"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_links" ADD CONSTRAINT "run_links_company_id_from_run_id_runs_company_id_id_fk" FOREIGN KEY ("company_id","from_run_id") REFERENCES "public"."runs"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_links" ADD CONSTRAINT "run_links_company_id_to_run_id_runs_company_id_id_fk" FOREIGN KEY ("company_id","to_run_id") REFERENCES "public"."runs"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_links_company_turn_idx" ON "run_links" USING btree ("company_id","turn_id");--> statement-breakpoint
CREATE INDEX "run_links_to_idx" ON "run_links" USING btree ("to_run_id");--> statement-breakpoint
CREATE INDEX "run_links_from_idx" ON "run_links" USING btree ("from_run_id");--> statement-breakpoint

-- =============================== hand-written part ===============================
-- Agent flow (docs/briefs/agent-flow.md, ADR-0020): runs.stage_index / runs.flow_key and run_links (typed edges between
-- runs of one turn, carried by the target run's event). A link is visible when its target run is: the app_web policy
-- is an EXISTS on runs, so the runs policies decide (own rows; led teams / company in full mode). Aggregates-only
-- readers go through agg_turn_links / agg_timeline_links. The run FKs cascade, so retention (which deletes runs and
-- turns) removes links without worker grants (FK actions run as the table owner, without RLS).
ALTER TABLE run_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE run_links FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON run_links TO app_definer;
--> statement-breakpoint
CREATE POLICY definer_all ON run_links TO app_definer USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT ON run_links TO app_web;
--> statement-breakpoint
CREATE POLICY web_select ON run_links FOR SELECT TO app_web USING (
  company_id = (SELECT app_company())
  AND EXISTS (SELECT 1 FROM runs r WHERE r.id = run_links.to_run_id));
--> statement-breakpoint
-- Ingest replaces a target run's incoming links on every run event (DELETE + INSERT) and resolves from_run_id /
-- turn_id late (UPDATE). Column-level SELECT on identity columns only, like runs; there are no metrics here.
GRANT INSERT, DELETE ON run_links TO app_ingest;
--> statement-breakpoint
GRANT SELECT (id, company_id, turn_id, turn_external_id, from_run_id, to_run_id, from_external_id, to_external_id, kind)
  ON run_links TO app_ingest;
--> statement-breakpoint
GRANT UPDATE (from_run_id, to_run_id, turn_id) ON run_links TO app_ingest;
--> statement-breakpoint
CREATE POLICY ingest_company ON run_links FOR ALL TO app_ingest
  USING (company_id = (SELECT app_ingest_company()))
  WITH CHECK (company_id = (SELECT app_ingest_company()));
--> statement-breakpoint
-- Cross-company like runs. No table grant: the worker never reads links, and retention reaches them via the cascades.
CREATE POLICY worker_all ON run_links TO app_worker USING (true) WITH CHECK (true);
--> statement-breakpoint
-- app_ingest has table-level INSERT on runs (0001); UPDATE is per column.
GRANT UPDATE (stage_index, flow_key) ON runs TO app_ingest;
--> statement-breakpoint
SET ROLE app_definer;
--> statement-breakpoint
-- The result type changes (stage_index, flow_key, orchestration_id appended after agent_group, so existing positions
-- stay). orchestration_id is already in agg_timeline_runs; here it lets the aggregate turn path lay out and chain
-- workflow agents like the raw path instead of guessing from agent_type.
DROP FUNCTION agg_turn_runs(uuid);
--> statement-breakpoint
CREATE FUNCTION agg_turn_runs(p_turn_id uuid)
RETURNS TABLE (id uuid, parent_run_id uuid, agent_type text, depth integer, model text, effort text,
  started_at timestamptz, ended_at timestamptz, duration_ms bigint, input_tokens bigint, output_tokens bigint,
  cache_read_tokens bigint, cache_write_tokens bigint, reasoning_tokens bigint, phases_ms jsonb, tools jsonb,
  outcome outcome, agent_group text, stage_index integer, flow_key text, orchestration_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.parent_run_id, r.agent_type, r.depth, r.model, r.effort, r.started_at, r.ended_at, r.duration_ms,
    r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens, r.reasoning_tokens,
    r.phases_ms, r.tools, r.outcome, r.agent_group, r.stage_index, r.flow_key, r.orchestration_id
  FROM turns t JOIN runs r ON r.turn_id = t.id AND r.company_id = t.company_id
  WHERE t.id = p_turn_id AND t.company_id = app_company()
    AND (t.user_id = app_user() OR app_is_admin() OR t.team_id = ANY (app_led_teams()))
  ORDER BY r.started_at
$$;
--> statement-breakpoint
DROP FUNCTION agg_timeline_runs(timestamptz, timestamptz, uuid, uuid, text, text, integer);
--> statement-breakpoint
-- Same as 0011 with stage_index, flow_key appended. The limit is capped at 5001 (the default + 1).
CREATE FUNCTION agg_timeline_runs(p_from timestamptz, p_to timestamptz, p_team_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL, p_harness text DEFAULT NULL, p_model text DEFAULT NULL, p_limit integer DEFAULT 5000)
RETURNS TABLE (id uuid, turn_id uuid, parent_run_id uuid, agent_type text, agent_group text, orchestration_id text,
  depth integer, model text, started_at timestamptz, ended_at timestamptz, duration_ms bigint, input_tokens bigint,
  output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint, reasoning_tokens bigint, outcome outcome,
  stage_index integer, flow_key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.turn_id, r.parent_run_id, r.agent_type, r.agent_group, r.orchestration_id, r.depth, r.model,
    r.started_at, r.ended_at, r.duration_ms, r.input_tokens, r.output_tokens, r.cache_read_tokens,
    r.cache_write_tokens, r.reasoning_tokens, r.outcome, r.stage_index, r.flow_key
  FROM agg_scope_turns(p_from - interval '1 day', p_to, p_team_id, p_project_id, p_harness, p_model) t
  JOIN runs r ON r.turn_id = t.id AND r.company_id = t.company_id
  WHERE r.started_at < p_to AND r.ended_at > p_from
  ORDER BY r.started_at, r.id
  LIMIT least(greatest(p_limit, 0), 5001)
$$;
--> statement-breakpoint
-- Links of one turn (target run in the turn, source resolved and in the same turn), same visibility as agg_turn_runs.
-- Run ids only: never user_id.
CREATE FUNCTION agg_turn_links(p_turn_id uuid)
RETURNS TABLE (from_run_id uuid, to_run_id uuid, kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.from_run_id, l.to_run_id, l.kind
  FROM turns t
  JOIN runs r ON r.turn_id = t.id AND r.company_id = t.company_id
  JOIN run_links l ON l.to_run_id = r.id AND l.company_id = r.company_id
  JOIN runs f ON f.id = l.from_run_id AND f.company_id = l.company_id AND f.turn_id = t.id
  WHERE t.id = p_turn_id AND t.company_id = app_company()
    AND (t.user_id = app_user() OR app_is_admin() OR t.team_id = ANY (app_led_teams()))
  ORDER BY r.started_at, r.id, l.from_run_id, l.kind
$$;
--> statement-breakpoint
-- Links whose target run is in the agg_timeline_runs scope of the same window (one-day look-back on the turn,
-- run overlaps [p_from, p_to)); the source run is in the same turn but may start before the window. Ordered by the
-- target's start; the limit is capped at 10001 (the default + 1).
CREATE FUNCTION agg_timeline_links(p_from timestamptz, p_to timestamptz, p_team_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL, p_harness text DEFAULT NULL, p_model text DEFAULT NULL, p_limit integer DEFAULT 10000)
RETURNS TABLE (from_run_id uuid, to_run_id uuid, kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.from_run_id, l.to_run_id, l.kind
  FROM agg_scope_turns(p_from - interval '1 day', p_to, p_team_id, p_project_id, p_harness, p_model) t
  JOIN runs r ON r.turn_id = t.id AND r.company_id = t.company_id
  JOIN run_links l ON l.to_run_id = r.id AND l.company_id = r.company_id
  JOIN runs f ON f.id = l.from_run_id AND f.company_id = l.company_id AND f.turn_id = t.id
  WHERE r.started_at < p_to AND r.ended_at > p_from
  ORDER BY r.started_at, r.id, l.from_run_id, l.kind
  LIMIT least(greatest(p_limit, 0), 10001)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION agg_turn_runs(uuid),
  agg_timeline_runs(timestamptz, timestamptz, uuid, uuid, text, text, integer), agg_turn_links(uuid),
  agg_timeline_links(timestamptz, timestamptz, uuid, uuid, text, text, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION agg_turn_runs(uuid),
  agg_timeline_runs(timestamptz, timestamptz, uuid, uuid, text, text, integer), agg_turn_links(uuid),
  agg_timeline_links(timestamptz, timestamptz, uuid, uuid, text, text, integer) TO app_definer, app_web;
--> statement-breakpoint
RESET ROLE;
