import { Router, Request, Response } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { systemDb } from "../db";
import { users, userRecoveryCodes } from "../db/schema";
import {
  authenticateJWT,
  AuthenticatedRequest,
  readMfaChallengeToken,
} from "../middleware/auth";
import { openWithMasterKey, sealWithMasterKey, encryptionConfigured } from "../crypto";
import {
  checkCode,
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCode,
  otpauthUri,
} from "../mfa";
import { AUDIT_ACTIONS, clientIp, recordAuditEvent } from "../audit";
import { completeSignIn, NoMemberships } from "../session";
import { clearFailedLogins, registerFailedLogin } from "../passwords";

/**
 * Enrolment, challenge, and recovery for the second factor.
 *
 * The shape that matters is that enrolment is two steps. A secret written at
 * setup does nothing until the user produces a code from it, so an enrolment
 * abandoned at the QR screen - the usual outcome when a scan does not work -
 * leaves the account exactly as it was rather than locked out of itself.
 */

const router = Router();

/** Never returned twice. The user writes them down at enrolment or not at all. */
async function issueRecoveryCodes(userId: string): Promise<string[]> {
  const { codes, hashes } = generateRecoveryCodes();

  await systemDb.transaction(async (tx) => {
    // Replacing, not appending: re-enrolling must retire the codes printed for
    // the old secret, or a set someone wrote down two phones ago still works.
    await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
    await tx.insert(userRecoveryCodes).values(hashes.map((codeHash) => ({ userId, codeHash })));
  });

  return codes;
}

/**
 * 1. Current state of the second factor
 */
router.get("/", authenticateJWT, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = await systemDb.query.users.findFirst({ where: eq(users.id, req.user!.id) });

    const remaining = user?.mfaEnabledAt
      ? await systemDb
          .select({ id: userRecoveryCodes.id })
          .from(userRecoveryCodes)
          .where(and(eq(userRecoveryCodes.userId, req.user!.id), isNull(userRecoveryCodes.usedAt)))
      : [];

    return res.status(200).json({
      enabled: !!user?.mfaEnabledAt,
      enabledAt: user?.mfaEnabledAt ?? null,
      pending: !!user?.mfaSecret && !user?.mfaEnabledAt,
      recoveryCodesRemaining: remaining.length,
      // Live, from the workspace's current policy. A session's restricted claim
      // is decided when the token is minted, so it can outlive the requirement
      // that caused it - this is how the enrolment screen can tell someone the
      // requirement was lifted instead of holding them there.
      restricted: !!req.user!.restricted,
    });
  } catch (error) {
    console.error("MFA status error:", error);
    return res.status(500).json({ error: "Failed to read MFA status" });
  }
});

/**
 * 2. Begin enrolment
 *
 * Returns the secret once, in the response, because the authenticator app has
 * to receive it somehow. It is stored wrapped, and MFA is not yet in force.
 */
router.post("/setup", authenticateJWT, async (req: AuthenticatedRequest, res: Response) => {
  // The secret is only as protected as the wrapping key. Refusing here rather
  // than storing it in the clear: an MFA secret sitting readable in a database
  // dump is worse than no MFA, because the account is now believed protected.
  if (!encryptionConfigured()) {
    return res.status(503).json({
      error: "MFA cannot be enrolled without MASTER_KEY_BASE64 set - the secret would be stored unwrapped.",
    });
  }

  try {
    const user = await systemDb.query.users.findFirst({ where: eq(users.id, req.user!.id) });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Re-enrolling with MFA already on would let anyone holding a live session
    // swap the second factor for one of their own. Disable it first, which
    // requires a current code.
    if (user.mfaEnabledAt) {
      return res.status(409).json({
        error: "MFA is already enabled. Disable it with a current code before enrolling again.",
      });
    }

    const secret = generateSecret();

    await systemDb
      .update(users)
      .set({ mfaSecret: sealWithMasterKey(Buffer.from(secret, "utf8")), updatedAt: new Date() })
      .where(eq(users.id, user.id));

    return res.status(200).json({
      secret,
      otpauthUri: otpauthUri(secret, user.email),
      // Said plainly: the next call is what turns this on.
      note: "Scan this, then confirm with a code from the app. MFA is not active until you do.",
    });
  } catch (error) {
    console.error("MFA setup error:", error);
    return res.status(500).json({ error: "Failed to begin MFA enrolment" });
  }
});

/**
 * 3. Finish enrolment
 *
 * Proving one code is what turns MFA on. Recovery codes are returned here and
 * never again - a system that can show them twice is a system where reading the
 * database is enough to bypass the second factor.
 */
router.post("/confirm", authenticateJWT, async (req: AuthenticatedRequest, res: Response) => {
  const { code } = req.body ?? {};

  try {
    const user = await systemDb.query.users.findFirst({ where: eq(users.id, req.user!.id) });

    if (!user?.mfaSecret) {
      return res.status(409).json({ error: "Start enrolment first" });
    }

    if (user.mfaEnabledAt) {
      return res.status(409).json({ error: "MFA is already enabled" });
    }

    const secret = openWithMasterKey(user.mfaSecret).toString("utf8");
    const check = checkCode(secret, String(code ?? ""));

    if (!check.ok) {
      await recordAuditEvent({
        action: AUDIT_ACTIONS.MFA_FAILED,
        organizationId: req.user!.organizationId,
        actorUserId: user.id,
        actorEmail: user.email,
        target: user.email,
        metadata: { stage: "enrolment" },
        ip: clientIp(req),
      });
      return res.status(401).json({ error: "That code is not valid. Check your device's clock." });
    }

    await systemDb
      .update(users)
      .set({ mfaEnabledAt: sql`NOW()`, mfaLastStep: check.step, updatedAt: new Date() })
      .where(eq(users.id, user.id));

    const codes = await issueRecoveryCodes(user.id);

    await recordAuditEvent({
      action: AUDIT_ACTIONS.MFA_ENROLLED,
      organizationId: req.user!.organizationId,
      actorUserId: user.id,
      actorEmail: user.email,
      target: user.email,
      ip: clientIp(req),
    });

    return res.status(200).json({
      enabled: true,
      recoveryCodes: codes,
      note: "Store these now. They are shown once, and each works a single time.",
    });
  } catch (error) {
    console.error("MFA confirm error:", error);
    return res.status(500).json({ error: "Failed to confirm MFA enrolment" });
  }
});

/**
 * 4. Answer the challenge
 *
 * Unauthenticated in the session sense: the caller presents the challenge token
 * from the password step, plus either a code or a recovery code.
 */
router.post("/verify", async (req: Request, res: Response) => {
  const { mfaToken, code, recoveryCode } = req.body ?? {};

  const challenge = typeof mfaToken === "string" ? readMfaChallengeToken(mfaToken) : null;
  if (!challenge) {
    // Expired or forged. Deliberately does not say which - the difference is
    // only useful to someone who did not have one to begin with.
    return res.status(401).json({ error: "Sign in again to continue." });
  }

  try {
    const user = await systemDb.query.users.findFirst({ where: eq(users.id, challenge.id) });

    if (!user?.mfaEnabledAt || !user.mfaSecret) {
      return res.status(409).json({ error: "MFA is not enabled for this account" });
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return res.status(423).json({
        error: "Too many failed attempts. This account is temporarily locked.",
        lockedUntil: user.lockedUntil.toISOString(),
      });
    }

    /** Shared by both failure paths, so neither can forget to count. */
    const reject = async (reason: string, message: string) => {
      // Counted against the same lockout as a wrong password. An attacker who
      // has the password and is guessing six digits is exactly who this limit
      // is for: 1,000,000 codes fall in hours at unlimited request rates.
      const outcome = await registerFailedLogin(user.id);

      await recordAuditEvent({
        action: outcome.locked ? AUDIT_ACTIONS.ACCOUNT_LOCKED : AUDIT_ACTIONS.MFA_FAILED,
        actorUserId: user.id,
        actorEmail: user.email,
        target: user.email,
        metadata: { reason, consecutiveFailures: outcome.failures },
        ip: clientIp(req),
      });

      return res.status(401).json({ error: message });
    };

    let factors: string[];

    if (typeof recoveryCode === "string" && recoveryCode.trim().length > 0) {
      // Claimed conditionally on being unused, in one statement: two requests
      // presenting the same code at once must not both succeed.
      const claimed = await systemDb
        .update(userRecoveryCodes)
        .set({ usedAt: sql`NOW()` })
        .where(
          and(
            eq(userRecoveryCodes.userId, user.id),
            eq(userRecoveryCodes.codeHash, hashRecoveryCode(recoveryCode)),
            isNull(userRecoveryCodes.usedAt)
          )
        )
        .returning({ id: userRecoveryCodes.id });

      if (claimed.length === 0) {
        return reject("bad_recovery_code", "That recovery code is not valid or has already been used.");
      }

      const left = await systemDb
        .select({ id: userRecoveryCodes.id })
        .from(userRecoveryCodes)
        .where(and(eq(userRecoveryCodes.userId, user.id), isNull(userRecoveryCodes.usedAt)));

      await recordAuditEvent({
        action: AUDIT_ACTIONS.MFA_RECOVERY_USED,
        actorUserId: user.id,
        actorEmail: user.email,
        target: user.email,
        // Worth an alert in a real deployment: recovery code use is rare and is
        // what an account takeover looks like when the attacker has the password.
        metadata: { remaining: left.length },
        ip: clientIp(req),
      });

      factors = ["password", "recovery_code"];
    } else {
      const secret = openWithMasterKey(user.mfaSecret).toString("utf8");
      const check = checkCode(secret, String(code ?? ""));

      if (!check.ok) {
        return reject("bad_code", "That code is not valid.");
      }

      // A code is good for a whole 30-second step, so accepting one without
      // burning the step leaves it replayable by anyone who saw it. Conditional
      // on the stored step, so a replay races and loses rather than being
      // checked and then written.
      const burned = await systemDb
        .update(users)
        .set({ mfaLastStep: check.step })
        .where(
          and(
            eq(users.id, user.id),
            sql`(${users.mfaLastStep} IS NULL OR ${users.mfaLastStep} < ${check.step})`
          )
        )
        .returning({ id: users.id });

      if (burned.length === 0) {
        return reject("replayed_code", "That code has already been used.");
      }

      factors = ["password", "totp"];
    }

    await clearFailedLogins(user.id);

    const signedIn = await completeSignIn(user, req, factors);
    return res.status(200).json(signedIn);
  } catch (error) {
    if (error instanceof NoMemberships) {
      return res.status(403).json({
        error: "This account does not belong to any organization. Ask an administrator for an invite link.",
      });
    }
    console.error("MFA verify error:", error);
    return res.status(500).json({ error: "Failed to verify second factor" });
  }
});

/**
 * 5. Turn it off
 *
 * Requires a current code, not just a live session. Otherwise a stolen session
 * is enough to remove the control that exists to make a stolen password
 * insufficient - and the attacker would be the one holding the account.
 */
router.post("/disable", authenticateJWT, async (req: AuthenticatedRequest, res: Response) => {
  const { code } = req.body ?? {};

  try {
    const user = await systemDb.query.users.findFirst({ where: eq(users.id, req.user!.id) });

    if (!user?.mfaEnabledAt || !user.mfaSecret) {
      return res.status(409).json({ error: "MFA is not enabled for this account" });
    }

    const secret = openWithMasterKey(user.mfaSecret).toString("utf8");
    if (!checkCode(secret, String(code ?? "")).ok) {
      await recordAuditEvent({
        action: AUDIT_ACTIONS.MFA_FAILED,
        organizationId: req.user!.organizationId,
        actorUserId: user.id,
        actorEmail: user.email,
        target: user.email,
        metadata: { stage: "disable" },
        ip: clientIp(req),
      });
      return res.status(401).json({ error: "A current code is required to disable MFA." });
    }

    await systemDb.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ mfaSecret: null, mfaEnabledAt: null, mfaLastStep: null, updatedAt: new Date() })
        .where(eq(users.id, user.id));
      // Unused codes are discarded rather than marked used: they were never
      // used, and the disable is already in the audit trail.
      await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, user.id));
    });

    await recordAuditEvent({
      action: AUDIT_ACTIONS.MFA_DISABLED,
      organizationId: req.user!.organizationId,
      actorUserId: user.id,
      actorEmail: user.email,
      target: user.email,
      ip: clientIp(req),
    });

    return res.status(200).json({ enabled: false });
  } catch (error) {
    console.error("MFA disable error:", error);
    return res.status(500).json({ error: "Failed to disable MFA" });
  }
});

export default router;
