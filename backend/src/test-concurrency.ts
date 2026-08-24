/**
 * Job concurrency test.
 *
 * arch.md section 1 requires "restrict users via configuration to uploading
 * exactly 1 image at a time." The only enforcement was client-side -
 * MaskUploader.tsx refusing a file picker selection of more than one file -
 * which does nothing about two browser tabs, two members of the same
 * workspace, or a request replayed by hand. Nothing on the server ever
 * counted how many jobs a tenant already had running.
 *
 * These checks create real PENDING/PROCESSING jobs through the same endpoint
 * a browser would call, so the count being enforced is the one that actually
 * matters: what is in the database, not what one client remembers asking for.
 *
 * Requires the API to be running.
 *   npx tsx src/test-concurrency.ts
 */
import { pool, authPool, adminPool, systemDb } from "./db";
import { verifyAuditChain } from "./audit";
import { grantCredits } from "./credits";

const API = "http://localhost:3000/api";
const WORKER_SECRET = process.env.WORKER_SECRET || "local-dev-worker-secret";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

async function call(method: string, pathname: string, body?: unknown, token?: string) {
  const r = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}

const post = (p: string, b?: unknown, t?: string) => call("POST", p, b, t);
const put = (p: string, b?: unknown, t?: string) => call("PUT", p, b, t);
const get = (p: string, t?: string) => call("GET", p, undefined, t);

async function register(email: string, orgName: string, password = "correct-horse-battery-1") {
  const r = await post("/auth/register", { email, password, orgName });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
  const payload = JSON.parse(Buffer.from(r.body.token.split(".")[1], "base64").toString());
  return { token: r.body.token as string, orgId: payload.organizationId as string };
}

/** Moves a PENDING job to PROCESSING as a worker would claim it. */
async function claim(jobId: string, workerId = `w-${jobId.slice(0, 8)}`) {
  const r = await fetch(`${API}/jobs/${jobId}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-worker-secret": WORKER_SECRET },
    body: JSON.stringify({ status: "PROCESSING", workerId }),
  });
  if (!r.ok) throw new Error(`claim failed: HTTP ${r.status}`);
}

/** Settles a job as SUCCESS, which is what frees a concurrency slot. */
async function finish(jobId: string, workerId = `w-${jobId.slice(0, 8)}`) {
  const r = await fetch(`${API}/jobs/${jobId}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-worker-secret": WORKER_SECRET },
    body: JSON.stringify({ status: "SUCCESS", workerId, modelVersion: "test-model-1" }),
  });
  if (!r.ok) throw new Error(`finish failed: HTTP ${r.status}`);
}

async function run() {
  console.log("=== JOB CONCURRENCY TEST ===\n");

  const stamp = Date.now();
  const domain = `conc-${stamp}.example.org`;
  const admin = await register(`conc.admin.${stamp}@${domain}`, `Concurrency Hospital ${stamp}`);
  console.log(`Workspace ${admin.orgId}\n`);

  console.log("1. The platform default is 1: a second job is refused while the first is PENDING");
  const first = await post("/jobs/request", {}, admin.token);
  assert(first.status === 200, `first job request failed: ${JSON.stringify(first.body)}`);
  const firstJobId = first.body.jobId as string;

  const second = await post("/jobs/request", {}, admin.token);
  console.log(`-> first: HTTP ${first.status}, second while first is PENDING: HTTP ${second.status}`);
  assert(second.status === 429, `a second concurrent job was accepted (HTTP ${second.status})`);
  assert(second.body.limit === 1, "the refusal did not name the limit that was hit");

  console.log("\n2. Still refused once the first job is claimed (PROCESSING counts too)");
  await claim(firstJobId);
  const stillBlocked = await post("/jobs/request", {}, admin.token);
  console.log(`-> HTTP ${stillBlocked.status}`);
  assert(stillBlocked.status === 429, `a PROCESSING job did not count against the limit (HTTP ${stillBlocked.status})`);

  console.log("\n3. Freed once the first job finishes");
  await finish(firstJobId);
  const afterFinish = await post("/jobs/request", {}, admin.token);
  console.log(`-> HTTP ${afterFinish.status}`);
  assert(afterFinish.status === 200, `the slot was not freed after the job finished (HTTP ${afterFinish.status})`);
  const secondJobId = afterFinish.body.jobId as string;
  await claim(secondJobId);
  await finish(secondJobId);

  console.log("\n4. The limit is a per-tenant setting, and it is bounded");
  const tooLow = await put("/auth/organization/concurrency", { maxConcurrentJobs: 0 }, admin.token);
  const tooHigh = await put("/auth/organization/concurrency", { maxConcurrentJobs: 5000 }, admin.token);
  const fractional = await put("/auth/organization/concurrency", { maxConcurrentJobs: 2.5 }, admin.token);
  const accepted = await put("/auth/organization/concurrency", { maxConcurrentJobs: 3 }, admin.token);
  console.log(
    `-> 0: ${tooLow.status}, 5000: ${tooHigh.status}, 2.5: ${fractional.status}, 3: ${accepted.status}`
  );
  assert(tooLow.status === 400, "zero was accepted");
  assert(tooHigh.status === 400, "an absurd ceiling was accepted");
  assert(fractional.status === 400, "a fractional limit was accepted");
  assert(accepted.status === 200 && accepted.body.maxConcurrentJobs === 3, "a valid limit was refused");

  console.log("\n5. A tenant's own limit of 3 admits a third job and refuses a fourth");
  // The trial grant is 3 credits and two have already been spent by successful
  // jobs above (credits are only refunded on failure) - topped up so this step
  // tests the concurrency limit rather than running into an unrelated one.
  await systemDb.transaction((tx) => grantCredits(tx, admin.orgId, 10, "MANUAL_ADJUSTMENT", "test top-up"));
  const a = await post("/jobs/request", {}, admin.token);
  const b = await post("/jobs/request", {}, admin.token);
  const c = await post("/jobs/request", {}, admin.token);
  const d = await post("/jobs/request", {}, admin.token);
  console.log(`-> 1st: ${a.status}, 2nd: ${b.status}, 3rd: ${c.status}, 4th: ${d.status}`);
  assert(a.status === 200 && b.status === 200 && c.status === 200, "three concurrent jobs were not all admitted");
  assert(d.status === 429 && d.body.limit === 3, `a fourth job under a limit of 3 was accepted (HTTP ${d.status})`);

  // Settle all three so the workspace is left clean.
  for (const jobId of [a.body.jobId, b.body.jobId, c.body.jobId] as string[]) {
    await claim(jobId);
    await finish(jobId);
  }

  console.log("\n6. A different tenant is unaffected by this one's limit");
  const other = await register(`conc.other.${stamp}@other-${stamp}.example.org`, `Other Hospital ${stamp}`);
  const otherFirst = await post("/jobs/request", {}, other.token);
  console.log(`-> other tenant's first job: HTTP ${otherFirst.status}`);
  assert(otherFirst.status === 200, "an unrelated tenant was blocked by this tenant's limit");
  await claim(otherFirst.body.jobId);
  await finish(otherFirst.body.jobId);

  console.log("\n7. Clearing the limit returns to the platform default, and the profile says so");
  await put("/auth/organization/concurrency", { maxConcurrentJobs: null }, admin.token);
  const profile = await get("/auth/profile", admin.token);
  console.log(
    `-> platform default: ${profile.body.platformMaxConcurrentJobs}, ` +
      `own limit: ${profile.body.organization.maxConcurrentJobs}`
  );
  assert(
    profile.body.platformMaxConcurrentJobs === Number(process.env.MAX_CONCURRENT_JOBS_DEFAULT || 1),
    "the profile does not name the platform's concurrency default"
  );
  assert(profile.body.organization.maxConcurrentJobs === null, "a cleared limit did not read back as null");

  const backToOne = await post("/jobs/request", {}, admin.token);
  const refusedAgain = await post("/jobs/request", {}, admin.token);
  console.log(`-> back on the default of 1: first ${backToOne.status}, second ${refusedAgain.status}`);
  assert(backToOne.status === 200, "the first job under the restored default was refused");
  assert(refusedAgain.status === 429, "the restored platform default of 1 was not enforced");
  await claim(backToOne.body.jobId);
  await finish(backToOne.body.jobId);

  console.log("\n8. Changing the limit is audited, with the value it replaced");
  await put("/auth/organization/concurrency", { maxConcurrentJobs: 3 }, admin.token);
  let change: any = null;
  for (let attempt = 0; attempt < 10 && !change; attempt++) {
    await new Promise((r) => setTimeout(r, 200));
    const trail = await get("/audit?action=organization.concurrency.changed&limit=10", admin.token);
    change = (trail.body?.events as any[])?.find((e: any) => e.metadata?.maxConcurrentJobs === 3);
  }
  console.log(`-> ${change?.actorEmail} changed the limit from ${change?.metadata?.previous} to 3`);
  assert(!!change, "a concurrency change was not recorded");
  assert(change.metadata.previous === null, "the prior value was not recorded");

  console.log("\n9. The audit chain still verifies");
  const chain = await verifyAuditChain();
  console.log(`-> ${chain.checked} event(s) checked, ok: ${chain.ok}`);
  assert(chain.ok, `the audit chain broke at row ${chain.brokenAt}: ${chain.reason}`);

  console.log("\n=== CONCURRENCY VERIFIED ===");
  console.log("A tenant cannot exceed its own in-flight job limit regardless of how many");
  console.log("clients are asking, the limit is configurable per tenant, and it is audited.");
}

run()
  .then(async () => {
    await Promise.all([pool.end(), authPool.end(), adminPool.end()]);
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nCONCURRENCY TEST FAILED:", e.message);
    await Promise.all([pool.end(), authPool.end(), adminPool.end()]).catch(() => {});
    process.exit(1);
  });
