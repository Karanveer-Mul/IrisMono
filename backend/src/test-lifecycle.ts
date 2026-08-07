/**
 * Job lifecycle test: the reaper, dead-lettering, and tier-based routing.
 *
 * Covers the failure modes that leak credits or lose work silently:
 *   - a credit reserved and never dispatched (client closed the tab)
 *   - a worker that died mid-job
 *   - a message that cannot be processed at all
 *   - VIP-tier work landing on the VIP queue rather than vanishing
 *
 * Requires the API and worker to be running. Run with:
 *   npx tsx src/test-lifecycle.ts
 */
import * as amqp from "amqplib";
import { sql } from "drizzle-orm";
import { systemDb, pool, authPool, adminPool } from "./db";
import { reapStaleJobs } from "./reaper";
import { QUEUES, deadLetterQueueFor } from "./queue";

const API = "http://localhost:3000/api";
const AMQP_URL = process.env.AMQP_URL || "amqp://guest:guest@localhost:5672";
const WORKER_SECRET = process.env.WORKER_SECRET || "local-dev-worker-secret";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

async function register(email: string, orgName: string) {
  const r = await fetch(`${API}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "secure_password_123", orgName }),
  });
  if (!r.ok) throw new Error(`register failed: ${await r.text()}`);
  const { token } = await r.json();
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
  return { token, orgId: payload.organizationId as string };
}

async function reserveJob(token: string) {
  const r = await fetch(`${API}/jobs/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`job request failed: ${await r.text()}`);
  return (await r.json()).jobId as string;
}

async function balanceOf(orgId: string) {
  const r = await systemDb.execute(
    sql`SELECT credit_balance FROM organizations WHERE id = ${orgId}`
  );
  return Number((r.rows[0] as any).credit_balance);
}

async function jobRow(jobId: string) {
  const r = await systemDb.execute(
    sql`SELECT status, error_message FROM jobs WHERE id = ${jobId}`
  );
  return r.rows[0] as { status: string; error_message: string | null };
}

/** Ages a job so the reaper considers it stale, without waiting the real window. */
async function backdate(jobId: string, column: "created_at" | "started_at", hours: number) {
  await systemDb.execute(
    sql`UPDATE jobs SET ${sql.raw(column)} = NOW() - ${`${hours} hours`}::interval WHERE id = ${jobId}`
  );
}

async function run() {
  console.log("=== JOB LIFECYCLE TEST ===\n");

  const stamp = Date.now();
  const org = await register(`lifecycle.${stamp}@alpha-health.org`, `Lifecycle Hospital ${stamp}`);
  console.log(`Tenant ${org.orgId}, starting balance ${await balanceOf(org.orgId)}\n`);

  // ---------------------------------------------------------------
  console.log("1. Abandoned reservation: PENDING but never dispatched");
  const abandoned = await reserveJob(org.token);
  const afterReserve = await balanceOf(org.orgId);
  console.log(`-> reserved, balance ${afterReserve}`);
  assert(afterReserve === 2, "reservation did not deduct a credit");

  console.log("   reaper must ignore it while it is still fresh");
  await reapStaleJobs();
  assert((await jobRow(abandoned)).status === "PENDING", "reaper expired a fresh job");
  console.log("   -> still PENDING");

  await backdate(abandoned, "created_at", 2);
  const reapedA = await reapStaleJobs();
  const abandonedRow = await jobRow(abandoned);
  console.log(`   -> after ageing: ${reapedA} reaped, status ${abandonedRow.status}, balance ${await balanceOf(org.orgId)}`);
  assert(abandonedRow.status === "FAILED", "stale PENDING job was not expired");
  assert(await balanceOf(org.orgId) === 3, "credit was not refunded");
  assert((abandonedRow.error_message ?? "").includes("never dispatched"), "unexpected reason recorded");

  // ---------------------------------------------------------------
  console.log("\n2. Dead worker: PROCESSING with a stale start time");
  const stalled = await reserveJob(org.token);
  await systemDb.execute(
    sql`UPDATE jobs SET status = 'PROCESSING', started_at = NOW() WHERE id = ${stalled}`
  );

  await reapStaleJobs();
  assert((await jobRow(stalled)).status === "PROCESSING", "reaper expired an actively running job");
  console.log("   -> fresh PROCESSING job left alone");

  await backdate(stalled, "started_at", 2);
  await reapStaleJobs();
  const stalledRow = await jobRow(stalled);
  console.log(`   -> after ageing: status ${stalledRow.status}, balance ${await balanceOf(org.orgId)}`);
  assert(stalledRow.status === "FAILED", "stalled PROCESSING job was not expired");
  assert(await balanceOf(org.orgId) === 3, "credit was not refunded");
  assert((stalledRow.error_message ?? "").includes("timed out"), "unexpected reason recorded");

  console.log("\n3. Reaper does not double-refund on a second sweep");
  await reapStaleJobs();
  console.log(`   -> balance ${await balanceOf(org.orgId)}`);
  assert(await balanceOf(org.orgId) === 3, "a second sweep refunded again");

  // ---------------------------------------------------------------
  console.log("\n4. Unprocessable message is dead-lettered, not discarded");
  const conn = await amqp.connect(AMQP_URL);
  const ch = await conn.createChannel();

  const dlqName = deadLetterQueueFor(QUEUES.STANDARD);
  const before = (await ch.checkQueue(dlqName)).messageCount;

  ch.sendToQueue(QUEUES.STANDARD, Buffer.from(JSON.stringify({ nothing: "useful" })), {
    persistent: true,
  });

  let after = before;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    after = (await ch.checkQueue(dlqName)).messageCount;
    if (after > before) break;
  }
  console.log(`   -> ${dlqName}: ${before} -> ${after}`);
  assert(after === before + 1, "message was not dead-lettered");

  // ---------------------------------------------------------------
  console.log("\n5. VIP tenants route to the VIP queue");
  await systemDb.execute(
    sql`UPDATE organizations SET infrastructure_tier = 'VIP' WHERE id = ${org.orgId}`
  );

  const vipBefore = (await ch.checkQueue(QUEUES.VIP)).messageCount;
  const vipJob = await reserveJob(org.token);
  const trigger = await fetch(`${API}/jobs/${vipJob}/trigger`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${org.token}` },
  });
  const dispatched = await trigger.json();
  console.log(`   -> dispatched to ${dispatched.queue}`);
  assert(dispatched.queue === QUEUES.VIP, "VIP tenant was not routed to the VIP queue");

  await new Promise((r) => setTimeout(r, 500));
  const vipAfter = (await ch.checkQueue(QUEUES.VIP)).messageCount;
  console.log(`   -> ${QUEUES.VIP}: ${vipBefore} -> ${vipAfter}`);
  assert(vipAfter === vipBefore + 1, "message did not land on the VIP queue");
  console.log("   (this worker consumes the standard queue only, so it waits for VIP capacity)");

  // ---------------------------------------------------------------
  console.log("\n6. A SUCCESS without provenance is refused");
  const orphan = await reserveJob(org.token);
  await fetch(`${API}/jobs/${orphan}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-worker-secret": WORKER_SECRET },
    body: JSON.stringify({ status: "PROCESSING", workerId: "test-harness" }),
  });
  const noProvenance = await fetch(`${API}/jobs/${orphan}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-worker-secret": WORKER_SECRET },
    body: JSON.stringify({ status: "SUCCESS", maskImageS3Key: "somewhere/mask.png" }),
  });
  console.log(`   -> HTTP ${noProvenance.status}`);
  assert(noProvenance.status === 400, "a mask was accepted with no model version");

  console.log("\n7. Provenance is recorded and the recall query finds it");
  const version = `test-model-${stamp}`;
  const withProvenance = await fetch(`${API}/jobs/${orphan}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-worker-secret": WORKER_SECRET },
    body: JSON.stringify({
      status: "SUCCESS",
      maskImageS3Key: "somewhere/mask.png",
      modelVersion: version,
      workerId: "test-harness",
      gpuSeconds: 4.25,
    }),
  });
  assert(withProvenance.status === 200, "provenance-carrying report was refused");

  const stored = await systemDb.execute(
    sql`SELECT model_version, worker_id, gpu_seconds FROM jobs WHERE id = ${orphan}`
  );
  const row = stored.rows[0] as any;
  console.log(`   -> model ${row.model_version}, worker ${row.worker_id}, ${row.gpu_seconds}s`);
  assert(row.model_version === version, "model version not stored");
  assert(row.worker_id === "test-harness", "worker id not stored");
  assert(Number(row.gpu_seconds) === 4.25, "gpu seconds not stored");

  const recall = await fetch(`${API}/jobs/logs?modelVersion=${encodeURIComponent(version)}`, {
    headers: { Authorization: `Bearer ${org.token}` },
  });
  const recalled = (await recall.json()).logs as any[];
  console.log(`   -> recall query returned ${recalled.length} job(s)`);
  assert(recalled.length === 1 && recalled[0].id === orphan, "recall query did not isolate the affected job");

  // Leave the broker as we found it.
  await ch.purgeQueue(QUEUES.VIP);
  await ch.purgeQueue(dlqName);
  await ch.close();
  await conn.close();

  console.log("\n=== LIFECYCLE VERIFIED: no leaked credits, no silently lost messages ===");
}

run()
  .then(async () => {
    await Promise.all([pool.end(), authPool.end(), adminPool.end()]);
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nLIFECYCLE TEST FAILED:", e.message);
    await Promise.all([pool.end(), authPool.end(), adminPool.end()]).catch(() => {});
    process.exit(1);
  });
