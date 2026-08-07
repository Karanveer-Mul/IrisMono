import express from "express";
import * as dotenv from "dotenv";
import authRouter from "./routes/auth";
import jobsRouter from "./routes/jobs";
import invitesRouter from "./routes/invites";
import creditsRouter from "./routes/credits";
import workersRouter from "./routes/workers";
import auditRouter from "./routes/audit";
import opsRouter, { beginDraining, warnIfMetricsUnprotected } from "./routes/ops";
import { closeQueue, initQueue } from "./queue";
import { initSseBus } from "./sse/bus";
import { startReaper } from "./reaper";
import { startRetentionSweeper } from "./retention";
import { registerCollectors } from "./observability/collectors";
import { observeRequests } from "./observability/http";
import { logger } from "./observability/logger";
import { adminPool, authPool, pool } from "./db";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * How long to keep serving after SIGTERM before closing the listener.
 *
 * Zero is right for local development, where the next thing to happen is a
 * restart. In an orchestrator it must be longer than the load balancer's
 * health-check interval: the pod is removed from the endpoint list and sent
 * SIGTERM at the same moment, and traffic keeps arriving until the balancer
 * notices. Closing immediately turns a routine deploy into dropped requests.
 */
const SHUTDOWN_DRAIN_MS = Number(process.env.SHUTDOWN_DRAIN_MS || 0);

/** Backstop: a connection that will not close must not block the deploy. */
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS || 15000);

// Correlation id and request metrics, mounted before the body parser so a
// request that dies during parsing is still recorded.
app.use(observeRequests);

// Middleware for parsing JSON requests
app.use(express.json());

// Operational endpoints: /health, /health/ready, /health/workers, /metrics.
// Mounted at the root rather than under /api because probes and scrapers
// address the process, not the product API.
app.use(opsRouter);

// Mount routers
app.use("/api/auth", authRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/invites", invitesRouter);
app.use("/api/credits", creditsRouter);
app.use("/api/workers", workersRouter);
app.use("/api/audit", auditRouter);

// Initialize services and start server
async function startServer() {
  logger.info("Starting backend server...");

  // Initialize RabbitMQ connection
  await initQueue();

  // Subscribe to the cross-instance SSE fan-out, so events published by any
  // API instance reach the clients connected to this one.
  await initSseBus();

  // Background maintenance: reclaim credits from jobs that will never finish,
  // and expire stored images past the retention window.
  startReaper();
  startRetentionSweeper();

  // Sample pool occupancy, queue depth, dependency health, and the worker fleet
  // at scrape time.
  registerCollectors();
  warnIfMetricsUnprotected();

  const server = app.listen(PORT, () => {
    logger.info(`Backend server running on http://localhost:${PORT}`);
  });

  installShutdownHandlers(server);
}

/**
 * Ordered shutdown.
 *
 * The order matters and is the whole point: fail readiness, let the balancer
 * notice, stop accepting, let in-flight requests finish, then release the
 * broker and the database. Reversing any two of those drops work that had
 * already been accepted - and in this system an accepted request has usually
 * already reserved a credit.
 */
function installShutdownHandlers(server: import("http").Server) {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info(`Received ${signal}; draining.`, { drainMs: SHUTDOWN_DRAIN_MS });
    beginDraining();

    const forceExit = setTimeout(() => {
      logger.error("Shutdown timed out; exiting anyway.");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    if (SHUTDOWN_DRAIN_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS));
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
    logger.info("HTTP listener closed.");

    await closeQueue();
    await Promise.allSettled([pool.end(), authPool.end(), adminPool.end()]);
    logger.info("Shutdown complete.");

    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

startServer().catch((error) => {
  logger.error("Fatal startup error", { error: String(error) });
  process.exit(1);
});
