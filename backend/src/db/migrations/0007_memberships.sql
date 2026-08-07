-- Memberships: one person, many organizations.
--
-- users.organization_id was a single nullable FK and role lived on the user
-- row, so a person could belong to exactly one organization and their role was
-- global. Consulting radiologists and multi-site hospital networks are the
-- normal case in this market, not the edge case, and a user who joined the
-- wrong workspace had no path out except deleting the account.
--
-- The relationship now carries the role, which is where it belongs: the same
-- person can be ORG_ADMIN at one hospital and MEMBER at another.

CREATE TABLE IF NOT EXISTS "memberships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "role" "user_role" DEFAULT 'MEMBER' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fk"
   FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_fk"
   FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- One membership per person per organization; the role is an attribute of it.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_membership_user_org"
  ON "memberships" ("user_id", "organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memberships_org" ON "memberships" ("organization_id");
--> statement-breakpoint

-- Carry every existing user across before the old columns go.
INSERT INTO "memberships" ("user_id", "organization_id", "role")
SELECT id, organization_id, role
  FROM "users"
 WHERE organization_id IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- users no longer carries a tenant of its own, so its isolation policy has to
-- ask the membership table instead. A user row is visible to whichever
-- organizations that person actually belongs to.
DROP POLICY IF EXISTS tenant_isolation_users ON "users";
--> statement-breakpoint
CREATE POLICY tenant_isolation_users ON "users"
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM "memberships" m
     WHERE m.user_id = users.id
       AND m.organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  ));
--> statement-breakpoint

ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation_memberships ON "memberships";
--> statement-breakpoint
CREATE POLICY tenant_isolation_memberships ON "memberships"
  FOR ALL
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "memberships" TO irismono_app, irismono_auth;
--> statement-breakpoint

-- The old single-tenant columns. Dropping them is the point: leaving them in
-- place would let code keep reading a "the" organization for a user, which is
-- exactly the assumption being removed.
DROP INDEX IF EXISTS "idx_users_org";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "organization_id";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "role";
