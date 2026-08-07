import { sql } from "drizzle-orm";
import { systemDb } from "./db";
import { creditMovements } from "./observability/apiMetrics";

/**
 * Credit movement.
 *
 * Every change to an organization's balance goes through here, and every change
 * writes a ledger row. The invariant is:
 *
 *     organizations.credit_balance == SUM(credit_transactions.delta)
 *
 * The balance column is a materialized total, kept because the reservation path
 * needs SELECT ... FOR UPDATE on one row to serialize concurrent spenders.
 * reconcile() below proves the two agree.
 *
 * Job-linked movements are idempotent by construction: a partial unique index on
 * (job_id, reason) means a replayed worker report or an overlapping reaper sweep
 * hits a constraint rather than moving the balance twice. The call sites do not
 * have to remember - the database refuses.
 */

/** Anything that can run a query: the pooled handle or an open transaction. */
type Executor = { execute: (query: any) => Promise<any> };

export class InsufficientCredits extends Error {
  constructor() {
    super("INSUFFICIENT_CREDITS");
  }
}

/**
 * Reserves one credit for a job, with the organization row locked.
 *
 * Must be called inside a transaction - the lock has to be held until the job
 * row is written, or two concurrent requests could both pass the balance check.
 * Throws InsufficientCredits when there is nothing left to reserve.
 */
export async function reserveCredit(tx: Executor, orgId: string, jobId: string) {
  const locked = await tx.execute(
    sql`SELECT credit_balance FROM organizations WHERE id = ${orgId} FOR UPDATE`
  );

  if (locked.rows.length === 0) {
    throw new Error("Organization not found");
  }

  if (Number(locked.rows[0].credit_balance) <= 0) {
    throw new InsufficientCredits();
  }

  await tx.execute(sql`
    INSERT INTO credit_transactions (organization_id, job_id, delta, reason)
    VALUES (${orgId}, ${jobId}, -1, 'JOB_RESERVATION')
  `);

  await tx.execute(sql`
    UPDATE organizations
       SET credit_balance = credit_balance - 1, updated_at = NOW()
     WHERE id = ${orgId}
  `);

  // Counted here rather than at the call sites, for the same reason the ledger
  // row is written here: this is the only place a balance moves, so the metric
  // cannot drift from what actually happened. Deliberately unlabelled by
  // organization - tenant ids are unbounded cardinality.
  creditMovements.inc({ reason: "JOB_RESERVATION" });
}

/**
 * Returns the credit reserved for a job.
 *
 * Idempotent: if this job has already been refunded the insert conflicts, no
 * row is produced, and the balance is left alone. Returns whether it actually
 * refunded, which is what lets the reaper report an honest count.
 */
export async function refundCredit(
  tx: Executor,
  orgId: string,
  jobId: string,
  note?: string
): Promise<boolean> {
  const inserted = await tx.execute(sql`
    INSERT INTO credit_transactions (organization_id, job_id, delta, reason, note)
    VALUES (${orgId}, ${jobId}, 1, 'JOB_REFUND', ${note ?? null})
    ON CONFLICT (job_id, reason) WHERE job_id IS NOT NULL DO NOTHING
    RETURNING id
  `);

  if (inserted.rows.length === 0) {
    return false; // Already refunded.
  }

  await tx.execute(sql`
    UPDATE organizations
       SET credit_balance = credit_balance + 1, updated_at = NOW()
     WHERE id = ${orgId}
  `);

  // Only counted when a refund actually happened. A rising refund rate means
  // the model is failing or workers are dying; a suppressed duplicate means
  // idempotency did its job and is not a business event.
  creditMovements.inc({ reason: "JOB_REFUND" });

  return true;
}

/**
 * Adds credits not tied to a job: the trial grant at signup, or a manual
 * adjustment. Not idempotent - each call is a distinct, intentional event.
 */
export async function grantCredits(
  tx: Executor,
  orgId: string,
  amount: number,
  reason: "TRIAL_GRANT" | "MANUAL_ADJUSTMENT",
  note?: string
) {
  if (amount === 0) return;

  await tx.execute(sql`
    INSERT INTO credit_transactions (organization_id, delta, reason, note)
    VALUES (${orgId}, ${amount}, ${sql.raw(`'${reason}'`)}, ${note ?? null})
  `);

  await tx.execute(sql`
    UPDATE organizations
       SET credit_balance = credit_balance + ${amount}, updated_at = NOW()
     WHERE id = ${orgId}
  `);

  creditMovements.inc({ reason });
}

export interface Discrepancy {
  organizationId: string;
  name: string;
  balance: number;
  ledgerTotal: number;
}

/**
 * Finds organizations whose stored balance disagrees with their ledger.
 *
 * A non-empty result means something moved the balance without recording it -
 * a code path that bypassed this module, or a manual UPDATE. Worth running on a
 * schedule in a real deployment; the test suites assert it comes back empty.
 */
export async function reconcile(): Promise<Discrepancy[]> {
  const result = await systemDb.execute(sql`
    SELECT o.id,
           o.name,
           o.credit_balance,
           COALESCE(SUM(ct.delta), 0) AS ledger_total
      FROM organizations o
      LEFT JOIN credit_transactions ct ON ct.organization_id = o.id
     GROUP BY o.id, o.name, o.credit_balance
    HAVING o.credit_balance <> COALESCE(SUM(ct.delta), 0)
  `);

  return (result.rows as any[]).map((row) => ({
    organizationId: row.id,
    name: row.name,
    balance: Number(row.credit_balance),
    ledgerTotal: Number(row.ledger_total),
  }));
}
