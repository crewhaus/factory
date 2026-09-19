/**
 * Writing ONE line back onto the bus every other local tool here reads.
 *
 * `EventQuery` and `RunTimeline` read `.crewhaus/sessions/<id>.jsonl`; this is
 * the only thing in the package that writes to it, so the line it produces has
 * to be the same line `@crewhaus/event-log` produces — `{ ts, version: 1, kind,
 * payload }`, one JSON object, one `\n`. A second shape is a line the readers
 * would parse and the renderers would not understand.
 *
 * Everything here is pure: the caller's values in, one serialised line out or a
 * readable refusal. `../index.ts` does the contained, append-only I/O.
 *
 * The whole of this module exists because of one fact: **the text on this line
 * did not come from the runtime.** It came through a tool call, which means it
 * can carry whatever a model was talked into emitting, and it lands in a file a
 * human reads during an incident and a model re-reads on the next turn. Three
 * rules follow, and each is enforced here rather than left to the caller.
 *
 *   1. **Provenance is structural, not advisory.** The kind is
 *      `custom.<name>` — a namespace no runtime kind can occupy, because every
 *      kind in `@crewhaus/event-log`'s union is bare `[a-z_]+` with no dot. A
 *      caller cannot write `run_failed`, or anything else the runtime writes,
 *      at any nesting of quoting or escaping, because it never supplies the
 *      kind: it supplies the `<name>` and this module supplies the namespace.
 *   2. **Caller text never occupies a field a reader trusts.** Free-form
 *      fields go under `fields`, one level down, and the envelope's own keys
 *      are written by this module. That is not tidiness: `buildTimeline` sums
 *      `payload.durationMs` for EVERY kind, `IncidentBundle` takes the FIRST
 *      `payload.specName` it finds in log order, and both are kind-agnostic
 *      scans. A caller-supplied `durationMs` spread at the top level would
 *      enter a total the README promises comes only from the runtime's own
 *      measurements, and a caller-supplied `specName` would retitle somebody
 *      else's incident bundle. Nesting is what makes those two unreachable.
 *   3. **The bytes are bounded and inert.** A cap on the name, the message,
 *      the field count, each field, and the finished line — plus a refusal of
 *      every character that could make one line look like two, execute in a
 *      terminal, or read differently to a human than it was written.
 *
 * The envelope is ordered provenance-first and free text last on purpose:
 * `renderEvent` truncates a payload from the TAIL, so a reader working to a
 * small payload budget keeps the marker saying who wrote this and loses the
 * attacker's prose, rather than the other way round.
 */
import { Buffer } from "node:buffer";
import { asString, byString } from "./events";

/**
 * The namespace every kind this tool writes lives in.
 *
 * Dotted, because no `EventKind` in `@crewhaus/event-log` contains a dot —
 * that is what makes "did a tool write this?" answerable from the kind alone,
 * by a reader that has never heard of this package and by a `grep`.
 */
export const EMITTED_KIND_PREFIX = "custom.";

/** Stamped into every payload, so provenance survives being read kind-blind. */
export const EMITTED_BY = "EmitTraceEvent";

/** `custom.<name>`: lower snake case, the shape every runtime kind already has. */
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
/**
 * A field name the sibling readers can actually address.
 *
 * No dot, deliberately: `EventQuery`'s `where.path` is a DOTTED path, so a
 * field written as `a.b` is one `{ path: "fields.a.b", op: "exists" }` reports
 * as MISSING and `op: "missing"` reports as present — a confidently wrong
 * answer about a field this tool itself accepted. Refusing the character here
 * is what keeps every field this writes queryable by the readers it was
 * written for.
 */
const FIELD_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

export const MAX_NAME_CHARS = 60;
export const MAX_MESSAGE_CHARS = 2000;
export const MAX_FIELDS = 24;
export const MAX_FIELD_KEY_CHARS = 60;
export const MAX_FIELD_VALUE_CHARS = 400;
/**
 * Cap on a caller-supplied `runId`.
 *
 * The runtime's own ids are `run_<hex>`; nothing legitimate is near this. The
 * cap exists because without one the only bound on a claimed id is the line
 * cap, which would let a caller spend the whole 4 KiB of an event on a field
 * every reader groups by.
 */
export const MAX_RUN_ID_CHARS = 200;

/**
 * Cap on the finished line, INCLUDING the newline.
 *
 * `@crewhaus/event-log` appends with one `appendFileSync` and documents that a
 * short enough write lands atomically, which is what keeps two processes
 * appending to one session log from interleaving half-lines. A tool that let a
 * caller write a 200 KB line would be the one write on the bus that broke
 * that. 4 KiB is also simply as much as anyone wants on a line they are going
 * to read in a terminal.
 */
export const MAX_EVENT_BYTES = 4096;

export type EmitLevel = "info" | "warn" | "error";

/** What the live run — if there is one — says about who is emitting. */
export type AmbientContext = {
  readonly runId?: string;
  readonly sessionId?: string;
  readonly turnNumber?: number;
};

export type EmitRequest = {
  readonly name: string;
  readonly message?: string;
  readonly level?: EmitLevel;
  readonly fields?: Readonly<Record<string, unknown>>;
  /** Epoch ms. Supplied, never read from a clock — see the package README. */
  readonly tsMs?: number;
  /** The run the CALLER says this belongs to. Loses to the ambient one. */
  readonly runId?: string;
  /** The session log this line is being appended to. */
  readonly targetSessionId: string;
  /** Absent when the tool was called outside a live run, or when a run
   * context was attached but nothing usable could be read off it. */
  readonly ambient?: AmbientContext;
  /**
   * True when a run context was attached to the call at all, whatever came off
   * it. `ambient === undefined` with this set is the `unusable` case.
   */
  readonly contextAttached?: boolean;
};

/**
 * What the call could learn from a live run, as three answers rather than two.
 *
 * `unusable` is the one that has to exist: the run context is read
 * STRUCTURALLY (see `ambientFrom`), so a runtime that renamed its fields hands
 * this module an object it can extract nothing from. Reporting that as
 * `present` would claim a provenance nothing supplied, and reporting it as
 * `absent` would hide a carrier that was really there — the drift would be
 * invisible either way.
 */
export type RunContextState = "present" | "unusable" | "absent";

export type BuiltEvent = {
  readonly kind: string;
  readonly ts?: number;
  /** What the run context on the call turned out to be worth. */
  readonly runContext: RunContextState;
  /** The run this line was finally attributed to, and where that came from. */
  readonly runId?: string;
  readonly runIdSource?: "context" | "caller";
  /** The exact bytes to append, newline included. */
  readonly line: string;
  readonly bytes: number;
  readonly payload: Record<string, unknown>;
};

export type BuildResult =
  | { readonly ok: true; readonly value: BuiltEvent }
  | { readonly ok: false; readonly message: string };

// ---------------------------------------------------------------------------
// characters that must not reach the line
// ---------------------------------------------------------------------------

export type ForbiddenChar = {
  readonly index: number;
  readonly code: number;
  /** Why this one is refused, in the refusal's own words. */
  readonly reason: string;
};

/**
 * Why a code point cannot appear in text that lands on a log line, or
 * `undefined` when it may.
 *
 * `JSON.stringify` would escape most of these rather than emit them raw, so
 * the JSONL itself would survive — that is not the risk being managed. The
 * risk is what happens AFTER a reader parses the line and prints the string:
 * a `\n` becomes a second log entry that the runtime never wrote, an ESC (U+001B)
 * becomes a control sequence the terminal obeys, and a bidi override makes the
 * rendered order of a sentence differ from its bytes. All three are ways for
 * text a tool call supplied to impersonate the record around it, which is the
 * one thing this tool must not allow.
 */
function forbiddenReason(code: number): string | undefined {
  if (code === 0x0a || code === 0x0d) {
    return "a line break, and one event is one line — it would read as a second entry nobody wrote";
  }
  if (code === 0x09) {
    return "a tab, which a reader renders as column structure this line does not have";
  }
  if (code === 0x1b) {
    return "an escape, which a terminal showing this log would obey as a control sequence";
  }
  if (code <= 0x1f) return "a C0 control character";
  if (code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
    return "a delete or C1 control character";
  }
  if (code === 0x2028 || code === 0x2029) {
    return "a Unicode line separator, which some readers split lines on";
  }
  if (
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  ) {
    return "a bidirectional control, which reorders what a human sees away from what was written";
  }
  if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0x2060 || code === 0xfeff) {
    return "a zero-width character, which is text a reviewer cannot see";
  }
  return undefined;
}

/**
 * The first character that may not appear, or `undefined`.
 *
 * A scan rather than a regex, for two reasons: the refusal has to NAME the
 * character and say where it is (a bare "invalid input" teaches nothing about
 * a byte you cannot see), and a regex literal holding control characters is
 * its own well-known hazard in this repo. Surrogate halves are read as
 * themselves and match nothing here, so astral characters pass through intact.
 */
export function findForbidden(text: string): ForbiddenChar | undefined {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    const reason = forbiddenReason(code);
    if (reason !== undefined) return { index, code, reason };
  }
  return undefined;
}

/** `U+001B`, for a refusal about a character that cannot be printed in one. */
export function codePointLabel(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * The refusal for one forbidden character, naming it and where it is.
 *
 * Exported because the SAME rule has to hold for the caller strings that never
 * reach the line but do reach a filename and the result — `../index.ts` gates
 * `sessionId` and the sessions path with it. A second spelling of this rule
 * over there is a rule that drifts.
 */
export function refuseForbidden(where: string, found: ForbiddenChar): string {
  return `${where} contains ${codePointLabel(found.code)} at index ${found.index} — ${found.reason}`;
}

// ---------------------------------------------------------------------------
// building the line
// ---------------------------------------------------------------------------

type Fields = { readonly ok: true; readonly value?: Record<string, unknown> } | BuildFailure;
type BuildFailure = { readonly ok: false; readonly message: string };

/**
 * Validate and normalise the caller's `fields`.
 *
 * Scalars only, and no nesting: an object value is unbounded in depth and
 * width and would turn a per-field cap into no cap at all. Keys are sorted so
 * the same call twice produces the same bytes — `JSON.stringify` preserves
 * insertion order, so unsorted keys would make the line depend on how the
 * caller happened to spell the object.
 */
function normaliseFields(fields: Readonly<Record<string, unknown>> | undefined): Fields {
  if (fields === undefined) return { ok: true };
  const keys = Object.keys(fields);
  if (keys.length === 0) return { ok: true };
  if (keys.length > MAX_FIELDS) {
    return { ok: false, message: `fields has ${keys.length} entries, over the ${MAX_FIELDS} cap` };
  }
  const out: Record<string, unknown> = {};
  for (const key of [...keys].sort(byString)) {
    if (key.length > MAX_FIELD_KEY_CHARS) {
      return {
        ok: false,
        message: `field name "${key.slice(0, 40)}…" is ${key.length} characters, over the ${MAX_FIELD_KEY_CHARS} cap`,
      };
    }
    if (!FIELD_KEY_PATTERN.test(key)) {
      return {
        ok: false,
        message: `field name "${key}" is not usable — use letters, digits, "_" and "-" starting with a letter, because a "." in a name is a path separator to EventQuery's where.path`,
      };
    }
    const value = fields[key];
    if (typeof value === "string") {
      if (value.length > MAX_FIELD_VALUE_CHARS) {
        return {
          ok: false,
          message: `field "${key}" is ${value.length} characters, over the ${MAX_FIELD_VALUE_CHARS} cap — put the long form somewhere a log line is not`,
        };
      }
      const found = findForbidden(value);
      if (found !== undefined)
        return { ok: false, message: refuseForbidden(`field "${key}"`, found) };
      out[key] = value;
      continue;
    }
    if (typeof value === "number") {
      // `z.number()` admits Infinity, and `JSON.stringify` turns it into
      // `null` — a number that silently becomes a different value on the way
      // to disk is worse than a refusal.
      if (!Number.isFinite(value)) {
        return { ok: false, message: `field "${key}" is not a finite number` };
      }
      out[key] = value;
      continue;
    }
    if (typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    return {
      ok: false,
      message: `field "${key}" must be a string, a finite number or a boolean — an object or array on a log line has no bound`,
    };
  }
  return { ok: true, value: out };
}

/**
 * Build the one line to append, or say why it cannot be built.
 *
 * Attribution, in order: the ambient run context wins, because it is the one
 * fact here the caller did not supply. A caller-supplied `runId` is used only
 * when there is no run context to contradict it, and when it is contradicted
 * it is kept verbatim as `claimedRunId` rather than dropped — a reader tracing
 * a mis-attributed event wants to see what was claimed, not an absence.
 */
export function buildEmittedEvent(request: EmitRequest): BuildResult {
  const name = request.name;
  if (name.length > MAX_NAME_CHARS) {
    return {
      ok: false,
      message: `name is ${name.length} characters, over the ${MAX_NAME_CHARS} cap`,
    };
  }
  if (!NAME_PATTERN.test(name)) {
    return {
      ok: false,
      message: `"${name.slice(0, 60)}" is not a usable event name — lower snake case, starting with a letter (e.g. "deploy_started"), which is the shape every runtime kind already has`,
    };
  }

  const message = request.message;
  if (message !== undefined) {
    if (message.length > MAX_MESSAGE_CHARS) {
      return {
        ok: false,
        message: `message is ${message.length} characters, over the ${MAX_MESSAGE_CHARS} cap — a trace event is a marker, not a transcript`,
      };
    }
    const found = findForbidden(message);
    if (found !== undefined) return { ok: false, message: refuseForbidden("message", found) };
  }

  // A claimed run id is caller text like any other, and it lands in the field
  // every reader here groups and filters by. Without this check the module
  // would refuse a bidi override in `message` and write the same character
  // into `runId` on the same line — `EventQuery` renders the payload as JSON,
  // and JSON escapes control characters but NOT U+202E or U+200B, so those
  // reach a human's terminal exactly as written.
  const claimedRunId = asString(request.runId);
  if (claimedRunId !== undefined) {
    if (claimedRunId.length > MAX_RUN_ID_CHARS) {
      return {
        ok: false,
        message: `runId is ${claimedRunId.length} characters, over the ${MAX_RUN_ID_CHARS} cap`,
      };
    }
    const found = findForbidden(claimedRunId);
    if (found !== undefined) return { ok: false, message: refuseForbidden("runId", found) };
  }

  const fields = normaliseFields(request.fields);
  if (!fields.ok) return fields;

  const level: EmitLevel = request.level ?? "info";
  const ambient = request.ambient;
  const runContext: RunContextState =
    ambient !== undefined ? "present" : request.contextAttached === true ? "unusable" : "absent";
  // `asString` rather than a truthiness test: an empty string is not an
  // attribution. Reported as one it would say `runIdSource: "caller"` for an
  // id `runIdOf` reads back as ABSENT, so every reader that filters by run
  // would disagree with the result that wrote it.
  const contextRunId = asString(ambient?.runId);
  const runId = contextRunId ?? claimedRunId;
  const runIdSource =
    contextRunId !== undefined ? "context" : claimedRunId !== undefined ? "caller" : undefined;
  const crossSession =
    ambient?.sessionId !== undefined && ambient.sessionId !== request.targetSessionId;

  const emittedFrom: Record<string, unknown> = {
    runContext,
    ...(ambient?.sessionId !== undefined ? { sessionId: ambient.sessionId } : {}),
    ...(contextRunId !== undefined ? { runId: contextRunId } : {}),
    ...(ambient?.turnNumber !== undefined ? { turnNumber: ambient.turnNumber } : {}),
    // A line written into a session log by a run whose OWN log is a different
    // file is the case a reader must not have to infer.
    ...(crossSession ? { crossSession: true } : {}),
    ...(claimedRunId !== undefined && claimedRunId !== runId ? { claimedRunId } : {}),
  };

  const payload: Record<string, unknown> = {
    // First key on the line: a reader that sees only the start of a truncated
    // payload still sees who wrote it.
    emittedBy: EMITTED_BY,
    name,
    level,
    ...(runId !== undefined ? { runId } : {}),
    ...(runIdSource !== undefined ? { runIdSource } : {}),
    // `buildTimeline` reads `isError` on every kind; setting it from the
    // caller's own level is honest because the kind still says `custom.`.
    // `durationMs` is deliberately NOT offered: that total is the runtime's
    // measurement and nothing here may add to it.
    ...(level === "error" ? { isError: true } : {}),
    emittedFrom,
    ...(message !== undefined ? { message } : {}),
    ...(fields.value !== undefined ? { fields: fields.value } : {}),
  };

  const kind = `${EMITTED_KIND_PREFIX}${name}`;
  // The wire shape, key for key, as `@crewhaus/event-log` writes it. A line
  // with no `ts` is the honest record of a caller who supplied no time: the
  // readers already keep an untimestamped event in log order and give it no
  // gap, which is a better answer than a timestamp this tool invented.
  const event = {
    ...(request.tsMs !== undefined ? { ts: request.tsMs } : {}),
    version: 1,
    kind,
    payload,
  };
  const line = `${JSON.stringify(event)}\n`;
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > MAX_EVENT_BYTES) {
    return {
      ok: false,
      message: `the event would be ${bytes} bytes, over the ${MAX_EVENT_BYTES} limit for one line — shorten message or drop fields`,
    };
  }

  return {
    ok: true,
    value: {
      kind,
      runContext,
      ...(request.tsMs !== undefined ? { ts: request.tsMs } : {}),
      ...(runId !== undefined ? { runId } : {}),
      ...(runIdSource !== undefined ? { runIdSource } : {}),
      line,
      bytes,
      payload,
    },
  };
}
