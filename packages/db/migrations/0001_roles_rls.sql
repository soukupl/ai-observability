-- Roles, grants, row-level security and SECURITY DEFINER functions (ADR-0006, ADR-0008).
-- Hand-written; tracked in the Drizzle journal like any other migration, so it runs exactly once and
-- in order. Later schema changes that add tables must add their grants + policies in a new migration.
--
-- Roles (NOLOGIN; services reach them via `SET ROLE` from the migrating user, or as LOGIN roles once
-- `src/migrate.ts` sets a password from DB_<ROLE>_PASSWORD):
--   app_web      dashboard; every query bound by RLS to app.company_id / app.user_id / app.role
--   app_ingest   ingest API; insert/patch telemetry for app.company_id, token lookup via function
--   app_worker   rollups, budgets, retention, e-mail; cross-company by design
--   app_platform super admin console; companies, plans, admin contacts, audit log; NO telemetry
--   app_definer  owns SECURITY DEFINER functions; never used for connections

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['app_web', 'app_ingest', 'app_worker', 'app_platform', 'app_definer'] LOOP
    -- Roles are cluster-wide. Several databases of one cluster may run this migration at the same time (the test
    -- suites do), so a concurrent CREATE of the same role is tolerated instead of failing on the duplicate name.
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      BEGIN
        EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT', r);
      EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
      END;
    END IF;
    IF NOT pg_has_role(current_user, r, 'MEMBER') THEN
      EXECUTE format('GRANT %I TO %I', r, current_user);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_web, app_ingest, app_worker, app_platform;
--> statement-breakpoint
-- Required so app_definer may own functions in this schema.
GRANT USAGE, CREATE ON SCHEMA public TO app_definer;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_definer;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Context helpers. The web app sets app.company_id / app.user_id / app.role with SET LOCAL
-- (set_config(..., true)) per transaction; ingest sets only app.company_id after token lookup.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_setting_uuid(p_name text) RETURNS uuid
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT nullif(current_setting(p_name, true), '')::uuid
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_user() RETURNS uuid
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT app_setting_uuid('app.user_id')
$$;
--> statement-breakpoint
-- The company of the RLS context, but only if app.user_id really is a user of app.company_id.
CREATE OR REPLACE FUNCTION app_company() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.company_id FROM users u
  WHERE u.id = app_setting_uuid('app.user_id') AND u.company_id = app_setting_uuid('app.company_id')
$$;
--> statement-breakpoint
-- Admin only if the context claims it AND the database agrees (a stale/forged app.role cannot escalate).
CREATE OR REPLACE FUNCTION app_is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(current_setting('app.role', true), '') = 'admin' AND EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = app_setting_uuid('app.user_id') AND u.company_id = app_setting_uuid('app.company_id')
      AND u.company_role = 'admin')
$$;
--> statement-breakpoint
-- Teams the context user leads ("lead" is a per-team role, read from team_memberships).
CREATE OR REPLACE FUNCTION app_led_teams() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(m.team_id), '{}') FROM team_memberships m
  WHERE m.user_id = app_setting_uuid('app.user_id') AND m.company_id = app_company() AND m.role = 'lead'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_member_teams() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(m.team_id), '{}') FROM team_memberships m
  WHERE m.user_id = app_setting_uuid('app.user_id') AND m.company_id = app_company()
$$;
--> statement-breakpoint
-- true = individual-visibility mode "full"; false = "aggregates-only" (default) or no context.
CREATE OR REPLACE FUNCTION app_full_visibility() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT c.settings->>'individualVisibility' = 'full' FROM companies c WHERE c.id = app_company()), false)
$$;
--> statement-breakpoint
-- Ingest context: the company resolved from the ingest token (no user context).
CREATE OR REPLACE FUNCTION app_ingest_company() RETURNS uuid
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT app_setting_uuid('app.company_id')
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Row-level security: enabled AND forced on every tenant table (the owner is bound too).
-- auth_accounts / auth_sessions / magic_links (pre-login identity) and model_prices (global)
-- carry no company_id and are protected by grants only.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['companies', 'teams', 'users', 'team_memberships', 'invitations', 'identity_providers',
    'ingest_tokens', 'machines', 'projects', 'ingest_events', 'agent_sessions', 'turns', 'runs', 'usage',
    'daily_rollups', 'budgets', 'audit_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS definer_all ON %I', t);
    EXECUTE format('CREATE POLICY definer_all ON %I TO app_definer USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- ===================================== app_web ==============================================
GRANT SELECT ON model_prices TO app_web;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_accounts, auth_sessions, magic_links TO app_web;
--> statement-breakpoint
GRANT SELECT, UPDATE (name, settings, updated_at) ON companies TO app_web;
--> statement-breakpoint
CREATE POLICY web_select ON companies FOR SELECT TO app_web USING (id = (SELECT app_company()));
--> statement-breakpoint
CREATE POLICY web_update ON companies FOR UPDATE TO app_web
  USING (id = (SELECT app_company()) AND (SELECT app_is_admin()))
  WITH CHECK (id = (SELECT app_company()) AND (SELECT app_is_admin()));
--> statement-breakpoint
-- Company directory tables: readable by everyone in the company, writable by company admins.
GRANT SELECT, INSERT, UPDATE (name), DELETE ON teams TO app_web;
--> statement-breakpoint
GRANT SELECT, UPDATE (name, company_role, primary_team_id), DELETE ON users TO app_web;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (role), DELETE ON team_memberships TO app_web;
--> statement-breakpoint
GRANT SELECT, UPDATE (display_name, team_id) ON projects TO app_web;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['teams', 'users', 'team_memberships', 'projects'] LOOP
    EXECUTE format($p$CREATE POLICY web_select ON %I FOR SELECT TO app_web
      USING (company_id = (SELECT app_company()))$p$, t);
    EXECUTE format($p$CREATE POLICY web_admin_write ON %I FOR ALL TO app_web
      USING (company_id = (SELECT app_company()) AND (SELECT app_is_admin()))
      WITH CHECK (company_id = (SELECT app_company()) AND (SELECT app_is_admin()))$p$, t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Admin-only tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON invitations, identity_providers TO app_web;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invitations', 'identity_providers'] LOOP
    EXECUTE format($p$CREATE POLICY web_admin_all ON %I FOR ALL TO app_web
      USING (company_id = (SELECT app_company()) AND (SELECT app_is_admin()))
      WITH CHECK (company_id = (SELECT app_company()) AND (SELECT app_is_admin()))$p$, t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Telemetry: own rows always; other people's rows only in "full" mode (admins: company, leads: led teams).
-- In "aggregates-only" mode leads/admins read other people's data only through the agg_* functions.
GRANT SELECT ON agent_sessions, turns, runs, usage, daily_rollups TO app_web;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_sessions', 'turns', 'runs', 'usage', 'daily_rollups'] LOOP
    EXECUTE format($p$CREATE POLICY web_select ON %I FOR SELECT TO app_web USING (
      company_id = (SELECT app_company())
      AND (user_id = (SELECT app_user())
           OR ((SELECT app_full_visibility())
               AND ((SELECT app_is_admin()) OR team_id = ANY ((SELECT app_led_teams())::uuid[])))))$p$, t);
  END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT ON machines TO app_web;
--> statement-breakpoint
CREATE POLICY web_select ON machines FOR SELECT TO app_web USING (
  company_id = (SELECT app_company())
  AND (user_id = (SELECT app_user()) OR ((SELECT app_full_visibility()) AND (SELECT app_is_admin()))));
--> statement-breakpoint
-- Ingest tokens: own user tokens; team tokens of led teams; admins everything in the company.
GRANT SELECT, INSERT, UPDATE (name, revoked_at) ON ingest_tokens TO app_web;
--> statement-breakpoint
CREATE POLICY web_select ON ingest_tokens FOR SELECT TO app_web USING (
  company_id = (SELECT app_company())
  AND (user_id = (SELECT app_user()) OR (SELECT app_is_admin())
       OR (kind = 'team' AND team_id = ANY ((SELECT app_led_teams())::uuid[]))));
--> statement-breakpoint
CREATE POLICY web_update ON ingest_tokens FOR UPDATE TO app_web
  USING (company_id = (SELECT app_company())
    AND (user_id = (SELECT app_user()) OR (SELECT app_is_admin())
         OR (kind = 'team' AND team_id = ANY ((SELECT app_led_teams())::uuid[]))))
  WITH CHECK (company_id = (SELECT app_company()));
--> statement-breakpoint
CREATE POLICY web_insert ON ingest_tokens FOR INSERT TO app_web WITH CHECK (
  company_id = (SELECT app_company())
  AND created_by_user_id = (SELECT app_user())
  AND ((kind = 'user' AND user_id = (SELECT app_user())
        AND ((SELECT app_is_admin()) OR team_id = ANY ((SELECT app_member_teams())::uuid[])))
    OR (kind = 'team' AND ((SELECT app_is_admin()) OR team_id = ANY ((SELECT app_led_teams())::uuid[])))));
--> statement-breakpoint
-- Budgets: admins manage; leads view their teams' budgets; members view their own.
GRANT SELECT, INSERT, UPDATE (team_id, user_id, kind, limit_value, updated_at), DELETE ON budgets TO app_web;
--> statement-breakpoint
CREATE POLICY web_select ON budgets FOR SELECT TO app_web USING (
  company_id = (SELECT app_company())
  AND ((SELECT app_is_admin()) OR team_id = ANY ((SELECT app_led_teams())::uuid[]) OR user_id = (SELECT app_user())));
--> statement-breakpoint
CREATE POLICY web_admin_write ON budgets FOR ALL TO app_web
  USING (company_id = (SELECT app_company()) AND (SELECT app_is_admin()))
  WITH CHECK (company_id = (SELECT app_company()) AND (SELECT app_is_admin()));
--> statement-breakpoint
-- Audit log: anyone appends their own actions; admins read the company log.
GRANT SELECT, INSERT ON audit_log TO app_web;
--> statement-breakpoint
CREATE POLICY web_select ON audit_log FOR SELECT TO app_web
  USING (company_id = (SELECT app_company()) AND (SELECT app_is_admin()));
--> statement-breakpoint
CREATE POLICY web_insert ON audit_log FOR INSERT TO app_web
  WITH CHECK (company_id = (SELECT app_company()) AND actor_user_id = (SELECT app_user()));
--> statement-breakpoint

-- ==================================== app_ingest ============================================
-- Inserts and patches telemetry of app.company_id only. Column-level SELECT is limited to the
-- identity columns needed to resolve foreign keys / RETURNING ids; no metrics, no summaries.
DO $$
DECLARE
  t text;
  sel text[];
  upd text;
  tables text[] := ARRAY['ingest_events', 'machines', 'projects', 'agent_sessions', 'turns', 'runs', 'usage'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    sel := CASE t
      WHEN 'ingest_events' THEN ARRAY['id', 'company_id', 'event_id']
      WHEN 'machines' THEN ARRAY['id', 'company_id', 'machine_id', 'user_id']
      WHEN 'projects' THEN ARRAY['id', 'company_id', 'key', 'team_id']
      WHEN 'agent_sessions' THEN ARRAY['id', 'company_id', 'external_id', 'team_id', 'user_id', 'project_id', 'machine_id', 'harness']
      WHEN 'turns' THEN ARRAY['id', 'company_id', 'external_id', 'session_id', 'team_id', 'user_id', 'project_id']
      WHEN 'runs' THEN ARRAY['id', 'company_id', 'turn_id', 'turn_external_id', 'external_id', 'parent_run_id', 'parent_external_id', 'team_id', 'user_id']
      WHEN 'usage' THEN ARRAY['id', 'company_id', 'turn_id', 'run_id', 'model', 'effort']
    END;
    EXECUTE format('GRANT INSERT ON %I TO app_ingest', t);
    EXECUTE format('GRANT SELECT (%s) ON %I TO app_ingest',
      (SELECT string_agg(quote_ident(c), ', ') FROM unnest(sel) c), t);
    IF t <> 'ingest_events' THEN
      SELECT string_agg(quote_ident(column_name), ', ') INTO upd FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name NOT IN ('id', 'company_id', 'created_at');
      EXECUTE format('GRANT UPDATE (%s) ON %I TO app_ingest', upd, t);
    END IF;
    EXECUTE format($p$CREATE POLICY ingest_company ON %I FOR ALL TO app_ingest
      USING (company_id = (SELECT app_ingest_company()))
      WITH CHECK (company_id = (SELECT app_ingest_company()))$p$, t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Resolves an ingest token by its hash (the only read path to ingest_tokens / companies / users for
-- app_ingest). Revoked tokens return no row. Touches last_used_at at most once a minute.
CREATE OR REPLACE FUNCTION lookup_ingest_token(p_hash text)
RETURNS TABLE (token_id uuid, kind token_kind, company_id uuid, team_id uuid, user_id uuid,
  user_primary_team_id uuid, company_status company_status, plan plan, settings jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
    SELECT t.id, t.kind, t.company_id, t.team_id, t.user_id, u.primary_team_id, c.status, c.plan, c.settings
    FROM ingest_tokens t
    JOIN companies c ON c.id = t.company_id
    LEFT JOIN users u ON u.id = t.user_id
    WHERE t.hash = p_hash AND t.revoked_at IS NULL;
  UPDATE ingest_tokens it SET last_used_at = now()
  WHERE it.hash = p_hash AND it.revoked_at IS NULL
    AND (it.last_used_at IS NULL OR it.last_used_at < now() - interval '1 minute');
END $$;
--> statement-breakpoint
-- Team-token attribution: match a git e-mail to a user of the ingest context's company (ADR-0007).
CREATE OR REPLACE FUNCTION ingest_match_user_by_email(p_email text)
RETURNS TABLE (user_id uuid, primary_team_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.primary_team_id FROM users u
  WHERE u.company_id = app_ingest_company() AND u.email = lower(trim(p_email))
$$;
--> statement-breakpoint

-- ==================================== app_worker ============================================
-- Cross-company by design (rollups, budgets, retention, e-mail); bounded by grants.
GRANT SELECT ON companies, teams, users, team_memberships, projects, machines, agent_sessions, turns, runs,
  usage, daily_rollups, budgets, model_prices, ingest_events TO app_worker;
--> statement-breakpoint
GRANT INSERT, UPDATE, DELETE ON daily_rollups TO app_worker;
--> statement-breakpoint
GRANT DELETE ON agent_sessions, turns, runs, usage, ingest_events, machines TO app_worker;
--> statement-breakpoint
GRANT UPDATE (notified_period, notified_80_at, notified_100_at) ON budgets TO app_worker;
--> statement-breakpoint
GRANT INSERT ON audit_log TO app_worker;
--> statement-breakpoint
GRANT SELECT, DELETE ON auth_sessions, magic_links TO app_worker;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['companies', 'teams', 'users', 'team_memberships', 'projects', 'machines',
    'agent_sessions', 'turns', 'runs', 'usage', 'daily_rollups', 'budgets', 'ingest_events', 'audit_log'] LOOP
    EXECUTE format('CREATE POLICY worker_all ON %I TO app_worker USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- =================================== app_platform ===========================================
-- Super admin: companies, plans, admin contacts, audit log, prices. No grants on telemetry
-- (turns, runs, usage, agent_sessions, daily_rollups, projects, machines, ...).
GRANT SELECT, INSERT, UPDATE, DELETE ON companies TO app_platform;
--> statement-breakpoint
CREATE POLICY platform_all ON companies TO app_platform USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT ON users TO app_platform;
--> statement-breakpoint
CREATE POLICY platform_admin_contacts ON users FOR SELECT TO app_platform
  USING (company_role = 'admin' OR is_super_admin);
--> statement-breakpoint
-- The super admin may invite a company's first admin.
GRANT SELECT, INSERT ON invitations TO app_platform;
--> statement-breakpoint
CREATE POLICY platform_admin_invites ON invitations TO app_platform
  USING (company_role = 'admin') WITH CHECK (company_role = 'admin');
--> statement-breakpoint
GRANT SELECT, INSERT ON audit_log TO app_platform;
--> statement-breakpoint
CREATE POLICY platform_all ON audit_log TO app_platform USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON model_prices TO app_platform;
--> statement-breakpoint
-- Plan-limit counts for the console (no telemetry, no names).
CREATE OR REPLACE FUNCTION platform_company_counts()
RETURNS TABLE (company_id uuid, users bigint, teams bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id,
    (SELECT count(*) FROM users u WHERE u.company_id = c.id),
    (SELECT count(*) FROM teams t WHERE t.company_id = c.id)
  FROM companies c
$$;
--> statement-breakpoint

-- ================================ auth (pre-login, app_web) =================================
-- Login happens before an RLS context exists, so these narrow functions are the only way the auth
-- code reads or creates users without a company context.
CREATE OR REPLACE FUNCTION auth_find_user_by_email(p_email text)
RETURNS TABLE (user_id uuid, company_id uuid, email text, name text, company_role company_role,
  is_super_admin boolean, company_status company_status)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.company_id, u.email, u.name, u.company_role, u.is_super_admin, c.status
  FROM users u LEFT JOIN companies c ON c.id = u.company_id
  WHERE u.email = lower(trim(p_email))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION auth_get_user(p_user_id uuid)
RETURNS TABLE (user_id uuid, company_id uuid, email text, name text, company_role company_role,
  is_super_admin boolean, company_status company_status)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.company_id, u.email, u.name, u.company_role, u.is_super_admin, c.status
  FROM users u LEFT JOIN companies c ON c.id = u.company_id
  WHERE u.id = p_user_id
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION auth_record_login(p_user_id uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE users SET last_login_at = now() WHERE id = p_user_id
$$;
--> statement-breakpoint
-- Accepts the newest pending invitation for the e-mail: creates the user, the team membership and
-- marks the company's invitations for that e-mail accepted. Returns null if none / user exists.
CREATE OR REPLACE FUNCTION auth_accept_invitation(p_email text, p_name text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_email text := lower(trim(p_email));
  inv invitations;
  v_user uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE email = v_email) THEN RETURN NULL; END IF;
  SELECT * INTO inv FROM invitations
  WHERE email = v_email AND accepted_at IS NULL AND expires_at > now()
  ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO users (company_id, email, name, company_role, primary_team_id)
  VALUES (inv.company_id, v_email, p_name, inv.company_role, inv.team_id)
  RETURNING id INTO v_user;
  IF inv.team_id IS NOT NULL THEN
    INSERT INTO team_memberships (company_id, team_id, user_id, role)
    VALUES (inv.company_id, inv.team_id, v_user, inv.team_role);
  END IF;
  UPDATE invitations SET accepted_at = now()
  WHERE company_id = inv.company_id AND email = v_email AND accepted_at IS NULL;
  RETURN v_user;
END $$;
--> statement-breakpoint
-- Solo sign-up (BRIEF §4): a Free company with one team and the user as admin + team lead.
CREATE OR REPLACE FUNCTION auth_create_solo_company(p_email text, p_name text, p_company_name text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_email text := lower(trim(p_email));
  v_company uuid;
  v_team uuid;
  v_user uuid;
  v_slug text := trim(both '-' from regexp_replace(lower(p_company_name), '[^a-z0-9]+', '-', 'g'));
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE email = v_email) THEN
    RAISE EXCEPTION 'user % already exists', v_email USING ERRCODE = 'unique_violation';
  END IF;
  v_slug := left(coalesce(nullif(v_slug, ''), 'company'), 40) || '-' || substr(md5(random()::text), 1, 6);
  INSERT INTO companies (name, slug) VALUES (p_company_name, v_slug) RETURNING id INTO v_company;
  INSERT INTO teams (company_id, name) VALUES (v_company, p_company_name) RETURNING id INTO v_team;
  INSERT INTO users (company_id, email, name, company_role, primary_team_id)
  VALUES (v_company, v_email, p_name, 'admin', v_team) RETURNING id INTO v_user;
  INSERT INTO team_memberships (company_id, team_id, user_id, role) VALUES (v_company, v_team, v_user, 'lead');
  RETURN v_user;
END $$;
--> statement-breakpoint
-- Grants the platform flag to a company-less user (SUPER_ADMIN_EMAILS); refuses company members.
CREATE OR REPLACE FUNCTION auth_ensure_super_admin(p_email text, p_name text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_email text := lower(trim(p_email));
  v_user uuid;
  v_company uuid;
BEGIN
  SELECT id, company_id INTO v_user, v_company FROM users WHERE email = v_email;
  IF v_user IS NULL THEN
    INSERT INTO users (email, name, is_super_admin) VALUES (v_email, p_name, true) RETURNING id INTO v_user;
  ELSIF v_company IS NOT NULL THEN
    RAISE EXCEPTION 'user % belongs to a company and cannot be a super admin', v_email;
  ELSE
    UPDATE users SET is_super_admin = true WHERE id = v_user;
  END IF;
  RETURN v_user;
END $$;
--> statement-breakpoint

-- ============================ cost + aggregate-only read path ===============================
-- ≈ cost at API list prices with the model_prices row effective on p_day (NULL if no price).
-- Reasoning tokens are part of output tokens and are not billed again.
CREATE OR REPLACE FUNCTION estimate_cost_usd(p_model text, p_day date, p_input bigint, p_output bigint,
  p_cache_read bigint, p_cache_write bigint) RETURNS numeric
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT (p_input * mp.input_per_mtok + p_output * mp.output_per_mtok
          + p_cache_read * mp.cache_read_per_mtok + p_cache_write * mp.cache_write_per_mtok) / 1000000
  FROM model_prices mp
  WHERE mp.model = p_model AND mp.effective_from <= p_day
  ORDER BY mp.effective_from DESC LIMIT 1
$$;
--> statement-breakpoint
-- Turns the caller may aggregate: own turns; admins the whole company; leads their led teams.
-- Valid in BOTH visibility modes because callers only ever get aggregates (or rows without user_id).
-- Internal: not executable by app_web directly.
CREATE OR REPLACE FUNCTION agg_scope_turns(p_from timestamptz, p_to timestamptz, p_team_id uuid,
  p_project_id uuid, p_harness text, p_model text) RETURNS SETOF turns
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.* FROM turns t
  WHERE t.company_id = app_company()
    AND t.started_at >= p_from AND t.started_at < p_to
    AND (t.user_id = app_user() OR app_is_admin() OR t.team_id = ANY (app_led_teams()))
    AND (p_team_id IS NULL OR t.team_id = p_team_id)
    AND (p_project_id IS NULL OR t.project_id = p_project_id)
    AND (p_harness IS NULL OR t.harness = p_harness)
    AND (p_model IS NULL OR t.model = p_model)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_turns_daily(p_from timestamptz, p_to timestamptz, p_team_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL, p_harness text DEFAULT NULL, p_model text DEFAULT NULL)
RETURNS TABLE (day date, turns bigint, success bigint, failed bigint, abandoned bigint, unknown bigint,
  duration_ms bigint, median_duration_ms double precision, input_tokens bigint, output_tokens bigint,
  cache_read_tokens bigint, cache_write_tokens bigint, reasoning_tokens bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (t.started_at AT TIME ZONE 'UTC')::date, count(*),
    count(*) FILTER (WHERE t.outcome = 'success'), count(*) FILTER (WHERE t.outcome = 'failed'),
    count(*) FILTER (WHERE t.outcome = 'abandoned'), count(*) FILTER (WHERE t.outcome = 'unknown'),
    sum(t.duration_ms)::bigint, percentile_cont(0.5) WITHIN GROUP (ORDER BY t.duration_ms),
    sum(t.input_tokens)::bigint, sum(t.output_tokens)::bigint, sum(t.cache_read_tokens)::bigint,
    sum(t.cache_write_tokens)::bigint, sum(t.reasoning_tokens)::bigint
  FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, p_model) t
  GROUP BY 1 ORDER BY 1
$$;
--> statement-breakpoint
-- Tokens + ≈ cost per day × model × effort, from usage rows (handles mixed-model turns).
CREATE OR REPLACE FUNCTION agg_usage_daily(p_from timestamptz, p_to timestamptz, p_team_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL, p_harness text DEFAULT NULL, p_model text DEFAULT NULL)
RETURNS TABLE (day date, model text, effort text, input_tokens bigint, output_tokens bigint,
  cache_read_tokens bigint, cache_write_tokens bigint, reasoning_tokens bigint, requests bigint, est_cost_usd numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.day, d.model, d.effort, d.i, d.o, d.cr, d.cw, d.r, d.rq, estimate_cost_usd(d.model, d.day, d.i, d.o, d.cr, d.cw)
  FROM (
    SELECT (u.started_at AT TIME ZONE 'UTC')::date AS day, u.model, u.effort,
      sum(u.input_tokens)::bigint AS i, sum(u.output_tokens)::bigint AS o, sum(u.cache_read_tokens)::bigint AS cr,
      sum(u.cache_write_tokens)::bigint AS cw, sum(u.reasoning_tokens)::bigint AS r, sum(u.requests)::bigint AS rq
    FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, NULL) t
    JOIN usage u ON u.turn_id = t.id AND u.company_id = t.company_id
    WHERE p_model IS NULL OR u.model = p_model
    GROUP BY 1, 2, 3
  ) d
  ORDER BY 1, 2, 3
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_turns_by_project(p_from timestamptz, p_to timestamptz, p_team_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL, p_harness text DEFAULT NULL, p_model text DEFAULT NULL)
RETURNS TABLE (project_id uuid, turns bigint, success bigint, failed bigint, abandoned bigint, unknown bigint,
  duration_ms bigint, input_tokens bigint, output_tokens bigint, cache_read_tokens bigint,
  cache_write_tokens bigint, reasoning_tokens bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.project_id, count(*),
    count(*) FILTER (WHERE t.outcome = 'success'), count(*) FILTER (WHERE t.outcome = 'failed'),
    count(*) FILTER (WHERE t.outcome = 'abandoned'), count(*) FILTER (WHERE t.outcome = 'unknown'),
    sum(t.duration_ms)::bigint, sum(t.input_tokens)::bigint, sum(t.output_tokens)::bigint,
    sum(t.cache_read_tokens)::bigint, sum(t.cache_write_tokens)::bigint, sum(t.reasoning_tokens)::bigint
  FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, p_model) t
  GROUP BY 1
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agg_turns_by_model(p_from timestamptz, p_to timestamptz, p_team_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL, p_harness text DEFAULT NULL, p_model text DEFAULT NULL)
RETURNS TABLE (model text, effort text, turns bigint, success bigint, failed bigint, abandoned bigint,
  unknown bigint, duration_ms bigint, median_duration_ms double precision, input_tokens bigint,
  output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint, reasoning_tokens bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.model, t.effort, count(*),
    count(*) FILTER (WHERE t.outcome = 'success'), count(*) FILTER (WHERE t.outcome = 'failed'),
    count(*) FILTER (WHERE t.outcome = 'abandoned'), count(*) FILTER (WHERE t.outcome = 'unknown'),
    sum(t.duration_ms)::bigint, percentile_cont(0.5) WITHIN GROUP (ORDER BY t.duration_ms),
    sum(t.input_tokens)::bigint, sum(t.output_tokens)::bigint, sum(t.cache_read_tokens)::bigint,
    sum(t.cache_write_tokens)::bigint, sum(t.reasoning_tokens)::bigint
  FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, p_model) t
  GROUP BY 1, 2
$$;
--> statement-breakpoint
-- Phase milliseconds grouped by p_group: 'team' | 'project' | 'model' | 'day' (group_key as text).
CREATE OR REPLACE FUNCTION agg_phases(p_group text, p_from timestamptz, p_to timestamptz, p_team_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL, p_harness text DEFAULT NULL, p_model text DEFAULT NULL)
RETURNS TABLE (group_key text, phase text, ms bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
$$;
--> statement-breakpoint
-- Sub-agent usage by agent type (runs of visible turns).
CREATE OR REPLACE FUNCTION agg_agents(p_from timestamptz, p_to timestamptz, p_team_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL, p_harness text DEFAULT NULL, p_model text DEFAULT NULL)
RETURNS TABLE (agent_type text, runs bigint, success bigint, failed bigint, abandoned bigint, unknown bigint,
  duration_ms bigint, input_tokens bigint, output_tokens bigint, cache_read_tokens bigint,
  cache_write_tokens bigint, reasoning_tokens bigint, avg_depth numeric, max_depth integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.agent_type, count(*),
    count(*) FILTER (WHERE r.outcome = 'success'), count(*) FILTER (WHERE r.outcome = 'failed'),
    count(*) FILTER (WHERE r.outcome = 'abandoned'), count(*) FILTER (WHERE r.outcome = 'unknown'),
    sum(r.duration_ms)::bigint, sum(r.input_tokens)::bigint, sum(r.output_tokens)::bigint,
    sum(r.cache_read_tokens)::bigint, sum(r.cache_write_tokens)::bigint, sum(r.reasoning_tokens)::bigint,
    avg(r.depth), max(r.depth)
  FROM agg_scope_turns(p_from, p_to, p_team_id, p_project_id, p_harness, p_model) t
  JOIN runs r ON r.turn_id = t.id AND r.company_id = t.company_id
  GROUP BY 1
$$;
--> statement-breakpoint
-- Turns explorer without attribution: never returns user_id; is_mine marks the caller's own turns.
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
  ORDER BY t.started_at DESC
  LIMIT least(greatest(p_limit, 0), 1000) OFFSET greatest(p_offset, 0)
$$;
--> statement-breakpoint
-- Run tree of one visible turn, without user_id.
CREATE OR REPLACE FUNCTION agg_turn_runs(p_turn_id uuid)
RETURNS TABLE (id uuid, parent_run_id uuid, agent_type text, depth integer, model text, effort text,
  started_at timestamptz, ended_at timestamptz, duration_ms bigint, input_tokens bigint, output_tokens bigint,
  cache_read_tokens bigint, cache_write_tokens bigint, reasoning_tokens bigint, phases_ms jsonb, tools jsonb,
  outcome outcome)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.parent_run_id, r.agent_type, r.depth, r.model, r.effort, r.started_at, r.ended_at, r.duration_ms,
    r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens, r.reasoning_tokens,
    r.phases_ms, r.tools, r.outcome
  FROM turns t JOIN runs r ON r.turn_id = t.id AND r.company_id = t.company_id
  WHERE t.id = p_turn_id AND t.company_id = app_company()
    AND (t.user_id = app_user() OR app_is_admin() OR t.team_id = ANY (app_led_teams()))
  ORDER BY r.started_at
$$;
--> statement-breakpoint
-- Long-range charts from daily rollups, collapsed over users (rows keep no user dimension).
CREATE OR REPLACE FUNCTION agg_rollups(p_from date, p_to date, p_team_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL, p_harness text DEFAULT NULL, p_model text DEFAULT NULL)
RETURNS TABLE (day date, team_id uuid, project_id uuid, harness text, model text, effort text, turns bigint,
  runs bigint, input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint,
  reasoning_tokens bigint, requests bigint, duration_ms bigint, success bigint, failed bigint, abandoned bigint,
  unknown bigint, est_cost_usd numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT g.*, estimate_cost_usd(g.model, g.day, g.i, g.o, g.cr, g.cw)
  FROM (
    SELECT d.day::date AS day, d.team_id, d.project_id, d.harness, d.model, d.effort,
      sum(d.turns)::bigint, sum(d.runs)::bigint, sum(d.input_tokens)::bigint AS i, sum(d.output_tokens)::bigint AS o,
      sum(d.cache_read_tokens)::bigint AS cr, sum(d.cache_write_tokens)::bigint AS cw, sum(d.reasoning_tokens)::bigint,
      sum(d.requests)::bigint, sum(d.duration_ms)::bigint, sum(d.success)::bigint, sum(d.failed)::bigint,
      sum(d.abandoned)::bigint, sum(d.unknown)::bigint
    FROM daily_rollups d
    WHERE d.company_id = app_company()
      AND d.day >= p_from AND d.day < p_to
      AND (d.user_id = app_user() OR app_is_admin() OR d.team_id = ANY (app_led_teams()))
      AND (p_team_id IS NULL OR d.team_id = p_team_id)
      AND (p_project_id IS NULL OR d.project_id = p_project_id)
      AND (p_harness IS NULL OR d.harness = p_harness)
      AND (p_model IS NULL OR d.model = p_model)
    GROUP BY 1, 2, 3, 4, 5, 6
  ) g
  ORDER BY g.day
$$;
--> statement-breakpoint

-- ===================================== ownership + EXECUTE ==================================
-- PostgreSQL grants EXECUTE to PUBLIC by default; revoke it everywhere, then grant per role.
DO $$
DECLARE
  f regprocedure;
  definer_fns text[] := ARRAY['app_company', 'app_is_admin', 'app_led_teams', 'app_member_teams',
    'app_full_visibility', 'lookup_ingest_token', 'ingest_match_user_by_email', 'platform_company_counts',
    'auth_find_user_by_email', 'auth_get_user', 'auth_record_login', 'auth_accept_invitation',
    'auth_create_solo_company', 'auth_ensure_super_admin', 'agg_scope_turns', 'agg_turns_daily',
    'agg_usage_daily', 'agg_turns_by_project', 'agg_turns_by_model', 'agg_phases', 'agg_agents',
    'agg_turn_list', 'agg_turn_runs', 'agg_rollups'];
  all_fns text[] := definer_fns || ARRAY['app_setting_uuid', 'app_user', 'app_ingest_company', 'estimate_cost_usd'];
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = ANY (all_fns) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO app_definer', f);
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = ANY (definer_fns) LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO app_definer', f);
  END LOOP;
END $$;
--> statement-breakpoint
-- Policy helpers (called while evaluating app_web / app_ingest policies).
GRANT EXECUTE ON FUNCTION app_setting_uuid(text), app_user(), app_company(), app_is_admin(), app_led_teams(),
  app_member_teams(), app_full_visibility() TO app_web;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_setting_uuid(text), app_ingest_company(), lookup_ingest_token(text),
  ingest_match_user_by_email(text) TO app_ingest;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_find_user_by_email(text), auth_get_user(uuid), auth_record_login(uuid),
  auth_accept_invitation(text, text), auth_create_solo_company(text, text, text), auth_ensure_super_admin(text, text),
  estimate_cost_usd(text, date, bigint, bigint, bigint, bigint),
  agg_turns_daily(timestamptz, timestamptz, uuid, uuid, text, text),
  agg_usage_daily(timestamptz, timestamptz, uuid, uuid, text, text),
  agg_turns_by_project(timestamptz, timestamptz, uuid, uuid, text, text),
  agg_turns_by_model(timestamptz, timestamptz, uuid, uuid, text, text),
  agg_phases(text, timestamptz, timestamptz, uuid, uuid, text, text),
  agg_agents(timestamptz, timestamptz, uuid, uuid, text, text),
  agg_turn_list(timestamptz, timestamptz, uuid, uuid, text, text, outcome, integer, integer),
  agg_turn_runs(uuid),
  agg_rollups(date, date, uuid, uuid, text, text) TO app_web;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION estimate_cost_usd(text, date, bigint, bigint, bigint, bigint) TO app_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_company_counts() TO app_platform;
