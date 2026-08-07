import { timingSafeEqual } from "crypto";
import { Request, Response, Router } from "express";
import { CONTENT_TYPE } from "../observability/metrics";
import { registry } from "../observability/apiMetrics";
import { checkDependencies } from "../observability/health";
import { listWorkers, WORKER_STALE_AFTER_SECONDS } from "../observability/fleet";

const router = Router();

const START_TIME = Date.now();

/** Set when shutdown begins. Fails readiness while liveness still passes. */
let draining = false;

export function beginDraining() {
  draining = true;
}

/**
 * Optional bearer token for the operational endpoints.
 *
 * Metrics and the fleet view describe internal topology: how many instances are
 * running, which model builds are deployed, how much capacity is idle, and how
 * far behind the queue is. That is reconnaissance material, and it is why
 * exporters are normally reachable only from the monitoring network. Where the
 * scrape crosses a network you do not control, set METRICS_TOKEN.
 *
 * Left unset, the endpoints are open and the process says so once at startup -
 * a silent default that looks secure and is not is worse than a loud one.
 */
const METRICS_TOKEN = process.env.METRICS_TOKEN || "";

function presentedToken(req: Request): string {
  const header = req.headers["x-metrics-token"];
  if (typeof header === "string") return header;

  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);

  return "";
}

/** Constant-time comparison, so the token cannot be recovered byte by byte. */
function tokenMatches(presented: string): boolean {
  const expected = Buffer.from(METRICS_TOKEN);
  const actual = Buffer.from(presented);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export function isOperator(req: Request): boolean {
  if (!METRICS_TOKEN) return true;
  return tokenMatches(presentedToken(req));
}

function requireOperator(req: Request, res: Response): boolean {
  if (isOperator(req)) return true;
  res.status(401).json({ error: "Operational endpoints require a metrics token" });
  return false;
}

export function warnIfMetricsUnprotected() {
  if (!METRICS_TOKEN) {
    console.warn(
      "[ops] METRICS_TOKEN is not set: /metrics and /health/workers are unauthenticated. " +
      "Acceptable when the port is only reachable from the monitoring network; set the token otherwise."
    );
  }
}

/**
 * Liveness.
 *
 * Answers one question: is this process still able to run a handler. It must
 * never consult Postgres or RabbitMQ - a failing liveness probe gets the
 * container killed, and killing every API instance because the database blinked
 * turns a recoverable dependency failure into a total outage with no capacity
 * left to recover into.
 */
router.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "alive",
    uptimeSeconds: Math.floor((Date.now() - START_TIME) / 1000),
    timestamp: new Date().toISOString(),
  });
});

/**
 * Readiness.
 *
 * Answers whether this instance should receive traffic right now, which does
 * depend on Postgres and RabbitMQ. 503 takes the instance out of the load
 * balancer without restarting it, so it can rejoin when the dependency returns.
 *
 * The worker fleet is deliberately not part of this. An API with no workers can
 * still authenticate users, serve completed masks, and accept new jobs into the
 * queue; refusing traffic would remove the only thing still working. Fleet
 * health is a separate endpoint and a separate alert.
 */
router.get("/health/ready", async (req: Request, res: Response) => {
  // A draining instance fails readiness before it stops accepting connections,
  // so the load balancer has time to take it out of rotation. Without this
  // window, shutdown races the balancer's next health check and some requests
  // are routed to a socket that is already closing.
  if (draining) {
    return res.status(503).json({
      status: "draining",
      checks: [],
      timestamp: new Date().toISOString(),
    });
  }

  const checks = await checkDependencies();
  const ready = checks.every((check) => check.ok);

  // Error strings name hosts, roles, and ports. Operators see them; anyone else
  // gets the dependency name and its state.
  const detailed = isOperator(req);

  res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not_ready",
    checks: checks.map((check) => ({
      name: check.name,
      ok: check.ok,
      durationMs: Math.round(check.durationSeconds * 1000),
      ...(detailed && check.error ? { error: check.error } : {}),
    })),
    timestamp: new Date().toISOString(),
  });
});

/**
 * Fleet view.
 *
 * The GPU tier's health, which the API can only know from heartbeats. Reported
 * as 200 with a degraded body rather than a failure status: this endpoint
 * describes something other than the process answering it, and an orchestrator
 * probing it must not conclude that this API instance is unhealthy.
 */
router.get("/health/workers", async (req: Request, res: Response) => {
  if (!requireOperator(req, res)) return;

  try {
    const workers = await listWorkers();
    const online = workers.filter((worker) => worker.online);

    res.status(200).json({
      status: online.length > 0 ? "ok" : "no_workers",
      staleAfterSeconds: WORKER_STALE_AFTER_SECONDS,
      onlineCount: online.length,
      knownCount: workers.length,
      workers: workers.map((worker) => ({
        workerId: worker.workerId,
        online: worker.online,
        status: worker.status,
        modelVersion: worker.modelVersion,
        queues: worker.queues,
        currentJobId: worker.currentJobId,
        jobsProcessed: worker.jobsProcessed,
        jobsFailed: worker.jobsFailed,
        uptimeSeconds: Math.floor((Date.now() - worker.startedAt.getTime()) / 1000),
        secondsSinceHeartbeat: Math.round(worker.secondsSinceHeartbeat),
      })),
    });
  } catch (error) {
    console.error("Failed to read worker fleet:", error);
    res.status(500).json({ error: "Failed to read worker fleet" });
  }
});

/** Prometheus scrape endpoint. */
router.get("/metrics", async (req: Request, res: Response) => {
  if (!requireOperator(req, res)) return;

  try {
    const body = await registry.render();
    res.setHeader("Content-Type", CONTENT_TYPE);
    res.status(200).send(body);
  } catch (error) {
    console.error("Failed to render metrics:", error);
    res.status(500).send("# metrics rendering failed\n");
  }
});

export default router;
