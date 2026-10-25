/**
 * One `ProofCheck`: run a checker, turn its verdict into the artifact the
 * `proven` rung reads, and say what the model should do next (design §6.4,
 * §7).
 *
 * The checker's verdict is the only thing trusted, and only `ok === true`
 * is a proof. Everything a checker returns is normalised here, because a
 * plugin checker implements the same interface and may get it wrong: a
 * thrown error, a non-array of assumptions or an oversized output is a
 * rejection or a clip, never a crash and never an accepted proof.
 */
import type { CheckResult, ProofChecker } from "@crewhaus/proof-checker";
import { type ProofArtifact, sha256Of } from "@crewhaus/provability";

/**
 * Input bounds. The statement and proof bounds are the largest any shipped
 * checker accepts (`BUILTIN_LIMITS.maxStatementChars`, `.maxProofChars`), so
 * the schema never refuses what a checker would take; each checker applies
 * its own tighter limit and says so. A claim is one sentence of an answer.
 */
export const PROOF_INPUT_LIMITS = {
  checkerChars: 64,
  claimChars: 2_000,
  statementChars: 20_000,
  proofChars: 1_000_000,
} as const;

/** Checker output kept in an artifact (proof-checker's "a few KB"). */
export const OUTPUT_CHARS = 4_000;
/** A counterexample or a reason, as recorded. */
const DETAIL_CHARS = 2_000;

/**
 * The most UTF-8 bytes a proof tool's report may be. The runtime spills any
 * tool result over 10 KB (`@crewhaus/tool-result-store`'s
 * `DEFAULT_THRESHOLD_BYTES`, 10 240) to a file and shows the model only its
 * first 10 KB, so a report past that loses its tail — and the tail is where
 * a JSON report's instructions would sit. Every report is cut to fit under
 * it, with the instructions placed first, so the model always reads the
 * whole of it.
 */
export const REPORT_BYTES = 9_000;

/** How a ProofCheck report spends its bytes; `output` gets what is left. */
const REPORT_REASON_BYTES = 1_200;
const REPORT_COUNTEREXAMPLE_BYTES = 1_800;
const REPORT_LIST_BYTES = 2_400;
/** One assumption or axiom as listed (the artifact keeps each whole). */
const LISTED_CHARS = 300;

/**
 * How much longer than `formal.timeoutMs` one check may take before it is
 * recorded as a rejection: a container start and the checker's own
 * reporting. The sandbox checkers stop themselves at `formal.timeoutMs`;
 * this is the backstop for a plugin checker that never settles.
 */
export const CHECK_GRACE_MS = 30_000;

/** Keep the head and the tail of long text, marking the cut. */
export function clipMiddle(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const head = text.slice(0, Math.floor(cap * 0.7));
  const tail = text.slice(text.length - Math.floor(cap * 0.25));
  return `${head}\n… ${text.length - head.length - tail.length} characters omitted …\n${tail}`;
}

/** Text clipped to `cap` characters, an ellipsis marking the cut. */
export function clip(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap - 1)}…`;
}

/** The UTF-8 bytes `value` takes in a compact JSON report. */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

/**
 * `text` cut (by `cut`, `clipMiddle` by default) until it takes at most
 * `maxBytes` as a JSON string. Measured, not estimated: escaping turns a
 * newline into two bytes and a control character into six, and a character
 * can take three bytes of UTF-8. Empty when not even the cut marker fits.
 */
export function fitText(
  text: string,
  maxBytes: number,
  cut: (text: string, cap: number) => string = clipMiddle,
): string {
  if (jsonBytes(text) <= maxBytes) return text;
  let cap = text.length;
  for (let attempt = 0; attempt < 12 && cap > 0; attempt++) {
    const candidate = cut(text, cap);
    const size = jsonBytes(candidate);
    if (size <= maxBytes) return candidate;
    cap = Math.min(cap - 1, Math.floor((cap * maxBytes) / size) - 8);
  }
  return "";
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const CANCELLED = Symbol("cancelled");
const TIMED_OUT = Symbol("timed out");

export type RunCheckerOptions = {
  /** The call's signal: an abort ends the wait at once (the caller then saves nothing). */
  readonly signal?: AbortSignal;
  /**
   * The longest the check may take before it is recorded as a rejection
   * (`formal.timeoutMs` + {@link CHECK_GRACE_MS} from the tool). Absent: no
   * backstop.
   */
  readonly timeoutMs?: number;
};

/**
 * Run `checker` and return a well-formed `CheckResult`, whatever it does.
 * A checker that throws has not proved anything: the result is a rejection
 * whose reason names the failure, and it is persisted like any rejection.
 * So is one that does not settle within `timeoutMs`. An abort of `signal`
 * stops the wait too, with a rejection the caller recognises by the aborted
 * signal and does not save. Neither stops a checker that ignores its signal
 * — nothing can — but the call returns, so one hung plugin cannot hang the
 * turn.
 */
export async function runChecker(
  checker: ProofChecker,
  input: { readonly claim: string; readonly statement: string; readonly proof: string },
  opts: RunCheckerOptions = {},
): Promise<CheckResult> {
  const { signal, timeoutMs } = opts;
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  const rejection = (reason: string): CheckResult => ({
    ok: false,
    checker: checker.id,
    assumptions: [],
    axioms: [],
    output: "",
    reason,
    durationMs: elapsed(),
  });
  if (signal?.aborted === true) return rejection("the check was cancelled");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stops: Array<Promise<typeof CANCELLED | typeof TIMED_OUT>> = [];
  if (signal !== undefined) {
    stops.push(
      new Promise((resolve) => {
        onAbort = () => resolve(CANCELLED);
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    );
  }
  if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs >= 0) {
    stops.push(
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    );
  }
  let raw: unknown;
  try {
    // `Promise.race` subscribes to the check, so one that rejects after the
    // race was decided is handled, not an unhandled rejection.
    raw = await Promise.race([
      Promise.resolve().then(() =>
        checker.check({
          claim: input.claim,
          statement: input.statement,
          proof: input.proof,
          ...(signal !== undefined ? { signal } : {}),
        }),
      ),
      ...stops,
    ]);
  } catch (err) {
    return rejection(`the ${checker.id} checker failed: ${clip(errorMessage(err), 300)}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
  if (raw === CANCELLED) return rejection("the check was cancelled");
  if (raw === TIMED_OUT) {
    return rejection(
      `the ${checker.id} checker did not finish within ${timeoutMs} ms, so nothing was proved`,
    );
  }
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const reason = text(r["reason"]);
  const counterexample = text(r["counterexample"]);
  const duration = r["durationMs"];
  const ok = r["ok"] === true;
  return {
    ok,
    checker: checker.id,
    assumptions: strings(r["assumptions"]),
    axioms: strings(r["axioms"]),
    output: typeof r["output"] === "string" ? r["output"] : "",
    ...(reason !== undefined
      ? { reason }
      : ok
        ? {}
        : { reason: `the ${checker.id} checker did not accept the proof` }),
    ...(counterexample !== undefined ? { counterexample } : {}),
    durationMs:
      typeof duration === "number" && Number.isFinite(duration) && duration >= 0
        ? Math.round(duration)
        : elapsed(),
  };
}

/**
 * The artifact for one check — accepted or rejected alike: a rejected proof
 * is persisted too, because proof pressure is signal (the `action_proof`
 * rule from tool-plan), and `proof_rejected` in a bundle can then name the
 * checker's reason. The `checker` is the id the model asked for, which is
 * the registry's identity for the checker that ran.
 */
export function toArtifact(args: {
  readonly id: string;
  readonly checker: ProofChecker;
  readonly input: { readonly claim: string; readonly statement: string; readonly proof: string };
  readonly result: CheckResult;
  readonly checkedAt: Date;
}): ProofArtifact {
  const { result } = args;
  const output = clipMiddle(result.output, OUTPUT_CHARS);
  return {
    version: 1,
    id: args.id,
    checker: args.checker.id,
    claim: args.input.claim,
    statement: args.input.statement,
    proof: args.input.proof,
    ok: result.ok,
    assumptions: [...result.assumptions],
    axioms: [...result.axioms],
    output,
    ...(result.counterexample !== undefined
      ? { counterexample: clip(result.counterexample, DETAIL_CHARS) }
      : {}),
    ...(result.reason !== undefined ? { reason: clip(result.reason, DETAIL_CHARS) } : {}),
    outputDigest: sha256Of(output),
    checkedAt: args.checkedAt.toISOString(),
    durationMs: result.durationMs,
  };
}

/** The `proof_checked` payload: the trace event's fields, and the event-log line's whole payload. */
export function proofCheckedFields(artifact: ProofArtifact): {
  readonly checker: string;
  readonly ok: boolean;
  readonly artifactId: string;
  readonly durationMs: number;
  readonly axioms: readonly string[];
} {
  return {
    checker: artifact.checker,
    ok: artifact.ok,
    artifactId: artifact.id,
    durationMs: artifact.durationMs ?? 0,
    axioms: [...artifact.axioms],
  };
}

/** The marker a ProofCheck report's lists end with: the artifact keeps every item. */
const keptInArtifact = (rest: number): string => `… and ${rest} more (the artifact keeps them all)`;

/**
 * As many of `items` as fit in `maxBytes`, each clipped to `itemChars`, in
 * order, then `more(n)` counting the n left out — which the caller says
 * where to find (the artifact keeps a ProofCheck's whole).
 */
export function listed(
  items: ReadonlyArray<string>,
  maxBytes: number,
  more: (rest: number) => string = keptInArtifact,
  itemChars: number = LISTED_CHARS,
): string[] {
  const shown: string[] = [];
  // Room for the marker, so adding it never breaks the budget.
  const reserve = jsonBytes(more(items.length)) + 1;
  let used = 2; // the brackets
  for (const item of items) {
    const cell = clip(item, itemChars);
    const cost = jsonBytes(cell) + (shown.length > 0 ? 1 : 0);
    if (used + cost + (shown.length + 1 < items.length ? reserve : 0) > maxBytes) break;
    shown.push(cell);
    used += cost;
  }
  const rest = items.length - shown.length;
  return rest > 0 ? [...shown, more(rest)] : shown;
}

/**
 * What the model reads back: the verdict, the artifact id and one
 * instruction — how to cite it, or what to do instead — first, then why
 * (reason, counterexample), what the proof rests on and the checker's
 * output. The whole report fits in {@link REPORT_BYTES}, the output taking
 * what the rest leaves; the artifact keeps everything whole.
 */
export function checkReport(artifact: ProofArtifact): Record<string, unknown> {
  const next = artifact.ok
    ? `cite it as [n]: proof:${artifact.id} — put [n] on the sentence that states this claim, with the same words, figures and polarity, or the gate reports claim_mismatch`
    : `not proven, so this artifact cannot back a claim (the gate reports proof_rejected)${
        artifact.counterexample !== undefined ? "; the counterexample shows where it fails" : ""
      } — fix the statement or the proof and run ProofCheck again, or do not state the claim`;
  const head = {
    ok: artifact.ok,
    id: artifact.id,
    checker: artifact.checker,
    next,
    ...(artifact.reason !== undefined
      ? { reason: fitText(artifact.reason, REPORT_REASON_BYTES) }
      : {}),
    ...(artifact.counterexample !== undefined
      ? { counterexample: fitText(artifact.counterexample, REPORT_COUNTEREXAMPLE_BYTES) }
      : {}),
  };
  const assumptions = listed(artifact.assumptions, REPORT_LIST_BYTES / 2);
  const axioms = listed(artifact.axioms, REPORT_LIST_BYTES - jsonBytes(assumptions));
  const rest = REPORT_BYTES - jsonBytes({ ...head, assumptions, axioms, output: "" });
  return { ...head, assumptions, axioms, output: fitText(artifact.output, rest) };
}
