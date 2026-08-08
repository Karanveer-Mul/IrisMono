/**
 * Retention-of-record test.
 *
 * The audit's §2.7 tail: every tenant-owned table hung off organizations with
 * ON DELETE CASCADE, so one DELETE erased a customer's jobs, their credit
 * ledger, and the provenance of every mask produced for them - while arch.md
 * promises that metadata is kept indefinitely for auditing and billing.
 *
 * These checks are written so they fail if the guarantee is only a convention.
 * The deletes below are issued as the superuser, which is the identity that
 * ignores grants and RLS: if the record survives that, it survives an operator
 * with a psql prompt, which is the threat. Closure is then exercised through
 * the API to show there is a supported answer to "remove this customer" that
 * does not involve destroying the record.
 *
 * Requires the API to be running.
 *   npx tsx src/test-retention.ts
 */
import { sql } from "drizzle-orm";
import { adminDb, systemDb, pool, authPool, adminPool } from "./db";
import { verifyAuditChain } from "./audit";

const API = "http://localhost:3000/api";

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
const get = (p: string, t?: string) => call("GET", p, undefined, t);
const del = (p: string, t?: string) => call("DELETE", p, undefined, t);

async function register(email: string, orgName: string, password = "correct-horse-battery-1") {
  const r = await post("/auth/register", { email, password, orgName });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
  const payload = JSON.parse(Buffer.from(r.body.token.split(".")[1], "base64").toString());
  return {
    token: r.body.token as string,
    orgId: payload.organizationId as string,
    userId: payload.id as string,
    email,
    password,
  };
}

/** Postgres foreign-key violation. */
const FK_VIOLATION = "23503";

async function expectRefused(what: string, run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error: any) {
    const code = error?.code ?? error?.cause?.code;
    assert(code === FK_VIOLATION, `${what} failed, but with ${code} rather than a foreign-key violation`);
    return String(error?.constraint ?? error?.cause?.constraint ?? "unknown constraint");
  }
  throw new Error(`FAIL: ${what} succeeded - the record is not protected`);
}

async function run() {
  console.log("=== RETENTION OF RECORD TEST ===\n");

  const stamp = Date.now();
  const domain = `ret-${stamp}.example.org`;
  const admin = await register(`ret.admin.${stamp}@${domain}`, `Retention Hospital ${stamp}`);

  // A job and its ledger entries, so the organization has a record to protect.
  const requested = await post("/jobs/request", {}, admin.token);
  assert(requested.status === 200, `job request failed: ${JSON.stringify(requested.body)}`);
  const jobId = requested.body.jobId as string;
  console.log(`Workspace ${admin.orgId} with job ${jobId}\n`);

  console.log("1. Deleting the organization is refused, not cascaded");
  const orgConstraint = await expectRefused("DELETE on organizations", () =>
    adminDb.execute(sql`DELETE FROM organizations WHERE id = ${admin.orgId}`)
  );
  console.log(`-> refused by ${orgConstraint}`);

  const survivingJobs = await adminDb.execute(
    sql`SELECT count(*)::int AS n FROM jobs WHERE organization_id = ${admin.orgId}`
  );
  const survivingLedger = await adminDb.execute(
    sql`SELECT count(*)::int AS n FROM credit_transactions WHERE organization_id = ${admin.orgId}`
  );
  console.log(
    `-> ${(survivingJobs.rows[0] as any).n} job(s) and ` +
      `${(survivingLedger.rows[0] as any).n} ledger row(s) still present`
  );
  assert((survivingJobs.rows[0] as any).n === 1, "the job did not survive the attempted delete");
  assert((survivingLedger.rows[0] as any).n === 2, "the ledger did not survive the attempted delete");

  console.log("\n2. Deleting a job is refused while its ledger entries reference it");
  const jobConstraint = await expectRefused("DELETE on jobs", () =>
    adminDb.execute(sql`DELETE FROM jobs WHERE id = ${jobId}`)
  );
  console.log(`-> refused by ${jobConstraint}`);

  console.log("\n3. An invite that admitted somebody cannot be deleted out from under them");
  const invite = await post("/invites", { maxUses: 5 }, admin.token);
  assert(invite.status === 201, `invite creation failed: ${JSON.stringify(invite.body)}`);
  const inviteCode = invite.body.invite.inviteCode as string;
  const inviteId = invite.body.invite.id as string;

  const joiner = await post(`/auth/join/${inviteCode}`, {
    email: `ret.joiner.${stamp}@${domain}`,
    password: "correct-horse-battery-2",
  });
  assert(joiner.status === 201 || joiner.status === 200, `join failed: ${JSON.stringify(joiner.body)}`);

  const inviteConstraint = await expectRefused("DELETE on organization_invites", () =>
    adminDb.execute(sql`DELETE FROM organization_invites WHERE id = ${inviteId}`)
  );
  console.log(`-> refused by ${inviteConstraint}`);

  const attributed = await adminDb.execute(
    sql`SELECT count(*)::int AS n FROM memberships WHERE invite_id = ${inviteId}`
  );
  assert((attributed.rows[0] as any).n === 1, "the membership is not attributed to the invite that admitted it");
  console.log(`-> membership still attributed to ${inviteId}`);

  console.log("\n4. Closing the workspace is the supported answer, and it is not a delete");
  const closed = await del("/auth/organization", admin.token);
  console.log(`-> HTTP ${closed.status}, closedAt ${closed.body?.closedAt}`);
  assert(closed.status === 200, `closure failed: ${JSON.stringify(closed.body)}`);
  assert(closed.body.alreadyClosed === false, "the workspace reported itself already closed");

  const again = await del("/auth/organization", admin.token);
  assert(again.status === 200 && again.body.alreadyClosed === true, "closing twice was not idempotent");
  assert(again.body.closedAt === closed.body.closedAt, "the second close overwrote the closure time");
  console.log("-> closing twice keeps the first closure timestamp");

  console.log("\n5. A closed workspace cannot spend, and cannot issue new links");
  const blockedJob = await post("/jobs/request", {}, admin.token);
  const blockedInvite = await post("/invites", { maxUses: 5 }, admin.token);
  console.log(`-> new job: HTTP ${blockedJob.status}, new invite: HTTP ${blockedInvite.status}`);
  assert(blockedJob.status === 410, `a closed workspace reserved a credit (HTTP ${blockedJob.status})`);
  assert(blockedInvite.status === 410, `a closed workspace issued an invite (HTTP ${blockedInvite.status})`);

  console.log("\n6. Its links stop working, including ones already in circulation");
  const lateJoin = await post(`/auth/join/${inviteCode}`, {
    email: `ret.late.${stamp}@${domain}`,
    password: "correct-horse-battery-3",
  });
  console.log(`-> redeeming a live link after closure: HTTP ${lateJoin.status}`);
  assert(lateJoin.status === 410, `a closed workspace admitted a new member (HTTP ${lateJoin.status})`);

  console.log("\n7. No new token can name it");
  const relogin = await post("/auth/login", { email: admin.email, password: admin.password });
  console.log(`-> sign-in with no remaining workspace: HTTP ${relogin.status}`);
  assert(relogin.status === 403, `login still offered the closed workspace (HTTP ${relogin.status})`);

  const switched = await post("/auth/switch-organization", { organizationId: admin.orgId }, admin.token);
  console.log(`-> switching to it by id: HTTP ${switched.status}`);
  assert(switched.status === 410, `a token was minted for a closed workspace (HTTP ${switched.status})`);

  console.log("\n8. Everything the closure was supposed to keep is still there");
  const afterClosure = await adminDb.execute(sql`
    SELECT (SELECT count(*)::int FROM jobs WHERE organization_id = ${admin.orgId}) AS jobs,
           (SELECT count(*)::int FROM credit_transactions WHERE organization_id = ${admin.orgId}) AS ledger,
           (SELECT count(*)::int FROM audit_events WHERE organization_id = ${admin.orgId}) AS audit
  `);
  const kept = afterClosure.rows[0] as any;
  console.log(`-> ${kept.jobs} job(s), ${kept.ledger} ledger row(s), ${kept.audit} audit event(s)`);
  assert(kept.jobs === 1, "the job did not survive closure");
  assert(kept.ledger === 2, "the ledger did not survive closure");
  assert(kept.audit > 0, "the audit trail did not survive closure");

  const closure = await adminDb.execute(sql`
    SELECT action FROM audit_events
     WHERE organization_id = ${admin.orgId} AND action = 'organization.closed'
  `);
  assert(closure.rows.length === 1, "the closure itself was not recorded exactly once");
  console.log("-> the closure is recorded once in the audit trail");

  console.log("\n9. Reopening works from the session that closed it");
  const reopened = await post("/auth/organization/reopen", {}, admin.token);
  console.log(`-> HTTP ${reopened.status}`);
  assert(reopened.status === 200, `reopen failed: ${JSON.stringify(reopened.body)}`);

  const worksAgain = await post("/jobs/request", {}, admin.token);
  console.log(`-> job request after reopening: HTTP ${worksAgain.status}`);
  assert(worksAgain.status === 200, "the workspace did not resume after reopening");

  const notClosed = await post("/auth/organization/reopen", {}, admin.token);
  assert(notClosed.status === 409, "reopening an open workspace was not refused");

  console.log("\n10. A deactivated account is refused, and its jobs remain");
  const leaver = await register(`ret.leaver.${stamp}@${domain}`, `Leaver Hospital ${stamp}`);
  const leaverJob = await post("/jobs/request", {}, leaver.token);
  assert(leaverJob.status === 200, "could not create a job for the departing user");

  await adminDb.execute(sql`UPDATE users SET deleted_at = NOW() WHERE id = ${leaver.userId}`);

  const refused = await post("/auth/login", { email: leaver.email, password: leaver.password });
  console.log(`-> sign-in after deactivation: HTTP ${refused.status}`);
  assert(refused.status === 403, `a deactivated account signed in (HTTP ${refused.status})`);

  const userConstraint = await expectRefused("DELETE on users", () =>
    adminDb.execute(sql`DELETE FROM users WHERE id = ${leaver.userId}`)
  );
  console.log(`-> hard delete refused by ${userConstraint}`);

  // The wrong password must still look like the wrong password: answering
  // "deactivated" before the password is verified would turn login into a
  // directory of who used to work here.
  const wrongPassword = await post("/auth/login", { email: leaver.email, password: "not-the-password-1" });
  console.log(`-> wrong password on a deactivated account: HTTP ${wrongPassword.status}`);
  assert(wrongPassword.status === 401, "deactivation is disclosed before the password is checked");

  console.log("\n11. The audit chain still verifies across all of it");
  const chain = await verifyAuditChain();
  console.log(`-> ${chain.checked} event(s) checked, ok: ${chain.ok}`);
  assert(chain.ok, `the audit chain broke at row ${chain.brokenAt}: ${chain.reason}`);

  // Left closed, so the fixture does not sit in the active set forever. The
  // rows stay - that is the whole point.
  await systemDb.execute(
    sql`UPDATE organizations SET deleted_at = NOW() WHERE id = ${admin.orgId} AND deleted_at IS NULL`
  );

  console.log("\n=== RETENTION OF RECORD VERIFIED ===");
  console.log("Organizations, users, jobs, and invites cannot be deleted out from under");
  console.log("the record. Closure stops the tenant acting and keeps everything else.");
}

run()
  .then(async () => {
    await Promise.all([pool.end(), authPool.end(), adminPool.end()]);
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nRETENTION TEST FAILED:", e.message);
    await Promise.all([pool.end(), authPool.end(), adminPool.end()]).catch(() => {});
    process.exit(1);
  });
