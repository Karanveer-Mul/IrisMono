import * as amqp from "amqplib";
import { ALL_QUEUES, createInspectionChannel, deadLetterQueueFor, isBrokerConnected } from "../queue";

/**
 * Queue depth sampling.
 *
 * Depth is the autoscaling input: how many images are waiting is the only
 * direct measure of how much GPU capacity is currently owed. Consumer count is
 * the companion signal - depth rising with consumers at zero is a stopped
 * fleet, depth rising with consumers healthy is genuine demand, and those two
 * want opposite responses.
 *
 * Dead-letter depth is separate and should alert at any non-zero value: a
 * message there is work that was accepted, charged for, and then abandoned.
 */

export interface QueueSample {
  queue: string;
  messages: number;
  consumers: number;
  /** True for the dead-letter queue of a work queue. */
  deadLetter: boolean;
}

let inspectionChannel: amqp.Channel | null = null;

async function channelForInspection(): Promise<amqp.Channel | null> {
  if (inspectionChannel) return inspectionChannel;
  if (!isBrokerConnected()) return null;

  const ch = await createInspectionChannel();
  if (!ch) return null;

  // A failed checkQueue closes the channel. Drop the reference so the next
  // sample opens a fresh one rather than reusing a dead handle.
  ch.on("error", () => {
    inspectionChannel = null;
  });
  ch.on("close", () => {
    inspectionChannel = null;
  });

  inspectionChannel = ch;
  return ch;
}

export async function sampleQueues(): Promise<QueueSample[]> {
  const channel = await channelForInspection();
  if (!channel) return [];

  const samples: QueueSample[] = [];

  for (const queue of ALL_QUEUES) {
    for (const [name, deadLetter] of [
      [queue, false],
      [deadLetterQueueFor(queue), true],
    ] as const) {
      try {
        const info = await channel.checkQueue(name);
        samples.push({
          queue: name,
          messages: info.messageCount,
          consumers: info.consumerCount,
          deadLetter,
        });
      } catch {
        // Queue missing or channel closed underneath us. Reported as absent
        // rather than as zero - a queue that is not there is not empty.
        inspectionChannel = null;
        break;
      }
    }
  }

  return samples;
}

/**
 * Round-trips a request to the broker.
 *
 * Deliberately more than "is the socket open": a connection object can look
 * alive while the broker has stopped answering.
 */
export async function probeBroker(): Promise<void> {
  const channel = await channelForInspection();
  if (!channel) {
    throw new Error("No broker connection");
  }
  await channel.checkQueue(ALL_QUEUES[0]);
}

export function resetInspectionChannel() {
  inspectionChannel = null;
}
