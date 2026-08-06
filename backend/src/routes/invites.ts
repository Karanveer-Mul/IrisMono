import { Router as ExpressRouter, Response } from "express";
import { db } from "../db";
import { organizations, organizationInvites } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { authenticateJWT, AuthenticatedRequest, requireRole } from "../middleware/auth";
import { randomUUID } from "crypto";

const router = ExpressRouter();

// Apply auth protection & admin role requirement for all invite management routes
router.use(authenticateJWT);
router.use(requireRole("ORG_ADMIN"));

/**
 * 1. Generate a reusable invite link
 * POST /api/invites
 */
router.post("/", async (req: AuthenticatedRequest, res: Response) => {
  const orgId = req.user!.organizationId;
  const userId = req.user!.id;
  const { allowedDomains, expiresDays } = req.body;

  try {
    const inviteCode = `inv_${randomUUID()}`;
    const expiresAt = expiresDays ? new Date(Date.now() + expiresDays * 24 * 60 * 60 * 1000) : null;

    // Use organization allowed domains as default if none specified
    let finalDomains = allowedDomains;
    if (!finalDomains || !Array.isArray(finalDomains)) {
      const org = await db.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
      });
      finalDomains = org?.allowedDomains || [];
    }

    const [newInvite] = await db
      .insert(organizationInvites)
      .values({
        organizationId: orgId,
        inviteCode,
        allowedDomains: finalDomains,
        isActive: true,
        createdBy: userId,
        expiresAt,
      })
      .returning();

    return res.status(201).json({
      inviteLink: `/join/${newInvite.inviteCode}`,
      invite: newInvite
    });

  } catch (error) {
    console.error("Failed to create invite:", error);
    return res.status(500).json({ error: "Failed to generate invite link" });
  }
});

/**
 * 2. Toggle invite active status (panic/revoke toggle)
 * PATCH /api/invites/:inviteId/toggle
 */
router.patch("/:inviteId/toggle", async (req: AuthenticatedRequest, res: Response) => {
  const { inviteId } = req.params;
  const orgId = req.user!.organizationId;

  try {
    const invite = await db.query.organizationInvites.findFirst({
      where: and(
        eq(organizationInvites.id, inviteId),
        eq(organizationInvites.organizationId, orgId)
      ),
    });

    if (!invite) {
      return res.status(404).json({ error: "Invite link not found" });
    }

    const [updatedInvite] = await db
      .update(organizationInvites)
      .set({
        isActive: !invite.isActive,
      })
      .where(eq(organizationInvites.id, inviteId))
      .returning();

    return res.status(200).json({
      message: `Invite link ${updatedInvite.isActive ? "activated" : "deactivated"} successfully.`,
      invite: updatedInvite
    });

  } catch (error) {
    console.error("Failed to toggle invite status:", error);
    return res.status(500).json({ error: "Failed to toggle invite status" });
  }
});

/**
 * 3. Add or remove whitelisted domains for the organization
 * POST /api/invites/domains
 */
router.post("/domains", async (req: AuthenticatedRequest, res: Response) => {
  const orgId = req.user!.organizationId;
  const { action, domain } = req.body; // action: 'add' | 'remove'

  if (!action || !domain) {
    return res.status(400).json({ error: "Missing required fields: action, domain" });
  }

  if (action !== "add" && action !== "remove") {
    return res.status(400).json({ error: "Invalid action. Use 'add' or 'remove'" });
  }

  const cleanDomain = domain.toLowerCase().trim();

  try {
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
    });

    if (!org) {
      return res.status(404).json({ error: "Organization not found" });
    }

    let updatedDomains = [...org.allowedDomains];

    if (action === "add") {
      if (!updatedDomains.includes(cleanDomain)) {
        updatedDomains.push(cleanDomain);
      }
    } else if (action === "remove") {
      // Rule: Whitelist must maintain AT LEAST one domain pattern
      if (updatedDomains.length <= 1) {
        return res.status(400).json({
          error: "Action denied. Organization whitelist must contain at least one domain pattern."
        });
      }
      updatedDomains = updatedDomains.filter((d) => d !== cleanDomain);
    }

    const [updatedOrg] = await db
      .update(organizations)
      .set({
        allowedDomains: updatedDomains,
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, orgId))
      .returning();

    return res.status(200).json({
      message: "Allowed domains updated successfully",
      allowedDomains: updatedOrg.allowedDomains
    });

  } catch (error) {
    console.error("Failed to update domains:", error);
    return res.status(500).json({ error: "Failed to update whitelist domains" });
  }
});

/**
 * GET /api/invites
 * List invites
 */
router.get("/", async (req: AuthenticatedRequest, res: Response) => {
  const orgId = req.user!.organizationId;
  try {
    const list = await db.query.organizationInvites.findMany({
      where: eq(organizationInvites.organizationId, orgId),
      orderBy: (inv, { desc }) => [desc(inv.createdAt)],
    });
    return res.status(200).json({ invites: list });
  } catch (error) {
    return res.status(500).json({ error: "Failed to fetch organization invites list" });
  }
});

/**
 * GET /api/invites/domains/list
 * List organization domains whitelist
 */
router.get("/domains/list", async (req: AuthenticatedRequest, res: Response) => {
  const orgId = req.user!.organizationId;
  try {
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
    });
    return res.status(200).json({ allowedDomains: org?.allowedDomains || [] });
  } catch (error) {
    return res.status(500).json({ error: "Failed to fetch organization whitelist domains list" });
  }
});

export default router;
