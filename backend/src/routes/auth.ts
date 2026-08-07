import { Router, Request, Response } from "express";
// Registration, login, and invite redemption all identify a row before any
// organization context exists (by email, or by invite code), so they run on the
// RLS-bypassing system identity. Everything with a known tenant uses withTenant.
import { systemDb, withTenant } from "../db";
import { organizations, users, memberships, organizationInvites } from "../db/schema";
import { eq, and } from "drizzle-orm";
import * as bcrypt from "bcryptjs";
import * as jwt from "jsonwebtoken";
import { isEmailDomainAllowed, getEmailDomain } from "../utils/domain";
import { authenticateJWT, AuthenticatedRequest, issueStreamToken } from "../middleware/auth";
import { grantCredits } from "../credits";

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

/** Every organization this person belongs to, with their role in each. */
async function membershipsOf(userId: string) {
  const rows = await systemDb
    .select({
      organizationId: memberships.organizationId,
      role: memberships.role,
      organizationName: organizations.name,
    })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
    .where(eq(memberships.userId, userId));

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

      return { token: issueSessionToken(user!, newOrg.id, "ORG_ADMIN"), userId: user!.id };
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

    if (!invite.isActive) {
      return res.status(410).json({ error: "This invite link has been revoked or deactivated" });
    }

    if (invite.expiresAt && new Date() > invite.expiresAt) {
      return res.status(410).json({ error: "This invite link has expired" });
    }

    // Hospital-grade domain whitelist enforcement. Invite whitelist first, then
    // the organization's.
    let allowedDomains = invite.allowedDomains;
    if (!allowedDomains || allowedDomains.length === 0) {
      const org = await systemDb.query.organizations.findFirst({
        where: eq(organizations.id, invite.organizationId),
      });
      allowedDomains = org?.allowedDomains || [];
    }

    if (!isEmailDomainAllowed(email, allowedDomains)) {
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
    }

    const result = await systemDb.transaction(async (tx) => {
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
      });

      return { token: issueSessionToken(user!, invite.organizationId, "MEMBER"), userId: user!.id };
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
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const list = await membershipsOf(user.id);

    if (list.length === 0) {
      return res.status(403).json({
        error: "This account does not belong to any organization. Ask an administrator for an invite link.",
      });
    }

    const active = list[0];

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

    const user = await systemDb.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

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

export default router;
