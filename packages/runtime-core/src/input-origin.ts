/**
 * `CREWHAUS_INPUT_ORIGIN=api`: a one-shot job the control API starts has its
 * input checked where it enters the run, at TrustOrigin "api".
 *
 * The job's input arrives as the seed messages of the process's first
 * top-level loop. Under the variable, that loop classifies the text of every
 * seed message, whatever its role, with `classifyBoundary`, each on its own
 * and, when there are several, joined (an injection split across two of them),
 * before its first model call. A message's text is its string, or every text its
 * blocks carry: each string field of a block other than its kind, ids, media
 * type, cache hints and signature (a text block's text, a document's title,
 * context and text source, a tool result's content, a thinking block's text),
 * with nested blocks and objects read the same way, and any block's input as
 * JSON. A message with no text adds
 * nothing. A block whose content cannot be read as text (a `source` that is
 * not a text source, such as base64 or a URL, or a `data` field outside a text
 * source) refuses the seed with the rule `unreadable_seed_block`, as a
 * malicious verdict does.
 *  - a malicious verdict tags nothing, and the loop throws a `RunFailedError`
 *    of class `input_blocked` (exit 41) right after its run rows open, so the
 *    rows record `failed {input_blocked}` and the job's process exits 41;
 *  - a kept seed is tagged at "api" into the run's context, which starts its
 *    `originStack` with "api"; a suspicious one publishes one warned
 *    `permission_decision` event (`withInboundContent`, run-context). A
 *    context the caller supplied is never replaced: it is tagged through
 *    `adoptInbound` and keeps its own `originStack`.
 *
 * Only the first top-level loop in the process: a later one, a loop whose
 * context names a `parent` (a sub-agent's, a consult side call's) and a
 * resumed history are never classified or relabelled. Unset, nothing
 * happens; any other value logs one warning naming the variable and nothing
 * else.
 */
import {
  type BoundaryResult,
  boundaryRuleIds,
  classifyBoundary,
} from "@crewhaus/boundary-classifier";
import { EXIT_CODES, RunFailedError } from "@crewhaus/errors";
import {
  type InboundContent,
  type RunContext,
  adoptInbound,
  withInboundContent,
} from "@crewhaus/run-context";

/** The variable a job's launcher sets, and the one value it takes. */
export const INPUT_ORIGIN_ENV = "CREWHAUS_INPUT_ORIGIN";
export const INPUT_ORIGIN_API = "api";

/** What the seed check decided for one loop. */
export type SeedVerdict =
  | { readonly kind: "none" }
  | { readonly kind: "kept"; readonly entries: readonly InboundContent[] }
  | { readonly kind: "blocked"; readonly rules: readonly string[]; readonly score: number };

const NONE: SeedVerdict = Object.freeze({ kind: "none" });

type Classify = (text: string, opts: { readonly origin: "api" }) => Promise<BoundaryResult>;

let firstLoopTaken = false;
let otherValueWarned = false;
let classify: Classify = classifyBoundary;

/** A message the seed check reads: its role and its content, a string or blocks. */
type SeedMessage = { readonly role: string; readonly content: unknown };

/** How deep blocks nest before the rest is read as JSON. */
const MAX_BLOCK_DEPTH = 8;

/** JSON of a value, or `""` when it has none. */
function jsonOf(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** What a message's content carries: its texts, and whether any block could not be read. */
type Read = { readonly texts: string[]; unreadable: boolean };

/**
 * A block's keys that never carry text: its kind, its ids, a media type, cache
 * hints and a signature. Every other key is read.
 */
const NON_TEXT_KEYS: ReadonlySet<string> = new Set([
  "type",
  "id",
  "tool_use_id",
  "name",
  "media_type",
  "cache_control",
  "signature",
]);

/** The text a block's `source` carries, or `undefined` when it is not a text source. */
function sourceText(source: unknown): string | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const { type, data } = source as { type?: unknown; data?: unknown };
  return type === "text" && typeof data === "string" ? data : undefined;
}

/**
 * Every text a message's content carries, in order, the empty ones left out: a
 * string itself, and in a block every string field other than {@link NON_TEXT_KEYS},
 * nested blocks and objects read the same way, and any block's `input` as JSON. A `source`
 * is read only as a text source; any other `source`, and a `data` field outside
 * one, marks the content unreadable.
 */
function textsOf(content: unknown, depth = 0, out: Read = { texts: [], unreadable: false }): Read {
  if (typeof content === "string") {
    if (content !== "") out.texts.push(content);
    return out;
  }
  if (content === null || content === undefined) return out;
  if (typeof content !== "object") return out;
  if (depth >= MAX_BLOCK_DEPTH) {
    const json = jsonOf(content);
    if (json !== "") out.texts.push(json);
    return out;
  }
  if (Array.isArray(content)) {
    for (const block of content) textsOf(block, depth + 1, out);
    return out;
  }
  for (const [key, value] of Object.entries(content as Record<string, unknown>)) {
    if (key === "source") {
      const text = sourceText(value);
      if (text === undefined) out.unreadable = true;
      else if (text !== "") out.texts.push(text);
      continue;
    }
    if (key === "data") {
      out.unreadable = true;
      continue;
    }
    if (NON_TEXT_KEYS.has(key)) continue;
    if (key === "input" && typeof value === "object" && value !== null) {
      // A call's input is read whole, its keys too.
      const json = jsonOf(value);
      if (json !== "" && json !== "{}") out.texts.push(json);
      continue;
    }
    textsOf(value, depth + 1, out);
  }
  return out;
}

/** The rule a seed with a block whose text cannot be read is refused under. */
export const UNREADABLE_SEED_BLOCK = "unreadable_seed_block";

/**
 * The seed check for one loop, run before its context is built. `none`
 * unless the variable is `api`, the loop's context names no `parent`, and no
 * loop in this process took the check before; the first such loop takes it
 * whatever it is seeded with.
 */
export async function seedVerdict(
  opts: {
    readonly seedMessages?: ReadonlyArray<SeedMessage>;
    readonly runContext?: { readonly parent?: string };
  },
  env: Readonly<Record<string, string | undefined>> = process.env,
  warn: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
): Promise<SeedVerdict> {
  const value = env[INPUT_ORIGIN_ENV];
  if (value === undefined) return NONE;
  if (value !== INPUT_ORIGIN_API) {
    if (!otherValueWarned) {
      otherValueWarned = true;
      warn(`[crewhaus] ${INPUT_ORIGIN_ENV} takes the one value "api"; it is ignored`);
    }
    return NONE;
  }
  if (opts.runContext?.parent !== undefined || firstLoopTaken) return NONE;
  firstLoopTaken = true;
  const read = (opts.seedMessages ?? []).map((m) => textsOf(m.content));
  if (read.some((r) => r.unreadable)) {
    return { kind: "blocked", rules: [UNREADABLE_SEED_BLOCK], score: 1 };
  }
  const texts = read.map((r) => r.texts.join("\n")).filter((text) => text !== "");
  if (texts.length === 0) return { kind: "kept", entries: [] };
  const each = await Promise.all(texts.map((text) => classify(text, { origin: "api" })));
  const joined = texts.length > 1 ? await classify(texts.join("\n"), { origin: "api" }) : undefined;
  const refused = [...each, ...(joined !== undefined ? [joined] : [])].find(
    (result) => result.action === "redact",
  );
  if (refused !== undefined) {
    return {
      kind: "blocked",
      rules: boundaryRuleIds(refused.verdict),
      score: refused.verdict.score,
    };
  }
  const warning = (result: BoundaryResult) => ({
    rules: boundaryRuleIds(result.verdict),
    score: result.verdict.score,
  });
  const entries: InboundContent[] = texts.map((content, i) => {
    const result = each[i] as BoundaryResult;
    return {
      content,
      origin: "api",
      door: "seed",
      ...(result.action === "warn" ? { warning: warning(result) } : {}),
    };
  });
  // A split injection only the joined text shows warns once, on the first message.
  const first = entries[0];
  if (joined?.action === "warn" && first !== undefined && !entries.some((e) => e.warning)) {
    entries[0] = { ...first, warning: warning(joined) };
  }
  return { kind: "kept", entries };
}

/**
 * The loop's context, built from the verdict: a kept seed is adopted by the
 * context `build` makes inside `withInboundContent`, or by the caller's own
 * context through `adoptInbound`; otherwise the caller's context or `build`'s.
 */
export function contextForSeed(
  verdict: SeedVerdict,
  supplied: RunContext | undefined,
  build: () => RunContext,
): RunContext {
  if (verdict.kind !== "kept" || verdict.entries.length === 0) return supplied ?? build();
  if (supplied !== undefined) {
    adoptInbound(supplied, verdict.entries);
    apiInputContexts.add(supplied);
    return supplied;
  }
  const built = withInboundContent(verdict.entries, build);
  apiInputContexts.add(built);
  return built;
}

/** The contexts a kept API seed was adopted into, whoever built them. */
const apiInputContexts = new WeakSet<object>();

/**
 * Whether `ctx` carries a job's API input: a kept seed was adopted into it,
 * into a context the loop built or one its caller supplied (which keeps its
 * own `originStack`). Every later loop that shares the context sees it too.
 */
export function isApiInputContext(ctx: object): boolean {
  return apiInputContexts.has(ctx);
}

/** Throw the classified refusal of a blocked seed, before any model call. */
export function refuseBlockedSeed(verdict: SeedVerdict): void {
  if (verdict.kind !== "blocked") return;
  throw new RunFailedError({
    class: "input_blocked",
    title: "input refused by the prompt-injection check",
    detail: `the job's input was refused at TrustOrigin "api" (rules: ${verdict.rules.join(", ")})`,
    exitCode: EXIT_CODES.input_blocked,
  });
}

/** Test seam: let the next top-level loop take the check, and forget the one warning. */
export function _resetInputOriginForTest(): void {
  firstLoopTaken = false;
  otherValueWarned = false;
  classify = classifyBoundary;
}

/** Test seam: count or script the classifier the check calls. `undefined` restores it. */
export function _setInputOriginClassifierForTest(next: Classify | undefined): void {
  classify = next ?? classifyBoundary;
}
