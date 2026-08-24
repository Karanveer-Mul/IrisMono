-- Job concurrency (arch.md section 1, the other half of it).
--
-- "The frontend must restrict users via configuration to uploading exactly 1
-- image at a time" was implemented as a client-side check for files.length,
-- which stops one browser tab from selecting a folder of images in a single
-- drop. It does nothing about two tabs, two members, or a retried request:
-- nothing on the server ever counted how many jobs a tenant already had in
-- flight, so the actual limit was "however many credits are left".
--
-- Same shape as per-tenant retention (0012): a platform default from the
-- environment, overridable per organization because "exactly 1" is a starting
-- configuration, not a law - a hospital that provisioned a larger GPU pool for
-- itself is contractually entitled to run more than one job at a time.

ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "max_concurrent_jobs" integer;
--> statement-breakpoint

-- Zero would mean "accept no jobs" on this column and "no limit" on the
-- environment default - the same ambiguity retention_days=0 has, refused for
-- the same reason.
DO $$ BEGIN
  ALTER TABLE "organizations" ADD CONSTRAINT "max_concurrent_jobs_positive"
    CHECK ("max_concurrent_jobs" IS NULL OR "max_concurrent_jobs" >= 1);
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- The enforcement query counts a tenant's own PENDING/PROCESSING jobs under
-- the organization row lock already taken for credit reservation - see
-- src/routes/jobs.ts. This index is what keeps that count cheap as the jobs
-- table grows; without it every reservation would scan the tenant's entire
-- history to find the handful of rows still in flight.
CREATE INDEX IF NOT EXISTS "idx_jobs_org_active"
  ON "jobs" ("organization_id")
  WHERE "status" IN ('PENDING', 'PROCESSING');
