/**
 * Section 30 — Postgres adapter for `@crewhaus/queue-protocol`. Uses
 * advisory locks + a job table for visibility timeouts:
 *   pull → SELECT … FOR UPDATE SKIP LOCKED
 *   ack → DELETE FROM jobs WHERE id = $1
 *   nack(transient) → UPDATE jobs SET visibility_expires_at = NOW()
 *   nack(permanent) → INSERT INTO dead_letter_jobs + DELETE
 *   extendVisibility → UPDATE jobs SET visibility_expires_at = NOW() + ...
 *
 * v0 throws when `pg` isn't installed; the contract holds with a stub
 * client.
 */
import type { Job, JobId, NackReason, PullOptions, QueueAdapter } from "../index";
import { QueueProtocolError } from "../index";

export type PostgresAdapterOptions = {
  readonly tableName: string;
  readonly deadLetterTable?: string;
  readonly _client?: PostgresClientLike;
};

export type PostgresClientLike = {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

type JobRow = {
  id: string;
  payload: string;
  enqueued_at: string;
  visibility_expires_at: string;
  attempt: number;
};

export function createPostgresAdapter<TInput = unknown>(
  opts: PostgresAdapterOptions,
): QueueAdapter<TInput> {
  if (!opts.tableName) throw new QueueProtocolError("postgres adapter requires tableName");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.tableName)) {
    throw new QueueProtocolError(`postgres adapter: invalid tableName "${opts.tableName}"`);
  }
  const client = opts._client ?? requireClient();
  let acked = 0;
  let nacked = 0;
  let deadLetter = 0;
  const dlqTable = opts.deadLetterTable;

  return {
    kind: "postgres",
    async pull(pullOpts: PullOptions): Promise<ReadonlyArray<Job<TInput>>> {
      const visibilitySec = Math.ceil((pullOpts.visibilityTimeoutMs ?? 60_000) / 1000);
      const result = await client.query<JobRow>(
        `WITH leased AS (
          SELECT id FROM ${opts.tableName}
          WHERE visibility_expires_at <= NOW()
          ORDER BY enqueued_at ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE ${opts.tableName} t
        SET visibility_expires_at = NOW() + INTERVAL '${visibilitySec} seconds',
            attempt = attempt + 1
        FROM leased
        WHERE t.id = leased.id
        RETURNING t.id, t.payload, t.enqueued_at, t.visibility_expires_at, t.attempt`,
        [pullOpts.maxBatch],
      );
      const out: Job<TInput>[] = [];
      for (const row of result.rows) {
        let parsed: TInput;
        try {
          parsed = JSON.parse(row.payload) as TInput;
        } catch {
          parsed = row.payload as unknown as TInput;
        }
        out.push({
          id: row.id,
          input: parsed,
          enqueuedAt: new Date(row.enqueued_at).toISOString(),
          visibilityExpiresAt: new Date(row.visibility_expires_at).toISOString(),
          attempt: row.attempt,
        });
      }
      return out;
    },
    async ack(jobId: JobId): Promise<void> {
      await client.query(`DELETE FROM ${opts.tableName} WHERE id = $1`, [jobId]);
      acked++;
    },
    async nack(jobId: JobId, reason: NackReason): Promise<void> {
      if (reason === "permanent" && dlqTable) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dlqTable)) {
          throw new QueueProtocolError(`postgres adapter: invalid deadLetterTable "${dlqTable}"`);
        }
        await client.query(
          `INSERT INTO ${dlqTable} (id, payload, enqueued_at)
           SELECT id, payload, enqueued_at FROM ${opts.tableName} WHERE id = $1`,
          [jobId],
        );
        await client.query(`DELETE FROM ${opts.tableName} WHERE id = $1`, [jobId]);
        deadLetter++;
      } else {
        await client.query(
          `UPDATE ${opts.tableName} SET visibility_expires_at = NOW() WHERE id = $1`,
          [jobId],
        );
      }
      nacked++;
    },
    async extendVisibility(jobId: JobId, additionalMs: number): Promise<void> {
      const sec = Math.ceil(additionalMs / 1000);
      await client.query(
        `UPDATE ${opts.tableName} SET visibility_expires_at = NOW() + INTERVAL '${sec} seconds' WHERE id = $1`,
        [jobId],
      );
    },
    async stats(): Promise<{
      pending: number;
      inFlight: number;
      acked: number;
      nacked: number;
      deadLetter: number;
    }> {
      const pendingRes = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ${opts.tableName} WHERE visibility_expires_at <= NOW()`,
      );
      const inFlightRes = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ${opts.tableName} WHERE visibility_expires_at > NOW()`,
      );
      return {
        pending: Number.parseInt(pendingRes.rows[0]?.count ?? "0", 10),
        inFlight: Number.parseInt(inFlightRes.rows[0]?.count ?? "0", 10),
        acked,
        nacked,
        deadLetter,
      };
    },
  };
}

function requireClient(): PostgresClientLike {
  throw new QueueProtocolError(
    "postgres adapter requires `pg` to be installed and DATABASE_URL configured. Pass an explicit `_client` to use a stub.",
  );
}
