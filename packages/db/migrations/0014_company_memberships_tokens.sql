-- ADR-0022: one login, many companies. company_memberships replaces users.company_id / company_role /
-- primary_team_id (users keeps identity only), the dashboard session carries the active company, ingest tokens
-- are company tokens (aiobs_c_) or user tokens (aiobs_u_) with no team binding, and every existing token is
-- revoked (clean break, brief Q7). Removing a member keeps their telemetry (D1): telemetry FKs point at users(id);
-- only team memberships and per-user budgets hang off the membership.
--
-- The generated Drizzle SQL was replaced in full (docs: design 1.2): it dropped users_company_id_uq before the
-- dependent FKs, had no backfill, cast token_kind without a team -> company mapping and wrote a plain
-- "ON DELETE set null" for the primary-team FK. Constraint and index names match meta/0014_snapshot.json.
-- DDL runs as the migrating owner; data moves and function bodies run as app_definer (FORCE RLS binds the owner).

-- ============ 1. new table + new/relaxed columns ============
CREATE TABLE "company_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"company_role" "company_role" DEFAULT 'member' NOT NULL,
	"primary_team_id" uuid,
	"last_active_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_memberships_company_user_uq" UNIQUE("company_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "company_memberships" ADD CONSTRAINT "company_memberships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_memberships" ADD CONSTRAINT "company_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- HAND-FIXED: drizzle writes "ON DELETE set null", which would also null company_id (NOT NULL). The column list
-- form needs PostgreSQL 15+ (we run 16).
ALTER TABLE "company_memberships" ADD CONSTRAINT "company_memberships_primary_team_fk" FOREIGN KEY ("company_id","primary_team_id") REFERENCES "public"."teams"("company_id","id") ON DELETE SET NULL ("primary_team_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_memberships_user_idx" ON "company_memberships" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "active_company_id" uuid;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_active_company_id_companies_id_fk" FOREIGN KEY ("active_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ALTER COLUMN "team_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runaway_alerts" ALTER COLUMN "team_id" DROP NOT NULL;--> statement-breakpoint

-- ============ 2. RLS + grants of the new table (before any data goes in) ============
ALTER TABLE company_memberships ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE company_memberships FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON company_memberships TO app_definer;--> statement-breakpoint
CREATE POLICY definer_all ON company_memberships TO app_definer USING (true) WITH CHECK (true);--> statement-breakpoint
-- app_web: the company directory (everyone in the active company); admins change role / primary team.
-- Inserts only through auth_accept_invitation / auth_create_solo_company; deletes only via admin_remove_member.
GRANT SELECT, UPDATE (company_role, primary_team_id) ON company_memberships TO app_web;--> statement-breakpoint
CREATE POLICY web_select ON company_memberships FOR SELECT TO app_web USING (company_id = (SELECT app_company()));--> statement-breakpoint
CREATE POLICY web_admin_update ON company_memberships FOR UPDATE TO app_web
  USING (company_id = (SELECT app_company()) AND (SELECT app_is_admin()))
  WITH CHECK (company_id = (SELECT app_company()) AND (SELECT app_is_admin()));--> statement-breakpoint
GRANT SELECT ON company_memberships TO app_worker;--> statement-breakpoint
CREATE POLICY worker_all ON company_memberships TO app_worker USING (true) WITH CHECK (true);--> statement-breakpoint
-- app_platform: admin contacts only (no members, no telemetry).
GRANT SELECT ON company_memberships TO app_platform;--> statement-breakpoint
CREATE POLICY platform_admin_contacts ON company_memberships FOR SELECT TO app_platform USING (company_role = 'admin');--> statement-breakpoint

-- ============ 3. objects that depend on columns about to change ============
DROP POLICY IF EXISTS web_select ON users;--> statement-breakpoint
DROP POLICY IF EXISTS web_admin_write ON users;--> statement-breakpoint
DROP POLICY IF EXISTS platform_admin_contacts ON users;--> statement-breakpoint
DROP POLICY IF EXISTS web_select ON ingest_tokens;--> statement-breakpoint
DROP POLICY IF EXISTS web_update ON ingest_tokens;--> statement-breakpoint
DROP POLICY IF EXISTS web_insert ON ingest_tokens;--> statement-breakpoint
REVOKE UPDATE (name, company_role, primary_team_id) ON users FROM app_web;--> statement-breakpoint
REVOKE DELETE ON users FROM app_web;--> statement-breakpoint
-- users.last_login_at is a cross-company activity signal: co-members of one company must not read it.
-- app_web gets column-level SELECT on identity columns only (auth reads go through definer functions).
REVOKE SELECT ON users FROM app_web;--> statement-breakpoint
GRANT SELECT (id, email, name, is_super_admin, created_at) ON users TO app_web;--> statement-breakpoint
-- Out columns / parameter names change, or the function depends on token_kind: dropped, recreated in step 9.
DROP FUNCTION IF EXISTS lookup_ingest_token(text);--> statement-breakpoint
DROP FUNCTION IF EXISTS ingest_match_user_by_email(text, uuid);--> statement-breakpoint
DROP FUNCTION IF EXISTS auth_find_user_by_email(text);--> statement-breakpoint
DROP FUNCTION IF EXISTS auth_get_user(uuid);--> statement-breakpoint
DROP FUNCTION IF EXISTS auth_accept_invitation(text, text, uuid);--> statement-breakpoint
DROP FUNCTION IF EXISTS platform_email_in_use(text);--> statement-breakpoint

-- ============ 4. data move (as app_definer: FORCE RLS binds the owner) ============
SET ROLE app_definer;--> statement-breakpoint
-- The old CHECK allowed company_id AND is_super_admin together; the new model forbids it (D11). Fail loudly.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE is_super_admin AND company_id IS NOT NULL) THEN
    RAISE EXCEPTION 'ADR-0022: super admins cannot be company members; clear users.is_super_admin or users.company_id for: %',
      (SELECT string_agg(email, ', ') FROM users WHERE is_super_admin AND company_id IS NOT NULL);
  END IF;
END $$;--> statement-breakpoint
INSERT INTO company_memberships (company_id, user_id, company_role, primary_team_id, last_active_at, created_at)
  SELECT u.company_id, u.id, u.company_role,
         CASE WHEN t.company_id = u.company_id THEN u.primary_team_id END, u.last_login_at, u.created_at
  FROM users u LEFT JOIN teams t ON t.id = u.primary_team_id
  WHERE u.company_id IS NOT NULL;--> statement-breakpoint
UPDATE auth_sessions s SET active_company_id = u.company_id
  FROM users u WHERE u.id = s.user_id AND u.company_id IS NOT NULL;--> statement-breakpoint
-- Clean break (brief Q7): every existing token is revoked; everyone re-runs `ai-obs init`.
UPDATE ingest_tokens SET revoked_at = now() WHERE revoked_at IS NULL;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint

-- ============ 5. repoint every (company_id, user_id) FK ============
-- D1: team_memberships + budgets -> the membership; tokens and telemetry -> the identity users(id), so removing
-- a member keeps their history.
ALTER TABLE "team_memberships" DROP CONSTRAINT "team_memberships_company_id_user_id_users_company_id_id_fk";--> statement-breakpoint
ALTER TABLE "ingest_tokens" DROP CONSTRAINT "ingest_tokens_company_id_user_id_users_company_id_id_fk";--> statement-breakpoint
ALTER TABLE "ingest_tokens" DROP CONSTRAINT "ingest_tokens_company_id_team_id_teams_company_id_id_fk";--> statement-breakpoint
ALTER TABLE "machines" DROP CONSTRAINT "machines_company_id_user_id_users_company_id_id_fk";--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP CONSTRAINT "agent_sessions_company_id_user_id_users_company_id_id_fk";--> statement-breakpoint
ALTER TABLE "turns" DROP CONSTRAINT "turns_company_id_user_id_users_company_id_id_fk";--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_company_id_user_id_users_company_id_id_fk";--> statement-breakpoint
ALTER TABLE "usage" DROP CONSTRAINT "usage_company_id_user_id_users_company_id_id_fk";--> statement-breakpoint
ALTER TABLE "budgets" DROP CONSTRAINT "budgets_company_id_user_id_users_company_id_id_fk";--> statement-breakpoint
ALTER TABLE "runaway_alerts" DROP CONSTRAINT "runaway_alerts_company_id_user_id_users_company_id_id_fk";--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_membership_fk" FOREIGN KEY ("company_id","user_id") REFERENCES "public"."company_memberships"("company_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_tokens" ADD CONSTRAINT "ingest_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_membership_fk" FOREIGN KEY ("company_id","user_id") REFERENCES "public"."company_memberships"("company_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runaway_alerts" ADD CONSTRAINT "runaway_alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ============ 6. ingest_tokens: drop team_id, token_kind {user, team} -> {user, company} ============
ALTER TABLE "ingest_tokens" DROP COLUMN "team_id";--> statement-breakpoint
ALTER TABLE "ingest_tokens" DROP CONSTRAINT "ingest_tokens_kind_user";--> statement-breakpoint
ALTER TYPE "public"."token_kind" RENAME TO "token_kind_old";--> statement-breakpoint
CREATE TYPE "public"."token_kind" AS ENUM('user', 'company');--> statement-breakpoint
-- D7: team tokens become (revoked) company tokens; the rows are kept for the audit history.
ALTER TABLE "ingest_tokens" ALTER COLUMN "kind" SET DATA TYPE "public"."token_kind"
  USING (CASE "kind"::text WHEN 'team' THEN 'company' ELSE "kind"::text END)::"public"."token_kind";--> statement-breakpoint
DROP TYPE "public"."token_kind_old";--> statement-breakpoint
ALTER TABLE "ingest_tokens" ADD CONSTRAINT "ingest_tokens_kind_user" CHECK (("ingest_tokens"."kind" = 'user') = ("ingest_tokens"."user_id" is not null));--> statement-breakpoint

-- ============ 7. users keeps identity only ============
ALTER TABLE "users" DROP CONSTRAINT "users_company_or_super_admin";--> statement-breakpoint
-- Only after step 5: nine FKs referenced users(company_id, id).
ALTER TABLE "users" DROP CONSTRAINT "users_company_id_uq";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_company_id_companies_id_fk";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_primary_team_id_teams_id_fk";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "company_id";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "company_role";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "primary_team_id";--> statement-breakpoint

-- ============ 8. new policies on users / ingest_tokens ============
-- A user sees their own identity and the identities of members of the active company.
CREATE POLICY web_select ON users FOR SELECT TO app_web USING (
  id = (SELECT app_user())
  OR EXISTS (SELECT 1 FROM company_memberships m WHERE m.user_id = users.id AND m.company_id = (SELECT app_company())));--> statement-breakpoint
CREATE POLICY platform_admin_contacts ON users FOR SELECT TO app_platform USING (
  is_super_admin OR EXISTS (SELECT 1 FROM company_memberships m WHERE m.user_id = users.id AND m.company_role = 'admin'));--> statement-breakpoint
-- Tokens (Q9): own user tokens; company tokens for admins and leads (company-wide); admins see and revoke every
-- token of the company, user tokens included (D6). Only the owner creates a user token.
CREATE POLICY web_select ON ingest_tokens FOR SELECT TO app_web USING (
  company_id = (SELECT app_company())
  AND (user_id = (SELECT app_user()) OR (SELECT app_is_admin())
       OR (kind = 'company' AND cardinality((SELECT app_led_teams())::uuid[]) > 0)));--> statement-breakpoint
CREATE POLICY web_update ON ingest_tokens FOR UPDATE TO app_web
  USING (company_id = (SELECT app_company())
    AND (user_id = (SELECT app_user()) OR (SELECT app_is_admin())
         OR (kind = 'company' AND cardinality((SELECT app_led_teams())::uuid[]) > 0)))
  WITH CHECK (company_id = (SELECT app_company()));--> statement-breakpoint
CREATE POLICY web_insert ON ingest_tokens FOR INSERT TO app_web WITH CHECK (
  company_id = (SELECT app_company())
  AND created_by_user_id = (SELECT app_user())
  AND ((kind = 'user' AND user_id = (SELECT app_user()))
    OR (kind = 'company' AND user_id IS NULL
        AND ((SELECT app_is_admin()) OR cardinality((SELECT app_led_teams())::uuid[]) > 0))));--> statement-breakpoint

-- ============ 9. functions (created as app_definer so it owns them) ============
SET ROLE app_definer;--> statement-breakpoint

-- 9a. Policy helpers FIRST: until replaced they still read users.company_id, which step 7 dropped (LANGUAGE sql
-- bodies have no dependency tracking). Same signatures, so grants survive.
-- The company of the RLS context, but only if app.user_id is a member of app.company_id.
CREATE OR REPLACE FUNCTION app_company() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.company_id FROM company_memberships m
  WHERE m.user_id = app_setting_uuid('app.user_id') AND m.company_id = app_setting_uuid('app.company_id')
$$;--> statement-breakpoint
-- Admin only if the context claims it AND the membership agrees (a stale/forged app.role cannot escalate).
CREATE OR REPLACE FUNCTION app_is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(current_setting('app.role', true), '') = 'admin' AND EXISTS (
    SELECT 1 FROM company_memberships m
    WHERE m.user_id = app_setting_uuid('app.user_id') AND m.company_id = app_setting_uuid('app.company_id')
      AND m.company_role = 'admin')
$$;--> statement-breakpoint

-- 9b. Trigger functions (D6, D11, D4).
-- Revocation is one-way: nobody, admins and app_definer included, can un-revoke or re-date a token.
CREATE FUNCTION ingest_tokens_revoke_once() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'a revoked ingest token stays revoked' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
-- Super admins hold no membership (replaces CHECK users_company_or_super_admin). FOR SHARE conflicts with the
-- no-key UPDATE of users.is_super_admin, so this check and the next one serialise instead of racing.
CREATE FUNCTION company_memberships_no_super_admin() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF (SELECT u.is_super_admin FROM users u WHERE u.id = NEW.user_id FOR SHARE) THEN
    RAISE EXCEPTION 'super admins cannot be company members' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE FUNCTION users_super_admin_no_membership() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.is_super_admin AND EXISTS (SELECT 1 FROM company_memberships m WHERE m.user_id = NEW.id) THEN
    RAISE EXCEPTION 'a company member cannot be a super admin' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
-- D4: the "last active company" survives logout and expiry. Fires on session insert and on a company switch only.
CREATE FUNCTION auth_sessions_mark_membership() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE company_memberships SET last_active_at = now()
  WHERE user_id = NEW.user_id AND company_id = NEW.active_company_id;
  RETURN NEW;
END $$;--> statement-breakpoint

-- 9c. Functions.
-- Plan capacity counts memberships (Q6). Mirrors PLAN_LIMITS in src/schema/settings.ts (free 3, team 50).
CREATE OR REPLACE FUNCTION company_has_user_capacity(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE c.plan WHEN 'free' THEN (SELECT count(*) FROM company_memberships m WHERE m.company_id = c.id) < 3
                     WHEN 'team' THEN (SELECT count(*) FROM company_memberships m WHERE m.company_id = c.id) < 50
                     ELSE true END
  FROM companies c WHERE c.id = p_company
$$;--> statement-breakpoint
-- Plan-limit counts for the console (return column still named "users" = members).
CREATE OR REPLACE FUNCTION platform_company_counts()
RETURNS TABLE (company_id uuid, users bigint, teams bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id,
    (SELECT count(*) FROM company_memberships m WHERE m.company_id = c.id),
    (SELECT count(*) FROM teams t WHERE t.company_id = c.id)
  FROM companies c
$$;--> statement-breakpoint
-- Identity plus membership counts (login happens before an RLS context exists).
CREATE FUNCTION auth_find_user_by_email(p_email text)
RETURNS TABLE (user_id uuid, email text, name text, is_super_admin boolean, memberships bigint, active_memberships bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.email, u.name, u.is_super_admin,
    (SELECT count(*) FROM company_memberships m WHERE m.user_id = u.id),
    (SELECT count(*) FROM company_memberships m JOIN companies c ON c.id = m.company_id AND c.status = 'active'
     WHERE m.user_id = u.id)
  FROM users u WHERE u.email = lower(trim(p_email))
$$;--> statement-breakpoint
CREATE FUNCTION auth_get_user(p_user_id uuid)
RETURNS TABLE (user_id uuid, email text, name text, is_super_admin boolean, memberships bigint, active_memberships bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.email, u.name, u.is_super_admin,
    (SELECT count(*) FROM company_memberships m WHERE m.user_id = u.id),
    (SELECT count(*) FROM company_memberships m JOIN companies c ON c.id = m.company_id AND c.status = 'active'
     WHERE m.user_id = u.id)
  FROM users u WHERE u.id = p_user_id
$$;--> statement-breakpoint
-- The switcher list and the active-company choice. Last active first (D4), then oldest membership.
CREATE FUNCTION auth_user_memberships(p_user_id uuid)
RETURNS TABLE (company_id uuid, company_name text, company_slug text, company_status company_status, plan plan,
  company_role company_role, primary_team_id uuid, last_active_at timestamptz, joined_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.company_id, c.name, c.slug, c.status, c.plan, m.company_role, m.primary_team_id, m.last_active_at, m.created_at
  FROM company_memberships m JOIN companies c ON c.id = m.company_id
  WHERE m.user_id = p_user_id
  ORDER BY m.last_active_at DESC NULLS LAST, m.created_at, c.slug
$$;--> statement-breakpoint
-- The switcher's write. Only an unexpired session, only to an active company the session's user is a member of.
-- NULL clears it. true = updated.
CREATE FUNCTION auth_set_session_company(p_token_hash text, p_company_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE auth_sessions s SET active_company_id = p_company_id
  WHERE s.token_hash = p_token_hash AND s.expires_at > now()
    AND (p_company_id IS NULL OR EXISTS (
      SELECT 1 FROM company_memberships m JOIN companies c ON c.id = m.company_id AND c.status = 'active'
      WHERE m.user_id = s.user_id AND m.company_id = p_company_id));
  RETURN FOUND;
END $$;--> statement-breakpoint
-- An invitation is offered unless the e-mail is ALREADY a member of that company (accounts in other companies now
-- see it) or belongs to a super admin.
CREATE OR REPLACE FUNCTION auth_pending_invitations(p_email text)
RETURNS TABLE (invitation_id uuid, company_name text, team_name text, company_role company_role,
  team_role team_role, invited_by_name text, invited_by_email text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.id, c.name, t.name, i.company_role, i.team_role, u.name, u.email, i.created_at
  FROM invitations i
  JOIN companies c ON c.id = i.company_id AND c.status = 'active'
  LEFT JOIN teams t ON t.id = i.team_id
  LEFT JOIN users u ON u.id = i.invited_by_user_id
  WHERE i.email = lower(trim(p_email)) AND i.accepted_at IS NULL AND i.expires_at > now()
    AND company_has_user_capacity(i.company_id)
    AND NOT EXISTS (SELECT 1 FROM users x JOIN company_memberships m ON m.user_id = x.id
                    WHERE x.email = lower(trim(p_email)) AND m.company_id = i.company_id)
    AND NOT EXISTS (SELECT 1 FROM users s WHERE s.email = lower(trim(p_email)) AND s.is_super_admin)
  ORDER BY i.created_at DESC
$$;--> statement-breakpoint
-- Accepts exactly the picked invitation (SEC-1). Finds or creates the identity and adds a membership + team
-- membership. Empty result when the invitation is not acceptable, the e-mail is already a member, a super admin,
-- or the company is full (dod:C2).
CREATE FUNCTION auth_accept_invitation(p_email text, p_name text, p_invitation_id uuid)
RETURNS TABLE (user_id uuid, company_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_email text := lower(trim(p_email));
  inv invitations;
  v_user uuid;
  v_super boolean := false;
BEGIN
  SELECT i.* INTO inv FROM invitations i JOIN companies c ON c.id = i.company_id AND c.status = 'active'
  WHERE i.id = p_invitation_id AND i.email = v_email AND i.accepted_at IS NULL AND i.expires_at > now()
  FOR UPDATE OF i;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM 1 FROM companies WHERE id = inv.company_id FOR UPDATE;   -- serialise accepts per company
  SELECT u.id, u.is_super_admin INTO v_user, v_super FROM users u WHERE u.email = v_email FOR UPDATE;
  IF coalesce(v_super, false) THEN RETURN; END IF;
  IF v_user IS NOT NULL AND EXISTS (SELECT 1 FROM company_memberships m
                                    WHERE m.company_id = inv.company_id AND m.user_id = v_user) THEN RETURN; END IF;
  IF NOT company_has_user_capacity(inv.company_id) THEN RETURN; END IF;
  IF v_user IS NULL THEN
    INSERT INTO users (email, name) VALUES (v_email, p_name)
    ON CONFLICT ((lower(email))) DO NOTHING RETURNING id INTO v_user;
    IF v_user IS NULL THEN SELECT u.id INTO v_user FROM users u WHERE u.email = v_email; END IF;
  END IF;
  INSERT INTO company_memberships (company_id, user_id, company_role, primary_team_id)
  VALUES (inv.company_id, v_user, inv.company_role, inv.team_id);
  IF inv.team_id IS NOT NULL THEN
    INSERT INTO team_memberships (company_id, team_id, user_id, role)
    VALUES (inv.company_id, inv.team_id, v_user, inv.team_role);
  END IF;
  UPDATE invitations SET accepted_at = now()
  WHERE company_id = inv.company_id AND email = v_email AND accepted_at IS NULL;
  RETURN QUERY SELECT v_user, inv.company_id;
END $$;--> statement-breakpoint
-- Solo sign-up (BRIEF §4): a new e-mail, or an identity with zero memberships (D5), gets a Free company with one
-- team, as admin + team lead. Refuses members and super admins.
CREATE OR REPLACE FUNCTION auth_create_solo_company(p_email text, p_name text, p_company_name text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_email text := lower(trim(p_email));
  v_company uuid; v_team uuid; v_user uuid; v_super boolean := false;
  v_slug text := trim(both '-' from regexp_replace(lower(p_company_name), '[^a-z0-9]+', '-', 'g'));
BEGIN
  SELECT id, is_super_admin INTO v_user, v_super FROM users WHERE email = v_email FOR UPDATE;
  IF v_user IS NOT NULL AND (v_super OR EXISTS (SELECT 1 FROM company_memberships WHERE user_id = v_user)) THEN
    RAISE EXCEPTION 'user % already exists', v_email USING ERRCODE = 'unique_violation';
  END IF;
  v_slug := left(coalesce(nullif(v_slug, ''), 'company'), 40) || '-' || substr(md5(random()::text), 1, 6);
  INSERT INTO companies (name, slug) VALUES (p_company_name, v_slug) RETURNING id INTO v_company;
  INSERT INTO teams (company_id, name) VALUES (v_company, p_company_name) RETURNING id INTO v_team;
  IF v_user IS NULL THEN
    INSERT INTO users (email, name) VALUES (v_email, p_name) RETURNING id INTO v_user;
  END IF;
  INSERT INTO company_memberships (company_id, user_id, company_role, primary_team_id) VALUES (v_company, v_user, 'admin', v_team);
  INSERT INTO team_memberships (company_id, team_id, user_id, role) VALUES (v_company, v_team, v_user, 'lead');
  RETURN v_user;
END $$;--> statement-breakpoint
-- Grants the platform flag to a user without memberships (SUPER_ADMIN_EMAILS); refuses company members.
CREATE OR REPLACE FUNCTION auth_ensure_super_admin(p_email text, p_name text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_email text := lower(trim(p_email)); v_user uuid;
BEGIN
  SELECT id INTO v_user FROM users WHERE email = v_email FOR UPDATE;   -- the triggers (9b) are the backstop
  IF v_user IS NULL THEN
    INSERT INTO users (email, name, is_super_admin) VALUES (v_email, p_name, true) RETURNING id INTO v_user;
  ELSIF EXISTS (SELECT 1 FROM company_memberships WHERE user_id = v_user) THEN
    RAISE EXCEPTION 'user % belongs to a company and cannot be a super admin', v_email;
  ELSE
    UPDATE users SET is_super_admin = true WHERE id = v_user;
  END IF;
  RETURN v_user;
END $$;--> statement-breakpoint
-- Replaces platform_email_in_use. Reveals only what the console needs: 'super_admin', 'admin' (of p_company_id)
-- or NULL (no account, or an account that is not an admin there). Plain membership is never disclosed to
-- app_platform (it has admin contacts only). NULL company = "is it a super admin?".
CREATE FUNCTION platform_invitee_status(p_email text, p_company_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN u.is_super_admin THEN 'super_admin'
              WHEN EXISTS (SELECT 1 FROM company_memberships m WHERE m.user_id = u.id AND m.company_id = p_company_id
                             AND m.company_role = 'admin') THEN 'admin' END
  FROM users u WHERE u.email = lower(trim(p_email))
$$;--> statement-breakpoint
-- Company + user + primary team in that company (no team binding). User tokens resolve only while the membership
-- exists (successor of SEC-4). Company name/slug and user e-mail feed collector-config (brief Q5).
CREATE FUNCTION lookup_ingest_token(p_hash text)
RETURNS TABLE (token_id uuid, kind token_kind, company_id uuid, company_name text, company_slug text,
  user_id uuid, user_email text, user_primary_team_id uuid, company_status company_status, plan plan, settings jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
    SELECT t.id, t.kind, t.company_id, c.name, c.slug, t.user_id, u.email, m.primary_team_id, c.status, c.plan, c.settings
    FROM ingest_tokens t
    JOIN companies c ON c.id = t.company_id
    LEFT JOIN company_memberships m ON m.company_id = t.company_id AND m.user_id = t.user_id
    LEFT JOIN users u ON u.id = t.user_id
    WHERE t.hash = p_hash AND t.revoked_at IS NULL
      AND CASE WHEN t.kind = 'user' THEN m.id IS NOT NULL
               -- D2 at use time, not only at removal / demotion: a company token works only while its creator is
               -- still an admin or a team lead of the company. A token inserted concurrently with the removal or
               -- demotion (the one-shot revoke cannot see it) is therefore never accepted.
               ELSE EXISTS (SELECT 1 FROM company_memberships cm
                            WHERE cm.company_id = t.company_id AND cm.user_id = t.created_by_user_id
                              AND (cm.company_role = 'admin'
                                   OR EXISTS (SELECT 1 FROM team_memberships tm
                                              WHERE tm.company_id = cm.company_id AND tm.user_id = cm.user_id
                                                AND tm.role = 'lead')))
          END;
  IF FOUND THEN
    UPDATE ingest_tokens it SET last_used_at = now()
    WHERE it.hash = p_hash AND it.revoked_at IS NULL
      AND (it.last_used_at IS NULL OR it.last_used_at < now() - interval '1 minute');
  END IF;
END $$;--> statement-breakpoint
-- Company-token attribution (Q2): any member of the ingest company. Bound to app_ingest_company(): a foreign
-- company id returns nothing, so another tenant's e-mails cannot be probed.
CREATE FUNCTION ingest_match_user_by_email(p_email text, p_company_id uuid)
RETURNS TABLE (user_id uuid, primary_team_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, m.primary_team_id
  FROM company_memberships m JOIN users u ON u.id = m.user_id
  WHERE m.company_id = p_company_id AND m.company_id = app_ingest_company() AND u.email = lower(trim(p_email))
$$;--> statement-breakpoint
-- D8, D2: removes a member from the RLS context's company. Admin only, never yourself. Revokes the member's user
-- tokens AND the company tokens they created in this company and returns them for the audit log. Clears sessions
-- pointing at the company, then deletes the membership; FK cascades delete the team memberships and per-user
-- budgets in this company. Raw telemetry, machines, runaway alerts and rollups keep their user_id (D1).
-- The last-admin guard stays in the app (it locks the admin memberships first).
CREATE FUNCTION admin_remove_member(p_user_id uuid)
RETURNS TABLE (token_id uuid, token_kind token_kind, token_name text, token_prefix text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE v_company uuid := app_company();
BEGIN
  IF v_company IS NULL OR NOT app_is_admin() THEN
    RAISE EXCEPTION 'only company admins can remove members' USING ERRCODE = '42501';
  END IF;
  IF p_user_id = app_user() THEN RAISE EXCEPTION 'cannot remove yourself' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM company_memberships m WHERE m.company_id = v_company AND m.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY
    UPDATE ingest_tokens t SET revoked_at = now()
    WHERE t.company_id = v_company AND t.revoked_at IS NULL
      AND (t.user_id = p_user_id OR (t.kind = 'company' AND t.created_by_user_id = p_user_id))
    RETURNING t.id, t.kind, t.name, t.prefix;
  UPDATE auth_sessions SET active_company_id = NULL WHERE user_id = p_user_id AND active_company_id = v_company;
  DELETE FROM company_memberships WHERE company_id = v_company AND user_id = p_user_id;
END $$;--> statement-breakpoint

-- 9d. Grants for new or recreated functions. Trigger functions need no EXECUTE grant for the roles whose writes
-- fire them (EXECUTE is checked by the owner at CREATE TRIGGER time).
REVOKE ALL ON FUNCTION auth_find_user_by_email(text), auth_get_user(uuid), auth_user_memberships(uuid),
  auth_set_session_company(text, uuid), auth_accept_invitation(text, text, uuid), admin_remove_member(uuid),
  lookup_ingest_token(text), ingest_match_user_by_email(text, uuid), platform_invitee_status(text, uuid),
  company_memberships_no_super_admin(), users_super_admin_no_membership(), auth_sessions_mark_membership(),
  ingest_tokens_revoke_once() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_find_user_by_email(text), auth_get_user(uuid), auth_user_memberships(uuid),
  auth_set_session_company(text, uuid), auth_accept_invitation(text, text, uuid), admin_remove_member(uuid)
  TO app_definer, app_web;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION lookup_ingest_token(text), ingest_match_user_by_email(text, uuid) TO app_definer, app_ingest;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_invitee_status(text, uuid) TO app_definer, app_platform;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint

-- ============ 10. triggers (CREATE TRIGGER needs the table owner, so after RESET ROLE) ============
CREATE TRIGGER ingest_tokens_revoke_once BEFORE UPDATE OF revoked_at ON ingest_tokens
  FOR EACH ROW EXECUTE FUNCTION ingest_tokens_revoke_once();--> statement-breakpoint
CREATE TRIGGER company_memberships_no_super_admin BEFORE INSERT OR UPDATE OF user_id ON company_memberships
  FOR EACH ROW EXECUTE FUNCTION company_memberships_no_super_admin();--> statement-breakpoint
CREATE TRIGGER users_super_admin_no_membership BEFORE INSERT OR UPDATE OF is_super_admin ON users
  FOR EACH ROW WHEN (NEW.is_super_admin) EXECUTE FUNCTION users_super_admin_no_membership();--> statement-breakpoint
CREATE TRIGGER auth_sessions_mark_membership AFTER INSERT OR UPDATE OF active_company_id ON auth_sessions
  FOR EACH ROW WHEN (NEW.active_company_id IS NOT NULL) EXECUTE FUNCTION auth_sessions_mark_membership();
