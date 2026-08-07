import { Router, Response } from "express";
import { eq } from "drizzle-orm";
import { withTenant } from "../db";
import { organizations, creditTransactions } from "../db/schema";
import { authenticateJWT, AuthenticatedRequest } from "../middleware/auth";

const router = Router();

router.use(authenticateJWT);

/**
 * Credit balance and its history.
 * GET /api/credits?limit=50
 *
 * The ledger is what makes "why is this organization at 47 credits?" an
 * answerable question. Every entry names the job it belongs to, so a balance
 * can be walked back to the work that moved it.
 */
router.get("/", async (req: AuthenticatedRequest, res: Response) => {
  const orgId = req.user!.organizationId;

  const limit = Math.min(Number(req.query.limit) || 50, 200);

  try {
    const data = await withTenant(orgId, async (tx) => {
      const org = await tx.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
      });

      const transactions = await tx.query.creditTransactions.findMany({
        where: eq(creditTransactions.organizationId, orgId),
        orderBy: (ct, { desc }) => [desc(ct.createdAt)],
        limit,
      });

      return { balance: org?.creditBalance ?? 0, transactions };
    });

    return res.status(200).json(data);
  } catch (error) {
    console.error("Failed to load credit ledger:", error);
    return res.status(500).json({ error: "Failed to load credit ledger" });
  }
});

export default router;
