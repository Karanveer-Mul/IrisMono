import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import * as schema from "./schema";
import * as dotenv from "dotenv";

dotenv.config();

/**
 * Three connection identities, deliberately separate.
 *
 * - DATABASE_URL        irismono_app   Row-Level Security enforced. Everything
 *                                      tenant-scoped goes through this, via
 *                                      withTenant() so the org context is set.
 * - AUTH_DATABASE_URL   irismono_auth  BYPASSRLS. Only for operations that have
 *                                      no organization context yet (login,
 *                                      registration, invite redemption) or that
 *                                      act as the system (worker reports).
 * - ADMIN_DATABASE_URL  postgres       DDL and migrations only.
 *
 * The application must never run tenant queries as a superuser: superusers
 * bypass RLS unconditionally, so the policies would be silently inert.
 */
const connectionString =
  process.env.DATABASE_URL || "postgresql://postgres:password@localhost:5432/irismono";

const authConnectionString = process.env.AUTH_DATABASE_URL || connectionString;
const adminConnectionString = process.env.ADMIN_DATABASE_URL || connectionString;

export const pool = new Pool({ connectionString });
export const authPool = new Pool({ connectionString: authConnectionString });
export const adminPool = new Pool({ connectionString: adminConnectionString });

/** RLS-enforced handle. Use through withTenant(). */
export const db = drizzle(pool, { schema });

/**
 * RLS-bypassing handle. Legitimate uses are narrow:
 *   - login / registration / invite redemption, which look up rows by email or
 *     invite code before any organization is known;
 *   - the GPU worker's job report, which is authenticated by shared secret and
 *     identifies the job by id alone.
 * Anything else belongs on `db`.
 */
export const systemDb = drizzle(authPool, { schema });

/** DDL handle, used by the migration runner. */
export const adminDb = drizzle(adminPool, { schema });

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Runs a callback inside a transaction with the tenant context applied, so the
 * RLS policies resolve.
 *
 * set_config's third argument is is_local: the setting is scoped to this
 * transaction and is discarded on commit or rollback. That matters because the
 * pool hands the same physical connection to unrelated requests afterwards - a
 * session-level SET here would leak one tenant's context into another tenant's
 * queries, which is a worse failure than having no RLS at all.
 */
export async function withTenant<T>(organizationId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.current_organization_id', ${organizationId}, true)`
    );
    return fn(tx);
  });
}
