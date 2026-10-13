CREATE TABLE "pending_session_patches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_external_id" text NOT NULL,
	"title" text NOT NULL,
	"title_source" text NOT NULL,
	"user_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_session_patches_company_session_uq" UNIQUE("company_id","session_external_id"),
	CONSTRAINT "pending_session_patches_title_len" CHECK (char_length("pending_session_patches"."title") <= 140),
	CONSTRAINT "pending_session_patches_title_source" CHECK ("pending_session_patches"."title_source" in ('custom', 'ai'))
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "title_source" text;--> statement-breakpoint
ALTER TABLE "pending_session_patches" ADD CONSTRAINT "pending_session_patches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_session_patches" ADD CONSTRAINT "pending_session_patches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_session_patches_received_idx" ON "pending_session_patches" USING btree ("received_at");--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_title_len" CHECK (char_length("agent_sessions"."title") <= 140);--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_title_source" CHECK ("agent_sessions"."title_source" in ('custom', 'ai'));--> statement-breakpoint

-- =============================== hand-written part (ADR-0026) ===============================
-- Session titles: agent_sessions.title / title_source are written only by session_title patches. app_ingest may set
-- them but not read them (like turn summaries); app_web reads them through its table-wide SELECT under RLS.
GRANT UPDATE (title, title_source) ON agent_sessions TO app_ingest;
--> statement-breakpoint
-- A session_title that arrives before its session is parked here (same design as pending_turn_patches, ADR-0015).
ALTER TABLE pending_session_patches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pending_session_patches FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON pending_session_patches TO app_definer;
--> statement-breakpoint
CREATE POLICY definer_all ON pending_session_patches TO app_definer USING (true) WITH CHECK (true);
--> statement-breakpoint
-- app_ingest: park and re-park patches of its own company; identity columns and the sender readable only (ON
-- CONFLICT target, owner check). It never deletes: ingest_apply_pending_session_patch() does that.
GRANT INSERT ON pending_session_patches TO app_ingest;
--> statement-breakpoint
GRANT SELECT (id, company_id, session_external_id, user_id) ON pending_session_patches TO app_ingest;
--> statement-breakpoint
GRANT UPDATE (title, title_source, user_id, received_at) ON pending_session_patches TO app_ingest;
--> statement-breakpoint
CREATE POLICY ingest_company ON pending_session_patches FOR ALL TO app_ingest
  USING (company_id = (SELECT app_ingest_company()))
  WITH CHECK (company_id = (SELECT app_ingest_company()));
--> statement-breakpoint
-- app_worker: prunes orphaned patches (retention). app_web / app_platform: no access.
GRANT SELECT, DELETE ON pending_session_patches TO app_worker;
--> statement-breakpoint
CREATE POLICY worker_all ON pending_session_patches TO app_worker USING (true) WITH CHECK (true);
--> statement-breakpoint
SET ROLE app_definer;
--> statement-breakpoint
-- Called by ingest right after a session row is upserted: moves the session's parked title (if any) onto it and
-- deletes it, applied only to an ownerless session or one of the same owner (SEC-3; otherwise it is dropped). Patches
-- whose session never comes are pruned after 30 days by the worker's retention job, not on this hot path. SECURITY DEFINER because app_ingest can neither read patch values nor delete.
CREATE FUNCTION ingest_apply_pending_session_patch(p_session_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_company uuid := app_ingest_company();
  p pending_session_patches%ROWTYPE;
  v_owner uuid;
  v_applied boolean := false;
BEGIN
  IF v_company IS NULL THEN
    RETURN false;
  END IF;
  DELETE FROM pending_session_patches pp USING agent_sessions s
  WHERE s.id = p_session_id AND s.company_id = v_company
    AND pp.company_id = v_company AND pp.session_external_id = s.external_id
  RETURNING pp.* INTO p;
  IF FOUND THEN
    SELECT user_id INTO v_owner FROM agent_sessions WHERE id = p_session_id AND company_id = v_company;
    IF v_owner IS NULL OR v_owner = p.user_id THEN
      v_applied := true;
      UPDATE agent_sessions SET title = p.title, title_source = p.title_source
      WHERE id = p_session_id AND company_id = v_company;
    END IF;
  END IF;
  RETURN v_applied;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ingest_apply_pending_session_patch(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ingest_apply_pending_session_patch(uuid) TO app_definer, app_ingest;
--> statement-breakpoint
RESET ROLE;
