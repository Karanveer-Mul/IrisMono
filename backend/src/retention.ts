import * as fs from "fs";
import * as path from "path";
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
 * Per-tenant retention (a hospital contract requiring 7 days rather than 30)
 * would need either a rule per prefix or object tagging - see AUDIT.md.
 */

const RETENTION_DAYS = Number(process.env.STORAGE_RETENTION_DAYS || 30);
const SWEEP_INTERVAL_HOURS = Number(process.env.RETENTION_SWEEP_INTERVAL_HOURS || 6);

/**
 * The SSE event log only has to outlive a disconnected client, not serve as an
 * audit record - jobs and credit_transactions already do that indefinitely.
 */
const EVENT_LOG_RETENTION_DAYS = Number(process.env.EVENT_LOG_RETENTION_DAYS || 7);

const UPLOADS_DIR = path.join(__dirname, "../../uploads");

/** Deletes stored images older than the retention window. Returns the count. */
export async function sweepExpiredArtifacts(): Promise<number> {
  if (RETENTION_DAYS <= 0) {
    return 0; // Retention disabled.
  }

  if (!fs.existsSync(UPLOADS_DIR)) {
    return 0;
  }

  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;

  for (const entry of await fs.promises.readdir(UPLOADS_DIR)) {
    const filePath = path.join(UPLOADS_DIR, entry);
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.isFile() && stat.mtimeMs < cutoff) {
        await fs.promises.unlink(filePath);
        removed++;
      }
    } catch (err) {
      console.error(`[Retention] Could not process ${entry}:`, err);
    }
  }

  if (removed > 0) {
    console.log(`[Retention] Deleted ${removed} artifact(s) older than ${RETENTION_DAYS} days.`);
  }

  return removed;
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
    `Retention sweeper started: delete stored images after ${RETENTION_DAYS} days, ` +
    `prune events after ${EVENT_LOG_RETENTION_DAYS} days, sweeping every ${SWEEP_INTERVAL_HOURS}h`
  );

  sweep().catch((err) => console.error("[Retention] Sweep failed:", err));

  const timer = setInterval(() => {
    sweep().catch((err) => console.error("[Retention] Sweep failed:", err));
  }, SWEEP_INTERVAL_HOURS * 60 * 60 * 1000);

  timer.unref();
  return timer;
}
