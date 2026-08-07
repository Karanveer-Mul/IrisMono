/**
 * Row-Level Security regression test.
 *
 * Every query below deliberately OMITS the organization predicate - the exact
 * mistake RLS exists to contain. Without working policies each one would return
 * every tenant's rows, so this fails loudly if RLS is disabled, if the app role
 * regains superuser/BYPASSRLS, or if the tenant context stops being applied.
 *
 * Requires the API and worker to be running. Run with:
 *   npx tsx src/test-rls.ts
 */
import { eq } from "drizzle-orm";
import { db, systemDb, withTenant, pool, authPool, adminPool } from "./db";
import { jobs, users, memberships, organizationInvites, organizations } from "./db/schema";

const API = "http://localhost:3000/api";

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

async function createJob(token: string) {
  const r = await fetch(`${API}/jobs/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`job request failed: ${await r.text()}`);
  return (await r.json()).jobId as string;
}

async function createInvite(token: string) {
  const r = await fetch(`${API}/invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ expiresDays: 1 }),
  });
  if (!r.ok) throw new Error(`invite failed: ${await r.text()}`);
  return (await r.json()).invite.id as string;
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

async function run() {
  console.log("=== ROW-LEVEL SECURITY ISOLATION TEST ===\n");

  const stamp = Date.now();

  console.log("Seeding two tenants, each with a job and an invite...");
  const a = await register(`admin.a.${stamp}@alpha-health.org`, `Alpha Health ${stamp}`);
  const b = await register(`admin.b.${stamp}@beta-clinic.org`, `Beta Clinic ${stamp}`);
  await createJob(a.token);
  await createJob(b.token);
  await createInvite(a.token);
  await createInvite(b.token);
  console.log(`-> tenant A = ${a.orgId}`);
  console.log(`-> tenant B = ${b.orgId}\n`);

  // Ground truth, read with the RLS-bypassing identity.
  const allJobs = await systemDb.select().from(jobs);
  const allUsers = await systemDb.select().from(users);
  const allOrgs = await systemDb.select().from(organizations);
  console.log(
    `Ground truth (bypass identity): ${allOrgs.length} orgs, ${allUsers.length} users, ${allJobs.length} jobs\n`
  );
  assert(allJobs.length >= 2, "expected at least two jobs across tenants");

  console.log("1. Unscoped SELECT with no tenant context at all");
  const leakedJobs = await db.select().from(jobs);
  const leakedUsers = await db.select().from(users);
  const leakedOrgs = await db.select().from(organizations);
  console.log(`-> jobs ${leakedJobs.length}, users ${leakedUsers.length}, orgs ${leakedOrgs.length}`);
  assert(leakedJobs.length === 0, "jobs readable without tenant context");
  assert(leakedUsers.length === 0, "users readable without tenant context");
  assert(leakedOrgs.length === 0, "organizations readable without tenant context");

  console.log("\n2. Unscoped SELECT inside tenant A's context (the forgotten-predicate case)");
  const seenByA = await withTenant(a.orgId, async (tx) => ({
    jobs: await tx.select().from(jobs),
    users: await tx.select().from(users),
    memberships: await tx.select().from(memberships),
    invites: await tx.select().from(organizationInvites),
    orgs: await tx.select().from(organizations),
  }));
  console.log(
    `-> jobs ${seenByA.jobs.length}, users ${seenByA.users.length}, ` +
    `memberships ${seenByA.memberships.length}, invites ${seenByA.invites.length}, orgs ${seenByA.orgs.length}`
  );
  assert(seenByA.jobs.every((j) => j.organizationId === a.orgId), "tenant A saw another tenant's jobs");
  // users carries no tenant column now; its policy asks the membership table,
  // so visibility follows who actually belongs to this organization.
  assert(seenByA.memberships.every((m) => m.organizationId === a.orgId), "tenant A saw another tenant's memberships");
  assert(seenByA.users.length === seenByA.memberships.length, "user visibility does not track membership");
  assert(seenByA.invites.every((i) => i.organizationId === a.orgId), "tenant A saw another tenant's invites");
  assert(seenByA.orgs.length === 1 && seenByA.orgs[0].id === a.orgId, "tenant A saw another organization");
  assert(seenByA.jobs.length < allJobs.length, "RLS did not actually filter anything");

  console.log("\n3. Tenant B sees a disjoint set");
  const seenByB = await withTenant(b.orgId, (tx) => tx.select().from(jobs));
  console.log(`-> jobs ${seenByB.length}`);
  assert(seenByB.every((j) => j.organizationId === b.orgId), "tenant B saw another tenant's jobs");
  const overlap = seenByB.filter((j) => seenByA.jobs.some((x) => x.id === j.id));
  assert(overlap.length === 0, "tenant result sets overlap");

  console.log("\n4. Cross-tenant write is refused");
  const wrote = await withTenant(a.orgId, (tx) =>
    tx
      .update(jobs)
      .set({ errorMessage: "tampered by tenant A" })
      .where(eq(jobs.organizationId, b.orgId))
      .returning()
  );
  console.log(`-> rows updated in tenant B: ${wrote.length}`);
  assert(wrote.length === 0, "tenant A modified tenant B's rows");

  console.log("\n5. Context does not survive the transaction (pooled connection leak check)");
  const afterCommit = await db.select().from(jobs);
  console.log(`-> jobs visible on a fresh query: ${afterCommit.length}`);
  assert(afterCommit.length === 0, "tenant context leaked past the transaction onto the pooled connection");

  console.log("\n=== RLS VERIFIED: isolation holds even with the predicate omitted ===");
}

run()
  .then(async () => {
    await Promise.all([pool.end(), authPool.end(), adminPool.end()]);
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nRLS TEST FAILED:", e.message);
    await Promise.all([pool.end(), authPool.end(), adminPool.end()]).catch(() => {});
    process.exit(1);
  });
