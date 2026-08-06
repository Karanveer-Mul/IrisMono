import * as amqp from "amqplib";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

const AMQP_URL = process.env.AMQP_URL || "amqp://guest:guest@localhost:5672";
const QUEUE_STANDARD = "queue-standard-jobs";

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:3000";
const WORKER_SECRET = process.env.WORKER_SECRET || "local-dev-worker-secret";

/**
 * Report a job outcome to the API.
 *
 * The worker deliberately holds no database credentials and no SSE hub. The
 * API owns finalization, credit settlement, and notification fan-out - which
 * is also the only way browser clients ever see these events, since they are
 * connected to the API process, not to this one.
 */
class ReportError extends Error {
  constructor(message: string, readonly httpStatus: number | null) {
    super(message);
  }
}

async function reportJobStatus(
  jobId: string,
  body: {
    status: "PROCESSING" | "SUCCESS" | "FAILED";
    maskImageS3Key?: string;
    errorMessage?: string;
  }
) {
  let response: globalThis.Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/jobs/${jobId}/report`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-worker-secret": WORKER_SECRET,
      },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    // API unreachable - no HTTP status to reason about.
    throw new ReportError(`Report request failed: ${err.message}`, null);
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new ReportError(`Report failed [HTTP ${response.status}] ${detail}`, response.status);
  }
}

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
      const { jobId, orgId } = payload;

      console.log(`[Worker] Received job ${jobId} for org ${orgId}`);

      try {
        // 1. Claim the job. A 409 means it is no longer PENDING - another
        // delivery already owns it, so drop this copy rather than racing.
        try {
          await reportJobStatus(jobId, { status: "PROCESSING" });
        } catch (claimErr) {
          if (claimErr instanceof ReportError && claimErr.httpStatus === 409) {
            console.warn(`[Worker] Job ${jobId} is not PENDING; discarding duplicate delivery.`);
            channel.ack(msg);
            return;
          }
          throw claimErr;
        }

        // 2. Simulate heavy GPU processing (e.g. 5 seconds)
        console.log(`[Worker] Running machine learning mask model on GPU for job ${jobId}...`);
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // 3. Simulated model outcomes (90% success, 10% failure simulation)
        const isSuccess = Math.random() > 0.1;

        if (!isSuccess) {
          throw new Error("GPU out of memory or ML model threshold assertion failed.");
        }

        // Handle mock S3 file writes locally
        const uploadsDir = path.join(__dirname, "../../uploads");
        const rawPath = path.join(uploadsDir, `${jobId}-raw.png`);
        const maskPath = path.join(uploadsDir, `${jobId}-mask.png`);

        if (fs.existsSync(rawPath)) {
          // Generate mock mask: just copy raw image or write a blank dummy
          fs.copyFileSync(rawPath, maskPath);
          console.log(`[Worker] Generated mask file locally at: ${maskPath}`);
        }

        await reportJobStatus(jobId, {
          status: "SUCCESS",
          maskImageS3Key: `org_id=${orgId}/jobs/${jobId}/mask.png`,
        });

        console.log(`[Worker] Job ${jobId} completed successfully.`);
        channel.ack(msg);

      } catch (error: any) {
        console.error(`[Worker] Failed job ${jobId}:`, error.message);

        try {
          await reportJobStatus(jobId, {
            status: "FAILED",
            errorMessage: error.message || "Internal ML worker failure",
          });
          console.log(`[Worker] Job ${jobId} reported as FAILED. Credit refunded by API.`);

          // The outcome is recorded, so the message is done.
          channel.ack(msg);

        } catch (reportErr) {
          // The outcome was NOT recorded. Acking here would strand the job in
          // PROCESSING with its credit still reserved and nothing left to retry
          // it, so requeue instead and let another delivery settle it.
          console.error(`[Worker] Could not report outcome for job ${jobId}:`, reportErr);

          // Back off before requeueing: without a dead-letter queue (AUDIT fix
          // #7) an immediate nack spins hot while the API is unreachable.
          setTimeout(() => channel.nack(msg, false, true), 5000);
        }
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
