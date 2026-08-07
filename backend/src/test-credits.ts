/**
 * Credit ledger test.
 *
 * The ledger exists so every credit has a recorded origin and so refunds are
 * idempotent by construction rather than by convention. This asserts both, and
 * that the materialized balance never drifts from the ledger.
 *
 * Requires the API to be running. Run with:
 *   npx tsx src/test-credits.ts
 */
import { sql } from "drizzle-orm";
import { systemDb, pool, authPool, adminPool } from "./db";
import { refundCredit, reconcile } from "./credits";

const API = "http://localhost:3000/api";
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
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function report(jobId: string, body: Record<string, unknown>) {
  const r = await fetch(`${API}/jobs/${jobId}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-worker-secret": WORKER_SECRET },
    body: JSON.stringify(body),
  });
  return r.status;
}

async function ledgerOf(orgId: string) {
  const r = await systemDb.execute(sql`
    SELECT reason, delta, job_id
      FROM credit_transactions
     WHERE organization_id = ${orgId}
     ORDER BY created_at
  `);
  return r.rows as unknown as { reason: string; delta: number; job_id: string | null }[];
}

async function balanceOf(orgId: string) {
  const r = await systemDb.execute(
    sql`SELECT credit_balance FROM organizations WHERE id = ${orgId}`
  );
  return Number((r.rows[0] as any).credit_balance);
}

async function assertReconciled(label: string) {
  const drift = await reconcile();
  assert(drift.length === 0, `${label}: ${drift.length} organization(s) drifted from the ledger`);
}

async function run() {
  console.log("=== CREDIT LEDGER TEST ===\n");

  const stamp = Date.now();
  const org = await register(`ledger.${stamp}@alpha-health.org`, `Ledger Hospital ${stamp}`);

  console.log("1. Trial credits arrive as a recorded grant, not a bare default");
  let entries = await ledgerOf(org.orgId);
  console.log(`-> ${entries.length} entry: ${entries[0].reason} ${entries[0].delta > 0 ? "+" : ""}${entries[0].delta}`);
  assert(entries.length === 1, "expected exactly one opening entry");
  assert(entries[0].reason === "TRIAL_GRANT", "opening entry is not a trial grant");
  assert(Number(entries[0].delta) === 3, "trial grant is not 3 credits");
  assert(await balanceOf(org.orgId) === 3, "balance does not match the grant");
  await assertReconciled("after signup");

  console.log("\n2. Reserving records a JOB_RESERVATION against the job");
  const first = await reserveJob(org.token);
  const jobId = first.body.jobId as string;
  entries = await ledgerOf(org.orgId);
  const reservation = entries.find((e) => e.reason === "JOB_RESERVATION");
  console.log(`-> ${reservation?.reason} ${reservation?.delta}, balance ${await balanceOf(org.orgId)}`);
  assert(!!reservation && Number(reservation.delta) === -1, "reservation not recorded");
  assert(reservation!.job_id === jobId, "reservation not linked to the job");
  assert(await balanceOf(org.orgId) === 2, "balance not decremented");
  await assertReconciled("after reservation");

  console.log("\n3. Failure records a JOB_REFUND and restores the balance");
  assert(await report(jobId, { status: "PROCESSING" }) === 200, "could not claim job");
  assert(await report(jobId, { status: "FAILED", errorMessage: "simulated" }) === 200, "could not fail job");
  console.log(`-> balance ${await balanceOf(org.orgId)}`);
  assert(await balanceOf(org.orgId) === 3, "credit not returned on failure");
  assert((await ledgerOf(org.orgId)).filter((e) => e.reason === "JOB_REFUND").length === 1, "refund not recorded");
  await assertReconciled("after refund");

  console.log("\n4. A replayed refund is refused by the database, not by a status check");
  const replayed = await systemDb.transaction((tx) =>
    refundCredit(tx, org.orgId, jobId, "replay attempt")
  );
  const refundCount = (await ledgerOf(org.orgId)).filter((e) => e.reason === "JOB_REFUND").length;
  console.log(`-> refundCredit returned ${replayed}, JOB_REFUND rows: ${refundCount}, balance ${await balanceOf(org.orgId)}`);
  assert(replayed === false, "a second refund was accepted");
  assert(refundCount === 1, "a duplicate refund row was written");
  assert(await balanceOf(org.orgId) === 3, "balance moved on a replayed refund");
  await assertReconciled("after replay");

  console.log("\n5. Balance cannot go below zero, and a refused request writes nothing");
  const spent: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await reserveJob(org.token);
    assert(r.status === 200, `reservation ${i + 1} unexpectedly failed`);
    spent.push(r.body.jobId);
  }
  assert(await balanceOf(org.orgId) === 0, "balance should be exhausted");

  const before = (await ledgerOf(org.orgId)).length;
  const overdraft = await reserveJob(org.token);
  const after = (await ledgerOf(org.orgId)).length;
  console.log(`-> overdraft attempt: HTTP ${overdraft.status}, ledger rows ${before} -> ${after}`);
  assert(overdraft.status === 402, "overdraft was not refused");
  assert(after === before, "a refused reservation still wrote to the ledger");
  await assertReconciled("after overdraft attempt");

  console.log("\n6. The ledger explains the balance");
  const finalEntries = await ledgerOf(org.orgId);
  const total = finalEntries.reduce((sum, e) => sum + Number(e.delta), 0);
  const balance = await balanceOf(org.orgId);
  console.log(`-> ${finalEntries.length} entries summing to ${total}, balance ${balance}`);
  for (const e of finalEntries) {
    console.log(`   ${e.reason.padEnd(16)} ${Number(e.delta) > 0 ? "+" : ""}${e.delta}${e.job_id ? `  job ${e.job_id.slice(0, 8)}` : ""}`);
  }
  assert(total === balance, "ledger total does not equal the stored balance");

  console.log("\n7. GET /api/credits exposes the history to the tenant");
  const view = await fetch(`${API}/credits`, { headers: { Authorization: `Bearer ${org.token}` } });
  const payload = await view.json();
  console.log(`-> HTTP ${view.status}, balance ${payload.balance}, ${payload.transactions.length} transactions`);
  assert(view.status === 200, "credits endpoint failed");
  assert(payload.balance === balance, "endpoint balance disagrees with the database");
  assert(payload.transactions.length === finalEntries.length, "endpoint returned the wrong history");

  console.log("\n8. Another tenant sees none of it");
  const other = await register(`intruder.${stamp}@beta-clinic.org`, `Beta Clinic ${stamp}`);
  const xview = await fetch(`${API}/credits`, { headers: { Authorization: `Bearer ${other.token}` } });
  const xpayload = await xview.json();
  console.log(`-> ${xpayload.transactions.length} transaction(s), all its own`);
  assert(
    xpayload.transactions.every((t: any) => t.organizationId === other.orgId),
    "credit history leaked across tenants"
  );

  console.log("\n9. Every organization in the database reconciles");
  const drift = await reconcile();
  console.log(`-> ${drift.length} discrepancies`);
  assert(drift.length === 0, "some organizations drifted from their ledger");

  console.log("\n=== LEDGER VERIFIED: every credit has an origin, refunds cannot double ===");
}

run()
  .then(async () => {
    await Promise.all([pool.end(), authPool.end(), adminPool.end()]);
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nLEDGER TEST FAILED:", e.message);
    await Promise.all([pool.end(), authPool.end(), adminPool.end()]).catch(() => {});
    process.exit(1);
  });
