/**
 * `checked` replay (design §6.3): re-execute a PURE tool with the input the
 * log recorded and hand the output back for the verifier's digest compare.
 *
 * Purity is `@crewhaus/provability`'s `isPureTool` over the tool's declared
 * safety flags — read-only, concurrency-safe, not destructive, no sandbox,
 * internal scope, no network or process capability — the one definition the
 * preflight tool also reads, so `Bash`, `Python`, every fetch and every
 * write are never re-run whatever a spec lists on `execution.allow`.
 *
 * A replay runs the tool the way the executor does: the logged input is
 * parsed through the tool's own schema first (defaults and transforms apply,
 * as they did on the original call), then `execute` gets a context carrying
 * only an abort signal — a pure tool needs no bridge, no run context and no
 * model. The call is bounded ({@link REPLAY_TIMEOUT_MS}) and follows the
 * turn's own signal, so a hung tool cannot hold the answer.
 *
 * Pure is not the same as deterministic, and a replay is only a verdict on
 * a tool that answers the same input the same way. Three things the flags
 * cannot say are handled here, each as "could not replay" (`replayed:
 * false`), never as a mismatch no retry could cure:
 *
 *   - THE CLOCK. A tool whose schema offers `now` ("overrides the real
 *     clock, for tests and replays" — DeadlineCheck, ErrorClassify,
 *     SequenceRun) read the real clock on a call that left it out, so that
 *     call is not re-run: its answer was about a moment that has passed.
 *   - ANY OTHER VARIANCE (the CSPRNG behind an unseeded Uuid v4, say). When
 *     a replay disagrees with the log it is run once more, after
 *     {@link REPLAY_RECHECK_MS}; two runs that disagree with EACH OTHER show
 *     the tool does not reproduce on this input, and only two that agree
 *     with each other and not with the log are handed over as the mismatch.
 *   - THE SPILL. runtime-core logs (and shows the model) only
 *     tool-result-store's preview of a string result over its threshold —
 *     the head plus its own `[truncated, full output at …]` markers. Such a
 *     replay is put in the shape it was logged in: when the logged text is
 *     this output's head followed by those markers, the logged text is what
 *     comes back (everything the evidence holds was reproduced); when it is
 *     a preview of another head, the replay's head does (a mismatch); when
 *     the logged text cannot be read as a preview at all, nothing does.
 *
 * Those last two need the text the log holds for the call: `logged` (the
 * gate passes a lookup over the turn's evidence index). Without it, a
 * result over the threshold is not compared at all.
 *
 * What comes back: `undefined` when there is nothing to re-run (the tool is
 * not in the catalog any more, not pure, the logged input no longer parses,
 * or one of the cases above); the output text when it ran; `isError: true`
 * with the message when the tool threw on an input it once answered — a
 * disagreement, so `replay_mismatch`. A timeout or an abort is not a verdict
 * on the tool: it throws, and the verifier reads that as "could not run"
 * (`replayed: false`).
 */
import { isPureTool } from "@crewhaus/provability";
import type { ReplayResult } from "@crewhaus/provability";
import type { RegisteredTool, ToolExecuteResult } from "@crewhaus/tool-catalog";
import {
  DEFAULT_PREVIEW_LINES,
  DEFAULT_THRESHOLD_BYTES,
  previewHead,
} from "@crewhaus/tool-result-store";

/** How long one replayed call may take. */
export const REPLAY_TIMEOUT_MS = 10_000;

/**
 * The pause before a disagreeing replay is run again: long enough that a
 * tool reading a millisecond clock has moved on, short enough to be noise
 * beside the replay itself.
 */
export const REPLAY_RECHECK_MS = 5;

/** Where replay looks tools up: a catalog (`defaultCatalog`) or the run's tool list. */
export type GateCatalog =
  | { get(name: string): RegisteredTool | undefined }
  | ReadonlyArray<RegisteredTool>;

/** The lookup over either catalog form. */
export function lookupTool(
  catalog: GateCatalog | undefined,
  name: string,
): RegisteredTool | undefined {
  if (catalog === undefined) return undefined;
  if (Array.isArray(catalog)) {
    return (catalog as ReadonlyArray<RegisteredTool>).find((tool) => tool.name === name);
  }
  return (catalog as { get(name: string): RegisteredTool | undefined }).get(name);
}

/** A tool result's text, the way the evidence index reads one: text blocks joined by newlines. */
export function resultText(result: ToolExecuteResult): string {
  if (typeof result === "string") return result;
  return result
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * The verifier's comparison (provability's `outputDigest` hashes exactly
 * this): whitespace runs collapsed to one space, the ends trimmed.
 */
function sameOutput(a: string, b: string): boolean {
  return a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
}

/**
 * What tool-result-store appends to a spilled result's head: the optional
 * part line, then the truncation line (saved, or why it could not be). The
 * whole tail, anchored at both ends — a preview is recognized by its own
 * grammar, or not at all.
 */
const SPILL_TAIL =
  /^(?:\n\[(?:part 1 of \d+; Read [^\n]+ for part 2|the rest could not also be saved in parts to Read one at a time: [^\n]*)\])?\n\[truncated(?:, full output at [^\n]+|; the full output could not be saved: [^\n]*)\]$/;

/** The same tail, found at the END of a logged text whose head is unknown. */
const SPILL_TAIL_AT_END = new RegExp(`(?:${SPILL_TAIL.source.slice(1, -1)})$`);

/** Did the runtime log `text` as a spill preview whose head is `head`? */
function isPreviewOf(text: string, head: string): boolean {
  return text.startsWith(head) && SPILL_TAIL.test(text.slice(head.length));
}

/** A replay's output put in the shape the log holds it in (see the module doc). */
type Shaped =
  | { readonly kind: "text"; readonly text: string }
  /** Cannot be compared: the log holds a form this output cannot be put in. */
  | { readonly kind: "incomparable" };

function shapeAsLogged(
  result: ToolExecuteResult,
  logged: ReadonlyArray<string> | undefined,
): Shaped {
  const text = resultText(result);
  // runtime-core spills only string results (block content goes through whole).
  if (typeof result !== "string" || Buffer.byteLength(text, "utf8") <= DEFAULT_THRESHOLD_BYTES) {
    return { kind: "text", text };
  }
  if (logged === undefined || logged.length === 0) return { kind: "incomparable" };
  const head = previewHead(text, DEFAULT_PREVIEW_LINES, DEFAULT_THRESHOLD_BYTES);
  const same = logged.find((entry) => isPreviewOf(entry, head));
  if (same !== undefined) return { kind: "text", text: same };
  // A preview of some other head: the output differs where the evidence can see it.
  if (logged.some((entry) => SPILL_TAIL_AT_END.test(entry))) return { kind: "text", text: head };
  return { kind: "incomparable" };
}

/** Does the parsed input leave out a `now` the tool's schema offers — so the call read the real clock? */
function readTheClock(tool: RegisteredTool, input: unknown): boolean {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  if ((input as Record<string, unknown>)["now"] !== undefined) return false;
  return offersField(tool, "now");
}

/** Whether a tool's input schema declares `field` (its JSON Schema, else its zod object shape). */
function offersField(tool: RegisteredTool, field: string): boolean {
  const json = tool.jsonSchema as { properties?: Record<string, unknown> } | undefined;
  if (json?.properties !== undefined && typeof json.properties === "object") {
    return Object.hasOwn(json.properties, field);
  }
  let schema: unknown = tool.inputSchema;
  // Unwrap refinements, optionals, defaults and pipes down to the object, if any.
  for (let depth = 0; depth < 8; depth += 1) {
    const def = (schema as { _def?: Record<string, unknown> } | undefined)?._def;
    if (def === undefined) return false;
    if (typeof def["shape"] === "function") {
      const shape = (def["shape"] as () => unknown)();
      return typeof shape === "object" && shape !== null && Object.hasOwn(shape, field);
    }
    schema = def["schema"] ?? def["innerType"] ?? def["in"] ?? def["type"];
  }
  return false;
}

class ReplayStopped extends Error {
  override readonly name = "ReplayStopped";
}

export type CatalogReplayOptions = {
  /** The turn's signal: an abort stops a running replay. */
  readonly signal?: AbortSignal;
  /** Bound on one replayed call (default {@link REPLAY_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
  /**
   * The text(s) the evidence holds for a call of `toolName` with `input` —
   * the verifier hands replay the very `input` object of the record it is
   * checking. Absent: a replay is handed over as it ran, and one over the
   * spill threshold is not compared.
   */
  readonly logged?: (toolName: string, input: unknown) => ReadonlyArray<string>;
  /** The pause before a disagreeing replay runs again (default {@link REPLAY_RECHECK_MS}). */
  readonly recheckMs?: number;
};

/** The verifier's two replay hooks over `catalog`, bound to one turn's signal. */
export function catalogReplay(
  catalog: GateCatalog | undefined,
  opts: CatalogReplayOptions = {},
): {
  readonly isPureTool: (toolName: string) => boolean;
  readonly replay: (toolName: string, input: unknown) => Promise<ReplayResult | undefined>;
} {
  const pure = (toolName: string): RegisteredTool | undefined => {
    const tool = lookupTool(catalog, toolName);
    return tool !== undefined && isPureTool(tool) ? tool : undefined;
  };
  const timeoutMs = opts.timeoutMs ?? REPLAY_TIMEOUT_MS;
  const recheckMs = opts.recheckMs ?? REPLAY_RECHECK_MS;

  /** One bounded run: the result, a thrown error as `{ error }`, or a throw on timeout / abort. */
  const runOnce = async (
    tool: RegisteredTool,
    input: unknown,
  ): Promise<{ readonly result: ToolExecuteResult } | { readonly error: string }> => {
    const ctrl = new AbortController();
    const outer = opts.signal;
    if (outer?.aborted === true) throw new ReplayStopped("the turn was aborted");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const stop = new Promise<never>((_resolve, reject) => {
      const halt = (why: ReplayStopped): void => {
        ctrl.abort(why);
        reject(why);
      };
      timer = setTimeout(
        () => halt(new ReplayStopped(`replaying ${tool.name} took longer than ${timeoutMs}ms`)),
        timeoutMs,
      );
      onAbort = () => halt(new ReplayStopped("the turn was aborted"));
      outer?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => tool.execute(input, { signal: ctrl.signal })),
        stop,
      ]);
      return { result };
    } catch (err) {
      if (err instanceof ReplayStopped || ctrl.signal.aborted) throw err;
      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) outer?.removeEventListener("abort", onAbort);
    }
  };

  /** A run as the verifier will compare it; `undefined` when it cannot be compared. */
  const asCompared = (
    run: { readonly result: ToolExecuteResult } | { readonly error: string },
    logged: ReadonlyArray<string> | undefined,
  ): ReplayResult | undefined => {
    if ("error" in run) return { content: run.error, isError: true };
    const shaped = shapeAsLogged(run.result, logged);
    return shaped.kind === "text" ? { content: shaped.text, isError: false } : undefined;
  };

  return {
    isPureTool: (toolName) => pure(toolName) !== undefined,
    replay: async (toolName, input) => {
      const tool = pure(toolName);
      if (tool === undefined) return undefined;
      const parsed = tool.inputSchema.safeParse(input);
      if (!parsed.success) return undefined;
      if (readTheClock(tool, parsed.data)) return undefined;
      const logged = opts.logged?.(toolName, input);
      const first = asCompared(await runOnce(tool, parsed.data), logged);
      if (first === undefined) return undefined;
      const agrees =
        !first.isError &&
        logged !== undefined &&
        logged.some((entry) => sameOutput(entry, first.content));
      if (agrees) return first;
      // A disagreement — or nothing to check against. Is it the tool's answer,
      // or does the tool not reproduce at all? Ask once more.
      await new Promise((resolve) => setTimeout(resolve, recheckMs));
      if (opts.signal?.aborted === true) throw new ReplayStopped("the turn was aborted");
      const second = asCompared(await runOnce(tool, parsed.data), logged);
      if (second === undefined || second.isError !== first.isError) return undefined;
      return sameOutput(second.content, first.content) ? first : undefined;
    },
  };
}
