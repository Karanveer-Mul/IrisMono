import { Request } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
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
      // Minted-at, in milliseconds. `iat` is whole seconds, which cannot
      // distinguish a token issued just before a revocation from the one issued
      // just after it - and revoking then signing in again happens inside the
      // same second. Compared against the revocation cut-offs; see checkSession.
      mit: Date.now(),
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

/**
 * Whether a session still holds, asked on every authenticated request.
 *
 * A JWT is a statement about the past: it says what was true when it was
 * signed and keeps saying it for 24 hours. Everything that should end access
 * immediately - deactivating an account, closing a workspace, removing someone
 * from one, demoting an administrator, requiring a second factor - happens
 * after that. Checking the claims alone means all of those take effect at the
 * next sign-in, which is the one thing whoever holds a stolen token will not do.
 *
 * So the token is treated as an assertion of identity and nothing else: who
 * you are and which workspace you are acting in. What you may do there is read
 * from the database each time, from the row that is the actual authority.
 *
 * That is one indexed lookup per request. The alternative - trusting the token
 * and accepting a revocation window - is a cache with a 24-hour TTL and no
 * invalidation, described as a design.
 */
export type SessionVerdict =
  | { ok: true; role: Role; restricted: boolean }
  | { ok: false; status: number; error: string; extra?: Record<string, unknown> };

export async function checkSession(
  userId: string,
  organizationId: string,
  issuedAt: { mit?: number; iat?: number }
): Promise<SessionVerdict> {
  const result = await systemDb.execute(sql`
    SELECT u.deleted_at              AS user_deleted_at,
           u.mfa_enabled_at          AS mfa_enabled_at,
           u.sessions_invalid_before AS user_cutoff,
           m.role                    AS role,
           m.sessions_invalid_before AS membership_cutoff,
           o.id                      AS org_id,
           o.deleted_at              AS org_deleted_at,
           o.require_mfa             AS require_mfa,
           o.sessions_invalid_before AS org_cutoff
      FROM users u
      LEFT JOIN memberships m
        ON m.user_id = u.id AND m.organization_id = ${organizationId}
      LEFT JOIN organizations o
        ON o.id = ${organizationId}
     WHERE u.id = ${userId}
  `);

  type Instant = Date | string | null;
  const row = result.rows[0] as
    | {
        user_deleted_at: Instant;
        mfa_enabled_at: Instant;
        user_cutoff: Instant;
        role: Role | null;
        membership_cutoff: Instant;
        org_id: string | null;
        org_deleted_at: Instant;
        require_mfa: boolean | null;
        org_cutoff: Instant;
      }
    | undefined;

  if (!row) {
    return { ok: false, status: 401, error: "This account no longer exists" };
  }

  if (row.user_deleted_at) {
    return { ok: false, status: 401, error: "This account has been deactivated" };
  }

  // A closed workspace is deliberately NOT refused here. Closure stops the
  // tenant acting - reserving credits, issuing invites - and that is enforced
  // inside the writing transactions, where it belongs. Refusing the session
  // outright would lock out the administrator who closed it, who is the only
  // person able to reopen it and the one most likely to be exporting records
  // during a wind-down.
  if (!row.org_id) {
    return { ok: false, status: 403, error: "That workspace does not exist" };
  }

  if (!row.role) {
    return { ok: false, status: 403, error: "You are no longer a member of this workspace" };
  }

  // Milliseconds, from the token's own `mit` claim. `iat` is whole seconds,
  // which cannot separate a token minted just before a revocation from the one
  // minted just after it - and "revoke my sessions, then sign in again" is
  // exactly that, a few hundred milliseconds apart. Falling back to `iat` for
  // tokens predating the claim costs second resolution and errs towards
  // refusing, which is the right direction and moot within a day.
  //
  // Timestamps arrive as strings from a raw query and as Dates through the
  // query builder, depending on the driver's parser - normalised rather than
  // assumed, because assuming it threw, and every refusal then came out as a
  // generic 403 that looked like an expired token.
  const issuedAtMs = issuedAt.mit ?? (issuedAt.iat ?? 0) * 1000;
  const cutoff = [row.user_cutoff, row.membership_cutoff, row.org_cutoff]
    .filter((d): d is Date | string => !!d)
    .reduce<number>((latest, d) => Math.max(latest, new Date(d).getTime()), 0);

  if (cutoff > 0 && issuedAtMs < cutoff) {
    return {
      ok: false,
      status: 401,
      error: "This session was ended. Sign in again.",
      extra: { sessionRevoked: true },
    };
  }

  // Recomputed rather than read from the token, so turning the requirement on
  // restricts the sessions that already exist instead of waiting for each
  // member to sign in again - which, for the accounts the policy is about, may
  // be a day away.
  return { ok: true, role: row.role, restricted: !!row.require_mfa && !row.mfa_enabled_at };
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
