import { BUCKETS, Counter, Gauge, Histogram, Registry, registerRuntimeMetrics } from "./metrics";

/**
 * The worker process's own registry.
 *
 * Separate from the API's, because they are separate processes with separate
 * lifecycles - a worker scaled to zero should have its series disappear, not be
 * merged into an API instance's. Prometheus scrapes each worker directly on its
 * probe port; the heartbeat to the API is for fleet inventory, not metrics.
 */
export const workerRegistry = new Registry();

registerRuntimeMetrics(workerRegistry, "worker");

export const messagesConsumed = workerRegistry.register(
  new Counter("worker_messages_consumed_total", "Queue messages taken off a queue.", ["queue"])
);

export const jobsFinished = workerRegistry.register(
  new Counter("worker_jobs_finished_total", "Jobs this worker carried to an outcome.", ["outcome"])
);

export const modelDuration = workerRegistry.register(
  new Histogram(
    "worker_model_seconds",
    "Time spent inside the model, excluding queue and reporting.",
    BUCKETS.gpu,
    ["outcome"]
  )
);

export const reportFailures = workerRegistry.register(
  new Counter(
    "worker_report_failures_total",
    "Failed attempts to report an outcome to the API, by HTTP status. 'unreachable' means no response at all.",
    ["status"]
  )
);

export const deadLettered = workerRegistry.register(
  new Counter(
    "worker_dead_lettered_total",
    "Messages this worker could not establish an outcome for. Every one is a paid-for job that stalled.",
    []
  )
);

export const retriesScheduled = workerRegistry.register(
  new Counter(
    "worker_retries_scheduled_total",
    "Messages parked in a delay queue for redelivery, by attempt number. A rising tail means a dependency is down long enough to matter.",
    ["attempt"]
  )
);

export const busy = workerRegistry.register(
  new Gauge("worker_busy", "1 while a job is being processed, 0 while idle.", [])
);
