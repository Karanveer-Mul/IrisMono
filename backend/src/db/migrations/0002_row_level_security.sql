-- Row-Level Security, per architecture_specification.md section 1.
--
-- Three things have to be true for RLS to actually isolate tenants here:
--
--   1. The application must not connect as a superuser. Superusers bypass RLS
--      unconditionally - FORCE ROW LEVEL SECURITY closes the table-owner hole,
--      not the superuser one. Hence the dedicated login roles below.
--   2. The org context must be set with set_config(..., is_local => true)
--      inside a transaction. A session-level SET on a pooled connection leaks
--      to whichever request borrows that connection next.
--   3. Login and invite redemption happen before any org context exists, so
--      they need a role that bypasses RLS. That is irismono_auth, which the
--      API uses only for pre-tenant and system operations.
--
-- NOTE: the passwords below are local development defaults. Provision these
-- roles out of band with real credentials in any deployed environment.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'irismono_app') THEN
    CREATE ROLE irismono_app LOGIN PASSWORD 'irismono_app_password';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'irismono_auth') THEN
    CREATE ROLE irismono_auth LOGIN PASSWORD 'irismono_auth_password' BYPASSRLS;
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO irismono_app, irismono_auth;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO irismono_app, irismono_auth;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO irismono_app, irismono_auth;
--> statement-breakpoint

-- Enable and FORCE on every tenant-scoped table. FORCE makes the policies
-- apply to the table owner too, so ownership alone is not an escape hatch.
--
-- organizations is included even though the specification omitted it: it holds
-- the credit balance and name, and a query that forgot its predicate would
-- otherwise read another tenant's billing state.
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "jobs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "organization_invites" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "organization_invites" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Policies. FOR ALL with no explicit WITH CHECK reuses the USING expression,
-- so inserts and updates cannot write a row into another tenant either.
DROP POLICY IF EXISTS tenant_isolation_organizations ON "organizations";
--> statement-breakpoint
CREATE POLICY tenant_isolation_organizations ON "organizations"
  FOR ALL
  USING (id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation_users ON "users";
--> statement-breakpoint
CREATE POLICY tenant_isolation_users ON "users"
  FOR ALL
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation_jobs ON "jobs";
--> statement-breakpoint
CREATE POLICY tenant_isolation_jobs ON "jobs"
  FOR ALL
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation_invites ON "organization_invites";
--> statement-breakpoint
CREATE POLICY tenant_isolation_invites ON "organization_invites"
  FOR ALL
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
