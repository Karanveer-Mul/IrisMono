/**
 * Multi-factor authentication test.
 *
 * AUDIT.md §7 called MFA the largest remaining gap, with the caveat that a code
 * generator without enrolment and recovery is a checkbox rather than a control.
 * These checks target the caveat: the parts that decide whether a second factor
 * helps are enrolment that cannot half-succeed, codes that cannot be replayed,
 * recovery codes that work exactly once, and a challenge token that cannot be
 * used as a session.
 *
 * Requires the API to be running, with MASTER_KEY_BASE64 set.
 *   npx tsx src/test-mfa.ts
 */
import { createHmac } from "crypto";
import { eq, sql } from "drizzle-orm";
import { systemDb, adminDb, pool, authPool, adminPool } from "./db";
import { users } from "./db/schema";
import { base32Decode, checkCode, stepAt } from "./mfa";
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

/**
 * An independent TOTP implementation for the test.
 *
 * Deliberately not src/mfa.ts's generator: a test that produces codes with the
 * same function it is checking would pass even if both were wrong. This is
 * RFC 6238 written straight from the specification.
 */
function totp(secret: string, step: number): string {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];

  return String(value % 1_000_000).padStart(6, "0");
}

async function register(email: string, orgName: string, password = "correct-horse-battery-1") {
  const r = await post("/auth/register", { email, password, orgName });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
  const payload = JSON.parse(Buffer.from(r.body.token.split(".")[1], "base64").toString());
  return { token: r.body.token as string, userId: payload.id as string, email, password };
}

async function run() {
  console.log("=== MFA TEST ===\n");

  const stamp = Date.now();
  const user = await register(`mfa.user.${stamp}@mfa-${stamp}.example.org`, `MFA Hospital ${stamp}`);

  console.log("1. Enrolment does not take effect until a code is proven");
  const setup = await post("/auth/mfa/setup", {}, user.token);
  assert(setup.status === 200, `setup failed: ${JSON.stringify(setup.body)}`);
  const secret = setup.body.secret as string;
  assert(/^[A-Z2-7]{32}$/.test(secret), "the secret is not 160 bits of base32");
  assert(
    setup.body.otpauthUri.startsWith("otpauth://totp/") && setup.body.otpauthUri.includes("issuer=IrisMono"),
    "the otpauth URI is not one an authenticator app would accept"
  );

  const midEnrolment = await get("/auth/mfa", user.token);
  console.log(`-> after setup: enabled ${midEnrolment.body.enabled}, pending ${midEnrolment.body.pending}`);
  assert(midEnrolment.body.enabled === false, "MFA took effect before a code was proven");
  assert(midEnrolment.body.pending === true, "the pending enrolment was not reported");

  // The account must still sign in normally at this point - an abandoned
  // enrolment that locks someone out is worse than no enrolment.
  const midLogin = await post("/auth/login", { email: user.email, password: user.password });
  console.log(`-> sign-in during a half-finished enrolment: HTTP ${midLogin.status}, mfaRequired ${!!midLogin.body.mfaRequired}`);
  assert(midLogin.status === 200 && !midLogin.body.mfaRequired, "an abandoned enrolment blocked sign-in");

  console.log("\n2. The secret is not stored in the clear");
  const stored = await adminDb.execute(
    sql`SELECT mfa_secret FROM users WHERE id = ${user.userId}`
  );
  const storedSecret = (stored.rows[0] as any).mfa_secret as string;
  console.log(`-> stored as ${storedSecret.slice(0, 16)}... (${storedSecret.length} chars)`);
  assert(!storedSecret.includes(secret), "the MFA secret is readable in the database");

  console.log("\n3. A wrong code does not enable it; a right one does");
  const wrongConfirm = await post("/auth/mfa/confirm", { code: "000000" }, user.token);
  assert(wrongConfirm.status === 401, `a wrong code enrolled MFA (HTTP ${wrongConfirm.status})`);

  const confirm = await post("/auth/mfa/confirm", { code: totp(secret, stepAt()) }, user.token);
  assert(confirm.status === 200, `confirm failed: ${JSON.stringify(confirm.body)}`);
  const recoveryCodes = confirm.body.recoveryCodes as string[];
  console.log(`-> enabled, ${recoveryCodes.length} recovery code(s) issued`);
  assert(recoveryCodes.length === 10, "ten recovery codes were not issued");
  assert(new Set(recoveryCodes).size === 10, "the recovery codes are not distinct");

  console.log("\n4. The password alone stops being a sign-in");
  const challenged = await post("/auth/login", { email: user.email, password: user.password });
  console.log(`-> HTTP ${challenged.status}, mfaRequired ${challenged.body.mfaRequired}, session token: ${!!challenged.body.token}`);
  assert(challenged.body.mfaRequired === true, "the password alone still signed in");
  assert(!challenged.body.token, "a session token was issued before the second factor");
  const mfaToken = challenged.body.mfaToken as string;

  console.log("\n5. The challenge token is not a session");
  const misused = await get("/auth/profile", mfaToken);
  console.log(`-> using it as a Bearer credential: HTTP ${misused.status}`);
  assert(misused.status === 403, `a challenge token was accepted as a session (HTTP ${misused.status})`);

  console.log("\n6. A correct code completes the sign-in");
  // One step ahead of now: the enrolment in step 3 legitimately burned the
  // current step, and the next code the user's app shows is the one they would
  // actually type. Within the drift window, so the API accepts it.
  const step = stepAt() + 1;
  const verified = await post("/auth/mfa/verify", { mfaToken, code: totp(secret, step) });
  console.log(`-> HTTP ${verified.status}, session token: ${!!verified.body.token}`);
  assert(verified.status === 200 && !!verified.body.token, `verify failed: ${JSON.stringify(verified.body)}`);

  const profile = await get("/auth/profile", verified.body.token);
  assert(profile.status === 200, "the issued session does not work");

  console.log("\n7. The same code cannot be used twice inside its window");
  const second = await post("/auth/login", { email: user.email, password: user.password });
  const replay = await post("/auth/mfa/verify", { mfaToken: second.body.mfaToken, code: totp(secret, step) });
  console.log(`-> replaying the code from step ${step}: HTTP ${replay.status}`);
  assert(replay.status === 401, `a code was accepted twice (HTTP ${replay.status})`);
  assert(!replay.body.token, "a session was issued for a replayed code");

  console.log("\n8. Clock drift of one step is tolerated, two is not");
  // Checked against the module directly: driving it through the API would need
  // the test to wait out real 30-second windows.
  const now = new Date();
  const early = checkCode(secret, totp(secret, stepAt(now) - 1), now);
  const late = checkCode(secret, totp(secret, stepAt(now) + 1), now);
  const tooEarly = checkCode(secret, totp(secret, stepAt(now) - 2), now);
  console.log(`-> one step behind: ${early.ok}, one ahead: ${late.ok}, two behind: ${tooEarly.ok}`);
  assert(early.ok && late.ok, "a phone one step out of sync was refused");
  assert(!tooEarly.ok, "the drift window is wider than one step");

  console.log("\n9. A recovery code works once, and only once");
  const forRecovery = await post("/auth/login", { email: user.email, password: user.password });
  const recovered = await post("/auth/mfa/verify", {
    mfaToken: forRecovery.body.mfaToken,
    recoveryCode: recoveryCodes[0],
  });
  console.log(`-> first use: HTTP ${recovered.status}`);
  assert(recovered.status === 200 && !!recovered.body.token, "a recovery code did not work");

  const reuse = await post("/auth/login", { email: user.email, password: user.password });
  const reused = await post("/auth/mfa/verify", {
    mfaToken: reuse.body.mfaToken,
    recoveryCode: recoveryCodes[0],
  });
  console.log(`-> second use: HTTP ${reused.status}`);
  assert(reused.status === 401, `a recovery code worked twice (HTTP ${reused.status})`);

  // Written down transcription-style: whitespace and case must not matter, or
  // the codes fail exactly when someone is reading them off paper under stress.
  const sloppy = await post("/auth/login", { email: user.email, password: user.password });
  const sloppyUse = await post("/auth/mfa/verify", {
    mfaToken: sloppy.body.mfaToken,
    recoveryCode: `  ${recoveryCodes[1].toUpperCase()} `,
  });
  console.log(`-> the same code typed with stray spaces and capitals: HTTP ${sloppyUse.status}`);
  assert(sloppyUse.status === 200, "a correctly transcribed recovery code was refused");

  const status = await get("/auth/mfa", sloppyUse.body.token);
  console.log(`-> ${status.body.recoveryCodesRemaining} recovery code(s) left`);
  assert(status.body.recoveryCodesRemaining === 8, "used recovery codes are still counted as available");

  console.log("\n10. Guessing is throttled by the same lockout as the password");
  const guessing = await register(`mfa.guess.${stamp}@mfa-${stamp}.example.org`, `Guess Hospital ${stamp}`);
  const guessSetup = await post("/auth/mfa/setup", {}, guessing.token);
  await post("/auth/mfa/confirm", { code: totp(guessSetup.body.secret, stepAt()) }, guessing.token);

  let guessStatus = 0;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const challenge = await post("/auth/login", { email: guessing.email, password: guessing.password });
    if (challenge.body.mfaToken) {
      const r = await post("/auth/mfa/verify", { mfaToken: challenge.body.mfaToken, code: "000000" });
      guessStatus = r.status;
    } else {
      guessStatus = challenge.status;
    }
  }
  console.log(`-> after six wrong codes: HTTP ${guessStatus}`);
  assert(guessStatus === 423, `code guessing is not rate limited (HTTP ${guessStatus})`);

  console.log("\n11. Disabling requires a current code, not just a session");
  await systemDb.update(users).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, user.userId));

  // The burned step is cleared here on purpose. Replay refusal is what step 7
  // covers; this check is about the disable path, and a real user would simply
  // be waiting for their app to roll over rather than being unable to sign in.
  await adminDb.execute(sql`UPDATE users SET mfa_last_step = NULL WHERE id = ${user.userId}`);

  const session = await post("/auth/login", { email: user.email, password: user.password });
  const live = await post("/auth/mfa/verify", {
    mfaToken: session.body.mfaToken,
    code: totp(secret, stepAt()),
  });
  const sessionToken = live.body.token as string | undefined;
  assert(!!sessionToken, `could not obtain a session to test disabling: ${JSON.stringify(live.body)}`);

  const refusedDisable = await post("/auth/mfa/disable", { code: "000000" }, sessionToken);
  console.log(`-> disable without a code: HTTP ${refusedDisable.status}`);
  assert(refusedDisable.status === 401, "a stolen session alone could remove the second factor");

  // Disabling does not consult mfa_last_step - a code proves possession here
  // rather than authorising a sign-in, and there is no session to replay it for.
  const disabled = await post("/auth/mfa/disable", { code: totp(secret, stepAt()) }, sessionToken);
  console.log(`-> disable with a current code: HTTP ${disabled.status}`);
  assert(disabled.status === 200, `disable failed: ${JSON.stringify(disabled.body)}`);

  const codesLeft = await adminDb.execute(
    sql`SELECT count(*)::int AS n FROM user_recovery_codes WHERE user_id = ${user.userId}`
  );
  console.log(`-> ${(codesLeft.rows[0] as any).n} recovery code(s) remain after disabling`);
  assert((codesLeft.rows[0] as any).n === 0, "recovery codes outlived the second factor they belonged to");

  const plain = await post("/auth/login", { email: user.email, password: user.password });
  assert(!!plain.body.token, "sign-in did not return to password-only after disabling");

  console.log("\n12. Every step of it is in the audit trail");
  let trail: any[] = [];
  for (let attempt = 0; attempt < 10 && trail.length < 4; attempt++) {
    await new Promise((r) => setTimeout(r, 200));
    const events = await adminDb.execute(sql`
      SELECT action FROM audit_events
       WHERE actor_user_id = ${user.userId} AND action LIKE 'auth.mfa.%'
    `);
    trail = events.rows as any[];
  }
  const actions = new Set(trail.map((e) => e.action));
  console.log(`-> ${[...actions].sort().join(", ")}`);
  for (const expected of ["auth.mfa.enrolled", "auth.mfa.failed", "auth.mfa.recovery_used", "auth.mfa.disabled"]) {
    assert(actions.has(expected), `${expected} was not recorded`);
  }

  // A sign-in has to say which factors were used, or an investigation cannot
  // tell whether MFA was in force at the time.
  const factored = await adminDb.execute(sql`
    SELECT metadata->'factors' AS factors FROM audit_events
     WHERE actor_user_id = ${user.userId} AND action = 'auth.login.succeeded'
     ORDER BY id DESC
  `);
  const recorded = (factored.rows as any[]).map((r) => JSON.stringify(r.factors));
  console.log(`-> recorded sign-in factors: ${[...new Set(recorded)].join(" | ")}`);
  assert(recorded.some((f) => f.includes("totp")), "a TOTP sign-in was not recorded as one");
  assert(recorded.some((f) => f.includes("recovery_code")), "a recovery sign-in was not recorded as one");

  console.log("\n13. The audit chain still verifies");
  const chain = await verifyAuditChain();
  console.log(`-> ${chain.checked} event(s) checked, ok: ${chain.ok}`);
  assert(chain.ok, `the audit chain broke at row ${chain.brokenAt}: ${chain.reason}`);

  console.log("\n=== MFA VERIFIED ===");
  console.log("Enrolment cannot half-succeed, codes cannot be replayed, recovery codes work");
  console.log("once, and the challenge token cannot be spent as a session.");
}

run()
  .then(async () => {
    await Promise.all([pool.end(), authPool.end(), adminPool.end()]);
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nMFA TEST FAILED:", e.message);
    await Promise.all([pool.end(), authPool.end(), adminPool.end()]).catch(() => {});
    process.exit(1);
  });
