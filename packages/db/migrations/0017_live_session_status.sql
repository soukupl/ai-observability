ALTER TABLE "agent_sessions" ADD COLUMN "current_turn_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "agent_sessions_company_last_seen_idx" ON "agent_sessions" USING btree ("company_id","last_seen_at") WHERE "agent_sessions"."ended_at" is null;--> statement-breakpoint

-- =============================== hand-written part (ADR-0027) ===============================
-- Live session status. Ingest keeps current_turn_started_at / last_seen_at with greatest() and case expressions over the
-- stored values and re-opens a resumed session by comparing ended_at; Postgres needs SELECT on every column such an
-- ON CONFLICT DO UPDATE reads. Liveness timestamps only: every other telemetry column stays unreadable for app_ingest.
-- app_web and app_worker read them through their table-wide SELECT (0001).
GRANT SELECT (current_turn_started_at, last_seen_at, ended_at) ON agent_sessions TO app_ingest;
--> statement-breakpoint
GRANT UPDATE (current_turn_started_at, last_seen_at) ON agent_sessions TO app_ingest;
