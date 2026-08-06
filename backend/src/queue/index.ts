import * as amqp from "amqplib";

const AMQP_URL = process.env.AMQP_URL || "amqp://guest:guest@localhost:5672";

let connection: amqp.Connection | null = null;
let channel: amqp.Channel | null = null;

export async function initQueue() {
  try {
    connection = await amqp.connect(AMQP_URL);
    channel = await connection.createChannel();
    
    // Declare standard jobs queue
    await channel.assertQueue("queue-standard-jobs", { durable: true });
    
    console.log("RabbitMQ queue connection initialized.");
    
    connection.on("error", (err) => {
      console.error("AMQP Connection error:", err);
      reconnect();
    });

    connection.on("close", () => {
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
