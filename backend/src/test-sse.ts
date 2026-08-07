/**
 * SSE bus test.
 *
 * Two properties the old in-process hub could not provide:
 *
 *   Cross-instance  An event published on one API instance must reach a client
 *                   connected to a different one. Without this the notification
 *                   layer cannot scale past a single process, which defeats the
 *                   asynchronous design it exists to serve.
 *   Replay          A client that drops mid-job must learn the outcome when it
 *                   reconnects, rather than waiting for a poll.
 *
 * Requires TWO API instances: the usual one on 3000, and a second on 3002:
 *   PORT=3002 npx tsx src/index.ts
 *
 * Run with: npx tsx src/test-sse.ts
 */
import { pool, authPool, adminPool } from "./db";

const A = "http://localhost:3000/api"; // instance A - client connects here
const B = "http://localhost:3002/api"; // instance B - events published here
const WORKER_SECRET = process.env.WORKER_SECRET || "local-dev-worker-secret";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

async function register(email: string, orgName: string) {
  const r = await fetch(`${A}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "secure_password_123", orgName }),
  });
  if (!r.ok) throw new Error(`register failed: ${await r.text()}`);
  return (await r.json()).token as string;
}

async function streamToken(token: string, base = A) {
  const r = await fetch(`${base}/auth/stream-token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`stream token failed: ${await r.text()}`);
  return (await r.json()).token as string;
}

interface Received {
  id: string;
  event: string;
  data: any;
}

/** Minimal SSE client: collects parsed events until aborted. */
function openStream(url: string) {
  const controller = new AbortController();
  const events: Received[] = [];
  const ready = (async () => {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status !== 200) throw new Error(`stream returned HTTP ${res.status}`);

    (async () => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let split: number;
          while ((split = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);

            let id = "";
            let event = "";
            let data = "";
            for (const line of frame.split("\n")) {
              if (line.startsWith("id:")) id = line.slice(3).trim();
              else if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data = line.slice(5).trim();
            }
            if (event && event !== "ping") {
              events.push({ id, event, data: data ? JSON.parse(data) : null });
            }
          }
        }
      } catch { /* aborted */ }
    })();

    return res;
  })();

  return { events, ready, close: () => controller.abort() };
}

async function waitFor<T>(probe: () => T | null, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = probe();
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("timed out waiting for an event");
}

async function reserveJob(token: string, base = A) {
  const r = await fetch(`${base}/jobs/request`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`reserve failed: ${await r.text()}`);
  return (await r.json()).jobId as string;
}

async function report(base: string, jobId: string, body: Record<string, unknown>) {
  const r = await fetch(`${base}/jobs/${jobId}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-worker-secret": WORKER_SECRET },
    body: JSON.stringify(body),
  });
  return r.status;
}

async function run() {
  console.log("=== SSE BUS TEST ===\n");

  // Both instances must be up, or the cross-instance claim proves nothing.
  const healthB = await fetch("http://localhost:3002/health").catch(() => null);
  assert(!!healthB && healthB.status === 200, "instance B is not running on 3002 - start it with PORT=3002 npx tsx src/index.ts");
  console.log("Both API instances reachable (3000, 3002)\n");

  const stamp = Date.now();
  const token = await register(`sse.${stamp}@alpha-health.org`, `SSE Hospital ${stamp}`);

  console.log("1. Client connects to instance A");
  const st = await streamToken(token);
  const stream = openStream(`http://localhost:3000/api/jobs/events?token=${encodeURIComponent(st)}`);
  await stream.ready;
  console.log("-> connected");

  console.log("\n2. Event published on instance B must reach that client");
  const job = await reserveJob(token, B);
  assert(await report(B, job, { status: "PROCESSING", workerId: "test-b" }) === 200, "report to B failed");

  const crossed = await waitFor(() => stream.events.find((e) => e.data?.jobId === job) ?? null);
  console.log(`-> received id ${crossed.id}: ${crossed.event} ${crossed.data.status}`);
  assert(crossed.data.status === "PROCESSING", "wrong event delivered");
  assert(crossed.id !== "", "event carried no id, so it cannot be resumed from");

  const lastId = crossed.id;

  console.log("\n3. Client disconnects; work continues without it");
  stream.close();
  await new Promise((r) => setTimeout(r, 500));

  assert(
    await report(B, job, {
      status: "SUCCESS",
      maskImageS3Key: "somewhere/mask.png",
      modelVersion: "sse-test-model",
      workerId: "test-b",
    }) === 200,
    "completion report failed"
  );
  console.log("-> job completed while the client was away");

  console.log("\n4. Reconnect with Last-Event-ID replays what was missed");
  const st2 = await streamToken(token);
  const resumed = openStream(
    `http://localhost:3000/api/jobs/events?token=${encodeURIComponent(st2)}&lastEventId=${lastId}`
  );
  await resumed.ready;

  const replayed = await waitFor(
    () => resumed.events.find((e) => e.data?.jobId === job && e.data?.status === "SUCCESS") ?? null
  );
  console.log(`-> replayed id ${replayed.id}: ${replayed.event} ${replayed.data.status}`);
  assert(Number(replayed.id) > Number(lastId), "replayed an event the client had already seen");

  console.log("\n5. Replay does not resend events before Last-Event-ID");
  const duplicates = resumed.events.filter((e) => Number(e.id) <= Number(lastId));
  console.log(`-> ${duplicates.length} duplicate(s)`);
  assert(duplicates.length === 0, "replay resent already-delivered events");

  console.log("\n6. Live delivery still works after a resume");
  const second = await reserveJob(token, B);
  assert(await report(B, second, { status: "PROCESSING", workerId: "test-b" }) === 200, "second report failed");
  const live = await waitFor(() => resumed.events.find((e) => e.data?.jobId === second) ?? null);
  console.log(`-> received id ${live.id} live after resuming`);

  resumed.close();

  console.log("\n=== SSE BUS VERIFIED: events cross instances, and nothing is missed across a drop ===");
}

run()
  .then(async () => {
    await Promise.all([pool.end(), authPool.end(), adminPool.end()]);
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nSSE BUS TEST FAILED:", e.message);
    await Promise.all([pool.end(), authPool.end(), adminPool.end()]).catch(() => {});
    process.exit(1);
  });
