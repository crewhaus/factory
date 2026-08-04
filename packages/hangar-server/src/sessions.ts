/**
 * TTL-safe session browsing — the non-eviction guarantee lives here.
 *
 * This module NEVER constructs a SessionStore and NEVER calls its `list()`
 * (whose TTL eviction unlinks expired transcripts as a side-effect). All
 * reads are raw directory scans plus capped, torn-tolerant JSONL parsing:
 * rendering a session browser must not delete a single byte, which the
 * regression tests assert file-by-file.
 *
 * Layout read (the session-store on-disk contract, consumed read-only):
 *   <sessionRoot>/sess_<16hex>.json    — live session metadata
 *   <sessionRoot>/sess_<16hex>.jsonl   — the durable event log (transcript)
 *   <parent>/sessions-index/sess_*.json — durable summaries that outlive the
 *     raw transcript's TTL; ids present ONLY here render `evicted: true`.
 *
 * The session root defaults to `<harness>/.crewhaus/sessions` and may be
 * relocated by `CREWHAUS_SESSION_DIR` in the harness's own `.env` (resolved
 * relative to the harness dir). An override that escapes the harness dir is
 * IGNORED — the manager only ever reads inside registered roots — and the
 * response says so instead of silently reading the default.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { maskCredentialTokens } from "@crewhaus/spec-patch";
import { MAX_RAW_LINES, SESSION_DIR_ENV, SESSION_ID_RE, SESSION_JSON_RE } from "./constants";
import { readHarnessEnvFiles } from "./env-file";
import { readJsonlCapped } from "./jsonl";
import { maskDeep } from "./mask";
import { resolveContained } from "./safety";

export type SessionRootInfo = {
  /** Absolute directory session files are read from. */
  readonly root: string;
  /** True when a `CREWHAUS_SESSION_DIR` override from the harness `.env`
   *  is in effect. */
  readonly overrideActive: boolean;
  /** True when an override was present but escaped the harness dir and was
   *  therefore ignored (the default root is used instead). */
  readonly overrideIgnored: boolean;
};

/** Resolve where a harness's sessions live, honoring the `.env` override
 *  when (and only when) it stays inside the harness dir. */
export function resolveSessionRoot(harnessDir: string): SessionRootInfo {
  const fallback = join(harnessDir, ".crewhaus", "sessions");
  const override = readHarnessEnvFiles(harnessDir).vars[SESSION_DIR_ENV];
  if (override === undefined || override.trim() === "") {
    return { root: fallback, overrideActive: false, overrideIgnored: false };
  }
  const resolved = resolveContained(harnessDir, override.trim());
  if (resolved === undefined) {
    return { root: fallback, overrideActive: false, overrideIgnored: true };
  }
  return { root: resolved, overrideActive: true, overrideIgnored: false };
}

export type SessionRow = {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly target: string;
  readonly updatedAt: string;
  readonly lastTurnIndex: number;
  readonly ageDays: number;
  readonly evicted: false;
};

export type EvictedSessionRow = {
  readonly id: string;
  readonly evicted: true;
  /** The durable sessions-index summary, passed through tolerantly. */
  readonly summary: Record<string, unknown>;
  readonly summarizedAt: string;
};

export type SessionListing = {
  readonly sessionRoot: SessionRootInfo;
  readonly sessions: ReadonlyArray<SessionRow | EvictedSessionRow>;
};

function listDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readJsonSafe(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // torn/garbage metadata — the row degrades, the scan survives
  }
  return undefined;
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" ? v : fallback);

/** Raw-scan the session root + durable index into newest-first rows. */
export function listSessions(harnessDir: string, nowMs: number): SessionListing {
  const rootInfo = resolveSessionRoot(harnessDir);
  const live = new Map<string, { row: SessionRow; sortTs: number }>();
  for (const file of listDirSafe(rootInfo.root)) {
    if (!SESSION_JSON_RE.test(file)) continue;
    const id = file.slice(0, -".json".length);
    // Shape-checked above; still containment-checked because a session file
    // can be a symlink planted inside the (possibly overridden) root.
    const path = resolveContained(rootInfo.root, file);
    if (path === undefined) continue;
    const meta = readJsonSafe(path) ?? {};
    let mtimeMs = nowMs;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      // vanished mid-scan — keep the row with a zero age
    }
    const updatedAt = str(meta["updatedAt"], new Date(mtimeMs).toISOString());
    const sortTs = Number.isNaN(Date.parse(updatedAt)) ? mtimeMs : Date.parse(updatedAt);
    live.set(id, {
      sortTs,
      row: {
        id,
        name: str(meta["name"]),
        model: str(meta["model"]),
        target: str(meta["target"]),
        updatedAt,
        lastTurnIndex: num(meta["lastTurnIndex"]),
        ageDays: Math.max(0, Math.floor((nowMs - mtimeMs) / 86_400_000)),
        evicted: false,
      },
    });
  }

  // Fall-through merge: durable summaries for ids with no live metadata.
  // Derived from the HARNESS dir, never from dirname(sessionRoot): an
  // overridden session root can sit anywhere, and its parent is not ours to
  // read. Summaries are masked like every other served payload.
  const indexDir = resolveContained(harnessDir, join(".crewhaus", "sessions-index"));
  const evicted: Array<{ row: EvictedSessionRow; sortTs: number }> = [];
  for (const file of indexDir === undefined ? [] : listDirSafe(indexDir)) {
    if (!SESSION_JSON_RE.test(file)) continue;
    const id = file.slice(0, -".json".length);
    if (live.has(id)) continue;
    const summaryPath = indexDir === undefined ? undefined : resolveContained(indexDir, file);
    if (summaryPath === undefined) continue;
    const summary = readJsonSafe(summaryPath);
    if (summary === undefined) continue;
    const summarizedAt = str(summary["summarizedAt"]);
    const parsed = Date.parse(summarizedAt);
    evicted.push({
      sortTs: Number.isNaN(parsed) ? 0 : parsed,
      row: {
        id,
        evicted: true,
        summary: maskDeep(summary) as Record<string, unknown>,
        summarizedAt,
      },
    });
  }

  const rows = [...live.values(), ...evicted].sort((a, b) => b.sortTs - a.sortTs);
  return { sessionRoot: rootInfo, sessions: rows.map((r) => r.row) };
}

// ---------------------------------------------------------------------------
// Transcript envelope
// ---------------------------------------------------------------------------

/** Session-log side-channel kinds surfaced in the metadata gutter. */
export const GUTTER_KINDS: ReadonlySet<string> = new Set([
  "cost_accrual",
  "model_route",
  "permission",
  "user_feedback",
  "recovery",
  "compaction",
]);

export type TranscriptTurn = {
  readonly role: "user" | "assistant";
  readonly text: string;
  /** 0-based line index in the read window (stable anchor for the UI). */
  readonly line: number;
};

export type TranscriptToolCall = {
  readonly toolUseId: string;
  readonly name: string;
  readonly input: unknown;
  readonly line: number;
  readonly result?: unknown;
  readonly isError: boolean;
};

export type TranscriptGutterItem = {
  readonly kind: string;
  readonly line: number;
  readonly payload: unknown;
};

export type TranscriptView = {
  readonly id: string;
  readonly evicted: boolean;
  readonly turns: readonly TranscriptTurn[];
  readonly tools: readonly TranscriptToolCall[];
  readonly gutter: readonly TranscriptGutterItem[];
  /** Tally of kinds seen but not rendered (unknown/future kinds tolerated). */
  readonly otherKinds: Record<string, number>;
  readonly truncated: boolean;
  readonly lineCount: number;
  readonly tornCount: number;
};

type ContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as ContentBlock[])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
  }
  return "";
}

/** True when a session id string has the on-disk shape. */
export function isSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

/**
 * Parse a transcript `.jsonl` into the per-kind envelope the UI renders:
 * conversational turns, tool_use/tool_result pairs (with `isError`), and a
 * metadata gutter of side-channel kinds. Capped + torn-tolerant; text and
 * payloads pass the credential masker (defense in depth — transcripts are
 * the harness's own data, but a pasted key must still never render).
 */
export function readTranscript(sessionRoot: string, id: string): TranscriptView | undefined {
  // Containment even though `id` is shape-checked upstream: either file may
  // be a symlink pointing out of the session root.
  const logPath = resolveContained(sessionRoot, `${id}.jsonl`);
  const metaPath = resolveContained(sessionRoot, `${id}.json`);
  if (logPath === undefined || metaPath === undefined) return undefined;
  if (!existsSync(logPath) && !existsSync(metaPath)) return undefined;
  const read = readJsonlCapped(logPath);

  const turns: TranscriptTurn[] = [];
  const tools: TranscriptToolCall[] = [];
  const byToolUseId = new Map<string, number>(); // toolUseId → index into tools
  const gutter: TranscriptGutterItem[] = [];
  const otherKinds: Record<string, number> = {};

  read.objects.forEach((obj, line) => {
    if (typeof obj !== "object" || obj === null) return;
    const { kind, payload } = obj as { kind?: unknown; payload?: unknown };
    if (typeof kind !== "string") return;

    if (kind === "user_message") {
      const p = (payload ?? {}) as { synthetic?: unknown; content?: unknown };
      const blocks = Array.isArray(p.content) ? (p.content as ContentBlock[]) : [];
      for (const b of blocks) {
        if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
        const at = byToolUseId.get(b.tool_use_id);
        if (at === undefined) continue;
        const call = tools[at] as TranscriptToolCall;
        tools[at] = {
          ...call,
          result: maskDeep(b.content),
          isError: b.is_error === true,
        };
      }
      if (p.synthetic === true) return;
      const text = textOfContent(p.content);
      const toolResultOnly = blocks.length > 0 && blocks.every((b) => b.type === "tool_result");
      if (!toolResultOnly && (typeof p.content === "string" || text !== "")) {
        turns.push({ role: "user", text: maskCredentialTokens(text), line });
      }
      return;
    }

    if (kind === "assistant_message") {
      const content = (payload as { content?: unknown } | undefined)?.content;
      if (Array.isArray(content)) {
        for (const b of content as ContentBlock[]) {
          if (b.type === "tool_use" && typeof b.name === "string") {
            const toolUseId = typeof b.id === "string" ? b.id : `tool_${line}_${tools.length}`;
            byToolUseId.set(toolUseId, tools.length);
            tools.push({
              toolUseId,
              name: b.name,
              input: maskDeep(b.input),
              line,
              isError: false,
            });
          }
        }
      }
      const text = textOfContent(content);
      if (text !== "") turns.push({ role: "assistant", text: maskCredentialTokens(text), line });
      return;
    }

    if (GUTTER_KINDS.has(kind)) {
      gutter.push({ kind, line, payload: maskDeep(payload) });
      return;
    }

    otherKinds[kind] = (otherKinds[kind] ?? 0) + 1;
  });

  return {
    id,
    evicted: false,
    turns,
    tools,
    gutter,
    otherKinds,
    truncated: read.truncated,
    lineCount: read.lineCount,
    tornCount: read.tornCount,
  };
}

export type RawTranscript = {
  readonly id: string;
  readonly raw: readonly string[];
  readonly truncated: boolean;
};

/** The `?raw=1` escape hatch: capped raw lines, still masked. */
export function readTranscriptRaw(sessionRoot: string, id: string): RawTranscript | undefined {
  const logPath = resolveContained(sessionRoot, `${id}.jsonl`);
  if (logPath === undefined) return undefined;
  if (!existsSync(logPath)) return undefined;
  const read = readJsonlCapped(logPath, MAX_RAW_LINES);
  return {
    id,
    raw: read.rawLines.map((l) => maskCredentialTokens(l)),
    truncated: read.truncated,
  };
}
