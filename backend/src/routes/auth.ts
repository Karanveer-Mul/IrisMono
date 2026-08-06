import { Router, Request, Response } from "express";
import { db } from "../db";
import { organizations, users, organizationInvites } from "../db/schema";
import { eq, and } from "drizzle-orm";
import * as bcrypt from "bcryptjs";
import * as jwt from "jsonwebtoken";
import { isEmailDomainAllowed, getEmailDomain } from "../utils/domain";
import { authenticateJWT, AuthenticatedRequest } from "../middleware/auth";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "super-secret-medical-saas-key-change-in-production";

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
    const existingUser = await db.query.users.findFirst({
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
    const token = await db.transaction(async (tx) => {
      // 1. Create Organization with 3 credits and the creator's domain whitelisted
      const [newOrg] = await tx
        .insert(organizations)
        .values({
          name: orgName,
          creditBalance: 3,
          allowedDomains: [creatorDomain],
        })
        .returning();

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
    const invite = await db.query.organizationInvites.findFirst({
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
      const org = await db.query.organizations.findFirst({
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
    const existingUser = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (existingUser) {
      return res.status(409).json({ error: "Email is already registered" });
    }

    // 3. Create User as MEMBER under transaction
    const token = await db.transaction(async (tx) => {
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
    const user = await db.query.users.findFirst({
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
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      with: {
        organization: true,
      },
    });

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

export default router;
