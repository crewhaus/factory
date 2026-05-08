/**
 * Section 30 — contract tests for the new queue adapters.
 *
 * Each adapter is wired to a stub client that mimics the SDK shape.
 * The contract corpus exercises the same lifecycle the in-memory
 * adapter passes: pull → ack ; pull → nack(transient) → re-pull ;
 * pull → nack(permanent) → dead-letter.
 */
import { describe, expect, test } from "bun:test";
import { QueueProtocolError } from "../index";
import { type PostgresClientLike, createPostgresAdapter } from "./postgres";
import { type RedisClientLike, createRedisStreamsAdapter } from "./redis-streams";
import { type SqsClientLike, createSqsAdapter } from "./sqs";

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
