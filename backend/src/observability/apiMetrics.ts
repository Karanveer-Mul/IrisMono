import { BUCKETS, Counter, Gauge, Histogram, Registry, registerRuntimeMetrics } from "./metrics";

/**
 * The API process's metric definitions.
 *
 * Kept free of imports from the rest of the application so that any module can
 * record a measurement without creating an import cycle. Everything that has to
 * *read* from another subsystem - pool counters, queue depth, the worker fleet -
 * is wired up as a scrape-time collector in ./collectors.ts instead.
 */
export const registry = new Registry();

registerRuntimeMetrics(registry, "api");

/* ---------------------------------------------------------------- *
 * HTTP
 * ---------------------------------------------------------------- */

export const httpRequests = registry.register(
  new Counter("http_requests_total", "HTTP requests handled, by outcome.", [
    "method",
    "route",
    "status",
  ])
);

export const httpDuration = registry.register(
  new Histogram(
    "http_request_duration_seconds",
    "Time from request received to response finished.",
    BUCKETS.http,
    ["method", "route"]
  )
);

export const httpInFlight = registry.register(
  new Gauge("http_requests_in_flight", "Requests currently being handled.")
);

/* ---------------------------------------------------------------- *
 * Job lifecycle
 *
 * These are the business-level signals. A rise in job_failures_total or in
 * queue wait is what an operator is paged for; the HTTP metrics only say the
 * API is answering.
 * ---------------------------------------------------------------- */

export const jobReports = registry.register(
  new Counter("job_reports_total", "Job outcome reports accepted from workers.", ["status"])
);

export const jobReportsRejected = registry.register(
  new Counter(
    "job_reports_rejected_total",
    "Worker reports refused by the API, by reason.",
    ["reason"]
  )
);

export const jobQueueWait = registry.register(
  new Histogram(
    "job_queue_wait_seconds",
    "Time from credit reservation to a worker claiming the job. The autoscaling signal.",
    BUCKETS.queueWait,
    ["tier"]
  )
);

export const jobDuration = registry.register(
  new Histogram(
    "job_duration_seconds",
    "Time from worker claim to terminal state.",
    BUCKETS.gpu,
    ["status"]
  )
);

export const jobGpuSeconds = registry.register(
  new Histogram(
    "job_gpu_seconds",
    "GPU time reported by the worker. Cost attribution, not latency.",
    BUCKETS.gpu,
    ["status"]
  )
);

export const jobsReaped = registry.register(
  new Counter(
    "jobs_reaped_total",
    "Jobs expired by the reaper because they would never finish.",
    ["from_status"]
  )
);

/* ---------------------------------------------------------------- *
 * Credits
 *
 * A refund spike means the model is failing; the ledger records it either way,
 * but nobody watches a table.
 * ---------------------------------------------------------------- */

export const creditMovements = registry.register(
  new Counter("credit_movements_total", "Credit ledger entries written, by reason.", ["reason"])
);

/* ---------------------------------------------------------------- *
 * Sampled at scrape time - see ./collectors.ts for the sources.
 * ---------------------------------------------------------------- */

export const dependencyUp = registry.register(
  new Gauge(
    "irismono_dependency_up",
    "1 when a dependency answered its health probe, 0 when it did not.",
    ["dependency"]
  )
);

export const dependencyCheckDuration = registry.register(
  new Gauge(
    "irismono_dependency_check_seconds",
    "How long the last health probe of this dependency took.",
    ["dependency"]
  )
);

export const dbPoolConnections = registry.register(
  new Gauge(
    "db_pool_connections",
    "node-postgres pool occupancy. 'waiting' above zero means the pool is the bottleneck.",
    ["pool", "state"]
  )
);

export const queueMessages = registry.register(
  new Gauge("queue_messages_ready", "Messages waiting in a queue. Scale workers on this.", [
    "queue",
  ])
);

export const queueConsumers = registry.register(
  new Gauge("queue_consumers", "Consumers attached to a queue. Zero with depth above zero is an outage.", [
    "queue",
  ])
);

export const sseConnections = registry.register(
  new Gauge("sse_connections", "Browser event streams attached to this instance.")
);

export const workerUp = registry.register(
  new Gauge(
    "irismono_worker_up",
    "1 for a worker that has heartbeated inside the liveness window, 0 for one that has not.",
    ["worker_id", "model_version", "queues"]
  )
);

export const workerSecondsSinceHeartbeat = registry.register(
  new Gauge(
    "irismono_worker_seconds_since_heartbeat",
    "Age of a worker's last heartbeat.",
    ["worker_id"]
  )
);

export const workerJobsProcessed = registry.register(
  new Gauge(
    "irismono_worker_jobs_processed",
    "Jobs a worker has finished since it started. Flat across scrapes with queue depth means a stuck worker.",
    ["worker_id"]
  )
);
