CREATE TABLE "pending_turn_patches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"turn_external_id" text NOT NULL,
	"outcome" "outcome",
	"outcome_signals" jsonb,
	"outcome_provisional" boolean,
	"summary" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_turn_patches_company_turn_uq" UNIQUE("company_id","turn_external_id"),
	CONSTRAINT "pending_turn_patches_summary_len" CHECK (char_length("pending_turn_patches"."summary") <= 140)
);
--> statement-breakpoint
ALTER TABLE "pending_turn_patches" ADD CONSTRAINT "pending_turn_patches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_turn_patches_received_idx" ON "pending_turn_patches" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "runs_created_idx" ON "runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "turns_updated_idx" ON "turns" USING btree ("updated_at");--> statement-breakpoint

-- =============================== hand-written part (ADR-0015) ===============================
-- Patches (turn_outcome / turn_summary) that arrive before their turn are parked in
-- pending_turn_patches instead of creating a placeholder turn, so no turn row ever exists without its
-- session and tokens. The two indexes above serve the worker's rollup watermark (updated turns,
-- created runs since the last pass).
ALTER TABLE pending_turn_patches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pending_turn_patches FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON pending_turn_patches TO app_definer;
--> statement-breakpoint
CREATE POLICY definer_all ON pending_turn_patches TO app_definer USING (true) WITH CHECK (true);
--> statement-breakpoint
-- app_ingest: park and re-park patches of its own company; identity columns readable only (ON CONFLICT
-- target). It never deletes: ingest_apply_pending_patch() does that.
GRANT INSERT ON pending_turn_patches TO app_ingest;
--> statement-breakpoint
GRANT SELECT (id, company_id, turn_external_id) ON pending_turn_patches TO app_ingest;
--> statement-breakpoint
GRANT UPDATE (outcome, outcome_signals, outcome_provisional, summary, received_at) ON pending_turn_patches TO app_ingest;
--> statement-breakpoint
CREATE POLICY ingest_company ON pending_turn_patches FOR ALL TO app_ingest
  USING (company_id = (SELECT app_ingest_company()))
  WITH CHECK (company_id = (SELECT app_ingest_company()));
--> statement-breakpoint
-- app_worker: may prune orphaned patches (retention). app_web / app_platform: no access.
GRANT SELECT, DELETE ON pending_turn_patches TO app_worker;
--> statement-breakpoint
CREATE POLICY worker_all ON pending_turn_patches TO app_worker USING (true) WITH CHECK (true);
--> statement-breakpoint
-- Called by ingest right after a turn is upserted: moves the turn's parked patch (if any) onto the
-- turn and deletes it, then drops this company's patches whose turn never came (30 days, like
-- ingest_events). SECURITY DEFINER because app_ingest can neither read patch values nor delete.
CREATE OR REPLACE FUNCTION ingest_apply_pending_patch(p_turn_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_company uuid := app_ingest_company();
  p pending_turn_patches%ROWTYPE;
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
    v_applied := true;
    UPDATE turns SET
      outcome = CASE WHEN p.outcome IS NULL THEN outcome ELSE p.outcome END,
      outcome_signals = CASE WHEN p.outcome IS NULL THEN outcome_signals ELSE coalesce(p.outcome_signals, '[]'::jsonb) END,
      outcome_provisional = CASE WHEN p.outcome IS NULL THEN outcome_provisional ELSE coalesce(p.outcome_provisional, false) END,
      summary = coalesce(p.summary, summary),
      updated_at = now()
    WHERE id = p_turn_id AND company_id = v_company;
  END IF;
  DELETE FROM pending_turn_patches WHERE company_id = v_company AND received_at < now() - interval '30 days';
  RETURN v_applied;
END $$;
--> statement-breakpoint
ALTER FUNCTION ingest_apply_pending_patch(uuid) OWNER TO app_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ingest_apply_pending_patch(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ingest_apply_pending_patch(uuid) TO app_definer, app_ingest;
--> statement-breakpoint

-- Data fix: placeholder turns written before this migration (session_id null) become parked patches.
-- Runs linked to a placeholder are unlinked (ingest re-links them by turn_external_id when the turn
-- arrives). Rollup slices that counted a placeholder are recomputed by the worker (their remaining
-- turns are marked updated) or, when nothing else remains that day, deleted. Runs as app_definer so
-- FORCE RLS lets the fix see every company when the migrating role is not a superuser.
SET ROLE app_definer;
--> statement-breakpoint
INSERT INTO pending_turn_patches (company_id, turn_external_id, outcome, outcome_signals, outcome_provisional, summary, received_at)
SELECT t.company_id, t.external_id,
  CASE WHEN m.id IS NULL THEN NULL ELSE t.outcome END,
  CASE WHEN m.id IS NULL THEN NULL ELSE t.outcome_signals END,
  CASE WHEN m.id IS NULL THEN NULL ELSE t.outcome_provisional END,
  t.summary, t.created_at
FROM turns t
LEFT JOIN ingest_events m ON m.company_id = t.company_id AND m.event_id = 'outcome-patch:' || t.external_id
WHERE t.session_id IS NULL
ON CONFLICT (company_id, turn_external_id) DO NOTHING;
--> statement-breakpoint
UPDATE runs r SET turn_id = NULL
FROM turns t
WHERE t.id = r.turn_id AND t.company_id = r.company_id AND t.session_id IS NULL;
--> statement-breakpoint
WITH ph AS (
  DELETE FROM turns WHERE session_id IS NULL
  RETURNING company_id, (started_at AT TIME ZONE 'UTC')::date AS day
), days AS (
  SELECT DISTINCT company_id, day FROM ph
), touched AS (
  UPDATE turns t SET updated_at = now()
  FROM days d
  WHERE t.company_id = d.company_id AND t.session_id IS NOT NULL
    AND t.started_at >= d.day::timestamp AT TIME ZONE 'UTC'
    AND t.started_at < (d.day + 1)::timestamp AT TIME ZONE 'UTC'
  RETURNING t.company_id, d.day
)
DELETE FROM daily_rollups r USING days d
WHERE r.company_id = d.company_id AND r.day = d.day
  AND NOT EXISTS (SELECT 1 FROM touched x WHERE x.company_id = d.company_id AND x.day = d.day);
--> statement-breakpoint
RESET ROLE;
