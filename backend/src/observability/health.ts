import { authPool, pool } from "../db";
import { probeBroker } from "./queueStats";

/**
 * Dependency probes behind the readiness endpoint.
 *
 * Liveness and readiness answer different questions and must not share an
 * implementation. Liveness is "is this process still a process" - if it fails,
 * the supervisor restarts it. Readiness is "should traffic be sent here right
 * now", and it is the only one that is allowed to consult Postgres and
 * RabbitMQ. Wiring dependency checks into liveness is a well-known way to turn
 * a brief database blip into a rolling restart of every API instance, which
 * removes the capacity that would have absorbed the blip.
 */

/** A probe must not outlive the scrape or the probe interval that called it. */
const CHECK_TIMEOUT_MS = Number(process.env.HEALTH_CHECK_TIMEOUT_MS || 2000);

export interface CheckResult {
  name: string;
  ok: boolean;
  durationSeconds: number;
  error?: string;
}

/**
 * Bounds how long a probe blocks.
 *
 * The underlying query is not cancelled - node-postgres has no way to abort a
 * statement already sent - so this bounds the *answer*, not the work. That is
 * the right trade for a probe: a check that hangs as long as the database hangs
 * tells the orchestrator nothing, and slowly.
 */
async function runCheck(name: string, fn: () => Promise<unknown>): Promise<CheckResult> {
  const startedAt = process.hrtime.bigint();

  const elapsed = () => Number(process.hrtime.bigint() - startedAt) / 1e9;

  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`timed out after ${CHECK_TIMEOUT_MS}ms`)), CHECK_TIMEOUT_MS)
      ),
    ]);
    return { name, ok: true, durationSeconds: elapsed() };
  } catch (err: any) {
    return { name, ok: false, durationSeconds: elapsed(), error: err?.message || String(err) };
  }
}

/**
 * Both database identities are probed, not just one.
 *
 * They are separate roles with separate pools and separate grants. The app role
 * losing its grants while the system role keeps working is exactly the failure
 * a single probe would miss, and it presents as every tenant query returning
 * nothing - which looks like empty data, not an outage.
 */
export async function checkDependencies(): Promise<CheckResult[]> {
  return Promise.all([
    runCheck("postgres_app", () => pool.query("SELECT 1")),
    runCheck("postgres_auth", () => authPool.query("SELECT 1")),
    runCheck("rabbitmq", () => probeBroker()),
  ]);
}
