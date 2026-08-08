/**
 * Session revocation test.
 *
 * A JWT is a statement about the past. Everything that should end access
 * immediately - deactivating an account, closing a workspace, removing someone
 * from one, demoting an administrator, requiring a second factor - happens
 * after the token was signed, and until migration 0015 all of it waited for the
 * next sign-in, which is the one thing whoever holds a stolen token will not do.
 *
 * These checks are written to fail if any of that is decided from the claims.
 *
 * Requires the API to be running.
 *   npx tsx src/test-sessions.ts
 */
import { createHmac } from "crypto";
import { eq, and, sql } from "drizzle-orm";
import { systemDb, pool, authPool, adminPool } from "./db";
import { memberships, users } from "./db/schema";
import { base32Decode, stepAt } from "./mfa";
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
const put = (p: string, b: unknown, t?: string) => call("PUT", p, b, t);

/**
 * RFC 6238, written from the specification rather than reusing the generator
 * under test - only needed here to get the admin enrolled so the workspace can
 * require MFA. src/test-mfa.ts is where TOTP itself is exercised.
 */
function code(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const d = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const o = d[d.length - 1] & 0x0f;
  const v = ((d[o] & 0x7f) << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3];
  return String(v % 1_000_000).padStart(6, "0");
}

function claims(token: string) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
}

async function register(email: string, orgName: string, password = "correct-horse-battery-1") {
  const r = await post("/auth/register", { email, password, orgName });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
  const c = claims(r.body.token);
  return { token: r.body.token as string, userId: c.id as string, orgId: c.organizationId as string, email, password };
}

async function run() {
  console.log("=== SESSION REVOCATION TEST ===\n");
  const stamp = Date.now();
  const domain = `sess-${stamp}.example.org`;

  const admin = await register(`sess.admin.${stamp}@${domain}`, `Session Hospital ${stamp}`);
  const invite = await post("/invites", { maxUses: 10 }, admin.token);
  const inviteCode = invite.body.invite.inviteCode as string;

  const joinAs = async (label: string) => {
    const email = `sess.${label}.${stamp}@${domain}`;
    const r = await post(`/auth/join/${inviteCode}`, { email, password: "correct-horse-battery-2" });
    if (r.status !== 201) throw new Error(`join failed: ${JSON.stringify(r.body)}`);
    return { token: r.body.token as string, userId: claims(r.body.token).id as string, email, password: "correct-horse-battery-2" };
  };

  console.log("1. A live session works, and the token alone is not the authority");
  const member = await joinAs("member");
  const before = await get("/auth/profile", member.token);
  console.log(`-> profile with a fresh session: HTTP ${before.status}`);
  assert(before.status === 200, "a valid session was refused");

  console.log("\n2. Signing out everywhere ends the session that asked for it");
  const revokedSelf = await post("/auth/sessions/revoke", {}, member.token);
  const afterSelf = await get("/auth/profile", member.token);
  console.log(`-> revoke: HTTP ${revokedSelf.status}, same token afterwards: HTTP ${afterSelf.status}`);
  assert(revokedSelf.status === 200, "sign out everywhere failed");
  assert(afterSelf.status === 401, `a revoked session answered ${afterSelf.status} rather than 401`);
  assert(afterSelf.body?.sessionRevoked === true, "the refusal does not say the session was revoked");

  // Signing in again must work: this ends sessions, it does not disable the
  // account. A cut-off that also blocked new sign-ins would be a lockout.
  const signedInAgain = await post("/auth/login", { email: member.email, password: member.password });
  console.log(`-> signing in again: HTTP ${signedInAgain.status}`);
  assert(signedInAgain.status === 200, "revocation blocked a fresh sign-in");
  const member2 = { ...member, token: signedInAgain.body.token as string };
  assert((await get("/auth/profile", member2.token)).status === 200, "the new session was refused");

  console.log("\n3. An admin can cut off one member, in one workspace only");
  const cut = await post(`/auth/members/${member.userId}/sessions/revoke`, {}, admin.token);
  const memberAfter = await get("/auth/profile", member2.token);
  const adminAfter = await get("/auth/profile", admin.token);
  console.log(`-> revoke: HTTP ${cut.status}, member: HTTP ${memberAfter.status}, admin: HTTP ${adminAfter.status}`);
  assert(cut.status === 200, "an admin could not revoke a member's sessions");
  assert(memberAfter.status === 401, "the member's session survived");
  assert(adminAfter.status === 200, "revoking one member ended everyone's sessions");

  // The cut-off is on the membership, not the person. Somebody who works for
  // two hospitals must not lose the other one because an admin at this one
  // revoked them - that would be an escalation past the tenant boundary.
  const elsewhere = await register(`sess.dual.${stamp}@other-${stamp}.example.org`, `Other Hospital ${stamp}`);
  await systemDb.insert(memberships).values({
    userId: elsewhere.userId,
    organizationId: admin.orgId,
    role: "MEMBER",
  });
  const switched = await post("/auth/switch-organization", { organizationId: admin.orgId }, elsewhere.token);
  assert(switched.status === 200, "the second membership did not take");
  const hereToken = switched.body.token as string;

  await post(`/auth/members/${elsewhere.userId}/sessions/revoke`, {}, admin.token);
  const hereAfter = await get("/auth/profile", hereToken);
  const homeAfter = await get("/auth/profile", elsewhere.token);
  console.log(`-> after revoking in one workspace: here HTTP ${hereAfter.status}, own workspace HTTP ${homeAfter.status}`);
  assert(hereAfter.status === 401, "the revoked workspace still accepted the session");
  assert(homeAfter.status === 200, "an admin's revocation reached another tenant's session");

  console.log("\n4. A member cannot revoke anyone");
  const memberFresh = await post("/auth/login", { email: member.email, password: member.password });
  const notAllowed = await post(`/auth/members/${admin.userId}/sessions/revoke`, {}, memberFresh.body.token);
  const notAllowedOrg = await post("/auth/organization/sessions/revoke", {}, memberFresh.body.token);
  console.log(`-> member revoking an admin: HTTP ${notAllowed.status}, whole workspace: HTTP ${notAllowedOrg.status}`);
  assert(notAllowed.status === 403, "a member revoked another account's sessions");
  assert(notAllowedOrg.status === 403, "a member revoked the whole workspace");
  const badId = await post("/auth/members/not-a-uuid/sessions/revoke", {}, admin.token);
  console.log(`-> a malformed user id: HTTP ${badId.status}`);
  assert(badId.status === 400, "a malformed id was not rejected as a client error");

  console.log("\n5. Removing a membership ends that person's session at once");
  const removed = await joinAs("removed");
  assert((await get("/auth/profile", removed.token)).status === 200, "the new member could not act");
  await systemDb
    .delete(memberships)
    .where(and(eq(memberships.userId, removed.userId), eq(memberships.organizationId, admin.orgId)));
  const afterRemoval = await get("/auth/profile", removed.token);
  console.log(`-> session after the membership was deleted: HTTP ${afterRemoval.status}`);
  assert(afterRemoval.status === 403, `a removed member answered ${afterRemoval.status} rather than 403`);

  console.log("\n6. A demotion binds the session that is already open");
  const demoted = await joinAs("demoted");
  await systemDb
    .update(memberships)
    .set({ role: "ORG_ADMIN" })
    .where(and(eq(memberships.userId, demoted.userId), eq(memberships.organizationId, admin.orgId)));
  // The token still claims MEMBER. Creating an invite is ORG_ADMIN-only, so if
  // this succeeds the role is being read from the database, not the claims.
  const asAdmin = await post("/invites", { maxUses: 1 }, demoted.token);
  await systemDb
    .update(memberships)
    .set({ role: "MEMBER" })
    .where(and(eq(memberships.userId, demoted.userId), eq(memberships.organizationId, admin.orgId)));
  const asMember = await post("/invites", { maxUses: 1 }, demoted.token);
  console.log(`-> same token, promoted: HTTP ${asAdmin.status}, then demoted: HTTP ${asMember.status}`);
  // The token still says ORG_ADMIN. The database says otherwise, and the
  // database is what decides - demotion is the direction that matters.
  assert(asAdmin.status === 201, "a promotion did not reach the open session");
  assert(asMember.status === 403, "a demoted session kept its administrator powers");
  // The token said MEMBER throughout - including while the promoted call
  // succeeded - so the role can only have come from the database.
  assert(claims(demoted.token).role === "MEMBER", "the token did not claim MEMBER, so this proves nothing");

  console.log("\n7. Deactivating an account ends its sessions immediately");
  const fired = await joinAs("fired");
  assert((await get("/auth/profile", fired.token)).status === 200, "the new member could not act");
  await systemDb.update(users).set({ deletedAt: sql`NOW()` }).where(eq(users.id, fired.userId));
  const afterDeactivation = await get("/auth/profile", fired.token);
  console.log(`-> session after deactivation: HTTP ${afterDeactivation.status}`);
  assert(afterDeactivation.status === 401, "a deactivated account kept its live session");

  console.log("\n8. Requiring MFA restricts the sessions that already exist");
  const caught = await joinAs("caught");
  assert((await get("/auth/profile", caught.token)).status === 200, "the new member could not act");
  assert(claims(caught.token).restricted === undefined, "the session was already restricted");

  // Enrol the admin, because requiring it of everyone is refused otherwise.
  const setup = await post("/auth/mfa/setup", {}, admin.token);
  const confirmed = await post("/auth/mfa/confirm", { code: code(setup.body.secret, stepAt()) }, admin.token);
  assert(confirmed.status === 200, `admin enrolment failed: ${JSON.stringify(confirmed.body)}`);

  const policy = await put("/auth/organization/mfa", { requireMfa: true }, admin.token);
  assert(policy.status === 200, "the policy could not be turned on");

  const nowRestricted = await get("/auth/profile", caught.token);
  const enrolmentReachable = await get("/auth/mfa", caught.token);
  console.log(`-> an existing session after the policy: HTTP ${nowRestricted.status}, enrolment: HTTP ${enrolmentReachable.status}`);
  assert(nowRestricted.status === 403, "the policy waited for the next sign-in");
  assert(nowRestricted.body?.mfaEnrolmentRequired === true, "the refusal does not say why");
  assert(enrolmentReachable.status === 200, "a restricted session could not reach enrolment");
  assert(enrolmentReachable.body.restricted === true, "the status does not report the restriction");

  console.log("\n9. Lifting the requirement releases those sessions again");
  await put("/auth/organization/mfa", { requireMfa: false }, admin.token);
  const released = await get("/auth/profile", caught.token);
  console.log(`-> same session after the policy was lifted: HTTP ${released.status}`);
  assert(released.status === 200, "a session stayed restricted after the requirement was lifted");

  console.log("\n10. An admin can end every session in the workspace at once");
  const staying = await joinAs("staying");
  const wholeOrg = await post("/auth/organization/sessions/revoke", {}, admin.token);
  const memberGone = await get("/auth/profile", staying.token);
  const adminGone = await get("/auth/profile", admin.token);
  console.log(`-> revoke: HTTP ${wholeOrg.status}, member: HTTP ${memberGone.status}, admin: HTTP ${adminGone.status}`);
  assert(wholeOrg.status === 200, "the workspace-wide revocation failed");
  assert(memberGone.status === 401, "a member's session survived a workspace-wide revocation");
  assert(adminGone.status === 401, "the administrator's own session survived");

  // And the other tenant is untouched, because the cut-off is on the row.
  const untouched = await get("/auth/profile", elsewhere.token);
  console.log(`-> another workspace's session: HTTP ${untouched.status}`);
  assert(untouched.status === 200, "a workspace-wide revocation reached another tenant");

  console.log("\n11. Closure does not run through the session gate");
  // Closure stops the tenant *acting*, enforced inside the writing
  // transactions. Refusing the session itself would lock out the administrator
  // who closed it - the only person who can reopen it, and the one most likely
  // to be exporting records during a wind-down.
  const closingAdmin = await register(`sess.closer.${stamp}@close-${stamp}.example.org`, `Closing Hospital ${stamp}`);
  const closed = await call("DELETE", "/auth/organization", undefined, closingAdmin.token);
  const afterClosure = await get("/auth/profile", closingAdmin.token);
  const writeAfterClosure = await put("/auth/organization/retention", { retentionDays: 30 }, closingAdmin.token);
  const reopened = await post("/auth/organization/reopen", {}, closingAdmin.token);
  console.log(
    `-> close: HTTP ${closed.status}, profile: HTTP ${afterClosure.status}, ` +
      `a write: HTTP ${writeAfterClosure.status}, reopen: HTTP ${reopened.status}`
  );
  assert(closed.status === 200, "closure failed");
  assert(afterClosure.status === 200, "the closing administrator lost their own session");
  assert(writeAfterClosure.status === 410, "a closed workspace accepted a write");
  assert(reopened.status === 200, "the administrator who closed it could not reopen it");

  console.log("\n12. Revocations are on the audit trail, and the chain still verifies");
  let trail: any = null;
  for (let attempt = 0; attempt < 10 && !trail; attempt++) {
    await new Promise((r) => setTimeout(r, 200));
    const fresh = await post("/auth/login", { email: admin.email, password: admin.password });
    if (fresh.status !== 200) continue;
    const mfaToken = fresh.body.mfaToken as string;
    const verified = await post("/auth/mfa/verify", {
      mfaToken,
      code: code(setup.body.secret, stepAt() + 1),
    });
    if (verified.status !== 200) continue;
    const events = await get("/audit?action=organization.sessions.revoked&limit=5", verified.body.token);
    trail = (events.body?.events as any[])?.find((e) => e.target === admin.orgId);
  }
  console.log(`-> ${trail?.actorEmail} ended every session in ${trail?.target}`);
  assert(!!trail, "a workspace-wide revocation was not recorded");

  const chain = await verifyAuditChain();
  console.log(`-> ${chain.checked} event(s) checked, ok: ${chain.ok}`);
  assert(chain.ok, `the audit chain broke at row ${chain.brokenAt}: ${chain.reason}`);

  console.log("\n=== SESSION REVOCATION VERIFIED ===");
  console.log("A token says who you are. What you may do is read from the database on");
  console.log("every request, so deactivation, removal, demotion, an MFA requirement,");
  console.log("and an explicit revocation all take effect on the next request rather");
  console.log("than at the next sign-in.");
}

run()
  .then(async () => {
    await Promise.all([pool.end(), authPool.end(), adminPool.end()]);
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nSESSION TEST FAILED:", e.message);
    await Promise.all([pool.end(), authPool.end(), adminPool.end()]).catch(() => {});
    process.exit(1);
  });
