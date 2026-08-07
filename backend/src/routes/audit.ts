import { Response, Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db";
import { authenticateJWT, AuthenticatedRequest, requireRole } from "../middleware/auth";
import { verifyAuditChain } from "../audit";

const router = Router();

router.use(authenticateJWT);
// Admins only. The trail names who opened which scan, which is itself
// information about colleagues that a member has no reason to read.
router.use(requireRole("ORG_ADMIN"));

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

/**
 * GET /api/audit
 *
 * A tenant's own audit trail. Read through the RLS-enforced identity rather
 * than filtered in application code: the isolation of the security log should
 * not depend on remembering a WHERE clause.
 */
router.get("/", async (req: AuthenticatedRequest, res: Response) => {
  const orgId = req.user!.organizationId;

  const requested = Number(req.query.limit);
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), MAX_PAGE)
    : DEFAULT_PAGE;

  const before = Number(req.query.before);
  const action = typeof req.query.action === "string" ? req.query.action : null;

  try {
    const events = await withTenant(orgId, (tx) =>
      tx.execute(sql`
        SELECT id, action, actor_email, actor_user_id, target, metadata, ip, created_at
          FROM audit_events
         WHERE (${action}::text IS NULL OR action = ${action})
           AND (${Number.isFinite(before) ? before : null}::bigint IS NULL
                OR id < ${Number.isFinite(before) ? before : null}::bigint)
         ORDER BY id DESC
         LIMIT ${limit}
      `)
    );

    const rows = events.rows as any[];

    return res.status(200).json({
      events: rows.map((row) => ({
        id: Number(row.id),
        action: row.action,
        actorEmail: row.actor_email,
        actorUserId: row.actor_user_id,
        target: row.target,
        metadata: row.metadata,
        ip: row.ip,
        createdAt: row.created_at,
      })),
      // Id-based rather than a cursor: the log is strictly append-only, so an
      // id is already a stable position in it.
      nextBefore: rows.length === limit ? Number(rows[rows.length - 1].id) : null,
    });
  } catch (error) {
    console.error("Failed to read audit events:", error);
    return res.status(500).json({ error: "Failed to read audit events" });
  }
});

/**
 * GET /api/audit/verify
 *
 * Recomputes the hash chain and reports the first row that does not verify.
 *
 * Deliberately available to an administrator rather than only to operators:
 * "you can check for yourself" is the property that makes an audit log worth
 * anything to the party it is meant to protect. The verification covers the
 * whole chain, not just this tenant's rows - a trail whose integrity could only
 * be established for the rows you are allowed to see would prove nothing, since
 * removing a row is exactly the tampering being detected.
 */
router.get("/verify", async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await verifyAuditChain();
    return res.status(result.ok ? 200 : 409).json(result);
  } catch (error) {
    console.error("Failed to verify the audit chain:", error);
    return res.status(500).json({ error: "Failed to verify the audit chain" });
  }
});

export default router;
