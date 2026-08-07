import { sql } from "drizzle-orm";
import { systemDb } from "./db";
import { sseHub } from "./sse";

/**
 * Reclaims credits from jobs that will never finish.
 *
 * Two ways a reservation leaks:
 *
 *   PENDING    A credit is reserved by POST /jobs/request, but the client never
 *              triggers dispatch - closing the tab after the upload is enough.
 *              Nothing else would ever move that row.
 *   PROCESSING A worker claimed the job and then died. The message may be
 *              redelivered, but if the process was killed mid-run nothing
 *              settles the credit.
 *
 * The specification requires that a job which "fails or times out" must not
 * consume credit. Failure was handled; the timeout half had no implementation.
 */

const PENDING_TIMEOUT_MINUTES = Number(process.env.JOB_PENDING_TIMEOUT_MINUTES || 30);
const PROCESSING_TIMEOUT_MINUTES = Number(process.env.JOB_PROCESSING_TIMEOUT_MINUTES || 15);
const REAPER_INTERVAL_SECONDS = Number(process.env.REAPER_INTERVAL_SECONDS || 60);

interface ReapedRow {
  id: string;
  organization_id: string;
}

/**
 * Expires one class of stale job and refunds the reserved credit.
 *
 * The UPDATE ... WHERE status = <expected> is the concurrency guard: if a
 * worker settles the job first, zero rows match and no refund is issued. The
 * credit is only ever returned by whichever writer wins.
 */
async function expire(
  status: "PENDING" | "PROCESSING",
  clockColumn: "created_at" | "started_at",
  minutes: number,
  reason: string
): Promise<ReapedRow[]> {
  return systemDb.transaction(async (tx) => {
    const stale = await tx.execute(sql`
      UPDATE jobs
         SET status = 'FAILED',
             error_message = ${reason},
             completed_at = NOW()
       WHERE status = ${status}
         AND ${sql.raw(clockColumn)} IS NOT NULL
         AND ${sql.raw(clockColumn)} < NOW() - ${`${minutes} minutes`}::interval
      RETURNING id, organization_id
    `);

    const rows = stale.rows as unknown as ReapedRow[];
    if (rows.length === 0) return [];

    // Refund one credit per reclaimed job, grouped so each organization takes a
    // single locked update rather than one per job.
    const perOrg = new Map<string, number>();
    for (const row of rows) {
      perOrg.set(row.organization_id, (perOrg.get(row.organization_id) ?? 0) + 1);
    }

    for (const [orgId, count] of perOrg) {
      await tx.execute(sql`
        UPDATE organizations
           SET credit_balance = credit_balance + ${count},
               updated_at = NOW()
         WHERE id = ${orgId}
      `);
    }

    return rows;
  });
}

export async function reapStaleJobs(): Promise<number> {
  const reaped = [
    ...(await expire(
      "PENDING",
      "created_at",
      PENDING_TIMEOUT_MINUTES,
      `Reservation expired: the image was never dispatched within ${PENDING_TIMEOUT_MINUTES} minutes.`
    )),
    ...(await expire(
      "PROCESSING",
      "started_at",
      PROCESSING_TIMEOUT_MINUTES,
      `Processing timed out after ${PROCESSING_TIMEOUT_MINUTES} minutes.`
    )),
  ];

  for (const row of reaped) {
    sseHub.broadcastToOrg(row.organization_id, "JOB_STATUS_CHANGE", {
      jobId: row.id,
      status: "FAILED",
      error: "Job expired. The reserved credit has been returned.",
    });
  }

  if (reaped.length > 0) {
    console.log(`[Reaper] Expired ${reaped.length} stale job(s); credits refunded.`);
  }

  return reaped.length;
}

export function startReaper() {
  console.log(
    `Reaper started: PENDING > ${PENDING_TIMEOUT_MINUTES}m, ` +
    `PROCESSING > ${PROCESSING_TIMEOUT_MINUTES}m, every ${REAPER_INTERVAL_SECONDS}s`
  );

  const timer = setInterval(() => {
    reapStaleJobs().catch((err) => console.error("[Reaper] Sweep failed:", err));
  }, REAPER_INTERVAL_SECONDS * 1000);

  // Do not hold the process open on this alone.
  timer.unref();
  return timer;
}
