import * as amqp from "amqplib";

const AMQP_URL = process.env.AMQP_URL || "amqp://guest:guest@localhost:5672";

// amqplib >= 0.10.5 resolves connect() to ChannelModel, not Connection.
let connection: amqp.ChannelModel | null = null;
let channel: amqp.Channel | null = null;

export async function initQueue() {
  try {
    const conn = await amqp.connect(AMQP_URL);
    connection = conn;

    const ch = await conn.createChannel();
    channel = ch;

    // Declare standard jobs queue
    await ch.assertQueue("queue-standard-jobs", { durable: true });

    console.log("RabbitMQ queue connection initialized.");

    conn.on("error", (err) => {
      console.error("AMQP Connection error:", err);
      reconnect();
    });

    conn.on("close", () => {
      console.log("AMQP Connection closed. Reconnecting...");
      reconnect();
    });
  } catch (err) {
    console.error("Failed to connect to RabbitMQ:", err);
    setTimeout(initQueue, 5000); // Retry connection
  }
}

async function reconnect() {
  connection = null;
  channel = null;
  await initQueue();
}

export async function publishJob(queueName: string, message: { jobId: string; orgId: string; s3Key: string }) {
  if (!channel) {
    throw new Error("Message broker channel not initialized");
  }

  // Ensure targeted queue exists
  await channel.assertQueue(queueName, { durable: true });
  
  const payload = Buffer.from(JSON.stringify(message));
  channel.sendToQueue(queueName, payload, { persistent: true });
  console.log(`Published job ${message.jobId} to queue: ${queueName}`);
}

export { connection, channel };
