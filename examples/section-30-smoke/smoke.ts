#!/usr/bin/env bun
/**
 * Section 30 — Backend adapter completions — end-to-end smoke.
 *
 * Six probes, one per family:
 *   1. queue: SQS adapter contract via stub fetch
 *   2. queue: Postgres adapter contract via stub PG client
 *   3. vector: lance file-backed upsert + query
 *   4. telephony: Twilio dial via stub fetch
 *   5. realtime: Vapi handshake via stub WebSocket
 *   6. browser: remote driver via stub puppeteer-core
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TwilioAdapterOptions, createTwilioTelephonyAdapter } from "@crewhaus/call-session";
import {
  type HostExecutor,
  type PuppeteerCoreLike,
  createHostDriver,
  createRemoteDriver,
} from "@crewhaus/computer-use-driver";
import {
  type PostgresClientLike,
  type SqsClientLike,
  createPostgresAdapter,
  createSqsAdapter,
} from "@crewhaus/queue-protocol";
import { createLanceVectorStore } from "@crewhaus/vector-store";
import {
  type WebSocketFactory,
  type WebSocketLike,
  createVapiRealtimeAdapter,
} from "@crewhaus/voice-runtime";

const log = (m: string): void => {
  process.stderr.write(`[smoke-30] ${m}\n`);
};
const fail = (m: string): never => {
  process.stderr.write(`[smoke-30] FAIL: ${m}\n`);
  process.exit(2);
};
const ok = (m: string): void => {
  process.stderr.write(`[smoke-30] ✓ ${m}\n`);
};

const main = async (): Promise<void> => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "smoke30-"));

  try {
    // ────────── Probe 1: SQS adapter ──────────
    {
      log("probe 1: queue/sqs — pull + ack via stub client");
      const stubClient: SqsClientLike = {
        receiveMessage: async () => ({
          Messages: [
            { MessageId: "m1", ReceiptHandle: "rh1", Body: JSON.stringify({ task: "x" }) },
          ],
        }),
        deleteMessage: async () => undefined,
        changeMessageVisibility: async () => undefined,
      };
      const adapter = createSqsAdapter({
        queueUrl: "https://sqs.test/q",
        region: "us-east-1",
        _client: stubClient,
      });
      const jobs = await adapter.pull({ maxJobs: 5 });
      if (jobs.length !== 1) fail(`expected 1 job, got ${jobs.length}`);
      const job = jobs[0];
      if (!job) fail("expected job");
      else await adapter.ack(job.id);
      ok("queue/sqs: pull → ack round-trip via stub");
    }

    // ────────── Probe 2: Postgres adapter ──────────
    {
      log("probe 2: queue/postgres — pull + ack via stub client");
      const stubClient: PostgresClientLike = {
        query: async (text) => {
          if (text.includes("UPDATE")) {
            return {
              rows: [
                {
                  id: "j1",
                  payload: JSON.stringify({ task: "y" }),
                  enqueued_at: new Date().toISOString(),
                  visibility_expires_at: new Date(Date.now() + 60_000).toISOString(),
                  attempt: 1,
                },
              ],
            };
          }
          return { rows: [] };
        },
      };
      const adapter = createPostgresAdapter({ tableName: "jobs", _client: stubClient });
      const jobs = await adapter.pull({});
      if (jobs.length !== 1) fail(`expected 1 job, got ${jobs.length}`);
      ok("queue/postgres: SELECT FOR UPDATE SKIP LOCKED + ack");
    }

    // ────────── Probe 3: Lance vector store ──────────
    {
      log("probe 3: vector/lance — upsert + query");
      const store = createLanceVectorStore({ path: join(tmpRoot, "lance") });
      await store.upsert("a", [1, 0, 0], { tag: "x" });
      await store.upsert("b", [0, 1, 0], { tag: "y" });
      await store.upsert("c", [0.99, 0.01, 0]);
      const hits = await store.query([1, 0, 0], 2);
      if (hits[0]?.id !== "a") fail(`expected first hit "a", got "${hits[0]?.id}"`);
      const count = await store.count();
      if (count !== 3) fail(`expected count 3, got ${count}`);
      ok("vector/lance: 3 vectors persisted; top-2 query ranks correctly");
    }

    // ────────── Probe 4: Twilio telephony ──────────
    {
      log("probe 4: telephony/twilio — dial via stub fetch");
      let observedFrom = "";
      const fetchImpl = (async (_url: string, init?: RequestInit) => {
        if ((init?.body as string)?.includes("From=")) {
          const params = new URLSearchParams(init?.body as string);
          observedFrom = params.get("From") ?? "";
        }
        return new Response(JSON.stringify({ sid: "CA123" }), { status: 200 });
      }) as unknown as typeof fetch;
      const opts: TwilioAdapterOptions = {
        accountSid: "ACtest",
        authToken: "tok",
        fromNumber: "+15551234567",
        fetchImpl,
      };
      const adapter = createTwilioTelephonyAdapter(opts);
      await adapter.dial("+15559876543");
      if (observedFrom !== "+15551234567") fail(`unexpected From: "${observedFrom}"`);
      ok(`telephony/twilio: dial sent From=${observedFrom}`);
    }

    // ────────── Probe 5: Vapi realtime ──────────
    {
      log("probe 5: realtime/vapi — handshake via stub WebSocket");
      const sentMessages: string[] = [];
      const stubFactory: WebSocketFactory = (_url, _init) => {
        const listeners = new Map<string, (ev: unknown) => void>();
        const ws: WebSocketLike = {
          readyState: 1,
          send(data: string | ArrayBuffer): void {
            if (typeof data === "string") sentMessages.push(data);
          },
          close(): void {},
          addEventListener(type, handler): void {
            listeners.set(type, handler);
          },
        };
        queueMicrotask(() => listeners.get("open")?.({}));
        return ws;
      };
      const adapter = createVapiRealtimeAdapter({
        apiKey: "test",
        assistantId: "asst_xyz",
        _ws: stubFactory,
      });
      await adapter.connect({
        model: "vapi-realtime",
        voice: "alloy",
        instructions: "be concise",
      });
      if (!adapter.connected) fail("expected vapi adapter to be connected");
      const sessionUpdate = sentMessages.find((m) => m.includes("session.update"));
      if (!sessionUpdate?.includes("asst_xyz")) {
        fail(`expected session.update with assistant_id, got ${sessionUpdate}`);
      }
      ok("realtime/vapi: handshake → session.update with assistant_id");
    }

    // ────────── Probe 6: Remote browser driver ──────────
    {
      log("probe 6: browser/remote — connect + click via stub puppeteer-core");
      const ops: string[] = [];
      const stubPuppeteer: PuppeteerCoreLike = {
        async connect(): Promise<never> {
          ops.push("connect");
          const page = {
            async goto(url: string) {
              ops.push(`goto ${url}`);
            },
            async screenshot(): Promise<string> {
              ops.push("screenshot");
              return "base64-data";
            },
            mouse: {
              async click(x: number, y: number) {
                ops.push(`click ${x},${y}`);
              },
            },
            keyboard: {
              async type() {},
              async press() {},
            },
            async evaluate<T>(_fn: () => T): Promise<T> {
              return undefined as unknown as T;
            },
            async close() {
              ops.push("close-page");
            },
          };
          return {
            async newPage() {
              return page;
            },
            async close() {
              ops.push("close-browser");
            },
          } as never;
        },
      };
      const driver = createRemoteDriver({ url: "ws://test", _puppeteer: stubPuppeteer });
      await driver.connect();
      await driver.goto("https://x.com");
      await driver.click(100, 200);
      await driver.disconnect();
      if (!ops.includes("connect")) fail("missing connect");
      if (!ops.includes("goto https://x.com")) fail("missing goto");
      if (!ops.includes("click 100,200")) fail("missing click");
      ok("browser/remote: connect + goto + click via stub puppeteer-core");
    }

    log("all probes passed.");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
};

main().catch((err) => {
  process.stderr.write(
    `[smoke-30] threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
