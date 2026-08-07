import * as amqp from "amqplib";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import { assertTopology, QUEUES } from "./queue";
import { CONTENT_TYPE } from "./observability/metrics";
import {
  busy,
  deadLettered,
  jobsFinished,
  messagesConsumed,
  modelDuration,
  reportFailures,
  workerRegistry,
} from "./observability/workerMetrics";
import { currentRequestId, logger, withRequestContext } from "./observability/logger";

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

/** Where this worker answers probes and Prometheus scrapes. 0 disables it. */
const HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT || 9101);

/** How often this worker tells the API it is still here. */
const HEARTBEAT_SECONDS = Number(process.env.WORKER_HEARTBEAT_SECONDS || 15);

process.env.LOG_SERVICE = process.env.LOG_SERVICE || "worker";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What this process is doing right now.
 *
 * A GPU worker is invisible from outside: it opens no listening socket in the
 * normal course of its work, holds no database credentials, and its only
 * outbound calls happen when a job ends. A worker that stopped consuming an
 * hour ago looks exactly like one that has had nothing to do. Everything below
 * exists to close that gap - locally through a probe port, and centrally
 * through a heartbeat the API records.
 */
const state = {
  startedAt: new Date(),
  status: "IDLE" as "IDLE" | "BUSY",
  currentJobId: null as string | null,
  jobsProcessed: 0,
  jobsFailed: 0,
  /** Set once the consumer is attached; readiness is false until then. */
  consuming: false,
};

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
        // Closes the trace: the API adopts this id, so the log line for the
        // report joins the browser request that dispatched the job.
        ...(currentRequestId() ? { "x-request-id": currentRequestId()! } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    // API unreachable - no HTTP status to reason about.
    reportFailures.inc({ status: "unreachable" });
    throw new ReportError(`Report request failed: ${err.message}`, null);
  }

  if (!response.ok) {
    const detail = await response.text();
    reportFailures.inc({ status: String(response.status) });
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
  logger.info("Starting GPU simulation worker queue consumer...");

  try {
    const connection = await amqp.connect(AMQP_URL);
    const channel = await connection.createChannel();

    // Declare the exchange, tier queues, and their dead-letter queues.
    await assertTopology(channel);
    // Prefetch 1 message to simulate concurrency control per worker
    channel.prefetch(1);

    logger.info(`Worker ${WORKER_ID} running ${MODEL_VERSION}`);
    logger.info(`Worker listening on: ${CONSUMED_QUEUES.join(", ")}`);

    for (const queue of CONSUMED_QUEUES) {
      await channel.consume(queue, (msg) => handleMessage(channel, msg, queue));
    }

    state.consuming = true;

    // A dropped broker connection is the failure that makes a worker look
    // healthy while doing nothing at all. Readiness has to know.
    connection.on("close", () => {
      state.consuming = false;
      logger.warn("Broker connection closed; worker is no longer consuming.");
    });

  } catch (err) {
    state.consuming = false;
    logger.error("Worker connection failed to RabbitMQ", { error: String(err) });
    setTimeout(startWorker, 5000);
  }
}

async function handleMessage(
  channel: amqp.Channel,
  msg: amqp.ConsumeMessage | null,
  queue: string
) {
  if (!msg) return;

  messagesConsumed.inc({ queue });

  // The id the API generated for the browser request that dispatched this job,
  // or a fresh one if the message predates correlation. Everything logged for
  // the rest of this handler carries it.
  const correlationId = msg.properties.correlationId || randomUUID();
  return withRequestContext(correlationId, () => processMessage(channel, msg));
}

async function processMessage(channel: amqp.Channel, msg: amqp.ConsumeMessage) {
  let jobId: string | undefined;

  try {
    const payload = JSON.parse(msg.content.toString());
    jobId = payload.jobId;
    const orgId = payload.orgId;

    if (!jobId) {
      throw new Error("Message has no jobId");
    }

    logger.info("Received job", { jobId, orgId });

    // 1. Claim the job. A 409 means it is no longer PENDING - another delivery
    // already owns it, so drop this copy rather than racing.
    try {
      await reportWithRetry(jobId, { status: "PROCESSING", workerId: WORKER_ID });
    } catch (claimErr) {
      if (claimErr instanceof ReportError && claimErr.httpStatus === 409) {
        logger.warn("Job is not PENDING; discarding duplicate delivery.", { jobId });
        channel.ack(msg);
        return;
      }
      throw claimErr;
    }

    // Claimed: this worker now owns the job, and says so to anyone who asks.
    state.status = "BUSY";
    state.currentJobId = jobId;
    busy.set({}, 1);

    // 2. Simulate heavy GPU processing (e.g. 5 seconds)
    logger.info(`Running ${MODEL_VERSION} on GPU`, { jobId });
    const gpuStart = Date.now();
    await sleep(5000);
    const gpuSeconds = (Date.now() - gpuStart) / 1000;

    // 3. Simulated model outcomes (90% success, 10% failure simulation)
    const isSuccess = Math.random() > 0.1;

    if (!isSuccess) {
      modelDuration.observe({ outcome: "failure" }, gpuSeconds);
      throw new ModelFailure("GPU out of memory or ML model threshold assertion failed.");
    }

    modelDuration.observe({ outcome: "success" }, gpuSeconds);

    // Handle mock S3 file writes locally
    const uploadsDir = path.join(__dirname, "../../uploads");
    const rawPath = path.join(uploadsDir, `${jobId}-raw.png`);
    const maskPath = path.join(uploadsDir, `${jobId}-mask.png`);

    if (fs.existsSync(rawPath)) {
      // Generate mock mask: just copy raw image or write a blank dummy
      fs.copyFileSync(rawPath, maskPath);
      logger.info("Generated mask file locally", { jobId, maskPath });
    }

    await reportWithRetry(jobId, {
      status: "SUCCESS",
      maskImageS3Key: `org_id=${orgId}/jobs/${jobId}/mask.png`,
      modelVersion: MODEL_VERSION,
      workerId: WORKER_ID,
      gpuSeconds,
    });

    state.jobsProcessed++;
    jobsFinished.inc({ outcome: "success" });
    logger.info("Job completed", { jobId, gpuSeconds, modelVersion: MODEL_VERSION });
    channel.ack(msg);

  } catch (error: any) {
    logger.error("Failed job", { jobId: jobId ?? "<unparseable>", error: error.message });

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
        state.jobsProcessed++;
        state.jobsFailed++;
        jobsFinished.inc({ outcome: "failure" });
        logger.info("Job reported as FAILED; credit refunded by API.", { jobId });
        channel.ack(msg);
        return;
      } catch (reportErr: any) {
        logger.error("Could not report failure", { jobId, error: reportErr.message });
      }
    }

    // Outcome not recorded. Do not requeue: retries already happened in-process,
    // and an endless redelivery loop would spin hot while the API is down.
    // Dead-letter it instead, so the message survives for inspection and the
    // reaper reclaims the credit once the job ages out.
    deadLettered.inc();
    jobsFinished.inc({ outcome: "dead_lettered" });
    logger.error("Dead-lettering job", { jobId: jobId ?? "<unparseable>" });
    channel.nack(msg, false, false);

  } finally {
    // Idle again whatever happened. A worker stuck reporting BUSY forever is
    // how a crashed handler hides behind a fleet view that looks busy.
    state.status = "IDLE";
    state.currentJobId = null;
    busy.set({}, 0);
  }
}

/**
 * Local probe and scrape endpoint.
 *
 * A queue consumer has no inbound port of its own, which is why worker health
 * is usually discovered from the outside - by noticing the queue is growing.
 * This is the standard remedy: a minimal listener whose only job is to let an
 * orchestrator restart a wedged process, and to let Prometheus scrape this
 * worker directly instead of inferring its state from the API.
 *
 * Readiness is "attached to the broker and consuming", which is the condition
 * that actually matters and the one that fails silently. Liveness is only "the
 * process still answers", for the same reason as on the API side: a worker
 * killed because RabbitMQ blinked comes back to the same unavailable RabbitMQ.
 */
function startProbeServer() {
  if (HEALTH_PORT <= 0) {
    logger.info("Worker probe server disabled (WORKER_HEALTH_PORT <= 0).");
    return null;
  }

  const server = http.createServer(async (req, res) => {
    const url = (req.url || "/").split("?")[0];

    if (url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          status: "alive",
          workerId: WORKER_ID,
          modelVersion: MODEL_VERSION,
          uptimeSeconds: Math.floor((Date.now() - state.startedAt.getTime()) / 1000),
        })
      );
    }

    if (url === "/health/ready") {
      res.writeHead(state.consuming ? 200 : 503, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          status: state.consuming ? "ready" : "not_consuming",
          workerId: WORKER_ID,
          queues: CONSUMED_QUEUES,
          jobStatus: state.status,
          currentJobId: state.currentJobId,
          jobsProcessed: state.jobsProcessed,
          jobsFailed: state.jobsFailed,
        })
      );
    }

    if (url === "/metrics") {
      const body = await workerRegistry.render();
      res.writeHead(200, { "Content-Type": CONTENT_TYPE });
      return res.end(body);
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(HEALTH_PORT, () => {
    logger.info(`Worker probes on http://localhost:${HEALTH_PORT}/health, metrics on /metrics`);
  });

  return server;
}

/**
 * Tells the API this worker exists.
 *
 * The probe port answers whoever can reach it; this is how the fleet becomes
 * visible centrally, without the API needing to know where workers are or how
 * many there should be. A failed heartbeat is logged and dropped - it must
 * never interfere with processing, because a worker that is doing its job while
 * unable to report that fact is still doing its job.
 */
async function sendHeartbeat() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/workers/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-worker-secret": WORKER_SECRET,
      },
      body: JSON.stringify({
        workerId: WORKER_ID,
        modelVersion: MODEL_VERSION,
        queues: CONSUMED_QUEUES.join(","),
        status: state.status,
        currentJobId: state.currentJobId,
        jobsProcessed: state.jobsProcessed,
        jobsFailed: state.jobsFailed,
        startedAt: state.startedAt.toISOString(),
      }),
    });

    if (!response.ok) {
      logger.warn("Heartbeat rejected", { status: response.status });
    }
  } catch (err: any) {
    logger.warn("Heartbeat failed", { error: err.message });
  }
}

function startHeartbeat() {
  void sendHeartbeat();
  const timer = setInterval(() => void sendHeartbeat(), HEARTBEAT_SECONDS * 1000);
  timer.unref();
  return timer;
}

// Run worker
startProbeServer();
startHeartbeat();
startWorker();
export {};
