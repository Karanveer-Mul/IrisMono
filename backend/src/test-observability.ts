/**
 * Operational surface test.
 *
 * The point of this suite is that the signals are real. A health endpoint that
 * returns 200 unconditionally, a gauge that never moves, or a fleet view that
 * reports a machine as online after it has stopped are all worse than having
 * nothing: they are trusted during an incident. Each check below therefore
 * changes something and then asserts the metric or endpoint noticed.
 *
 * Requires the API to be running. The worker is optional - the fleet checks
 * synthesise a heartbeat rather than waiting for one, so the suite does not
 * depend on a GPU worker being up.
 *
 *   npx tsx src/test-observability.ts
 */
import express from "express";
import { AddressInfo } from "net";
import { sql } from "drizzle-orm";
import { systemDb, pool, authPool, adminPool } from "./db";
import opsRouter, { beginDraining } from "./routes/ops";
import { closeQueue, initQueue } from "./queue";

const BASE = "http://localhost:3000";
const API = `${BASE}/api`;
const WORKER_SECRET = process.env.WORKER_SECRET || "local-dev-worker-secret";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

async function scrape(): Promise<string> {
  const r = await fetch(`${BASE}/metrics`);
  assert(r.ok, `/metrics returned ${r.status}`);
  return r.text();
}

/**
 * Reads one sample out of the exposition text.
 *
 * Matches on the metric name plus a label substring, which is enough to find a
 * specific series without reimplementing a parser.
 */
function sampleValue(body: string, metric: string, labelMatch = ""): number | null {
  for (const line of body.split("\n")) {
    if (line.startsWith("#") || !line.startsWith(metric)) continue;
    const [series, value] = line.split(/\s+/);
    if (!series.startsWith(metric)) continue;
    // Guard against http_requests_total matching http_requests_total_foo.
    const after = series.slice(metric.length);
    if (after !== "" && !after.startsWith("{")) continue;
    if (labelMatch && !series.includes(labelMatch)) continue;
    return Number(value);
  }
  return null;
}

function hasMetric(body: string, metric: string): boolean {
  return body.includes(`# TYPE ${metric} `);
}

async function register(email: string, orgName: string) {
  const r = await fetch(`${API}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "secure_password_123", orgName }),
  });
  if (!r.ok) throw new Error(`register failed: ${await r.text()}`);
  const { token } = await r.json();
  return token as string;
}

async function heartbeat(body: Record<string, unknown>, secret = WORKER_SECRET) {
  const r = await fetch(`${API}/workers/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-worker-secret": secret },
    body: JSON.stringify(body),
  });
  return r.status;
}

async function run() {
  console.log("=== OPERATIONAL SURFACE TEST ===\n");

  const stamp = Date.now();

  console.log("1. Liveness answers without touching a dependency");
  const alive = await fetch(`${BASE}/health`);
  const aliveBody = await alive.json();
  console.log(`-> ${alive.status} ${aliveBody.status}, up ${aliveBody.uptimeSeconds}s`);
  assert(alive.status === 200, "liveness did not return 200");
  assert(aliveBody.status === "alive", "liveness did not report alive");
  assert(typeof aliveBody.uptimeSeconds === "number", "liveness reports no uptime");

  console.log("\n2. Readiness names each dependency and reports it individually");
  const ready = await fetch(`${BASE}/health/ready`);
  const readyBody = await ready.json();
  const names = readyBody.checks.map((c: any) => `${c.name}=${c.ok ? "ok" : "down"}`);
  console.log(`-> ${ready.status} ${readyBody.status}: ${names.join(", ")}`);
  assert(ready.status === 200, `readiness returned ${ready.status}; a dependency is down`);
  for (const expected of ["postgres_app", "postgres_auth", "rabbitmq"]) {
    const check = readyBody.checks.find((c: any) => c.name === expected);
    assert(!!check, `readiness does not probe ${expected}`);
    assert(check.ok === true, `${expected} reported down`);
    assert(typeof check.durationMs === "number", `${expected} reports no duration`);
  }

  console.log("\n3. Readiness probes the app role separately from the system role");
  // The two identities have different grants. A single probe would miss the app
  // role losing access, which presents as empty tenant reads, not as an outage.
  assert(
    readyBody.checks.filter((c: any) => c.name.startsWith("postgres_")).length === 2,
    "only one database identity is probed"
  );

  console.log("\n4. The scrape exposes the series an operator would page on");
  const body = await scrape();
  for (const metric of [
    "http_requests_total",
    "http_request_duration_seconds",
    "job_reports_total",
    "job_queue_wait_seconds",
    "credit_movements_total",
    "queue_messages_ready",
    "queue_consumers",
    "db_pool_connections",
    "sse_connections",
    "irismono_dependency_up",
    "nodejs_eventloop_lag_seconds",
    "process_resident_memory_bytes",
  ]) {
    assert(hasMetric(body, metric), `${metric} is not exposed`);
  }
  console.log(`-> ${body.split("\n").filter((l) => l.startsWith("# TYPE")).length} metric families`);

  console.log("\n5. Request counting is real, and labelled by route pattern not URL");
  const before = sampleValue(body, "http_requests_total", 'route="/api/auth/register"') ?? 0;
  await register(`ops.${stamp}@alpha-health.org`, `Ops Hospital ${stamp}`);
  const after = sampleValue(await scrape(), "http_requests_total", 'route="/api/auth/register"') ?? 0;
  console.log(`-> /api/auth/register: ${before} then ${after}`);
  assert(after > before, "a handled request did not increment the counter");

  console.log("\n6. A job id never becomes a label value");
  // This is the failure that takes down a metrics backend rather than the
  // service: one series per job, forever.
  const token = await register(`ops.card.${stamp}@alpha-health.org`, `Cardinality ${stamp}`);
  const reserved = await fetch(`${API}/jobs/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  });
  const { jobId } = await reserved.json();
  await fetch(`${API}/jobs/${jobId}/image/mask`, { headers: { Authorization: `Bearer ${token}` } });
  const cardinalityBody = await scrape();
  assert(!cardinalityBody.includes(jobId), "a job id leaked into a metric label");
  assert(
    cardinalityBody.includes('route="/api/jobs/:jobId/image/:kind"'),
    "the parameterised route was not recorded as a pattern"
  );

  console.log("\n7. Dependency health is exported as a metric, not only as an endpoint");
  const depBody = await scrape();
  for (const dependency of ["postgres_app", "postgres_auth", "rabbitmq"]) {
    const up = sampleValue(depBody, "irismono_dependency_up", `dependency="${dependency}"`);
    console.log(`-> ${dependency} up=${up}`);
    assert(up === 1, `${dependency} is not reported up in the scrape`);
  }

  console.log("\n8. Queue depth and consumer count are sampled from the broker");
  const queueSample = sampleValue(depBody, "queue_messages_ready", 'queue="queue-standard-jobs"');
  const dlqSample = sampleValue(depBody, "queue_messages_ready", 'queue="queue-standard-jobs.dlq"');
  console.log(`-> standard queue depth ${queueSample}, dead-letter depth ${dlqSample}`);
  assert(queueSample !== null, "the work queue is not sampled");
  assert(dlqSample !== null, "the dead-letter queue is not sampled - a stalled job would be invisible");

  console.log("\n9. The request id is generated, returned, and honoured when supplied");
  const generated = await fetch(`${BASE}/health`);
  assert(!!generated.headers.get("x-request-id"), "no correlation id was returned");
  const supplied = await fetch(`${BASE}/health`, { headers: { "x-request-id": `trace-${stamp}` } });
  console.log(`-> echoed ${supplied.headers.get("x-request-id")}`);
  assert(
    supplied.headers.get("x-request-id") === `trace-${stamp}`,
    "an upstream correlation id was discarded"
  );

  console.log("\n10. A heartbeat needs the worker secret");
  const unauthorized = await heartbeat({ workerId: "x", queues: "q", status: "IDLE" }, "wrong");
  console.log(`-> without the secret: ${unauthorized}`);
  assert(unauthorized === 401, "the heartbeat endpoint accepted an unauthenticated caller");

  console.log("\n11. A heartbeat makes a worker visible to every API instance");
  const workerId = `test-worker-${stamp}`;
  const accepted = await heartbeat({
    workerId,
    modelVersion: "irismono-seg-test-9.9.9",
    queues: "queue-standard-jobs",
    status: "BUSY",
    currentJobId: null,
    jobsProcessed: 7,
    jobsFailed: 1,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  assert(accepted === 204, `heartbeat returned ${accepted}`);

  const fleet = await (await fetch(`${BASE}/health/workers`)).json();
  const seen = fleet.workers.find((w: any) => w.workerId === workerId);
  console.log(`-> ${fleet.onlineCount}/${fleet.knownCount} online; ${workerId} online=${seen?.online}`);
  assert(!!seen, "the heartbeat did not appear in the fleet view");
  assert(seen.online === true, "a worker that just reported is not counted as online");
  assert(seen.modelVersion === "irismono-seg-test-9.9.9", "the model version was not recorded");
  assert(seen.jobsProcessed === 7, "the job count was not recorded");

  const fleetBody = await scrape();
  assert(
    sampleValue(fleetBody, "irismono_worker_up", `worker_id="${workerId}"`) === 1,
    "the worker is not exported as up"
  );

  console.log("\n12. A worker that stops reporting is marked offline, not forgotten silently");
  // Aged directly in the database: waiting out the staleness window would make
  // this suite take a minute to prove one boolean.
  await systemDb.execute(sql`
    UPDATE worker_heartbeats
       SET last_seen_at = NOW() - INTERVAL '10 minutes'
     WHERE worker_id = ${workerId}
  `);

  const stale = await (await fetch(`${BASE}/health/workers`)).json();
  const staleWorker = stale.workers.find((w: any) => w.workerId === workerId);
  console.log(`-> online=${staleWorker.online} after ${staleWorker.secondsSinceHeartbeat}s of silence`);
  assert(staleWorker.online === false, "a silent worker is still reported as online");
  assert(staleWorker.secondsSinceHeartbeat >= 600, "the heartbeat age is wrong");
  assert(
    sampleValue(await scrape(), "irismono_worker_up", `worker_id="${workerId}"`) === 0,
    "the stale worker is still exported as up"
  );

  console.log("\n13. Restarting a worker replaces its record rather than duplicating it");
  await heartbeat({
    workerId,
    modelVersion: "irismono-seg-test-9.9.9",
    queues: "queue-standard-jobs",
    status: "IDLE",
    jobsProcessed: 0,
    startedAt: new Date().toISOString(),
  });
  const afterRestart = await (await fetch(`${BASE}/health/workers`)).json();
  const rows = afterRestart.workers.filter((w: any) => w.workerId === workerId);
  console.log(`-> ${rows.length} row for ${workerId}, jobsProcessed reset to ${rows[0].jobsProcessed}`);
  assert(rows.length === 1, "a restarted worker produced a second row");
  assert(rows[0].jobsProcessed === 0, "counters did not reset with the process");

  console.log("\n14. Fleet health is not readiness");
  // An API with no workers can still authenticate, serve completed masks, and
  // accept jobs. Failing readiness would remove the part that still works.
  await systemDb.execute(sql`
    UPDATE worker_heartbeats SET last_seen_at = NOW() - INTERVAL '1 hour'
  `);
  const readyWithoutWorkers = await fetch(`${BASE}/health/ready`);
  const fleetWithoutWorkers = await (await fetch(`${BASE}/health/workers`)).json();
  console.log(
    `-> readiness ${readyWithoutWorkers.status}, fleet reports ${fleetWithoutWorkers.status} ` +
    `(${fleetWithoutWorkers.onlineCount} online)`
  );
  assert(readyWithoutWorkers.status === 200, "an empty fleet took the API out of rotation");
  // A real worker running alongside this suite will have heartbeated again by
  // now, which is correct behaviour and not a failure of the assertion above.
  if (fleetWithoutWorkers.onlineCount === 0) {
    assert(fleetWithoutWorkers.status === "no_workers", "the fleet endpoint hid an empty fleet");
  }

  console.log("\n15. Draining fails readiness while liveness still passes");
  // Exercised in-process rather than by signalling the running API: Windows has
  // no real SIGTERM, so Node terminates the target unconditionally and the
  // handler never runs. What is asserted here is the part that matters and is
  // portable - that entering the draining state flips readiness and leaves
  // liveness alone, so a load balancer withdraws the instance and a supervisor
  // does not restart it. Signal delivery itself is a platform behaviour.
  // This process has its own pools and its own broker connection, and readiness
  // consults all three - so the broker has to be connected here for the "ready"
  // baseline to mean anything.
  await initQueue();

  const probe = express();
  probe.use(opsRouter);
  const probeServer = probe.listen(0);
  await new Promise((resolve) => probeServer.once("listening", resolve));
  const probePort = (probeServer.address() as AddressInfo).port;

  const readyBefore = await fetch(`http://localhost:${probePort}/health/ready`);
  beginDraining();
  const readyAfter = await fetch(`http://localhost:${probePort}/health/ready`);
  const drainBody = await readyAfter.json();
  const liveDuring = await fetch(`http://localhost:${probePort}/health`);
  probeServer.close();
  await closeQueue();

  console.log(
    `-> readiness ${readyBefore.status} then ${readyAfter.status} (${drainBody.status}); ` +
    `liveness ${liveDuring.status}`
  );
  assert(readyBefore.status === 200, "the probe instance was not ready to begin with");
  assert(readyAfter.status === 503, "a draining instance still reported ready");
  assert(drainBody.status === "draining", "draining was not distinguished from a dependency failure");
  assert(liveDuring.status === 200, "draining failed liveness, which would cause a restart");

  console.log("\n=== OPERATIONAL SURFACE VERIFIED ===");
  console.log("Dependencies probed individually, business signals exported, fleet visible,");
  console.log("cardinality bounded, and requests correlated end to end.");

  // Leave no synthetic worker behind for the next run to find.
  await systemDb.execute(sql`DELETE FROM worker_heartbeats WHERE worker_id = ${workerId}`);
}

run()
  .then(async () => {
    await Promise.all([pool.end(), authPool.end(), adminPool.end()]);
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nOBSERVABILITY TEST FAILED:", e.message);
    await Promise.all([pool.end(), authPool.end(), adminPool.end()]).catch(() => {});
    process.exit(1);
  });
