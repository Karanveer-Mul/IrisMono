-- Durable event log behind the SSE stream.
--
-- The hub was a Map in one Node process, which meant two things: a second API
-- instance could not see events published by the first, and a client that
-- dropped mid-job never learned the outcome because there was nothing to
-- replay. Notifications could not participate in the horizontal scaling that
-- justifies the whole asynchronous design.
--
-- Events are now written here first and fanned out to every instance. The
-- monotonic id is what Last-Event-ID resumes from.

CREATE TABLE IF NOT EXISTS "job_events" (
  "id" bigserial PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "job_id" uuid,
  "event_type" varchar(64) NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_events" ADD CONSTRAINT "job_events_organization_id_fk"
   FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Resume scan: "everything for this tenant after id N".
CREATE INDEX IF NOT EXISTS "idx_job_events_org_id" ON "job_events" ("organization_id", "id");
--> statement-breakpoint
-- Pruning scan.
CREATE INDEX IF NOT EXISTS "idx_job_events_created" ON "job_events" ("created_at");
--> statement-breakpoint

-- Same isolation posture as every other tenant table (migration 0002).
ALTER TABLE "job_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "job_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation_job_events ON "job_events";
--> statement-breakpoint
CREATE POLICY tenant_isolation_job_events ON "job_events"
  FOR ALL
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "job_events" TO irismono_app, irismono_auth;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "job_events_id_seq" TO irismono_app, irismono_auth;
