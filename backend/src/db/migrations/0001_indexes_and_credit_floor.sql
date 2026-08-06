-- Indexes specified in architecture_specification.md section 1 but never
-- included in the initial migration.
CREATE INDEX IF NOT EXISTS "idx_users_org" ON "users" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_invites_code" ON "organization_invites" ("invite_code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jobs_org" ON "jobs" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jobs_user" ON "jobs" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jobs_status" ON "jobs" ("status");
--> statement-breakpoint
-- Database-level floor on the credit balance. Until now the only guard against
-- an overdraft was an application-level check, so any future code path that
-- decremented without checking could drive the balance negative.
DO $$ BEGIN
 ALTER TABLE "organizations"
   ADD CONSTRAINT "positive_credit_balance" CHECK ("credit_balance" >= 0);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
