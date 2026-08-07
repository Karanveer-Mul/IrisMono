import * as amqp from "amqplib";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assertTopology, QUEUES } from "./queue";

dotenv.config();

const AMQP_URL = process.env.AMQP_URL || "amqp://guest:guest@localhost:5672";

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:3000";
const WORKER_SECRET = process.env.WORKER_SECRET || "local-dev-worker-secret";

/**
 * Which tier queues this worker serves. A standard pool consumes the standard
 * queue; a dedicated pool for enterprise tenants is started with
 * WORKER_QUEUES=queue-vip-jobs and given its own GPU capacity.
 */
const CONSUMED_QUEUES = (process.env.WORKER_QUEUES || QUEUES.STANDARD)
  .split(",")
  .map((q) => q.trim())
  .filter(Boolean);

/**
 * Which model build this worker runs, and which worker it is.
 *
 * MODEL_VERSION is stamped onto every job this process completes. In a real
 * deployment it is the image tag or model artifact digest, injected at deploy
 * time - never edited by hand, or the provenance record means nothing.
 */
const MODEL_VERSION = process.env.MODEL_VERSION || "irismono-seg-sim-0.1.0";
const WORKER_ID = process.env.WORKER_ID || `${os.hostname()}:${process.pid}`;

/** In-process retries before a message is dead-lettered. */
const REPORT_ATTEMPTS = Number(process.env.WORKER_REPORT_ATTEMPTS || 3);
const REPORT_RETRY_DELAY_MS = Number(process.env.WORKER_REPORT_RETRY_DELAY_MS || 2000);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** The model ran and did not produce a mask. A real outcome, not an error. */
class ModelFailure extends Error {}

async function reportJobStatus(
  jobId: string,
  body: {
    status: "PROCESSING" | "SUCCESS" | "FAILED";
    maskImageS3Key?: string;
    errorMessage?: string;
    modelVersion?: string;
    workerId?: string;
    gpuSeconds?: number;
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

/**
 * Reports with bounded retries.
 *
 * Only transient conditions are retried. A 4xx is the API's considered answer -
 * a 409 means someone else already settled the job, and repeating the call will
 * never change that - so those surface immediately to the caller.
 */
async function reportWithRetry(
  jobId: string,
  body: Parameters<typeof reportJobStatus>[1]
) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= REPORT_ATTEMPTS; attempt++) {
    try {
      return await reportJobStatus(jobId, body);
    } catch (err) {
      lastError = err;

      const status = err instanceof ReportError ? err.httpStatus : null;
      const isTransient = status === null || status >= 500;
      if (!isTransient || attempt === REPORT_ATTEMPTS) {
        throw err;
      }

      console.warn(
        `[Worker] Report attempt ${attempt}/${REPORT_ATTEMPTS} for job ${jobId} failed; retrying...`
      );
      await sleep(REPORT_RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError;
}

async function startWorker() {
  console.log("Starting GPU simulation worker queue consumer...");

  try {
    const connection = await amqp.connect(AMQP_URL);
    const channel = await connection.createChannel();

    // Declare the exchange, tier queues, and their dead-letter queues.
    await assertTopology(channel);
    // Prefetch 1 message to simulate concurrency control per worker
    channel.prefetch(1);

    console.log(`Worker ${WORKER_ID} running ${MODEL_VERSION}`);
    console.log(`Worker listening on: ${CONSUMED_QUEUES.join(", ")}`);

    for (const queue of CONSUMED_QUEUES) {
      await channel.consume(queue, (msg) => handleMessage(channel, msg));
    }

  } catch (err) {
    console.error("Worker connection failed to RabbitMQ:", err);
    setTimeout(startWorker, 5000);
  }
}

async function handleMessage(channel: amqp.Channel, msg: amqp.ConsumeMessage | null) {
  if (!msg) return;

  let jobId: string | undefined;

  try {
    const payload = JSON.parse(msg.content.toString());
    jobId = payload.jobId;
    const orgId = payload.orgId;

    if (!jobId) {
      throw new Error("Message has no jobId");
    }

    console.log(`[Worker] Received job ${jobId} for org ${orgId}`);

    // 1. Claim the job. A 409 means it is no longer PENDING - another delivery
    // already owns it, so drop this copy rather than racing.
    try {
      await reportWithRetry(jobId, { status: "PROCESSING", workerId: WORKER_ID });
    } catch (claimErr) {
      if (claimErr instanceof ReportError && claimErr.httpStatus === 409) {
        console.warn(`[Worker] Job ${jobId} is not PENDING; discarding duplicate delivery.`);
        channel.ack(msg);
        return;
      }
      throw claimErr;
    }

    // 2. Simulate heavy GPU processing (e.g. 5 seconds)
    console.log(`[Worker] Running ${MODEL_VERSION} on GPU for job ${jobId}...`);
    const gpuStart = Date.now();
    await sleep(5000);
    const gpuSeconds = (Date.now() - gpuStart) / 1000;

    // 3. Simulated model outcomes (90% success, 10% failure simulation)
    const isSuccess = Math.random() > 0.1;

    if (!isSuccess) {
      throw new ModelFailure("GPU out of memory or ML model threshold assertion failed.");
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

    await reportWithRetry(jobId, {
      status: "SUCCESS",
      maskImageS3Key: `org_id=${orgId}/jobs/${jobId}/mask.png`,
      modelVersion: MODEL_VERSION,
      workerId: WORKER_ID,
      gpuSeconds,
    });

    console.log(`[Worker] Job ${jobId} completed successfully in ${gpuSeconds}s using ${MODEL_VERSION}.`);
    channel.ack(msg);

  } catch (error: any) {
    console.error(`[Worker] Failed job ${jobId ?? "<unparseable>"}:`, error.message);

    // A model failure is a real outcome and must be recorded so the credit is
    // returned. Anything else (unreachable API, malformed message) means we
    // could not establish an outcome at all.
    if (jobId && error instanceof ModelFailure) {
      try {
        await reportWithRetry(jobId, {
          status: "FAILED",
          errorMessage: error.message,
          modelVersion: MODEL_VERSION,
          workerId: WORKER_ID,
        });
        console.log(`[Worker] Job ${jobId} reported as FAILED. Credit refunded by API.`);
        channel.ack(msg);
        return;
      } catch (reportErr: any) {
        console.error(`[Worker] Could not report failure for job ${jobId}:`, reportErr.message);
      }
    }

    // Outcome not recorded. Do not requeue: retries already happened in-process,
    // and an endless redelivery loop would spin hot while the API is down.
    // Dead-letter it instead, so the message survives for inspection and the
    // reaper reclaims the credit once the job ages out.
    console.error(`[Worker] Dead-lettering job ${jobId ?? "<unparseable>"}.`);
    channel.nack(msg, false, false);
  }
}

// Run worker
startWorker();
export {};
