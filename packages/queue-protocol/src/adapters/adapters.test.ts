/**
 * Section 30 — contract tests for the new queue adapters.
 *
 * Each adapter is wired to a stub client that mimics the SDK shape.
 * The contract corpus exercises the same lifecycle the in-memory
 * adapter passes: pull → ack ; pull → nack(transient) → re-pull ;
 * pull → nack(permanent) → dead-letter.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueueProtocolError } from "../index";
import { type PostgresClientLike, createPostgresAdapter } from "./postgres";
import { type RedisClientLike, createRedisStreamsAdapter } from "./redis-streams";
import { type SqsClientLike, createSqsAdapter } from "./sqs";

// These adapters use plain dependency injection (`_client`) — no real
// Postgres/Redis/SQS connection, no real clock dependency in assertions, and
// no leaked handles/sockets. We still restore any module mock after each test
// so a future `mock.module(...)` here can never bleed into a sibling test.
afterEach(() => {
  mock.restore();
});

describe("sqs adapter — T2 contract", () => {
  test("pull returns deserialized jobs", async () => {
    const client: SqsClientLike = {
      receiveMessage: async () => ({
        Messages: [
          {
            MessageId: "msg-1",
            ReceiptHandle: "rh-1",
            Body: JSON.stringify({ job: "value" }),
          },
        ],
      }),
      deleteMessage: async () => undefined,
      changeMessageVisibility: async () => undefined,
    };
    const adapter = createSqsAdapter({
      queueUrl: "https://sqs.test/queue",
      region: "us-east-1",
      _client: client,
    });
    const jobs = await adapter.pull({ maxJobs: 5, visibilityTimeoutMs: 30_000 });
    expect(jobs.length).toBe(1);
    expect(jobs[0]?.id).toBe("msg-1");
    expect(jobs[0]?.input).toEqual({ job: "value" });
  });

  test("ack deletes the message", async () => {
    let deleteCalls = 0;
    const client: SqsClientLike = {
      receiveMessage: async () => ({
        Messages: [{ MessageId: "msg-1", ReceiptHandle: "rh-1", Body: "{}" }],
      }),
      deleteMessage: async () => {
        deleteCalls++;
      },
      changeMessageVisibility: async () => undefined,
    };
    const adapter = createSqsAdapter({
      queueUrl: "https://sqs.test/queue",
      region: "us-east-1",
      _client: client,
    });
    const jobs = await adapter.pull({});
    if (!jobs[0]) throw new Error("expected job");
    await adapter.ack(jobs[0].id);
    expect(deleteCalls).toBe(1);
  });

  test("nack(transient) resets visibility to 0", async () => {
    let resetTo: number | undefined;
    const client: SqsClientLike = {
      receiveMessage: async () => ({
        Messages: [{ MessageId: "msg-1", ReceiptHandle: "rh-1", Body: "{}" }],
      }),
      deleteMessage: async () => undefined,
      changeMessageVisibility: async (input) => {
        resetTo = input.VisibilityTimeout;
      },
    };
    const adapter = createSqsAdapter({
      queueUrl: "u",
      region: "r",
      _client: client,
    });
    const jobs = await adapter.pull({});
    if (!jobs[0]) throw new Error("expected job");
    await adapter.nack(jobs[0].id, "transient");
    expect(resetTo).toBe(0);
  });

  test("nack(permanent) deletes (relying on SQS redrive policy for DLQ)", async () => {
    let deleteCalls = 0;
    const client: SqsClientLike = {
      receiveMessage: async () => ({
        Messages: [{ MessageId: "msg-1", ReceiptHandle: "rh-1", Body: "{}" }],
      }),
      deleteMessage: async () => {
        deleteCalls++;
      },
      changeMessageVisibility: async () => undefined,
    };
    const adapter = createSqsAdapter({
      queueUrl: "u",
      region: "r",
      _client: client,
    });
    const jobs = await adapter.pull({});
    if (!jobs[0]) throw new Error("expected job");
    await adapter.nack(jobs[0].id, "permanent");
    const stats = await adapter.stats();
    expect(stats.deadLetter).toBe(1);
    expect(deleteCalls).toBe(1);
  });

  test("missing queueUrl throws", () => {
    expect(() =>
      createSqsAdapter({ queueUrl: "", region: "us-east-1", _client: {} as never }),
    ).toThrow(QueueProtocolError);
  });
});

describe("redis-streams adapter — T2 contract", () => {
  test("pull deserializes payloads", async () => {
    const client: RedisClientLike = {
      xreadgroup: async () => [
        {
          stream: "s",
          messages: [{ id: "1-0", fields: { payload: JSON.stringify({ job: "value" }) } }],
        },
      ],
      xack: async () => 1,
      xadd: async () => "1-1",
    };
    const adapter = createRedisStreamsAdapter({
      streamKey: "s",
      consumerGroup: "g",
      consumerName: "c",
      _client: client,
    });
    const jobs = await adapter.pull({ maxJobs: 1 });
    expect(jobs.length).toBe(1);
    expect(jobs[0]?.input).toEqual({ job: "value" });
  });

  test("nack(permanent) writes to dead-letter stream when configured", async () => {
    let dlqWrites = 0;
    const client: RedisClientLike = {
      xreadgroup: async () => null,
      xack: async () => 1,
      xadd: async (streamKey: string) => {
        if (streamKey === "dlq") dlqWrites++;
        return "1-0";
      },
    };
    const adapter = createRedisStreamsAdapter({
      streamKey: "s",
      consumerGroup: "g",
      consumerName: "c",
      deadLetterStream: "dlq",
      _client: client,
    });
    await adapter.nack("1-0", "permanent");
    expect(dlqWrites).toBe(1);
  });

  test("missing streamKey throws", () => {
    expect(() =>
      createRedisStreamsAdapter({
        streamKey: "",
        consumerGroup: "g",
        consumerName: "c",
        _client: {} as never,
      }),
    ).toThrow(QueueProtocolError);
  });
});

describe("postgres adapter — T2 contract", () => {
  test("pull issues SELECT … FOR UPDATE SKIP LOCKED", async () => {
    const queries: string[] = [];
    const client: PostgresClientLike = {
      query: async (text) => {
        queries.push(text);
        if (text.includes("UPDATE")) {
          return {
            rows: [
              {
                id: "j1",
                payload: JSON.stringify({ job: "value" }),
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
    const adapter = createPostgresAdapter({ tableName: "jobs", _client: client });
    const jobs = await adapter.pull({ maxJobs: 5 });
    expect(jobs.length).toBe(1);
    expect(jobs[0]?.input).toEqual({ job: "value" });
    expect(queries[0]).toContain("FOR UPDATE SKIP LOCKED");
  });

  test("ack deletes the row", async () => {
    let deletes = 0;
    const client: PostgresClientLike = {
      query: async (text) => {
        if (text.includes("DELETE")) deletes++;
        return { rows: [] };
      },
    };
    const adapter = createPostgresAdapter({ tableName: "jobs", _client: client });
    await adapter.ack("j1");
    expect(deletes).toBe(1);
  });

  test("nack(permanent) inserts into dead-letter table", async () => {
    let dlqInsert = false;
    const client: PostgresClientLike = {
      query: async (text) => {
        if (text.includes("INSERT INTO dead_letter")) dlqInsert = true;
        return { rows: [] };
      },
    };
    const adapter = createPostgresAdapter({
      tableName: "jobs",
      deadLetterTable: "dead_letter",
      _client: client,
    });
    await adapter.nack("j1", "permanent");
    expect(dlqInsert).toBe(true);
  });

  test("rejects sql-injection in tableName", () => {
    expect(() =>
      createPostgresAdapter({
        tableName: "jobs; DROP TABLE users;",
        _client: {} as never,
      }),
    ).toThrow(QueueProtocolError);
  });
});

describe("queue-protocol — adapter requireClient stubs throw without SDKs", () => {
  test("sqs without _client throws QueueProtocolError on construction", () => {
    expect(() => createSqsAdapter({ queueUrl: "u", region: "r" })).toThrow(QueueProtocolError);
  });

  test("redis-streams without _client throws", () => {
    expect(() =>
      createRedisStreamsAdapter({ streamKey: "s", consumerGroup: "g", consumerName: "c" }),
    ).toThrow(QueueProtocolError);
  });

  test("postgres without _client throws", () => {
    expect(() => createPostgresAdapter({ tableName: "jobs" })).toThrow(QueueProtocolError);
  });
});

// ---------------------------------------------------------------------------
// Section 30 — STRICT coverage: every adapter line + function, including the
// error/retry paths and the no-op / counter branches.
// ---------------------------------------------------------------------------

describe("sqs adapter — full lifecycle coverage", () => {
  /** Build a stub SQS client that records every call for assertions. */
  function makeClient(overrides: Partial<SqsClientLike> = {}): {
    client: SqsClientLike;
    deleted: Array<{ QueueUrl: string; ReceiptHandle: string }>;
    visibilityChanges: Array<{ ReceiptHandle: string; VisibilityTimeout: number }>;
  } {
    const deleted: Array<{ QueueUrl: string; ReceiptHandle: string }> = [];
    const visibilityChanges: Array<{ ReceiptHandle: string; VisibilityTimeout: number }> = [];
    const client: SqsClientLike = {
      receiveMessage: async () => ({
        Messages: [{ MessageId: "msg-1", ReceiptHandle: "rh-1", Body: JSON.stringify({ k: "v" }) }],
      }),
      deleteMessage: async (input) => {
        deleted.push(input);
      },
      changeMessageVisibility: async (input) => {
        visibilityChanges.push({
          ReceiptHandle: input.ReceiptHandle,
          VisibilityTimeout: input.VisibilityTimeout,
        });
      },
      ...overrides,
    };
    return { client, deleted, visibilityChanges };
  }

  test("pull falls back to raw Body when payload is not JSON (line 75)", async () => {
    const { client } = makeClient({
      receiveMessage: async () => ({
        Messages: [{ MessageId: "msg-raw", ReceiptHandle: "rh-raw", Body: "not-json-at-all" }],
      }),
    });
    const adapter = createSqsAdapter({ queueUrl: "u", region: "r", _client: client });
    const jobs = await adapter.pull({});
    expect(jobs.length).toBe(1);
    // JSON.parse throws → catch keeps the raw string.
    expect(jobs[0]?.input).toBe("not-json-at-all");
  });

  test("pull skips messages missing MessageId/ReceiptHandle/Body", async () => {
    const { client } = makeClient({
      receiveMessage: async () => ({
        Messages: [
          { ReceiptHandle: "rh", Body: "{}" }, // no MessageId
          { MessageId: "m", Body: "{}" }, // no ReceiptHandle
          { MessageId: "m", ReceiptHandle: "rh" }, // no Body
          { MessageId: "ok", ReceiptHandle: "rh-ok", Body: "{}" },
        ],
      }),
    });
    const adapter = createSqsAdapter({ queueUrl: "u", region: "r", _client: client });
    const jobs = await adapter.pull({});
    expect(jobs.map((j) => j.id)).toEqual(["ok"]);
  });

  test("pull handles an empty receive (no Messages field)", async () => {
    const { client } = makeClient({ receiveMessage: async () => ({}) });
    const adapter = createSqsAdapter({ queueUrl: "u", region: "r", _client: client });
    expect(await adapter.pull({})).toEqual([]);
  });

  test("nack(transient) resets visibility, drops the receipt, bumps nacked (lines 103-112)", async () => {
    const { client, visibilityChanges } = makeClient();
    const adapter = createSqsAdapter({ queueUrl: "u", region: "r", _client: client });
    const [job] = await adapter.pull({});
    if (!job) throw new Error("expected job");
    await adapter.nack(job.id, "transient");
    expect(visibilityChanges).toEqual([{ ReceiptHandle: "rh-1", VisibilityTimeout: 0 }]);
    const stats = await adapter.stats();
    expect(stats.nacked).toBe(1);
    expect(stats.deadLetter).toBe(0);
    // Receipt was deleted from the in-flight map.
    expect(stats.inFlight).toBe(0);
    // A second nack for the same id now has no receipt → throws.
    await expect(adapter.nack(job.id, "transient")).rejects.toThrow(QueueProtocolError);
  });

  test("nack(permanent) deletes from main queue and bumps deadLetter+nacked", async () => {
    const { client, deleted } = makeClient();
    const adapter = createSqsAdapter({ queueUrl: "u", region: "r", _client: client });
    const [job] = await adapter.pull({});
    if (!job) throw new Error("expected job");
    await adapter.nack(job.id, "permanent");
    expect(deleted).toEqual([{ QueueUrl: "u", ReceiptHandle: "rh-1" }]);
    const stats = await adapter.stats();
    expect(stats.nacked).toBe(1);
    expect(stats.deadLetter).toBe(1);
  });

  test("nack without a known receipt throws (line 97)", async () => {
    const { client } = makeClient();
    const adapter = createSqsAdapter({ queueUrl: "u", region: "r", _client: client });
    await expect(adapter.nack("never-pulled", "transient")).rejects.toThrow(
      /sqs nack: receipt for never-pulled not found/,
    );
  });

  test("extendVisibility pushes the lease forward (lines 114-122)", async () => {
    const { client, visibilityChanges } = makeClient();
    const adapter = createSqsAdapter({ queueUrl: "u", region: "r", _client: client });
    const [job] = await adapter.pull({});
    if (!job) throw new Error("expected job");
    // 4500ms → ceil to 5 seconds.
    await adapter.extendVisibility(job.id, 4_500);
    expect(visibilityChanges).toEqual([{ ReceiptHandle: "rh-1", VisibilityTimeout: 5 }]);
  });

  test("extendVisibility without a known receipt throws (lines 116-117)", async () => {
    const { client } = makeClient();
    const adapter = createSqsAdapter({ queueUrl: "u", region: "r", _client: client });
    await expect(adapter.extendVisibility("ghost", 1_000)).rejects.toThrow(
      /sqs extendVisibility: receipt for ghost not found/,
    );
  });

  test("ack without a known receipt throws (line 90)", async () => {
    const { client } = makeClient();
    const adapter = createSqsAdapter({ queueUrl: "u", region: "r", _client: client });
    await expect(adapter.ack("ghost")).rejects.toThrow(/sqs ack: receipt for ghost not found/);
  });

  test("stats reports inFlight from the receipt map", async () => {
    const { client } = makeClient({
      receiveMessage: async () => ({
        Messages: [
          { MessageId: "a", ReceiptHandle: "rh-a", Body: "{}" },
          { MessageId: "b", ReceiptHandle: "rh-b", Body: "{}" },
        ],
      }),
    });
    const adapter = createSqsAdapter({ queueUrl: "u", region: "r", _client: client });
    await adapter.pull({});
    const stats = await adapter.stats();
    expect(stats).toEqual({ pending: 0, inFlight: 2, acked: 0, nacked: 0, deadLetter: 0 });
  });
});

describe("redis-streams adapter — full lifecycle coverage", () => {
  function makeClient(overrides: Partial<RedisClientLike> = {}): {
    client: RedisClientLike;
    acks: Array<{ streamKey: string; group: string; ids: string[] }>;
    adds: Array<{ streamKey: string; id: string; fields: string[] }>;
  } {
    const acks: Array<{ streamKey: string; group: string; ids: string[] }> = [];
    const adds: Array<{ streamKey: string; id: string; fields: string[] }> = [];
    const client: RedisClientLike = {
      xreadgroup: async () => null,
      xack: async (streamKey, group, ...ids) => {
        acks.push({ streamKey, group, ids });
        return ids.length;
      },
      xadd: async (streamKey, id, ...fields) => {
        adds.push({ streamKey, id, fields });
        return "1-0";
      },
      ...overrides,
    };
    return { client, acks, adds };
  }

  test("pull falls back to raw payload when not JSON (line 72)", async () => {
    const { client } = makeClient({
      xreadgroup: async () => [
        { stream: "s", messages: [{ id: "1-0", fields: { payload: "<<raw>>" } }] },
      ],
    });
    const adapter = createRedisStreamsAdapter({
      streamKey: "s",
      consumerGroup: "g",
      consumerName: "c",
      _client: client,
    });
    const jobs = await adapter.pull({ maxJobs: 1 });
    expect(jobs.length).toBe(1);
    expect(jobs[0]?.input).toBe("<<raw>>");
    expect(jobs[0]?.attempt).toBe(1);
  });

  test("pull defaults missing payload field to {} and maps multiple streams (lines 84-85)", async () => {
    const { client } = makeClient({
      xreadgroup: async () => [
        { stream: "s1", messages: [{ id: "1-0", fields: {} }] },
        { stream: "s2", messages: [{ id: "2-0", fields: { payload: '{"x":1}' } }] },
      ],
    });
    const adapter = createRedisStreamsAdapter({
      streamKey: "s",
      consumerGroup: "g",
      consumerName: "c",
      _client: client,
    });
    const jobs = await adapter.pull({});
    expect(jobs.map((j) => j.id)).toEqual(["1-0", "2-0"]);
    expect(jobs[0]?.input).toEqual({});
    expect(jobs[1]?.input).toEqual({ x: 1 });
  });

  test("ack issues XACK and bumps acked (lines 86-88)", async () => {
    const { client, acks } = makeClient();
    const adapter = createRedisStreamsAdapter({
      streamKey: "s",
      consumerGroup: "g",
      consumerName: "c",
      _client: client,
    });
    await adapter.ack("1-0");
    expect(acks).toEqual([{ streamKey: "s", group: "g", ids: ["1-0"] }]);
    const stats = await adapter.stats();
    expect(stats.acked).toBe(1);
  });

  test("nack(transient) re-publishes to the stream tail then XACKs (lines 94-99)", async () => {
    const { client, acks, adds } = makeClient();
    const adapter = createRedisStreamsAdapter({
      streamKey: "s",
      consumerGroup: "g",
      consumerName: "c",
      _client: client,
    });
    await adapter.nack("1-0", "transient");
    // Re-published to the main stream tail with a retry marker…
    expect(adds).toEqual([
      { streamKey: "s", id: "*", fields: ["payload", JSON.stringify({ retry: "1-0" })] },
    ]);
    // …and acked on the consumer group so the original is removed.
    expect(acks).toEqual([{ streamKey: "s", group: "g", ids: ["1-0"] }]);
    const stats = await adapter.stats();
    expect(stats.nacked).toBe(1);
    expect(stats.deadLetter).toBe(0);
  });

  test("nack(permanent) without a configured DLQ falls back to re-publish", async () => {
    // deadLetterStream undefined → the `else` (re-publish) branch runs even
    // though the reason is permanent.
    const { client, adds } = makeClient();
    const adapter = createRedisStreamsAdapter({
      streamKey: "s",
      consumerGroup: "g",
      consumerName: "c",
      _client: client,
    });
    await adapter.nack("9-9", "permanent");
    expect(adds).toEqual([
      { streamKey: "s", id: "*", fields: ["payload", JSON.stringify({ retry: "9-9" })] },
    ]);
    const stats = await adapter.stats();
    expect(stats.deadLetter).toBe(0);
    expect(stats.nacked).toBe(1);
  });

  test("nack(permanent) with DLQ writes to dead-letter, bumps counters (lines 91-93)", async () => {
    const { client, adds, acks } = makeClient();
    const adapter = createRedisStreamsAdapter({
      streamKey: "s",
      consumerGroup: "g",
      consumerName: "c",
      deadLetterStream: "dlq",
      _client: client,
    });
    await adapter.nack("7-7", "permanent");
    expect(adds).toEqual([
      { streamKey: "dlq", id: "*", fields: ["payload", JSON.stringify({ jobId: "7-7" })] },
    ]);
    expect(acks).toEqual([{ streamKey: "s", group: "g", ids: ["7-7"] }]);
    const stats = await adapter.stats();
    expect(stats.deadLetter).toBe(1);
    expect(stats.nacked).toBe(1);
  });

  test("extendVisibility is a no-op and resolves (lines 101-103)", async () => {
    const { client, acks, adds } = makeClient();
    const adapter = createRedisStreamsAdapter({
      streamKey: "s",
      consumerGroup: "g",
      consumerName: "c",
      _client: client,
    });
    await expect(adapter.extendVisibility("1-0", 60_000)).resolves.toBeUndefined();
    // Truly a no-op: no Redis calls were made.
    expect(acks).toEqual([]);
    expect(adds).toEqual([]);
  });

  test("missing consumerGroup throws (line 47-48)", () => {
    expect(() =>
      createRedisStreamsAdapter({
        streamKey: "s",
        consumerGroup: "",
        consumerName: "c",
        _client: {} as never,
      }),
    ).toThrow(QueueProtocolError);
  });

  test("stats returns local counters with pending/inFlight = 0 (lines 104-112)", async () => {
    const { client } = makeClient();
    const adapter = createRedisStreamsAdapter({
      streamKey: "s",
      consumerGroup: "g",
      consumerName: "c",
      _client: client,
    });
    await adapter.ack("a");
    await adapter.nack("b", "transient");
    expect(await adapter.stats()).toEqual({
      pending: 0,
      inFlight: 0,
      acked: 1,
      nacked: 1,
      deadLetter: 0,
    });
  });
});

describe("postgres adapter — full lifecycle coverage", () => {
  /** A query stub that records SQL text + params and returns canned rows. */
  function makeClient(
    handler: (text: string, params?: unknown[]) => { rows: unknown[] } = () => ({ rows: [] }),
  ): { client: PostgresClientLike; calls: Array<{ text: string; params?: unknown[] }> } {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const client: PostgresClientLike = {
      query: async (text, params) => {
        calls.push({ text, params });
        return handler(text, params) as { rows: never[] };
      },
    };
    return { client, calls };
  }

  test("pull falls back to raw payload when not JSON (line 72)", async () => {
    const { client } = makeClient(() => ({
      rows: [
        {
          id: "j-raw",
          payload: "definitely-not-json",
          enqueued_at: new Date(0).toISOString(),
          visibility_expires_at: new Date(60_000).toISOString(),
          attempt: 2,
        },
      ],
    }));
    const adapter = createPostgresAdapter({ tableName: "jobs", _client: client });
    const jobs = await adapter.pull({ maxJobs: 1, visibilityTimeoutMs: 5_000 });
    expect(jobs.length).toBe(1);
    expect(jobs[0]?.input).toBe("definitely-not-json");
    expect(jobs[0]?.attempt).toBe(2);
    // Timestamps are converted to epoch millis.
    expect(jobs[0]?.enqueuedAt).toBe(0);
    expect(jobs[0]?.visibilityExpiresAt).toBe(60_000);
  });

  test("pull computes visibility seconds from ms (ceil) into the SQL", async () => {
    const { client, calls } = makeClient(() => ({ rows: [] }));
    const adapter = createPostgresAdapter({ tableName: "jobs", _client: client });
    await adapter.pull({ visibilityTimeoutMs: 1_500 }); // ceil(1500/1000) = 2
    expect(calls[0]?.text).toContain("INTERVAL '2 seconds'");
    expect(calls[0]?.params).toEqual([10]); // default maxJobs
  });

  test("nack(transient) UPDATEs visibility to NOW and bumps nacked (lines 101-107)", async () => {
    const { client, calls } = makeClient();
    const adapter = createPostgresAdapter({ tableName: "jobs", _client: client });
    await adapter.nack("j1", "transient");
    expect(calls.length).toBe(1);
    expect(calls[0]?.text).toContain("SET visibility_expires_at = NOW() WHERE id = $1");
    expect(calls[0]?.params).toEqual(["j1"]);
    expect((await adapter.stats()).nacked).toBe(1);
  });

  test("nack(permanent) without a DLQ table takes the transient UPDATE branch", async () => {
    // deadLetterTable undefined → the `if (reason === "permanent" && dlqTable)`
    // guard is false, so it UPDATEs (re-enqueues) instead of dead-lettering.
    const { client, calls } = makeClient();
    const adapter = createPostgresAdapter({ tableName: "jobs", _client: client });
    await adapter.nack("j1", "permanent");
    expect(calls[0]?.text).toContain("SET visibility_expires_at = NOW()");
    expect((await adapter.stats()).deadLetter).toBe(0);
  });

  test("nack(permanent) with a DLQ table INSERTs then DELETEs (lines 94-100)", async () => {
    const { client, calls } = makeClient();
    const adapter = createPostgresAdapter({
      tableName: "jobs",
      deadLetterTable: "dead_letter_jobs",
      _client: client,
    });
    await adapter.nack("j1", "permanent");
    expect(calls[0]?.text).toContain("INSERT INTO dead_letter_jobs");
    expect(calls[1]?.text).toContain("DELETE FROM jobs WHERE id = $1");
    const stats = await adapter.stats();
    expect(stats.deadLetter).toBe(1);
    expect(stats.nacked).toBe(1);
  });

  test("nack(permanent) rejects an injection-y deadLetterTable (line 92)", async () => {
    const { client } = makeClient();
    const adapter = createPostgresAdapter({
      tableName: "jobs",
      deadLetterTable: "dlq; DROP TABLE users;",
      _client: client,
    });
    await expect(adapter.nack("j1", "permanent")).rejects.toThrow(
      /invalid deadLetterTable "dlq; DROP TABLE users;"/,
    );
  });

  test("ack DELETEs the row and bumps acked", async () => {
    const { client, calls } = makeClient();
    const adapter = createPostgresAdapter({ tableName: "jobs", _client: client });
    await adapter.ack("j1");
    expect(calls[0]?.text).toContain("DELETE FROM jobs WHERE id = $1");
    expect(calls[0]?.params).toEqual(["j1"]);
    expect((await adapter.stats()).acked).toBe(1);
  });

  test("extendVisibility UPDATEs with ceil(ms/1000) seconds (lines 109-115)", async () => {
    const { client, calls } = makeClient();
    const adapter = createPostgresAdapter({ tableName: "jobs", _client: client });
    await adapter.extendVisibility("j1", 2_001); // ceil → 3
    expect(calls[0]?.text).toContain("INTERVAL '3 seconds'");
    expect(calls[0]?.text).toContain("WHERE id = $1");
    expect(calls[0]?.params).toEqual(["j1"]);
  });

  test("stats parses pending + inFlight counts from COUNT(*) queries (lines 116-134)", async () => {
    const { client, calls } = makeClient((text) => {
      if (text.includes("<= NOW()")) return { rows: [{ count: "4" }] };
      if (text.includes("> NOW()")) return { rows: [{ count: "2" }] };
      return { rows: [] };
    });
    const adapter = createPostgresAdapter({ tableName: "jobs", _client: client });
    // Drive the terminal counters too.
    await adapter.ack("a");
    await adapter.nack("b", "transient");
    const stats = await adapter.stats();
    expect(stats).toEqual({ pending: 4, inFlight: 2, acked: 1, nacked: 1, deadLetter: 0 });
    // Two COUNT queries were issued (plus ack DELETE + nack UPDATE before).
    const countQueries = calls.filter((c) => c.text.includes("COUNT(*)"));
    expect(countQueries.length).toBe(2);
  });

  test("stats defaults to 0 when COUNT returns no rows (?? '0' fallback)", async () => {
    const { client } = makeClient(() => ({ rows: [] }));
    const adapter = createPostgresAdapter({ tableName: "jobs", _client: client });
    expect(await adapter.stats()).toEqual({
      pending: 0,
      inFlight: 0,
      acked: 0,
      nacked: 0,
      deadLetter: 0,
    });
  });

  test("missing tableName throws (line 37)", () => {
    expect(() => createPostgresAdapter({ tableName: "", _client: {} as never })).toThrow(
      /requires tableName/,
    );
  });
});
