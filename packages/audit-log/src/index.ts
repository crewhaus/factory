/**
 * Catalog R17 `audit-log` — per-tenant hash-chained append-only JSONL.
 *
 * Daily file rotation: `<auditRoot>/<YYYY-MM-DD>.jsonl`. Every line is
 * a self-describing record with a SHA-256 hash that includes the
 * previous line's hash, forming a tamper-evident chain:
 *
 *   {
 *     ts: <ms epoch>, version: 1, kind: "policy_decision" | …,
 *     payload: <opaque JSON>,
 *     prevHash: <hex of prior line, or "GENESIS">,
 *     hash: <SHA-256(prevHash || JSON.stringify({ts,version,kind,payload}))>
 *   }
 *
 * `verify(rootDir)` walks the chain and reports the first broken link
 * (line number + reason). The chain is per-day; the previous day's
 * tail seeds the next day's `prevHash` via a one-line index file.
 *
 * Files are created with mode 0o600 (owner-only) so the audit trail
 * cannot be read by other users on the host. Append uses
 * `appendFileSync` which is atomic per line on POSIX when the line
 * fits in `PIPE_BUF`, mirroring `event-log`'s contract.
 *
 * Layer R17. Pairs with `tenancy` (R17) and `gateway-server` (R16).
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { CrewhausError, RuntimeError } from "@crewhaus/errors";

export const GENESIS_HASH = "GENESIS";

export type AuditKind =
  | "policy_decision"
  | "model_call"
  | "tool_classification"
  | "gateway_request"
  | "session_fork"
  | "tenancy_context"
  // Section 27 — secrets-manager rotation + access events
  | "secrets_rotation"
  | "secrets_access"
  // Section 28 — deployment-controller actions
  | "deployment_action"
  // Pillar 3 sink-side fabric — egress-classifier emits one event per
  // external-tool invocation. Payload shape (informally; opaque JSON):
  //   { sinkId, sinkScope, verdict, originsFound, matchCount, originStack }
  // The raw outbound payload is NEVER stored verbatim — only the lineage
  // summary. The egress-classifier's `summarizeEgress(result)` produces
  // the human-readable form that lands in the `payload_summary` field.
  | "egress_decision"
  // Pillar 3 intent gate — permission-engine emits one event per
  // justification-evaluated tool call. Payload shape (opaque JSON):
  //   { toolName, justification, verdict: "allow"|"deny", reason, judgeModel }
  // Stored verbatim because the justification IS the audit artifact;
  // redacting it would defeat the purpose.
  | "permission_justification_evaluated";

export type AuditRecord = {
  readonly ts: number;
  readonly version: 1;
  readonly kind: AuditKind;
  readonly payload: unknown;
  readonly prevHash: string;
  readonly hash: string;
};

export type AppendInput = Pick<AuditRecord, "kind" | "payload">;

export class AuditLogError extends CrewhausError {
  override readonly name = "AuditLogError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type OpenAuditLogOptions = {
  readonly rootDir: string;
  readonly now?: () => number;
  readonly day?: () => string;
};

export interface AuditLog {
  append(input: AppendInput): Promise<AuditRecord>;
  read(opts?: { readonly day?: string }): AsyncIterable<AuditRecord>;
}

function hashBody(
  body: { ts: number; version: 1; kind: AuditKind; payload: unknown },
  prevHash: string,
): string {
  return createHash("sha256")
    .update(prevHash)
    .update("|")
    .update(JSON.stringify(body))
    .digest("hex");
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function indexPath(rootDir: string): string {
  return join(rootDir, "_chain-tail.json");
}

type ChainTail = { readonly day: string; readonly hash: string };

function readChainTail(rootDir: string): ChainTail | undefined {
  const p = indexPath(rootDir);
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, "utf8")) as ChainTail;
}

function writeChainTail(rootDir: string, day: string, hash: string): void {
  const p = indexPath(rootDir);
  writeFileSync(p, JSON.stringify({ day, hash }), { mode: 0o600 });
}

export async function openAuditLog(opts: OpenAuditLogOptions): Promise<AuditLog> {
  if (typeof opts.rootDir !== "string" || opts.rootDir === "") {
    throw new AuditLogError("rootDir is required");
  }
  mkdirSync(opts.rootDir, { recursive: true, mode: 0o700 });
  const now = opts.now ?? ((): number => Date.now());
  const day = opts.day ?? todayStr;

  return {
    async append(input: AppendInput): Promise<AuditRecord> {
      const tail = readChainTail(opts.rootDir);
      const prevHash = tail?.hash ?? GENESIS_HASH;
      const body = { ts: now(), version: 1 as const, kind: input.kind, payload: input.payload };
      const hash = hashBody(body, prevHash);
      const record: AuditRecord = { ...body, prevHash, hash };
      const file = join(opts.rootDir, `${day()}.jsonl`);
      appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      writeChainTail(opts.rootDir, day(), hash);
      return record;
    },
    read(readOpts: { day?: string } = {}): AsyncIterable<AuditRecord> {
      return readDay(opts.rootDir, readOpts.day ?? day());
    },
  };
}

async function* readDay(rootDir: string, day: string): AsyncIterable<AuditRecord> {
  const file = join(rootDir, `${day}.jsonl`);
  if (!existsSync(file)) return;
  const stream = createReadStream(file, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  let lineNumber = 0;
  try {
    for await (const raw of rl) {
      lineNumber += 1;
      if (raw === "") continue;
      let parsed: AuditRecord;
      try {
        parsed = JSON.parse(raw) as AuditRecord;
      } catch (err) {
        throw new RuntimeError(`audit-log: malformed JSON on line ${lineNumber} of ${file}`, err);
      }
      yield parsed;
    }
  } finally {
    rl.close();
    stream.close();
  }
}

export type VerifyResult =
  | { readonly ok: true; readonly recordsChecked: number }
  | {
      readonly ok: false;
      readonly recordsChecked: number;
      readonly file: string;
      readonly line: number;
      readonly reason: string;
    };

/**
 * Walk every `<rootDir>/*.jsonl` chain, verifying each record's
 * `hash` against `SHA-256(prevHash || canonical-body)` and that
 * `prevHash` matches the previous record's `hash`. Returns the first
 * broken link (file + line number + reason) or `{ ok: true }` if the
 * full chain is intact.
 */
export async function verify(rootDir: string): Promise<VerifyResult> {
  if (!existsSync(rootDir)) return { ok: true, recordsChecked: 0 };
  const files = readdirSync(rootDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  let prevHash = GENESIS_HASH;
  let recordsChecked = 0;
  for (const f of files) {
    const file = join(rootDir, f);
    const stream = createReadStream(file, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    let lineNumber = 0;
    try {
      for await (const raw of rl) {
        lineNumber += 1;
        if (raw === "") continue;
        let r: AuditRecord;
        try {
          r = JSON.parse(raw) as AuditRecord;
        } catch (err) {
          stream.close();
          rl.close();
          return {
            ok: false,
            recordsChecked,
            file,
            line: lineNumber,
            reason: `malformed JSON: ${(err as Error).message}`,
          };
        }
        if (r.prevHash !== prevHash) {
          stream.close();
          rl.close();
          return {
            ok: false,
            recordsChecked,
            file,
            line: lineNumber,
            reason: `prevHash mismatch — expected "${prevHash}", got "${r.prevHash}"`,
          };
        }
        const body = { ts: r.ts, version: r.version, kind: r.kind, payload: r.payload };
        const expected = hashBody(body, r.prevHash);
        if (r.hash !== expected) {
          stream.close();
          rl.close();
          return {
            ok: false,
            recordsChecked,
            file,
            line: lineNumber,
            reason: `hash mismatch — expected "${expected}", got "${r.hash}"`,
          };
        }
        prevHash = r.hash;
        recordsChecked += 1;
      }
    } finally {
      rl.close();
      stream.close();
    }
  }
  return { ok: true, recordsChecked };
}
