import { Response } from "express";
import { and, eq, gt } from "drizzle-orm";
import { withTenant } from "../db";
import { jobEvents } from "../db/schema";

/** How many missed events a reconnecting client may replay in one go. */
const MAX_REPLAY = 200;

export interface DeliverableEvent {
  id: number;
  eventType: string;
  payload: unknown;
}

interface ActiveConnection {
  userId: string;
  res: Response;
  /** Events delivered while the initial replay is still running. */
  buffer: DeliverableEvent[] | null;
  /** Highest id already written to this client. */
  deliveredThrough: number;
}

/**
 * Per-process fan-out to connected browsers.
 *
 * This class only knows about the clients attached to *this* instance. Getting
 * an event to every instance is the bus's job (src/sse/bus.ts); the hub is what
 * turns a received event into bytes on the right sockets.
 */
class SSEHub {
  // Map of organizationId -> array of active connections
  private connections: Map<string, ActiveConnection[]> = new Map();

  /**
   * Attaches a client, replaying anything it missed.
   *
   * lastEventId comes from the Last-Event-ID header that EventSource resends
   * automatically on reconnect, so a client that dropped during a two-minute
   * job still learns the outcome. The connection is registered *before* the
   * replay query runs and buffers live events until the replay finishes -
   * otherwise an event arriving mid-replay would fall through the gap.
   */
  public async addConnection(orgId: string, userId: string, res: Response, lastEventId: number | null) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const connection: ActiveConnection = {
      userId,
      res,
      buffer: [],
      deliveredThrough: lastEventId ?? 0,
    };

    const orgConnections = this.connections.get(orgId) ?? [];
    orgConnections.push(connection);
    this.connections.set(orgId, orgConnections);

    console.log(
      `SSE connection established for user ${userId} in organization ${orgId}. ` +
      `Total active connections in org: ${orgConnections.length}`
    );

    const heartbeatInterval = setInterval(() => {
      res.write("event: ping\ndata: {}\n\n");
    }, 30000);

    res.on("close", () => {
      clearInterval(heartbeatInterval);
      this.removeConnection(orgId, userId, res);
    });

    // PING establishes the connection immediately, before any replay work.
    res.write("event: ping\ndata: {}\n\n");

    try {
      if (lastEventId !== null) {
        const missed = await withTenant(orgId, (tx) =>
          tx.query.jobEvents.findMany({
            where: and(eq(jobEvents.organizationId, orgId), gt(jobEvents.id, lastEventId)),
            orderBy: (e, { asc }) => [asc(e.id)],
            limit: MAX_REPLAY,
          })
        );

        for (const event of missed) {
          this.write(connection, { id: event.id, eventType: event.eventType, payload: event.payload });
        }

        if (missed.length > 0) {
          console.log(`SSE replayed ${missed.length} missed event(s) to user ${userId} from id ${lastEventId}.`);
        }
      }
    } catch (err) {
      console.error("SSE replay failed:", err);
    } finally {
      // Flush anything that arrived during the replay, then go live.
      const buffered = connection.buffer ?? [];
      connection.buffer = null;
      for (const event of buffered) {
        this.write(connection, event);
      }
    }
  }

  private removeConnection(orgId: string, userId: string, resToRemove: Response) {
    const orgConnections = this.connections.get(orgId);
    if (!orgConnections) return;

    const filtered = orgConnections.filter((conn) => conn.res !== resToRemove);
    if (filtered.length === 0) {
      this.connections.delete(orgId);
    } else {
      this.connections.set(orgId, filtered);
    }
    console.log(`SSE connection closed for user ${userId} in org ${orgId}. Remaining in org: ${filtered.length}`);
  }

  /** Writes one event, skipping anything this client has already seen. */
  private write(connection: ActiveConnection, event: DeliverableEvent) {
    if (event.id <= connection.deliveredThrough) {
      return; // Already delivered, or replaced by the replay.
    }

    try {
      connection.res.write(
        `id: ${event.id}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event.payload)}\n\n`
      );
      connection.deliveredThrough = event.id;
    } catch (err) {
      console.error(`Failed to push SSE to user ${connection.userId}:`, err);
    }
  }

  /**
   * Delivers an event to this instance's clients for an organization.
   *
   * Called by the bus for every event, whichever instance originated it.
   */
  public deliver(orgId: string, event: DeliverableEvent) {
    const orgConnections = this.connections.get(orgId);
    if (!orgConnections || orgConnections.length === 0) {
      return;
    }

    for (const connection of orgConnections) {
      if (connection.buffer) {
        connection.buffer.push(event); // Still replaying; flushed on completion.
      } else {
        this.write(connection, event);
      }
    }

    console.log(`Delivered '${event.eventType}' to ${orgConnections.length} local connection(s) in org ${orgId}.`);
  }

  /** Local connection count, for diagnostics. */
  public localConnectionCount() {
    let total = 0;
    for (const conns of this.connections.values()) total += conns.length;
    return total;
  }
}

export const sseHub = new SSEHub();
