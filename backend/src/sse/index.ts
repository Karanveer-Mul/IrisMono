import { Response } from "express";

interface ActiveConnection {
  userId: string;
  res: Response;
}

class SSEHub {
  // Map of organizationId -> array of active connections
  private connections: Map<string, ActiveConnection[]> = new Map();

  /**
   * Adds an active SSE connection for a user in an organization.
   */
  public addConnection(orgId: string, userId: string, res: Response) {
    if (!this.connections.has(orgId)) {
      this.connections.set(orgId, []);
    }

    const orgConnections = this.connections.get(orgId)!;
    
    // Setup clean SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    // PING event to establish connection immediately
    res.write("event: ping\ndata: {}\n\n");

    orgConnections.push({ userId, res });
    console.log(`SSE Connection established for user ${userId} in organization ${orgId}. Total active connections in org: ${orgConnections.length}`);

    // Heartbeat every 30 seconds to keep connection alive
    const heartbeatInterval = setInterval(() => {
      res.write("event: ping\ndata: {}\n\n");
    }, 30000);

    // Clean up connection when request is closed
    res.on("close", () => {
      clearInterval(heartbeatInterval);
      this.removeConnection(orgId, userId, res);
    });
  }

  /**
   * Removes a specific connection.
   */
  private removeConnection(orgId: string, userId: string, resToRemove: Response) {
    const orgConnections = this.connections.get(orgId);
    if (!orgConnections) return;

    const filtered = orgConnections.filter(conn => conn.res !== resToRemove);
    if (filtered.length === 0) {
      this.connections.delete(orgId);
    } else {
      this.connections.set(orgId, filtered);
    }
    console.log(`SSE Connection closed for user ${userId} in org ${orgId}. Remaining in org: ${filtered.length}`);
  }

  /**
   * Broadcasts a real-time message to all active client connections within an organization.
   */
  public broadcastToOrg(orgId: string, eventName: string, data: any) {
    const orgConnections = this.connections.get(orgId);
    if (!orgConnections || orgConnections.length === 0) {
      return;
    }

    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    
    orgConnections.forEach((conn) => {
      try {
        conn.res.write(payload);
      } catch (err) {
        console.error(`Failed to push SSE to user ${conn.userId}:`, err);
      }
    });
    console.log(`Broadcasted event '${eventName}' to organization ${orgId}.`);
  }
}

export const sseHub = new SSEHub();
