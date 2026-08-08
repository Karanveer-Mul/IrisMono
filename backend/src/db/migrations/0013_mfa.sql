-- Multi-factor authentication (TOTP).
--
-- §2.6 of the audit listed MFA as absent, and §7 called it the largest
-- remaining gap - with the caveat that a code generator without enrolment and
-- recovery is a checkbox rather than a control. The columns here are shaped by
-- that caveat: a secret that is not trusted until proven, a record of the last
-- step used so a code cannot be replayed, and single-use recovery codes.

-- ---------------------------------------------------------------------------
-- 1. The user's second factor
-- ---------------------------------------------------------------------------
--
-- mfa_secret is stored wrapped by the master key (src/crypto.ts), not in the
-- clear. A database dump is the realistic exposure for this: dumps travel, get
-- restored into staging, and live in backups far longer than anyone intends.
-- Under the master key rather than a tenant key because the second factor
-- belongs to the person, and one person can act in several organizations.
--
-- mfa_enabled_at is what makes enrolment two-step. A secret is written at setup
-- and this stays NULL until the user produces a code from it, so an enrolment
-- abandoned halfway - the usual outcome of a scan that did not work - cannot
-- lock the account out of itself.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_secret" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_enabled_at" timestamp with time zone;
--> statement-breakpoint

-- The last TOTP step accepted for this user.
--
-- A code is valid for a whole 30-second step, so accepting one without
-- recording it leaves it replayable for the rest of that window by anyone who
-- saw it - over a shoulder, in a screen share, in a proxy log. bigint because
-- it is a unix-epoch counter, not a small number.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_last_step" bigint;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Recovery codes
-- ---------------------------------------------------------------------------
--
-- Losing the phone is the common case, not the edge case, and an MFA rollout
-- without a recovery path produces either locked-out clinicians or a support
-- desk that disables MFA on request - which is the same as not having it.
--
-- Rows are kept after use rather than deleted: "this account was recovered with
-- a code on the 4th" is exactly the sort of thing an investigation needs, and a
-- deleted row cannot say it. used_at carries that.
CREATE TABLE IF NOT EXISTS "user_recovery_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  -- SHA-256 of the normalised code. These are 80 random bits chosen by the
  -- system, so there is no low-entropy guessing for bcrypt's cost to slow -
  -- and ten bcrypt comparisons per sign-in attempt would be a CPU amplifier
  -- pointed at the login endpoint. See src/mfa.ts.
  "code_hash" char(64) NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Unique across users, not just within one: a collision would mean one person's
-- recovery code opening another's account. The odds are negligible; the cost of
-- the index is also negligible, and the failure is not one to accept on odds.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_recovery_code_hash" ON "user_recovery_codes" ("code_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_recovery_codes_user" ON "user_recovery_codes" ("user_id");
--> statement-breakpoint

-- No policy, like organization_keys: a tenant-scoped session has no business
-- reading credential material, and these rows have no tenant anyway - they
-- belong to a person who may act in several organizations.
ALTER TABLE "user_recovery_codes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "user_recovery_codes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "user_recovery_codes" TO irismono_auth;
--> statement-breakpoint

-- DELETE is granted because disabling MFA discards the unused codes. Marking
-- them used would be wrong: they were never used, and the audit trail already
-- records the disable.
