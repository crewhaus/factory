/**
 * @crewhaus/tool-state — durable harness state, and lexical retrieval over it.
 *
 * A long-running crew needs somewhere to put the things a context window
 * cannot hold: what it has already handled, how many attempts are left, where
 * it got to before it was interrupted, what one agent wants another to know.
 * This package is that somewhere. It is a directory of small files under the
 * workspace (`.crewhaus/state` by default) — no database, no server, no
 * network, nothing to run alongside the harness.
 *
 * Four properties hold across every tool here:
 *
 *   1. CONTAINMENT. The state directory and every file path a caller supplies
 *      go through `resolveSafe`, which refuses anything resolving outside
 *      `process.cwd()`, including via a symlink inside the workspace. Every
 *      path BENEATH the state directory is checked the same way, because the
 *      escape that works in practice is an innocuous-looking `kv/cache` that
 *      is a symlink to somewhere else.
 *   2. DETERMINISM. Same inputs against the same state, same bytes out.
 *      Listings are sorted with plain code-unit comparison (never
 *      `localeCompare`), nothing samples a random source, an instant with no
 *      offset is read as UTC rather than in the machine's zone, and NO TOOL
 *      READS THE CLOCK — expiry and timestamps come from a caller-supplied
 *      `now`.
 *   3. TOLERANCE. A corrupt or half-written file is reported, with its path
 *      and the reason, as a normal result. Nothing throws out of `execute`
 *      because a previous run was killed mid-write.
 *   4. SAFETY FLAGS THAT MEAN SOMETHING. Reads are `readOnly`; anything that
 *      writes is `destructive`. Every tool is `scope: "internal"` with no
 *      declared io capability, because nothing here opens a socket or spawns
 *      a process — files under the workspace are all it touches.
 *
 * Concurrency is taken seriously but not magically: compare-and-set, counter
 * increments and sequence allocation run under a machine-local lock file with
 * a deadline, journal appends use `O_APPEND`, and de-duplication rides on an
 * exclusive create. Two agents in one workspace are safe. Two machines sharing
 * a directory over a network filesystem are not, and the README says so.
 */
import { readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolDefinition } from "@crewhaus/tool-catalog";
import { z } from "zod";
import {
  DEFAULT_B,
  DEFAULT_K1,
  type IndexDoc,
  type InvertedIndex,
  buildIndex,
  isInvertedIndex,
  searchIndex,
  snippet,
} from "./lib/bm25";
import {
  type CorruptLine,
  type JsonlRecord,
  filterRecords,
  highestSeq,
  parseJsonl,
  toJsonlLine,
} from "./lib/jsonl";
import {
  MAX_KEY_LENGTH,
  compareStrings,
  decodeSegment,
  encodeSegment,
  validateKey,
  validateName,
} from "./lib/names";
import {
  type StoredRecord,
  byteLength,
  casConflict,
  expiryFrom,
  formatInstant,
  isExpired,
  isPlainObject,
  isStoredRecord,
  parseInstant,
} from "./lib/records";
import {
  type SafePath,
  ToolPermissionError,
  entryNameEscapes,
  resolveSafe,
  workspaceRoot,
} from "./paths";
import {
  DEFAULT_STATE_DIR,
  MAX_FILE_BYTES,
  appendLine,
  createExclusive,
  describeIoError,
  errorCode,
  fileSize,
  listNames,
  readBytes,
  readJsonFile,
  readTextFile,
  relativeToRoot,
  removeFile,
  removeTree,
  sha256,
  statePath,
  stateRoot,
  walkFiles,
  withLock,
  writeBuffer,
  writeJsonAtomic,
} from "./store";

/** Compact JSON — the reader is a model, and every byte is context. */
const json = (value: unknown): string => JSON.stringify(value);

// --- limits -----------------------------------------------------------------

/** Largest single stored value: a KV value, checkpoint, note or journal entry. */
const MAX_VALUE_BYTES = 4 * 1024 * 1024;
/** Largest journal or blackboard log this package will read in one call. */
const MAX_LOG_BYTES = 32 * 1024 * 1024;
/** Largest file `IndexBuild` will index, and `IndexSearch` will re-read. */
const MAX_INDEXED_FILE_BYTES = 4 * 1024 * 1024;
/** Total text `IndexBuild` will hold in memory across every file. */
const MAX_INDEXED_TOTAL_BYTES = 128 * 1024 * 1024;
/** Most records one listing will scan, so a runaway store cannot hang a call. */
const MAX_SCAN = 5_000;
/** Most files `StateExport` will carry, and `StateImport` will accept. */
const MAX_EXPORT_FILES = 5_000;
/** Largest export, measured on the bytes exported. */
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
/** Small metadata files (counters, sequence hints, dedupe marks). */
const SMALL_FILE_BYTES = 64 * 1024;

// --- directory layout -------------------------------------------------------

const KV_DIR = "kv";
const COUNTER_DIR = "counters";
const CHECKPOINT_DIR = "checkpoints";
const JOURNAL_DIR = "journal";
const BLACKBOARD_DIR = "blackboard";
const NOTE_DIR = "notes";
const INDEX_DIR = "indexes";
const DEDUPE_DIR = "dedupe";

/** Every top-level directory this package creates inside a state directory. */
const STATE_DIRS: ReadonlySet<string> = new Set([
  KV_DIR,
  COUNTER_DIR,
  CHECKPOINT_DIR,
  JOURNAL_DIR,
  BLACKBOARD_DIR,
  NOTE_DIR,
  INDEX_DIR,
  DEDUPE_DIR,
]);

// --- shared schema fragments ------------------------------------------------

const stateDirField = z
  .string()
  .min(1)
  .optional()
  .describe(`state directory, relative to the workspace (default '${DEFAULT_STATE_DIR}')`);

const nowField = z
  .string()
  .optional()
  .describe(
    "ISO-8601 instant to record as the time of this call; nothing here reads the system clock, so omitting it simply stores no timestamp",
  );

// --- shared helpers ---------------------------------------------------------

/**
 * `buildTool`, plus the two failures every tool in this package shares: a path
 * that escapes the workspace, and an I/O error the caller can act on. Both
 * come back as a readable sentence. Anything else is a bug and still throws,
 * because a crash the runtime can see beats a lie the caller cannot.
 */
function stateTool<TInput>(def: ToolDefinition<TInput>): RegisteredTool {
  const inner = def.execute;
  return buildTool<TInput>({
    ...def,
    execute: async (input, ctx) => {
      try {
        return await inner(input, ctx);
      } catch (err) {
        if (err instanceof ToolPermissionError) return err.message;
        const io = describeIoError(err);
        if (io !== undefined) return `${def.name} could not complete: ${io}`;
        throw err;
      }
    },
  });
}

type NowParse = { ms?: number; error?: string };

function parseNow(value: string | undefined): NowParse {
  if (value === undefined) return {};
  const ms = parseInstant(value);
  if (ms === undefined) return { error: `now is not an ISO-8601 instant I can read: ${value}` };
  return { ms };
}

/** A corrupt read, rendered for the caller with the path that is broken. */
function corruptMessage(rel: string, reason: string): string {
  return `${rel} is unusable: ${reason} — delete or repair the file, then retry`;
}

function sizeGuard(field: string, value: unknown): string | undefined {
  const bytes = byteLength(JSON.stringify(value ?? null));
  if (bytes > MAX_VALUE_BYTES) {
    return `${field} is ${bytes} bytes, over the ${MAX_VALUE_BYTES} limit — store it as a file and keep a path here instead`;
  }
  return undefined;
}

/** Load a KV record, separating "absent" from "there but broken". */
type LoadedRecord =
  | { kind: "ok"; record: StoredRecord }
  | { kind: "missing" }
  | { kind: "broken"; message: string };

function loadRecord(abs: string, rel: string): LoadedRecord {
  const outcome = readJsonFile(abs, MAX_VALUE_BYTES * 2);
  if (outcome.kind === "missing") return { kind: "missing" };
  if (outcome.kind === "corrupt") {
    return { kind: "broken", message: corruptMessage(rel, outcome.reason) };
  }
  if (!isStoredRecord(outcome.value)) {
    return { kind: "broken", message: corruptMessage(rel, "not a state record") };
  }
  return { kind: "ok", record: outcome.value };
}

/** The `next` hint beside a log, or `undefined` when it is absent or unusable. */
function readSequenceHint(seqAbs: string): number | undefined {
  const outcome = readJsonFile(seqAbs, SMALL_FILE_BYTES);
  if (outcome.kind !== "ok" || !isPlainObject(outcome.value)) return undefined;
  const next = outcome.value["next"];
  return typeof next === "number" && Number.isFinite(next) && next >= 1 ? next : undefined;
}

type SequencedAppend =
  | { ok: true; seq: number; bytes: number; rebuiltSequence: boolean }
  | { ok: false; message: string };

/**
 * Append a record to a `.jsonl` log with a monotonic sequence number.
 *
 * The number is allocated under a lock, so two writers never take the same
 * one; the line itself is written with `O_APPEND`, so even a writer that
 * ignored the lock cannot split somebody else's line. If the sequence hint is
 * missing or unusable it is rebuilt from the log's own highest sequence and
 * the caller is told. Sequences are monotonic but not gapless: an append that
 * fails after its number was allocated leaves a hole, so a sequence is an
 * ordering, not a count.
 */
async function appendSequenced(
  toolName: string,
  root: SafePath,
  dir: string,
  name: string,
  build: (seq: number) => JsonlRecord,
): Promise<SequencedAppend> {
  const encoded = encodeSegment(name);
  const logAbs = statePath(toolName, root, dir, `${encoded}.jsonl`);
  const seqAbs = `${logAbs}.seq`;
  const logRel = relativeToRoot(root, logAbs);

  const locked = await withLock(`${logAbs}.lock`, (): SequencedAppend => {
    const hint = readSequenceHint(seqAbs);
    let next = hint;
    let rebuilt = false;
    if (next === undefined) {
      const log = readTextFile(logAbs, MAX_LOG_BYTES);
      if (log.kind === "corrupt") return { ok: false, message: corruptMessage(logRel, log.reason) };
      next = log.kind === "ok" ? highestSeq(parseJsonl(log.value).records) + 1 : 1;
      // Only call it a rebuild when there was something to rebuild FROM.
      rebuilt = next > 1;
    }
    const line = toJsonlLine(build(next));
    appendLine(logAbs, line);
    writeJsonAtomic(seqAbs, { next: next + 1 });
    return { ok: true, seq: next, bytes: byteLength(line), rebuiltSequence: rebuilt };
  });

  return locked.ok ? locked.value : { ok: false, message: locked.reason };
}

type LogStream = { name: string; lastSeq: number; bytes: number };

/** Every `.jsonl` log in `dir`, sorted by name, with its high-water sequence. */
function listLogs(
  toolName: string,
  root: SafePath,
  dir: string,
): { streams: LogStream[]; undecodable: string[] } {
  const base = statePath(toolName, root, dir);
  const streams: LogStream[] = [];
  const undecodable: string[] = [];
  for (const file of listNames(base, "file")) {
    if (!file.endsWith(".jsonl")) continue;
    const name = decodeSegment(file.slice(0, -".jsonl".length));
    if (name === undefined) {
      undecodable.push(file);
      continue;
    }
    const abs = statePath(toolName, root, dir, file);
    const hint = readSequenceHint(`${abs}.seq`);
    // No hint, or an unusable one, does not mean an empty stream: the hint is
    // a cache of the log's own high-water mark and can be lost on its own.
    // Reporting `lastSeq: 0` for a stream with a thousand entries would send
    // a resuming reader back to the beginning, so it is recomputed instead.
    const lastSeq = hint !== undefined ? hint - 1 : highestSeqOf(toolName, root, dir, name);
    streams.push({ name, lastSeq, bytes: fileSize(abs) ?? 0 });
  }
  streams.sort((a, b) => compareStrings(a.name, b.name));
  return { streams, undecodable };
}

/** The high-water sequence read out of the log itself, or 0 if unreadable. */
function highestSeqOf(toolName: string, root: SafePath, dir: string, name: string): number {
  const log = readLog(toolName, root, dir, name);
  return log.ok ? highestSeq(log.records) : 0;
}

type LogRead =
  | { ok: true; records: ReadonlyArray<JsonlRecord>; corrupt: ReadonlyArray<CorruptLine> }
  | { ok: false; message: string };

function readLog(toolName: string, root: SafePath, dir: string, name: string): LogRead {
  const abs = statePath(toolName, root, dir, `${encodeSegment(name)}.jsonl`);
  const outcome = readTextFile(abs, MAX_LOG_BYTES);
  if (outcome.kind === "missing") return { ok: true, records: [], corrupt: [] };
  if (outcome.kind === "corrupt") {
    return { ok: false, message: corruptMessage(relativeToRoot(root, abs), outcome.reason) };
  }
  const parsed = parseJsonl(outcome.value);
  return { ok: true, records: parsed.records, corrupt: parsed.corrupt };
}

// ---------------------------------------------------------------------------
// key-value store
// ---------------------------------------------------------------------------

export const kvSet: RegisteredTool = stateTool({
  name: "KvSet",
  description:
    "Store a JSON value under a key in a namespace, with an optional TTL and an optional compare-and-set on the current version. Use it to remember something across turns, runs or agents; pass `expectedVersion` when another agent might be writing the same key and the write is refused rather than clobbering theirs.",
  inputSchema: z.object({
    namespace: z.string().min(1).describe("a group of keys, e.g. 'orders' or 'session'"),
    key: z.string().min(1).describe("any printable string, e.g. an id or a URL"),
    value: z.unknown().describe("any JSON value"),
    ttlSeconds: z
      .number()
      .int()
      .positive()
      .max(31_536_000)
      .optional()
      .describe("expiry, counted from `now`; requires `now`"),
    expectedVersion: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("compare-and-set: the version you last read, or 0 to require the key be absent"),
    now: nowField,
    stateDir: stateDirField,
  }),
  destructive: true,
  execute: async (input) => {
    const badNamespace = validateName("namespace", input.namespace);
    if (badNamespace !== undefined) return badNamespace;
    const badKey = validateKey("key", input.key);
    if (badKey !== undefined) return badKey;
    if (input.value === undefined)
      return "value is required — pass null if you mean an empty value";
    const tooBig = sizeGuard("value", input.value);
    if (tooBig !== undefined) return tooBig;
    const now = parseNow(input.now);
    if (now.error !== undefined) return now.error;
    if (input.ttlSeconds !== undefined && now.ms === undefined) {
      return "ttlSeconds needs `now`: expiry is computed from the instant you supply, never from the system clock";
    }

    const root = stateRoot("KvSet", input.stateDir);
    const abs = statePath(
      "KvSet",
      root,
      KV_DIR,
      encodeSegment(input.namespace),
      `${encodeSegment(input.key)}.json`,
    );
    const rel = relativeToRoot(root, abs);

    const locked = await withLock(`${abs}.lock`, () => {
      const existing = loadRecord(abs, rel);
      if (existing.kind === "broken") return existing.message;
      const current = existing.kind === "missing" ? undefined : existing.record.version;
      const conflict = casConflict(current, input.expectedVersion);
      if (conflict !== undefined) {
        return json({
          stored: false,
          conflict: true,
          reason: conflict,
          currentVersion: current ?? null,
        });
      }
      const record: StoredRecord = {
        key: input.key,
        value: input.value,
        version: (current ?? 0) + 1,
        ...(input.ttlSeconds !== undefined && now.ms !== undefined
          ? { expiresAt: expiryFrom(now.ms, input.ttlSeconds) }
          : {}),
        ...(now.ms !== undefined ? { updatedAt: formatInstant(now.ms) } : {}),
      };
      const bytes = writeJsonAtomic(abs, record);
      return json({
        stored: true,
        namespace: input.namespace,
        key: input.key,
        version: record.version,
        created: current === undefined,
        bytes,
        ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
      });
    });
    return locked.ok ? locked.value : locked.reason;
  },
});

export const kvGet: RegisteredTool = stateTool({
  name: "KvGet",
  description:
    "Read one key back, with its version and expiry. Use it before a compare-and-set write, or to recover a value a previous turn stored; expiry is evaluated only when you pass `now`, and the result says whether it was checked.",
  inputSchema: z.object({
    namespace: z.string().min(1),
    key: z.string().min(1),
    now: z
      .string()
      .optional()
      .describe("ISO-8601 instant to evaluate expiry against; omit and expiry is not checked"),
    includeExpired: z.boolean().optional().describe("return the value even when it has expired"),
    stateDir: stateDirField,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const badNamespace = validateName("namespace", input.namespace);
    if (badNamespace !== undefined) return badNamespace;
    const badKey = validateKey("key", input.key);
    if (badKey !== undefined) return badKey;
    const now = parseNow(input.now);
    if (now.error !== undefined) return now.error;

    const root = stateRoot("KvGet", input.stateDir);
    const abs = statePath(
      "KvGet",
      root,
      KV_DIR,
      encodeSegment(input.namespace),
      `${encodeSegment(input.key)}.json`,
    );
    const loaded = loadRecord(abs, relativeToRoot(root, abs));
    if (loaded.kind === "broken") return loaded.message;
    if (loaded.kind === "missing") {
      return json({ found: false, namespace: input.namespace, key: input.key });
    }
    const record = loaded.record;
    const expired = isExpired(record.expiresAt, now.ms);
    if (expired && input.includeExpired !== true) {
      return json({
        found: false,
        expired: true,
        namespace: input.namespace,
        key: input.key,
        version: record.version,
        expiresAt: record.expiresAt,
      });
    }
    return json({
      found: true,
      namespace: input.namespace,
      key: input.key,
      value: record.value,
      version: record.version,
      expired,
      expiryChecked: record.expiresAt === undefined || now.ms !== undefined,
      ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
      ...(record.updatedAt !== undefined ? { updatedAt: record.updatedAt } : {}),
    });
  },
});

export const kvDelete: RegisteredTool = stateTool({
  name: "KvDelete",
  description:
    "Delete a key, optionally only while it is still at the version you read. Use it to release a claim or drop state you are finished with; deleting a key that is not there is reported, not an error.",
  inputSchema: z.object({
    namespace: z.string().min(1),
    key: z.string().min(1),
    expectedVersion: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("compare-and-set: delete only if the key is still at this version"),
    stateDir: stateDirField,
  }),
  destructive: true,
  execute: async (input) => {
    const badNamespace = validateName("namespace", input.namespace);
    if (badNamespace !== undefined) return badNamespace;
    const badKey = validateKey("key", input.key);
    if (badKey !== undefined) return badKey;

    const root = stateRoot("KvDelete", input.stateDir);
    const abs = statePath(
      "KvDelete",
      root,
      KV_DIR,
      encodeSegment(input.namespace),
      `${encodeSegment(input.key)}.json`,
    );
    const rel = relativeToRoot(root, abs);

    const locked = await withLock(`${abs}.lock`, () => {
      const existing = loadRecord(abs, rel);
      if (existing.kind === "broken") {
        // A corrupt record can still be deleted — that is half the point of a
        // delete — but not under a version check it cannot satisfy.
        if (input.expectedVersion !== undefined) return existing.message;
        return json({ deleted: removeFile(abs), existed: true, corrupt: true });
      }
      if (existing.kind === "missing") {
        const conflict = casConflict(undefined, input.expectedVersion);
        if (conflict !== undefined)
          return json({ deleted: false, conflict: true, reason: conflict });
        return json({ deleted: false, existed: false });
      }
      const version = existing.record.version;
      const conflict = casConflict(version, input.expectedVersion);
      if (conflict !== undefined) {
        return json({ deleted: false, conflict: true, reason: conflict, currentVersion: version });
      }
      return json({ deleted: removeFile(abs), existed: true, version });
    });
    return locked.ok ? locked.value : locked.reason;
  },
});

export const kvList: RegisteredTool = stateTool({
  name: "KvList",
  description:
    "List the keys in a namespace, sorted, with their versions and optionally their values. Use it to see what a previous run left behind; records whose files are corrupt are listed separately instead of failing the whole call.",
  inputSchema: z.object({
    namespace: z.string().min(1),
    prefix: z.string().optional().describe("only keys starting with this"),
    includeValues: z.boolean().optional().describe("include each value (default false)"),
    now: z.string().optional().describe("ISO-8601 instant to evaluate expiry against"),
    includeExpired: z.boolean().optional(),
    limit: z.number().int().positive().max(MAX_SCAN).optional().describe("default 200"),
    stateDir: stateDirField,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const badNamespace = validateName("namespace", input.namespace);
    if (badNamespace !== undefined) return badNamespace;
    const now = parseNow(input.now);
    if (now.error !== undefined) return now.error;
    const limit = input.limit ?? 200;

    const root = stateRoot("KvList", input.stateDir);
    const namespaceDir = encodeSegment(input.namespace);
    const dir = statePath("KvList", root, KV_DIR, namespaceDir);

    const entries: Array<Record<string, unknown>> = [];
    const corrupt: Array<{ file: string; reason: string }> = [];
    let expiredCount = 0;
    let scanned = 0;
    for (const file of listNames(dir, "file")) {
      if (!file.endsWith(".json")) continue;
      if (scanned >= MAX_SCAN) break;
      scanned += 1;
      const loaded = loadRecord(statePath("KvList", root, KV_DIR, namespaceDir, file), file);
      if (loaded.kind === "broken") {
        corrupt.push({ file, reason: loaded.message });
        continue;
      }
      if (loaded.kind === "missing") continue;
      const record = loaded.record;
      if (input.prefix !== undefined && !record.key.startsWith(input.prefix)) continue;
      const expired = isExpired(record.expiresAt, now.ms);
      if (expired) {
        expiredCount += 1;
        if (input.includeExpired !== true) continue;
      }
      entries.push({
        key: record.key,
        version: record.version,
        expired,
        ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
        ...(record.updatedAt !== undefined ? { updatedAt: record.updatedAt } : {}),
        ...(input.includeValues === true ? { value: record.value } : {}),
      });
    }
    entries.sort((a, b) => compareStrings(String(a["key"]), String(b["key"])));

    return json({
      namespace: input.namespace,
      total: entries.length,
      returned: Math.min(entries.length, limit),
      truncated: entries.length > limit || scanned >= MAX_SCAN,
      expiredSkipped: input.includeExpired === true ? 0 : expiredCount,
      expiryChecked: now.ms !== undefined,
      keys: entries.slice(0, limit),
      ...(corrupt.length > 0 ? { corrupt } : {}),
    });
  },
});

// ---------------------------------------------------------------------------
// counters
// ---------------------------------------------------------------------------

type CounterRecord = { name: string; value: number; version: number; updatedAt?: string };

function isCounter(value: unknown): value is CounterRecord {
  return (
    isPlainObject(value) &&
    typeof value["name"] === "string" &&
    typeof value["value"] === "number" &&
    typeof value["version"] === "number"
  );
}

export const counterIncrement: RegisteredTool = stateTool({
  name: "CounterIncrement",
  description:
    "Add to a durable named counter and return the new value, optionally refusing to cross a limit. Use it for attempt counts, quotas and budgets that must survive a restart; the read-modify-write runs under a lock, so two agents incrementing at once both count.",
  inputSchema: z.object({
    name: z.string().min(1).describe("counter name, e.g. 'retries.orders'"),
    by: z
      .number()
      .int()
      .min(-1_000_000_000)
      .max(1_000_000_000)
      .optional()
      .describe("default 1; may be negative"),
    limit: z
      .number()
      .int()
      .optional()
      .describe(
        "refuse the increment, leaving the counter untouched, if it would take the value above this",
      ),
    now: nowField,
    stateDir: stateDirField,
  }),
  destructive: true,
  execute: async (input) => {
    const badName = validateName("name", input.name);
    if (badName !== undefined) return badName;
    const now = parseNow(input.now);
    if (now.error !== undefined) return now.error;
    const by = input.by ?? 1;

    const root = stateRoot("CounterIncrement", input.stateDir);
    const abs = statePath(
      "CounterIncrement",
      root,
      COUNTER_DIR,
      `${encodeSegment(input.name)}.json`,
    );
    const rel = relativeToRoot(root, abs);

    const locked = await withLock(`${abs}.lock`, () => {
      const outcome = readJsonFile(abs, SMALL_FILE_BYTES);
      if (outcome.kind === "corrupt") return corruptMessage(rel, outcome.reason);
      let previous = 0;
      let version = 0;
      if (outcome.kind === "ok") {
        if (!isCounter(outcome.value)) return corruptMessage(rel, "not a counter record");
        previous = outcome.value.value;
        version = outcome.value.version;
      }
      const next = previous + by;
      if (input.limit !== undefined && next > input.limit) {
        return json({
          applied: false,
          limited: true,
          name: input.name,
          value: previous,
          limit: input.limit,
          reason: `${previous} + ${by} would exceed the limit of ${input.limit}`,
        });
      }
      const record: CounterRecord = {
        name: input.name,
        value: next,
        version: version + 1,
        ...(now.ms !== undefined ? { updatedAt: formatInstant(now.ms) } : {}),
      };
      writeJsonAtomic(abs, record);
      return json({
        applied: true,
        name: input.name,
        value: next,
        previous,
        by,
        version: record.version,
      });
    });
    return locked.ok ? locked.value : locked.reason;
  },
});

export const counterGet: RegisteredTool = stateTool({
  name: "CounterGet",
  description:
    "Read one counter, or every counter when you name none. Use it to check a budget before spending it; a counter that has never been incremented reads as 0 rather than as an error.",
  inputSchema: z.object({
    name: z.string().min(1).optional().describe("omit to list every counter, sorted by name"),
    prefix: z.string().optional().describe("when listing, only counters starting with this"),
    stateDir: stateDirField,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const root = stateRoot("CounterGet", input.stateDir);
    if (input.name !== undefined) {
      const badName = validateName("name", input.name);
      if (badName !== undefined) return badName;
      const abs = statePath("CounterGet", root, COUNTER_DIR, `${encodeSegment(input.name)}.json`);
      const rel = relativeToRoot(root, abs);
      const outcome = readJsonFile(abs, SMALL_FILE_BYTES);
      if (outcome.kind === "corrupt") return corruptMessage(rel, outcome.reason);
      if (outcome.kind === "missing") {
        return json({ name: input.name, value: 0, exists: false, version: 0 });
      }
      if (!isCounter(outcome.value)) return corruptMessage(rel, "not a counter record");
      return json({
        name: input.name,
        value: outcome.value.value,
        exists: true,
        version: outcome.value.version,
        ...(outcome.value.updatedAt !== undefined ? { updatedAt: outcome.value.updatedAt } : {}),
      });
    }

    const dir = statePath("CounterGet", root, COUNTER_DIR);
    const counters: Array<Record<string, unknown>> = [];
    const corrupt: Array<{ file: string; reason: string }> = [];
    for (const file of listNames(dir, "file")) {
      if (!file.endsWith(".json")) continue;
      const outcome = readJsonFile(
        statePath("CounterGet", root, COUNTER_DIR, file),
        SMALL_FILE_BYTES,
      );
      if (outcome.kind !== "ok" || !isCounter(outcome.value)) {
        corrupt.push({
          file,
          reason: outcome.kind === "corrupt" ? outcome.reason : "not a counter record",
        });
        continue;
      }
      if (input.prefix !== undefined && !outcome.value.name.startsWith(input.prefix)) continue;
      counters.push({
        name: outcome.value.name,
        value: outcome.value.value,
        version: outcome.value.version,
      });
    }
    counters.sort((a, b) => compareStrings(String(a["name"]), String(b["name"])));
    return json({ count: counters.length, counters, ...(corrupt.length > 0 ? { corrupt } : {}) });
  },
});

// ---------------------------------------------------------------------------
// checkpoints
// ---------------------------------------------------------------------------

const VERSION_FILE = /^v(\d{7})\.json$/;

function checkpointVersions(dirAbs: string): number[] {
  const versions: number[] = [];
  for (const file of listNames(dirAbs, "file")) {
    const match = VERSION_FILE.exec(file);
    const digits = match?.[1];
    if (digits !== undefined) versions.push(Number.parseInt(digits, 10));
  }
  return versions.sort((a, b) => a - b);
}

function versionFileName(version: number): string {
  return `v${String(version).padStart(7, "0")}.json`;
}

export const checkpointSave: RegisteredTool = stateTool({
  name: "CheckpointSave",
  description:
    "Save a named JSON checkpoint as a new numbered version, so a long flow can be resumed after a crash or a restart. Use it at each stage boundary; earlier versions are kept unless you set `keep`, and `expectedVersion` refuses the save when somebody else checkpointed in the meantime.",
  inputSchema: z.object({
    name: z.string().min(1).describe("checkpoint name, e.g. 'migration' or 'crawl.batch-3'"),
    data: z.unknown().describe("any JSON value — the state you want back later"),
    label: z.string().max(200).optional().describe("a short human note about this version"),
    expectedVersion: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("the latest version you saw; 0 requires that no checkpoint exists yet"),
    keep: z
      .number()
      .int()
      .positive()
      .max(1000)
      .optional()
      .describe("keep only this many most recent versions, deleting older ones"),
    now: nowField,
    stateDir: stateDirField,
  }),
  destructive: true,
  execute: async (input) => {
    const badName = validateName("name", input.name);
    if (badName !== undefined) return badName;
    if (input.data === undefined) {
      return "data is required — pass null if you mean an empty checkpoint";
    }
    const tooBig = sizeGuard("data", input.data);
    if (tooBig !== undefined) return tooBig;
    const now = parseNow(input.now);
    if (now.error !== undefined) return now.error;

    const root = stateRoot("CheckpointSave", input.stateDir);
    const folder = encodeSegment(input.name);
    const dir = statePath("CheckpointSave", root, CHECKPOINT_DIR, folder);

    const locked = await withLock(`${dir}.lock`, () => {
      const versions = checkpointVersions(dir);
      const latest = versions.length === 0 ? undefined : versions[versions.length - 1];
      const conflict = casConflict(latest, input.expectedVersion);
      if (conflict !== undefined) {
        return json({ saved: false, conflict: true, reason: conflict, latestVersion: latest ?? 0 });
      }
      const version = (latest ?? 0) + 1;
      const abs = statePath(
        "CheckpointSave",
        root,
        CHECKPOINT_DIR,
        folder,
        versionFileName(version),
      );
      const line = `${JSON.stringify({
        name: input.name,
        version,
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(now.ms !== undefined ? { savedAt: formatInstant(now.ms) } : {}),
        data: input.data,
      })}\n`;
      if (!createExclusive(abs, line)) {
        return `checkpoint "${input.name}" version ${version} already exists — another writer got there first; re-read with CheckpointList and retry`;
      }
      const pruned: number[] = [];
      if (input.keep !== undefined) {
        const all = [...versions, version];
        for (const old of all.slice(0, Math.max(0, all.length - input.keep))) {
          const oldAbs = statePath(
            "CheckpointSave",
            root,
            CHECKPOINT_DIR,
            folder,
            versionFileName(old),
          );
          if (removeFile(oldAbs)) pruned.push(old);
        }
      }
      return json({
        saved: true,
        name: input.name,
        version,
        bytes: byteLength(line),
        ...(pruned.length > 0 ? { pruned } : {}),
      });
    });
    return locked.ok ? locked.value : locked.reason;
  },
});

export const checkpointLoad: RegisteredTool = stateTool({
  name: "CheckpointLoad",
  description:
    "Load a checkpoint back — the newest version, or an earlier one by number. Use it when resuming: load, see how far the last run got, and carry on from there instead of starting again.",
  inputSchema: z.object({
    name: z.string().min(1),
    version: z.number().int().positive().optional().describe("default: the most recent version"),
    stateDir: stateDirField,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const badName = validateName("name", input.name);
    if (badName !== undefined) return badName;
    const root = stateRoot("CheckpointLoad", input.stateDir);
    const folder = encodeSegment(input.name);
    const versions = checkpointVersions(statePath("CheckpointLoad", root, CHECKPOINT_DIR, folder));
    if (versions.length === 0) return json({ found: false, name: input.name, versions: 0 });

    const latest = versions[versions.length - 1];
    const wanted = input.version ?? latest;
    if (wanted === undefined || !versions.includes(wanted)) {
      return json({
        found: false,
        name: input.name,
        requestedVersion: wanted ?? null,
        availableVersions: versions,
      });
    }
    const abs = statePath("CheckpointLoad", root, CHECKPOINT_DIR, folder, versionFileName(wanted));
    const rel = relativeToRoot(root, abs);
    const outcome = readJsonFile(abs, MAX_VALUE_BYTES * 2);
    if (outcome.kind === "corrupt") return corruptMessage(rel, outcome.reason);
    if (outcome.kind === "missing") {
      return json({ found: false, name: input.name, requestedVersion: wanted });
    }
    if (!isPlainObject(outcome.value)) return corruptMessage(rel, "not a checkpoint record");
    const label = outcome.value["label"];
    const savedAt = outcome.value["savedAt"];
    return json({
      found: true,
      name: input.name,
      version: wanted,
      latestVersion: latest,
      ...(typeof label === "string" ? { label } : {}),
      ...(typeof savedAt === "string" ? { savedAt } : {}),
      data: outcome.value["data"],
    });
  },
});

export const checkpointList: RegisteredTool = stateTool({
  name: "CheckpointList",
  description:
    "List the saved checkpoints with their version counts and newest label. Use it to find out what a previous run left to resume from before loading anything.",
  inputSchema: z.object({
    name: z.string().min(1).optional().describe("only this checkpoint"),
    stateDir: stateDirField,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const root = stateRoot("CheckpointList", input.stateDir);
    const base = statePath("CheckpointList", root, CHECKPOINT_DIR);
    const out: Array<Record<string, unknown>> = [];
    const undecodable: string[] = [];
    for (const entry of listNames(base, "dir")) {
      const name = decodeSegment(entry);
      if (name === undefined) {
        undecodable.push(entry);
        continue;
      }
      if (input.name !== undefined && name !== input.name) continue;
      const versions = checkpointVersions(statePath("CheckpointList", root, CHECKPOINT_DIR, entry));
      const latest = versions[versions.length - 1];
      if (latest === undefined) continue;
      const abs = statePath("CheckpointList", root, CHECKPOINT_DIR, entry, versionFileName(latest));
      const bytes = fileSize(abs);
      const outcome = readJsonFile(abs, MAX_VALUE_BYTES * 2);
      const head =
        outcome.kind === "ok" && isPlainObject(outcome.value) ? outcome.value : undefined;
      const label = head?.["label"];
      const savedAt = head?.["savedAt"];
      out.push({
        name,
        versions: versions.length,
        latestVersion: latest,
        oldestVersion: versions[0],
        ...(bytes !== undefined ? { bytes } : {}),
        ...(typeof label === "string" ? { label } : {}),
        ...(typeof savedAt === "string" ? { savedAt } : {}),
        ...(outcome.kind === "corrupt" ? { corrupt: outcome.reason } : {}),
      });
    }
    out.sort((a, b) => compareStrings(String(a["name"]), String(b["name"])));
    return json({
      count: out.length,
      checkpoints: out,
      ...(undecodable.length > 0 ? { unreadableNames: undecodable } : {}),
    });
  },
});

// ---------------------------------------------------------------------------
// journal
// ---------------------------------------------------------------------------

export const journalAppend: RegisteredTool = stateTool({
  name: "JournalAppend",
  description:
    "Append one entry to an append-only JSONL stream and return its monotonic sequence number. Use it to record what happened, in order, so a later run or a reviewer can replay it; the sequence is allocated under a lock and the line written with O_APPEND, so concurrent writers never interleave.",
  inputSchema: z.object({
    stream: z.string().min(1).describe("stream name, e.g. 'runs' or 'orders.processed'"),
    entry: z.record(z.unknown()).describe("the JSON object to record"),
    kind: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("a label to filter on later, e.g. 'error' or 'sent'"),
    now: nowField,
    stateDir: stateDirField,
  }),
  destructive: true,
  execute: async (input) => {
    const badName = validateName("stream", input.stream);
    if (badName !== undefined) return badName;
    const tooBig = sizeGuard("entry", input.entry);
    if (tooBig !== undefined) return tooBig;
    const now = parseNow(input.now);
    if (now.error !== undefined) return now.error;

    const root = stateRoot("JournalAppend", input.stateDir);
    const result = await appendSequenced(
      "JournalAppend",
      root,
      JOURNAL_DIR,
      input.stream,
      (seq) => ({
        seq,
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(now.ms !== undefined ? { at: formatInstant(now.ms) } : {}),
        data: input.entry,
      }),
    );
    if (!result.ok) return result.message;
    return json({
      stream: input.stream,
      seq: result.seq,
      bytes: result.bytes,
      ...(result.rebuiltSequence ? { rebuiltSequence: true } : {}),
    });
  },
});

export const journalRead: RegisteredTool = stateTool({
  name: "JournalRead",
  description:
    "Read a journal stream back, filtered by sequence range, kind or substring — or list the streams when you name none. Use `sinceSeq` with the last sequence you handled to read only what is new; corrupt lines are reported with their line numbers and the rest of the stream is still returned.",
  inputSchema: z.object({
    stream: z
      .string()
      .min(1)
      .optional()
      .describe("omit to list every stream with its last sequence"),
    sinceSeq: z.number().int().min(0).optional().describe("exclusive: entries after this sequence"),
    untilSeq: z.number().int().min(0).optional().describe("inclusive: entries up to this sequence"),
    kind: z.string().min(1).optional(),
    contains: z.string().min(1).optional().describe("case-sensitive substring of the entry's JSON"),
    limit: z.number().int().positive().max(MAX_SCAN).optional().describe("default 100"),
    order: z
      .enum(["asc", "desc"])
      .optional()
      .describe("'desc' returns the newest first (default 'asc')"),
    stateDir: stateDirField,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const root = stateRoot("JournalRead", input.stateDir);
    if (input.stream === undefined) {
      const { streams, undecodable } = listLogs("JournalRead", root, JOURNAL_DIR);
      return json({
        count: streams.length,
        streams,
        ...(undecodable.length > 0 ? { unreadableNames: undecodable } : {}),
      });
    }
    const badName = validateName("stream", input.stream);
    if (badName !== undefined) return badName;

    const log = readLog("JournalRead", root, JOURNAL_DIR, input.stream);
    if (!log.ok) return log.message;
    const filtered = filterRecords(log.records, {
      ...(input.sinceSeq !== undefined ? { sinceSeq: input.sinceSeq } : {}),
      ...(input.untilSeq !== undefined ? { untilSeq: input.untilSeq } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.contains !== undefined ? { contains: input.contains } : {}),
      limit: input.limit ?? 100,
      order: input.order ?? "asc",
    });
    return json({
      stream: input.stream,
      total: log.records.length,
      matched: filtered.matched,
      returned: filtered.selected.length,
      truncated: filtered.truncated,
      lastSeq: highestSeq(log.records),
      entries: filtered.selected,
      ...(log.corrupt.length > 0 ? { corruptLines: log.corrupt } : {}),
    });
  },
});

// ---------------------------------------------------------------------------
// blackboard
// ---------------------------------------------------------------------------

export const blackboardPost: RegisteredTool = stateTool({
  name: "BlackboardPost",
  description:
    "Post a note to a shared topic that other crew members can read. Use it to leave findings, claims or warnings for agents working the same problem — it is a durable pinboard, not a delivery mechanism, so nobody is notified and nobody is guaranteed to read it.",
  inputSchema: z.object({
    topic: z.string().min(1).describe("topic name, e.g. 'incident-421'"),
    author: z.string().min(1).max(64).describe("who is posting, e.g. the agent's name"),
    text: z.string().min(1).max(32_000).describe("the note itself"),
    tags: z.array(z.string().min(1).max(64)).max(32).optional(),
    replyToSeq: z.number().int().positive().optional().describe("the post this one answers"),
    now: nowField,
    stateDir: stateDirField,
  }),
  destructive: true,
  execute: async (input) => {
    const badTopic = validateName("topic", input.topic);
    if (badTopic !== undefined) return badTopic;
    const badAuthor = validateKey("author", input.author, 64);
    if (badAuthor !== undefined) return badAuthor;
    const now = parseNow(input.now);
    if (now.error !== undefined) return now.error;

    const root = stateRoot("BlackboardPost", input.stateDir);
    const result = await appendSequenced(
      "BlackboardPost",
      root,
      BLACKBOARD_DIR,
      input.topic,
      (seq) => ({
        seq,
        author: input.author,
        text: input.text,
        ...(input.tags !== undefined ? { tags: [...input.tags].sort(compareStrings) } : {}),
        ...(input.replyToSeq !== undefined ? { replyToSeq: input.replyToSeq } : {}),
        ...(now.ms !== undefined ? { at: formatInstant(now.ms) } : {}),
      }),
    );
    if (!result.ok) return result.message;
    return json({
      topic: input.topic,
      seq: result.seq,
      author: input.author,
      bytes: result.bytes,
      ...(result.rebuiltSequence ? { rebuiltSequence: true } : {}),
    });
  },
});

export const blackboardRead: RegisteredTool = stateTool({
  name: "BlackboardRead",
  description:
    "Read a topic's posts, filtered by author, tag or sequence — or list the topics when you name none. Use `latestPerAuthor` to get each crew member's most recent word without wading through the whole thread.",
  inputSchema: z.object({
    topic: z.string().min(1).optional().describe("omit to list every topic"),
    author: z.string().min(1).optional(),
    tag: z.string().min(1).optional(),
    sinceSeq: z.number().int().min(0).optional().describe("exclusive: posts after this sequence"),
    latestPerAuthor: z.boolean().optional().describe("keep only each author's most recent post"),
    limit: z.number().int().positive().max(MAX_SCAN).optional().describe("default 50"),
    order: z.enum(["asc", "desc"]).optional().describe("default 'asc'"),
    stateDir: stateDirField,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const root = stateRoot("BlackboardRead", input.stateDir);
    if (input.topic === undefined) {
      const { streams, undecodable } = listLogs("BlackboardRead", root, BLACKBOARD_DIR);
      return json({
        count: streams.length,
        topics: streams.map((s) => ({ topic: s.name, lastSeq: s.lastSeq, bytes: s.bytes })),
        ...(undecodable.length > 0 ? { unreadableNames: undecodable } : {}),
      });
    }
    const badTopic = validateName("topic", input.topic);
    if (badTopic !== undefined) return badTopic;

    const log = readLog("BlackboardRead", root, BLACKBOARD_DIR, input.topic);
    if (!log.ok) return log.message;

    let records: ReadonlyArray<JsonlRecord> = log.records;
    if (input.tag !== undefined) {
      const wanted = input.tag;
      records = records.filter((record) => {
        const tags = record["tags"];
        return Array.isArray(tags) && tags.includes(wanted);
      });
    }
    if (input.latestPerAuthor === true) {
      const byAuthor = new Map<string, JsonlRecord>();
      for (const record of records) {
        const author = record["author"];
        if (typeof author === "string") byAuthor.set(author, record);
      }
      records = [...byAuthor.values()].sort(
        (a, b) => Number(a["seq"] ?? 0) - Number(b["seq"] ?? 0),
      );
    }
    const filtered = filterRecords(records, {
      ...(input.sinceSeq !== undefined ? { sinceSeq: input.sinceSeq } : {}),
      ...(input.author !== undefined ? { author: input.author } : {}),
      limit: input.limit ?? 50,
      order: input.order ?? "asc",
    });
    const authors = [
      ...new Set(
        log.records.map((r) => r["author"]).filter((a): a is string => typeof a === "string"),
      ),
    ].sort(compareStrings);

    return json({
      topic: input.topic,
      total: log.records.length,
      matched: filtered.matched,
      returned: filtered.selected.length,
      truncated: filtered.truncated,
      authors,
      posts: filtered.selected,
      ...(log.corrupt.length > 0 ? { corruptLines: log.corrupt } : {}),
    });
  },
});

// ---------------------------------------------------------------------------
// notes + lexical search
// ---------------------------------------------------------------------------

type NoteRecord = {
  id: string;
  title?: string;
  text: string;
  tags?: string[];
  version: number;
  updatedAt?: string;
};

function isNote(value: unknown): value is NoteRecord {
  return (
    isPlainObject(value) &&
    typeof value["id"] === "string" &&
    typeof value["text"] === "string" &&
    typeof value["version"] === "number"
  );
}

export const noteWrite: RegisteredTool = stateTool({
  name: "NoteWrite",
  description:
    "Write or overwrite a durable note under an id, with an optional title and tags. Use it to keep what the crew learned — a convention, a workaround, an answer worth not deriving twice — somewhere NoteSearch can find it again.",
  inputSchema: z.object({
    id: z.string().min(1).describe("note id; writing the same id again replaces the note"),
    text: z.string().min(1).max(MAX_VALUE_BYTES).describe("the note body"),
    title: z.string().max(200).optional(),
    tags: z.array(z.string().min(1).max(64)).max(32).optional(),
    ifAbsent: z.boolean().optional().describe("refuse to overwrite an existing note"),
    now: nowField,
    stateDir: stateDirField,
  }),
  destructive: true,
  execute: async (input) => {
    const badId = validateKey("id", input.id, 200);
    if (badId !== undefined) return badId;
    const now = parseNow(input.now);
    if (now.error !== undefined) return now.error;

    const root = stateRoot("NoteWrite", input.stateDir);
    const abs = statePath("NoteWrite", root, NOTE_DIR, `${encodeSegment(input.id)}.json`);
    const rel = relativeToRoot(root, abs);

    const locked = await withLock(`${abs}.lock`, () => {
      const outcome = readJsonFile(abs, MAX_VALUE_BYTES * 2);
      if (outcome.kind === "corrupt" && input.ifAbsent === true) {
        return corruptMessage(rel, outcome.reason);
      }
      const previous = outcome.kind === "ok" && isNote(outcome.value) ? outcome.value : undefined;
      if (previous !== undefined && input.ifAbsent === true) {
        return json({ written: false, exists: true, id: input.id, version: previous.version });
      }
      const record: NoteRecord = {
        id: input.id,
        ...(input.title !== undefined ? { title: input.title } : {}),
        text: input.text,
        ...(input.tags !== undefined ? { tags: [...input.tags].sort(compareStrings) } : {}),
        version: (previous?.version ?? 0) + 1,
        ...(now.ms !== undefined ? { updatedAt: formatInstant(now.ms) } : {}),
      };
      // The schema's `max` counts CHARACTERS; what has to fit is BYTES, and
      // the read cap is what the note must fit under or it comes back as
      // corrupt. A note of 4M astral characters is 16MB on disk — writing it
      // would produce a file this package could never read again.
      const tooLarge = sizeGuard("text", record);
      if (tooLarge !== undefined) return tooLarge;
      const bytes = writeJsonAtomic(abs, record);
      return json({
        written: true,
        id: input.id,
        version: record.version,
        replaced: previous !== undefined,
        bytes,
      });
    });
    return locked.ok ? locked.value : locked.reason;
  },
});

export const noteSearch: RegisteredTool = stateTool({
  name: "NoteSearch",
  description:
    "Search the stored notes with BM25 ranking over their titles, tags and text. Use it to recall what the crew already worked out; the matching is LEXICAL ONLY — no embeddings, no synonyms, no stemming — so a note about 'automobiles' will not answer a query about 'cars'.",
  inputSchema: z.object({
    query: z.string().min(1).describe("the words to look for"),
    tags: z
      .array(z.string().min(1))
      .max(16)
      .optional()
      .describe("only notes carrying all of these"),
    limit: z.number().int().positive().max(100).optional().describe("default 10"),
    snippetChars: z
      .number()
      .int()
      .min(0)
      .max(2000)
      .optional()
      .describe("default 240; 0 for no snippet"),
    minScore: z.number().min(0).optional(),
    k1: z
      .number()
      .min(0)
      .max(10)
      .optional()
      .describe(`BM25 term-frequency saturation (default ${DEFAULT_K1})`),
    b: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(`BM25 length normalisation (default ${DEFAULT_B})`),
    stateDir: stateDirField,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const root = stateRoot("NoteSearch", input.stateDir);
    const dir = statePath("NoteSearch", root, NOTE_DIR);
    const corrupt: Array<{ file: string; reason: string }> = [];
    const notes: NoteRecord[] = [];
    let scanned = 0;
    for (const file of listNames(dir, "file")) {
      if (!file.endsWith(".json")) continue;
      if (scanned >= MAX_SCAN) break;
      scanned += 1;
      const outcome = readJsonFile(
        statePath("NoteSearch", root, NOTE_DIR, file),
        MAX_VALUE_BYTES * 2,
      );
      if (outcome.kind === "missing") continue;
      if (outcome.kind === "corrupt" || !isNote(outcome.value)) {
        corrupt.push({
          file,
          reason: outcome.kind === "corrupt" ? outcome.reason : "not a note record",
        });
        continue;
      }
      notes.push(outcome.value);
    }
    const wantedTags = input.tags ?? [];
    const eligible = notes
      .filter((note) => wantedTags.every((tag) => (note.tags ?? []).includes(tag)))
      .sort((a, b) => compareStrings(a.id, b.id));

    const docs: IndexDoc[] = eligible.map((note) => ({
      id: note.id,
      text: [note.title ?? "", (note.tags ?? []).join(" "), note.text].join("\n"),
      ...(note.title !== undefined ? { title: note.title } : {}),
    }));
    const k1 = input.k1 ?? DEFAULT_K1;
    const b = input.b ?? DEFAULT_B;
    const result = searchIndex(buildIndex(docs), input.query, {
      k1,
      b,
      limit: input.limit ?? 10,
      ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
    });
    const byId = new Map(eligible.map((note) => [note.id, note]));
    const snippetChars = input.snippetChars ?? 240;

    return json({
      query: input.query,
      terms: result.terms,
      unknownTerms: result.unknownTerms,
      searched: eligible.length,
      matched: result.matched,
      parameters: { algorithm: "bm25", k1, b, lexicalOnly: true },
      hits: result.hits.map((hit) => {
        const note = byId.get(hit.id);
        const text = snippet(note?.text ?? "", result.terms, snippetChars);
        return {
          id: hit.id,
          score: hit.score,
          matchedTerms: hit.matchedTerms,
          ...(note?.title !== undefined ? { title: note.title } : {}),
          ...(note?.tags !== undefined ? { tags: note.tags } : {}),
          ...(note?.updatedAt !== undefined ? { updatedAt: note.updatedAt } : {}),
          ...(text !== undefined ? { snippet: text } : {}),
        };
      }),
      ...(corrupt.length > 0 ? { corrupt } : {}),
    });
  },
});

// ---------------------------------------------------------------------------
// file index
// ---------------------------------------------------------------------------

export const indexBuild: RegisteredTool = stateTool({
  name: "IndexBuild",
  description:
    "Build a named inverted index over a list of workspace text files, so they can be searched without a model reading them. Use it once per corpus and re-run it when the files change — the index is a snapshot and watches nothing; binary and over-large files are skipped and reported rather than mangled.",
  inputSchema: z.object({
    name: z.string().min(1).describe("index name, used later by IndexSearch"),
    paths: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_SCAN)
      .describe("workspace-relative file paths; pair with Glob or FindFiles to produce the list"),
    now: nowField,
    stateDir: stateDirField,
  }),
  destructive: true,
  execute: async (input) => {
    const badName = validateName("name", input.name);
    if (badName !== undefined) return badName;
    const now = parseNow(input.now);
    if (now.error !== undefined) return now.error;

    const docs: IndexDoc[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    let totalBytes = 0;
    const seen = new Set<string>();

    for (const given of [...input.paths].sort(compareStrings)) {
      let safe: SafePath;
      try {
        safe = resolveSafe("IndexBuild", given);
      } catch (err) {
        if (err instanceof ToolPermissionError) {
          skipped.push({ path: given, reason: "resolves outside the workspace" });
          continue;
        }
        throw err;
      }
      if (seen.has(safe.rel)) continue;
      seen.add(safe.rel);
      const outcome = readTextFile(safe.abs, MAX_INDEXED_FILE_BYTES);
      if (outcome.kind === "missing") {
        skipped.push({ path: safe.rel, reason: "no such file" });
        continue;
      }
      if (outcome.kind === "corrupt") {
        skipped.push({ path: safe.rel, reason: outcome.reason });
        continue;
      }
      if (totalBytes + outcome.stats.size > MAX_INDEXED_TOTAL_BYTES) {
        skipped.push({ path: safe.rel, reason: "would exceed the total index budget" });
        continue;
      }
      totalBytes += outcome.stats.size;
      docs.push({
        id: safe.rel,
        text: outcome.value,
        bytes: outcome.stats.size,
        mtimeMs: Math.round(outcome.stats.mtimeMs),
      });
    }

    const index = buildIndex(docs);
    const root = stateRoot("IndexBuild", input.stateDir);
    const abs = statePath("IndexBuild", root, INDEX_DIR, `${encodeSegment(input.name)}.json`);
    // Serialise first and check the size: `IndexSearch` reads with a cap, so
    // an index written over it would be built successfully and then be
    // unreadable forever. Better to refuse the build and say how to shrink it.
    const body = `${JSON.stringify({
      ...index,
      name: input.name,
      ...(now.ms !== undefined ? { builtAt: formatInstant(now.ms) } : {}),
    })}\n`;
    const buffer = Buffer.from(body, "utf8");
    if (buffer.byteLength > MAX_FILE_BYTES) {
      return `the index would be ${buffer.byteLength} bytes, over the ${MAX_FILE_BYTES} limit IndexSearch can read — build it over fewer or smaller files, or split it into several named indexes`;
    }
    const bytes = writeBuffer(abs, buffer);

    return json({
      name: input.name,
      documents: index.docs.length,
      terms: Object.keys(index.postings).length,
      totalTerms: index.totalTerms,
      bytesIndexed: totalBytes,
      indexBytes: bytes,
      ...(skipped.length > 0 ? { skipped } : {}),
    });
  },
});

export const indexSearch: RegisteredTool = stateTool({
  name: "IndexSearch",
  description:
    "Query an index built by IndexBuild and get the ranked files back, with optional snippets. Use it to narrow a large corpus to the two or three files worth reading; ranking is BM25 over literal terms, and a file whose size or mtime no longer matches the index is flagged stale rather than silently trusted.",
  inputSchema: z.object({
    name: z.string().min(1),
    query: z.string().min(1),
    limit: z.number().int().positive().max(100).optional().describe("default 10"),
    snippetChars: z
      .number()
      .int()
      .min(0)
      .max(2000)
      .optional()
      .describe("re-read each hit to quote a matching line; 0, the default, skips the re-read"),
    minScore: z.number().min(0).optional(),
    k1: z
      .number()
      .min(0)
      .max(10)
      .optional()
      .describe(`BM25 term-frequency saturation (default ${DEFAULT_K1})`),
    b: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(`BM25 length normalisation (default ${DEFAULT_B})`),
    stateDir: stateDirField,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const badName = validateName("name", input.name);
    if (badName !== undefined) return badName;
    const root = stateRoot("IndexSearch", input.stateDir);
    const abs = statePath("IndexSearch", root, INDEX_DIR, `${encodeSegment(input.name)}.json`);
    const rel = relativeToRoot(root, abs);
    const outcome = readJsonFile(abs);
    if (outcome.kind === "missing") {
      return `no index named "${input.name}" — build one with IndexBuild first`;
    }
    if (outcome.kind === "corrupt") return corruptMessage(rel, outcome.reason);
    if (!isInvertedIndex(outcome.value)) return corruptMessage(rel, "not an inverted index");
    const index: InvertedIndex = outcome.value;
    const k1 = input.k1 ?? DEFAULT_K1;
    const b = input.b ?? DEFAULT_B;
    const result = searchIndex(index, input.query, {
      k1,
      b,
      limit: input.limit ?? 10,
      ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
    });
    const snippetChars = input.snippetChars ?? 0;

    const hits = result.hits.map((hit) => {
      let state: "current" | "changed" | "missing" = "current";
      let text: string | undefined;
      try {
        const safe = resolveSafe("IndexSearch", hit.id);
        const stats = statSync(safe.abs);
        const sizeChanged = hit.entry.bytes !== undefined && hit.entry.bytes !== stats.size;
        const timeChanged =
          hit.entry.mtimeMs !== undefined && hit.entry.mtimeMs !== Math.round(stats.mtimeMs);
        if (sizeChanged || timeChanged) state = "changed";
        if (snippetChars > 0) {
          const read = readTextFile(safe.abs, MAX_INDEXED_FILE_BYTES);
          if (read.kind === "ok") text = snippet(read.value, result.terms, snippetChars);
        }
      } catch {
        // The file has been moved, deleted or put outside the workspace since
        // the index was built; the hit still ranks, but say it cannot be read.
        state = "missing";
      }
      return {
        path: hit.id,
        score: hit.score,
        matchedTerms: hit.matchedTerms,
        file: state,
        ...(text !== undefined ? { snippet: text } : {}),
      };
    });

    return json({
      name: input.name,
      query: input.query,
      terms: result.terms,
      unknownTerms: result.unknownTerms,
      documents: index.docs.length,
      matched: result.matched,
      parameters: { algorithm: "bm25", k1, b, lexicalOnly: true },
      hits,
      stale: hits.filter((hit) => hit.file !== "current").map((hit) => hit.path),
    });
  },
});

// ---------------------------------------------------------------------------
// export / import
// ---------------------------------------------------------------------------

/**
 * Why `StateImport` in `replace` mode may not empty this directory.
 *
 * `replace` is a recursive delete of a caller-named directory, and `stateDir`
 * is a caller-named directory anywhere in the workspace — so `stateDir: "."`
 * would have deleted the workspace, source tree and all, and `stateDir: "src"`
 * the source. A directory may be emptied only when it still looks like one of
 * ours: absent, empty, or holding nothing but the eight folders this package
 * creates. Anything else — a foreign folder, a loose file this package never
 * writes at the top level — is the signal that it is somebody's working
 * directory, and the import is refused rather than allowed to delete it.
 */
function replaceRefusal(root: SafePath): string | undefined {
  if (root.abs === workspaceRoot()) {
    return "StateImport will not replace the workspace root — point `stateDir` at a state directory (the default is '.crewhaus/state')";
  }
  let entries: string[];
  try {
    entries = readdirSync(root.abs, { withFileTypes: true })
      .filter((entry) => !(entry.isDirectory() && STATE_DIRS.has(entry.name)))
      .map((entry) => entry.name);
  } catch (err) {
    if (errorCode(err) === "ENOENT" || errorCode(err) === "ENOTDIR") return undefined;
    throw err;
  }
  if (entries.length === 0) return undefined;
  const foreign = entries.sort(compareStrings);
  return `StateImport will not replace "${root.rel}": it holds ${foreign.length} entr${foreign.length === 1 ? "y" : "ies"} this package did not put there (${foreign.slice(0, 5).join(", ")}), and replacing means deleting them — use mode 'merge', or point \`stateDir\` at a real state directory`;
}

export const stateExport: RegisteredTool = stateTool({
  name: "StateExport",
  description:
    "Dump the whole state directory as one JSON document, with a digest per file. Use it to back state up, move it to another machine, or attach it to a bug report; text files are carried as text and anything else as base64, and symlinks are skipped rather than followed.",
  inputSchema: z.object({
    prefix: z
      .string()
      .optional()
      .describe("only entries whose path inside the state directory starts with this, e.g. 'kv/'"),
    includeContent: z.boolean().optional().describe("include file bodies (default true)"),
    stateDir: stateDirField,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const root = stateRoot("StateExport", input.stateDir);
    const { files, truncated } = walkFiles(root.abs, MAX_EXPORT_FILES);
    const selected = files.filter(
      (file) => input.prefix === undefined || file.path.startsWith(input.prefix),
    );
    const totalBytes = selected.reduce((sum, file) => sum + file.bytes, 0);
    if (totalBytes > MAX_EXPORT_BYTES) {
      return `the state directory holds ${totalBytes} bytes, over the ${MAX_EXPORT_BYTES} export limit — narrow it with \`prefix\`, or copy the directory with the filesystem tools instead`;
    }

    const entries: Array<Record<string, unknown>> = [];
    // Listed apart from `files`, never inside it: an entry with no content
    // would fail StateImport's schema and make the whole document unusable.
    const unreadable: Array<{ path: string; reason: string }> = [];
    for (const file of selected) {
      const text = readTextFile(file.abs, MAX_EXPORT_BYTES);
      if (text.kind === "ok") {
        entries.push({
          path: file.path,
          encoding: "utf8",
          bytes: file.bytes,
          sha256: sha256(text.value),
          ...(input.includeContent === false ? {} : { content: text.value }),
        });
        continue;
      }
      // Binary, or unreadable as text: carry the bytes verbatim instead.
      const raw = readBytes(file.abs, MAX_EXPORT_BYTES);
      if (raw === undefined) {
        unreadable.push({
          path: file.path,
          reason: text.kind === "corrupt" ? text.reason : "could not be read as bytes",
        });
        continue;
      }
      entries.push({
        path: file.path,
        encoding: "base64",
        bytes: file.bytes,
        sha256: sha256(raw),
        ...(input.includeContent === false ? {} : { content: raw.toString("base64") }),
      });
    }

    return json({
      version: 1,
      stateDir: root.rel,
      fileCount: entries.length,
      totalBytes,
      truncated,
      files: entries,
      ...(unreadable.length > 0 ? { unreadable } : {}),
    });
  },
});

export const stateImport: RegisteredTool = stateTool({
  name: "StateImport",
  description:
    "Restore a state directory from a StateExport document, merging into what is there or replacing it. Use it to seed a fresh workspace or roll state back; `dryRun` reports exactly what would be written first, every entry path is checked for escapes before anything is created, and 'replace' refuses any directory holding anything this package did not put there, so it can never be pointed at a source tree.",
  inputSchema: z.object({
    document: z
      .object({
        version: z.literal(1),
        files: z
          .array(
            z.object({
              path: z.string().min(1),
              encoding: z.enum(["utf8", "base64"]),
              content: z.string(),
            }),
          )
          .max(MAX_EXPORT_FILES),
      })
      .describe("a document produced by StateExport, with contents included"),
    mode: z
      .enum(["merge", "replace"])
      .optional()
      .describe(
        "'merge' (default) overwrites the named files and leaves the rest; 'replace' empties the state directory first",
      ),
    dryRun: z.boolean().optional().describe("report what would happen and write nothing"),
    stateDir: stateDirField,
  }),
  destructive: true,
  execute: async (input) => {
    const root = stateRoot("StateImport", input.stateDir);
    const mode = input.mode ?? "merge";
    const dryRun = input.dryRun === true;

    // Validate every path BEFORE writing anything, so a document with one bad
    // entry cannot leave the state directory half-replaced.
    const planned: Array<{ path: string; target: string; body: Buffer }> = [];
    const refused: Array<{ path: string; reason: string }> = [];
    let plannedBytes = 0;
    for (const file of input.document.files) {
      if (entryNameEscapes(file.path)) {
        refused.push({ path: file.path, reason: "path segment would escape the state directory" });
        continue;
      }
      const segments = file.path.split("/");
      let target: string;
      try {
        target = statePath("StateImport", root, ...segments);
      } catch (err) {
        if (err instanceof ToolPermissionError) {
          refused.push({ path: file.path, reason: "resolves outside the state directory" });
          continue;
        }
        throw err;
      }
      const body =
        file.encoding === "utf8"
          ? Buffer.from(file.content, "utf8")
          : Buffer.from(file.content, "base64");
      if (plannedBytes + body.byteLength > MAX_EXPORT_BYTES) {
        refused.push({
          path: file.path,
          reason: `would take the import over the ${MAX_EXPORT_BYTES} byte limit`,
        });
        continue;
      }
      plannedBytes += body.byteLength;
      planned.push({ path: file.path, target, body });
    }
    planned.sort((a, b) => compareStrings(a.path, b.path));

    const refusedReplace = mode === "replace" ? replaceRefusal(root) : undefined;
    if (refusedReplace !== undefined) return refusedReplace;

    let written = 0;
    if (!dryRun) {
      // `replace` empties the directory rather than removing it, so a state
      // directory that is itself a mount point or the process's cwd survives.
      if (mode === "replace") {
        for (const name of listNames(root.abs, "dir")) removeTree(path.join(root.abs, name));
        for (const name of listNames(root.abs, "file")) removeFile(path.join(root.abs, name));
      }
      for (const file of planned) {
        writeBuffer(file.target, file.body);
        written += 1;
      }
    }

    return json({
      stateDir: root.rel,
      mode,
      dryRun,
      planned: planned.length,
      written,
      totalBytes: planned.reduce((sum, file) => sum + file.body.byteLength, 0),
      files: planned.map((file) => file.path),
      ...(refused.length > 0 ? { refused } : {}),
    });
  },
});

// ---------------------------------------------------------------------------
// idempotency
// ---------------------------------------------------------------------------

export const dedupeMark: RegisteredTool = stateTool({
  name: "DedupeMark",
  description:
    "Record that an external id has been handled, and say whether it had been seen before. Use it as the guard in front of anything that must not happen twice — sending a mail, charging a card, filing a ticket — because a retried run marks the same id and gets `alreadySeen: true` instead of doing it again.",
  inputSchema: z.object({
    scope: z.string().min(1).describe("what is being de-duplicated, e.g. 'emails' or 'webhook'"),
    id: z.string().min(1).max(MAX_KEY_LENGTH).describe("the external id, e.g. a message id"),
    note: z.string().max(500).optional().describe("a short note stored with the first sighting"),
    peek: z.boolean().optional().describe("only report whether the id is known; mark nothing"),
    now: nowField,
    stateDir: stateDirField,
  }),
  destructive: true,
  execute: async (input) => {
    const badScope = validateName("scope", input.scope);
    if (badScope !== undefined) return badScope;
    const badId = validateKey("id", input.id);
    if (badId !== undefined) return badId;
    const now = parseNow(input.now);
    if (now.error !== undefined) return now.error;

    const root = stateRoot("DedupeMark", input.stateDir);
    const abs = statePath(
      "DedupeMark",
      root,
      DEDUPE_DIR,
      encodeSegment(input.scope),
      `${encodeSegment(input.id)}.json`,
    );
    const rel = relativeToRoot(root, abs);

    if (input.peek === true) {
      const existing = readJsonFile(abs, SMALL_FILE_BYTES);
      if (existing.kind === "corrupt") return corruptMessage(rel, existing.reason);
      return json({
        scope: input.scope,
        id: input.id,
        alreadySeen: existing.kind === "ok",
        marked: false,
        ...(existing.kind === "ok" && isPlainObject(existing.value)
          ? { firstSeen: existing.value }
          : {}),
      });
    }

    // The exclusive create IS the de-duplication: exactly one caller can win,
    // with no lock and no read-then-write window for a retry to slip through.
    const record = {
      scope: input.scope,
      id: input.id,
      ...(now.ms !== undefined ? { at: formatInstant(now.ms) } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    };
    if (createExclusive(abs, `${JSON.stringify(record)}\n`)) {
      return json({ scope: input.scope, id: input.id, alreadySeen: false, marked: true });
    }
    const existing = readJsonFile(abs, SMALL_FILE_BYTES);
    if (existing.kind === "corrupt") return corruptMessage(rel, existing.reason);
    return json({
      scope: input.scope,
      id: input.id,
      alreadySeen: true,
      marked: false,
      ...(existing.kind === "ok" && isPlainObject(existing.value)
        ? { firstSeen: existing.value }
        : {}),
    });
  },
});

/** Every tool this package registers, in the order a catalog should list them. */
export const STATE_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  blackboardPost,
  blackboardRead,
  checkpointList,
  checkpointLoad,
  checkpointSave,
  counterGet,
  counterIncrement,
  dedupeMark,
  indexBuild,
  indexSearch,
  journalAppend,
  journalRead,
  kvDelete,
  kvGet,
  kvList,
  kvSet,
  noteSearch,
  noteWrite,
  stateExport,
  stateImport,
]);

export { ToolPermissionError } from "./paths";
export { DEFAULT_STATE_DIR } from "./store";
