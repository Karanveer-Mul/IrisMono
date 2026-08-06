import { Request, Response, NextFunction } from "express";
import * as jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "super-secret-medical-saas-key-change-in-production";

/** Shared secret the GPU worker presents when reporting job outcomes. */
const WORKER_SECRET = process.env.WORKER_SECRET || "local-dev-worker-secret";

/** Lifetime of a stream token. Short, because it travels in a URL. */
const STREAM_TOKEN_TTL_SECONDS = 60;

export interface AuthUser {
  id: string;
  email: string;
  organizationId: string;
  role: "ORG_ADMIN" | "MEMBER";
}

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
}

/**
 * Session tokens carry no purpose claim; stream tokens carry purpose "stream".
 * They are deliberately not interchangeable - see authenticateJWT below.
 */
interface SessionClaims extends AuthUser {
  purpose?: "stream";
}

export function authenticateJWT(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Access token missing or invalid format" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as SessionClaims;

    // A stream token leaks more easily than a session token (it rides in a
    // query string, so it lands in access logs and Referer headers). Refuse
    // to accept one as a general-purpose credential.
    if (decoded.purpose === "stream") {
      return res.status(403).json({ error: "Stream tokens cannot be used for API access" });
    }

    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ error: "Invalid or expired access token" });
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
    },
    JWT_SECRET,
    { expiresIn: STREAM_TOKEN_TTL_SECONDS }
  );
}

/**
 * Authenticates an endpoint by `?token=` instead of the Authorization header.
 * Only accepts tokens minted by issueStreamToken.
 */
export function authenticateStreamToken(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const token = typeof req.query.token === "string" ? req.query.token : null;

  if (!token) {
    return res.status(401).json({ error: "Stream token missing" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as SessionClaims;

    if (decoded.purpose !== "stream") {
      return res.status(403).json({ error: "Token is not valid for stream access" });
    }

    req.user = decoded;
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
