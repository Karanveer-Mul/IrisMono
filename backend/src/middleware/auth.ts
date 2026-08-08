import { Request, Response, NextFunction } from "express";
import * as jwt from "jsonwebtoken";
import { checkSession } from "../session";

const JWT_SECRET = process.env.JWT_SECRET || "super-secret-medical-saas-key-change-in-production";

/** Shared secret the GPU worker presents when reporting job outcomes. */
const WORKER_SECRET = process.env.WORKER_SECRET || "local-dev-worker-secret";

/** Shared secret the object store presents when notifying an upload. */
const STORAGE_EVENT_SECRET = process.env.STORAGE_EVENT_SECRET || "local-dev-storage-secret";

/** Lifetime of a stream token. Short, because it travels in a URL. */
const STREAM_TOKEN_TTL_SECONDS = 60;

export interface AuthUser {
  id: string;
  email: string;
  organizationId: string;
  role: "ORG_ADMIN" | "MEMBER";
  /**
   * Set when the active organization requires a second factor and this person
   * does not have one. The session is real but may only reach MFA enrolment -
   * see authenticateJWT.
   */
  restricted?: boolean;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
}

/**
 * Session tokens carry no purpose claim. Every other kind carries one, and none
 * of them are interchangeable with a session - see authenticateJWT below.
 *
 *   stream  60 seconds, rides in a query string, for the SSE endpoint.
 *   mfa     5 minutes, proves the password step only, for the MFA challenge.
 */
interface SessionClaims extends AuthUser {
  purpose?: "stream" | "mfa";
  /** Issued-at, in whole seconds. Set by jsonwebtoken. */
  iat?: number;
  /** Minted-at, in milliseconds. Ours, because `iat` is too coarse to revoke by. */
  mit?: number;
}

/** Lifetime of an MFA challenge token. Long enough to open an app, no longer. */
const MFA_TOKEN_TTL_SECONDS = 300;

export async function authenticateJWT(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Access token missing or invalid format" });
  }

  const token = authHeader.split(" ")[1];

  // Only the signature check belongs in this try. Widening it to cover the
  // database lookup below turns any infrastructure failure into "Invalid or
  // expired access token", which sends whoever is debugging it to look at the
  // client - as it did once already while this was being written.
  let decoded: SessionClaims;
  try {
    decoded = jwt.verify(token, JWT_SECRET) as SessionClaims;
  } catch {
    return res.status(403).json({ error: "Invalid or expired access token" });
  }

  try {
    // Anything with a purpose is a narrow credential and is refused here, by
    // default rather than by enumeration. A stream token leaks easily (it rides
    // in a query string, so it lands in access logs and Referer headers); an
    // MFA challenge token represents a half-finished sign-in, and accepting it
    // as a session would make the second factor optional for anyone who noticed.
    if (decoded.purpose) {
      return res.status(403).json({
        error: `Tokens issued for ${decoded.purpose} cannot be used for API access`,
      });
    }

    // What the token asserts is who this is and where they are acting. What
    // they may do there is read from the database, every request, because the
    // token cannot know anything that happened after it was signed - a closed
    // workspace, a revoked session, a removed membership, a demotion.
    const state = await checkSession(decoded.id, decoded.organizationId, decoded);

    if (!state.ok) {
      return res.status(state.status).json({ error: state.error, ...(state.extra ?? {}) });
    }

    // A restricted session can reach MFA enrolment and nothing else.
    //
    // Enforced here, in the one place every authenticated route passes through,
    // rather than by adding a guard to each router. Matching on the mount path
    // is uglier than a per-route flag, and it is the right trade: the failure
    // mode of the tidier design is a router someone forgot, which fails open on
    // exactly the accounts the policy exists to cover.
    //
    // The restriction cannot include enrolment itself. An organization that
    // turns on the requirement locks out every member who has not enrolled, and
    // enrolling needs a session - so refusing one outright would leave them
    // with no way in at all.
    if (state.restricted && !req.baseUrl.startsWith("/api/auth/mfa")) {
      return res.status(403).json({
        error: "This organization requires multi-factor authentication. Enrol before continuing.",
        mfaEnrolmentRequired: true,
      });
    }

    // Role and restriction come from the database rather than the token, so a
    // demotion or a new MFA requirement binds the sessions that already exist.
    req.user = {
      id: decoded.id,
      email: decoded.email,
      organizationId: decoded.organizationId,
      role: state.role,
      ...(state.restricted ? { restricted: true } : {}),
    };
    next();
  } catch (error) {
    // The token was good and the check itself failed. Refusing is still right -
    // an authorization decision that cannot be made must not default to yes -
    // but it is reported as ours, and loudly, rather than blamed on the caller.
    console.error("Session check failed:", error);
    return res.status(503).json({ error: "Could not verify this session. Try again." });
  }
}

/**
 * Mints a short-lived token for endpoints the browser cannot send headers to.
 *
 * EventSource has no API for request headers, so the SSE stream cannot be
 * authenticated with the normal Authorization: Bearer flow. The client asks
 * for one of these and puts it in the query string instead.
 */
export function issueStreamToken(user: AuthUser): string {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      organizationId: user.organizationId,
      role: user.role,
      purpose: "stream",
      // Same millisecond claim as a session token: this is checked against the
      // revocation cut-offs too, and a stream reconnecting is one of the paths
      // a revoked session would otherwise slip back in through.
      mit: Date.now(),
    },
    JWT_SECRET,
    { expiresIn: STREAM_TOKEN_TTL_SECONDS }
  );
}

/**
 * Mints the token that carries a half-finished sign-in.
 *
 * Issued once the password is verified and before the second factor is. It
 * names the user and nothing else useful: no organization, no role, and it is
 * refused by every authenticated route, so the only thing it can do is be
 * exchanged for a session at POST /api/auth/mfa/verify.
 */
export function issueMfaChallengeToken(user: { id: string; email: string }): string {
  return jwt.sign({ id: user.id, email: user.email, purpose: "mfa" }, JWT_SECRET, {
    expiresIn: MFA_TOKEN_TTL_SECONDS,
  });
}

export interface MfaChallenge {
  id: string;
  email: string;
}

/** Verifies a challenge token. Returns null for anything else. */
export function readMfaChallengeToken(token: string): MfaChallenge | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as SessionClaims;
    if (decoded.purpose !== "mfa") return null;
    return { id: decoded.id, email: decoded.email };
  } catch {
    return null;
  }
}

/**
 * Authenticates an endpoint by `?token=` instead of the Authorization header.
 * Only accepts tokens minted by issueStreamToken.
 */
export async function authenticateStreamToken(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const token = typeof req.query.token === "string" ? req.query.token : null;

  if (!token) {
    return res.status(401).json({ error: "Stream token missing" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as SessionClaims;

    if (decoded.purpose !== "stream") {
      return res.status(403).json({ error: "Token is not valid for stream access" });
    }

    // Same gate as the header path. A stream is long-lived once open, so the
    // check at connect time is the only one it gets - and a revoked session
    // reconnecting is exactly the case this has to refuse.
    const state = await checkSession(decoded.id, decoded.organizationId, decoded);

    if (!state.ok) {
      return res.status(state.status).json({ error: state.error, ...(state.extra ?? {}) });
    }

    req.user = { ...decoded, role: state.role };
    next();
  } catch (error) {
    return res.status(403).json({ error: "Invalid or expired stream token" });
  }
}

/**
 * Authenticates the GPU worker reporting a job outcome.
 *
 * The worker is not a user and holds no organization context - it proves it is
 * the worker, and the API decides what that permits. This is what lets the
 * worker drop its database credentials entirely.
 */
export function authenticateWorker(req: Request, res: Response, next: NextFunction) {
  const presented = req.headers["x-worker-secret"];

  if (typeof presented !== "string" || presented !== WORKER_SECRET) {
    return res.status(401).json({ error: "Invalid worker credentials" });
  }

  next();
}

/**
 * Authenticates an object-storage event notification.
 *
 * The bucket is infrastructure, not a user: it proves it is the configured
 * notification source and the API decides what that permits, which is to say
 * "queue the job named by this key, if it is still waiting for its image".
 *
 * A separate secret from the worker's, because the two are different trust
 * domains with different blast radii - the storage notifier can start work, the
 * worker can settle it - and rotating one should not require rotating the other.
 */
export function authenticateStorageEvent(req: Request, res: Response, next: NextFunction) {
  const presented = req.headers["x-storage-secret"];

  if (typeof presented !== "string" || presented !== STORAGE_EVENT_SECRET) {
    return res.status(401).json({ error: "Invalid storage event credentials" });
  }

  next();
}

export function requireRole(role: "ORG_ADMIN" | "MEMBER") {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (req.user.role !== role) {
      return res.status(403).json({ error: "Forbidden: insufficient permissions" });
    }

    next();
  };
}
