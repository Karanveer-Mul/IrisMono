import { Router, Response } from "express";
import { db } from "../db";
import { organizations, jobs } from "../db/schema";
import { eq, and, sql } from "drizzle-orm";
import { authenticateJWT, AuthenticatedRequest } from "../middleware/auth";
import { sseHub } from "../sse";
import { publishJob } from "../queue";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";

const router = Router();

const BUCKET_NAME = process.env.S3_BUCKET_NAME || "medical-image-masks-bucket";
const AWS_REGION = process.env.AWS_REGION || "us-east-1";

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

import * as fs from "fs";
import * as path from "path";

// Public Mock upload endpoint (bypasses JWT to behave like S3)
router.put("/mock-upload/:jobId", async (req, res) => {
  const { jobId } = req.params;
  const uploadsDir = path.join(__dirname, "../../../uploads");

  try {
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const filePath = path.join(uploadsDir, `${jobId}-raw.png`);
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
    const result = await db.transaction(async (tx) => {
      // a. SELECT FOR UPDATE to lock organization row and prevent overdraft race conditions
      // Note: In Drizzle, we can execute a raw SQL query or check if there is an alternative.
      // Drizzle ORM does not support `forUpdate()` natively on select builder in all versions, 
      // so we use a raw SQL query here to ensure full row-level locking.
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

      const [newJob] = await tx
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
 * 2. Trigger job execution (Notify API that S3 upload completed)
 * POST /api/jobs/:jobId/trigger
 */
router.post("/:jobId/trigger", async (req: AuthenticatedRequest, res: Response) => {
  const { jobId } = req.params;
  const orgId = req.user!.organizationId;

  try {
    const job = await db.query.jobs.findFirst({
      where: and(
        eq(jobs.id, jobId),
        eq(jobs.organizationId, orgId)
      ),
    });

    if (!job) {
      return res.status(404).json({ error: "Job record not found." });
    }

    if (job.status !== "PENDING") {
      return res.status(400).json({ error: `Job has already been dispatched. Current status: ${job.status}` });
    }

    // Determine target queue (standard vs VIP infrastructure routing)
    // For local tests, we can verify if the organization's name contains "VIP" or check metadata.
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
    });

    const isVip = org?.name.toLowerCase().includes("vip") || false;
    const queueName = isVip ? `queue-vip-${orgId}` : "queue-standard-jobs";

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
 * 3. SSE Live Events subscription
 * GET /api/jobs/events
 */
router.get("/events", (req: AuthenticatedRequest, res: Response) => {
  const orgId = req.user!.organizationId;
  const userId = req.user!.id;

  sseHub.addConnection(orgId, userId, res);
});

/**
 * 4. Fetch billing audit logs
 * GET /api/jobs/logs
 */
router.get("/logs", async (req: AuthenticatedRequest, res: Response) => {
  const orgId = req.user!.organizationId;

  try {
    const logs = await db.query.jobs.findMany({
      where: eq(jobs.organizationId, orgId),
      orderBy: (jobs, { desc }) => [desc(jobs.createdAt)],
    });

    return res.status(200).json({ logs });
  } catch (error) {
    return res.status(500).json({ error: "Failed to fetch logs" });
  }
});

export default router;
