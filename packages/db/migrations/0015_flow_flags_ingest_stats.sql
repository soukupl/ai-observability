CREATE TABLE "flow_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"flow_key" text NOT NULL,
	"flow_name" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_flags_user_flow_uq" UNIQUE("company_id","user_id","turn_id","flow_key"),
	CONSTRAINT "flow_flags_key_format" CHECK ("flow_flags"."flow_key" ~ '^[A-Za-z0-9_.:-]{1,128}$'),
	CONSTRAINT "flow_flags_name_len" CHECK (char_length("flow_flags"."flow_name") between 1 and 200),
	CONSTRAINT "flow_flags_note_len" CHECK ("flow_flags"."note" is null or char_length("flow_flags"."note") <= 500)
);
--> statement-breakpoint
ALTER TABLE "flow_flags" ADD CONSTRAINT "flow_flags_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_flags" ADD CONSTRAINT "flow_flags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_flags" ADD CONSTRAINT "flow_flags_company_id_turn_id_turns_company_id_id_fk" FOREIGN KEY ("company_id","turn_id") REFERENCES "public"."turns"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flow_flags_company_user_created_idx" ON "flow_flags" USING btree ("company_id","user_id","created_at");--> statement-breakpoint

-- =============================== hand-written part ===============================
-- Flow flags (docs/briefs/dashboard-followups-2026-10-10.md, ADR-0024): a user's private "for later" bookmarks of
-- agent flows. app_web reads, inserts and deletes its own rows only (company + user of the RLS context); nobody else
-- in the company sees them. The worker needs no grant: retention deletes turns and the FK cascades (as run_links).
ALTER TABLE flow_flags ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE flow_flags FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON flow_flags TO app_definer;
--> statement-breakpoint
CREATE POLICY definer_all ON flow_flags TO app_definer USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (note), DELETE ON flow_flags TO app_web;
--> statement-breakpoint
CREATE POLICY web_own ON flow_flags TO app_web
  USING (company_id = (SELECT app_company()) AND user_id = (SELECT app_user()))
  WITH CHECK (company_id = (SELECT app_company()) AND user_id = (SELECT app_user()));
--> statement-breakpoint
-- Ingest statistics of the Overview (brief item 5): per event type, how many events the company's collectors delivered
-- in the last 24 h / 7 days and when the last one arrived. The ledger (ingest_events) is pruned after 30 days.
CREATE INDEX ingest_events_company_received_idx ON ingest_events USING btree (company_id, received_at);
--> statement-breakpoint
SET ROLE app_definer;
--> statement-breakpoint
-- Company-wide (no attribution, no user_id), so every member may read it in either visibility mode.
CREATE FUNCTION agg_ingest_stats()
RETURNS TABLE (type text, events_24h bigint, events_7d bigint, last_received_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.type,
    count(*) FILTER (WHERE e.received_at >= now() - interval '24 hours'),
    count(*) FILTER (WHERE e.received_at >= now() - interval '7 days'),
    max(e.received_at)
  FROM ingest_events e
  WHERE e.company_id = app_company()
  GROUP BY e.type
  ORDER BY e.type
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION agg_ingest_stats() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION agg_ingest_stats() TO app_definer, app_web;
--> statement-breakpoint
RESET ROLE;
