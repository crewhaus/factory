/**
 * The proof ladder's machine check (design §2.4): `proven` is earned by
 * citing `toolUseId`s that RESOLVE against the append-only session event
 * logs — the substrate runtime-core already writes verbatim (`tool_use` with
 * full input, `tool_result` with full output + `isError`). Narration can
 * never produce a ✓.
 *
 * Resolution walks the cited session's JSONL and, when the id is not found
 * there, descends into child sessions via the `sub_agent_start` bracket
 * events (whose payloads record `childSessionId`) — so a researcher
 * sub-agent's tool calls are valid proof for the parent's plan.
 *
 * Proof-evidence lifetime (§2.4, judge-mandated): session JSONLs are
 * TTL-evicted, which would silently degrade every `proven` to unverifiable.
 * Verification therefore returns a FROZEN excerpt — `{toolName, inputHash,
 * resultDigest}` — that the store writes into the citing plan/goal record,
 * and the store additionally pins the cited session in
 * `.crewhaus/retention.json` (see `appendRetentionPins`).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import { openEventLog } from "@crewhaus/event-log";

export const DEFAULT_SESSION_ROOT_DIR = ".crewhaus/sessions";
const SESSION_ID_REGEX = /^sess_[0-9a-f]{16}$/;
/** How deep the sub-agent bracket walk descends before giving up. */
const DEFAULT_MAX_DEPTH = 8;
/** Frozen `resultDigest` excerpt length (chars). */
const RESULT_DIGEST_MAX_CHARS = 240;

export type EvidenceRef = {
  readonly toolUseId: string;
  /** The session whose log carries the id. Optional when a default session
   *  is supplied at verification time. */
  readonly sessionId?: string;
};

export type EvidenceVerdict = "verified" | "missing" | "error_result";

/** The proof excerpt frozen into the citing plan/goal record so evidence
 *  outlives the transcript's TTL (design §2.4). */
export type FrozenProof = {
  readonly toolUseId: string;
  /** The session (parent or child) whose log resolved the id. */
  readonly sessionId: string;
  readonly toolName: string;
  /** `sha256:<hex>` over the verbatim `tool_use` input JSON. */
  readonly inputHash: string;
  /** Whitespace-collapsed excerpt (≤240 chars) of the `tool_result` text —
   *  human-checkable even after the raw transcript is evicted. */
  readonly resultDigest: string;
  readonly verifiedAt: string;
};

export type EvidenceResolution = {
  readonly ref: EvidenceRef;
  readonly verdict: EvidenceVerdict;
  /** Present iff `verdict === "verified"`. */
  readonly proof?: FrozenProof;
  /** Human-readable detail for rejected refs. */
  readonly detail?: string;
};

/** Thrown by `verifyEvidence` on the first non-verified ref. Carries the
 *  failing ref + verdict so callers (tool-plan) can emit an `action_proof`
 *  event for the rejected attempt. */
export class EvidenceError extends CrewhausError {
  override readonly name = "EvidenceError";
  readonly toolUseId: string;
  readonly verdict: EvidenceVerdict;
  constructor(message: string, toolUseId: string, verdict: EvidenceVerdict) {
    super("runtime", message);
    this.toolUseId = toolUseId;
    this.verdict = verdict;
  }
}

export type VerifyEvidenceOptions = {
  /** Where session `.jsonl` logs live. Default `.crewhaus/sessions`. */
  readonly sessionRootDir?: string;
  /** Session assumed for refs that omit `sessionId`. */
  readonly defaultSessionId?: string;
  /** Bracket-walk depth cap. Default 8. */
  readonly maxDepth?: number;
  readonly now?: () => Date;
};

function collapse(text: string, maxChars: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > maxChars ? `${t.slice(0, maxChars - 1).trimEnd()}…` : t;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
  }
  return "";
}

type SessionScan = {
  readonly toolUse?: { readonly name: string; readonly input: unknown };
  readonly toolResult?: { readonly content: unknown; readonly isError: boolean };
  readonly childSessionIds: readonly string[];
};

async function scanSession(
  sessionId: string,
  toolUseId: string,
  sessionRootDir: string,
): Promise<SessionScan> {
  const log = await openEventLog(sessionId, { rootDir: sessionRootDir });
  let toolUse: SessionScan["toolUse"];
  let toolResult: SessionScan["toolResult"];
  const childSessionIds: string[] = [];
  for await (const ev of log.read()) {
    if (ev.kind === "tool_use") {
      const p = ev.payload as { id?: unknown; name?: unknown; input?: unknown };
      if (p.id === toolUseId) {
        toolUse = { name: typeof p.name === "string" ? p.name : "unknown", input: p.input };
      }
    } else if (ev.kind === "tool_result") {
      const p = ev.payload as { toolUseId?: unknown; content?: unknown; isError?: unknown };
      if (p.toolUseId === toolUseId) {
        toolResult = { content: p.content, isError: p.isError === true };
      }
    } else if (ev.kind === "sub_agent_start") {
      const p = ev.payload as { childSessionId?: unknown };
      if (typeof p.childSessionId === "string" && SESSION_ID_REGEX.test(p.childSessionId)) {
        childSessionIds.push(p.childSessionId);
      }
    }
  }
  await log.close();
  return {
    ...(toolUse !== undefined ? { toolUse } : {}),
    ...(toolResult !== undefined ? { toolResult } : {}),
    childSessionIds,
  };
}

/**
 * Resolve each ref against the session logs WITHOUT throwing — one verdict
 * per ref, in input order. `verifyEvidence` is the throwing wrapper the
 * `proven` transition uses; this form exists so callers can audit rejected
 * attempts (`action_proof` events with `verdict: "missing"`).
 */
export async function resolveEvidence(
  refs: readonly EvidenceRef[],
  opts: VerifyEvidenceOptions = {},
): Promise<readonly EvidenceResolution[]> {
  const sessionRootDir = opts.sessionRootDir ?? DEFAULT_SESSION_ROOT_DIR;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const now = opts.now ?? (() => new Date());
  const resolutions: EvidenceResolution[] = [];

  for (const ref of refs) {
    const rootSession = ref.sessionId ?? opts.defaultSessionId;
    if (rootSession === undefined) {
      resolutions.push({
        ref,
        verdict: "missing",
        detail: `no verified evidence for ${ref.toolUseId}: no sessionId to resolve it against — cite {toolUseId, sessionId} explicitly.`,
      });
      continue;
    }
    if (!SESSION_ID_REGEX.test(rootSession)) {
      resolutions.push({
        ref,
        verdict: "missing",
        detail: `no verified evidence for ${ref.toolUseId}: "${rootSession}" is not a valid sessionId (expected sess_<16 hex>).`,
      });
      continue;
    }

    // Breadth-first over the session and its sub-agent children.
    const queue: Array<{ sessionId: string; depth: number }> = [
      { sessionId: rootSession, depth: 0 },
    ];
    const visited = new Set<string>();
    let resolution: EvidenceResolution | undefined;
    while (queue.length > 0 && resolution === undefined) {
      const item = queue.shift() as { sessionId: string; depth: number };
      if (visited.has(item.sessionId)) continue;
      visited.add(item.sessionId);
      const scan = await scanSession(item.sessionId, ref.toolUseId, sessionRootDir);
      if (scan.toolUse !== undefined && scan.toolResult !== undefined) {
        if (scan.toolResult.isError) {
          resolution = {
            ref,
            verdict: "error_result",
            detail: `evidence ${ref.toolUseId} resolved in ${item.sessionId} but its tool_result has isError: true — a failed call cannot prove a step. Rerun the action and cite the successful toolUseId.`,
          };
        } else {
          const inputJson = JSON.stringify(scan.toolUse.input);
          resolution = {
            ref,
            verdict: "verified",
            proof: {
              toolUseId: ref.toolUseId,
              sessionId: item.sessionId,
              toolName: scan.toolUse.name,
              inputHash: `sha256:${createHash("sha256")
                .update(inputJson ?? "null")
                .digest("hex")}`,
              resultDigest: collapse(resultText(scan.toolResult.content), RESULT_DIGEST_MAX_CHARS),
              verifiedAt: now().toISOString(),
            },
          };
        }
      } else if (item.depth < maxDepth) {
        for (const child of scan.childSessionIds) {
          queue.push({ sessionId: child, depth: item.depth + 1 });
        }
      }
    }

    resolutions.push(
      resolution ?? {
        ref,
        verdict: "missing",
        detail: `no verified evidence for ${ref.toolUseId}: run the action first, then complete the step with its toolUseId.`,
      },
    );
  }
  return resolutions;
}

/**
 * The `proven` gate: resolve every ref and throw an instructive
 * `EvidenceError` on the first one that is missing or errored. Returns the
 * frozen proofs (one per ref) on success.
 */
export async function verifyEvidence(
  refs: readonly EvidenceRef[],
  opts: VerifyEvidenceOptions = {},
): Promise<readonly FrozenProof[]> {
  if (refs.length === 0) {
    throw new EvidenceError(
      "no verified evidence: cite at least one {toolUseId} — run the action first, then complete the step with its toolUseId.",
      "",
      "missing",
    );
  }
  const resolutions = await resolveEvidence(refs, opts);
  const proofs: FrozenProof[] = [];
  for (const r of resolutions) {
    if (r.verdict !== "verified" || r.proof === undefined) {
      throw new EvidenceError(
        r.detail ??
          `no verified evidence for ${r.ref.toolUseId}: run the action first, then complete the step with its toolUseId.`,
        r.ref.toolUseId,
        r.verdict,
      );
    }
    proofs.push(r.proof);
  }
  return proofs;
}

/**
 * Proof lifetime, mechanism (a): pin the cited sessions in
 * `.crewhaus/retention.json` (the `pins` contract session-store's TTL
 * eviction and `crewhaus retention` both honor) so a transcript cited by a
 * live `proven` record is never TTL-evicted out from under it. Read-modify-
 * write preserves every other key in the file verbatim; the write is
 * tmp+rename atomic. Absent file → created with `{version: 1, pins: […]}`.
 */
export async function appendRetentionPins(
  sessionIds: readonly string[],
  retentionPath: string,
): Promise<{ readonly added: readonly string[] }> {
  const valid = [...new Set(sessionIds.filter((id) => SESSION_ID_REGEX.test(id)))];
  if (valid.length === 0) return { added: [] };

  let config: Record<string, unknown> = { version: 1 };
  if (existsSync(retentionPath)) {
    let raw: string;
    try {
      raw = await readFile(retentionPath, "utf8");
    } catch (err) {
      throw new CrewhausError("config", `continuity-store: cannot read ${retentionPath}`, err);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new CrewhausError(
        "config",
        `continuity-store: ${retentionPath} is malformed JSON — fix it before pinning proof sessions (a half-understood retention policy must not be rewritten).`,
        err,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new CrewhausError(
        "config",
        `continuity-store: ${retentionPath} must be a JSON object — fix it before pinning proof sessions.`,
      );
    }
    config = parsed as Record<string, unknown>;
  }

  const existing = Array.isArray(config["pins"])
    ? (config["pins"] as unknown[]).filter((p): p is string => typeof p === "string")
    : [];
  const added = valid.filter((id) => !existing.includes(id));
  if (added.length === 0) return { added: [] };

  config["pins"] = [...existing, ...added];
  await mkdir(dirname(retentionPath), { recursive: true });
  const tmpPath = `${retentionPath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(tmpPath, retentionPath);
  return { added };
}
