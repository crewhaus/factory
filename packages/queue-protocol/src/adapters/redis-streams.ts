/**
 * Section 30 — Redis Streams adapter for `@crewhaus/queue-protocol`.
 *
 * Maps to Redis Streams + consumer groups:
 *   pull → XREADGROUP
 *   ack → XACK
 *   nack(transient) → XADD back to the stream tail
 *   nack(permanent) → XADD to the dead-letter stream + XACK on main
 *   extendVisibility → no-op (Redis Streams uses pending-list min-idle-time
 *                     instead of per-message visibility timeouts; consumers
 *                     refresh by re-reading from the pending list)
 *
 * v0 throws when `ioredis` is not installed; the contract is correct +
 * tested with stub clients.
 */
import type { Job, JobId, NackReason, PullOptions, QueueAdapter } from "../index";
import { QueueProtocolError } from "../index";

export type RedisStreamsAdapterOptions = {
  readonly streamKey: string;
  readonly consumerGroup: string;
  readonly consumerName: string;
  readonly deadLetterStream?: string;
  readonly _client?: RedisClientLike;
};

export type RedisClientLike = {
  xreadgroup(
    group: string,
    consumer: string,
    count: number,
    blockMs: number,
    streamKey: string,
    id: string,
  ): Promise<Array<{
    stream: string;
    messages: Array<{ id: string; fields: Record<string, string> }>;
  }> | null>;
  xack(streamKey: string, group: string, ...ids: string[]): Promise<number>;
  xadd(streamKey: string, id: string, ...fields: string[]): Promise<string>;
};

export function createRedisStreamsAdapter<TInput = unknown>(
  opts: RedisStreamsAdapterOptions,
): QueueAdapter<TInput> {
  if (!opts.streamKey) throw new QueueProtocolError("redis-streams adapter requires streamKey");
  if (!opts.consumerGroup)
    throw new QueueProtocolError("redis-streams adapter requires consumerGroup");
  const client = opts._client ?? requireClient();
  let acked = 0;
  let nacked = 0;
  let deadLetter = 0;
  return {
    kind: "redis-streams",
    async pull(pullOpts: PullOptions): Promise<ReadonlyArray<Job<TInput>>> {
      const res = await client.xreadgroup(
        opts.consumerGroup,
        opts.consumerName,
        pullOpts.maxBatch,
        // PullOptions carries no long-poll knob; read non-blocking and let the
        // consumer drive polling cadence.
        0,
        opts.streamKey,
        ">",
      );
      if (!res) return [];
      const out: Job<TInput>[] = [];
      const now = Date.now();
      for (const stream of res) {
        for (const m of stream.messages) {
          let parsed: TInput;
          try {
            parsed = JSON.parse(m.fields["payload"] ?? "{}") as TInput;
          } catch {
            parsed = m.fields["payload"] as unknown as TInput;
          }
          out.push({
            id: m.id,
            input: parsed,
            enqueuedAt: new Date(now).toISOString(),
            visibilityExpiresAt: new Date(now + pullOpts.visibilityTimeoutMs).toISOString(),
            attempt: 1,
          });
        }
      }
      return out;
    },
    async ack(jobId: JobId): Promise<void> {
      await client.xack(opts.streamKey, opts.consumerGroup, jobId);
      acked++;
    },
    async nack(jobId: JobId, reason: NackReason): Promise<void> {
      if (reason === "permanent" && opts.deadLetterStream) {
        await client.xadd(opts.deadLetterStream, "*", "payload", JSON.stringify({ jobId }));
        deadLetter++;
      } else {
        // Re-publish to the tail; the consumer-group will redeliver.
        await client.xadd(opts.streamKey, "*", "payload", JSON.stringify({ retry: jobId }));
      }
      await client.xack(opts.streamKey, opts.consumerGroup, jobId);
      nacked++;
    },
    async extendVisibility(_jobId: JobId, _additionalMs: number): Promise<void> {
      // Redis Streams uses min-idle-time; nothing to do here.
    },
    async stats(): Promise<{
      pending: number;
      inFlight: number;
      acked: number;
      nacked: number;
      deadLetter: number;
    }> {
      return { pending: 0, inFlight: 0, acked, nacked, deadLetter };
    },
  };
}

function requireClient(): RedisClientLike {
  throw new QueueProtocolError(
    "redis-streams adapter requires `ioredis` to be installed and a Redis URL configured. Pass an explicit `_client` to use a stub.",
  );
}
