-- Support for the abandoned-job reaper and for tier-based queue routing.

-- When a worker claimed the job. PENDING is aged from created_at, but
-- PROCESSING needs its own clock or a slow job would be reaped by the age of
-- its reservation rather than the age of its execution.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone;
--> statement-breakpoint

-- Infrastructure tier, replacing the name-substring check in routes/jobs.ts
-- ("does the organization name contain 'vip'").
DO $$ BEGIN
 CREATE TYPE "public"."infrastructure_tier" AS ENUM('STANDARD', 'VIP');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "infrastructure_tier" "infrastructure_tier" NOT NULL DEFAULT 'STANDARD';
--> statement-breakpoint

-- The reaper scans by status and age.
CREATE INDEX IF NOT EXISTS "idx_jobs_status_created" ON "jobs" ("status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jobs_status_started" ON "jobs" ("status", "started_at");
