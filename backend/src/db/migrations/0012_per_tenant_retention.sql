-- Per-tenant retention.
--
-- arch.md section 1 requires storage cleanup be "fully configurable". The
-- sweeper built for that reads one number from the environment, so every
-- customer on the deployment gets the same window. That is not configurable in
-- the sense the requirement means: retention is a term in a hospital contract,
-- negotiated per customer, and a tenant that has agreed to seven days is not
-- served by a platform that keeps their images for thirty.
--
-- Two columns. One says how long a tenant's images live; the other records
-- that a job's images have been removed, which is a different fact from "the
-- file is missing" and has to be answerable years later.

-- ---------------------------------------------------------------------------
-- 1. The tenant's window
-- ---------------------------------------------------------------------------
--
-- NULL means "use the platform default" rather than "keep forever". A tenant
-- who has never expressed a preference should get the deployment's policy, and
-- should keep getting it when that policy changes - copying the default into
-- every row at migration time would freeze today's number into rows nobody
-- meant to pin.

ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "retention_days" integer;
--> statement-breakpoint

-- Zero would read as "delete immediately" to this column and as "retention
-- disabled" to STORAGE_RETENTION_DAYS, which are opposites. Refused outright
-- rather than given one of the two meanings.
DO $$ BEGIN
  ALTER TABLE "organizations" ADD CONSTRAINT "retention_days_positive"
    CHECK ("retention_days" IS NULL OR ("retention_days" >= 1 AND "retention_days" <= 3650));
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. The record that the images are gone
-- ---------------------------------------------------------------------------
--
-- Without this, an absent file is ambiguous: expired on schedule, never
-- uploaded, or lost. The first is a policy being honoured and the third is an
-- incident, and a clinician asking why a scan will not open deserves a
-- different answer in each case. The job row itself is never deleted - only
-- the image bytes expire, exactly as a bucket lifecycle rule would do.

ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "artifacts_purged_at" timestamp with time zone;
--> statement-breakpoint

-- The sweeper's working set is "old enough, not yet purged", and it runs every
-- few hours forever. Partial, so the index covers only the rows still eligible
-- and shrinks as they are swept rather than growing with the table.
CREATE INDEX IF NOT EXISTS "idx_jobs_unpurged"
  ON "jobs" ("created_at") WHERE "artifacts_purged_at" IS NULL;
--> statement-breakpoint

-- The application role writes the purge timestamp during a sweep. It already
-- holds UPDATE on jobs, so nothing is granted here - noted only because it is
-- the kind of thing that is easy to miss when a column becomes writable by a
-- background task rather than by a request.
