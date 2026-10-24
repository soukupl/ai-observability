-- ADR-0028 / ADR-0029 / ADR-0030 (docs/briefs/single-deployment-per-user-tokens.md): one deployment = one company.
-- The company leaves the schema: `companies`, `identity_providers` and every company_id column with its composite
-- (company_id, id) keys are dropped; a one-row `deployment` table holds name, slug, settings and the project salt;
-- `company_memberships` becomes `memberships` (one per user); users get a kind (person | service); tokens always belong
-- to a user and get source / label / expires_at; teams get an immutable slug; device-login codes are new; the SaaS
-- objects (app_platform, platform_* and the super-admin machinery) go. Every RLS policy and SECURITY DEFINER function
-- is rewritten without the company predicate: isolation is now users / teams / roles only.
--
-- Hand-written (only the snapshot / journal are drizzle's; the snapshot was generated from src/schema after the TS
-- matched, so the next `drizzle-kit generate` is a no-op). Refuses to run while more than one company exists: merge
-- them first with `pnpm --filter @ai-obs/db db:merge-companies` (dev only, brief Q3). DDL runs as the migrating owner;
-- data moves and function bodies run as app_definer (FORCE RLS binds a non-superuser owner).

-- ============ 0. guard: at most one company ============
SET ROLE app_definer;--> statement-breakpoint
DO $$ BEGIN
  IF (SELECT count(*) FROM companies) > 1 THEN
    RAISE EXCEPTION 'ADR-0028: migration 0018 needs at most one company, found % (%). Merge them first: pnpm --filter @ai-obs/db db:merge-companies -- --survivor <slug> --name <name> --slug <slug>',
      (SELECT count(*) FROM companies), (SELECT string_agg(slug, ', ' ORDER BY slug) FROM companies)
      USING ERRCODE = '55000';
  END IF;
END $$;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint

-- ============ 1. policies, triggers and functions that depend on what goes ============
-- Every policy except definer_all (always `true`, no column dependency; the data moves below run under it). All of
-- them are re-created in step 8.
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public' AND policyname <> 'definer_all' LOOP
    EXECUTE format('DROP POLICY %I ON %I', r.policyname, r.tablename);
  END LOOP;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS company_memberships_no_super_admin ON company_memberships;--> statement-breakpoint
DROP TRIGGER IF EXISTS users_super_admin_no_membership ON users;--> statement-breakpoint
DROP TRIGGER IF EXISTS auth_sessions_mark_membership ON auth_sessions;--> statement-breakpoint
DROP FUNCTION IF EXISTS company_memberships_no_super_admin();--> statement-breakpoint
DROP FUNCTION IF EXISTS users_super_admin_no_membership();--> statement-breakpoint
DROP FUNCTION IF EXISTS auth_sessions_mark_membership();--> statement-breakpoint
DROP FUNCTION IF EXISTS platform_company_counts();--> statement-breakpoint
DROP FUNCTION IF EXISTS platform_invitee_status(text, uuid);--> statement-breakpoint
DROP FUNCTION IF EXISTS platform_email_in_use(text);--> statement-breakpoint
DROP FUNCTION IF EXISTS auth_create_solo_company(text, text, text);--> statement-breakpoint
DROP FUNCTION IF EXISTS auth_ensure_super_admin(text, text);--> statement-breakpoint
DROP FUNCTION IF EXISTS company_has_user_capacity(uuid);--> statement-breakpoint
DROP FUNCTION IF EXISTS auth_user_memberships(uuid);--> statement-breakpoint
DROP FUNCTION IF EXISTS auth_set_session_company(text, uuid);--> statement-breakpoint
DROP FUNCTION IF EXISTS ingest_match_user_by_email(text, uuid);--> statement-breakpoint
DROP FUNCTION IF EXISTS app_ingest_company();--> statement-breakpoint
DROP FUNCTION IF EXISTS app_company();--> statement-breakpoint
-- Re-created in step 7 (new out columns / parameter types, or owner app_definer + SECURITY DEFINER).
DROP FUNCTION IF EXISTS app_user();--> statement-breakpoint
DROP FUNCTION IF EXISTS lookup_ingest_token(text);--> statement-breakpoint
DROP FUNCTION IF EXISTS admin_remove_member(uuid);--> statement-breakpoint
DROP FUNCTION IF EXISTS auth_find_user_by_email(text);--> statement-breakpoint
DROP FUNCTION IF EXISTS auth_get_user(uuid);--> statement-breakpoint
DROP FUNCTION IF EXISTS auth_pending_invitations(text);--> statement-breakpoint
DROP FUNCTION IF EXISTS auth_accept_invitation(text, text, uuid);--> statement-breakpoint

-- ============ 2. deployment (one row, from the remaining company or defaults) ============
CREATE TABLE "deployment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"settings" jsonb DEFAULT '{"individualVisibility":"aggregates-only","projectNaming":"plain","retentionDays":395}'::jsonb NOT NULL,
	"project_salt" text DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployment_settings_valid" CHECK ("deployment"."settings"->>'individualVisibility' in ('aggregates-only', 'full')
        and "deployment"."settings"->>'projectNaming' in ('plain', 'hashed')
        and jsonb_typeof("deployment"."settings"->'retentionDays') = 'number'
        and ("deployment"."settings"->>'retentionDays')::numeric between 30 and 730
        and ("deployment"."settings"->'runawayCostUsd' is null or (jsonb_typeof("deployment"."settings"->'runawayCostUsd') = 'number'
          and ("deployment"."settings"->>'runawayCostUsd')::numeric between 1 and 100000))
        and ("deployment"."settings"->'runawayHours' is null or (jsonb_typeof("deployment"."settings"->'runawayHours') = 'number'
          and ("deployment"."settings"->>'runawayHours')::numeric between 0.5 and 72)))
);--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_singleton" ON "deployment" USING btree ((true));--> statement-breakpoint
ALTER TABLE deployment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE deployment FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON deployment TO app_definer;--> statement-breakpoint
CREATE POLICY definer_all ON deployment TO app_definer USING (true) WITH CHECK (true);--> statement-breakpoint
SET ROLE app_definer;--> statement-breakpoint
INSERT INTO deployment (name, slug, settings, project_salt, created_at, updated_at)
  SELECT c.name, c.slug, c.settings, c.project_salt, c.created_at, c.updated_at FROM companies c;--> statement-breakpoint
-- A fresh database (or one whose companies were all deleted): defaults; admins rename it in Settings.
INSERT INTO deployment (name, slug) SELECT 'ai-obs', 'ai-obs' WHERE NOT EXISTS (SELECT 1 FROM deployment);--> statement-breakpoint
-- Brief Q1: no super admins. A super-admin identity never had a membership (the 0014 trigger forbade it) and would be
-- refused at login as a removed member, even once listed in ADMIN_EMAILS. Like the merge script, delete it when it owns
-- nothing but its dashboard sessions / OAuth links (cascaded); then a later ADMIN_EMAILS login provisions it afresh.
-- Platform audit rows stay as history (actor set null).
DO $$ DECLARE
  r record;
  v_doomed uuid[];
  v_owning uuid[];
BEGIN
  SELECT coalesce(array_agg(u.id), '{}') INTO v_doomed FROM users u
  WHERE u.is_super_admin AND NOT EXISTS (SELECT 1 FROM company_memberships m WHERE m.user_id = u.id);
  IF cardinality(v_doomed) = 0 THEN RETURN; END IF;
  -- Every ON DELETE CASCADE reference to users.id, except the login tables: a super admin owning such a row stays.
  FOR r IN SELECT c.conrelid::regclass AS tbl, a.attname AS col
    FROM pg_constraint c
    CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(attnum, refnum)
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = k.refnum AND ra.attname = 'id'
    WHERE c.contype = 'f' AND c.confrelid = 'public.users'::regclass AND c.confdeltype = 'c'
      AND c.conrelid NOT IN ('public.auth_sessions'::regclass, 'public.auth_accounts'::regclass)
  LOOP
    EXECUTE format('SELECT array_agg(DISTINCT %I) FROM %s WHERE %I = ANY ($1)', r.col, r.tbl, r.col) INTO v_owning USING v_doomed;
    IF v_owning IS NOT NULL THEN
      RAISE NOTICE 'ADR-0028: keeping % former super admin(s) that own rows in %', cardinality(v_owning), r.tbl;
      SELECT coalesce(array_agg(d), '{}') INTO v_doomed FROM unnest(v_doomed) d WHERE d <> ALL (v_owning);
    END IF;
  END LOOP;
  DELETE FROM users WHERE id = ANY (v_doomed);
END $$;--> statement-breakpoint
-- Company tokens (user_id null) have no owner in the new model (aiobs_c_ is rejected): deleted.
DELETE FROM ingest_tokens WHERE user_id IS NULL;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint

-- ============ 3. drop every company_id (CASCADE drops the composite keys, FKs and indexes that include it) ============
ALTER TABLE "audit_log" DROP COLUMN "company_id" CASCADE;--> statement-breakpoint
ALTER TABLE "budgets" DROP COLUMN "company_id" CASCADE;--> statement-breakpoint
ALTER TABLE "daily_skill_mcp_rollups" DROP COLUMN "company_id" CASCADE;--> statement-breakpoint
ALTER TABLE "daily_rollups" DROP COLUMN "company_id" CASCADE;--> statement-breakpoint
ALTER TABLE "flow_flags" DROP COLUMN "company_id" CASCADE;--> statement-breakpoint
ALTER TABLE "runaway_alerts" DROP COLUMN "company_id" CASCADE;--> statement-breakpoint
ALTER TABLE "pending_session_patches" DROP COLUMN "company_id" CASCADE;--> statement-breakpoint
ALTER TABLE "pending_turn_patches" DROP COLUMN "company_id" CASCADE;--> statement-breakpoint
ALTER TABLE "usage" DROP COLUMN "company_id" CASCADE;--> statement-breakpoint
ALTER TABLE "run_links" DROP COLUMN "company_id" CASCADE;--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "company_id" CASCADE;--> statement-breakpoint
ALTER TABLE "turns" DROP COLUMN "company_id" CASCADE;--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP COLUMN "company_id" CASCADE;--> statement-breakpoint
ALTER TABLE "ingest_events" DROP COLUMN "company_id" CASCADE;--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "company_id" CASCADE;--> statement-breakpoint
ALTER TABLE "machines" DROP COLUMN "company_id" CASCADE;--> statement-breakpoint
ALTER TABLE "ingest_tokens" DROP COLUMN "company_id" CASCADE;--> statement-breakpoint
ALTER TABLE "invitations" DROP COLUMN "company_id" CASCADE;--> statement-breakpoint
ALTER TABLE "team_memberships" DROP COLUMN "company_id" CASCADE;--> statement-breakpoint
ALTER TABLE "company_memberships" DROP COLUMN "company_id" CASCADE;--> statement-breakpoint
ALTER TABLE "teams" DROP COLUMN "company_id" CASCADE;--> statement-breakpoint
ALTER TABLE "auth_sessions" DROP COLUMN "active_company_id";--> statement-breakpoint
DROP TABLE "identity_providers";--> statement-breakpoint
DROP TABLE "companies";--> statement-breakpoint

-- ============ 4. memberships, users, invitations, teams ============
ALTER TABLE "company_memberships" RENAME TO "memberships";--> statement-breakpoint
ALTER TABLE "memberships" RENAME CONSTRAINT "company_memberships_pkey" TO "memberships_pkey";--> statement-breakpoint
ALTER TABLE "memberships" RENAME CONSTRAINT "company_memberships_user_id_users_id_fk" TO "memberships_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "memberships" RENAME COLUMN "company_role" TO "role";--> statement-breakpoint
ALTER TABLE "memberships" DROP COLUMN "last_active_at";--> statement-breakpoint
DROP INDEX "company_memberships_user_idx";--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_uq" UNIQUE("user_id");--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_primary_team_id_teams_id_fk" FOREIGN KEY ("primary_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TYPE "public"."company_role" RENAME TO "member_role";--> statement-breakpoint
ALTER TABLE "invitations" RENAME COLUMN "company_role" TO "role";--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_user_id_memberships_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."memberships"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TYPE "public"."user_kind" AS ENUM('person', 'service');--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "is_super_admin";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "kind" "user_kind" DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_kind" CHECK ("users"."kind" = 'service' or "users"."email" is not null);--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_name_uq" UNIQUE("name");--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "slug" text;--> statement-breakpoint

-- Team slugs (ADR-0030): derived from the name like slugifyTeamName() in src/schema/settings.ts; '-2', '-3', … on a clash.
CREATE FUNCTION team_slug_base(p_name text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(nullif(rtrim(left(trim(both '-' from regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g')), 63), '-'), ''), 'team')
$$;--> statement-breakpoint
ALTER FUNCTION team_slug_base(text) OWNER TO app_definer;--> statement-breakpoint
SET ROLE app_definer;--> statement-breakpoint
CREATE FUNCTION team_unique_slug(p_name text, p_team uuid DEFAULT NULL) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_base text := team_slug_base(p_name);
  v_slug text := v_base;
  n int := 1;
BEGIN
  WHILE EXISTS (SELECT 1 FROM teams t WHERE t.slug = v_slug AND t.id IS DISTINCT FROM p_team) LOOP
    n := n + 1;
    v_slug := rtrim(left(v_base, 63 - length(n::text) - 1), '-') || '-' || n;
  END LOOP;
  RETURN v_slug;
END $$;--> statement-breakpoint
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT id, name FROM teams ORDER BY created_at, id LOOP
    UPDATE teams SET slug = team_unique_slug(r.name, r.id) WHERE id = r.id;
  END LOOP;
END $$;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_slug_uq" UNIQUE("slug");--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_slug_format" CHECK ("teams"."slug" ~ '^[a-z0-9-]{1,63}$');--> statement-breakpoint

-- ============ 5. ingest: tokens, device codes, machines, projects, events ============
ALTER TABLE "ingest_tokens" DROP COLUMN "kind";--> statement-breakpoint
DROP TYPE "public"."token_kind";--> statement-breakpoint
CREATE TYPE "public"."token_source" AS ENUM('device', 'manual');--> statement-breakpoint
ALTER TABLE "ingest_tokens" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ingest_tokens" ADD COLUMN "source" "token_source" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "ingest_tokens" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "ingest_tokens" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "ingest_tokens_user_idx" ON "ingest_tokens" USING btree ("user_id");--> statement-breakpoint
SET ROLE app_definer;--> statement-breakpoint
-- Brief Q7 (carry over): live tokens stay valid for 90 days from the cutover, as manual tokens.
UPDATE ingest_tokens SET expires_at = now() + interval '90 days' WHERE revoked_at IS NULL;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
CREATE TYPE "public"."device_code_status" AS ENUM('pending', 'approved', 'denied', 'consumed', 'expired');--> statement-breakpoint
CREATE TABLE "device_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code" text NOT NULL,
	"client_name" text NOT NULL,
	"client_version" text,
	"requester_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "device_code_status" DEFAULT 'pending' NOT NULL,
	"approved_by" uuid,
	"token_id" uuid,
	"last_polled_at" timestamp with time zone,
	CONSTRAINT "device_codes_device_code_hash_unique" UNIQUE("device_code_hash"),
	CONSTRAINT "device_codes_user_code_format" CHECK ("device_codes"."user_code" ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$'),
	CONSTRAINT "device_codes_client_name_len" CHECK (char_length("device_codes"."client_name") between 1 and 200)
);--> statement-breakpoint
ALTER TABLE "device_codes" ADD CONSTRAINT "device_codes_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_codes" ADD CONSTRAINT "device_codes_token_id_ingest_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."ingest_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_codes_open_user_code_uq" ON "device_codes" USING btree ("user_code") WHERE "device_codes"."status" in ('pending', 'approved');--> statement-breakpoint
CREATE INDEX "device_codes_expires_idx" ON "device_codes" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE device_codes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE device_codes FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON device_codes TO app_definer;--> statement-breakpoint
CREATE POLICY definer_all ON device_codes TO app_definer USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_machine_uq" UNIQUE("machine_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_key_uq" UNIQUE("key");--> statement-breakpoint
ALTER TABLE "ingest_events" ADD CONSTRAINT "ingest_events_event_uq" UNIQUE("event_id");--> statement-breakpoint

-- ============ 6. telemetry and reporting: single-column keys, plain FKs ============
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_external_uq" UNIQUE("external_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_started_idx" ON "agent_sessions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "agent_sessions_last_seen_idx" ON "agent_sessions" USING btree ("last_seen_at") WHERE "agent_sessions"."ended_at" is null;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_external_uq" UNIQUE("external_id");--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "turns_started_idx" ON "turns" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "turns_team_started_idx" ON "turns" USING btree ("team_id","started_at");--> statement-breakpoint
CREATE INDEX "turns_user_started_idx" ON "turns" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "turns_project_started_idx" ON "turns" USING btree ("project_id","started_at");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_turn_external_uq" UNIQUE("turn_external_id","external_id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_started_idx" ON "runs" USING btree ("started_at");--> statement-breakpoint
ALTER TABLE "run_links" ADD CONSTRAINT "run_links_edge_uq" UNIQUE("turn_external_id","from_external_id","to_external_id","kind");--> statement-breakpoint
ALTER TABLE "run_links" ADD CONSTRAINT "run_links_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_links" ADD CONSTRAINT "run_links_from_run_id_runs_id_fk" FOREIGN KEY ("from_run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_links" ADD CONSTRAINT "run_links_to_run_id_runs_id_fk" FOREIGN KEY ("to_run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_links_turn_idx" ON "run_links" USING btree ("turn_id");--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_owner_model_uq" UNIQUE NULLS NOT DISTINCT("turn_id","run_id","model","effort");--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_started_idx" ON "usage" USING btree ("started_at");--> statement-breakpoint
ALTER TABLE "pending_turn_patches" ADD CONSTRAINT "pending_turn_patches_turn_uq" UNIQUE("turn_external_id");--> statement-breakpoint
ALTER TABLE "pending_session_patches" ADD CONSTRAINT "pending_session_patches_session_uq" UNIQUE("session_external_id");--> statement-breakpoint
ALTER TABLE "runaway_alerts" ADD CONSTRAINT "runaway_alerts_turn_uq" UNIQUE("turn_id");--> statement-breakpoint
ALTER TABLE "runaway_alerts" ADD CONSTRAINT "runaway_alerts_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runaway_alerts_started_idx" ON "runaway_alerts" USING btree ("started_at");--> statement-breakpoint
ALTER TABLE "flow_flags" ADD CONSTRAINT "flow_flags_user_flow_uq" UNIQUE("user_id","turn_id","flow_key");--> statement-breakpoint
ALTER TABLE "flow_flags" ADD CONSTRAINT "flow_flags_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flow_flags_user_created_idx" ON "flow_flags" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "daily_rollups_day_idx" ON "daily_rollups" USING btree ("day");--> statement-breakpoint
CREATE INDEX "daily_rollups_team_day_idx" ON "daily_rollups" USING btree ("team_id","day");--> statement-breakpoint
CREATE INDEX "daily_skill_mcp_rollups_day_idx" ON "daily_skill_mcp_rollups" USING btree ("day");--> statement-breakpoint
CREATE INDEX "daily_skill_mcp_rollups_team_day_idx" ON "daily_skill_mcp_rollups" USING btree ("team_id","day");--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_user_id_memberships_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."memberships"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
DROP TYPE "public"."plan";--> statement-breakpoint
DROP TYPE "public"."company_status";--> statement-breakpoint
DROP TYPE "public"."identity_provider_kind";--> statement-breakpoint

-- ============ 7. app_platform loses every privilege ============
-- DROP OWNED revokes its grants, policies and function privileges in this database. The role itself is NOT dropped:
-- roles are cluster-wide, and dropping one from a per-database migration races every other database of the cluster
-- that is migrating at the same time (the test suites run many in parallel: "role ... was concurrently dropped").
-- The operator drops the cluster role by hand once no database uses it any more: DROP ROLE app_platform;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_platform') THEN
    EXECUTE 'DROP OWNED BY app_platform';
  END IF;
END $$;--> statement-breakpoint

-- ============ 8. functions (as app_definer, which owns every SECURITY DEFINER function) ============
-- The CREATE OR REPLACE below runs as app_definer and needs to own the function. A database restored with
-- `pg_restore --no-owner` has every function owned by the restoring role (which would also run the SECURITY DEFINER
-- ones with its rights): hand them back to app_definer first, while still the owner. A no-op on an ordinary database.
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT p.oid::regprocedure AS f FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef AND p.proowner <> 'app_definer'::regrole
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO app_definer', r.f);
  END LOOP;
END $$;--> statement-breakpoint
SET ROLE app_definer;--> statement-breakpoint

-- Context helpers. The dashboard sets app.user_id / app.role per transaction (withRlsContext); ingest sets app.user_id
-- to the token's user (withIngestContext). app_user() is that user only while they hold a membership, so a removed
-- member's context (or a forged id) sees nothing.
CREATE FUNCTION app_user() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.user_id FROM memberships m WHERE m.user_id = app_setting_uuid('app.user_id')
$$;--> statement-breakpoint
-- Admin only if the context claims it AND the membership agrees (a stale or forged app.role cannot escalate).
CREATE OR REPLACE FUNCTION app_is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(current_setting('app.role', true), '') = 'admin' AND EXISTS (
    SELECT 1 FROM memberships m WHERE m.user_id = app_setting_uuid('app.user_id') AND m.role = 'admin')
$$;--> statement-breakpoint
-- Teams the context user leads ("lead" is a per-team role, read from team_memberships).
CREATE OR REPLACE FUNCTION app_led_teams() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(m.team_id), '{}') FROM team_memberships m WHERE m.user_id = app_user() AND m.role = 'lead'
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_member_teams() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(m.team_id), '{}') FROM team_memberships m WHERE m.user_id = app_user()
$$;--> statement-breakpoint
-- true = individual-visibility mode "full"; false = "aggregates-only" (default) or no live context.
CREATE OR REPLACE FUNCTION app_full_visibility() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT d.settings->>'individualVisibility' = 'full' FROM deployment d WHERE app_user() IS NOT NULL), false)
$$;--> statement-breakpoint

-- Team slug triggers (ADR-0030): fill an omitted slug from the name; a slug is fixed once a turn references the team.
CREATE FUNCTION teams_fill_slug() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.slug IS NULL OR NEW.slug = '' THEN NEW.slug := team_unique_slug(NEW.name, NEW.id); END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE FUNCTION teams_slug_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.slug IS DISTINCT FROM OLD.slug AND EXISTS (SELECT 1 FROM turns t WHERE t.team_id = OLD.id) THEN
    RAISE EXCEPTION 'the slug of team % is fixed: turns already reference it (ADR-0030)', OLD.slug USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- ---- dashboard login (pre-context; app_web) ----
CREATE FUNCTION auth_find_user_by_email(p_email text)
RETURNS TABLE(user_id uuid, email text, name text, kind user_kind, role member_role, primary_team_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.email, u.name, u.kind, m.role, m.primary_team_id
  FROM users u LEFT JOIN memberships m ON m.user_id = u.id
  WHERE u.email = lower(trim(p_email))
$$;--> statement-breakpoint
CREATE FUNCTION auth_get_user(p_user_id uuid)
RETURNS TABLE(user_id uuid, email text, name text, kind user_kind, role member_role, primary_team_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.email, u.name, u.kind, m.role, m.primary_team_id
  FROM users u LEFT JOIN memberships m ON m.user_id = u.id
  WHERE u.id = p_user_id
$$;--> statement-breakpoint
-- Open invitations for an e-mail (auto-accepted at login, ADR-0028), newest first.
CREATE FUNCTION auth_pending_invitations(p_email text)
RETURNS TABLE(invitation_id uuid, team_id uuid, team_name text, role member_role, team_role team_role,
  invited_by_name text, invited_by_email text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.id, i.team_id, t.name, i.role, i.team_role, u.name, u.email, i.created_at
  FROM invitations i
  LEFT JOIN teams t ON t.id = i.team_id
  LEFT JOIN users u ON u.id = i.invited_by_user_id
  WHERE i.email = lower(trim(p_email)) AND i.accepted_at IS NULL AND i.expires_at > now()
  ORDER BY i.created_at DESC
$$;--> statement-breakpoint
-- Accepts one invitation for the e-mail: creates the person and the membership (role, primary team = the invited team)
-- and the team membership; for an existing member only the team membership is added (the role is not changed) and the
-- invited team becomes the primary team when they have none (e.g. an ADMIN_EMAILS admin provisioned just before).
-- Returns the user, or nothing when the invitation is not open for that e-mail.
CREATE FUNCTION auth_accept_invitation(p_email text, p_name text, p_invitation_id uuid)
RETURNS TABLE(user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_email text := lower(trim(p_email));
  inv invitations;
  v_user uuid;
BEGIN
  SELECT i.* INTO inv FROM invitations i
  WHERE i.id = p_invitation_id AND i.email = v_email AND i.accepted_at IS NULL AND i.expires_at > now()
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM 1 FROM deployment FOR UPDATE;   -- serialise membership creation
  SELECT u.id INTO v_user FROM users u WHERE u.email = v_email FOR UPDATE;
  IF v_user IS NULL THEN
    INSERT INTO users (email, name, kind) VALUES (v_email, p_name, 'person')
    ON CONFLICT ((lower(email))) DO NOTHING RETURNING id INTO v_user;
    IF v_user IS NULL THEN SELECT u.id INTO v_user FROM users u WHERE u.email = v_email; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = v_user) THEN
    INSERT INTO memberships (user_id, role, primary_team_id) VALUES (v_user, inv.role, inv.team_id);
  ELSIF inv.team_id IS NOT NULL THEN
    UPDATE memberships m SET primary_team_id = inv.team_id WHERE m.user_id = v_user AND m.primary_team_id IS NULL;
  END IF;
  IF inv.team_id IS NOT NULL THEN
    INSERT INTO team_memberships (team_id, user_id, role) VALUES (inv.team_id, v_user, inv.team_role)
    ON CONFLICT (team_id, user_id) DO NOTHING;
  END IF;
  UPDATE invitations SET accepted_at = now() WHERE id = inv.id;
  RETURN QUERY SELECT v_user;
END $$;--> statement-breakpoint
-- Login provisioning without an invitation (brief Q8): an ADMIN_EMAILS address joins as admin, an address of an
-- ALLOWED_EMAIL_DOMAINS domain as member. The web app decides; this only creates the person and the membership.
-- An existing membership is never changed (created = false).
CREATE FUNCTION auth_provision_member(p_email text, p_name text, p_role member_role)
RETURNS TABLE(user_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_email text := lower(trim(p_email));
  v_user uuid;
BEGIN
  IF v_email IS NULL OR v_email = '' THEN RETURN; END IF;
  PERFORM 1 FROM deployment FOR UPDATE;
  SELECT u.id INTO v_user FROM users u WHERE u.email = v_email FOR UPDATE;
  IF v_user IS NOT NULL AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = v_user) THEN
    RETURN QUERY SELECT v_user, false;
    RETURN;
  END IF;
  IF v_user IS NULL THEN
    INSERT INTO users (email, name, kind) VALUES (v_email, p_name, 'person') RETURNING id INTO v_user;
  END IF;
  INSERT INTO memberships (user_id, role) VALUES (v_user, p_role);
  RETURN QUERY SELECT v_user, true;
END $$;--> statement-breakpoint

-- ---- admin (app_web with an admin context) ----
-- Removing a member (ADR-0022 D1/D2, kept): revoke every live token of the user, end their dashboard sessions, delete
-- the membership (team memberships and per-user budgets go with it). Telemetry stays.
CREATE FUNCTION admin_remove_member(p_user_id uuid)
RETURNS TABLE(token_id uuid, token_name text, token_prefix text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  IF NOT app_is_admin() THEN RAISE EXCEPTION 'only admins can remove members' USING ERRCODE = '42501'; END IF;
  IF p_user_id = app_user() THEN RAISE EXCEPTION 'cannot remove yourself' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM memberships m WHERE m.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY
    UPDATE ingest_tokens t SET revoked_at = now()
    WHERE t.user_id = p_user_id AND t.revoked_at IS NULL
    RETURNING t.id, t.name, t.prefix;
  DELETE FROM auth_sessions WHERE user_id = p_user_id;
  DELETE FROM memberships WHERE user_id = p_user_id;
END $$;--> statement-breakpoint
-- A service user (brief Q9): no e-mail, never logs in, member role, optional primary team (also joined as a member).
-- Rename: UPDATE users SET name (admins, service users only); disable: admin_remove_member.
CREATE FUNCTION admin_create_service_user(p_name text, p_primary_team_id uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
  IF NOT app_is_admin() THEN RAISE EXCEPTION 'only admins can create service users' USING ERRCODE = '42501'; END IF;
  IF p_name IS NULL OR trim(p_name) = '' THEN RAISE EXCEPTION 'a service user needs a name' USING ERRCODE = '23514'; END IF;
  INSERT INTO users (name, kind) VALUES (trim(p_name), 'service') RETURNING id INTO v_user;
  INSERT INTO memberships (user_id, role, primary_team_id) VALUES (v_user, 'member', p_primary_team_id);
  IF p_primary_team_id IS NOT NULL THEN
    INSERT INTO team_memberships (team_id, user_id, role) VALUES (p_primary_team_id, v_user, 'member');
  END IF;
  RETURN v_user;
END $$;--> statement-breakpoint

-- ---- ingest (app_ingest) ----
-- A token resolves only while it is not revoked, not expired and its user holds a membership (ADR-0029). Also touches
-- last_used_at (at most once a minute). The last four columns feed collector-config (brief Appendix A).
CREATE FUNCTION lookup_ingest_token(p_hash text)
RETURNS TABLE(token_id uuid, user_id uuid, user_email text, user_name text, user_kind user_kind, primary_team_id uuid,
  settings jsonb, project_salt text, expires_at timestamptz, token_label text, token_source token_source,
  deployment_name text, deployment_slug text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
    SELECT t.id, t.user_id, u.email, u.name, u.kind, m.primary_team_id, d.settings, d.project_salt, t.expires_at,
      t.label, t.source, d.name, d.slug
    FROM ingest_tokens t
    JOIN users u ON u.id = t.user_id
    JOIN memberships m ON m.user_id = t.user_id
    CROSS JOIN deployment d
    WHERE t.hash = p_hash AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now());
  IF FOUND THEN
    UPDATE ingest_tokens it SET last_used_at = now()
    WHERE it.hash = p_hash AND it.revoked_at IS NULL
      AND (it.last_used_at IS NULL OR it.last_used_at < now() - interval '1 minute');
  END IF;
END $$;--> statement-breakpoint
-- Team resolution step 2 (brief Appendix D): the team with this slug, only when the user is a member of it.
CREATE FUNCTION ingest_resolve_team(p_user uuid, p_slug text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id FROM teams t JOIN team_memberships tm ON tm.team_id = t.id AND tm.user_id = p_user
  WHERE t.slug = p_slug
$$;--> statement-breakpoint
-- Same check with the reason, for the ingest warning: 'member' (team_id set), 'not_member' or 'unknown' (team_id null).
CREATE FUNCTION ingest_team_status(p_user uuid, p_slug text) RETURNS TABLE(team_id uuid, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN tm.id IS NOT NULL THEN t.id END, CASE WHEN tm.id IS NOT NULL THEN 'member' ELSE 'not_member' END
  FROM teams t LEFT JOIN team_memberships tm ON tm.team_id = t.id AND tm.user_id = p_user
  WHERE t.slug = p_slug
  UNION ALL
  SELECT NULL::uuid, 'unknown' WHERE NOT EXISTS (SELECT 1 FROM teams t WHERE t.slug = p_slug)
$$;--> statement-breakpoint
-- The teams a user belongs to, in slug order (collector-config `teams`).
CREATE FUNCTION ingest_user_teams(p_user uuid) RETURNS TABLE(team_id uuid, slug text, name text, role team_role)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, t.slug, t.name, tm.role FROM team_memberships tm JOIN teams t ON t.id = tm.team_id
  WHERE tm.user_id = p_user ORDER BY t.slug
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION ingest_project_salt() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.project_salt FROM deployment d
$$;--> statement-breakpoint
-- A parked turn_outcome / turn_summary (ADR-0015) is applied only to an ownerless turn or one of the same owner (SEC-3).
CREATE OR REPLACE FUNCTION ingest_apply_pending_patch(p_turn_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  p pending_turn_patches%ROWTYPE;
  v_owner uuid;
  v_applied boolean := false;
BEGIN
  IF app_user() IS NULL THEN RETURN false; END IF;
  DELETE FROM pending_turn_patches pp USING turns t
  WHERE t.id = p_turn_id AND pp.turn_external_id = t.external_id
  RETURNING pp.* INTO p;
  IF FOUND THEN
    SELECT user_id INTO v_owner FROM turns WHERE id = p_turn_id;
    IF v_owner IS NULL OR v_owner = p.user_id THEN
      v_applied := true;
      UPDATE turns SET
        outcome = CASE WHEN p.outcome IS NULL THEN outcome ELSE p.outcome END,
        outcome_signals = CASE WHEN p.outcome IS NULL THEN outcome_signals ELSE coalesce(p.outcome_signals, '[]'::jsonb) END,
        outcome_provisional = CASE WHEN p.outcome IS NULL THEN outcome_provisional ELSE coalesce(p.outcome_provisional, false) END,
        summary = coalesce(p.summary, summary),
        updated_at = now()
      WHERE id = p_turn_id;
    END IF;
  END IF;
  DELETE FROM pending_turn_patches WHERE received_at < now() - interval '30 days';
  RETURN v_applied;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION ingest_apply_pending_session_patch(p_session_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  p pending_session_patches%ROWTYPE;
  v_owner uuid;
  v_applied boolean := false;
BEGIN
  IF app_user() IS NULL THEN RETURN false; END IF;
  DELETE FROM pending_session_patches pp USING agent_sessions s
  WHERE s.id = p_session_id AND pp.session_external_id = s.external_id
  RETURNING pp.* INTO p;
  IF FOUND THEN
    SELECT user_id INTO v_owner FROM agent_sessions WHERE id = p_session_id;
    IF v_owner IS NULL OR v_owner = p.user_id THEN
      v_applied := true;
      UPDATE agent_sessions SET title = p.title, title_source = p.title_source WHERE id = p_session_id;
    END IF;
  END IF;
  RETURN v_applied;
END $$;--> statement-breakpoint

-- ---- device login (ADR-0029, brief Appendix B) ----
-- POST /api/v1/device/code (public): stores a new code; expires stale open codes first. Returns no row when
-- p_max_open codes are already open (→ 429). A user_code clash raises 23505 (the caller draws another code).
CREATE FUNCTION device_create_code(p_device_code_hash text, p_user_code text, p_client_name text, p_client_version text,
  p_requester_ip text, p_ttl_seconds integer DEFAULT 600, p_max_open integer DEFAULT 100)
RETURNS TABLE(id uuid, user_code text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('ai-obs:device_codes'));
  UPDATE device_codes SET status = 'expired' WHERE status IN ('pending', 'approved') AND expires_at <= now();
  IF (SELECT count(*) FROM device_codes WHERE status IN ('pending', 'approved')) >= p_max_open THEN RETURN; END IF;
  RETURN QUERY
    INSERT INTO device_codes (device_code_hash, user_code, client_name, client_version, requester_ip, expires_at)
    VALUES (p_device_code_hash, upper(replace(p_user_code, '-', '')), p_client_name, p_client_version, p_requester_ip,
      now() + make_interval(secs => p_ttl_seconds))
    RETURNING device_codes.id, device_codes.user_code, device_codes.expires_at;
END $$;--> statement-breakpoint
-- /device (signed-in person): the open code the user typed (with or without the dash), or nothing. Lookup and approval
-- need 30 s left on the code, so the CLI's next poll (5 s interval, more after slow_down) exchanges an approved code
-- before it expires instead of answering expired_token.
CREATE FUNCTION device_lookup(p_user_code text)
RETURNS TABLE(id uuid, client_name text, client_version text, requester_ip text, created_at timestamptz, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.client_name, c.client_version, c.requester_ip, c.created_at, c.expires_at
  FROM device_codes c
  WHERE app_user() IS NOT NULL AND c.user_code = upper(replace(trim(p_user_code), '-', ''))
    AND c.status = 'pending' AND c.expires_at > now() + interval '30 seconds'
$$;--> statement-breakpoint
-- Approve: any member who is a person may approve their own login; the token is minted for them at the exchange.
CREATE FUNCTION device_approve(p_user_code text)
RETURNS TABLE(id uuid, client_name text, requester_ip text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE v_user uuid := app_user();
BEGIN
  IF v_user IS NULL OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = v_user AND u.kind = 'person') THEN
    RAISE EXCEPTION 'only a signed-in member can approve a device login' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    UPDATE device_codes c SET status = 'approved', approved_by = v_user
    WHERE c.user_code = upper(replace(trim(p_user_code), '-', '')) AND c.status = 'pending'
      AND c.expires_at > now() + interval '30 seconds'
    RETURNING c.id, c.client_name, c.requester_ip, c.expires_at;
END $$;--> statement-breakpoint
CREATE FUNCTION device_deny(p_user_code text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_user() IS NULL THEN RAISE EXCEPTION 'only a signed-in member can deny a device login' USING ERRCODE = '42501'; END IF;
  UPDATE device_codes c SET status = 'denied'
  WHERE c.user_code = upper(replace(trim(p_user_code), '-', '')) AND c.status = 'pending' AND c.expires_at > now();
  RETURN FOUND;
END $$;--> statement-breakpoint
-- POST /api/v1/device/token (public poll). status: 'ok' (token minted: user, expires_at = now() + 90 days, label =
-- client name, source 'device'; audit 'token.create'), 'authorization_pending', 'slow_down' (polled again within
-- p_min_interval_seconds), 'access_denied' (denied, or the approver lost their membership), 'expired_token',
-- 'invalid_grant' (unknown or already exchanged: a code is exchanged at most once). The caller generates the token and
-- passes only its hash and prefix; it returns the secret to the CLI only on 'ok'.
CREATE FUNCTION device_exchange(p_device_code_hash text, p_token_hash text, p_token_prefix text,
  p_min_interval_seconds integer DEFAULT 5)
RETURNS TABLE(status text, token_id uuid, user_id uuid, expires_at timestamptz, label text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  c device_codes%ROWTYPE;
  v_token uuid;
  v_expires timestamptz;
  v_slow boolean;
BEGIN
  SELECT * INTO c FROM device_codes d WHERE d.device_code_hash = p_device_code_hash FOR UPDATE;
  IF NOT FOUND OR c.status = 'consumed' THEN
    RETURN QUERY SELECT 'invalid_grant'::text, NULL::uuid, NULL::uuid, NULL::timestamptz, NULL::text; RETURN;
  END IF;
  IF c.status = 'denied' THEN
    RETURN QUERY SELECT 'access_denied'::text, NULL::uuid, NULL::uuid, NULL::timestamptz, NULL::text; RETURN;
  END IF;
  IF c.status = 'expired' OR c.expires_at <= now() THEN
    UPDATE device_codes SET status = 'expired', last_polled_at = now() WHERE id = c.id;
    RETURN QUERY SELECT 'expired_token'::text, NULL::uuid, NULL::uuid, NULL::timestamptz, NULL::text; RETURN;
  END IF;
  IF c.status = 'pending' THEN
    v_slow := c.last_polled_at IS NOT NULL AND c.last_polled_at > now() - make_interval(secs => p_min_interval_seconds);
    UPDATE device_codes SET last_polled_at = now() WHERE id = c.id;
    RETURN QUERY SELECT CASE WHEN v_slow THEN 'slow_down' ELSE 'authorization_pending' END::text,
      NULL::uuid, NULL::uuid, NULL::timestamptz, NULL::text;
    RETURN;
  END IF;
  -- approved
  IF c.approved_by IS NULL OR NOT EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
                                          WHERE m.user_id = c.approved_by AND u.kind = 'person') THEN
    UPDATE device_codes SET status = 'denied', last_polled_at = now() WHERE id = c.id;
    RETURN QUERY SELECT 'access_denied'::text, NULL::uuid, NULL::uuid, NULL::timestamptz, NULL::text; RETURN;
  END IF;
  INSERT INTO ingest_tokens (user_id, name, source, label, prefix, hash, created_by_user_id, expires_at)
  VALUES (c.approved_by, c.client_name, 'device', c.client_name, p_token_prefix, p_token_hash, c.approved_by,
    now() + interval '90 days')
  RETURNING ingest_tokens.id, ingest_tokens.expires_at INTO v_token, v_expires;
  UPDATE device_codes SET status = 'consumed', token_id = v_token, last_polled_at = now() WHERE id = c.id;
  INSERT INTO audit_log (actor_user_id, action, target, meta)
  VALUES (c.approved_by, 'token.create', v_token::text, jsonb_build_object('source', 'device', 'label', c.client_name,
    'prefix', p_token_prefix, 'client_version', c.client_version, 'requester_ip', c.requester_ip, 'device_code_id', c.id));
  RETURN QUERY SELECT 'ok'::text, v_token, c.approved_by, v_expires, c.client_name;
END $$;--> statement-breakpoint

-- ---- aggregates (agg_*): the same functions, without the company predicate ----
CREATE OR REPLACE FUNCTION agg_agents(p_from timestamp with time zone, p_to timestamp with time zone, p_team_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_harness text DEFAULT NULL::text, p_model text DEFAULT NULL::text)
 RETURNS TABLE(agent_type text, agent_group text, runs bigint, success bigint, failed bigint, abandoned bigint, unknown bigint, duration_ms bigint, input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint, reasoning_tokens bigint, avg_depth numeric, max_depth integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT r.agent_type, r.agent_group, count(*),
    count(*) FILTER (WHERE r.outcome = 'success'), count(*) FILTER (WHERE r.outcome = 'failed'),
    count(*) FILTER (WHERE r.outcome = 'abandoned'), count(*) FILTER (WHERE r.outcome = 'unknown'),
    sum(r.duration_ms)::bigint, sum(r.input_tokens)::bigint, sum(r.output_tokens)::bigint,
    sum(r.cache_read_tokens)::bigint, sum(r.cache_write_tokens)::bigint, sum(r.reasoning_tokens)::bigint,
    avg(r.depth), max(r.depth)
  FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, p_model) t
  JOIN runs r ON r.turn_id = t.id
  GROUP BY r.agent_type, r.agent_group
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_effort_cells(p_from timestamp with time zone, p_to timestamp with time zone, p_team_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_harness text DEFAULT NULL::text, p_model text DEFAULT NULL::text)
 RETURNS TABLE(project_id uuid, model text, effort text, turns bigint, decided bigint, success bigint, priced_turns bigint, median_cost_usd double precision, median_duration_ms double precision)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH scope AS (
    SELECT t.id, t.project_id, t.model, t.effort, t.outcome, t.duration_ms,
      (t.started_at AT TIME ZONE 'UTC')::date AS day
    FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, p_model) t
    WHERE t.model IS NOT NULL AND t.effort IS NOT NULL
  ), cost AS (
    SELECT s.id,
      CASE WHEN bool_or(c.usd IS NULL AND u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens > 0)
           THEN NULL ELSE coalesce(sum(c.usd), 0) END AS usd
    FROM scope s
    JOIN usage u ON u.turn_id = s.id
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
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_flow_links(p_from timestamp with time zone, p_to timestamp with time zone, p_team_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_harness text DEFAULT NULL::text, p_model text DEFAULT NULL::text, p_limit integer DEFAULT 20000)
 RETURNS TABLE(from_run_id uuid, to_run_id uuid, kind text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT l.from_run_id, l.to_run_id, l.kind
  FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, p_model) t
  JOIN runs r ON r.turn_id = t.id
  JOIN run_links l ON l.to_run_id = r.id
  JOIN runs f ON f.id = l.from_run_id AND f.turn_id = t.id
  ORDER BY r.started_at, r.id, l.from_run_id, l.kind
  LIMIT least(greatest(p_limit, 0), 20001)
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_flow_runs(p_from timestamp with time zone, p_to timestamp with time zone, p_team_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_harness text DEFAULT NULL::text, p_model text DEFAULT NULL::text, p_limit integer DEFAULT 20000)
 RETURNS TABLE(id uuid, turn_id uuid, parent_run_id uuid, agent_type text, agent_group text, orchestration_id text, stage_index integer, flow_key text, depth integer, model text, effort text, started_at timestamp with time zone, ended_at timestamp with time zone, duration_ms bigint, input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint, reasoning_tokens bigint, outcome outcome, turn_started_at timestamp with time zone, turn_project_id uuid, turn_harness text, turn_summary text, turn_is_mine boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT r.id, r.turn_id, r.parent_run_id, r.agent_type, r.agent_group, r.orchestration_id, r.stage_index, r.flow_key,
    r.depth, r.model, r.effort, r.started_at, r.ended_at, r.duration_ms, r.input_tokens, r.output_tokens,
    r.cache_read_tokens, r.cache_write_tokens, r.reasoning_tokens, r.outcome,
    t.started_at, t.project_id, t.harness, t.summary, t.user_id IS NOT DISTINCT FROM app_user()
  FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, p_model) t
  JOIN runs r ON r.turn_id = t.id
  ORDER BY r.started_at, r.id
  LIMIT least(greatest(p_limit, 0), 20001)
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_ingest_stats()
 RETURNS TABLE(type text, events_24h bigint, events_7d bigint, last_received_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT e.type,
    count(*) FILTER (WHERE e.received_at >= now() - interval '24 hours'),
    count(*) FILTER (WHERE e.received_at >= now() - interval '7 days'),
    max(e.received_at)
  FROM ingest_events e
  WHERE app_user() IS NOT NULL
  GROUP BY e.type
  ORDER BY e.type
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_mcp_reliability(p_from timestamp with time zone, p_to timestamp with time zone, p_team_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_harness text DEFAULT NULL::text, p_model text DEFAULT NULL::text)
 RETURNS TABLE(level text, name text, tool text, errors bigint, denied bigint, latency_ms bigint, lat0 bigint, lat1 bigint, lat2 bigint, lat3 bigint, lat4 bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH uses AS (
    SELECT u.mcp_stats
    FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, p_model) t
    CROSS JOIN LATERAL (
      SELECT t.mcp_stats UNION ALL SELECT r.mcp_stats FROM runs r WHERE r.turn_id = t.id
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
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_mcp_reliability_rollups(p_from date, p_to date, p_team_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_harness text DEFAULT NULL::text, p_model text DEFAULT NULL::text)
 RETURNS TABLE(level text, name text, tool text, errors bigint, denied bigint, latency_ms bigint, lat0 bigint, lat1 bigint, lat2 bigint, lat3 bigint, lat4 bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN d.tool = '' THEN 'name' ELSE 'tool' END, d.name, d.tool, sum(d.errors)::bigint, sum(d.denied)::bigint,
    sum(d.latency_ms)::bigint, sum(d.lat0)::bigint, sum(d.lat1)::bigint, sum(d.lat2)::bigint, sum(d.lat3)::bigint, sum(d.lat4)::bigint
  FROM daily_skill_mcp_rollups d
  WHERE d.kind = 'mcp'
    AND d.day >= p_from AND d.day < p_to
    AND (d.user_id = app_user() OR app_is_admin() OR d.team_id = ANY (app_led_teams()))
    AND (p_team_id IS NULL OR d.team_id = p_team_id)
    AND (p_project_id IS NULL OR d.project_id = p_project_id)
    AND (p_harness IS NULL OR d.harness = p_harness)
    AND (p_model IS NULL OR d.model = p_model)
  GROUP BY 1, 2, 3
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_phases(p_group text, p_from timestamp with time zone, p_to timestamp with time zone, p_team_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_harness text DEFAULT NULL::text, p_model text DEFAULT NULL::text)
 RETURNS TABLE(group_key text, phase text, ms bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE p_group
      WHEN 'team' THEN t.team_id::text
      WHEN 'project' THEN t.project_id::text
      WHEN 'model' THEN t.model
      WHEN 'day' THEN ((t.started_at AT TIME ZONE 'UTC')::date)::text
    END,
    p.key, sum(p.value::bigint)::bigint
  FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, p_model) t
  CROSS JOIN LATERAL jsonb_each_text(t.phases_ms) p
  WHERE p_group IN ('team', 'project', 'model', 'day')
  GROUP BY 1, 2
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_rollups(p_from date, p_to date, p_team_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_harness text DEFAULT NULL::text, p_model text DEFAULT NULL::text)
 RETURNS TABLE(day date, team_id uuid, project_id uuid, harness text, model text, effort text, turns bigint, runs bigint, input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint, reasoning_tokens bigint, requests bigint, duration_ms bigint, success bigint, failed bigint, abandoned bigint, unknown bigint, est_cost_usd numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT g.*, estimate_cost_usd(g.model, g.day, g.i, g.o, g.cr, g.cw)
  FROM (
    SELECT d.day::date AS day, d.team_id, d.project_id, d.harness, d.model, d.effort,
      sum(d.turns)::bigint, sum(d.runs)::bigint, sum(d.input_tokens)::bigint AS i, sum(d.output_tokens)::bigint AS o,
      sum(d.cache_read_tokens)::bigint AS cr, sum(d.cache_write_tokens)::bigint AS cw, sum(d.reasoning_tokens)::bigint,
      sum(d.requests)::bigint, sum(d.duration_ms)::bigint, sum(d.success)::bigint, sum(d.failed)::bigint,
      sum(d.abandoned)::bigint, sum(d.unknown)::bigint
    FROM daily_rollups d
    WHERE d.day >= p_from AND d.day < p_to
      AND (d.user_id = app_user() OR app_is_admin() OR d.team_id = ANY (app_led_teams()))
      AND (p_team_id IS NULL OR d.team_id = p_team_id)
      AND (p_project_id IS NULL OR d.project_id = p_project_id)
      AND (p_harness IS NULL OR d.harness = p_harness)
      AND (p_model IS NULL OR d.model = p_model)
    GROUP BY 1, 2, 3, 4, 5, 6
  ) g
  ORDER BY g.day
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_runaways(p_from timestamp with time zone, p_to timestamp with time zone, p_team_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_harness text DEFAULT NULL::text, p_model text DEFAULT NULL::text)
 RETURNS TABLE(turn_id uuid, started_at timestamp with time zone, team_id uuid, project_id uuid, harness text, model text, reasons jsonb, tokens bigint, cost_usd numeric, duration_ms bigint, is_mine boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT a.turn_id, a.started_at, a.team_id, a.project_id, a.harness, a.model, a.reasons, a.tokens, a.cost_usd,
    a.duration_ms, a.user_id IS NOT DISTINCT FROM app_user()
  FROM runaway_alerts a
  WHERE a.started_at >= p_from AND a.started_at < p_to
    AND (a.user_id = app_user() OR app_is_admin() OR a.team_id = ANY (app_led_teams()))
    AND (p_team_id IS NULL OR a.team_id = p_team_id)
    AND (p_project_id IS NULL OR a.project_id = p_project_id)
    AND (p_harness IS NULL OR a.harness = p_harness)
    AND (p_model IS NULL OR a.model = p_model)
  ORDER BY a.started_at DESC
  LIMIT 200
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_scope_turns(p_from timestamp with time zone, p_to timestamp with time zone, p_team_id uuid, p_project_id uuid, p_harness text, p_model text)
 RETURNS SETOF turns
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT t.* FROM turns t
  WHERE t.started_at >= p_from AND t.started_at < p_to
    AND (t.user_id = app_user() OR app_is_admin() OR t.team_id = ANY (app_led_teams()))
    AND (p_team_id IS NULL OR t.team_id = p_team_id)
    AND (p_project_id IS NULL OR t.project_id = p_project_id)
    AND (p_harness IS NULL OR t.harness = p_harness)
    AND (p_model IS NULL OR t.model = p_model)
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_skill_impact(p_from timestamp with time zone, p_to timestamp with time zone, p_team_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_harness text DEFAULT NULL::text, p_model text DEFAULT NULL::text)
 RETURNS TABLE(skill text, project_id uuid, model text, with_skill boolean, turns bigint, decided bigint, success bigint, priced_turns bigint, median_cost_usd double precision, median_tokens double precision, median_duration_ms double precision)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH scope AS (
    SELECT t.id, t.project_id, coalesce(t.model, 'unknown') AS model, t.outcome, t.duration_ms, t.skills,
      t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_write_tokens AS tokens,
      (t.started_at AT TIME ZONE 'UTC')::date AS day
    FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, p_model) t
  ), used AS (
    SELECT DISTINCT x.id AS turn_id, s.key AS skill
    FROM scope x
    CROSS JOIN LATERAL (SELECT x.skills UNION ALL SELECT r.skills FROM runs r WHERE r.turn_id = x.id) u
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
    FROM (SELECT DISTINCT id, day FROM pairs) x
    JOIN usage u ON u.turn_id = x.id
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
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_skill_impact_rollups(p_from date, p_to date, p_team_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_harness text DEFAULT NULL::text, p_model text DEFAULT NULL::text)
 RETURNS TABLE(skill text, project_id uuid, model text, with_skill boolean, turns bigint, decided bigint, success bigint, priced_turns bigint, median_cost_usd double precision, median_tokens double precision, median_duration_ms double precision)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH s AS (
    SELECT d.name AS skill, d.project_id, d.model, sum(d.turns)::bigint AS turns,
      sum(d.turns - d.unknown)::bigint AS decided, sum(d.success)::bigint AS success
    FROM daily_skill_mcp_rollups d
    WHERE d.kind = 'skill' AND d.tool = '' AND d.outcome_split
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
    WHERE d.outcome_split
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
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_skill_mcp(p_from timestamp with time zone, p_to timestamp with time zone, p_team_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_harness text DEFAULT NULL::text, p_model text DEFAULT NULL::text)
 RETURNS TABLE(level text, day date, kind text, name text, tool text, calls bigint, model_calls bigint, user_calls bigint, turns bigint, users bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH uses AS (
    SELECT t.id AS turn_id, t.user_id, (t.started_at AT TIME ZONE 'UTC')::date AS day, u.skills, u.mcp
    FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, p_model) t
    CROSS JOIN LATERAL (
      SELECT t.skills, t.mcp
      UNION ALL
      SELECT r.skills, r.mcp FROM runs r WHERE r.turn_id = t.id
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
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_skill_mcp_rollups(p_from date, p_to date, p_team_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_harness text DEFAULT NULL::text, p_model text DEFAULT NULL::text)
 RETURNS TABLE(level text, day date, kind text, name text, tool text, calls bigint, model_calls bigint, user_calls bigint, turns bigint, users bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH d AS (
    SELECT * FROM daily_skill_mcp_rollups d
    WHERE d.day >= p_from AND d.day < p_to
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
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_timeline_links(p_from timestamp with time zone, p_to timestamp with time zone, p_team_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_harness text DEFAULT NULL::text, p_model text DEFAULT NULL::text, p_limit integer DEFAULT 10000)
 RETURNS TABLE(from_run_id uuid, to_run_id uuid, kind text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT l.from_run_id, l.to_run_id, l.kind
  FROM agg_scope_turns(p_from - interval '1 day', p_to, p_team_id, p_project_id, p_harness, p_model) t
  JOIN runs r ON r.turn_id = t.id
  JOIN run_links l ON l.to_run_id = r.id
  JOIN runs f ON f.id = l.from_run_id AND f.turn_id = t.id
  WHERE r.started_at < p_to AND r.ended_at > p_from
  ORDER BY r.started_at, r.id, l.from_run_id, l.kind
  LIMIT least(greatest(p_limit, 0), 10001)
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_timeline_runs(p_from timestamp with time zone, p_to timestamp with time zone, p_team_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_harness text DEFAULT NULL::text, p_model text DEFAULT NULL::text, p_limit integer DEFAULT 5000)
 RETURNS TABLE(id uuid, turn_id uuid, parent_run_id uuid, agent_type text, agent_group text, orchestration_id text, depth integer, model text, started_at timestamp with time zone, ended_at timestamp with time zone, duration_ms bigint, input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint, reasoning_tokens bigint, outcome outcome, stage_index integer, flow_key text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT r.id, r.turn_id, r.parent_run_id, r.agent_type, r.agent_group, r.orchestration_id, r.depth, r.model,
    r.started_at, r.ended_at, r.duration_ms, r.input_tokens, r.output_tokens, r.cache_read_tokens,
    r.cache_write_tokens, r.reasoning_tokens, r.outcome, r.stage_index, r.flow_key
  FROM agg_scope_turns(p_from - interval '1 day', p_to, p_team_id, p_project_id, p_harness, p_model) t
  JOIN runs r ON r.turn_id = t.id
  WHERE r.started_at < p_to AND r.ended_at > p_from
  ORDER BY r.started_at, r.id
  LIMIT least(greatest(p_limit, 0), 5001)
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_timeline_turns(p_from timestamp with time zone, p_to timestamp with time zone, p_team_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_harness text DEFAULT NULL::text, p_model text DEFAULT NULL::text, p_limit integer DEFAULT 1000)
 RETURNS TABLE(id uuid, session_id uuid, project_id uuid, harness text, model text, started_at timestamp with time zone, ended_at timestamp with time zone, duration_ms bigint, input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint, reasoning_tokens bigint, outcome outcome, summary text, is_mine boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT t.id, md5(t.session_id::text || '|' || p_from::text || '|' || p_to::text)::uuid, t.project_id, t.harness,
    t.model, t.started_at, t.ended_at, t.duration_ms,
    t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_write_tokens, t.reasoning_tokens,
    t.outcome, t.summary, t.user_id IS NOT DISTINCT FROM app_user()
  FROM agg_scope_turns(p_from - interval '1 day', p_to, p_team_id, p_project_id, p_harness, p_model) t
  WHERE t.ended_at > p_from
    OR EXISTS (SELECT 1 FROM runs r WHERE r.turn_id = t.id
      AND r.started_at < p_to AND r.ended_at > p_from)
  ORDER BY t.started_at, t.id
  LIMIT least(greatest(p_limit, 0), 1001)
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_turn_links(p_turn_id uuid)
 RETURNS TABLE(from_run_id uuid, to_run_id uuid, kind text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT l.from_run_id, l.to_run_id, l.kind
  FROM turns t
  JOIN runs r ON r.turn_id = t.id
  JOIN run_links l ON l.to_run_id = r.id
  JOIN runs f ON f.id = l.from_run_id AND f.turn_id = t.id
  WHERE t.id = p_turn_id
    AND (t.user_id = app_user() OR app_is_admin() OR t.team_id = ANY (app_led_teams()))
  ORDER BY r.started_at, r.id, l.from_run_id, l.kind
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_turn_list(p_from timestamp with time zone, p_to timestamp with time zone, p_team_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_harness text DEFAULT NULL::text, p_model text DEFAULT NULL::text, p_outcome outcome DEFAULT NULL::outcome, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, started_at timestamp with time zone, ended_at timestamp with time zone, duration_ms bigint, team_id uuid, project_id uuid, harness text, model text, effort text, input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint, reasoning_tokens bigint, outcome outcome, summary text, is_mine boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT t.id, t.started_at, t.ended_at, t.duration_ms, t.team_id, t.project_id, t.harness, t.model, t.effort,
    t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_write_tokens, t.reasoning_tokens,
    t.outcome, t.summary, t.user_id IS NOT DISTINCT FROM app_user()
  FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, p_model) t
  WHERE p_outcome IS NULL OR t.outcome = p_outcome
  ORDER BY t.started_at DESC, t.id
  LIMIT least(greatest(p_limit, 0), 1000) OFFSET greatest(p_offset, 0)
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_turn_runs(p_turn_id uuid)
 RETURNS TABLE(id uuid, parent_run_id uuid, agent_type text, depth integer, model text, effort text, started_at timestamp with time zone, ended_at timestamp with time zone, duration_ms bigint, input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint, reasoning_tokens bigint, phases_ms jsonb, tools jsonb, outcome outcome, agent_group text, stage_index integer, flow_key text, orchestration_id text, skills jsonb, mcp jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT r.id, r.parent_run_id, r.agent_type, r.depth, r.model, r.effort, r.started_at, r.ended_at, r.duration_ms,
    r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens, r.reasoning_tokens,
    r.phases_ms, r.tools, r.outcome, r.agent_group, r.stage_index, r.flow_key, r.orchestration_id, r.skills, r.mcp
  FROM turns t JOIN runs r ON r.turn_id = t.id
  WHERE t.id = p_turn_id
    AND (t.user_id = app_user() OR app_is_admin() OR t.team_id = ANY (app_led_teams()))
  ORDER BY r.started_at
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_turns_by_model(p_from timestamp with time zone, p_to timestamp with time zone, p_team_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_harness text DEFAULT NULL::text, p_model text DEFAULT NULL::text)
 RETURNS TABLE(model text, effort text, turns bigint, success bigint, failed bigint, abandoned bigint, unknown bigint, duration_ms bigint, median_duration_ms double precision, input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint, reasoning_tokens bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT t.model, t.effort, count(*),
    count(*) FILTER (WHERE t.outcome = 'success'), count(*) FILTER (WHERE t.outcome = 'failed'),
    count(*) FILTER (WHERE t.outcome = 'abandoned'), count(*) FILTER (WHERE t.outcome = 'unknown'),
    sum(t.duration_ms)::bigint, percentile_cont(0.5) WITHIN GROUP (ORDER BY t.duration_ms),
    sum(t.input_tokens)::bigint, sum(t.output_tokens)::bigint, sum(t.cache_read_tokens)::bigint,
    sum(t.cache_write_tokens)::bigint, sum(t.reasoning_tokens)::bigint
  FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, p_model) t
  GROUP BY 1, 2
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_turns_by_project(p_from timestamp with time zone, p_to timestamp with time zone, p_team_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_harness text DEFAULT NULL::text, p_model text DEFAULT NULL::text)
 RETURNS TABLE(project_id uuid, turns bigint, success bigint, failed bigint, abandoned bigint, unknown bigint, duration_ms bigint, input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint, reasoning_tokens bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT t.project_id, count(*),
    count(*) FILTER (WHERE t.outcome = 'success'), count(*) FILTER (WHERE t.outcome = 'failed'),
    count(*) FILTER (WHERE t.outcome = 'abandoned'), count(*) FILTER (WHERE t.outcome = 'unknown'),
    sum(t.duration_ms)::bigint, sum(t.input_tokens)::bigint, sum(t.output_tokens)::bigint,
    sum(t.cache_read_tokens)::bigint, sum(t.cache_write_tokens)::bigint, sum(t.reasoning_tokens)::bigint
  FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, p_model) t
  GROUP BY 1
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_turns_daily(p_from timestamp with time zone, p_to timestamp with time zone, p_team_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_harness text DEFAULT NULL::text, p_model text DEFAULT NULL::text)
 RETURNS TABLE(day date, turns bigint, success bigint, failed bigint, abandoned bigint, unknown bigint, duration_ms bigint, median_duration_ms double precision, input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint, reasoning_tokens bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT (t.started_at AT TIME ZONE 'UTC')::date, count(*),
    count(*) FILTER (WHERE t.outcome = 'success'), count(*) FILTER (WHERE t.outcome = 'failed'),
    count(*) FILTER (WHERE t.outcome = 'abandoned'), count(*) FILTER (WHERE t.outcome = 'unknown'),
    sum(t.duration_ms)::bigint, percentile_cont(0.5) WITHIN GROUP (ORDER BY t.duration_ms),
    sum(t.input_tokens)::bigint, sum(t.output_tokens)::bigint, sum(t.cache_read_tokens)::bigint,
    sum(t.cache_write_tokens)::bigint, sum(t.reasoning_tokens)::bigint
  FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, p_model) t
  GROUP BY 1 ORDER BY 1
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_usage_daily(p_from timestamp with time zone, p_to timestamp with time zone, p_team_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_harness text DEFAULT NULL::text, p_model text DEFAULT NULL::text)
 RETURNS TABLE(day date, model text, effort text, input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint, reasoning_tokens bigint, requests bigint, est_cost_usd numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT d.day, d.model, d.effort, d.i, d.o, d.cr, d.cw, d.r, d.rq, estimate_cost_usd(d.model, d.day, d.i, d.o, d.cr, d.cw)
  FROM (
    SELECT (u.started_at AT TIME ZONE 'UTC')::date AS day, u.model, u.effort,
      sum(u.input_tokens)::bigint AS i, sum(u.output_tokens)::bigint AS o, sum(u.cache_read_tokens)::bigint AS cr,
      sum(u.cache_write_tokens)::bigint AS cw, sum(u.reasoning_tokens)::bigint AS r, sum(u.requests)::bigint AS rq
    FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, NULL) t
    JOIN usage u ON u.turn_id = t.id
    WHERE p_model IS NULL OR u.model = p_model
    GROUP BY 1, 2, 3
  ) d
  ORDER BY 1, 2, 3
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_wasted(p_from timestamp with time zone, p_to timestamp with time zone, p_team_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_harness text DEFAULT NULL::text, p_model text DEFAULT NULL::text)
 RETURNS TABLE(day date, team_id uuid, project_id uuid, model text, effort text, class text, input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT (u.started_at AT TIME ZONE 'UTC')::date, t.team_id, t.project_id, u.model, u.effort,
    CASE WHEN t.outcome IN ('failed', 'abandoned') THEN 'wasted' WHEN t.outcome = 'unknown' THEN 'unknown' ELSE 'ok' END,
    sum(u.input_tokens)::bigint, sum(u.output_tokens)::bigint, sum(u.cache_read_tokens)::bigint, sum(u.cache_write_tokens)::bigint
  FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, NULL) t
  JOIN usage u ON u.turn_id = t.id
  WHERE p_model IS NULL OR u.model = p_model
  GROUP BY 1, 2, 3, 4, 5, 6
  HAVING sum(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens) > 0
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_wasted_rollups(p_from date, p_to date, p_team_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_harness text DEFAULT NULL::text, p_model text DEFAULT NULL::text)
 RETURNS TABLE(day date, team_id uuid, project_id uuid, model text, effort text, split boolean, input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint, wasted_input_tokens bigint, wasted_output_tokens bigint, wasted_cache_read_tokens bigint, wasted_cache_write_tokens bigint, unknown_input_tokens bigint, unknown_output_tokens bigint, unknown_cache_read_tokens bigint, unknown_cache_write_tokens bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT d.day, d.team_id, d.project_id, d.model, d.effort,
    coalesce(bool_and(d.outcome_split) FILTER (WHERE d.input_tokens + d.output_tokens + d.cache_read_tokens + d.cache_write_tokens > 0), true),
    sum(d.input_tokens)::bigint, sum(d.output_tokens)::bigint, sum(d.cache_read_tokens)::bigint, sum(d.cache_write_tokens)::bigint,
    sum(d.wasted_input_tokens)::bigint, sum(d.wasted_output_tokens)::bigint, sum(d.wasted_cache_read_tokens)::bigint,
    sum(d.wasted_cache_write_tokens)::bigint, sum(d.unknown_input_tokens)::bigint, sum(d.unknown_output_tokens)::bigint,
    sum(d.unknown_cache_read_tokens)::bigint, sum(d.unknown_cache_write_tokens)::bigint
  FROM daily_rollups d
  WHERE d.day >= p_from AND d.day < p_to
    AND (d.user_id = app_user() OR app_is_admin() OR d.team_id = ANY (app_led_teams()))
    AND (p_team_id IS NULL OR d.team_id = p_team_id)
    AND (p_project_id IS NULL OR d.project_id = p_project_id)
    AND (p_harness IS NULL OR d.harness = p_harness)
    AND (p_model IS NULL OR d.model = p_model)
  GROUP BY 1, 2, 3, 4, 5
  HAVING sum(d.input_tokens + d.output_tokens + d.cache_read_tokens + d.cache_write_tokens) > 0
$function$;
--> statement-breakpoint
RESET ROLE;--> statement-breakpoint

-- ============ 9. function privileges (new functions start executable by PUBLIC) ============
REVOKE ALL ON FUNCTION app_user() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_user() TO app_web, app_ingest, app_definer;--> statement-breakpoint
REVOKE ALL ON FUNCTION team_slug_base(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION team_slug_base(text) TO app_web, app_definer;--> statement-breakpoint
REVOKE ALL ON FUNCTION team_unique_slug(text, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION team_unique_slug(text, uuid) TO app_web;--> statement-breakpoint
REVOKE ALL ON FUNCTION teams_fill_slug() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION teams_slug_immutable() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_find_user_by_email(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_find_user_by_email(text) TO app_web;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_get_user(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_get_user(uuid) TO app_web;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_pending_invitations(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_pending_invitations(text) TO app_web;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_accept_invitation(text, text, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_accept_invitation(text, text, uuid) TO app_web;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_provision_member(text, text, member_role) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_provision_member(text, text, member_role) TO app_web;--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_remove_member(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_remove_member(uuid) TO app_web;--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_create_service_user(text, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_create_service_user(text, uuid) TO app_web;--> statement-breakpoint
REVOKE ALL ON FUNCTION lookup_ingest_token(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION lookup_ingest_token(text) TO app_ingest;--> statement-breakpoint
REVOKE ALL ON FUNCTION ingest_resolve_team(uuid, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ingest_resolve_team(uuid, text) TO app_ingest;--> statement-breakpoint
REVOKE ALL ON FUNCTION ingest_team_status(uuid, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ingest_team_status(uuid, text) TO app_ingest;--> statement-breakpoint
REVOKE ALL ON FUNCTION ingest_user_teams(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ingest_user_teams(uuid) TO app_ingest;--> statement-breakpoint
-- The public device routes live in the web app; app_ingest may serve them too.
REVOKE ALL ON FUNCTION device_create_code(text, text, text, text, text, integer, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION device_create_code(text, text, text, text, text, integer, integer) TO app_web, app_ingest;--> statement-breakpoint
REVOKE ALL ON FUNCTION device_exchange(text, text, text, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION device_exchange(text, text, text, integer) TO app_web, app_ingest;--> statement-breakpoint
REVOKE ALL ON FUNCTION device_lookup(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION device_lookup(text) TO app_web;--> statement-breakpoint
REVOKE ALL ON FUNCTION device_approve(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION device_approve(text) TO app_web;--> statement-breakpoint
REVOKE ALL ON FUNCTION device_deny(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION device_deny(text) TO app_web;--> statement-breakpoint

-- ============ 10. triggers (CREATE TRIGGER needs the table owner) ============
CREATE TRIGGER teams_fill_slug BEFORE INSERT OR UPDATE OF slug ON teams FOR EACH ROW EXECUTE FUNCTION teams_fill_slug();--> statement-breakpoint
CREATE TRIGGER teams_slug_immutable BEFORE UPDATE OF slug ON teams FOR EACH ROW EXECUTE FUNCTION teams_slug_immutable();--> statement-breakpoint

-- ============ 11. table privileges ============
-- deployment: everyone may read it (the header and the login page show the name); admins change name / settings.
GRANT SELECT, UPDATE (name, settings, updated_at) ON deployment TO app_web;--> statement-breakpoint
GRANT SELECT ON deployment TO app_worker;--> statement-breakpoint
-- users: identity columns for app_web (last_login_at stays private); admins rename service users.
REVOKE ALL ON users FROM app_web;--> statement-breakpoint
GRANT SELECT (id, email, name, kind, created_at), UPDATE (name) ON users TO app_web;--> statement-breakpoint
-- teams: admins set the slug (until first use, trigger) and the name.
GRANT UPDATE (name, slug) ON teams TO app_web;--> statement-breakpoint
-- model prices: admins edit them in the console (audited by the web app).
GRANT SELECT, INSERT, UPDATE, DELETE ON model_prices TO app_web;--> statement-breakpoint
GRANT SELECT, UPDATE (status), DELETE ON device_codes TO app_worker;--> statement-breakpoint
-- projects: ingest only registers a project (key, display name) and touches last_seen_at; the team mapping is the
-- admins' (ADR-0030 step 1: it always wins), so ingest may neither set nor change projects.team_id.
REVOKE INSERT, UPDATE ON projects FROM app_ingest;--> statement-breakpoint
GRANT INSERT (key, display_name), UPDATE (last_seen_at) ON projects TO app_ingest;--> statement-breakpoint

-- ============ 12. RLS policies (no company predicate: users / teams / roles only) ============
-- Visibility rule of the per-user telemetry (BRIEF §4, ADR-0008): own rows always; with full visibility also admins
-- (everything) and leads (their teams); aggregates-only mode exposes others only through the agg_* functions.
-- deployment
CREATE POLICY web_select ON deployment FOR SELECT TO app_web USING (true);--> statement-breakpoint
CREATE POLICY web_admin_update ON deployment FOR UPDATE TO app_web
  USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));--> statement-breakpoint
CREATE POLICY worker_all ON deployment TO app_worker USING (true) WITH CHECK (true);--> statement-breakpoint
-- directory: every member sees teams, team memberships, memberships and projects; admins write them.
CREATE POLICY web_select ON memberships FOR SELECT TO app_web USING ((SELECT app_user()) IS NOT NULL);--> statement-breakpoint
CREATE POLICY web_admin_update ON memberships FOR UPDATE TO app_web
  USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));--> statement-breakpoint
CREATE POLICY worker_all ON memberships TO app_worker USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY web_select ON teams FOR SELECT TO app_web USING ((SELECT app_user()) IS NOT NULL);--> statement-breakpoint
CREATE POLICY web_admin_write ON teams TO app_web USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));--> statement-breakpoint
CREATE POLICY worker_all ON teams TO app_worker USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY web_select ON team_memberships FOR SELECT TO app_web USING ((SELECT app_user()) IS NOT NULL);--> statement-breakpoint
CREATE POLICY web_admin_write ON team_memberships TO app_web USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));--> statement-breakpoint
CREATE POLICY worker_all ON team_memberships TO app_worker USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY web_select ON projects FOR SELECT TO app_web USING ((SELECT app_user()) IS NOT NULL);--> statement-breakpoint
CREATE POLICY web_admin_write ON projects TO app_web USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));--> statement-breakpoint
CREATE POLICY ingest_all ON projects TO app_ingest USING ((SELECT app_user()) IS NOT NULL) WITH CHECK ((SELECT app_user()) IS NOT NULL);--> statement-breakpoint
CREATE POLICY worker_all ON projects TO app_worker USING (true) WITH CHECK (true);--> statement-breakpoint
-- users: members see the current members (removed members' identities stay hidden, D1); admins rename service users.
CREATE POLICY web_select ON users FOR SELECT TO app_web
  USING ((SELECT app_user()) IS NOT NULL AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id));--> statement-breakpoint
CREATE POLICY web_admin_update_service ON users FOR UPDATE TO app_web
  USING (kind = 'service' AND (SELECT app_is_admin())) WITH CHECK (kind = 'service' AND (SELECT app_is_admin()));--> statement-breakpoint
CREATE POLICY worker_all ON users TO app_worker USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY web_admin_all ON invitations TO app_web USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));--> statement-breakpoint
-- tokens (ADR-0029): own tokens; admins every token. Users create their own manual tokens, admins also tokens of
-- service users; device tokens come only from device_exchange. Leads have no token rights any more.
CREATE POLICY web_select ON ingest_tokens FOR SELECT TO app_web
  USING (user_id = (SELECT app_user()) OR (SELECT app_is_admin()));--> statement-breakpoint
CREATE POLICY web_insert ON ingest_tokens FOR INSERT TO app_web
  WITH CHECK (created_by_user_id = (SELECT app_user()) AND source = 'manual'
    AND (user_id = (SELECT app_user())
         OR ((SELECT app_is_admin()) AND EXISTS (SELECT 1 FROM users u WHERE u.id = ingest_tokens.user_id AND u.kind = 'service'))));--> statement-breakpoint
CREATE POLICY web_update ON ingest_tokens FOR UPDATE TO app_web
  USING (user_id = (SELECT app_user()) OR (SELECT app_is_admin()))
  WITH CHECK (user_id = (SELECT app_user()) OR (SELECT app_is_admin()));--> statement-breakpoint
CREATE POLICY worker_all ON device_codes TO app_worker USING (true) WITH CHECK (true);--> statement-breakpoint
-- machines: one machine may be used by several people, so ingest sees every row but writes only its own user.
CREATE POLICY ingest_own ON machines TO app_ingest USING ((SELECT app_user()) IS NOT NULL) WITH CHECK (user_id = (SELECT app_user()));--> statement-breakpoint
CREATE POLICY web_select ON machines FOR SELECT TO app_web
  USING (user_id = (SELECT app_user()) OR ((SELECT app_full_visibility()) AND (SELECT app_is_admin())));--> statement-breakpoint
CREATE POLICY worker_all ON machines TO app_worker USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY ingest_all ON ingest_events TO app_ingest USING ((SELECT app_user()) IS NOT NULL) WITH CHECK ((SELECT app_user()) IS NOT NULL);--> statement-breakpoint
CREATE POLICY worker_all ON ingest_events TO app_worker USING (true) WITH CHECK (true);--> statement-breakpoint
-- per-user telemetry. Ingest (brief: write guard) works only on rows of the token's user; an ownerless row (old
-- company-token history) may be claimed, never another user's. Without an ingest context nothing is visible.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['agent_sessions', 'turns', 'runs', 'usage'] LOOP
    EXECUTE format('CREATE POLICY ingest_own ON %I TO app_ingest
      USING ((SELECT app_user()) IS NOT NULL AND (user_id = (SELECT app_user()) OR user_id IS NULL))
      WITH CHECK (user_id = (SELECT app_user()))', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['pending_turn_patches', 'pending_session_patches'] LOOP
    EXECUTE format('CREATE POLICY ingest_own ON %I TO app_ingest
      USING ((SELECT app_user()) IS NOT NULL AND (user_id = (SELECT app_user()) OR user_id IS NULL))
      WITH CHECK (user_id = (SELECT app_user()))', t);
    EXECUTE format('CREATE POLICY worker_all ON %I TO app_worker USING (true) WITH CHECK (true)', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['agent_sessions', 'turns', 'runs', 'usage', 'daily_rollups', 'daily_skill_mcp_rollups', 'runaway_alerts'] LOOP
    EXECUTE format('CREATE POLICY web_select ON %I FOR SELECT TO app_web USING (
      user_id = (SELECT app_user())
      OR ((SELECT app_full_visibility()) AND ((SELECT app_is_admin()) OR team_id = ANY ((SELECT app_led_teams())::uuid[]))))', t);
    EXECUTE format('CREATE POLICY worker_all ON %I TO app_worker USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;--> statement-breakpoint
-- run links: visible exactly when the target run is; ingest replaces the incoming links of its own (or claimable) runs
-- only (the runs subquery is under app_ingest's own runs policy).
CREATE POLICY ingest_own ON run_links TO app_ingest
  USING (EXISTS (SELECT 1 FROM runs r WHERE r.id = run_links.to_run_id))
  WITH CHECK (EXISTS (SELECT 1 FROM runs r WHERE r.id = run_links.to_run_id));--> statement-breakpoint
CREATE POLICY web_select ON run_links FOR SELECT TO app_web USING (EXISTS (SELECT 1 FROM runs r WHERE r.id = run_links.to_run_id));--> statement-breakpoint
CREATE POLICY worker_all ON run_links TO app_worker USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY web_own ON flow_flags TO app_web USING (user_id = (SELECT app_user())) WITH CHECK (user_id = (SELECT app_user()));--> statement-breakpoint
CREATE POLICY web_select ON budgets FOR SELECT TO app_web
  USING ((SELECT app_is_admin()) OR team_id = ANY ((SELECT app_led_teams())::uuid[]) OR user_id = (SELECT app_user()));--> statement-breakpoint
CREATE POLICY web_admin_write ON budgets TO app_web USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));--> statement-breakpoint
CREATE POLICY worker_all ON budgets TO app_worker USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY web_insert ON audit_log FOR INSERT TO app_web WITH CHECK (actor_user_id = (SELECT app_user()));--> statement-breakpoint
CREATE POLICY web_select ON audit_log FOR SELECT TO app_web USING ((SELECT app_is_admin()));--> statement-breakpoint
CREATE POLICY worker_all ON audit_log TO app_worker USING (true) WITH CHECK (true);--> statement-breakpoint
-- model prices (global): readable by everyone, writable by admins. ENABLE without FORCE, so the migrating owner's
-- ensureDefaultModelPrices() keeps working.
ALTER TABLE model_prices ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY definer_all ON model_prices TO app_definer USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY web_select ON model_prices FOR SELECT TO app_web USING (true);--> statement-breakpoint
CREATE POLICY web_admin_write ON model_prices TO app_web USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));--> statement-breakpoint
CREATE POLICY worker_all ON model_prices TO app_worker USING (true) WITH CHECK (true);
