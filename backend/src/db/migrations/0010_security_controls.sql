-- Security controls that "hospital-grade" actually implies.
--
-- The audit called this out: the phrase reduced to a domain whitelist, which
-- stops nothing on its own. Any holder of a matching address could self-serve
-- through a reusable link, forever, with no record of who joined through which
-- link and no way to prove afterwards what had happened.
--
-- Four things here: an append-only audit log that resists tampering, invite
-- links that can be exhausted, per-organization data keys for encryption at
-- rest, and somewhere to record failed sign-ins.

-- ---------------------------------------------------------------------------
-- 1. Immutable audit log
-- ---------------------------------------------------------------------------
--
-- "Immutable" is not a table comment. Three mechanisms, because each covers a
-- different attacker:
--
--   * REVOKE UPDATE/DELETE      stops the application roles, including anything
--                               that reaches them through a SQL injection.
--   * A blocking trigger        stops the table owner and any superuser session,
--                               which RLS and grants do not constrain at all.
--   * A hash chain              stops someone with direct disk or backup access,
--                               who can rewrite bytes but cannot recompute every
--                               subsequent hash without being noticed.
--
-- The first two prevent; the third detects. A regulator asks for the third.

CREATE TABLE IF NOT EXISTS "audit_events" (
  "id" bigserial PRIMARY KEY,
  -- Null for events with no tenant yet: a failed login against an unknown
  -- address, for instance. Those still have to be recorded.
  "organization_id" uuid,
  "actor_user_id" uuid,
  -- Denormalised on purpose. The audit record must survive the account being
  -- deleted, which is exactly when it matters most.
  "actor_email" varchar(255),
  "action" varchar(64) NOT NULL,
  "target" varchar(255),
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "ip" varchar(64),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  -- Chain linkage. previous_hash is null only for the first row ever written.
  "previous_hash" varchar(64),
  "hash" varchar(64) NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_audit_events_org" ON "audit_events" ("organization_id", "id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_events_action" ON "audit_events" ("action", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_events_actor" ON "audit_events" ("actor_user_id", "created_at" DESC);
--> statement-breakpoint

-- Blocks rewriting history from any session, including the owner's. A trigger
-- is the only one of the three mechanisms a superuser cannot simply ignore.
CREATE OR REPLACE FUNCTION audit_events_are_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_events_no_update ON "audit_events";
--> statement-breakpoint
CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_are_append_only();
--> statement-breakpoint

ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation_audit_events ON "audit_events";
--> statement-breakpoint
-- A tenant reads its own trail and nothing else. Rows with no organization are
-- system-level and are not visible to any tenant.
CREATE POLICY tenant_isolation_audit_events ON "audit_events"
  FOR ALL
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint

GRANT SELECT ON "audit_events" TO irismono_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "audit_events" TO irismono_auth;
--> statement-breakpoint
-- Explicit, because ALTER DEFAULT PRIVILEGES in migration 0002 granted the full
-- set on new tables. Writing the audit log is not the same right as editing it.
REVOKE UPDATE, DELETE ON "audit_events" FROM irismono_app, irismono_auth;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "audit_events_id_seq" TO irismono_auth;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Invite links that can be exhausted
-- ---------------------------------------------------------------------------
--
-- A reusable link with no cap is a standing offer: anyone who ever sees it,
-- including in a forwarded email or a screenshot, can join for as long as it
-- exists. A cap turns it back into an invitation.

ALTER TABLE "organization_invites" ADD COLUMN IF NOT EXISTS "max_uses" integer;
--> statement-breakpoint
ALTER TABLE "organization_invites" ADD COLUMN IF NOT EXISTS "uses_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "organization_invites" DROP CONSTRAINT IF EXISTS "invite_uses_within_cap";
--> statement-breakpoint
-- The cap is enforced by the database, not only by the check in the handler, so
-- a redemption path added later cannot quietly exceed it.
ALTER TABLE "organization_invites"
  ADD CONSTRAINT "invite_uses_within_cap" CHECK ("max_uses" IS NULL OR "uses_count" <= "max_uses");
--> statement-breakpoint

-- Which link admitted this person. The audit found no record of this at all,
-- so revoking a leaked invite could not answer "who did it let in?".
ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "invite_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memberships" ADD CONSTRAINT "memberships_invite_id_fk"
   FOREIGN KEY ("invite_id") REFERENCES "public"."organization_invites"("id") ON DELETE set null;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memberships_invite" ON "memberships" ("invite_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Per-organization data keys
-- ---------------------------------------------------------------------------
--
-- Envelope encryption. Each tenant gets its own AES-256 data key, stored here
-- only in wrapped form; the key that wraps it never touches this database.
--
-- The point of per-tenant keys is containment and revocation: destroying one
-- tenant's key renders that tenant's scans unreadable without touching anyone
-- else's, which is what a deletion request under a hospital contract requires.
--
-- In deployment the wrapping is AWS KMS GenerateDataKey/Decrypt and this column
-- holds the KMS ciphertext blob. Locally the master key is an environment
-- variable - see src/crypto.ts, which is explicit that this is not equivalent.
CREATE TABLE IF NOT EXISTS "organization_keys" (
  "organization_id" uuid PRIMARY KEY REFERENCES "organizations"("id") ON DELETE cascade,
  "wrapped_key" text NOT NULL,
  "key_version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- No policy: a tenant-scoped session has no business reading key material at
-- all, wrapped or not. Only the system identity touches this table.
ALTER TABLE "organization_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "organization_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT ON "organization_keys" TO irismono_auth;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Sign-in throttling
-- ---------------------------------------------------------------------------
--
-- There was no rate limit, no lockout, and no record of failures - so an
-- unlimited online password guessing attack against a named clinician left no
-- trace. Held on the user row rather than in process memory because the API
-- runs behind a load balancer: per-instance counters divide the attacker's
-- effort by the number of instances.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "failed_login_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_login_at" timestamp with time zone;
