import * as amqp from "amqplib";
import { db } from "./db";
import { jobs, organizations } from "./db/schema";
import { eq, sql } from "drizzle-orm";
import { sseHub } from "./sse";
import * as fs from "fs";
import * as path from "path";

const AMQP_URL = process.env.AMQP_URL || "amqp://guest:guest@localhost:5672";
const QUEUE_STANDARD = "queue-standard-jobs";

async function startWorker() {
  console.log("Starting GPU simulation worker queue consumer...");

  try {
    const connection = await amqp.connect(AMQP_URL);
    const channel = await connection.createChannel();

    // Ensure standard queue is asserted
    await channel.assertQueue(QUEUE_STANDARD, { durable: true });
    // Prefetch 1 message to simulate concurrency control per worker
    channel.prefetch(1);

    console.log(`Worker listening on queue '${QUEUE_STANDARD}'`);

    channel.consume(QUEUE_STANDARD, async (msg) => {
      if (!msg) return;

      const payload = JSON.parse(msg.content.toString());
      const { jobId, orgId, s3Key } = payload;
      
      console.log(`[Worker] Received job ${jobId} for org ${orgId}`);

      try {
        // 1. Update status to PROCESSING
        await db
          .update(jobs)
          .set({ status: "PROCESSING" })
          .where(eq(jobs.id, jobId));

        // Broadcast status change immediately to listening clients
        sseHub.broadcastToOrg(orgId, "JOB_STATUS_CHANGE", {
          jobId,
          status: "PROCESSING",
        });

        // 2. Simulate heavy GPU processing (e.g. 5 seconds)
        console.log(`[Worker] Running machine learning mask model on GPU for job ${jobId}...`);
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // 3. Simulated model outcomes (90% success, 10% failure simulation)
        const isSuccess = Math.random() > 0.1;

        if (isSuccess) {
          // Handle mock S3 file writes locally
          const uploadsDir = path.join(__dirname, "../../uploads");
          const rawPath = path.join(uploadsDir, `${jobId}-raw.png`);
          const maskPath = path.join(uploadsDir, `${jobId}-mask.png`);

          if (fs.existsSync(rawPath)) {
            // Generate mock mask: just copy raw image or write a blank dummy
            fs.copyFileSync(rawPath, maskPath);
            console.log(`[Worker] Generated mask file locally at: ${maskPath}`);
          }

          // Atomic Settlement: Transition job to SUCCESS (credit was already reserved at request-time)
          await db.transaction(async (tx) => {
            // Row-level lock job
            const jobRows = await tx.execute(
              sql`SELECT id, status FROM jobs WHERE id = ${jobId} FOR UPDATE`
            );

            if (jobRows.rows.length === 0) {
              throw new Error("Job not found during worker completion");
            }

            const mockMaskKey = `org_id=${orgId}/jobs/${jobId}/mask.png`;

            await tx
              .update(jobs)
              .set({
                status: "SUCCESS",
                maskImageS3Key: mockMaskKey,
                completedAt: new Date(),
              })
              .where(eq(jobs.id, jobId));
          });

          console.log(`[Worker] Job ${jobId} completed successfully.`);

          // Notify frontend of success
          sseHub.broadcastToOrg(orgId, "JOB_STATUS_CHANGE", {
            jobId,
            status: "SUCCESS",
            maskImageS3Key: `org_id=${orgId}/jobs/${jobId}/mask.png`,
          });

        } else {
          // Fail path
          throw new Error("GPU out of memory or ML model threshold assertion failed.");
        }

      } catch (error: any) {
        console.error(`[Worker] Failed job ${jobId}:`, error.message);

        // Fail path under transaction: set status FAILED and refund credit
        try {
          await db.transaction(async (tx) => {
            // Row-level lock job
            const jobRows = await tx.execute(
              sql`SELECT id, status FROM jobs WHERE id = ${jobId} FOR UPDATE`
            );

            if (jobRows.rows.length === 0) {
              return;
            }

            // Update job to FAILED
            await tx
              .update(jobs)
              .set({
                status: "FAILED",
                errorMessage: error.message || "Model processing failed",
                completedAt: new Date(),
              })
              .where(eq(jobs.id, jobId));

            // Lock organization and refund 1 credit
            await tx.execute(
              sql`UPDATE organizations SET credit_balance = credit_balance + 1, updated_at = NOW() WHERE id = ${orgId}`
            );
          });

          console.log(`[Worker] Job ${jobId} failed. Credit refunded.`);

          // Notify frontend of failure
          sseHub.broadcastToOrg(orgId, "JOB_STATUS_CHANGE", {
            jobId,
            status: "FAILED",
            error: error.message || "Internal ML worker failure",
          });

        } catch (txErr) {
          console.error(`[Worker] Fatal transaction rollback error for job ${jobId}:`, txErr);
        }
      } finally {
        // Acknowledge message from broker
        channel.ack(msg);
      }
    });

  } catch (err) {
    console.error("Worker connection failed to RabbitMQ:", err);
    setTimeout(startWorker, 5000);
  }
}

// Run worker
startWorker();
export {};
