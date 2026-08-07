import { adminPool, authPool, pool } from "../db";
import { sseHub } from "../sse";
import {
  dbPoolConnections,
  dependencyCheckDuration,
  dependencyUp,
  queueConsumers,
  queueMessages,
  registry,
  sseConnections,
  workerJobsProcessed,
  workerSecondsSinceHeartbeat,
  workerUp,
} from "./apiMetrics";
import { listWorkers } from "./fleet";
import { checkDependencies } from "./health";
import { sampleQueues } from "./queueStats";

/**
 * Scrape-time sampling.
 *
 * Everything here is read from somewhere else in the process (or from the
 * database) at the moment Prometheus asks, rather than pushed on every change.
 * The hot paths - reserving a credit, dispatching a job, writing an SSE frame -
 * stay free of instrumentation they would otherwise pay for on every call.
 *
 * Each collector is registered separately so one failing source leaves the rest
 * of the scrape intact; the registry already isolates them.
 */
export function registerCollectors() {
  registry.addCollector(() => {
    // waiting > 0 is the one to watch: requests are queued behind connections,
    // and it presents as uniform latency across unrelated endpoints.
    for (const [name, p] of [
      ["app", pool],
      ["auth", authPool],
      ["admin", adminPool],
    ] as const) {
      dbPoolConnections.set({ pool: name, state: "total" }, p.totalCount);
      dbPoolConnections.set({ pool: name, state: "idle" }, p.idleCount);
      dbPoolConnections.set({ pool: name, state: "waiting" }, p.waitingCount);
    }

    sseConnections.set({}, sseHub.localConnectionCount());
  });

  registry.addCollector(async () => {
    const samples = await sampleQueues();

    // Reset first: a queue that disappeared must stop reporting its last known
    // depth, which would otherwise look like a permanent backlog.
    queueMessages.reset();
    queueConsumers.reset();

    for (const sample of samples) {
      queueMessages.set({ queue: sample.queue }, sample.messages);
      queueConsumers.set({ queue: sample.queue }, sample.consumers);
    }
  });

  registry.addCollector(async () => {
    for (const check of await checkDependencies()) {
      dependencyUp.set({ dependency: check.name }, check.ok ? 1 : 0);
      dependencyCheckDuration.set({ dependency: check.name }, check.durationSeconds);
    }
  });

  registry.addCollector(async () => {
    const workers = await listWorkers();

    // Reset so a worker whose row was pruned stops being reported as down
    // forever. Pruning is what closes the alert, not the gauge.
    workerUp.reset();
    workerSecondsSinceHeartbeat.reset();
    workerJobsProcessed.reset();

    for (const worker of workers) {
      workerUp.set(
        {
          worker_id: worker.workerId,
          model_version: worker.modelVersion ?? "unknown",
          queues: worker.queues.join(","),
        },
        worker.online ? 1 : 0
      );
      workerSecondsSinceHeartbeat.set({ worker_id: worker.workerId }, worker.secondsSinceHeartbeat);
      workerJobsProcessed.set({ worker_id: worker.workerId }, worker.jobsProcessed);
    }
  });
}
