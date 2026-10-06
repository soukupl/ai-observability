ALTER TABLE "companies" ADD COLUMN "project_salt" text DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_turn_patches" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "pending_turn_patches" ADD CONSTRAINT "pending_turn_patches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- =============================== hand-written part ===============================
-- Review fixes SEC-1 (explicit invitation consent), SEC-3 (parked-patch ownership), SEC-4 (user tokens
-- need a live membership), SEC-6 (platform audit scope), SEC-7 (platform e-mail check), SEC-10 (team-token
-- attribution limited to the token's team), SEC-11 (per-company project salt), dod:C2 (capacity at
-- accept time). Functions are (re)created as app_definer (it holds CREATE on public, see 0001/0003), so
-- they keep that owner; new ones get their grants explicitly.
SET ROLE app_definer;
--> statement-breakpoint

-- Plan capacity of a company: true while it can add one more user (members, not counting pending
-- invitations). Mirrors PLAN_LIMITS in src/schema/settings.ts (free 3, team 50, business unlimited).
CREATE OR REPLACE FUNCTION company_has_user_capacity(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE c.plan WHEN 'free' THEN (SELECT count(*) FROM users u WHERE u.company_id = c.id) < 3
                     WHEN 'team' THEN (SELECT count(*) FROM users u WHERE u.company_id = c.id) < 50
                     ELSE true END
  FROM companies c WHERE c.id = p_company
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION company_has_user_capacity(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION company_has_user_capacity(uuid) TO app_definer;
--> statement-breakpoint

-- SEC-1: the invitations the sign-up step offers to a verified e-mail that has no user yet. Newest
-- first. Only pending, unexpired invitations of active companies that still have room for the user.
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
    AND NOT EXISTS (SELECT 1 FROM users x WHERE x.email = lower(trim(p_email)))
  ORDER BY i.created_at DESC
$$;
--> statement-breakpoint

-- SEC-1: accepts exactly the invitation the user picked (never "the newest"): it must be for this
-- e-mail, pending, unexpired, of an active company with room (dod:C2: plan user limit at accept time).
-- NULL otherwise, or when a user with that e-mail exists. Marks the company's invitations for that
-- e-mail accepted.
CREATE OR REPLACE FUNCTION auth_accept_invitation(p_email text, p_name text, p_invitation_id uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_email text := lower(trim(p_email));
  inv invitations;
  v_user uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE email = v_email) THEN RETURN NULL; END IF;
  SELECT i.* INTO inv FROM invitations i JOIN companies c ON c.id = i.company_id AND c.status = 'active'
  WHERE i.id = p_invitation_id AND i.email = v_email AND i.accepted_at IS NULL AND i.expires_at > now()
  FOR UPDATE OF i;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- Serialise concurrent accepts for one company so the capacity check cannot be raced.
  PERFORM 1 FROM companies WHERE id = inv.company_id FOR UPDATE;
  IF NOT company_has_user_capacity(inv.company_id) THEN RETURN NULL; END IF;
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
-- The old two-argument form picked the newest invitation by itself (SEC-1): gone.
DROP FUNCTION auth_accept_invitation(text, text);
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_pending_invitations(text), auth_accept_invitation(text, text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_pending_invitations(text), auth_accept_invitation(text, text, uuid) TO app_definer, app_web;
--> statement-breakpoint

-- SEC-4 (defence in depth): a user token only resolves while its user is still a member of the token's
-- team (removeMember also revokes it). Team tokens are unaffected. Replaces the 0001 body.
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
    WHERE t.hash = p_hash AND t.revoked_at IS NULL
      AND (t.kind <> 'user' OR EXISTS (SELECT 1 FROM team_memberships m WHERE m.user_id = t.user_id AND m.team_id = t.team_id));
  UPDATE ingest_tokens it SET last_used_at = now()
  WHERE it.hash = p_hash AND it.revoked_at IS NULL
    AND (it.kind <> 'user' OR EXISTS (SELECT 1 FROM team_memberships m WHERE m.user_id = it.user_id AND m.team_id = it.team_id))
    AND (it.last_used_at IS NULL OR it.last_used_at < now() - interval '1 minute');
END $$;
--> statement-breakpoint

-- SEC-10: a team token attributes a git e-mail only to a member of the token's team (primary team or a
-- team membership), not to anyone in the company. The one-argument form is dropped.
CREATE OR REPLACE FUNCTION ingest_match_user_by_email(p_email text, p_team uuid)
RETURNS TABLE (user_id uuid, primary_team_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.primary_team_id FROM users u
  WHERE u.company_id = app_ingest_company() AND u.email = lower(trim(p_email))
    AND (u.primary_team_id = p_team
         OR EXISTS (SELECT 1 FROM team_memberships m WHERE m.user_id = u.id AND m.team_id = p_team))
$$;
--> statement-breakpoint
DROP FUNCTION ingest_match_user_by_email(text);
--> statement-breakpoint
REVOKE ALL ON FUNCTION ingest_match_user_by_email(text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ingest_match_user_by_email(text, uuid) TO app_definer, app_ingest;
--> statement-breakpoint

-- SEC-3 residual: a parked patch remembers its sender; it is applied only to a turn that has no owner
-- or the same owner (otherwise it is dropped). Replaces the 0002 body.
CREATE OR REPLACE FUNCTION ingest_apply_pending_patch(p_turn_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_company uuid := app_ingest_company();
  p pending_turn_patches%ROWTYPE;
  v_owner uuid;
  v_applied boolean := false;
BEGIN
  IF v_company IS NULL THEN
    RETURN false;
  END IF;
  DELETE FROM pending_turn_patches pp USING turns t
  WHERE t.id = p_turn_id AND t.company_id = v_company
    AND pp.company_id = v_company AND pp.turn_external_id = t.external_id
  RETURNING pp.* INTO p;
  IF FOUND THEN
    SELECT user_id INTO v_owner FROM turns WHERE id = p_turn_id AND company_id = v_company;
    IF v_owner IS NULL OR v_owner = p.user_id THEN
      v_applied := true;
      UPDATE turns SET
        outcome = CASE WHEN p.outcome IS NULL THEN outcome ELSE p.outcome END,
        outcome_signals = CASE WHEN p.outcome IS NULL THEN outcome_signals ELSE coalesce(p.outcome_signals, '[]'::jsonb) END,
        outcome_provisional = CASE WHEN p.outcome IS NULL THEN outcome_provisional ELSE coalesce(p.outcome_provisional, false) END,
        summary = coalesce(p.summary, summary),
        updated_at = now()
      WHERE id = p_turn_id AND company_id = v_company;
    END IF;
  END IF;
  DELETE FROM pending_turn_patches WHERE company_id = v_company AND received_at < now() - interval '30 days';
  RETURN v_applied;
END $$;
--> statement-breakpoint

-- SEC-11: the company's project salt, readable only for the ingest context's own company.
CREATE OR REPLACE FUNCTION ingest_project_salt() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.project_salt FROM companies c WHERE c.id = app_ingest_company()
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ingest_project_salt() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ingest_project_salt() TO app_definer, app_ingest;
--> statement-breakpoint

-- SEC-7: is an e-mail registered as a user of ANY company (members and super admins included)? The
-- platform role cannot read users (RLS), so its "already in use" check goes through this.
CREATE OR REPLACE FUNCTION platform_email_in_use(p_email text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM users WHERE lower(email) = lower(trim(p_email)))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform_email_in_use(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_email_in_use(text) TO app_definer, app_platform;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint

-- app_ingest records and compares the sender of a parked patch (identity columns stay the only other
-- readable ones).
GRANT SELECT (user_id) ON pending_turn_patches TO app_ingest;
--> statement-breakpoint
GRANT UPDATE (user_id) ON pending_turn_patches TO app_ingest;
--> statement-breakpoint

-- SEC-6: the platform role reads and writes only platform.* audit rows (or rows without a company); it
-- can no longer read a company's tenant audit trail or forge `export` rows.
DROP POLICY platform_all ON audit_log;
--> statement-breakpoint
CREATE POLICY platform_audit ON audit_log TO app_platform
  USING (action LIKE 'platform.%' OR company_id IS NULL)
  WITH CHECK (action LIKE 'platform.%' OR company_id IS NULL);
