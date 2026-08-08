import { sql } from "drizzle-orm";
import { systemDb } from "./db";

/**
 * Closing a workspace or an account.
 *
 * "Delete the organization" is a request every B2B product eventually receives,
 * and in this domain it cannot be answered with DELETE. Migration 0011 makes
 * that structural: jobs and credit_transactions reference organizations with
 * ON DELETE RESTRICT, so the database rejects the delete rather than cascading
 * through the clinical and billing record. Since every organization is created
 * with a TRIAL_GRANT ledger row, that is true from the moment it exists.
 *
 * What remains is closure: the tenant stops being able to act, its data stops
 * being reachable through the API, and the record stays.
 *
 * This is deliberately NOT the same as erasure. A tenant asking to have their
 * data destroyed is served by destroying their encryption key (src/crypto.ts),
 * which makes the stored images unreadable while leaving the metadata that
 * billing and auditing are obliged to keep. Those are different requests and
 * they have different answers.
 */

type Executor = { execute: (query: any) => Promise<any> };

export class OrganizationClosed extends Error {
  constructor() {
    super("ORGANIZATION_CLOSED");
  }
}

/**
 * Refuses to proceed when the organization has been closed.
 *
 * Called on the paths that create new state - reserving a credit, redeeming an
 * invite - rather than on every read. A closed workspace that could still queue
 * jobs would keep spending and keep producing records nobody is going to look
 * at; a closed workspace whose existing rows can still be read by an
 * administrator during an export or an investigation is useful.
 *
 * Takes an executor so it can run inside the caller's transaction: checking
 * outside one would leave a window between the check and the write in which the
 * workspace closes.
 */
export async function assertOrganizationActive(tx: Executor, orgId: string): Promise<void> {
  const result = await tx.execute(
    sql`SELECT deleted_at FROM organizations WHERE id = ${orgId}`
  );

  if (result.rows.length === 0) {
    throw new Error("Organization not found");
  }

  if (result.rows[0].deleted_at !== null) {
    throw new OrganizationClosed();
  }
}

export interface ClosureResult {
  /** False when it was already closed - closing twice is not an error. */
  changed: boolean;
  closedAt: string | null;
}

/**
 * Marks an organization closed.
 *
 * Conditional on it being open, so two administrators clicking at once produce
 * one closure timestamp rather than the second overwriting the first - the time
 * of closure is itself part of the record.
 */
export async function closeOrganization(orgId: string): Promise<ClosureResult> {
  const result = await systemDb.execute(sql`
    UPDATE organizations
       SET deleted_at = NOW(), updated_at = NOW()
     WHERE id = ${orgId} AND deleted_at IS NULL
    RETURNING deleted_at::text AS closed_at
  `);

  if (result.rows.length > 0) {
    return { changed: true, closedAt: result.rows[0].closed_at as string };
  }

  const existing = await systemDb.execute(
    sql`SELECT deleted_at::text AS closed_at FROM organizations WHERE id = ${orgId}`
  );

  return {
    changed: false,
    closedAt: existing.rows.length > 0 ? (existing.rows[0].closed_at as string | null) : null,
  };
}

/**
 * Reverses a closure.
 *
 * Reachable only with a session token minted before the workspace closed,
 * because the organization stops appearing in membershipsOf the moment it is
 * closed and no new token can name it. That is a deliberately narrow window -
 * roughly a day - covering the case this actually guards against, which is an
 * administrator closing the wrong workspace and noticing immediately. Later
 * than that it is an operator action, and it should be: reopening a workspace
 * that a customer asked to have closed is not a self-service decision.
 */
export async function reopenOrganization(orgId: string): Promise<boolean> {
  const result = await systemDb.execute(sql`
    UPDATE organizations
       SET deleted_at = NULL, updated_at = NOW()
     WHERE id = ${orgId} AND deleted_at IS NOT NULL
    RETURNING id
  `);

  return result.rows.length > 0;
}
