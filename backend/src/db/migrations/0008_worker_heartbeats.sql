-- Worker fleet visibility.
--
-- The GPU tier holds no database credentials and is not an HTTP service anyone
-- else calls, so from the API's side a worker that has silently stopped
-- consuming is indistinguishable from an idle one. Queue depth eventually shows
-- it, but only once work has already piled up.
--
-- Each worker posts a heartbeat to the API, which records it here. The table is
-- the fleet's shared view: any API instance can answer "what is running, on
-- which model build, and when did we last hear from it" without being the
-- instance that happened to receive the heartbeat.
--
-- Not tenant data. It is deliberately left with RLS enabled and no policy, so
-- the tenant-scoped role irismono_app reads zero rows from it; the system role
-- (BYPASSRLS) is the only application identity that sees it.

CREATE TABLE IF NOT EXISTS "worker_heartbeats" (
  -- hostname:pid by default, or whatever WORKER_ID is set to at deploy time.
  "worker_id" varchar(100) PRIMARY KEY,
  "model_version" varchar(100),
  -- Comma-separated queue names this worker consumes.
  "queues" varchar(255) NOT NULL,
  "status" varchar(16) NOT NULL,
  "current_job_id" uuid,
  "jobs_processed" integer NOT NULL DEFAULT 0,
  "jobs_failed" integer NOT NULL DEFAULT 0,
  "started_at" timestamp with time zone NOT NULL,
  "last_seen_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- "Which workers are stale?" and the pruning sweep both scan on this.
CREATE INDEX IF NOT EXISTS "idx_worker_heartbeats_last_seen" ON "worker_heartbeats" ("last_seen_at");
--> statement-breakpoint

ALTER TABLE "worker_heartbeats" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "worker_heartbeats" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- No policy is created on purpose: with RLS enabled and no policy, every row is
-- invisible to a role that does not bypass RLS. The grant below exists so the
-- system identity can write it.
GRANT SELECT, INSERT, UPDATE, DELETE ON "worker_heartbeats" TO irismono_auth;
