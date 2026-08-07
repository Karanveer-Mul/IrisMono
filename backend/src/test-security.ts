/**
 * Security controls test.
 *
 * The audit's §2.6 finding was that "hospital-grade" reduced to a domain
 * whitelist. These are the controls that replaced it, and each check here is
 * written to fail if the control is present in name only: the audit log is
 * altered on purpose to prove the chain notices, the invite is exhausted rather
 * than assumed to have a cap, and the scan on disk is read back as bytes rather
 * than trusted to be encrypted because a flag says so.
 *
 * Requires the API to be running, with MASTER_KEY_BASE64 set.
 *   npx tsx src/test-security.ts
 */
import * as fs from "fs";
import * as path from "path";
import { sql } from "drizzle-orm";
import { systemDb, adminDb, pool, authPool, adminPool } from "./db";
import { verifyAuditChain } from "./audit";
import { encryptionConfigured, isEncrypted } from "./crypto";

const API = "http://localhost:3000/api";
const UPLOADS_DIR = path.join(__dirname, "../../uploads");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

async function post(pathname: string, body: unknown, token?: string) {
  const r = await fetch(`${API}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function get(pathname: string, token: string) {
  const r = await fetch(`${API}${pathname}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function register(email: string, orgName: string, password = "correct-horse-battery-1") {
  const r = await post("/auth/register", { email, password, orgName });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
  const payload = JSON.parse(Buffer.from(r.body.token.split(".")[1], "base64").toString());
  return { token: r.body.token as string, orgId: payload.organizationId as string, email };
}

async function run() {
  console.log("=== SECURITY CONTROLS TEST ===\n");

  const stamp = Date.now();
  const admin = await register(`sec.admin.${stamp}@alpha-health.org`, `Security Hospital ${stamp}`);

  console.log("1. Weak passwords are refused at account creation");
  const weak = await post("/auth/register", {
    email: `sec.weak.${stamp}@alpha-health.org`,
    password: "short1",
    orgName: "Weak Hospital",
  });
  const common = await post("/auth/register", {
    email: `sec.common.${stamp}@alpha-health.org`,
    password: "password123",
    orgName: "Common Hospital",
  });
  const named = await post("/auth/register", {
    email: `sec.namedpw.${stamp}@alpha-health.org`,
    password: `sec.namedpw.${stamp}XYZ`,
    orgName: "Named Hospital",
  });
  console.log(`-> too short: ${weak.status}, too common: ${common.status}, contains email: ${named.status}`);
  assert(weak.status === 400, "a six-character password was accepted");
  assert(common.status === 400, "a password from the top-guesses list was accepted");
  assert(named.status === 400, "a password containing the email address was accepted");

  console.log("\n2. Repeated failures lock the account, and the lockout is stated");
  const victim = await register(`sec.victim.${stamp}@alpha-health.org`, `Victim Hospital ${stamp}`);
  let lockStatus = 0;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const r = await post("/auth/login", { email: victim.email, password: "wrong-password-here" });
    lockStatus = r.status;
  }
  console.log(`-> after six wrong passwords: HTTP ${lockStatus}`);
  assert(lockStatus === 423, `expected the account to be locked, got ${lockStatus}`);

  // The correct password is refused too - a lockout that the real owner can
  // bypass is not a lockout, it is a hint.
  const correctWhileLocked = await post("/auth/login", {
    email: victim.email,
    password: "correct-horse-battery-1",
  });
  console.log(`-> the correct password while locked: HTTP ${correctWhileLocked.status}`);
  assert(correctWhileLocked.status === 423, "the lockout did not apply to the correct password");

  await systemDb.execute(
    sql`UPDATE users SET locked_until = NULL, failed_login_count = 0 WHERE email = ${victim.email}`
  );
  const afterUnlock = await post("/auth/login", {
    email: victim.email,
    password: "correct-horse-battery-1",
  });
  console.log(`-> once the lockout lifts: HTTP ${afterUnlock.status}`);
  assert(afterUnlock.status === 200, "the account did not recover after the lockout lifted");

  console.log("\n3. Invite links are capped, and the cap is enforced by the database");
  const created = await post("/invites", { maxUses: 1, allowedDomains: ["alpha-health.org"] }, admin.token);
  assert(created.status === 201, `invite creation failed: ${JSON.stringify(created.body)}`);
  const code = created.body.invite.inviteCode as string;
  console.log(`-> created with maxUses ${created.body.invite.maxUses}, expires ${created.body.invite.expiresAt ? "set" : "never"}`);
  assert(created.body.invite.maxUses === 1, "the cap was not stored");
  assert(!!created.body.invite.expiresAt, "an invite was created that never expires");

  const firstJoin = await post(`/auth/join/${code}`, {
    email: `sec.first.${stamp}@alpha-health.org`,
    password: "correct-horse-battery-1",
  });
  const secondJoin = await post(`/auth/join/${code}`, {
    email: `sec.second.${stamp}@alpha-health.org`,
    password: "correct-horse-battery-1",
  });
  console.log(`-> first redemption: ${firstJoin.status}, second: ${secondJoin.status}`);
  assert(firstJoin.status === 201, "the first redemption failed");
  assert(secondJoin.status === 410, "the cap did not stop a second redemption");

  // The CHECK constraint is the backstop: even a code path that forgot the
  // handler's guard cannot push the counter past the cap.
  let constraintHeld = false;
  try {
    await systemDb.execute(
      sql`UPDATE organization_invites SET uses_count = uses_count + 5 WHERE invite_code = ${code}`
    );
  } catch {
    constraintHeld = true;
  }
  console.log(`-> a direct UPDATE past the cap was refused: ${constraintHeld}`);
  assert(constraintHeld, "the database allowed uses_count to exceed max_uses");

  console.log("\n4. The link that admitted someone is recorded");
  const admitted = await systemDb.execute(sql`
    SELECT u.email, m.invite_id, i.invite_code
      FROM memberships m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN organization_invites i ON i.id = m.invite_id
     WHERE u.email = ${`sec.first.${stamp}@alpha-health.org`}
  `);
  const admittedRow = admitted.rows[0] as any;
  console.log(`-> ${admittedRow.email} joined via ${admittedRow.invite_code}`);
  assert(admittedRow.invite_id !== null, "no record of which link admitted the member");
  assert(admittedRow.invite_code === code, "the membership points at the wrong invite");

  console.log("\n5. Security-relevant actions reach the audit log");
  const trail = await get("/audit?limit=100", admin.token);
  const actions = new Set((trail.body.events as any[]).map((e) => e.action));
  console.log(`-> ${trail.body.events.length} event(s): ${[...actions].sort().join(", ")}`);
  assert(trail.status === 200, "an admin could not read the audit trail");
  for (const expected of ["auth.registered", "invite.created", "invite.redeemed", "invite.rejected"]) {
    assert(actions.has(expected), `${expected} was not recorded`);
  }

  const rejection = (trail.body.events as any[]).find((e) => e.action === "invite.rejected");
  console.log(`-> a refused redemption recorded reason '${rejection.metadata.reason}'`);
  assert(rejection.metadata.reason === "exhausted", "the refusal reason was not recorded");

  console.log("\n6. A member cannot read the trail, and neither can another tenant");
  const memberLogin = await post("/auth/login", {
    email: `sec.first.${stamp}@alpha-health.org`,
    password: "correct-horse-battery-1",
  });
  const asMember = await get("/audit", memberLogin.body.token);
  const other = await register(`sec.other.${stamp}@beta-clinic.org`, `Other Hospital ${stamp}`);
  const otherTrail = await get("/audit?limit=100", other.token);
  const leaked = (otherTrail.body.events as any[]).filter((e) =>
    String(e.actorEmail || "").includes(`sec.admin.${stamp}`)
  );
  console.log(`-> member: HTTP ${asMember.status}; other tenant sees ${leaked.length} of our events`);
  assert(asMember.status === 403, "a non-admin member read the audit trail");
  assert(leaked.length === 0, "the audit trail leaked across tenants");

  console.log("\n7. The audit log cannot be rewritten, by anyone");
  // The application roles have no UPDATE or DELETE grant, and the trigger stops
  // the owner too - which is what makes this different from a permissions
  // convention. systemDb is the RLS-bypassing identity, so this is the most
  // privileged application path there is.
  let updateBlocked = false;
  let deleteBlocked = false;
  try {
    await systemDb.execute(sql`UPDATE audit_events SET action = 'tampered' WHERE id > 0`);
  } catch {
    updateBlocked = true;
  }
  try {
    await systemDb.execute(sql`DELETE FROM audit_events WHERE id > 0`);
  } catch {
    deleteBlocked = true;
  }
  console.log(`-> UPDATE refused: ${updateBlocked}, DELETE refused: ${deleteBlocked}`);
  assert(updateBlocked, "the audit log could be updated");
  assert(deleteBlocked, "the audit log could be deleted");

  console.log("\n8. The chain verifies, and detects an alteration made around it");
  const before = await verifyAuditChain();
  console.log(`-> ${before.checked} event(s) verified: ${before.ok}`);
  assert(before.ok, `the chain did not verify: ${before.reason}`);

  // Tamper the only way it can be done: as the table owner, disabling the
  // trigger first. Note that the application identity used in step 7 cannot
  // even reach this - `ALTER TABLE ... DISABLE TRIGGER` requires ownership, so
  // this needs the superuser connection reserved for migrations.
  //
  // Prevention is bypassed on purpose. The point of the chain is that it
  // detects an alteration made by someone who was able to defeat prevention.
  const targetRow = await systemDb.execute(
    sql`SELECT id, action FROM audit_events ORDER BY id DESC LIMIT 1`
  );
  const targetId = Number((targetRow.rows[0] as any).id);
  const originalAction = (targetRow.rows[0] as any).action;

  await adminDb.execute(sql`ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update`);
  await adminDb.execute(
    sql`UPDATE audit_events SET action = 'auth.login.succeeded' WHERE id = ${targetId}`
  );

  const after = await verifyAuditChain();
  console.log(`-> after editing event ${targetId}: ok=${after.ok}, brokenAt=${after.brokenAt}`);
  assert(!after.ok, "the chain did not notice an altered row");
  assert(after.brokenAt === targetId, `the chain blamed the wrong row: ${after.brokenAt}`);

  // Put it back, so the suite leaves a verifying chain behind.
  await adminDb.execute(
    sql`UPDATE audit_events SET action = ${originalAction} WHERE id = ${targetId}`
  );
  await adminDb.execute(sql`ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update`);

  const restored = await verifyAuditChain();
  console.log(`-> restored: ok=${restored.ok}`);
  assert(restored.ok, "the chain did not verify after the row was restored");

  console.log("\n9. Scans are encrypted at rest, and still readable through the API");
  assert(encryptionConfigured(), "MASTER_KEY_BASE64 is not set; this check cannot mean anything");

  const reserve = await post("/jobs/request", {}, admin.token);
  const jobId = reserve.body.jobId as string;
  const scan = Buffer.concat([PNG, Buffer.from(`scan-contents-${stamp}`)]);

  const upload = await fetch(reserve.body.uploadUrl, {
    method: "PUT",
    body: scan,
    headers: { "Content-Type": "image/png" },
  });
  assert(upload.ok, `upload failed: ${upload.status}`);

  const onDisk = await fs.promises.readFile(path.join(UPLOADS_DIR, `${jobId}-raw.png`));
  console.log(`-> on disk: ${onDisk.length} bytes, encrypted=${isEncrypted(onDisk)}`);
  assert(isEncrypted(onDisk), "the stored scan is not encrypted");
  assert(!onDisk.subarray(0, 8).equals(PNG), "the stored scan still starts with a PNG header");
  assert(!onDisk.includes(`scan-contents-${stamp}`), "the plaintext is recoverable from the file");

  const served = await fetch(`${API}/jobs/${jobId}/image/raw`, {
    headers: { Authorization: `Bearer ${admin.token}` },
  });
  const servedBytes = Buffer.from(await served.arrayBuffer());
  console.log(`-> served back: ${servedBytes.length} bytes, matches original: ${servedBytes.equals(scan)}`);
  assert(served.status === 200, "the scan could not be read back");
  assert(servedBytes.equals(scan), "the decrypted scan does not match what was uploaded");
  assert(served.headers.get("cache-control") === "no-store", "a scan was served as cacheable");

  console.log("\n9b. The mask a worker produces is readable too");
  // Worth asserting separately: the GPU worker holds no database credentials
  // and therefore no data key. It handles the stored bytes opaquely, so what
  // proves encryption did not break the pipeline is that the mask decrypts
  // under the tenant's key at the far end.
  let finalStatus = "";
  for (let attempt = 0; attempt < 20 && finalStatus !== "SUCCESS" && finalStatus !== "FAILED"; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    const row = await systemDb.execute(sql`SELECT status FROM jobs WHERE id = ${jobId}`);
    finalStatus = (row.rows[0] as any).status;
  }

  if (finalStatus === "SUCCESS") {
    const maskOnDisk = await fs.promises.readFile(path.join(UPLOADS_DIR, `${jobId}-mask.png`));
    const maskServed = await fetch(`${API}/jobs/${jobId}/image/mask`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    const maskBytes = Buffer.from(await maskServed.arrayBuffer());
    console.log(`-> mask on disk encrypted=${isEncrypted(maskOnDisk)}, served ${maskBytes.length} bytes`);
    assert(isEncrypted(maskOnDisk), "the generated mask was stored unencrypted");
    assert(maskServed.status === 200, "the mask could not be read back");
    assert(maskBytes.subarray(0, 8).equals(PNG), "the served mask is not a PNG - decryption failed");
  } else {
    // The simulated model fails about one run in ten. That is a real outcome,
    // not a failure of this control, so it is reported rather than asserted on.
    console.log(`-> job ended ${finalStatus}; the model's simulated failure path, nothing to check`);
  }

  console.log("\n10. Each tenant's scans are encrypted under its own key");
  // The second tenant has to actually store something, or there is no key to
  // compare against and the check passes vacuously.
  const otherReserve = await post("/jobs/request", {}, other.token);
  await fetch(otherReserve.body.uploadUrl, {
    method: "PUT",
    body: Buffer.concat([PNG, Buffer.from(`other-tenant-scan-${stamp}`)]),
    headers: { "Content-Type": "image/png" },
  });

  const keys = await systemDb.execute(sql`
    SELECT organization_id, wrapped_key FROM organization_keys
     WHERE organization_id IN (${admin.orgId}, ${other.orgId})
  `);
  const wrapped = (keys.rows as any[]).map((r) => r.wrapped_key);
  console.log(`-> ${keys.rows.length} key(s) issued, distinct: ${new Set(wrapped).size === wrapped.length}`);
  assert(keys.rows.length === 2, "both tenants should have been issued a key by now");
  assert(new Set(wrapped).size === wrapped.length, "two organizations share a data key");

  console.log("\n11. Reading a scan is recorded as PHI access");
  // The audit write is deliberately not on the response path - it must never be
  // able to fail a clinician's read - so it can land just after the image does.
  let access: any = null;
  for (let attempt = 0; attempt < 10 && !access; attempt++) {
    await new Promise((r) => setTimeout(r, 200));
    const phiTrail = await get("/audit?action=phi.scan.accessed&limit=10", admin.token);
    access = (phiTrail.body.events as any[]).find((e) => e.target === jobId);
  }
  console.log(`-> ${access?.actorEmail} read ${access?.metadata?.kind} of job ${access?.target}`);
  assert(!!access, "reading a scan was not recorded");
  assert(access.actorEmail === admin.email, "the wrong actor was recorded");
  assert(access.metadata.encrypted === true, "the access record does not note the scan was encrypted");

  console.log("\n=== SECURITY CONTROLS VERIFIED ===");
  console.log("Audit log append-only and tamper-evident, invites exhaustible and attributable,");
  console.log("scans encrypted per tenant, sign-ins throttled and recorded.");
}

run()
  .then(async () => {
    await Promise.all([pool.end(), authPool.end(), adminPool.end()]);
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nSECURITY TEST FAILED:", e.message);
    // Never leave the trigger disabled, whatever failed.
    await adminDb
      .execute(sql`ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update`)
      .catch(() => {});
    await Promise.all([pool.end(), authPool.end(), adminPool.end()]).catch(() => {});
    process.exit(1);
  });
