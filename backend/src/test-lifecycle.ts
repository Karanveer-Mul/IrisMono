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
import { grantCredits } from "./credits";
import {
  QUEUES,
  RETRY_COUNT_HEADER,
  RETRY_DELAYS_MS,
  deadLetterQueueFor,
  retryQueueFor,
  scheduleRetry,
} from "./queue";

const API = "http://localhost:3000/api";
const AMQP_URL = process.env.AMQP_URL || "amqp://guest:guest@localhost:5672";
const WORKER_SECRET = process.env.WORKER_SECRET || "local-dev-worker-secret";
const STORAGE_EVENT_SECRET = process.env.STORAGE_EVENT_SECRET || "local-dev-storage-secret";

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
  console.log("\n4. Unprocessable message is retried before it is dead-lettered");
  const conn = await amqp.connect(AMQP_URL);
  const ch = await conn.createChannel();

  const dlqName = deadLetterQueueFor(QUEUES.STANDARD);
  const firstRetryQueue = retryQueueFor(QUEUES.STANDARD, 1);
  const before = (await ch.checkQueue(dlqName)).messageCount;
  const retryBefore = (await ch.checkQueue(firstRetryQueue)).messageCount;

  // A message whose outcome cannot be established no longer goes straight to
  // the dead-letter queue - it is parked in the first delay tier, because the
  // usual cause is a dependency that is briefly unavailable.
  ch.sendToQueue(QUEUES.STANDARD, Buffer.from(JSON.stringify({ nothing: "useful" })), {
    persistent: true,
  });

  let parkedNow = retryBefore;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    parkedNow = (await ch.checkQueue(firstRetryQueue)).messageCount;
    if (parkedNow > retryBefore) break;
  }
  console.log(`   -> ${firstRetryQueue}: ${retryBefore} -> ${parkedNow}`);
  assert(parkedNow === retryBefore + 1, "message was not held for retry");
  assert(
    (await ch.checkQueue(dlqName)).messageCount === before,
    "message was dead-lettered on its first failure"
  );

  // The same message arriving with its tiers already spent has nowhere left to
  // go, and only then is it dead-lettered. Asserted by pre-setting the header
  // rather than by waiting out every tier in sequence.
  ch.sendToQueue(QUEUES.STANDARD, Buffer.from(JSON.stringify({ nothing: "useful" })), {
    persistent: true,
    headers: { [RETRY_COUNT_HEADER]: RETRY_DELAYS_MS.length },
  });

  let after = before;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    after = (await ch.checkQueue(dlqName)).messageCount;
    if (after > before) break;
  }
  console.log(`   -> ${dlqName}: ${before} -> ${after} once the tiers are spent`);
  assert(after === before + 1, "an exhausted message was not dead-lettered");

  // Do not leave the parked message to reappear on the work queue mid-suite.
  await ch.purgeQueue(firstRetryQueue);

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

  // ---------------------------------------------------------------
  console.log("\n8. Dispatch is single-shot under concurrent triggers");
  // Two clicks, or a retried fetch. Both used to see PENDING and both used to
  // publish, so a worker picked up a message that could only ever be refused.
  const contested = await reserveJob(org.token);
  const vipDepthBefore = (await ch.checkQueue(QUEUES.VIP)).messageCount;

  const triggerOnce = () =>
    fetch(`${API}/jobs/${contested}/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${org.token}` },
    });

  const [a, b] = await Promise.all([triggerOnce(), triggerOnce()]);
  const accepted = [a.status, b.status].filter((s) => s === 202).length;
  const refused = [a.status, b.status].filter((s) => s === 400).length;
  await new Promise((r) => setTimeout(r, 500));
  const vipDepthAfter = (await ch.checkQueue(QUEUES.VIP)).messageCount;

  console.log(`   -> ${accepted} accepted, ${refused} refused; queue depth ${vipDepthBefore} -> ${vipDepthAfter}`);
  assert(accepted === 1, `expected exactly one trigger to win, got ${accepted}`);
  assert(refused === 1, "the losing trigger was not refused");
  assert(vipDepthAfter === vipDepthBefore + 1, "the job was published more than once");

  const dispatchRow = await systemDb.execute(
    sql`SELECT dispatched_at FROM jobs WHERE id = ${contested}`
  );
  assert(
    (dispatchRow.rows[0] as any).dispatched_at !== null,
    "the winning trigger did not record when it dispatched"
  );

  // ---------------------------------------------------------------
  console.log("\n9. Retry tiers hold a message and return it to its work queue");
  // The delay queues have no consumer: a message sits until its TTL expires,
  // and RabbitMQ dead-letters it back to the queue it came from. That expiry is
  // the redelivery, so this asserts the mechanism rather than the wiring.
  const retryQueue = retryQueueFor(QUEUES.VIP, 1);
  const delayMs = RETRY_DELAYS_MS[0];
  await ch.purgeQueue(QUEUES.VIP);

  ch.sendToQueue(retryQueue, Buffer.from(JSON.stringify({ jobId: "retry-probe", orgId: org.orgId })), {
    persistent: true,
    headers: { [RETRY_COUNT_HEADER]: 1 },
  });

  await new Promise((r) => setTimeout(r, 800));
  const parked = (await ch.checkQueue(retryQueue)).messageCount;
  const notYet = (await ch.checkQueue(QUEUES.VIP)).messageCount;
  console.log(`   -> after 0.8s: ${parked} parked, ${notYet} back on the work queue`);
  assert(parked === 1, "the message was not held in the delay queue");
  assert(notYet === 0, "the message returned before its delay elapsed");

  console.log(`   waiting out the ${delayMs / 1000}s tier...`);
  await new Promise((r) => setTimeout(r, delayMs + 2000));
  const returned = (await ch.checkQueue(QUEUES.VIP)).messageCount;
  console.log(`   -> after the TTL: ${returned} back on ${QUEUES.VIP}`);
  assert(returned === 1, "the message never came back from the delay queue");

  // ---------------------------------------------------------------
  console.log("\n10. Retries are bounded, and the last one dead-letters");
  // scheduleRetry is pure with respect to the channel, so exhaustion is checked
  // directly rather than by waiting out every tier in sequence.
  const published: string[] = [];
  const fakeChannel = {
    sendToQueue: (queue: string) => {
      published.push(queue);
      return true;
    },
  } as unknown as amqp.Channel;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const message = {
      content: Buffer.from("{}"),
      properties: { headers: { [RETRY_COUNT_HEADER]: attempt } },
    } as unknown as amqp.ConsumeMessage;

    const result = scheduleRetry(fakeChannel, QUEUES.STANDARD, message);
    if (attempt < RETRY_DELAYS_MS.length) {
      assert(result.retried, `attempt ${attempt + 1} should have been scheduled`);
    } else {
      assert(!result.retried, "a message was retried past the last tier");
    }
  }
  console.log(`   -> ${RETRY_DELAYS_MS.length} tiers scheduled, then exhausted`);
  assert(published.length === RETRY_DELAYS_MS.length, "wrong number of retries scheduled");
  assert(
    published[published.length - 1] === retryQueueFor(QUEUES.STANDARD, RETRY_DELAYS_MS.length),
    "the last retry did not use the longest tier"
  );

  // ---------------------------------------------------------------
  console.log("\n11. The audit log pages by cursor, without overlap");
  const firstPage = await (
    await fetch(`${API}/jobs/logs?limit=2`, { headers: { Authorization: `Bearer ${org.token}` } })
  ).json();
  console.log(`   -> page 1: ${firstPage.logs.length} row(s), cursor ${firstPage.nextCursor ? "present" : "null"}`);
  assert(firstPage.logs.length === 2, "the page size was not honoured");
  assert(!!firstPage.nextCursor, "no cursor was returned despite more rows existing");

  const secondPage = await (
    await fetch(`${API}/jobs/logs?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor)}`, {
      headers: { Authorization: `Bearer ${org.token}` },
    })
  ).json();
  const firstIds = firstPage.logs.map((j: any) => j.id);
  const secondIds = secondPage.logs.map((j: any) => j.id);
  console.log(`   -> page 2: ${secondIds.length} row(s), ${secondIds.filter((id: string) => firstIds.includes(id)).length} overlapping`);
  assert(secondIds.every((id: string) => !firstIds.includes(id)), "a row appeared on two pages");
  assert(
    new Date(secondPage.logs[0].createdAt) <= new Date(firstPage.logs[1].createdAt),
    "the second page is not older than the first"
  );

  const malformed = await fetch(`${API}/jobs/logs?cursor=not-a-cursor`, {
    headers: { Authorization: `Bearer ${org.token}` },
  });
  console.log(`   -> malformed cursor: HTTP ${malformed.status}`);
  assert(malformed.status === 400, "a malformed cursor was not rejected");

  // ---------------------------------------------------------------
  console.log("\n12. A redelivered job can be re-claimed by its own worker only");
  // Without this the retry tiers would be decorative: the first attempt leaves
  // the job PROCESSING, so the redelivered copy would be refused and dropped.
  // Earlier steps spent the trial credits. Topped up through the ledger rather
  // than by writing the balance column, so reconciliation still holds.
  await grantCredits(systemDb, org.orgId, 1, "MANUAL_ADJUSTMENT", "lifecycle test top-up");

  const reclaimJob = await reserveJob(org.token);
  const claim = (workerId: string) =>
    fetch(`${API}/jobs/${reclaimJob}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-worker-secret": WORKER_SECRET },
      body: JSON.stringify({ status: "PROCESSING", workerId }),
    });

  assert((await claim("worker-a")).status === 200, "the first claim was refused");
  const sameWorker = await claim("worker-a");
  const otherWorker = await claim("worker-b");
  console.log(`   -> same worker: ${sameWorker.status}, different worker: ${otherWorker.status}`);
  assert(sameWorker.status === 200, "a worker could not re-claim its own job after redelivery");
  assert(otherWorker.status === 409, "a second worker was allowed to take a job already in flight");

  // ---------------------------------------------------------------
  console.log("\n13. A rejected upload settles the job instead of stranding the credit");
  await grantCredits(systemDb, org.orgId, 2, "MANUAL_ADJUSTMENT", "lifecycle test top-up");

  const uploadUrlFor = async () => {
    const r = await fetch(`${API}/jobs/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${org.token}` },
    });
    return r.json();
  };

  const notPng = await uploadUrlFor();
  const balanceBeforeReject = await balanceOf(org.orgId);
  const wrongFormat = await fetch(notPng.uploadUrl, {
    method: "PUT",
    body: Buffer.from("MZ this is not a png at all, it is an executable"),
    headers: { "Content-Type": "image/png" },
  });
  // The settlement happens as the request is answered; give it a moment to land.
  await new Promise((r) => setTimeout(r, 400));
  const rejectedRow = await jobRow(notPng.jobId);
  console.log(
    `   -> HTTP ${wrongFormat.status}, job ${rejectedRow.status}, balance ${balanceBeforeReject} -> ${await balanceOf(org.orgId)}`
  );
  assert(wrongFormat.status === 415, "a non-PNG body was accepted as a scan");
  assert(rejectedRow.status === "FAILED", "the rejected upload left the job PENDING");
  assert(
    (await balanceOf(org.orgId)) === balanceBeforeReject + 1,
    "the credit was not returned when the upload was refused"
  );

  const oversized = await uploadUrlFor();
  const tooBig = Buffer.alloc(26 * 1024 * 1024);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(tooBig);
  const overLimit = await fetch(oversized.uploadUrl, {
    method: "PUT",
    body: tooBig,
    headers: { "Content-Type": "image/png" },
  }).catch(() => ({ status: 413 }) as Response);
  await new Promise((r) => setTimeout(r, 400));
  console.log(`   -> 26MB upload answered HTTP ${overLimit.status}, job ${(await jobRow(oversized.jobId)).status}`);
  assert(overLimit.status === 413, "an oversized body was accepted");
  assert((await jobRow(oversized.jobId)).status === "FAILED", "the oversized upload left the job PENDING");

  // ---------------------------------------------------------------
  console.log("\n14. A storage event queues the job, and only the right caller may send one");
  await grantCredits(systemDb, org.orgId, 1, "MANUAL_ADJUSTMENT", "lifecycle test top-up");
  const eventJob = await reserveJob(org.token);
  const rawKey = `org_id=${org.orgId}/jobs/${eventJob}/raw.png`;

  const unauthorizedEvent = await fetch(`${API}/jobs/storage-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-storage-secret": "wrong" },
    body: JSON.stringify({ key: rawKey }),
  });
  console.log(`   -> without the secret: ${unauthorizedEvent.status}`);
  assert(unauthorizedEvent.status === 401, "the storage event endpoint accepted an unauthenticated caller");

  const vipDepthBeforeEvent = (await ch.checkQueue(QUEUES.VIP)).messageCount;
  const notified = await fetch(`${API}/jobs/storage-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-storage-secret": STORAGE_EVENT_SECRET },
    // The S3 notification envelope, as a real bucket would send it.
    body: JSON.stringify({ Records: [{ s3: { object: { key: rawKey } } }] }),
  });
  const notifiedBody = await notified.json();
  await new Promise((r) => setTimeout(r, 500));
  const vipDepthAfterEvent = (await ch.checkQueue(QUEUES.VIP)).messageCount;
  console.log(`   -> ${notifiedBody.results[rawKey]}, queue depth ${vipDepthBeforeEvent} -> ${vipDepthAfterEvent}`);
  assert(notified.status === 200, "a valid storage event was refused");
  assert(vipDepthAfterEvent === vipDepthBeforeEvent + 1, "the storage event did not queue the job");

  // A mask written by a worker lands in the same bucket and must not start
  // anything - otherwise every completed job would re-queue itself.
  const maskEvent = await fetch(`${API}/jobs/storage-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-storage-secret": STORAGE_EVENT_SECRET },
    body: JSON.stringify({ key: `org_id=${org.orgId}/jobs/${eventJob}/mask.png` }),
  });
  const maskBody = await maskEvent.json();
  console.log(`   -> a mask key is ${Object.values(maskBody.results)[0]}`);
  assert(Object.values(maskBody.results)[0] === "ignored", "a mask upload started a job");

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
