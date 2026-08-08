import { Router as ExpressRouter, Response } from "express";
import { withTenant } from "../db";
import { organizations, organizationInvites } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { authenticateJWT, AuthenticatedRequest, requireRole } from "../middleware/auth";
import { randomUUID } from "crypto";
import { AUDIT_ACTIONS, clientIp, recordAuditEvent } from "../audit";
import { assertOrganizationActive, OrganizationClosed } from "../lifecycle";

const router = ExpressRouter();

/**
 * Defaults applied when an admin does not specify them.
 *
 * Both exist because the safe value has to be the one you get by not thinking
 * about it. A link that never expires and never runs out is the shape of every
 * invite-link incident.
 */
const DEFAULT_INVITE_MAX_USES = Number(process.env.DEFAULT_INVITE_MAX_USES || 25);
const DEFAULT_INVITE_DAYS = Number(process.env.DEFAULT_INVITE_DAYS || 30);

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
  const { allowedDomains, expiresDays, maxUses } = req.body;

  // A cap is the difference between an invitation and a standing offer: without
  // one, anybody who ever sees the link - forwarded, screenshotted, pasted into
  // a ticket - can admit themselves for as long as it exists. Defaulted rather
  // than required, so creating a link does not silently create an uncapped one.
  const cap =
    maxUses === null || maxUses === "unlimited"
      ? null
      : Number.isFinite(Number(maxUses)) && Number(maxUses) > 0
        ? Math.trunc(Number(maxUses))
        : DEFAULT_INVITE_MAX_USES;

  try {
    const inviteCode = `inv_${randomUUID()}`;
    const expiresAt = expiresDays
      ? new Date(Date.now() + expiresDays * 24 * 60 * 60 * 1000)
      : new Date(Date.now() + DEFAULT_INVITE_DAYS * 24 * 60 * 60 * 1000);

    const newInvite = await withTenant(orgId, async (tx) => {
      // A closed workspace does not issue new links. The redemption path
      // refuses them too, so this only stops a dead link being handed out.
      await assertOrganizationActive(tx, orgId);

      // Use organization allowed domains as default if none specified
      let finalDomains = allowedDomains;
      if (!finalDomains || !Array.isArray(finalDomains)) {
        const org = await tx.query.organizations.findFirst({
          where: eq(organizations.id, orgId),
        });
        finalDomains = org?.allowedDomains || [];
      }

      const [created] = await tx
        .insert(organizationInvites)
        .values({
          organizationId: orgId,
          inviteCode,
          allowedDomains: finalDomains,
          isActive: true,
          createdBy: userId,
          expiresAt,
          maxUses: cap,
        })
        .returning();

      return created;
    });

    await recordAuditEvent({
      action: AUDIT_ACTIONS.INVITE_CREATED,
      organizationId: orgId,
      actorUserId: userId,
      actorEmail: req.user!.email,
      target: newInvite.inviteCode,
      metadata: {
        inviteId: newInvite.id,
        maxUses: cap,
        expiresAt: expiresAt.toISOString(),
        allowedDomains: newInvite.allowedDomains,
      },
      ip: clientIp(req),
    });

    return res.status(201).json({
      inviteLink: `/join/${newInvite.inviteCode}`,
      invite: newInvite
    });

  } catch (error) {
    if (error instanceof OrganizationClosed) {
      return res.status(410).json({ error: "This workspace has been closed" });
    }
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
    const updatedInvite = await withTenant(orgId, async (tx) => {
      const invite = await tx.query.organizationInvites.findFirst({
        where: and(
          eq(organizationInvites.id, inviteId),
          eq(organizationInvites.organizationId, orgId)
        ),
      });

      if (!invite) {
        return null;
      }

      const [updated] = await tx
        .update(organizationInvites)
        .set({
          isActive: !invite.isActive,
        })
        .where(eq(organizationInvites.id, inviteId))
        .returning();

      return updated;
    });

    if (!updatedInvite) {
      return res.status(404).json({ error: "Invite link not found" });
    }

    await recordAuditEvent({
      action: AUDIT_ACTIONS.INVITE_TOGGLED,
      organizationId: orgId,
      actorUserId: req.user!.id,
      actorEmail: req.user!.email,
      target: updatedInvite.inviteCode,
      metadata: { isActive: updatedInvite.isActive, usesCount: updatedInvite.usesCount },
      ip: clientIp(req),
    });

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
    const outcome = await withTenant(orgId, async (tx) => {
      const org = await tx.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
      });

      if (!org) {
        return { error: "NOT_FOUND" as const };
      }

      let updatedDomains = [...org.allowedDomains];

      if (action === "add") {
        if (!updatedDomains.includes(cleanDomain)) {
          updatedDomains.push(cleanDomain);
        }
      } else if (action === "remove") {
        // Rule: Whitelist must maintain AT LEAST one domain pattern
        if (updatedDomains.length <= 1) {
          return { error: "LAST_DOMAIN" as const };
        }
        updatedDomains = updatedDomains.filter((d) => d !== cleanDomain);
      }

      const [updatedOrg] = await tx
        .update(organizations)
        .set({
          allowedDomains: updatedDomains,
          updatedAt: new Date(),
        })
        .where(eq(organizations.id, orgId))
        .returning();

      return { allowedDomains: updatedOrg.allowedDomains };
    });

    if ("error" in outcome) {
      if (outcome.error === "NOT_FOUND") {
        return res.status(404).json({ error: "Organization not found" });
      }
      return res.status(400).json({
        error: "Action denied. Organization whitelist must contain at least one domain pattern."
      });
    }

    // Widening the whitelist widens who can admit themselves through every
    // existing link, so it is a security-relevant change and is recorded.
    await recordAuditEvent({
      action: AUDIT_ACTIONS.DOMAINS_CHANGED,
      organizationId: orgId,
      actorUserId: req.user!.id,
      actorEmail: req.user!.email,
      target: cleanDomain,
      metadata: { action, allowedDomains: outcome.allowedDomains },
      ip: clientIp(req),
    });

    return res.status(200).json({
      message: "Allowed domains updated successfully",
      allowedDomains: outcome.allowedDomains
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
    const list = await withTenant(orgId, (tx) =>
      tx.query.organizationInvites.findMany({
        where: eq(organizationInvites.organizationId, orgId),
        orderBy: (inv, { desc }) => [desc(inv.createdAt)],
      })
    );
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
    const org = await withTenant(orgId, (tx) =>
      tx.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
      })
    );
    return res.status(200).json({ allowedDomains: org?.allowedDomains || [] });
  } catch (error) {
    return res.status(500).json({ error: "Failed to fetch organization whitelist domains list" });
  }
});

export default router;
