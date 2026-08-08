import * as fs from "fs";
import * as path from "path";
import { inArray, sql } from "drizzle-orm";
import { systemDb } from "./db";
import { jobs } from "./db/schema";
import { pruneJobEvents } from "./sse/bus";
import { pruneWorkers, WORKER_FORGET_AFTER_HOURS } from "./observability/fleet";

/**
 * Storage retention.
 *
 * arch.md section 1 requires that "storage cleanup/wiping must be fully
 * configurable (e.g. automated S3 lifecycle rules to delete files after X
 * days)". Nothing implemented it.
 *
 * Job metadata is deliberately NOT touched - the specification keeps it
 * indefinitely for billing and audit. Only the image bytes expire, which is
 * also what a bucket lifecycle rule would do. The image endpoint already
 * answers 404 for a job whose files have aged out, and the UI renders that as
 * "unavailable" rather than an error.
 *
 * On real S3 this sweeper is not the mechanism - configure the bucket instead,
 * which costs nothing and cannot be skipped by a process that failed to start:
 *
 *   aws s3api put-bucket-lifecycle-configuration \
 *     --bucket <bucket> \
 *     --lifecycle-configuration '{
 *       "Rules": [{
 *         "ID": "expire-scan-artifacts",
 *         "Status": "Enabled",
 *         "Filter": {"Prefix": "org_id="},
 *         "Expiration": {"Days": 30}
 *       }]
 *     }'
 *
 * Retention is per tenant. STORAGE_RETENTION_DAYS is the platform default, and
 * organizations.retention_days overrides it for a customer whose contract says
 * something else. The sweep is therefore driven from the database rather than
 * from the filesystem: it asks which jobs have outlived *their own* tenant's
 * window and deletes those files, instead of walking a directory and comparing
 * every mtime against one global number.
 *
 * That ordering also fixes a subtler thing. A file's mtime is a proxy for the
 * age of the scan; the job's created_at is the age of the scan. They differ
 * whenever a file is rewritten, restored from a backup, or copied between
 * hosts - and a restore that silently extends a contractual retention window is
 * the wrong direction to be wrong in.
 *
 * On real S3 the per-tenant equivalent is a lifecycle rule per `org_id=` prefix
 * or object tagging; the keys are already prefixed for it.
 */

const RETENTION_DAYS = Number(process.env.STORAGE_RETENTION_DAYS || 30);
const SWEEP_INTERVAL_HOURS = Number(process.env.RETENTION_SWEEP_INTERVAL_HOURS || 6);

/**
 * The SSE event log only has to outlive a disconnected client, not serve as an
 * audit record - jobs and credit_transactions already do that indefinitely.
 */
const EVENT_LOG_RETENTION_DAYS = Number(process.env.EVENT_LOG_RETENTION_DAYS || 7);

const UPLOADS_DIR = path.join(__dirname, "../../uploads");

/** How many jobs are examined per sweep. Bounds one pass, not the backlog. */
const SWEEP_BATCH = Number(process.env.RETENTION_SWEEP_BATCH || 500);

export interface SweepResult {
  /** Jobs whose window has passed and whose images are now gone. */
  jobs: number;
  /** Files actually unlinked. Lower than `jobs` when a file was already gone. */
  files: number;
}

/**
 * Deletes stored images for jobs that have outlived their tenant's window.
 *
 * The interval is computed in SQL against NOW(), so the comparison happens on
 * one clock. Mixing the database's idea of created_at with the application's
 * idea of "now" is how the queue-wait metric was silently negative for a while
 * - the same mistake here would expire scans early or keep them past a
 * contractual window, and nobody would notice either.
 */
export async function sweepExpiredArtifacts(): Promise<SweepResult> {
  if (RETENTION_DAYS <= 0) {
    return { jobs: 0, files: 0 }; // Platform retention disabled.
  }

  // COALESCE, not a value copied into the row: a tenant that has never stated a
  // preference tracks the deployment default, including when it changes.
  //
  // Deliberately no filter on organizations.deleted_at. A closed workspace's
  // scans still expire on schedule - closure is not a reason to keep images
  // longer, and it is the case where nobody is watching.
  const due = await systemDb.execute(sql`
    SELECT j.id
      FROM jobs j
      JOIN organizations o ON o.id = j.organization_id
     WHERE j.artifacts_purged_at IS NULL
       AND j.created_at < NOW() - (COALESCE(o.retention_days, ${RETENTION_DAYS}) || ' days')::interval
     ORDER BY j.created_at ASC
     LIMIT ${SWEEP_BATCH}
  `);

  if (due.rows.length === 0) {
    return { jobs: 0, files: 0 };
  }

  let files = 0;
  const purged: string[] = [];

  for (const row of due.rows as { id: string }[]) {
    let failed = false;

    for (const kind of ["raw", "mask"]) {
      const filePath = path.join(UPLOADS_DIR, `${row.id}-${kind}.png`);
      try {
        await fs.promises.unlink(filePath);
        files++;
      } catch (err: any) {
        // Already gone is the expected case for a mask that was never produced,
        // and for a re-sweep after a crash between unlink and the update below.
        if (err?.code !== "ENOENT") {
          console.error(`[Retention] Could not delete ${filePath}:`, err);
          failed = true;
        }
      }
    }

    // Marked only when the bytes are actually gone. Recording a purge that did
    // not happen would retire the job from the working set while its images sit
    // on disk past the window the tenant was promised - the one failure of this
    // sweeper that a customer could hold against the contract.
    if (!failed) {
      purged.push(row.id);
    }
  }

  if (purged.length > 0) {
    await systemDb
      .update(jobs)
      .set({ artifactsPurgedAt: sql`NOW()` })
      .where(inArray(jobs.id, purged));
    console.log(
      `[Retention] Purged images for ${purged.length} job(s) (${files} file(s)) past their tenant's window.`
    );
  }

  return { jobs: purged.length, files };
}

/** Artifacts, the SSE event log, and records of workers that are gone. */
async function sweep() {
  await sweepExpiredArtifacts();

  if (EVENT_LOG_RETENTION_DAYS > 0) {
    const pruned = await pruneJobEvents(EVENT_LOG_RETENTION_DAYS);
    if (pruned > 0) {
      console.log(`[Retention] Pruned ${pruned} job event(s) older than ${EVENT_LOG_RETENTION_DAYS} days.`);
    }
  }

  // A worker that scaled down should stop being reported as offline eventually,
  // or its gauge holds an alert open for a machine nobody expects to return.
  const forgotten = await pruneWorkers(WORKER_FORGET_AFTER_HOURS);
  if (forgotten > 0) {
    console.log(`[Retention] Forgot ${forgotten} worker(s) silent for over ${WORKER_FORGET_AFTER_HOURS}h.`);
  }
}

export function startRetentionSweeper() {
  if (RETENTION_DAYS <= 0) {
    console.log("Retention sweeper disabled (STORAGE_RETENTION_DAYS <= 0).");
    return null;
  }

  console.log(
    `Retention sweeper started: delete stored images after ${RETENTION_DAYS} days ` +
    `(or the tenant's own retention_days), prune events after ${EVENT_LOG_RETENTION_DAYS} days, ` +
    `sweeping every ${SWEEP_INTERVAL_HOURS}h`
  );

  sweep().catch((err) => console.error("[Retention] Sweep failed:", err));

  const timer = setInterval(() => {
    sweep().catch((err) => console.error("[Retention] Sweep failed:", err));
  }, SWEEP_INTERVAL_HOURS * 60 * 60 * 1000);

  timer.unref();
  return timer;
}
