import { sql } from "drizzle-orm";
import { systemDb } from "../db";

/**
 * The worker fleet, as seen by the API.
 *
 * Workers report in rather than being polled, because nothing knows in advance
 * where they are: they scale with GPU demand, they have no stable addresses,
 * and they hold no database credentials of their own. The heartbeat goes to the
 * API under the same shared secret as a job report, and the API writes it.
 *
 * The record is in Postgres and not in process memory for the same reason the
 * SSE event log is: with more than one API instance behind a load balancer, a
 * heartbeat lands on whichever instance the balancer picked, and an in-memory
 * fleet view would then differ per instance and be wrong on all of them.
 */

/**
 * How long after its last beat a worker is treated as gone.
 *
 * Set independently of the worker's own interval on purpose - the API cannot
 * know how often a given worker was configured to report, and a window derived
 * from the API's own configuration is one the operator can reason about. The
 * default is three missed beats at the default interval.
 */
export const WORKER_STALE_AFTER_SECONDS = Number(process.env.WORKER_STALE_AFTER_SECONDS || 45);

/**
 * When a worker's record is deleted outright.
 *
 * A scaled-down worker is not an incident, and a permanently offline row would
 * hold an alert open forever. Long enough that a crash-looping worker is still
 * visible the next morning.
 */
export const WORKER_FORGET_AFTER_HOURS = Number(process.env.WORKER_FORGET_AFTER_HOURS || 24);

export interface HeartbeatInput {
  workerId: string;
  modelVersion?: string | null;
  queues: string;
  status: string;
  currentJobId?: string | null;
  jobsProcessed?: number;
  jobsFailed?: number;
  startedAt: Date;
}

export interface FleetMember {
  workerId: string;
  modelVersion: string | null;
  queues: string[];
  status: string;
  currentJobId: string | null;
  jobsProcessed: number;
  jobsFailed: number;
  startedAt: Date;
  lastSeenAt: Date;
  secondsSinceHeartbeat: number;
  online: boolean;
}

export async function recordHeartbeat(input: HeartbeatInput): Promise<void> {
  // Upsert on worker_id: a restarted worker with the same identity replaces its
  // own row rather than accumulating one per lifetime. started_at is overwritten
  // too, so uptime resets with the process.
  await systemDb.execute(sql`
    INSERT INTO worker_heartbeats (
      worker_id, model_version, queues, status, current_job_id,
      jobs_processed, jobs_failed, started_at, last_seen_at
    )
    VALUES (
      ${input.workerId},
      ${input.modelVersion ?? null},
      ${input.queues},
      ${input.status},
      ${input.currentJobId ?? null},
      ${input.jobsProcessed ?? 0},
      ${input.jobsFailed ?? 0},
      ${input.startedAt},
      NOW()
    )
    ON CONFLICT (worker_id) DO UPDATE SET
      model_version  = EXCLUDED.model_version,
      queues         = EXCLUDED.queues,
      status         = EXCLUDED.status,
      current_job_id = EXCLUDED.current_job_id,
      jobs_processed = EXCLUDED.jobs_processed,
      jobs_failed    = EXCLUDED.jobs_failed,
      started_at     = EXCLUDED.started_at,
      last_seen_at   = NOW()
  `);
}

export async function listWorkers(): Promise<FleetMember[]> {
  // Age is computed by the database, so a clock skewed on one API instance
  // cannot make a healthy worker look stale to that instance alone.
  const result = await systemDb.execute(sql`
    SELECT
      worker_id,
      model_version,
      queues,
      status,
      current_job_id,
      jobs_processed,
      jobs_failed,
      started_at,
      last_seen_at,
      EXTRACT(EPOCH FROM (NOW() - last_seen_at)) AS seconds_since_heartbeat
    FROM worker_heartbeats
    ORDER BY worker_id
  `);

  return result.rows.map((row: any) => {
    const secondsSinceHeartbeat = Number(row.seconds_since_heartbeat);
    return {
      workerId: row.worker_id,
      modelVersion: row.model_version,
      queues: String(row.queues).split(",").filter(Boolean),
      status: row.status,
      currentJobId: row.current_job_id,
      jobsProcessed: Number(row.jobs_processed),
      jobsFailed: Number(row.jobs_failed),
      startedAt: new Date(row.started_at),
      lastSeenAt: new Date(row.last_seen_at),
      secondsSinceHeartbeat,
      online: secondsSinceHeartbeat <= WORKER_STALE_AFTER_SECONDS,
    };
  });
}

/** Forgets workers that have been silent long enough to be gone for good. */
export async function pruneWorkers(hours: number): Promise<number> {
  const result = await systemDb.execute(sql`
    DELETE FROM worker_heartbeats WHERE last_seen_at < NOW() - ${`${hours} hours`}::interval
  `);
  return result.rowCount ?? 0;
}
