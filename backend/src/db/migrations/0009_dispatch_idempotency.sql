-- Single-shot dispatch.
--
-- POST /jobs/:id/trigger read the job, checked that it was PENDING, and then
-- published - three steps with no lock between them. Two clicks, a retried
-- fetch, or a double-submitted form put two copies of the same job on the
-- queue. The second copy was harmless in the end, because claiming is guarded
-- by status, but only after a worker had picked it up, asked the API for it,
-- and been refused: real GPU scheduling spent on a message that could not
-- have succeeded.
--
-- dispatched_at makes the transition itself the guard. The publish happens only
-- for the caller whose UPDATE ... WHERE dispatched_at IS NULL returned a row.
-- Nullable rather than a boolean because when it was dispatched is worth
-- keeping: it is the other end of the queue-wait measurement.

ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "dispatched_at" timestamp with time zone;
--> statement-breakpoint

-- Existing jobs that already left PENDING were dispatched by definition; dating
-- them from created_at is approximate but is the only honest value available,
-- and leaving them NULL would let a replay re-dispatch historical work.
UPDATE "jobs" SET "dispatched_at" = "created_at" WHERE "status" <> 'PENDING' AND "dispatched_at" IS NULL;
--> statement-breakpoint

-- Backs the keyset pagination on GET /api/jobs/logs.
--
-- idx_jobs_org alone would find the tenant's rows and then sort all of them to
-- return fifty. This index is already in the requested order, so a page is a
-- range scan whose cost does not grow with the tenant's history - which is the
-- entire reason for paginating a table the specification keeps forever.
CREATE INDEX IF NOT EXISTS "idx_jobs_org_created" ON "jobs" ("organization_id", "created_at" DESC, "id" DESC);
