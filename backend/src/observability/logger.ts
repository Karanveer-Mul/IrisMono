import { AsyncLocalStorage } from "async_hooks";

/**
 * Structured logging with a correlation id.
 *
 * This is the cheap end of tracing, and it is the part that pays off first in
 * this system: one image passes through the browser, the API, RabbitMQ, a GPU
 * worker, and back into the API on a different connection. Without a shared id,
 * reconstructing a single failed job means correlating by timestamp across four
 * logs, which stops working the moment there is more than one worker.
 *
 * The id is generated at the edge, carried through the process by
 * AsyncLocalStorage, published on the job message, echoed by the worker, and
 * returned to the client in the x-request-id response header. A real deployment
 * should replace this with OpenTelemetry, whose context propagation is the same
 * idea with spans and a wire format; the log field name is deliberately the one
 * OTel would use.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs fn with a correlation id attached to everything it awaits. */
export function withRequestContext<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * Text by default because a human reads the dev console; JSON in deployment,
 * where a log shipper reads it and the fields have to survive intact.
 */
const asJson = () => (process.env.LOG_FORMAT || "text").toLowerCase() === "json";

// Read per call rather than at import: the worker sets LOG_SERVICE on itself at
// startup, and module initialisation order would otherwise decide whether that
// took effect.
const service = () => process.env.LOG_SERVICE || "api";

export function log(level: LogLevel, message: string, fields: Record<string, unknown> = {}) {
  const requestId = currentRequestId();
  const record = {
    ts: new Date().toISOString(),
    level,
    service: service(),
    msg: message,
    ...(requestId ? { requestId } : {}),
    ...fields,
  };

  const line = asJson()
    ? JSON.stringify(record)
    : `${record.ts} ${level.toUpperCase().padEnd(5)} ${requestId ? `[${requestId.slice(0, 8)}] ` : ""}${message}` +
      (Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "");

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => log("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => log("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => log("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => log("error", message, fields),
};
