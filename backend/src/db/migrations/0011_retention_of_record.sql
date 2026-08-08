-- Retention of record: a workspace can be closed, but its history cannot be
-- erased by closing it.
--
-- The audit raised this under §2.7: every tenant-owned table hung off
-- organizations with ON DELETE CASCADE, so a single DELETE on one row silently
-- destroyed that tenant's jobs, its credit ledger, and the provenance of every
-- mask ever produced for it. arch.md promises job metadata is "maintained
-- indefinitely for auditing/billing"; a cascade is a standing contradiction of
-- that promise, and one that fires without warning - the person running the
-- DELETE sees "DELETE 1".
--
-- Two changes, and they only work together:
--
--   1. The retained relationships become RESTRICT, so the database refuses the
--      delete instead of widening it. RESTRICT is not an inconvenience to route
--      around: being unable to delete the row IS the requirement.
--   2. Organizations and users get deleted_at, so "we are done with this
--      customer" has an answer that is not DELETE.
--
-- Note which relationships are deliberately left as CASCADE below. Not
-- everything is a record: memberships are current state, and job_events are a
-- replay buffer already pruned at seven days.

-- ---------------------------------------------------------------------------
-- 1. Soft-delete columns
-- ---------------------------------------------------------------------------
--
-- Nullable with no default: NULL means active, which keeps every existing row
-- and every existing query correct without a backfill.

ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
--> statement-breakpoint

-- Closure is rare and closed rows stay forever, so the index that matters is
-- the one over the active set. Partial, so it does not carry the dead weight.
CREATE INDEX IF NOT EXISTS "idx_organizations_active"
  ON "organizations" ("id") WHERE "deleted_at" IS NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. The relationships that carry the record
-- ---------------------------------------------------------------------------
--
-- jobs is the clinical and billing record; credit_transactions is the ledger
-- the balance is derived from; organization_invites is the forensic answer to
-- "which link admitted this account", which memberships.invite_id points at.
--
-- Dropping and re-adding is the only way to change ON DELETE - Postgres has no
-- ALTER CONSTRAINT for the action - so each one is dropped IF EXISTS and added
-- back under the same name.

ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "jobs_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint

-- A departing employee's scans are not theirs to take with them: the images
-- were the hospital's record before the account existed and remain so after.
ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "jobs_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT;
--> statement-breakpoint

ALTER TABLE "credit_transactions" DROP CONSTRAINT IF EXISTS "credit_transactions_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint

-- Deleting a job used to delete its reservation and its refund, which is how a
-- ledger stops reconciling against the balance it is supposed to explain.
ALTER TABLE "credit_transactions" DROP CONSTRAINT IF EXISTS "credit_transactions_job_id_fk";
--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_job_id_fk"
  FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE RESTRICT;
--> statement-breakpoint

ALTER TABLE "organization_invites" DROP CONSTRAINT IF EXISTS "organization_invites_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Stop the invite attribution erasing itself
-- ---------------------------------------------------------------------------
--
-- 0010 pointed memberships.invite_id at organization_invites with ON DELETE
-- SET NULL, which is the worst of the three options here. A dangling id is at
-- least visibly broken; a NULL is indistinguishable from "this person joined
-- without an invite", so deleting the link quietly rewrites the answer to
-- "which link admitted this account" rather than failing to answer it.
--
-- RESTRICT instead: the invite that admitted somebody cannot be removed while
-- they are still a member. Revoking a leaked link is is_active = false, which
-- is what that flag is for and which keeps the history.

ALTER TABLE "memberships" DROP CONSTRAINT IF EXISTS "memberships_invite_id_fk";
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_invite_id_fk"
  FOREIGN KEY ("invite_id") REFERENCES "public"."organization_invites"("id") ON DELETE RESTRICT;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. What stays CASCADE, and why
-- ---------------------------------------------------------------------------
--
--   memberships.user_id / organization_id   Current state, not history. Who was
--       a member when is already in audit_events (membership.added / .removed),
--       which no cascade can reach because it holds no foreign keys at all.
--
--   job_events.organization_id              A replay buffer for SSE resume,
--       pruned at EVENT_LOG_RETENTION_DAYS regardless.
--
--   organization_invites.created_by         SET NULL. The invite survives its
--       creator's deletion; who created it is preserved by actor_email on the
--       invite.created audit row, which is denormalised for exactly this.
--
-- None of these cascades can fire while an organization has a single job or
-- ledger entry, because the RESTRICT above rejects the parent delete first.
-- That is the intended outcome: every organization is created with a
-- TRIAL_GRANT ledger row, so from the moment it exists it cannot be deleted.
