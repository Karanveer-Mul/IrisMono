import * as amqp from "amqplib";

const AMQP_URL = process.env.AMQP_URL || "amqp://guest:guest@localhost:5672";

/**
 * Queue topology.
 *
 * One queue per infrastructure tier, not one queue per tenant. The previous
 * `queue-vip-${orgId}` scheme meant unbounded queue proliferation and a
 * consumer topology that had to be reconfigured on every enterprise sale.
 *
 * Each work queue dead-letters to a shared exchange, so a message that cannot
 * be processed is parked for inspection rather than silently discarded.
 */
export const DLX_NAME = "jobs.dlx";

export const QUEUES = {
  STANDARD: "queue-standard-jobs",
  VIP: "queue-vip-jobs",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const ALL_QUEUES: QueueName[] = [QUEUES.STANDARD, QUEUES.VIP];

export function deadLetterQueueFor(queue: string) {
  return `${queue}.dlq`;
}

/**
 * Redelivery schedule for a job whose outcome could not be established.
 *
 * Distinct from the worker's in-process report retries, which cover a few
 * seconds of API unavailability. This covers the longer failure: the API is
 * being redeployed, the database is failing over, the machine has run out of
 * disk. Without it, every such message went straight to the dead-letter queue
 * and needed a human, while the reaper quietly refunded the credit - so a
 * thirty-second blip destroyed jobs that would have succeeded on a second try.
 *
 * Growing delays, because retrying hard against a dependency that is down is
 * how a brief outage becomes a long one.
 */
export const RETRY_DELAYS_MS: number[] = (process.env.JOB_RETRY_DELAYS_MS || "10000,60000,300000")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);

export function retryQueueFor(queue: string, attempt: number) {
  return `${queue}.retry.${attempt}`;
}

/** Header carrying how many times this message has already been retried. */
export const RETRY_COUNT_HEADER = "x-retry-count";

// amqplib >= 0.10.5 resolves connect() to ChannelModel, not Connection.
let connection: amqp.ChannelModel | null = null;
let channel: amqp.Channel | null = null;
/** Set by closeQueue, so a deliberate close is not mistaken for an outage. */
let shuttingDown = false;

/**
 * Declares the dead-letter exchange, the per-tier work queues, and their
 * dead-letter queues. Safe to call from both the API and the worker.
 */
export async function assertTopology(ch: amqp.Channel) {
  await ch.assertExchange(DLX_NAME, "direct", { durable: true });

  for (const queue of ALL_QUEUES) {
    const dlq = deadLetterQueueFor(queue);

    await ch.assertQueue(dlq, { durable: true });
    await ch.bindQueue(dlq, DLX_NAME, dlq);

    await ch.assertQueue(queue, {
      durable: true,
      arguments: {
        "x-dead-letter-exchange": DLX_NAME,
        "x-dead-letter-routing-key": dlq,
      },
    });

    // One holding queue per attempt, each with its own TTL.
    //
    // Nothing consumes these. A message published here sits until its TTL
    // expires, at which point RabbitMQ dead-letters it - and the dead-letter
    // route points back at the work queue, so expiry *is* the redelivery.
    //
    // A queue per attempt rather than a per-message TTL on one queue: TTL is
    // only honoured at the head, so a message with a five-minute delay parked
    // in front of a ten-second one would hold both for five minutes.
    for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      await ch.assertQueue(retryQueueFor(queue, attempt), {
        durable: true,
        arguments: {
          "x-message-ttl": RETRY_DELAYS_MS[attempt - 1],
          // The default exchange routes by queue name, so this returns the
          // message to the work queue it came from.
          "x-dead-letter-exchange": "",
          "x-dead-letter-routing-key": queue,
        },
      });
    }
  }
}

export async function initQueue() {
  try {
    const conn = await amqp.connect(AMQP_URL);
    connection = conn;

    const ch = await conn.createChannel();
    channel = ch;

    await assertTopology(ch);

    console.log("RabbitMQ queue connection initialized.");

    conn.on("error", (err) => {
      console.error("AMQP Connection error:", err);
      reconnect();
    });

    conn.on("close", () => {
      if (shuttingDown) {
        console.log("AMQP connection closed.");
        return;
      }
      console.log("AMQP Connection closed. Reconnecting...");
      reconnect();
    });
  } catch (err: any) {
    // A queue declared before the dead-letter arguments existed cannot be
    // redeclared with them - RabbitMQ answers PRECONDITION_FAILED. Deleting it
    // automatically could discard queued work, so say what to do instead.
    if (typeof err?.message === "string" && err.message.includes("PRECONDITION_FAILED")) {
      console.error(
        "Queue exists with different arguments. Drain it, then delete the old queue " +
        "so it can be redeclared with dead-lettering:\n" +
        "  docker exec irismono-rabbitmq rabbitmqctl delete_queue queue-standard-jobs"
      );
    }
    console.error("Failed to connect to RabbitMQ:", err);
    if (!shuttingDown) {
      setTimeout(initQueue, 5000); // Retry connection
    }
  }
}

async function reconnect() {
  if (shuttingDown) return;
  connection = null;
  channel = null;
  await initQueue();
}

export async function publishJob(
  queueName: string,
  message: { jobId: string; orgId: string; s3Key: string; requestId?: string }
) {
  if (!channel) {
    throw new Error("Message broker channel not initialized");
  }

  const payload = Buffer.from(JSON.stringify(message));
  // The correlation id rides with the message so the worker's logs and its
  // report back to the API join up with the browser request that started it.
  //
  // messageId is the job id: one job, one message, whatever happens to the
  // delivery. Dispatch itself is made single-shot in POST /jobs/:id/trigger,
  // so this is an assertion a broker-side consumer or an operator can rely on
  // rather than a hope.
  channel.sendToQueue(queueName, payload, {
    persistent: true,
    correlationId: message.requestId,
    messageId: message.jobId,
  });
  console.log(`Published job ${message.jobId} to queue: ${queueName}`);
}

/**
 * Parks a message in the next delay tier, or reports that it is out of tries.
 *
 * The original delivery is the caller's to acknowledge: this republishes the
 * content rather than nacking, because a nack would send it to the dead-letter
 * exchange immediately, which is the outcome being avoided.
 */
export function scheduleRetry(
  channel: amqp.Channel,
  queue: string,
  msg: amqp.ConsumeMessage
): { retried: false } | { retried: true; attempt: number; delayMs: number } {
  const previous = Number(msg.properties.headers?.[RETRY_COUNT_HEADER] ?? 0);
  const attempt = previous + 1;

  if (attempt > RETRY_DELAYS_MS.length) {
    return { retried: false };
  }

  channel.sendToQueue(retryQueueFor(queue, attempt), msg.content, {
    persistent: true,
    correlationId: msg.properties.correlationId,
    messageId: msg.properties.messageId,
    headers: { ...msg.properties.headers, [RETRY_COUNT_HEADER]: attempt },
  });

  return { retried: true, attempt, delayMs: RETRY_DELAYS_MS[attempt - 1] };
}

/**
 * Accessors rather than re-exported bindings.
 *
 * `export { channel }` publishes the value once, at module evaluation - when it
 * is still null. Every consumer would see null forever, including after a
 * successful reconnect.
 */
export function getChannel(): amqp.Channel | null {
  return channel;
}

export function isBrokerConnected(): boolean {
  return connection !== null && channel !== null;
}

/**
 * A separate channel for queue inspection.
 *
 * checkQueue on a queue that does not exist makes RabbitMQ close the channel.
 * Sampling depth on the publishing channel would therefore let a metrics call
 * break job dispatch, so the sampler gets its own.
 */
export async function createInspectionChannel(): Promise<amqp.Channel | null> {
  if (!connection) return null;
  return connection.createChannel();
}

/** Closes the broker connection. Used by graceful shutdown. */
export async function closeQueue() {
  const conn = connection;
  // Flagged and cleared first so the close handler does not treat this as an
  // outage and start reconnecting into a process that is on its way out.
  shuttingDown = true;
  connection = null;
  channel = null;

  if (conn) {
    try {
      await conn.close();
    } catch {
      // Already gone. Nothing to do on the way out.
    }
  }
}
