import { Router, Request, Response } from "express";
// Registration, login, and invite redemption all identify a row before any
// organization context exists (by email, or by invite code), so they run on the
// RLS-bypassing system identity. Everything with a known tenant uses withTenant.
import { systemDb, withTenant } from "../db";
import { organizations, users, memberships, organizationInvites } from "../db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";
import * as bcrypt from "bcryptjs";
import * as jwt from "jsonwebtoken";
import { isEmailDomainAllowed, getEmailDomain } from "../utils/domain";
import { authenticateJWT, AuthenticatedRequest, issueStreamToken, requireRole } from "../middleware/auth";
import {
  assertOrganizationActive,
  closeOrganization,
  OrganizationClosed,
  reopenOrganization,
} from "../lifecycle";
import { grantCredits } from "../credits";
import { AUDIT_ACTIONS, clientIp, recordAuditEvent } from "../audit";
import { checkPasswordStrength, clearFailedLogins, registerFailedLogin } from "../passwords";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "super-secret-medical-saas-key-change-in-production";

/** Seeded to a new workspace on creation (arch.md section 3). */
const TRIAL_CREDITS = 3;

/**
 * A session token is scoped to ONE organization - the one the user is currently
 * acting in. A person may belong to several; switching is a new token, issued by
 * POST /switch-organization after verifying the membership.
 *
 * Keeping the active tenant in the token is what lets every downstream route go
 * on reading req.user.organizationId, and what keeps the RLS context a single
 * unambiguous value per request.
 */
function issueSessionToken(user: { id: string; email: string }, orgId: string, role: "ORG_ADMIN" | "MEMBER") {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      organizationId: orgId,
      role,
    },
    JWT_SECRET,
    { expiresIn: "24h" }
  );
}

/**
 * Every organization this person belongs to, with their role in each.
 *
 * Closed workspaces are excluded rather than deleted from memberships: the
 * membership row is the answer to "who had access to this tenant", which
 * outlives the tenant being switched off. Excluding here is also what makes
 * closure effective - no new token can name an organization that does not
 * appear in this list.
 */
async function membershipsOf(userId: string) {
  const rows = await systemDb
    .select({
      organizationId: memberships.organizationId,
      role: memberships.role,
      organizationName: organizations.name,
    })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
    .where(and(eq(memberships.userId, userId), isNull(organizations.deletedAt)));

  return rows;
}

/**
 * 1. First-In Creator Signup
 * Creates a new Organization, seeds it with trial credits, sets the allowed
 * domain to the creator's email domain, and makes them its ORG_ADMIN.
 *
 * An existing account may also create an additional workspace: the email is
 * already known, so the password authenticates the person rather than
 * registering a new one.
 */
router.post("/register", async (req: Request, res: Response) => {
  const { email, password, orgName } = req.body;

  if (!email || !password || !orgName) {
    return res.status(400).json({ error: "Missing required fields: email, password, orgName" });
  }

  try {
    const creatorDomain = getEmailDomain(email);
    if (!creatorDomain) {
      return res.status(400).json({ error: "Invalid email domain" });
    }

    const existingUser = await systemDb.query.users.findFirst({
      where: eq(users.email, email),
    });

    // A known email means an existing person creating another workspace, which
    // must be authenticated - otherwise anyone could attach workspaces to
    // someone else's account.
    if (existingUser) {
      const isMatch = await bcrypt.compare(password, existingUser.passwordHash);
      if (!isMatch) {
        return res.status(409).json({
          error: "Email is already registered. Sign in to create an additional workspace.",
        });
      }
    } else {
      // Only checked when a password is actually being set. An existing account
      // adding a workspace is authenticating with a password it already has,
      // and rejecting it here would lock them out of their own account.
      const strength = checkPasswordStrength(password, email);
      if (!strength.ok) {
        return res.status(400).json({ error: strength.error });
      }
    }

    const result = await systemDb.transaction(async (tx) => {
      const [newOrg] = await tx
        .insert(organizations)
        .values({
          name: orgName,
          creditBalance: 0,
          allowedDomains: [creatorDomain],
        })
        .returning();

      await grantCredits(tx, newOrg.id, TRIAL_CREDITS, "TRIAL_GRANT", "New workspace trial credits");

      let user = existingUser;
      if (!user) {
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);
        [user] = await tx.insert(users).values({ email, passwordHash }).returning();
      }

      await tx.insert(memberships).values({
        userId: user!.id,
        organizationId: newOrg.id,
        role: "ORG_ADMIN",
      });

      return {
        token: issueSessionToken(user!, newOrg.id, "ORG_ADMIN"),
        userId: user!.id,
        organizationId: newOrg.id,
      };
    });

    await recordAuditEvent({
      action: AUDIT_ACTIONS.REGISTERED,
      organizationId: result.organizationId,
      actorUserId: result.userId,
      actorEmail: email,
      target: orgName,
      metadata: { existingAccount: !!existingUser, allowedDomain: creatorDomain },
      ip: clientIp(req),
    });

    return res.status(201).json({
      token: result.token,
      memberships: await membershipsOf(result.userId),
    });

  } catch (error) {
    console.error("Registration error:", error);
    return res.status(500).json({ error: "Internal server error during registration" });
  }
});

/**
 * 2. Join Organization via Invite Link
 * Validates the domain whitelist and adds a MEMBER membership.
 *
 * An existing account joining a second organization is the normal case here -
 * a consulting radiologist working across hospitals - so a known email adds a
 * membership rather than being refused, once the password proves who they are.
 */
router.post("/join/:inviteCode", async (req: Request, res: Response) => {
  const { inviteCode } = req.params;
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Missing email or password" });
  }

  try {
    const invite = await systemDb.query.organizationInvites.findFirst({
      where: eq(organizationInvites.inviteCode, inviteCode),
    });

    if (!invite) {
      return res.status(404).json({ error: "Invite link not found" });
    }

    const inviteOrg = await systemDb.query.organizations.findFirst({
      where: eq(organizations.id, invite.organizationId),
    });

    // A closed workspace's links stop working, including ones already in
    // circulation. Closure that left a standing invite live would be a way to
    // acquire a membership nobody is administering.
    if (!inviteOrg || inviteOrg.deletedAt) {
      await recordAuditEvent({
        action: AUDIT_ACTIONS.INVITE_REJECTED,
        organizationId: invite.organizationId,
        actorEmail: email,
        target: invite.inviteCode,
        metadata: { reason: "organization_closed" },
        ip: clientIp(req),
      });
      return res.status(410).json({ error: "This workspace is no longer accepting members" });
    }

    /** Every refusal is recorded against the link, so probing is visible. */
    const rejectInvite = async (reason: string) => {
      await recordAuditEvent({
        action: AUDIT_ACTIONS.INVITE_REJECTED,
        organizationId: invite.organizationId,
        actorEmail: email,
        target: invite.inviteCode,
        metadata: { reason },
        ip: clientIp(req),
      });
    };

    if (!invite.isActive) {
      await rejectInvite("revoked");
      return res.status(410).json({ error: "This invite link has been revoked or deactivated" });
    }

    if (invite.expiresAt && new Date() > invite.expiresAt) {
      await rejectInvite("expired");
      return res.status(410).json({ error: "This invite link has expired" });
    }

    if (invite.maxUses !== null && invite.usesCount >= invite.maxUses) {
      await rejectInvite("exhausted");
      return res.status(410).json({ error: "This invite link has reached its usage limit" });
    }

    // Hospital-grade domain whitelist enforcement. Invite whitelist first, then
    // the organization's.
    let allowedDomains = invite.allowedDomains;
    if (!allowedDomains || allowedDomains.length === 0) {
      allowedDomains = inviteOrg.allowedDomains || [];
    }

    if (!isEmailDomainAllowed(email, allowedDomains)) {
      await rejectInvite("domain_not_allowed");
      return res.status(403).json({
        error: `Registration denied. Your email domain is not authorized for this organization. Whitelist includes: ${allowedDomains.join(", ")}`,
      });
    }

    const existingUser = await systemDb.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (existingUser) {
      const isMatch = await bcrypt.compare(password, existingUser.passwordHash);
      if (!isMatch) {
        await rejectInvite("wrong_password_for_existing_account");
        return res.status(401).json({
          error: "This email already has an account. Use its password to join this organization.",
        });
      }

      const already = await systemDb.query.memberships.findFirst({
        where: and(
          eq(memberships.userId, existingUser.id),
          eq(memberships.organizationId, invite.organizationId)
        ),
      });

      if (already) {
        return res.status(409).json({ error: "You are already a member of this organization" });
      }
    } else {
      const strength = checkPasswordStrength(password, email);
      if (!strength.ok) {
        return res.status(400).json({ error: strength.error });
      }
    }

    const result = await systemDb.transaction(async (tx) => {
      // Consume the use inside the transaction, conditionally on the cap. The
      // CHECK constraint would catch an overrun anyway, but claiming it here
      // means two people redeeming the last use at once are serialised on this
      // row rather than one of them hitting a constraint violation.
      const consumed = await tx.execute(sql`
        UPDATE organization_invites
           SET uses_count = uses_count + 1
         WHERE id = ${invite.id}
           AND is_active = true
           AND (max_uses IS NULL OR uses_count < max_uses)
        RETURNING uses_count, max_uses
      `);

      if (consumed.rows.length === 0) {
        return { exhausted: true as const };
      }

      let user = existingUser;
      if (!user) {
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);
        [user] = await tx.insert(users).values({ email, passwordHash }).returning();
      }

      await tx.insert(memberships).values({
        userId: user!.id,
        organizationId: invite.organizationId,
        role: "MEMBER",
        // Which link admitted this person. Revoking a leaked invite can now
        // answer "and who did it let in?", which it previously could not.
        inviteId: invite.id,
      });

      const row = consumed.rows[0] as any;
      return {
        token: issueSessionToken(user!, invite.organizationId, "MEMBER"),
        userId: user!.id,
        usesCount: Number(row.uses_count),
        maxUses: row.max_uses === null ? null : Number(row.max_uses),
      };
    });

    if ("exhausted" in result) {
      await rejectInvite("exhausted");
      return res.status(410).json({ error: "This invite link has reached its usage limit" });
    }

    await recordAuditEvent({
      action: AUDIT_ACTIONS.INVITE_REDEEMED,
      organizationId: invite.organizationId,
      actorUserId: result.userId,
      actorEmail: email,
      target: invite.inviteCode,
      metadata: {
        inviteId: invite.id,
        existingAccount: !!existingUser,
        usesCount: result.usesCount,
        maxUses: result.maxUses,
      },
      ip: clientIp(req),
    });

    return res.status(201).json({
      token: result.token,
      memberships: await membershipsOf(result.userId),
    });

  } catch (error) {
    console.error("Invite join error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * 3. Standard Login
 *
 * Signs in to the first organization the person belongs to, and returns the
 * full list so a client can offer a switcher.
 */
router.post("/login", async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Missing email or password" });
  }

  try {
    const user = await systemDb.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (!user) {
      // Recorded even though no account exists: a spray across many addresses
      // is exactly the pattern that leaves no trace if only known accounts are
      // logged. The response is unchanged, so nothing is disclosed.
      await recordAuditEvent({
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        actorEmail: email,
        target: email,
        metadata: { reason: "unknown_account" },
        ip: clientIp(req),
      });
      return res.status(401).json({ error: "Invalid email or password" });
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await recordAuditEvent({
        action: AUDIT_ACTIONS.LOGIN_BLOCKED,
        actorUserId: user.id,
        actorEmail: user.email,
        target: user.email,
        metadata: { lockedUntil: user.lockedUntil.toISOString() },
        ip: clientIp(req),
      });
      // 423 rather than 401, and the caller is told when it lifts: hiding the
      // lockout would just look like a wrong password and invite more attempts
      // from the legitimate owner.
      return res.status(423).json({
        error: "Too many failed sign-in attempts. This account is temporarily locked.",
        lockedUntil: user.lockedUntil.toISOString(),
      });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      const outcome = await registerFailedLogin(user.id);

      await recordAuditEvent({
        action: outcome.locked ? AUDIT_ACTIONS.ACCOUNT_LOCKED : AUDIT_ACTIONS.LOGIN_FAILED,
        actorUserId: user.id,
        actorEmail: user.email,
        target: user.email,
        metadata: { reason: "bad_password", consecutiveFailures: outcome.failures },
        ip: clientIp(req),
      });

      return res.status(401).json({ error: "Invalid email or password" });
    }

    // A successful sign-in clears the counter: the lockout is meant to stop a
    // run of guesses, not to accumulate over months of ordinary typos.
    await clearFailedLogins(user.id);

    // Checked after the password rather than before it. Deactivation is not a
    // secret worth protecting from the account's owner, but it is one worth
    // protecting from someone guessing addresses: answering differently before
    // the password is verified turns login into a directory of who used to work
    // here. The account row survives because jobs reference it (migration 0011).
    if (user.deletedAt) {
      await recordAuditEvent({
        action: AUDIT_ACTIONS.LOGIN_BLOCKED,
        actorUserId: user.id,
        actorEmail: user.email,
        target: user.email,
        metadata: { reason: "account_deactivated" },
        ip: clientIp(req),
      });
      return res.status(403).json({ error: "This account has been deactivated." });
    }

    const list = await membershipsOf(user.id);

    if (list.length === 0) {
      return res.status(403).json({
        error: "This account does not belong to any organization. Ask an administrator for an invite link.",
      });
    }

    const active = list[0];

    await recordAuditEvent({
      action: AUDIT_ACTIONS.LOGIN_SUCCEEDED,
      organizationId: active.organizationId,
      actorUserId: user.id,
      actorEmail: user.email,
      target: user.email,
      metadata: { organizations: list.length },
      ip: clientIp(req),
    });

    return res.status(200).json({
      token: issueSessionToken(user, active.organizationId, active.role),
      memberships: list,
    });

  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * 4. Get active profile
 */
router.get("/profile", authenticateJWT, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user!.id;
  const orgId = req.user!.organizationId;

  try {
    // Tenant context is known here, so this runs under RLS.
    const data = await withTenant(orgId, async (tx) => {
      const user = await tx.query.users.findFirst({ where: eq(users.id, userId) });
      const organization = await tx.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
      });
      return { user, organization };
    });

    if (!data.user) {
      return res.status(404).json({ error: "User profile not found" });
    }

    return res.status(200).json({
      user: {
        id: data.user.id,
        email: data.user.email,
        role: req.user!.role,
      },
      organization: data.organization,
      memberships: await membershipsOf(userId),
    });
  } catch (error) {
    console.error("Profile load error:", error);
    return res.status(500).json({ error: "Failed to load user profile" });
  }
});

/**
 * 5. List the organizations this person belongs to
 */
router.get("/memberships", authenticateJWT, async (req: AuthenticatedRequest, res: Response) => {
  try {
    return res.status(200).json({ memberships: await membershipsOf(req.user!.id) });
  } catch (error) {
    console.error("Membership load error:", error);
    return res.status(500).json({ error: "Failed to load organization memberships" });
  }
});

/**
 * 6. Switch the active organization
 *
 * Issues a token scoped to a different organization, but only one the caller
 * actually belongs to - the membership is re-checked here rather than trusted
 * from the request, so a token cannot be minted for an arbitrary tenant.
 */
router.post("/switch-organization", authenticateJWT, async (req: AuthenticatedRequest, res: Response) => {
  const { organizationId } = req.body ?? {};
  const userId = req.user!.id;

  if (!organizationId) {
    return res.status(400).json({ error: "Missing required field: organizationId" });
  }

  try {
    const membership = await systemDb.query.memberships.findFirst({
      where: and(eq(memberships.userId, userId), eq(memberships.organizationId, organizationId)),
    });

    if (!membership) {
      return res.status(403).json({ error: "You are not a member of that organization" });
    }

    const target = await systemDb.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });

    // Re-checked here and not only in membershipsOf: this route takes the
    // organization id from the request body, so a client holding an id from
    // before the closure could otherwise mint a fresh token naming it.
    if (!target || target.deletedAt) {
      return res.status(410).json({ error: "That workspace has been closed" });
    }

    const user = await systemDb.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    await recordAuditEvent({
      action: AUDIT_ACTIONS.ORGANIZATION_SWITCHED,
      organizationId,
      actorUserId: userId,
      actorEmail: user.email,
      target: organizationId,
      metadata: { from: req.user!.organizationId, role: membership.role },
      ip: clientIp(req),
    });

    return res.status(200).json({
      token: issueSessionToken(user, organizationId, membership.role),
    });
  } catch (error) {
    console.error("Organization switch error:", error);
    return res.status(500).json({ error: "Failed to switch organization" });
  }
});

/**
 * 7. Mint a short-lived token for the SSE stream
 *
 * EventSource cannot send an Authorization header, so the stream is
 * authenticated by query parameter instead. These tokens expire in 60 seconds
 * and are rejected by the normal API middleware.
 */
router.post("/stream-token", authenticateJWT, (req: AuthenticatedRequest, res: Response) => {
  return res.status(200).json({ token: issueStreamToken(req.user!) });
});

/**
 * 8. Set how long this workspace's scans are kept
 *
 * Retention is a contract term, negotiated per customer, so it cannot live only
 * in the deployment's environment. Null restores the platform default rather
 * than meaning "keep forever" - a tenant withdrawing a preference should track
 * the deployment's policy, not opt out of retention entirely.
 *
 * Changes are audited both ways. Shortening a window destroys data on a
 * schedule and lengthening one keeps images past what a hospital may have told
 * its patients, so "who changed this, when, from what" has to be answerable.
 */
router.put(
  "/organization/retention",
  authenticateJWT,
  requireRole("ORG_ADMIN"),
  async (req: AuthenticatedRequest, res: Response) => {
    const orgId = req.user!.organizationId;
    const { retentionDays } = req.body ?? {};

    const requested =
      retentionDays === null || retentionDays === undefined ? null : Number(retentionDays);

    if (requested !== null && (!Number.isInteger(requested) || requested < 1 || requested > 3650)) {
      return res.status(400).json({
        error: "retentionDays must be a whole number of days between 1 and 3650, or null for the platform default",
      });
    }

    try {
      const previous = await withTenant(orgId, async (tx) => {
        await assertOrganizationActive(tx, orgId);

        // Read before write, in the same transaction. RETURNING on an UPDATE
        // yields the new row, so it cannot tell us what the value used to be.
        const current = await tx.query.organizations.findFirst({
          where: eq(organizations.id, orgId),
        });

        await tx
          .update(organizations)
          .set({ retentionDays: requested, updatedAt: new Date() })
          .where(eq(organizations.id, orgId));

        return current?.retentionDays ?? null;
      });

      await recordAuditEvent({
        action: AUDIT_ACTIONS.RETENTION_CHANGED,
        organizationId: orgId,
        actorUserId: req.user!.id,
        actorEmail: req.user!.email,
        target: orgId,
        // The old value matters as much as the new one: a shortened window is
        // an instruction to delete, and the trail has to show what it replaced.
        metadata: { retentionDays: requested, previous },
        ip: clientIp(req),
      });

      return res.status(200).json({
        retentionDays: requested,
        usingPlatformDefault: requested === null,
      });
    } catch (error) {
      if (error instanceof OrganizationClosed) {
        return res.status(410).json({ error: "This workspace has been closed" });
      }
      console.error("Retention update error:", error);
      return res.status(500).json({ error: "Failed to update retention policy" });
    }
  }
);

/**
 * 9. Close the active workspace
 *
 * DELETE, because that is what the caller means and what the client will call
 * it - but the row is not deleted and cannot be. Jobs and ledger entries
 * reference it with ON DELETE RESTRICT (migration 0011), so the record that
 * arch.md promises to keep indefinitely survives the customer leaving.
 *
 * Restricted to ORG_ADMIN of the workspace being closed: the role comes from
 * the token, which is scoped to one organization, so an administrator of one
 * tenant cannot close another.
 */
router.delete(
  "/organization",
  authenticateJWT,
  requireRole("ORG_ADMIN"),
  async (req: AuthenticatedRequest, res: Response) => {
    const orgId = req.user!.organizationId;

    try {
      const result = await closeOrganization(orgId);

      // Recorded on the first closure only. A repeated call is a no-op, and an
      // audit trail that shows three closures where one happened is misleading
      // in the direction that matters.
      if (result.changed) {
        await recordAuditEvent({
          action: AUDIT_ACTIONS.ORGANIZATION_CLOSED,
          organizationId: orgId,
          actorUserId: req.user!.id,
          actorEmail: req.user!.email,
          target: orgId,
          metadata: { closedAt: result.closedAt },
          ip: clientIp(req),
        });
      }

      return res.status(200).json({
        closed: true,
        closedAt: result.closedAt,
        alreadyClosed: !result.changed,
        // Said plainly, because a caller who believes this erased their data
        // has been misled by the verb.
        note: "The workspace is closed. Jobs, credit history, and audit records are retained.",
      });
    } catch (error) {
      console.error("Workspace closure error:", error);
      return res.status(500).json({ error: "Failed to close workspace" });
    }
  }
);

/**
 * 10. Reopen a workspace closed by mistake
 *
 * Only reachable with a token minted before the closure, since a closed
 * organization no longer appears in membershipsOf and no new token can name it.
 * That bounds this to the session that closed it - the case it is for. After
 * that it is an operator action, deliberately.
 */
router.post(
  "/organization/reopen",
  authenticateJWT,
  requireRole("ORG_ADMIN"),
  async (req: AuthenticatedRequest, res: Response) => {
    const orgId = req.user!.organizationId;

    try {
      const reopened = await reopenOrganization(orgId);

      if (!reopened) {
        return res.status(409).json({ error: "That workspace is not closed" });
      }

      await recordAuditEvent({
        action: AUDIT_ACTIONS.ORGANIZATION_REOPENED,
        organizationId: orgId,
        actorUserId: req.user!.id,
        actorEmail: req.user!.email,
        target: orgId,
        ip: clientIp(req),
      });

      return res.status(200).json({ reopened: true });
    } catch (error) {
      console.error("Workspace reopen error:", error);
      return res.status(500).json({ error: "Failed to reopen workspace" });
    }
  }
);

export default router;
