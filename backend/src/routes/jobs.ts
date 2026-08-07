import { Router, Request, Response } from "express";
import { systemDb, withTenant } from "../db";
import { organizations, jobs } from "../db/schema";
import { eq, and, sql } from "drizzle-orm";
import {
  authenticateJWT,
  authenticateStreamToken,
  authenticateWorker,
  AuthenticatedRequest,
} from "../middleware/auth";
import { sseHub } from "../sse";
import { publishJob, QUEUES } from "../queue";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
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

/* ------------------------------------------------------------------ *
 * Routes with their own authentication, declared before the global
 * Bearer middleware below.
 * ------------------------------------------------------------------ */

// Public Mock upload endpoint (bypasses JWT to behave like S3)
router.put("/mock-upload/:jobId", async (req, res) => {
  const { jobId } = req.params;

  try {
    if (!fs.existsSync(UPLOADS_DIR)) {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    }

    const filePath = path.join(UPLOADS_DIR, `${jobId}-raw.png`);
    const writeStream = fs.createWriteStream(filePath);

    req.pipe(writeStream);

    writeStream.on("finish", () => {
      console.log(`Mock S3 direct-upload completed locally for job ${jobId}`);
      return res.status(200).json({ message: "Mock S3 direct-upload completed successfully" });
    });

    writeStream.on("error", (err) => {
      console.error("Mock upload write error:", err);
      return res.status(500).json({ error: "Mock upload failed writing file" });
    });

  } catch (error) {
    console.error("Mock upload catch error:", error);
    return res.status(500).json({ error: "Mock upload handler failed" });
  }
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

  sseHub.addConnection(orgId, userId, res);
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
  const { status, maskImageS3Key, errorMessage } = req.body ?? {};

  if (status !== "PROCESSING" && status !== "SUCCESS" && status !== "FAILED") {
    return res.status(400).json({ error: "status must be PROCESSING, SUCCESS or FAILED" });
  }

  // The worker knows a job id and nothing else - it has no organization
  // context to set, so this runs on the RLS-bypassing system identity. It is
  // gated by the worker shared secret and only ever touches the one job.
  try {
    // Interim progress: no credit implications, no transaction needed.
    if (status === "PROCESSING") {
      const [updated] = await systemDb
        .update(jobs)
        // startedAt gives the reaper a clock for execution time, separate from
        // how long the reservation has existed.
        .set({ status: "PROCESSING", startedAt: new Date() })
        .where(and(eq(jobs.id, jobId), eq(jobs.status, "PENDING")))
        .returning();

      if (!updated) {
        return res.status(409).json({ error: "Job is not PENDING" });
      }

      sseHub.broadcastToOrg(updated.organizationId, "JOB_STATUS_CHANGE", {
        jobId,
        status: "PROCESSING",
      });

      return res.status(200).json({ jobId, status: "PROCESSING" });
    }

    // Terminal states settle the reserved credit, so they run in a transaction
    // with the job row locked.
    const outcome = await systemDb.transaction(async (tx) => {
      const locked = await tx.execute(
        sql`SELECT id, organization_id, status FROM jobs WHERE id = ${jobId} FOR UPDATE`
      );

      if (locked.rows.length === 0) {
        return { notFound: true as const };
      }

      const row = locked.rows[0] as { organization_id: string; status: string };

      // Idempotency guard: a redelivered message must not refund twice.
      if (row.status === "SUCCESS" || row.status === "FAILED") {
        return { alreadyFinal: true as const, status: row.status };
      }

      if (status === "SUCCESS") {
        await tx
          .update(jobs)
          .set({
            status: "SUCCESS",
            maskImageS3Key: maskImageS3Key ?? null,
            completedAt: new Date(),
          })
          .where(eq(jobs.id, jobId));
      } else {
        await tx
          .update(jobs)
          .set({
            status: "FAILED",
            errorMessage: errorMessage || "Model processing failed",
            completedAt: new Date(),
          })
          .where(eq(jobs.id, jobId));

        // Reservation is released only on failure.
        await tx.execute(
          sql`UPDATE organizations SET credit_balance = credit_balance + 1, updated_at = NOW() WHERE id = ${row.organization_id}`
        );
      }

      return { orgId: row.organization_id };
    });

    if ("notFound" in outcome) {
      return res.status(404).json({ error: "Job not found" });
    }

    if ("alreadyFinal" in outcome) {
      return res.status(409).json({ error: `Job already finalized as ${outcome.status}` });
    }

    sseHub.broadcastToOrg(outcome.orgId, "JOB_STATUS_CHANGE", {
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
      // a. SELECT FOR UPDATE to lock organization row and prevent overdraft race conditions
      const orgs = await tx.execute(
        sql`SELECT id, credit_balance, allowed_domains FROM organizations WHERE id = ${orgId} FOR UPDATE`
      );

      if (orgs.rows.length === 0) {
        throw new Error("Organization not found");
      }

      const creditBalance = orgs.rows[0].credit_balance as number;
      if (creditBalance <= 0) {
        throw new Error("INSUFFICIENT_CREDITS");
      }

      // b. Decrement credit balance immediately (Reservation)
      await tx.execute(
        sql`UPDATE organizations SET credit_balance = credit_balance - 1, updated_at = NOW() WHERE id = ${orgId}`
      );

      // c. Insert job record in PENDING state
      const jobId = randomUUID();
      const s3Key = `org_id=${orgId}/jobs/${jobId}/raw.png`;

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
    if (error.message === "INSUFFICIENT_CREDITS") {
      return res.status(402).json({ error: "Insufficient organization credits remaining to start a new job." });
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

  try {
    const logs = await withTenant(orgId, (tx) =>
      tx.query.jobs.findMany({
        where: eq(jobs.organizationId, orgId),
        orderBy: (jobs, { desc }) => [desc(jobs.createdAt)],
      })
    );

    return res.status(200).json({ logs });
  } catch (error) {
    return res.status(500).json({ error: "Failed to fetch logs" });
  }
});

/**
 * 3. Trigger job execution (Notify API that S3 upload completed)
 * POST /api/jobs/:jobId/trigger
 */
router.post("/:jobId/trigger", async (req: AuthenticatedRequest, res: Response) => {
  const { jobId } = req.params;
  const orgId = req.user!.organizationId;

  try {
    const found = await withTenant(orgId, async (tx) => {
      const job = await tx.query.jobs.findFirst({
        where: and(
          eq(jobs.id, jobId),
          eq(jobs.organizationId, orgId)
        ),
      });

      const org = await tx.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
      });

      return { job, org };
    });

    const { job, org } = found;

    if (!job) {
      return res.status(404).json({ error: "Job record not found." });
    }

    if (job.status !== "PENDING") {
      return res.status(400).json({ error: `Job has already been dispatched. Current status: ${job.status}` });
    }

    // Determine target queue from the organization's infrastructure tier.
    // One queue per tier, not per tenant - see src/queue/index.ts.
    const queueName = org?.infrastructureTier === "VIP" ? QUEUES.VIP : QUEUES.STANDARD;

    // Publish task message to RabbitMQ queue
    await publishJob(queueName, {
      jobId: job.id,
      orgId: orgId,
      s3Key: job.rawImageS3Key,
    });

    return res.status(202).json({
      message: "Job successfully queued for processing",
      jobId: job.id,
      queue: queueName,
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

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "private, max-age=300");
    return fs.createReadStream(filePath).pipe(res);

  } catch (error) {
    console.error("Failed to serve job image:", error);
    return res.status(500).json({ error: "Failed to read job image" });
  }
});

export default router;
