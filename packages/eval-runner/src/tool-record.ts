/**
 * NEW-HUNT-4 — tool record / replay for eval runs.
 *
 * `crewhaus eval` wires the spec's REAL tools and MCP servers and runs every
 * sample with `permissionMode: "auto"`, so a tool-using agent's eval hits the
 * network, the filesystem and every MCP write on every sample of every
 * iteration. This module is the deterministic alternative:
 *
 * - RECORD (`--record-tools <dir>`): each tool execution's result is appended
 *   to `<dir>/tools.jsonl`, keyed by `(sampleId, toolName, sha256(canonical
 *   JSON of the parsed args))`.
 * - REPLAY (`--replay-tools <dir>`): the same key resolves against the
 *   recording and the recorded result is returned WITHOUT executing the tool.
 *   A key the recording does not carry is a MISS, governed by the miss policy:
 *   `error` (default — loud, names the key) or `live` (execute for real).
 *
 * The seam is `RegisteredTool.execute`: `@crewhaus/tool-executor` validates
 * the model's raw input against the tool's Zod schema and then calls
 * `tool.execute(parsedInput, ctx)`, so wrapping `execute` intercepts every
 * tool call the runtime makes — built-ins, MCP tools, the Skill/Task wrappers
 * and the memory fabric's tools alike — and hashes the PARSED args (schema
 * defaults applied, key order irrelevant).
 *
 * Deliberate scope: only tool EXECUTION is recorded/replayed. The agent stack
 * is still wired (MCP servers still boot, so their tool schemas exist) and the
 * model still runs live — this is a tool-side cassette, not a full VCR.
 *
 * SENSITIVITY: a recording holds tool args and results VERBATIM — bash stdout,
 * file contents, MCP responses, whatever a credentialed tool returned. Treat a
 * cassette like a session transcript: do not commit one recorded against
 * production credentials or production data. The recording FILE is written
 * 0600 and its directory 0700, but the directory is a path the caller chose
 * (often next to the dataset, i.e. inside a repo), so the choice of what to
 * version is the caller's.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_CODES, RunFailedError } from "@crewhaus/errors";
import type { RegisteredTool, ToolExecuteResult } from "@crewhaus/tool-catalog";
import { RunnerError } from "./errors";

/** The single JSONL file a recording directory holds. */
export const TOOL_RECORDING_FILENAME = "tools.jsonl";

/**
 * Stable prefix of every replay-miss failure message. The runner matches on
 * it to SUPPRESS its bounded noise auto-retry: a miss is deterministic by
 * construction (same key, same recording), so re-running the sample would
 * burn a second model call to fail identically — the same reasoning G54
 * applies to a `failure_taxonomy` class declaring `recovery: fail`.
 */
export const TOOL_REPLAY_MISS_MARKER = "tool replay miss";

/** What a replay does when the recording has no entry for a call's key. */
export type ToolReplayMissPolicy = "error" | "live";

/**
 * One line of `tools.jsonl`. `args`/`result` are VERBATIM tool input and
 * output — see the module docstring's sensitivity note before committing a
 * recording anywhere.
 */
export type ToolRecord = {
  /** The eval sample whose invocation made the call. */
  readonly sampleId: string;
  readonly toolName: string;
  /** sha256 hex of {@link canonicalJson}(parsed args). */
  readonly argsHash: string;
  /** The parsed args verbatim — human-readable evidence, never the key. */
  readonly args: unknown;
  /** The tool's return value. Absent when the call THREW (see `error`). */
  readonly result?: ToolExecuteResult;
  /** The thrown error's message when the call threw. Absent on success. */
  readonly error?: string;
  readonly ts: string;
};

/**
 * Deterministic JSON encoding: object keys sorted recursively so the same
 * logical args always produce the same string regardless of property order
 * (arrays keep their order — order IS meaning there). An object key whose
 * value is `undefined` is SKIPPED, exactly as `JSON.stringify` skips it, so a
 * key present-but-undefined and an absent key hash the same — and so a hash
 * recomputed from a recording's round-tripped `args` (JSON dropped the
 * undefined key on write) still matches the live call's. Inside an ARRAY
 * `undefined` stays a positional `null`, again matching `JSON.stringify`:
 * dropping it would shift every later element.
 * Mirrors `@crewhaus/tool-loop-detection`'s private encoder; kept local so
 * the recording format never moves when loop detection's does.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  // bigint / symbol / function — stable, obviously-tagged fallback.
  return JSON.stringify(String(value));
}

/** sha256 hex of the canonical encoding of a tool call's parsed args. */
export function hashToolArgs(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args)).digest("hex");
}

/** The replay lookup key: `(sampleId, toolName, argsHash)`, NUL-joined. */
export function toolRecordKey(sampleId: string, toolName: string, argsHash: string): string {
  return `${sampleId}\u0000${toolName}\u0000${argsHash}`;
}

export type ToolRecorderOptions = {
  /** Recording directory (created on construction). */
  readonly dir: string;
  /** Clock seam — tests pin the `ts` field. */
  readonly now?: () => Date;
  /** Append seam — tests capture lines without touching disk. */
  readonly append?: (path: string, line: string) => void;
};

/**
 * Append-only writer for a recording directory. `appendFileSync` per record:
 * an eval run is one process and JS is single-threaded, so concurrent samples
 * cannot interleave a partial line (each append completes before the next
 * statement runs).
 */
export class ToolRecorder {
  readonly dir: string;
  readonly path: string;
  private readonly now: () => Date;
  private readonly appendLine: (path: string, line: string) => void;

  constructor(opts: ToolRecorderOptions) {
    this.dir = opts.dir;
    this.path = join(opts.dir, TOOL_RECORDING_FILENAME);
    this.now = opts.now ?? (() => new Date());
    this.appendLine = opts.append ?? ((path, line) => appendFileSync(path, line, { mode: 0o600 }));
    // 0700 to match the 0600 file: the cassette holds verbatim tool args and
    // results (module docstring), so the directory must not be world-readable
    // just because the caller's umask is loose.
    if (opts.append === undefined) mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  }

  record(entry: Omit<ToolRecord, "ts"> & { readonly ts?: string }): ToolRecord {
    const full: ToolRecord = { ...entry, ts: entry.ts ?? this.now().toISOString() };
    this.appendLine(this.path, `${JSON.stringify(full)}\n`);
    return full;
  }
}

/** A parsed recording directory. */
export type LoadedToolRecording = {
  readonly dir: string;
  readonly path: string;
  readonly records: ReadonlyArray<ToolRecord>;
  /**
   * sha256 hex of the `tools.jsonl` bytes — the "recording dir hash" a
   * replayed run records in `run.json`, so two replayed runs can be told
   * apart by the cassette they were served from.
   */
  readonly hash: string;
};

/**
 * Read a recording directory. A missing/unreadable file is a loud
 * `RunnerError` at run start (never a silent all-miss replay); a torn or
 * malformed LINE is skipped with the same posture as the run-history index —
 * one bad append must not make the whole cassette unusable.
 */
export function loadToolRecording(
  dir: string,
  read?: (path: string) => string | undefined,
): LoadedToolRecording {
  const path = join(dir, TOOL_RECORDING_FILENAME);
  const readFile = read ?? ((p: string) => (existsSync(p) ? readFileSync(p, "utf-8") : undefined));
  const text = readFile(path);
  if (text === undefined) {
    throw new RunnerError(
      `tool recording not found: ${path} — record one first with \`crewhaus eval ... --record-tools ${dir}\``,
    );
  }
  const records: ToolRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed) as ToolRecord;
      if (
        typeof parsed?.sampleId === "string" &&
        typeof parsed.toolName === "string" &&
        typeof parsed.argsHash === "string"
      ) {
        records.push(parsed);
      }
    } catch {
      // skip torn line — see docstring
    }
  }
  return {
    dir,
    path,
    records,
    hash: createHash("sha256").update(text).digest("hex"),
  };
}

/** One call that was served a recording entry ALREADY consumed — see
 *  {@link ToolReplayer.reusedEntries}. */
export type ReusedRecordingEntry = {
  readonly sampleId: string;
  readonly toolName: string;
  readonly argsHash: string;
};

/**
 * Serves recorded results by key. Repeated identical calls consume the
 * recorded entries IN ORDER (a tool called twice with the same args in the
 * recorded run replays its first, then its second result); once a key's
 * entries are exhausted the LAST one keeps replaying, so a replayed run that
 * calls an idempotent tool one extra time is a hit, not a spurious miss.
 *
 * That last-entry reuse is a convenience, not a measurement: the replayed
 * trajectory called the tool more times than the recorded one did, so it has
 * DIVERGED from the recording and is being fed a stale result. Every such
 * reuse is counted in {@link reusedEntries} and the runner turns a non-empty
 * list into a run-level `[eval] warning:` plus a `reusedEntries` count on
 * `run.json`'s `toolRecording` block — never a silent substitution.
 */
export class ToolReplayer {
  readonly recording: LoadedToolRecording;
  private readonly byKey = new Map<string, ToolRecord[]>();
  private readonly cursor = new Map<string, number>();
  private readonly reused: ReusedRecordingEntry[] = [];

  constructor(recording: LoadedToolRecording) {
    this.recording = recording;
    for (const rec of recording.records) {
      const key = toolRecordKey(rec.sampleId, rec.toolName, rec.argsHash);
      const list = this.byKey.get(key);
      if (list === undefined) this.byKey.set(key, [rec]);
      else list.push(rec);
    }
  }

  /** Calls served an already-consumed entry, in the order they happened. */
  get reusedEntries(): ReadonlyArray<ReusedRecordingEntry> {
    return this.reused;
  }

  /** The next recorded entry for the key, or undefined on a MISS. */
  take(sampleId: string, toolName: string, argsHash: string): ToolRecord | undefined {
    const key = toolRecordKey(sampleId, toolName, argsHash);
    const list = this.byKey.get(key);
    if (list === undefined || list.length === 0) return undefined;
    const at = this.cursor.get(key) ?? 0;
    if (at < list.length) this.cursor.set(key, at + 1);
    else this.reused.push({ sampleId, toolName, argsHash });
    return list[Math.min(at, list.length - 1)];
  }
}

/** The run-level warning for {@link ToolReplayer.reusedEntries} (empty →
 *  `undefined`, so a clean replay stays silent). */
export function formatReusedRecordingWarning(
  reused: ReadonlyArray<ReusedRecordingEntry>,
  recordingPath: string,
): string | undefined {
  if (reused.length === 0) return undefined;
  const shown = reused
    .slice(0, 10)
    .map((r) => `${r.sampleId}/${r.toolName}@${r.argsHash.slice(0, 12)}`)
    .join(", ");
  const more = reused.length > 10 ? `, … (+${reused.length - 10} more)` : "";
  return `[eval] warning: ${reused.length} tool call(s) replayed a REUSED recording entry — the replayed trajectory called a tool more times than ${recordingPath} recorded, so it diverged from the recording and was served a stale result: ${shown}${more}. Re-record with \`crewhaus eval ... --record-tools <dir>\` to grade the current trajectory.`;
}

/** The terminal failure a `--replay-miss error` miss raises. */
export function toolReplayMissError(args: {
  readonly sampleId: string;
  readonly toolName: string;
  readonly argsHash: string;
  readonly args: unknown;
  readonly recordingPath: string;
}): RunFailedError {
  const preview = clip(canonicalJson(args.args), 200);
  return new RunFailedError({
    class: "config",
    title: TOOL_REPLAY_MISS_MARKER,
    detail:
      `sample "${args.sampleId}" called tool "${args.toolName}" with args-sha256 ${args.argsHash} ` +
      `(args: ${preview}) — no such entry in ${args.recordingPath}`,
    remediation:
      "re-record with `crewhaus eval ... --record-tools <dir>`, or pass `--replay-miss live` to execute unrecorded calls for real",
    exitCode: EXIT_CODES.config,
  });
}

/**
 * Wrap a sample's tool list so every execution is recorded. Additive by
 * construction: the wrapper delegates to the real `execute` and returns its
 * value untouched (a throw is recorded as `error` and re-thrown verbatim), so
 * a recorded run behaves exactly like an unrecorded one.
 */
export function recordingTools(
  tools: ReadonlyArray<RegisteredTool>,
  sampleId: string,
  recorder: ToolRecorder,
): RegisteredTool[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (input: unknown, ctx?: Parameters<RegisteredTool["execute"]>[1]) => {
      const argsHash = hashToolArgs(input);
      try {
        const result = await tool.execute(input, ctx);
        recorder.record({ sampleId, toolName: tool.name, argsHash, args: input, result });
        return result;
      } catch (err) {
        recorder.record({
          sampleId,
          toolName: tool.name,
          argsHash,
          args: input,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  }));
}

/**
 * Wrap a sample's tool list so every execution is SERVED FROM the recording.
 * A recorded throw replays as a plain `Error` carrying the original message
 * (the tool-executor boundary turns it into the same `is_error` tool result
 * the live run produced). A miss follows the policy: `error` throws the
 * terminal {@link toolReplayMissError}; `live` executes the real tool — and
 * records nothing, because a replay directory is read-only evidence.
 */
export function replayingTools(
  tools: ReadonlyArray<RegisteredTool>,
  sampleId: string,
  replayer: ToolReplayer,
  missPolicy: ToolReplayMissPolicy,
): RegisteredTool[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (input: unknown, ctx?: Parameters<RegisteredTool["execute"]>[1]) => {
      const argsHash = hashToolArgs(input);
      const hit = replayer.take(sampleId, tool.name, argsHash);
      if (hit === undefined) {
        if (missPolicy === "live") return tool.execute(input, ctx);
        throw toolReplayMissError({
          sampleId,
          toolName: tool.name,
          argsHash,
          args: input,
          recordingPath: replayer.recording.path,
        });
      }
      if (hit.error !== undefined) throw new Error(hit.error);
      return hit.result ?? "";
    },
  }));
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
