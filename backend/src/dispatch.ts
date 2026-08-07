import { and, eq, isNull, sql } from "drizzle-orm";
import { systemDb } from "./db";
import { jobs, organizations } from "./db/schema";
import { publishJob, QUEUES } from "./queue";

/**
 * Job dispatch.
 *
 * Dispatch used to be a step the browser performed: request a credit, PUT the
 * image, then call /trigger. That made the client load-bearing for a state
 * transition it has no business owning. Closing the tab between the upload and
 * the trigger stranded a reserved credit; calling the trigger without uploading
 * spent GPU scheduling on an image that did not exist.
 *
 * Now the storage layer decides. Upload completion is what queues the job, so
 * the two states cannot diverge: there is no window in which an image exists
 * and no job is queued, or a job is queued and no image exists.
 *
 * Every route that can start a job funnels through here, so the single-shot
 * guarantee lives in one place rather than in each caller.
 */

export type DispatchResult =
  | { dispatched: true; queue: string }
  | { dispatched: false; reason: "not_found" | "already_dispatched"; status?: string };

/**
 * Claims the right to dispatch, then publishes.
 *
 * Runs on the system identity because its callers have no tenant context: an
 * object-storage event notification is authenticated by shared secret and knows
 * only a key, exactly like a worker's job report. The organization is read from
 * the job row rather than trusted from the caller.
 */
export async function dispatchJob(
  jobId: string,
  options: {
    /** Correlation id to carry onto the queue, when one exists. */
    requestId?: string;
    /**
     * Restricts the claim to one tenant. Set when a user session is driving
     * the dispatch; omitted for storage events, which are authenticated by
     * secret and identify the job by key alone.
     */
    organizationId?: string;
  } = {}
): Promise<DispatchResult> {
  // One caller wins this UPDATE. The others are told the job is already on its
  // way, which is the correct answer for a retried upload or a double click.
  const [claimed] = await systemDb
    .update(jobs)
    .set({ dispatchedAt: sql`NOW()` })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.status, "PENDING"),
        isNull(jobs.dispatchedAt),
        ...(options.organizationId ? [eq(jobs.organizationId, options.organizationId)] : [])
      )
    )
    .returning();

  if (!claimed) {
    const existing = await systemDb.query.jobs.findFirst({
      where: and(
        eq(jobs.id, jobId),
        ...(options.organizationId ? [eq(jobs.organizationId, options.organizationId)] : [])
      ),
    });
    if (!existing) return { dispatched: false, reason: "not_found" };
    return { dispatched: false, reason: "already_dispatched", status: existing.status };
  }

  const org = await systemDb.query.organizations.findFirst({
    where: eq(organizations.id, claimed.organizationId),
    columns: { infrastructureTier: true },
  });

  // One queue per tier, not per tenant - see src/queue/index.ts.
  const queue = org?.infrastructureTier === "VIP" ? QUEUES.VIP : QUEUES.STANDARD;

  try {
    await publishJob(queue, {
      jobId: claimed.id,
      orgId: claimed.organizationId,
      s3Key: claimed.rawImageS3Key,
      requestId: options.requestId,
    });
  } catch (err) {
    // Release the claim so the upload can be retried. Left set, a broker hiccup
    // would strand the job in PENDING until the reaper expired it - trading a
    // rare double-dispatch for a routine dropped one.
    await systemDb.update(jobs).set({ dispatchedAt: null }).where(eq(jobs.id, claimed.id));
    throw err;
  }

  return { dispatched: true, queue };
}
