import { Request } from "express";
import { and, eq, isNull } from "drizzle-orm";
import * as jwt from "jsonwebtoken";
import { systemDb } from "./db";
import { memberships, organizations } from "./db/schema";
import { AUDIT_ACTIONS, clientIp, recordAuditEvent } from "./audit";

/**
 * Issuing a session.
 *
 * Shared by the password path and the MFA path, and deliberately one function
 * rather than two similar ones: the second is where a check gets left out. Both
 * routes end a sign-in, so both must apply the same membership rule and write
 * the same audit record.
 */

const JWT_SECRET = process.env.JWT_SECRET || "super-secret-medical-saas-key-change-in-production";

export type Role = "ORG_ADMIN" | "MEMBER";

/**
 * A session token is scoped to ONE organization - the one the user is currently
 * acting in. A person may belong to several; switching is a new token, issued by
 * POST /switch-organization after verifying the membership.
 *
 * Keeping the active tenant in the token is what lets every downstream route go
 * on reading req.user.organizationId, and what keeps the RLS context a single
 * unambiguous value per request.
 */
export function issueSessionToken(
  user: { id: string; email: string },
  orgId: string,
  role: Role,
  restricted = false
): string {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      organizationId: orgId,
      role,
      // Omitted rather than set false, so an ordinary session carries no claim
      // at all and cannot be turned into a restricted one by flipping a bit
      // that was already there.
      ...(restricted ? { restricted: true } : {}),
    },
    JWT_SECRET,
    { expiresIn: "24h" }
  );
}

/**
 * Whether this person may act in this organization, or only enrol.
 *
 * A restricted session is the answer to a chicken-and-egg problem: an
 * organization that turns on the requirement has members who cannot enrol
 * without a session and cannot have a session without enrolling. Refusing the
 * sign-in outright would strand them.
 */
export async function isRestricted(
  user: { mfaEnabledAt?: Date | null },
  organizationId: string
): Promise<boolean> {
  if (user.mfaEnabledAt) return false;

  const org = await systemDb.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
  });

  return !!org?.requireMfa;
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
export async function membershipsOf(userId: string) {
  return systemDb
    .select({
      organizationId: memberships.organizationId,
      role: memberships.role,
      organizationName: organizations.name,
    })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
    .where(and(eq(memberships.userId, userId), isNull(organizations.deletedAt)));
}

export interface SignInResult {
  token: string;
  memberships: Awaited<ReturnType<typeof membershipsOf>>;
  /** True when the session may only reach MFA enrolment. */
  mfaEnrolmentRequired?: boolean;
}

/** Raised when an authenticated person has nowhere to act. */
export class NoMemberships extends Error {
  constructor() {
    super("NO_MEMBERSHIPS");
  }
}

/**
 * Finishes a sign-in that has already been authenticated.
 *
 * `factors` is recorded on the audit row rather than inferred later: "signed in
 * with a password alone" and "signed in with a password and a second factor"
 * are different events, and an investigation that cannot tell them apart cannot
 * say whether MFA was in force at the time.
 */
export async function completeSignIn(
  user: { id: string; email: string; mfaEnabledAt?: Date | null },
  req: Request,
  factors: string[]
): Promise<SignInResult> {
  const list = await membershipsOf(user.id);

  if (list.length === 0) {
    throw new NoMemberships();
  }

  const active = list[0];
  const restricted = await isRestricted(user, active.organizationId);

  await recordAuditEvent({
    action: AUDIT_ACTIONS.LOGIN_SUCCEEDED,
    organizationId: active.organizationId,
    actorUserId: user.id,
    actorEmail: user.email,
    target: user.email,
    metadata: { organizations: list.length, factors, restricted },
    ip: clientIp(req),
  });

  return {
    token: issueSessionToken(user, active.organizationId, active.role, restricted),
    memberships: list,
    ...(restricted ? { mfaEnrolmentRequired: true } : {}),
  };
}
