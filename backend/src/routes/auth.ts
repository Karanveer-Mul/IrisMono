import { Router, Request, Response } from "express";
// Registration, login, and invite redemption all identify a row before any
// organization context exists (by email, or by invite code), so they run on the
// RLS-bypassing system identity. Everything with a known tenant uses withTenant.
import { systemDb, withTenant } from "../db";
import { organizations, users, organizationInvites } from "../db/schema";
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
 * 1. First-In Creator Signup
 * Automatically creates a new Organization, seeds it with 3 trial credits, 
 * sets the allowed domain to the creator's email domain, and grants them ORG_ADMIN role.
 */
router.post("/register", async (req: Request, res: Response) => {
  const { email, password, orgName } = req.body;

  if (!email || !password || !orgName) {
    return res.status(400).json({ error: "Missing required fields: email, password, orgName" });
  }

  try {
    // Check if user already exists
    const existingUser = await systemDb.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (existingUser) {
      return res.status(409).json({ error: "Email is already registered" });
    }

    const creatorDomain = getEmailDomain(email);
    if (!creatorDomain) {
      return res.status(400).json({ error: "Invalid email domain" });
    }

    // Start database transaction
    const token = await systemDb.transaction(async (tx) => {
      // 1. Create Organization with the creator's domain whitelisted. The
      // balance starts at zero and the trial credits arrive as a ledger entry
      // below, so every credit this organization ever holds has a recorded
      // origin.
      const [newOrg] = await tx
        .insert(organizations)
        .values({
          name: orgName,
          creditBalance: 0,
          allowedDomains: [creatorDomain],
        })
        .returning();

      await grantCredits(tx, newOrg.id, TRIAL_CREDITS, "TRIAL_GRANT", "New workspace trial credits");

      // 2. Hash Password
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(password, salt);

      // 3. Create User as ORG_ADMIN
      const [newUser] = await tx
        .insert(users)
        .values({
          email,
          passwordHash,
          organizationId: newOrg.id,
          role: "ORG_ADMIN",
        })
        .returning();

      // 4. Generate JWT
      return jwt.sign(
        {
          id: newUser.id,
          email: newUser.email,
          organizationId: newOrg.id,
          role: "ORG_ADMIN",
        },
        JWT_SECRET,
        { expiresIn: "24h" }
      );
    });

    return res.status(201).json({ token });

  } catch (error) {
    console.error("Registration error:", error);
    return res.status(500).json({ error: "Internal server error during registration" });
  }
});

/**
 * 2. Join Organization via Invite Link
 * Validates domain whitelists and assigns MEMBER role.
 */
router.post("/join/:inviteCode", async (req: Request, res: Response) => {
  const { inviteCode } = req.params;
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Missing email or password" });
  }

  try {
    // 1. Query invite code
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

    // 2. Hospital-grade Domain Whitelist Enforcement
    // Check invite whitelist first, then fallback to organization allowed domains
    let allowedDomains = invite.allowedDomains;
    if (!allowedDomains || allowedDomains.length === 0) {
      const org = await systemDb.query.organizations.findFirst({
        where: eq(organizations.id, invite.organizationId),
      });
      allowedDomains = org?.allowedDomains || [];
    }

    const domainAllowed = isEmailDomainAllowed(email, allowedDomains);
    if (!domainAllowed) {
      return res.status(403).json({
        error: `Registration denied. Your email domain is not authorized for this organization. Whitelist includes: ${allowedDomains.join(", ")}`,
      });
    }

    // Check if user already exists
    const existingUser = await systemDb.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (existingUser) {
      return res.status(409).json({ error: "Email is already registered" });
    }

    // 3. Create User as MEMBER under transaction
    const token = await systemDb.transaction(async (tx) => {
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(password, salt);

      const [newUser] = await tx
        .insert(users)
        .values({
          email,
          passwordHash,
          organizationId: invite.organizationId,
          role: "MEMBER",
        })
        .returning();

      return jwt.sign(
        {
          id: newUser.id,
          email: newUser.email,
          organizationId: invite.organizationId,
          role: "MEMBER",
        },
        JWT_SECRET,
        { expiresIn: "24h" }
      );
    });

    return res.status(201).json({ token });

  } catch (error) {
    console.error("Invite join error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * 3. Standard Login
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

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        organizationId: user.organizationId,
        role: user.role,
      },
      JWT_SECRET,
      { expiresIn: "24h" }
    );

    return res.status(200).json({ token });

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
    const user = await withTenant(orgId, (tx) =>
      tx.query.users.findFirst({
        where: eq(users.id, userId),
        with: {
          organization: true,
        },
      })
    );

    if (!user) {
      return res.status(404).json({ error: "User profile not found" });
    }

    return res.status(200).json({
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
      organization: user.organization,
    });
  } catch (error) {
    console.error("Profile load error:", error);
    return res.status(500).json({ error: "Failed to load user profile" });
  }
});

/**
 * 5. Mint a short-lived token for the SSE stream
 *
 * EventSource cannot send an Authorization header, so the stream is
 * authenticated by query parameter instead. These tokens expire in 60 seconds
 * and are rejected by the normal API middleware.
 */
router.post("/stream-token", authenticateJWT, (req: AuthenticatedRequest, res: Response) => {
  return res.status(200).json({ token: issueStreamToken(req.user!) });
});

export default router;
