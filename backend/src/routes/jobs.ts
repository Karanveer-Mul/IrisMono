import { Router, Request, Response } from "express";
import { systemDb, withTenant } from "../db";
import { organizations, jobs } from "../db/schema";
import { eq, and, sql } from "drizzle-orm";
import {
  authenticateJWT,
  authenticateStorageEvent,
  authenticateStreamToken,
  authenticateWorker,
  AuthenticatedRequest,
} from "../middleware/auth";
import { dispatchJob } from "../dispatch";
import { AUDIT_ACTIONS, clientIp, recordAuditEvent } from "../audit";
import {
  decryptForOrganization,
  encryptForOrganization,
  encryptionConfigured,
  isEncrypted,
} from "../crypto";
import { sseHub } from "../sse";
import { publishJobEvent } from "../sse/bus";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import { reserveCredit, refundCredit, InsufficientCredits } from "../credits";
import { assertOrganizationActive, OrganizationClosed } from "../lifecycle";
import {
  jobDuration,
  jobGpuSeconds,
  jobQueueWait,
  jobReports,
  jobReportsRejected,
} from "../observability/apiMetrics";
import * as fs from "fs";
import * as path from "path";

const router = Router();

const BUCKET_NAME = process.env.S3_BUCKET_NAME || "medical-image-masks-bucket";
const AWS_REGION = process.env.AWS_REGION || "us-east-1";

const UPLOADS_DIR = path.join(__dirname, "../../../uploads");

// Setup S3 Client (can point to LocalStack, MinIO, or AWS S3)
const s3Client = new S3Client({
  region: AWS_REGION,
  endpoint: process.env.AWS_S3_ENDPOINT || undefined,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "mock-key-id",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "mock-secret-key",
  },
  forcePathStyle: true,
});

/**
 * Ceiling on a single uploaded scan.
 *
 * A presigned PUT lets the client choose the body, so nothing upstream bounds
 * it. Enforced while streaming rather than from Content-Length, because the
 * client picks that too.
 */
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 25 * 1024 * 1024);

/** The eight bytes every PNG starts with. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Recovers the job id from a raw-scan object key.
 *
 * Keys are `org_id=<orgId>/jobs/<jobId>/raw.png`. Only raw scans start a job;
 * a mask written by a worker lands in the same bucket and must not.
 */
function jobIdFromKey(key: string): string | null {
  const match = /\/jobs\/([0-9a-f-]{36})\/raw\.png$/i.exec(key);
  return match ? match[1] : null;
}

/**
 * Settles a job whose upload was refused.
 *
 * The upload has been answered, so nothing further is coming for this job.
 * Leaving it PENDING would hold the customer's credit until the reaper expired
 * it half an hour later, for a request that was rejected immediately.
 */
async function failRejectedUpload(jobId: string, reason: string) {
  try {
    await systemDb.transaction(async (tx) => {
      const locked = await tx.execute(
        sql`SELECT organization_id, status FROM jobs WHERE id = ${jobId} FOR UPDATE`
      );
      if (locked.rows.length === 0) return;

      const row = locked.rows[0] as { organization_id: string; status: string };
      if (row.status !== "PENDING") return;

      await tx
        .update(jobs)
        .set({
          status: "FAILED",
          errorMessage: `Upload rejected: ${reason}`,
          completedAt: sql`NOW()`,
        })
        .where(eq(jobs.id, jobId));

      await refundCredit(tx, row.organization_id, jobId, `Upload rejected: ${reason}`);

      await publishJobEvent(row.organization_id, "JOB_STATUS_CHANGE", {
        jobId,
        status: "FAILED",
        error: `Upload rejected: ${reason}`,
      });
    });
  } catch (error) {
    // The reaper is the backstop if this fails; the credit is not lost, only
    // returned later than it should have been.
    console.error(`Could not settle rejected upload for job ${jobId}:`, error);
  }
}

/** Page size for the audit log, and the ceiling a caller may ask for. */
const DEFAULT_LOG_PAGE = 50;
const MAX_LOG_PAGE = 200;

/**
 * Cursors are opaque on purpose.
 *
 * Base64 rather than exposing the timestamp and id, so the pagination key stays
 * an implementation detail: changing the sort later must not break clients that
 * stored a cursor, and a client that tries to construct one by hand is a client
 * that will break.
 */
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const [timestamp, id] = Buffer.from(cursor, "base64url").toString().split("|");
    const createdAt = new Date(timestamp);
    if (!id || Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * Records how long a job waited between reservation and being claimed.
 *
 * The tier label costs one indexed primary-key lookup per job - not per
 * request - and it is what separates "the standard pool is saturated" from
 * "the tenant we sold a dedicated pool to is queueing", which are different
 * incidents with different responses. Failing to resolve the tier must never
 * fail the claim, so it degrades to an unlabelled observation.
 */
async function recordQueueWait(orgId: string, createdAt: Date | null, startedAt: Date | null) {
  if (!createdAt || !startedAt) return;

  const seconds = (startedAt.getTime() - createdAt.getTime()) / 1000;

  // Both timestamps are generated by the database, so this cannot be negative
  // unless something has gone wrong with the clock behind them. Said out loud
  // rather than dropped: a metric that silently discards its input looks
  // identical to a metric nothing is happening on, which is how the clock skew
  // that motivated this comment stayed hidden.
  if (seconds < 0) {
    console.warn(`Negative queue wait (${seconds}s) for org ${orgId}; check clock sources.`);
    return;
  }

  let tier = "unknown";
  try {
    const org = await systemDb.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
      columns: { infrastructureTier: true },
    });
    if (org) tier = org.infrastructureTier;
  } catch (err) {
    console.error("Could not resolve tier for queue-wait metric:", err);
  }

  jobQueueWait.observe({ tier }, seconds);
}

/* ------------------------------------------------------------------ *
 * Routes with their own authentication, declared before the global
 * Bearer middleware below.
 * ------------------------------------------------------------------ */

/**
 * Mock object storage: the direct upload target.
 * PUT /api/jobs/mock-upload/:jobId
 *
 * Stands in for a presigned PUT to S3, so it authenticates the way one does -
 * by possession of a URL naming a job that is still waiting for its image,
 * not by a session. Two things happen here that the old version did not do:
 * the upload is validated, and completing it dispatches the job.
 */
router.put("/mock-upload/:jobId", async (req, res) => {
  const { jobId } = req.params;

  try {
    if (!fs.existsSync(UPLOADS_DIR)) {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    }

    const filePath = path.join(UPLOADS_DIR, `${jobId}-raw.png`);

    // Buffered rather than streamed straight to disk, because the bytes are
    // encrypted before they land: an authenticated cipher produces its tag at
    // the end, so nothing can be written until the whole body is in hand. The
    // ceiling below is what makes that safe to hold in memory.
    const chunks: Buffer[] = [];
    let received = 0;
    let rejection: string | null = null;
    let signatureChecked = false;

    const abort = async (reason: string, statusCode: number) => {
      if (rejection) return;
      rejection = reason;

      // The reservation is settled here rather than left to the reaper. The
      // upload was answered - nothing further is coming for this job - so
      // holding the customer's credit for thirty minutes would be punitive.
      await failRejectedUpload(jobId, reason);

      if (!res.headersSent) {
        res.status(statusCode).json({ error: reason });
      }
      req.destroy();
    };

    req.on("data", (chunk: Buffer) => {
      if (rejection) return;

      // A presigned PUT sets only ContentType: the client picks the body, so
      // the ceiling has to be enforced where the bytes land. Checked as they
      // arrive, not from Content-Length, which the client also picks.
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) {
        void abort(`Upload exceeds the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit`, 413);
        return;
      }

      // The first bytes decide the format. A GPU worker should never be the
      // thing that discovers a scan is a zip file.
      if (!signatureChecked && chunk.length >= PNG_SIGNATURE.length) {
        signatureChecked = true;
        if (!chunk.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
          void abort("Upload is not a PNG image", 415);
          return;
        }
      }

      chunks.push(chunk);
    });

    req.on("end", async () => {
      if (rejection) return;

      if (received === 0) {
        return abort("Upload is empty", 400);
      }

      try {
        const job = await systemDb.query.jobs.findFirst({
          where: eq(jobs.id, jobId),
          columns: { organizationId: true },
        });

        if (!job) {
          return res.status(404).json({ error: "No reservation exists for this upload" });
        }

        // Encrypted with the tenant's own data key before it touches the disk,
        // so the image directory is inert without the key that wraps it.
        const plaintext = Buffer.concat(chunks);
        const atRest = encryptionConfigured()
          ? await encryptForOrganization(job.organizationId, plaintext)
          : plaintext;

        await fs.promises.writeFile(filePath, atRest);

        console.log(
          `Mock S3 direct-upload completed locally for job ${jobId} ` +
          `(${received} bytes, ${encryptionConfigured() ? "encrypted" : "plaintext"})`
        );

        // Upload completion *is* the trigger. On real S3 this is the bucket's
        // event notification calling POST /api/jobs/storage-events; here the
        // mock storage layer is in-process, so it calls dispatch directly.
        const result = await dispatchJob(jobId, { requestId: req.requestId });
        return res.status(200).json({
          message: "Upload completed successfully",
          dispatched: result.dispatched,
          ...(result.dispatched ? { queue: result.queue } : {}),
        });
      } catch (error) {
        console.error(`Upload handling failed for job ${jobId}:`, error);
        if (!res.headersSent) {
          return res.status(500).json({ error: "Upload could not be stored or queued" });
        }
      }
    });

  } catch (error) {
    console.error("Mock upload catch error:", error);
    return res.status(500).json({ error: "Mock upload handler failed" });
  }
});

/**
 * Object storage event notification
 * POST /api/jobs/storage-events
 *
 * What a real deployment wires the bucket to. S3 sends an ObjectCreated
 * notification, and that notification is what queues the job - so the browser
 * is never trusted to report its own upload, and an image can never sit in the
 * bucket with nothing scheduled to process it.
 *
 * Authenticated by shared secret, like the worker's report: the caller is
 * infrastructure, not a user, and it identifies the job by object key alone.
 */
router.post("/storage-events", authenticateStorageEvent, async (req: Request, res: Response) => {
  // Accepts the S3 notification envelope, and a flat {key} for anything else
  // that can be pointed at a webhook.
  const records = Array.isArray(req.body?.Records) ? req.body.Records : null;
  const keys: string[] = records
    ? records
        .map((record: any) => record?.s3?.object?.key)
        .filter((key: unknown): key is string => typeof key === "string")
        .map((key: string) => decodeURIComponent(key.replace(/\+/g, " ")))
    : typeof req.body?.key === "string"
      ? [req.body.key]
      : [];

  if (keys.length === 0) {
    return res.status(400).json({ error: "No object key in the event" });
  }

  const results: Record<string, string> = {};

  for (const key of keys) {
    const jobId = jobIdFromKey(key);
    if (!jobId) {
      // Not a raw scan - a mask written by a worker, or anything else in the
      // bucket. Acknowledged so the notification is not retried forever.
      results[key] = "ignored";
      continue;
    }

    try {
      const result = await dispatchJob(jobId, { requestId: req.requestId });
      results[key] = result.dispatched ? `queued:${result.queue}` : result.reason;
    } catch (error) {
      console.error(`Storage event dispatch failed for ${key}:`, error);
      // 500 so the notification is redelivered: S3 retries, and the claim was
      // released, so a later attempt can still queue the job.
      return res.status(500).json({ error: "Dispatch failed", results });
    }
  }

  return res.status(200).json({ results });
});

/**
 * SSE Live Events subscription
 * GET /api/jobs/events?token=<stream token>
 *
 * Authenticated by query token rather than Authorization header, because
 * EventSource cannot set headers. Clients mint one via POST /api/auth/stream-token.
 */
router.get("/events", authenticateStreamToken, (req: AuthenticatedRequest, res: Response) => {
  const orgId = req.user!.organizationId;
  const userId = req.user!.id;

  // EventSource resends Last-Event-ID automatically after a dropped connection;
  // the query parameter is the manual equivalent for other clients.
  const rawLastId = req.headers["last-event-id"] ?? req.query.lastEventId;
  const parsed = typeof rawLastId === "string" ? Number(rawLastId) : NaN;
  const lastEventId = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;

  sseHub.addConnection(orgId, userId, res, lastEventId);
});

/**
 * Worker job outcome report
 * POST /api/jobs/:jobId/report
 *
 * The API owns job finalization, credit settlement, and SSE fan-out - the
 * worker only reports what happened. This keeps database credentials out of
 * the GPU tier and keeps every SSE connection in one process.
 */
router.post("/:jobId/report", authenticateWorker, async (req: Request, res: Response) => {
  const { jobId } = req.params;
  const { status, maskImageS3Key, errorMessage, modelVersion, workerId, gpuSeconds } = req.body ?? {};

  if (status !== "PROCESSING" && status !== "SUCCESS" && status !== "FAILED") {
    jobReportsRejected.inc({ reason: "invalid_status" });
    return res.status(400).json({ error: "status must be PROCESSING, SUCCESS or FAILED" });
  }

  // A produced mask must be attributable. Without this the guarantee is only a
  // convention, and one worker deployed without MODEL_VERSION would silently
  // create masks that cannot be traced to the model that generated them.
  if (status === "SUCCESS" && (typeof modelVersion !== "string" || modelVersion.trim() === "")) {
    jobReportsRejected.inc({ reason: "missing_model_version" });
    return res.status(400).json({ error: "modelVersion is required when reporting SUCCESS" });
  }

  // The worker knows a job id and nothing else - it has no organization
  // context to set, so this runs on the RLS-bypassing system identity. It is
  // gated by the worker shared secret and only ever touches the one job.
  try {
    // Interim progress: no credit implications, no transaction needed.
    if (status === "PROCESSING") {
      const [claimed] = await systemDb
        .update(jobs)
        // startedAt gives the reaper a clock for execution time, separate from
        // how long the reservation has existed. workerId is recorded at claim
        // time so a job that never completes can still be traced to a machine.
        .set({
          status: "PROCESSING",
          // NOW(), not the API's clock. created_at is generated by the
          // database, so a timestamp taken here is measured against a
          // different clock - and any interval spanning the two is wrong by
          // the skew between them. Locally that skew is the Docker VM running
          // a third of a second ahead of the host, which was enough to make
          // every queue wait come out negative. The same mismatch shifts the
          // reaper's PROCESSING timeout, which compares started_at against
          // NOW() in SQL.
          startedAt: sql`NOW()`,
          workerId: typeof workerId === "string" ? workerId : null,
        })
        .where(and(eq(jobs.id, jobId), eq(jobs.status, "PENDING")))
        .returning();

      // A worker re-claiming a job it already owns is a retry, not a race.
      //
      // Without this, backoff redelivery would be pointless: the first attempt
      // leaves the job PROCESSING, so the redelivered copy would be refused and
      // dropped, and the job would sit until the reaper expired it. The rule is
      // deliberately narrow - only the same worker id, so a delivery reaching a
      // *different* worker is still refused and the dead one's job is left to
      // the reaper. Worker ids include the pid, so a restarted process does not
      // inherit its predecessor's claims.
      let reclaimed: typeof claimed | undefined;
      if (!claimed && typeof workerId === "string") {
        [reclaimed] = await systemDb
          .update(jobs)
          .set({ startedAt: sql`NOW()` })
          .where(and(eq(jobs.id, jobId), eq(jobs.status, "PROCESSING"), eq(jobs.workerId, workerId)))
          .returning();
      }

      const updated = claimed ?? reclaimed;

      if (!updated) {
        jobReportsRejected.inc({ reason: "not_pending" });
        return res.status(409).json({ error: "Job is not PENDING" });
      }

      // Queue wait: reservation to claim. This is the number to autoscale on -
      // it rises before anything else visibly breaks, and unlike queue depth it
      // is denominated in what the customer actually experiences.
      //
      // Only on a first claim. Measuring it again on a retry would fold the
      // backoff delay into the queue wait and make the metric read as a
      // capacity problem.
      if (claimed) {
        await recordQueueWait(claimed.organizationId, claimed.createdAt, claimed.startedAt);
      }
      jobReports.inc({ status: claimed ? "PROCESSING" : "PROCESSING_RECLAIM" });

      await publishJobEvent(updated.organizationId, "JOB_STATUS_CHANGE", {
        jobId,
        status: "PROCESSING",
      });

      return res.status(200).json({ jobId, status: "PROCESSING" });
    }

    // Terminal states settle the reserved credit, so they run in a transaction
    // with the job row locked.
    const outcome = await systemDb.transaction(async (tx) => {
      const locked = await tx.execute(
        sql`SELECT id, organization_id, status, started_at FROM jobs WHERE id = ${jobId} FOR UPDATE`
      );

      if (locked.rows.length === 0) {
        return { notFound: true as const };
      }

      const row = locked.rows[0] as {
        organization_id: string;
        status: string;
        started_at: string | null;
      };

      // Idempotency guard: a redelivered message must not refund twice.
      if (row.status === "SUCCESS" || row.status === "FAILED") {
        return { alreadyFinal: true as const, status: row.status };
      }

      // completed_at is NOW() for the same reason started_at is: every job
      // timestamp is then on one clock, and the intervals between them mean
      // something.
      let settled: { startedAt: Date | null; completedAt: Date | null } | undefined;

      if (status === "SUCCESS") {
        [settled] = await tx
          .update(jobs)
          .set({
            status: "SUCCESS",
            maskImageS3Key: maskImageS3Key ?? null,
            modelVersion: modelVersion.trim(),
            workerId: typeof workerId === "string" ? workerId : null,
            gpuSeconds: typeof gpuSeconds === "number" ? gpuSeconds : null,
            completedAt: sql`NOW()`,
          })
          .where(eq(jobs.id, jobId))
          .returning({ startedAt: jobs.startedAt, completedAt: jobs.completedAt });
      } else {
        [settled] = await tx
          .update(jobs)
          .set({
            status: "FAILED",
            errorMessage: errorMessage || "Model processing failed",
            // Recorded on failure too: a model version that fails often is
            // exactly what you want to be able to query for.
            modelVersion: typeof modelVersion === "string" ? modelVersion.trim() : null,
            workerId: typeof workerId === "string" ? workerId : null,
            gpuSeconds: typeof gpuSeconds === "number" ? gpuSeconds : null,
            completedAt: sql`NOW()`,
          })
          .where(eq(jobs.id, jobId))
          .returning({ startedAt: jobs.startedAt, completedAt: jobs.completedAt });

        // Reservation is released only on failure. Idempotent: a replayed
        // report cannot refund twice, independently of the status guard above.
        await refundCredit(tx, row.organization_id, jobId, "Refunded after job failure");
      }

      return {
        orgId: row.organization_id,
        startedAt: settled?.startedAt ?? null,
        completedAt: settled?.completedAt ?? null,
      };
    });

    if ("notFound" in outcome) {
      jobReportsRejected.inc({ reason: "not_found" });
      return res.status(404).json({ error: "Job not found" });
    }

    if ("alreadyFinal" in outcome) {
      jobReportsRejected.inc({ reason: "already_final" });
      return res.status(409).json({ error: `Job already finalized as ${outcome.status}` });
    }

    jobReports.inc({ status });

    // Wall-clock execution, which includes anything the worker did around the
    // model - fetching the scan, writing the mask. gpuSeconds below is the
    // model itself, and the gap between the two is where waste hides.
    if (outcome.startedAt && outcome.completedAt) {
      const seconds =
        (outcome.completedAt.getTime() - outcome.startedAt.getTime()) / 1000;
      if (seconds >= 0) jobDuration.observe({ status }, seconds);
    }

    if (typeof gpuSeconds === "number" && Number.isFinite(gpuSeconds)) {
      jobGpuSeconds.observe({ status }, gpuSeconds);
    }

    await publishJobEvent(outcome.orgId, "JOB_STATUS_CHANGE", {
      jobId,
      status,
      maskImageS3Key: status === "SUCCESS" ? maskImageS3Key ?? null : undefined,
      error: status === "FAILED" ? errorMessage : undefined,
    });

    return res.status(200).json({ jobId, status });

  } catch (error) {
    console.error(`Failed to record report for job ${jobId}:`, error);
    return res.status(500).json({ error: "Failed to record job outcome" });
  }
});

/* ------------------------------------------------------------------ *
 * Everything below requires a user session.
 * ------------------------------------------------------------------ */

router.use(authenticateJWT);

/**
 * 1. Request Presigned URL & Reserve Credit (Option A)
 * POST /api/jobs/request
 */
router.post("/request", async (req: AuthenticatedRequest, res: Response) => {
  const orgId = req.user!.organizationId;
  const userId = req.user!.id;

  try {
    // Start transactional credit checking & reservation
    const result = await withTenant(orgId, async (tx) => {
      // Inside the transaction, so the workspace cannot close between the check
      // and the reservation. A closed workspace that could still spend credits
      // would keep billing after the customer stopped.
      await assertOrganizationActive(tx, orgId);

      const jobId = randomUUID();
      const s3Key = `org_id=${orgId}/jobs/${jobId}/raw.png`;

      // The job row is written first so the ledger's job_id foreign key
      // resolves; the reservation below still holds the organization lock for
      // the rest of the transaction, so concurrent spenders remain serialized.
      await tx
        .insert(jobs)
        .values({
          id: jobId,
          organizationId: orgId,
          userId,
          status: "PENDING",
          rawImageS3Key: s3Key,
        })
        .returning();

      // Locks the organization row, writes the ledger entry, and decrements the
      // materialized balance. Throws InsufficientCredits if there is none left.
      await reserveCredit(tx, orgId, jobId);

      return { jobId, s3Key };
    });

    // d. Generate S3 presigned URL for the reserved job
    let presignedUrl = "";
    const isMock = process.env.AWS_ACCESS_KEY_ID === "mock-key-id";

    if (isMock) {
      // Local fallback: mock upload URL
      presignedUrl = `${req.protocol}://${req.get("host")}/api/jobs/mock-upload/${result.jobId}`;
    } else {
      const command = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: result.s3Key,
        ContentType: "image/png",
      });
      presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    }

    return res.status(200).json({
      jobId: result.jobId,
      s3Key: result.s3Key,
      uploadUrl: presignedUrl,
    });

  } catch (error: any) {
    if (error instanceof InsufficientCredits) {
      return res.status(402).json({ error: "Insufficient organization credits remaining to start a new job." });
    }
    if (error instanceof OrganizationClosed) {
      return res.status(410).json({ error: "This workspace has been closed and cannot start new jobs." });
    }
    console.error("Queue job request error:", error);
    return res.status(500).json({ error: error.message || "Failed to initiate job" });
  }
});

/**
 * 2. Fetch billing audit logs
 * GET /api/jobs/logs
 */
router.get("/logs", async (req: AuthenticatedRequest, res: Response) => {
  const orgId = req.user!.organizationId;

  // Recall filter: ?modelVersion=<version> answers "which of our scans were
  // produced by this model build?" - the question that matters when a version
  // is withdrawn. Backed by idx_jobs_model_version.
  const modelVersion = typeof req.query.modelVersion === "string" ? req.query.modelVersion : null;

  const requested = Number(req.query.limit);
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), MAX_LOG_PAGE)
    : DEFAULT_LOG_PAGE;

  const cursor = typeof req.query.cursor === "string" ? decodeCursor(req.query.cursor) : null;
  if (req.query.cursor && !cursor) {
    return res.status(400).json({ error: "Malformed cursor" });
  }

  try {
    // Keyset pagination, not OFFSET.
    //
    // This table only grows, and the specification keeps it forever. OFFSET
    // makes the database walk and discard every skipped row, so the last page
    // of a long-lived tenant costs the most - and any job created mid-scroll
    // shifts every subsequent page by one, silently duplicating or skipping a
    // row. Seeking on (created_at, id) is stable under insertion and reads only
    // the page asked for.
    const page = await withTenant(orgId, (tx) =>
      tx.query.jobs.findMany({
        where: and(
          eq(jobs.organizationId, orgId),
          ...(modelVersion ? [eq(jobs.modelVersion, modelVersion)] : []),
          // The id tiebreaks jobs sharing a timestamp, which two requests in
          // the same millisecond will.
          ...(cursor
            ? [sql`(${jobs.createdAt}, ${jobs.id}) < (${cursor.createdAt}, ${cursor.id})`]
            : [])
        ),
        orderBy: (jobs, { desc }) => [desc(jobs.createdAt), desc(jobs.id)],
        // One extra row answers "is there more" without a second count query.
        limit: limit + 1,
      })
    );

    const hasMore = page.length > limit;
    const logs = hasMore ? page.slice(0, limit) : page;
    const last = logs[logs.length - 1];

    return res.status(200).json({
      logs,
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
    });
  } catch (error) {
    console.error("Failed to fetch logs:", error);
    return res.status(500).json({ error: "Failed to fetch logs" });
  }
});

/**
 * 3. Dispatch fallback
 * POST /api/jobs/:jobId/trigger
 *
 * No longer part of the normal path: the upload dispatches the job, because the
 * client should not be load-bearing for a state transition it does not own.
 * This remains for the case where storage event notifications are not wired up
 * yet, and for operators re-queueing a job by hand.
 *
 * It is safe to call redundantly. A job the upload already dispatched answers
 * 400, and only one caller can ever win the claim, so calling it after an
 * upload cannot double-queue the scan.
 */
router.post("/:jobId/trigger", async (req: AuthenticatedRequest, res: Response) => {
  const { jobId } = req.params;
  const orgId = req.user!.organizationId;

  try {
    // Scoped to the caller's organization, unlike the storage-event path: this
    // one has a session, so it must not be able to reach another tenant's job.
    const result = await dispatchJob(jobId, { requestId: req.requestId, organizationId: orgId });

    if (!result.dispatched) {
      if (result.reason === "not_found") {
        return res.status(404).json({ error: "Job record not found." });
      }
      return res.status(400).json({
        error: `Job has already been dispatched. Current status: ${result.status}`,
      });
    }

    return res.status(202).json({
      message: "Job successfully queued for processing",
      jobId,
      queue: result.queue,
    });

  } catch (error) {
    console.error("Failed to trigger job:", error);
    return res.status(500).json({ error: "Failed to queue job message broker execution" });
  }
});

/**
 * 4. Serve a job's raw scan or generated mask
 * GET /api/jobs/:jobId/image/:kind  (kind: raw | mask)
 *
 * Tenant-scoped: the job must belong to the caller's organization. Served
 * behind the normal Bearer session, so the client fetches it as a blob rather
 * than pointing an <img src> straight at it.
 */
router.get("/:jobId/image/:kind", async (req: AuthenticatedRequest, res: Response) => {
  const { jobId, kind } = req.params;
  const orgId = req.user!.organizationId;

  if (kind !== "raw" && kind !== "mask") {
    return res.status(400).json({ error: "Image kind must be 'raw' or 'mask'" });
  }

  try {
    const job = await withTenant(orgId, (tx) =>
      tx.query.jobs.findFirst({
        where: and(eq(jobs.id, jobId), eq(jobs.organizationId, orgId)),
      })
    );

    if (!job) {
      return res.status(404).json({ error: "Job record not found." });
    }

    // jobId comes from a UUID-keyed lookup that just succeeded, so it cannot
    // contain traversal characters by the time we build the path.
    const filePath = path.join(UPLOADS_DIR, `${job.id}-${kind}.png`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: `No ${kind} image stored for this job` });
    }

    const stored = await fs.promises.readFile(filePath);
    // Decrypted on the way out. A file written before encryption was enabled
    // passes through unchanged, so switching it on does not orphan old scans.
    const image = await decryptForOrganization(orgId, stored);

    // Every read of a scan is recorded. This is the question a hospital asks
    // after an incident - who opened this patient's images, and when - and it
    // cannot be answered retrospectively if it was not being written down.
    void recordAuditEvent({
      action: AUDIT_ACTIONS.SCAN_ACCESSED,
      organizationId: orgId,
      actorUserId: req.user!.id,
      actorEmail: req.user!.email,
      target: jobId,
      metadata: { kind, encrypted: isEncrypted(stored) },
      ip: clientIp(req),
    });

    res.setHeader("Content-Type", "image/png");
    // no-store, not a private cache window: a scan left in a shared
    // workstation's browser cache outlives the session that fetched it.
    res.setHeader("Cache-Control", "no-store");
    return res.send(image);

  } catch (error) {
    console.error("Failed to serve job image:", error);
    return res.status(500).json({ error: "Failed to read job image" });
  }
});

export default router;
