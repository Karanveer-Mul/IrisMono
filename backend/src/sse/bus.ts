import * as amqp from "amqplib";
import { sql } from "drizzle-orm";
import { systemDb } from "../db";
import { sseHub } from "./index";

/**
 * Cross-instance event bus for the SSE stream.
 *
 * Publishing an event does two things: it appends to job_events (so a client
 * that reconnects can replay what it missed), then fans out on a RabbitMQ
 * exchange so every API instance can deliver it to its own connected clients.
 *
 * A fanout exchange rather than Redis pub/sub: the stack already runs a message
 * broker, and adding a second piece of infrastructure to move a few hundred
 * bytes per job would be hard to justify. Each instance binds an exclusive,
 * auto-deleted queue, so instances can come and go without leaving queues
 * behind.
 */

const AMQP_URL = process.env.AMQP_URL || "amqp://guest:guest@localhost:5672";
export const SSE_EXCHANGE = "sse.fanout";

interface BusMessage {
  orgId: string;
  id: number;
  eventType: string;
  payload: unknown;
}

let channel: amqp.Channel | null = null;

export async function initSseBus() {
  try {
    const connection = await amqp.connect(AMQP_URL);
    const ch = await connection.createChannel();

    await ch.assertExchange(SSE_EXCHANGE, "fanout", { durable: false });

    // Exclusive and auto-delete: this queue belongs to this process only, and
    // disappears with it. Events are not durable here because durability lives
    // in job_events - a restarted instance replays from the table, not the
    // broker.
    const { queue } = await ch.assertQueue("", { exclusive: true, autoDelete: true });
    await ch.bindQueue(queue, SSE_EXCHANGE, "");

    await ch.consume(
      queue,
      (msg) => {
        if (!msg) return;
        try {
          const message = JSON.parse(msg.content.toString()) as BusMessage;
          sseHub.deliver(message.orgId, {
            id: message.id,
            eventType: message.eventType,
            payload: message.payload,
          });
        } catch (err) {
          console.error("Malformed SSE bus message:", err);
        }
      },
      { noAck: true }
    );

    channel = ch;

    connection.on("close", () => {
      console.log("SSE bus connection closed. Reconnecting...");
      channel = null;
      setTimeout(initSseBus, 5000);
    });

    connection.on("error", (err) => {
      console.error("SSE bus connection error:", err);
    });

    console.log(`SSE bus initialized on exchange '${SSE_EXCHANGE}'.`);
  } catch (err) {
    console.error("Failed to initialize the SSE bus:", err);
    setTimeout(initSseBus, 5000);
  }
}

/**
 * Records an event and fans it out to every API instance.
 *
 * The append happens first and is what makes the event real: if the broker is
 * unavailable, connected clients miss the live push but a reconnecting client
 * still replays it from job_events, and polling callers still see the job state
 * itself. Losing the push is a degraded experience, not lost data.
 */
export async function publishJobEvent(
  orgId: string,
  eventType: string,
  payload: Record<string, unknown> & { jobId?: string }
) {
  let eventId: number;

  try {
    const inserted = await systemDb.execute(sql`
      INSERT INTO job_events (organization_id, job_id, event_type, payload)
      VALUES (${orgId}, ${payload.jobId ?? null}, ${eventType}, ${JSON.stringify(payload)}::jsonb)
      RETURNING id
    `);
    eventId = Number((inserted.rows[0] as any).id);
  } catch (err) {
    console.error("Failed to record job event:", err);
    return;
  }

  if (!channel) {
    console.warn("SSE bus not connected; event recorded but not pushed live.");
    return;
  }

  try {
    const message: BusMessage = { orgId, id: eventId, eventType, payload };
    channel.publish(SSE_EXCHANGE, "", Buffer.from(JSON.stringify(message)));
  } catch (err) {
    console.error("Failed to fan out job event:", err);
  }
}

/** Removes event-log rows past the retention window. Returns the count. */
export async function pruneJobEvents(days: number): Promise<number> {
  const result = await systemDb.execute(sql`
    DELETE FROM job_events WHERE created_at < NOW() - ${`${days} days`}::interval
  `);
  return result.rowCount ?? 0;
}
