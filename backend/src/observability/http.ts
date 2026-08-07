import { randomUUID } from "crypto";
import { NextFunction, Request, Response } from "express";
import { httpDuration, httpInFlight, httpRequests } from "./apiMetrics";
import { logger, withRequestContext } from "./logger";

declare module "express-serve-static-core" {
  interface Request {
    /** Correlation id for this request. Also returned as x-request-id. */
    requestId?: string;
  }
}

/** Paths that are scraped or probed constantly and would drown the access log. */
const QUIET_PATHS = new Set(["/health", "/health/ready", "/metrics"]);

/**
 * The metric label for a request's route.
 *
 * This must be the route *pattern*, never the URL. `/api/jobs/<uuid>/image/raw`
 * as a label value would mint a new time series per job, which is how a metrics
 * backend gets taken down by the service it monitors. Express exposes the
 * matched pattern only after routing, which is why this is read at response
 * time rather than on the way in.
 */
function routeLabel(req: Request): string {
  const pattern = (req.route as { path?: string } | undefined)?.path;
  if (!pattern) {
    // No route matched: a 404, or a middleware that answered early. One bucket
    // for all of them, because the paths are attacker-controlled.
    return "unmatched";
  }
  const base = req.baseUrl || "";
  return `${base}${pattern === "/" ? "" : pattern}` || "/";
}

/**
 * Assigns a correlation id, records the request, and logs the outcome.
 *
 * Mounted before the body parser so a request that dies in parsing is still
 * counted - malformed-body errors are exactly the kind of failure that is
 * invisible when instrumentation sits too deep in the stack.
 */
export function observeRequests(req: Request, res: Response, next: NextFunction) {
  // An id supplied by an upstream proxy is honoured so the trace spans the
  // whole edge, and it is bounded in length because it is echoed back.
  const inbound = req.headers["x-request-id"];
  const requestId =
    typeof inbound === "string" && inbound.length > 0 && inbound.length <= 200
      ? inbound
      : randomUUID();

  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);

  const startedAt = process.hrtime.bigint();
  httpInFlight.set({}, inFlightDelta(1));

  res.on("finish", () => {
    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    const route = routeLabel(req);
    const status = String(res.statusCode);

    httpInFlight.set({}, inFlightDelta(-1));
    httpRequests.inc({ method: req.method, route, status });
    httpDuration.observe({ method: req.method, route }, durationSeconds);

    if (QUIET_PATHS.has(req.path) && res.statusCode < 400) {
      return;
    }

    // requestId is passed explicitly: an EventEmitter callback does not inherit
    // the AsyncLocalStorage store the way an awaited continuation does.
    logger.info("request", {
      requestId,
      method: req.method,
      route,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationSeconds * 1000),
    });
  });

  withRequestContext(requestId, next);
}

/**
 * In-flight is a gauge with no labels, so it is tracked as a plain number here
 * rather than read back out of the registry.
 */
let inFlight = 0;
function inFlightDelta(delta: number): number {
  inFlight = Math.max(0, inFlight + delta);
  return inFlight;
}
