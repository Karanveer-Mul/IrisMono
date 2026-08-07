import { Request, Response, Router } from "express";
import { authenticateWorker } from "../middleware/auth";
import { recordHeartbeat } from "../observability/fleet";

const router = Router();

/**
 * Worker heartbeat
 * POST /api/workers/heartbeat
 *
 * Authenticated by the same shared secret as a job report, and for the same
 * reason: the worker is not a user, holds no organization context, and holds no
 * database credentials. It proves it is a worker; the API decides what that
 * permits and does the writing.
 */
router.post("/heartbeat", authenticateWorker, async (req: Request, res: Response) => {
  const { workerId, modelVersion, queues, status, currentJobId, jobsProcessed, jobsFailed, startedAt } =
    req.body ?? {};

  if (typeof workerId !== "string" || workerId.trim() === "") {
    return res.status(400).json({ error: "workerId is required" });
  }

  if (status !== "IDLE" && status !== "BUSY") {
    return res.status(400).json({ error: "status must be IDLE or BUSY" });
  }

  // startedAt comes from the worker's own clock. It is stored as reported and
  // only ever used to display uptime; every staleness decision is made from
  // last_seen_at, which the database stamps, so a worker with a wrong clock
  // cannot make itself look alive.
  const started = typeof startedAt === "string" ? new Date(startedAt) : null;

  try {
    await recordHeartbeat({
      workerId: workerId.trim().slice(0, 100),
      modelVersion: typeof modelVersion === "string" ? modelVersion.slice(0, 100) : null,
      queues: typeof queues === "string" ? queues.slice(0, 255) : "",
      status,
      currentJobId: typeof currentJobId === "string" ? currentJobId : null,
      jobsProcessed: Number.isFinite(jobsProcessed) ? Number(jobsProcessed) : 0,
      jobsFailed: Number.isFinite(jobsFailed) ? Number(jobsFailed) : 0,
      startedAt: started && !Number.isNaN(started.getTime()) ? started : new Date(),
    });

    return res.status(204).end();
  } catch (error) {
    console.error(`Failed to record heartbeat for worker ${workerId}:`, error);
    return res.status(500).json({ error: "Failed to record heartbeat" });
  }
});

export default router;
