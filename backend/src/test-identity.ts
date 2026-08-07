/**
 * Identity model test.
 *
 * users.organization_id was a single FK with the role on the user row, so one
 * person belonged to exactly one organization and their role was global. This
 * asserts the shape that replaced it: the same person in two organizations,
 * with a different role in each, switching between them without the tenants
 * ever seeing each other.
 *
 * Requires the API to be running. Run with:
 *   npx tsx src/test-identity.ts
 */
import { and, eq } from "drizzle-orm";
import { systemDb, withTenant, pool, authPool, adminPool } from "./db";
import { memberships, users } from "./db/schema";

const API = "http://localhost:3000/api";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function decode(token: string) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
}

async function post(path: string, body: unknown, token?: string) {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function get(path: string, token: string) {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function run() {
  console.log("=== IDENTITY MODEL TEST ===\n");

  const stamp = Date.now();
  const consultant = `radiologist.${stamp}@stjude.org`;
  const password = "secure_password_123";

  console.log("1. Person creates their own workspace and is its ORG_ADMIN");
  const created = await post("/auth/register", {
    email: consultant,
    password,
    orgName: `Consulting Practice ${stamp}`,
  });
  assert(created.status === 201, "registration failed");
  const practiceToken = created.body.token as string;
  const practiceId = decode(practiceToken).organizationId as string;
  console.log(`-> practice ${practiceId}, role ${decode(practiceToken).role}`);
  assert(decode(practiceToken).role === "ORG_ADMIN", "creator is not ORG_ADMIN");

  console.log("\n2. A hospital invites the same person as a MEMBER");
  const hospital = await post("/auth/register", {
    email: `director.${stamp}@stjude.org`,
    password,
    orgName: `St. Jude Hospital ${stamp}`,
  });
  assert(hospital.status === 201, "hospital registration failed");
  const hospitalAdminToken = hospital.body.token as string;
  const hospitalId = decode(hospitalAdminToken).organizationId as string;

  const invite = await post("/invites", { expiresDays: 1 }, hospitalAdminToken);
  assert(invite.status === 201, "invite creation failed");
  const code = invite.body.invite.inviteCode as string;

  // The pre-memberships schema refused this outright: the email already existed.
  const joined = await post(`/auth/join/${code}`, { email: consultant, password });
  console.log(`-> join returned HTTP ${joined.status}`);
  assert(joined.status === 201, "an existing account could not join a second organization");

  console.log("\n3. One account, two organizations, different roles in each");
  const list = (await get("/auth/memberships", practiceToken)).body.memberships as any[];
  for (const m of list) {
    console.log(`   ${m.role.padEnd(9)} ${m.organizationName}`);
  }
  assert(list.length === 2, `expected 2 memberships, got ${list.length}`);
  assert(list.find((m) => m.organizationId === practiceId)?.role === "ORG_ADMIN", "wrong role in own practice");
  assert(list.find((m) => m.organizationId === hospitalId)?.role === "MEMBER", "wrong role at the hospital");

  const accounts = await systemDb.select().from(users).where(eq(users.email, consultant));
  console.log(`-> ${accounts.length} user row for this person`);
  assert(accounts.length === 1, "a duplicate account was created instead of a membership");

  console.log("\n4. Wrong password cannot attach a membership to someone else's account");
  const hospital2 = await post("/auth/register", {
    email: `director2.${stamp}@stjude.org`,
    password,
    orgName: `Other Hospital ${stamp}`,
  });
  const invite2 = await post("/invites", { expiresDays: 1 }, hospital2.body.token);
  const impostor = await post(`/auth/join/${invite2.body.invite.inviteCode}`, {
    email: consultant,
    password: "not-the-right-password",
  });
  console.log(`-> HTTP ${impostor.status}`);
  assert(impostor.status === 401, "an impostor attached a membership using only an email address");

  console.log("\n5. Switching organizations issues a token scoped to the other one");
  const switched = await post("/auth/switch-organization", { organizationId: hospitalId }, practiceToken);
  assert(switched.status === 200, "switch failed");
  const hospitalToken = switched.body.token as string;
  const claims = decode(hospitalToken);
  console.log(`-> now acting in ${claims.organizationId} as ${claims.role}`);
  assert(claims.organizationId === hospitalId, "token was not rescoped");
  assert(claims.role === "MEMBER", "role did not follow the membership");
  assert(claims.id === decode(practiceToken).id, "switching changed identity");

  console.log("\n6. Role is per organization, so admin powers do not travel");
  const asAdmin = await post("/invites", { expiresDays: 1 }, practiceToken);
  const asMember = await post("/invites", { expiresDays: 1 }, hospitalToken);
  console.log(`-> own practice (ORG_ADMIN): HTTP ${asAdmin.status}; hospital (MEMBER): HTTP ${asMember.status}`);
  assert(asAdmin.status === 201, "ORG_ADMIN could not manage their own organization");
  assert(asMember.status === 403, "MEMBER exercised admin powers via a role carried from elsewhere");

  console.log("\n7. Cannot switch into an organization one does not belong to");
  const outsider = await post("/auth/register", {
    email: `stranger.${stamp}@othercorp.org`,
    password,
    orgName: `Stranger Corp ${stamp}`,
  });
  const trespass = await post("/auth/switch-organization", { organizationId: hospitalId }, outsider.body.token);
  console.log(`-> HTTP ${trespass.status}`);
  assert(trespass.status === 403, "a token was minted for an organization the caller does not belong to");

  console.log("\n8. Each organization sees only its own members");
  const practiceMembers = await withTenant(practiceId, (tx) =>
    tx.select().from(memberships)
  );
  const hospitalMembers = await withTenant(hospitalId, (tx) =>
    tx.select().from(memberships)
  );
  console.log(`-> practice ${practiceMembers.length}, hospital ${hospitalMembers.length}`);
  assert(practiceMembers.every((m) => m.organizationId === practiceId), "membership list leaked across tenants");
  assert(hospitalMembers.every((m) => m.organizationId === hospitalId), "membership list leaked across tenants");

  console.log("\n9. A user row is visible to each organization the person belongs to");
  const seenByPractice = await withTenant(practiceId, (tx) =>
    tx.select().from(users).where(eq(users.email, consultant))
  );
  const seenByStranger = await withTenant(
    decode(outsider.body.token).organizationId,
    (tx) => tx.select().from(users).where(eq(users.email, consultant))
  );
  console.log(`-> practice sees ${seenByPractice.length}, unrelated org sees ${seenByStranger.length}`);
  assert(seenByPractice.length === 1, "an organization could not see its own member");
  assert(seenByStranger.length === 0, "an unrelated organization could read this person's account");

  console.log("\n10. Leaving one organization leaves the other intact");
  await systemDb
    .delete(memberships)
    .where(and(eq(memberships.organizationId, hospitalId), eq(memberships.userId, claims.id)));
  const remaining = (await get("/auth/memberships", practiceToken)).body.memberships as any[];
  console.log(`-> ${remaining.length} membership remaining`);
  assert(remaining.length === 1 && remaining[0].organizationId === practiceId, "removal affected the wrong membership");
  const stillThere = await systemDb.select().from(users).where(eq(users.email, consultant));
  assert(stillThere.length === 1, "removing a membership deleted the account");

  console.log("\n=== IDENTITY VERIFIED: one account, many organizations, role per relationship ===");
}

run()
  .then(async () => {
    await Promise.all([pool.end(), authPool.end(), adminPool.end()]);
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nIDENTITY TEST FAILED:", e.message);
    await Promise.all([pool.end(), authPool.end(), adminPool.end()]).catch(() => {});
    process.exit(1);
  });
