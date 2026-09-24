import { type RegexLimits, type RegexRejectCode, screenUserRegex } from "./screen";
import { REGEX_WORKER_SOURCE } from "./worker-source";

/**
 * Running a caller-supplied regex under a deadline that actually holds.
 *
 * A synchronous `RegExp` call cannot be interrupted: no timer fires, no abort
 * signal is seen, and the whole process — every session, every heartbeat —
 * waits for it. So the match runs in a Bun Worker, and at the deadline the
 * worker is terminated and the caller is told the answer is undetermined.
 *
 * WHAT TERMINATION DOES AND DOES NOT DO (measured, Bun 1.3.14):
 *   - The caller's event loop is free the moment the deadline fires. That is
 *     the guarantee this module exists for.
 *   - The worker THREAD is not preempted inside the regex engine. It stops at
 *     the next point JavaScriptCore checks for termination, which is after the
 *     current `exec` returns. For an exponential pattern that is when JSC's
 *     backtracking budget runs out (≈0.4–3 s of one core); for a polynomial
 *     one it grows with the input: `\s+$` costs about 0.6 ns × n², so 64 000
 *     characters take ≈2.4 s and 1 000 000 about ten minutes. A batch op runs
 *     one `exec` per input, so `maxItemChars` bounds this for batches, and
 *     `maxInputChars` for the single-input ops. {@link regexWorkerCounts}
 *     reports such "runaway" threads. Past `maxRunawayWorkers` of them under
 *     one `runawayKey`, or `maxRunawayWorkersTotal` in the process, a new run
 *     is refused with `error`/`busy` rather than stacking more.
 *   - A terminated worker does not hold the process open (it is `unref`ed).
 *
 * THE SCREEN RUNS ON THE CALLER'S THREAD, before the worker starts, and it is
 * bounded there: by `maxPatternChars` and the screen's work budget per
 * pattern, and, for the many-pattern ops, by yielding to the event loop every
 * few milliseconds and stopping at the deadline, which covers screening and
 * matching alike. Screen verdicts are cached, so a session loop re-running
 * the same pattern pays for its screen once.
 *
 * THE ANSWER IS TRI-STATE. `status: "ok"` is the only outcome that carries a
 * definite answer. Every other status means "could not tell", and a caller
 * must never read it as "no match" — see {@link regexVerdict} and the README
 * for how each kind of tool should surface it.
 */

export type RegexOp =
  | "test"
  | "matchAll"
  | "replace"
  | "split"
  | "testEach"
  | "firstMatchingRule"
  | "testMatrix"
  | "replaceEach";

type CommonOptions = {
  /**
   * Wall-clock budget for screening the pattern(s) and running the match,
   * worker start-up excluded. Default 1000.
   */
  readonly deadlineMs?: number;
  /** Total input size admitted, in UTF-16 code units (plus one per batch item). Default 1 000 000. */
  readonly maxInputChars?: number;
  /**
   * A single `exec` that reports no match after at least this long is
   * reported as `gave-up`, because that is JavaScriptCore abandoning the
   * match, not a real no-match (see the worker source). Default 100.
   */
  readonly giveUpMs?: number;
  /** Pattern limits for the up-front screen. */
  readonly limits?: RegexLimits;
  /**
   * Refuse to start while this many workers abandoned at a deadline under
   * the same `runawayKey` are still running. Default 2.
   */
  readonly maxRunawayWorkers?: number;
  /**
   * Whose abandoned workers count toward `maxRunawayWorkers`: pass the
   * session (or tenant) id so one caller's hostile patterns make only that
   * caller `busy`. Requests without a key share one. A process-wide ceiling
   * (`REGEX_RUN_DEFAULTS.maxRunawayWorkersTotal`) applies across all keys.
   */
  readonly runawayKey?: string;
  /** Abandon the run when this fires; it resolves as `error`/`aborted`. Pass the tool's `ctx.signal`. */
  readonly signal?: AbortSignal;
};

/**
 * What a batch op does with an input it cannot answer: one the engine gave
 * up on, or one longer than `maxItemChars`. `"stop"` (the default) ends the
 * batch there as `gave-up` / `input-too-large`; `"skip"` lists the input in
 * the result's `undetermined` and goes on while the deadline allows.
 */
export type OnGiveUp = "stop" | "skip";

type BatchOptions = {
  readonly onGiveUp?: OnGiveUp;
  /**
   * Longest single input a batch op runs, in UTF-16 code units. Default
   * 65 536. This bounds each `exec`, and so how long a worker abandoned at a
   * deadline keeps burning a core (see the module comment).
   */
  readonly maxItemChars?: number;
};

type ManyPatterns = {
  /** Default 1000. */
  readonly maxRules?: number;
  /** Cap on the patterns' combined length. Default 100 000. */
  readonly maxTotalPatternChars?: number;
};

type OnePattern = CommonOptions & { readonly pattern: string; readonly flags?: string };

/** Does the pattern match anywhere in `input`? */
export type TestRequest = OnePattern & { readonly op: "test"; readonly input: string };

/** Every match (the `g` flag is implied), up to `maxMatches`. */
export type MatchAllRequest = OnePattern & {
  readonly op: "matchAll";
  readonly input: string;
  /** Default 10 000. */
  readonly maxMatches?: number;
  /** Cap on the characters of all returned matches and captures. Default 2 000 000. */
  readonly maxOutputChars?: number;
};

/**
 * `input.replace(pattern, replacement)` with a STRING replacement and the
 * standard `$&`, `$1`, `$<name>`, `` $` ``, `$'` and `$$` substitutions. All
 * matches under `g`, the first otherwise.
 */
export type ReplaceRequest = OnePattern & {
  readonly op: "replace";
  readonly input: string;
  readonly replacement: string;
  /** Output larger than this is refused (`output-too-large`), never cut. Default 2 000 000. */
  readonly maxOutputChars?: number;
};

/** `input.split(pattern, limit)`, captures included, as the standard method does. */
export type SplitRequest = OnePattern & {
  readonly op: "split";
  readonly input: string;
  /** The standard method's own `limit`: stop after this many pieces, not an error. */
  readonly limit?: number;
  /** Hard cap on pieces; exceeding it sets `truncated`. Default 10 000. */
  readonly maxMatches?: number;
  readonly maxOutputChars?: number;
};

/** One pattern over many inputs (lines, records): which of them match. */
export type TestEachRequest = OnePattern &
  BatchOptions & {
    readonly op: "testEach";
    readonly inputs: ReadonlyArray<string>;
    /** Stop after this many matching inputs and set `truncated`. Default 10 000. */
    readonly maxMatches?: number;
  };

export type RegexRule = { readonly pattern: string; readonly flags?: string };

/** Many patterns over many inputs: for each input, the first rule that matches. */
export type FirstMatchingRuleRequest = CommonOptions &
  BatchOptions &
  ManyPatterns & {
    readonly op: "firstMatchingRule";
    readonly rules: ReadonlyArray<RegexRule>;
    readonly inputs: ReadonlyArray<string>;
  };

/**
 * Every pattern against every input: which inputs each pattern matches. For
 * a classifier that scores all its rules against one text, a policy check
 * that reports every rule that fired, or a synchronous evaluator that runs
 * one batch up front and then looks answers up (see the README).
 */
export type TestMatrixRequest = CommonOptions &
  BatchOptions &
  ManyPatterns & {
    readonly op: "testMatrix";
    readonly patterns: ReadonlyArray<RegexRule>;
    readonly inputs: ReadonlyArray<string>;
  };

/** One `replace` over many inputs; `maxOutputChars` caps all the outputs together. */
export type ReplaceEachRequest = OnePattern &
  BatchOptions & {
    readonly op: "replaceEach";
    readonly inputs: ReadonlyArray<string>;
    readonly replacement: string;
    readonly maxOutputChars?: number;
  };

export type RegexRequest =
  | TestRequest
  | MatchAllRequest
  | ReplaceRequest
  | SplitRequest
  | TestEachRequest
  | FirstMatchingRuleRequest
  | TestMatrixRequest
  | ReplaceEachRequest;

export type TestResult = { readonly matched: boolean };

export type RegexMatch = {
  readonly match: string;
  readonly index: number;
  readonly captures: ReadonlyArray<string | undefined>;
  readonly groups?: Readonly<Record<string, string | undefined>>;
};

export type MatchAllResult = {
  readonly matches: ReadonlyArray<RegexMatch>;
  /** More matches exist than were returned. */
  readonly truncated: boolean;
  readonly truncatedBy?: "maxMatches" | "maxOutputChars";
};

export type ReplaceResult = { readonly output: string; readonly replacements: number };

export type SplitResult = {
  readonly pieces: ReadonlyArray<string | undefined>;
  readonly truncated: boolean;
  readonly truncatedBy?: "maxMatches" | "maxOutputChars";
};

export type TestEachResult = {
  /** Indexes of the inputs that matched, ascending. */
  readonly matched: ReadonlyArray<number>;
  /** How many inputs were answered or skipped — all of them unless `truncated`. */
  readonly scanned: number;
  readonly truncated: boolean;
  /** `onGiveUp: "skip"`: inputs whose answer is undetermined, ascending. Neither matched nor not. */
  readonly undetermined: ReadonlyArray<number>;
};

export type FirstMatchingRuleResult = {
  /**
   * Per input, the index of the first matching rule, -1 when none matched,
   * or null when that is undetermined (`onGiveUp: "skip"`).
   */
  readonly ruleIndexes: ReadonlyArray<number | null>;
  /** The inputs whose entry is null, ascending. */
  readonly undetermined: ReadonlyArray<number>;
};

export type TestMatrixResult = {
  /** Per pattern, the indexes of the inputs it matched, ascending. */
  readonly matched: ReadonlyArray<ReadonlyArray<number>>;
  /** Per pattern, the inputs whose answer is undetermined (`onGiveUp: "skip"`), ascending. */
  readonly undetermined: ReadonlyArray<ReadonlyArray<number>>;
};

export type ReplaceEachResult = {
  /** Per input, its output, or null when undetermined (`onGiveUp: "skip"`). */
  readonly outputs: ReadonlyArray<string | null>;
  /** Replacements made across all inputs. */
  readonly replacements: number;
  /** The inputs whose output is null, ascending. */
  readonly undetermined: ReadonlyArray<number>;
};

type ResultByOp = {
  readonly test: TestResult;
  readonly matchAll: MatchAllResult;
  readonly replace: ReplaceResult;
  readonly split: SplitResult;
  readonly testEach: TestEachResult;
  readonly firstMatchingRule: FirstMatchingRuleResult;
  readonly testMatrix: TestMatrixResult;
  readonly replaceEach: ReplaceEachResult;
};

export type ResultOf<R extends RegexRequest> = ResultByOp[R["op"]];

export type RegexErrorCode =
  /** Too many abandoned workers are still running; try again once they exit. */
  | "busy"
  /** A worker could not be started (no Worker support, or it never became ready). */
  | "worker-unavailable"
  /** The worker died mid-run. */
  | "worker-crashed"
  /** The engine threw (out of memory, stack overflow). */
  | "exec-threw"
  /** The session was closed. */
  | "closed"
  /** The request's `signal` fired. */
  | "aborted";

export type RegexOutcome<T> =
  | { readonly status: "ok"; readonly result: T; readonly elapsedMs: number }
  | {
      readonly status: "rejected";
      readonly code: RegexRejectCode;
      readonly reason: string;
      readonly fragment?: string;
      /** For `firstMatchingRule` and `testMatrix`: which rule. */
      readonly ruleIndex?: number;
    }
  | {
      readonly status: "input-too-large";
      readonly reason: string;
      /** Batch ops: the input over `maxItemChars`. */
      readonly index?: number;
    }
  | { readonly status: "output-too-large"; readonly reason: string }
  | {
      readonly status: "timeout";
      readonly reason: string;
      readonly deadlineMs: number;
      /** Batch ops: inputs answered before the deadline (a lower bound). */
      readonly completed?: number;
      /** Batch ops: the answers for those inputs. */
      readonly partial?: T;
    }
  | {
      readonly status: "gave-up";
      readonly reason: string;
      /** How long the abandoned `exec` ran. */
      readonly execMs: number;
      /** Batch ops: the input the engine gave up on. */
      readonly index?: number;
      /** `firstMatchingRule` / `testMatrix`: the rule it gave up on. */
      readonly ruleIndex?: number;
      /** What was determined before it. */
      readonly partial?: T;
    }
  | { readonly status: "error"; readonly code: RegexErrorCode; readonly reason: string };

export const REGEX_RUN_DEFAULTS = {
  deadlineMs: 1_000,
  maxInputChars: 1_000_000,
  maxItemChars: 65_536,
  giveUpMs: 100,
  maxMatches: 10_000,
  maxOutputChars: 2_000_000,
  maxRules: 1_000,
  maxTotalPatternChars: 100_000,
  maxRunawayWorkers: 2,
  /** Abandoned workers still running, across every `runawayKey`, past which every run is `busy`. */
  maxRunawayWorkersTotal: 8,
  /** How long a fresh worker may take to report ready before it counts as unavailable. */
  startupTimeoutMs: 10_000,
  /** How often a batch op reports progress, so a timeout can say how far it got. */
  progressEveryMs: 10,
  /** Screening many patterns yields to the event loop at least this often. */
  screenSliceMs: 4,
} as const;

// ─── Tri-state helpers ──────────────────────────────────────────────────────

export type RegexVerdict = "matched" | "not-matched" | "undetermined";

/**
 * The three-way answer to "does it match?". Only `ok` is ever `matched` or
 * `not-matched`; a refusal, a timeout or a give-up is `undetermined`, and a
 * caller must surface it as such — a gate fails closed, a search reports the
 * input as unscanned, a classifier returns no label rather than its default.
 */
export function regexVerdict(outcome: RegexOutcome<TestResult>): RegexVerdict {
  if (outcome.status !== "ok") return "undetermined";
  return outcome.result.matched ? "matched" : "not-matched";
}

/** One line describing a non-`ok` outcome, fit to put in a tool result. */
export function describeRegexOutcome(outcome: RegexOutcome<unknown>): string {
  switch (outcome.status) {
    case "ok":
      return "the pattern ran to completion";
    case "rejected":
      return `pattern refused (${outcome.code}): ${outcome.reason}`;
    case "error":
      return `undetermined (${outcome.code}): ${outcome.reason}`;
    default:
      return `undetermined (${outcome.status}): ${outcome.reason}`;
  }
}

// ─── Worker bookkeeping ─────────────────────────────────────────────────────

const counts = { live: 0, runaway: 0 };
/** Abandoned workers still running, per `runawayKey`. */
const runawayByKey = new Map<string, number>();

/**
 * Process-wide worker counts. `live` is every regex worker thread that has
 * not exited; `runaway` is the subset that was terminated at a deadline but
 * is still inside a regex `exec` (see the module comment). Both return to
 * zero on their own; a `runaway` that stays up is a pattern burning a core.
 */
export function regexWorkerCounts(): { readonly live: number; readonly runaway: number } {
  return { live: counts.live, runaway: counts.runaway };
}

let workerUrl: string | undefined;

function workerUrlOnce(): string {
  workerUrl ??= URL.createObjectURL(new Blob([REGEX_WORKER_SOURCE], { type: "text/javascript" }));
  return workerUrl;
}

type WorkerMessage = {
  readonly kind: "ready" | "progress" | "done";
  readonly id?: number;
  readonly [key: string]: unknown;
};

type Slot = {
  readonly worker: Worker;
  runaway: boolean;
  /** The `runawayKey` of the run it is serving; charged if it is abandoned. */
  runawayKey: string;
  exited: boolean;
  onMessage: ((message: WorkerMessage) => void) | undefined;
  onFailure: ((why: string) => void) | undefined;
};

function spawnSlot(): Slot | string {
  let worker: Worker;
  try {
    worker = new Worker(workerUrlOnce());
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  worker.unref();
  counts.live += 1;
  const slot: Slot = {
    worker,
    runaway: false,
    runawayKey: "",
    exited: false,
    onMessage: undefined,
    onFailure: undefined,
  };
  worker.addEventListener("close", () => {
    if (slot.exited) return;
    slot.exited = true;
    counts.live -= 1;
    if (slot.runaway) {
      counts.runaway -= 1;
      const left = (runawayByKey.get(slot.runawayKey) ?? 1) - 1;
      if (left <= 0) runawayByKey.delete(slot.runawayKey);
      else runawayByKey.set(slot.runawayKey, left);
    }
    slot.onFailure?.("the worker exited");
  });
  worker.addEventListener("error", (event) => {
    slot.onFailure?.(event instanceof ErrorEvent ? event.message : "the worker failed");
  });
  worker.addEventListener("message", (event) => {
    slot.onMessage?.(event.data as WorkerMessage);
  });
  return slot;
}

/**
 * Stop a worker that is (or may be) still matching. Until it exits it counts
 * as a runaway of the key whose run it was serving.
 */
function abandon(slot: Slot): void {
  slot.onMessage = undefined;
  slot.onFailure = undefined;
  if (!slot.exited && !slot.runaway) {
    slot.runaway = true;
    counts.runaway += 1;
    runawayByKey.set(slot.runawayKey, (runawayByKey.get(slot.runawayKey) ?? 0) + 1);
  }
  slot.worker.terminate();
}

/** Stop an idle worker. */
function retire(slot: Slot): void {
  slot.onMessage = undefined;
  slot.onFailure = undefined;
  slot.worker.terminate();
}

function waitReady(slot: Slot, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      slot.onMessage = undefined;
      slot.onFailure = undefined;
      resolve(`the worker did not start within ${timeoutMs} ms`);
    }, timeoutMs);
    slot.onMessage = (message) => {
      if (message.kind !== "ready") return;
      clearTimeout(timer);
      slot.onMessage = undefined;
      slot.onFailure = undefined;
      resolve(undefined);
    };
    slot.onFailure = (why) => {
      clearTimeout(timer);
      slot.onMessage = undefined;
      slot.onFailure = undefined;
      resolve(why);
    };
  });
}

/** Why a new run must wait, or undefined when it may start. */
function busyReason(key: string, perKey: number): string | undefined {
  const mine = runawayByKey.get(key) ?? 0;
  if (mine >= perKey) {
    return `${mine} regex worker(s) this caller abandoned at a deadline are still running; refusing to start another until one exits`;
  }
  if (counts.runaway >= REGEX_RUN_DEFAULTS.maxRunawayWorkersTotal) {
    return `${counts.runaway} regex worker(s) abandoned at a deadline are still running in this process; refusing to start another until one exits`;
  }
  return undefined;
}

// ─── Request preparation (on the caller's thread) ───────────────────────────

type BatchKind = "testEach" | "firstMatchingRule" | "testMatrix" | "replaceEach";

type Prepared = {
  readonly message: Record<string, unknown>;
  readonly deadlineMs: number;
  /** Time already spent screening, which counts against the deadline. */
  readonly screenMs: number;
  readonly batch: BatchKind | undefined;
  /** Number of patterns, for `testMatrix`. */
  readonly patternCount: number;
  readonly maxRunawayWorkers: number;
  readonly runawayKey: string;
};

function option(name: string, value: number | undefined, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || Number.isNaN(value) || value < min) {
    throw new RangeError(`${name} must be a number >= ${min}, got ${String(value)}`);
  }
  return value;
}

function sizeOf(inputs: ReadonlyArray<unknown>, batch: boolean): number | string {
  if (!Array.isArray(inputs)) return "inputs must be an array of strings";
  let total = 0;
  for (let i = 0; i < inputs.length; i++) {
    const s = inputs[i];
    if (typeof s !== "string") return `input ${i} is not a string`;
    total += s.length + (batch ? 1 : 0);
  }
  return total;
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

type Stopped = { readonly stopped: RegexOutcome<never> };

/**
 * Screen every rule of a many-pattern op. Yields to the event loop every
 * `screenSliceMs`, and stops at the deadline or the signal, so a long rule
 * list never holds the caller's thread for long.
 */
async function screenRules(
  rules: ReadonlyArray<RegexRule>,
  limits: RegexLimits | undefined,
  started: number,
  deadlineMs: number,
  signal: AbortSignal | undefined,
): Promise<Array<{ pattern: string; flags: string }> | Stopped> {
  const out: Array<{ pattern: string; flags: string }> = [];
  let slice = performance.now();
  for (let i = 0; i < rules.length; i++) {
    const now = performance.now();
    if (now - slice >= REGEX_RUN_DEFAULTS.screenSliceMs) {
      await yieldToLoop();
      slice = performance.now();
      if (signal?.aborted) return { stopped: abortedOutcome() };
      if (slice - started >= deadlineMs) return { stopped: screenTimeout(deadlineMs) };
    }
    const rule = rules[i] as RegexRule;
    if (rule === null || typeof rule !== "object")
      throw new TypeError(`rule ${i} is not an object`);
    const flags = rule.flags ?? "";
    const verdict = screenUserRegex(rule.pattern, flags, limits);
    if (!verdict.ok) {
      return {
        stopped: {
          status: "rejected",
          code: verdict.code,
          reason: `rule ${i}: ${verdict.reason}`,
          ...(verdict.fragment === undefined ? {} : { fragment: verdict.fragment }),
          ruleIndex: i,
        },
      };
    }
    out.push({ pattern: rule.pattern, flags });
  }
  return out;
}

function screenTimeout(deadlineMs: number): RegexOutcome<never> {
  return {
    status: "timeout",
    reason: `screening the patterns took longer than the ${deadlineMs} ms deadline, so whether they match is undetermined; nothing was run`,
    deadlineMs,
    completed: 0,
  };
}

function abortedOutcome(): RegexOutcome<never> {
  return {
    status: "error",
    code: "aborted",
    reason: "the run was aborted, so whether it matches is undetermined",
  };
}

async function prepare(request: RegexRequest): Promise<Prepared | RegexOutcome<never>> {
  const started = performance.now();
  const deadlineMs = option("deadlineMs", request.deadlineMs, REGEX_RUN_DEFAULTS.deadlineMs, 1);
  const maxInputChars = option(
    "maxInputChars",
    request.maxInputChars,
    REGEX_RUN_DEFAULTS.maxInputChars,
    0,
  );
  const giveUpMs = option("giveUpMs", request.giveUpMs, REGEX_RUN_DEFAULTS.giveUpMs, 1);
  const maxRunawayWorkers = option(
    "maxRunawayWorkers",
    request.maxRunawayWorkers,
    REGEX_RUN_DEFAULTS.maxRunawayWorkers,
    1,
  );
  const runawayKey = request.runawayKey ?? "";
  if (typeof runawayKey !== "string") throw new TypeError("runawayKey must be a string");
  const base = {
    op: request.op,
    giveUpMs,
    progressEveryMs: REGEX_RUN_DEFAULTS.progressEveryMs,
  };
  const done = (
    message: Record<string, unknown>,
    batch: BatchKind | undefined,
    patternCount = 1,
  ): Prepared => ({
    message,
    deadlineMs,
    screenMs: performance.now() - started,
    batch,
    patternCount,
    maxRunawayWorkers,
    runawayKey,
  });

  const tooLarge = (size: number): RegexOutcome<never> => ({
    status: "input-too-large",
    reason: `the input is ${size} characters; the limit is ${maxInputChars}`,
  });

  const batchOptions = (
    options: BatchOptions,
    inputs: ReadonlyArray<string>,
  ): { skip: boolean; maxItemChars: number } | RegexOutcome<never> => {
    const onGiveUp = options.onGiveUp ?? "stop";
    if (onGiveUp !== "stop" && onGiveUp !== "skip") {
      throw new RangeError(`onGiveUp must be "stop" or "skip", got ${String(onGiveUp)}`);
    }
    const maxItemChars = option(
      "maxItemChars",
      options.maxItemChars,
      REGEX_RUN_DEFAULTS.maxItemChars,
      0,
    );
    if (onGiveUp === "stop") {
      const index = inputs.findIndex((s) => s.length > maxItemChars);
      if (index !== -1) {
        return {
          status: "input-too-large",
          reason: `input ${index} is ${(inputs[index] as string).length} characters; the limit per input is ${maxItemChars} (onGiveUp "skip" would report it as undetermined instead)`,
          index,
        };
      }
    }
    return { skip: onGiveUp === "skip", maxItemChars };
  };

  if (request.op === "firstMatchingRule" || request.op === "testMatrix") {
    const rules = request.op === "firstMatchingRule" ? request.rules : request.patterns;
    const maxRules = option("maxRules", request.maxRules, REGEX_RUN_DEFAULTS.maxRules, 1);
    if (!Array.isArray(rules) || rules.length > maxRules) {
      return {
        status: "input-too-large",
        reason: `${Array.isArray(rules) ? rules.length : "no"} patterns; the limit is ${maxRules}`,
      };
    }
    const maxTotal = option(
      "maxTotalPatternChars",
      request.maxTotalPatternChars,
      REGEX_RUN_DEFAULTS.maxTotalPatternChars,
      0,
    );
    let total = 0;
    for (const rule of rules) total += typeof rule?.pattern === "string" ? rule.pattern.length : 0;
    if (total > maxTotal) {
      return {
        status: "input-too-large",
        reason: `the patterns total ${total} characters; the limit is ${maxTotal}`,
      };
    }
    const size = sizeOf(request.inputs, true);
    if (typeof size === "string") throw new TypeError(size);
    if (size > maxInputChars) return tooLarge(size);
    const batch = batchOptions(request, request.inputs);
    if ("status" in batch) return batch;
    const screened = await screenRules(rules, request.limits, started, deadlineMs, request.signal);
    if ("stopped" in screened) return screened.stopped;
    return done(
      {
        ...base,
        ...batch,
        [request.op === "firstMatchingRule" ? "rules" : "patterns"]: screened,
        inputs: request.inputs,
      },
      request.op,
      screened.length,
    );
  }

  const flags = request.flags ?? "";
  const compiled = screenUserRegex(request.pattern, flags, request.limits);
  if (!compiled.ok) {
    return {
      status: "rejected",
      code: compiled.code,
      reason: compiled.reason,
      ...(compiled.fragment === undefined ? {} : { fragment: compiled.fragment }),
    };
  }
  const withPattern = { ...base, pattern: request.pattern, flags };
  const maxMatches = (value: number | undefined): number =>
    Math.floor(option("maxMatches", value, REGEX_RUN_DEFAULTS.maxMatches, 0));
  const maxOutputChars = (value: number | undefined): number =>
    option("maxOutputChars", value, REGEX_RUN_DEFAULTS.maxOutputChars, 0);

  if (request.op === "testEach" || request.op === "replaceEach") {
    const size = sizeOf(request.inputs, true);
    if (typeof size === "string") throw new TypeError(size);
    if (size > maxInputChars) return tooLarge(size);
    const batch = batchOptions(request, request.inputs);
    if ("status" in batch) return batch;
    if (request.op === "testEach") {
      return done(
        {
          ...withPattern,
          ...batch,
          inputs: request.inputs,
          maxMatches: maxMatches(request.maxMatches),
        },
        "testEach",
      );
    }
    if (typeof request.replacement !== "string") {
      throw new TypeError("replacement must be a string");
    }
    return done(
      {
        ...withPattern,
        ...batch,
        inputs: request.inputs,
        replacement: request.replacement,
        maxOutputChars: maxOutputChars(request.maxOutputChars),
      },
      "replaceEach",
    );
  }

  const size = sizeOf([request.input], false);
  if (typeof size === "string") throw new TypeError(size);
  if (size > maxInputChars) return tooLarge(size);
  const single = { ...withPattern, input: request.input };
  switch (request.op) {
    case "test":
      return done(single, undefined);
    case "matchAll":
      return done(
        {
          ...single,
          maxMatches: maxMatches(request.maxMatches),
          maxOutputChars: maxOutputChars(request.maxOutputChars),
        },
        undefined,
      );
    case "replace":
      if (typeof request.replacement !== "string") {
        throw new TypeError("replacement must be a string");
      }
      return done(
        {
          ...single,
          replacement: request.replacement,
          maxOutputChars: maxOutputChars(request.maxOutputChars),
        },
        undefined,
      );
    case "split":
      return done(
        {
          ...single,
          limit: request.limit,
          maxMatches: maxMatches(request.maxMatches),
          maxOutputChars: maxOutputChars(request.maxOutputChars),
        },
        undefined,
      );
    default: {
      const unknownOp: never = request;
      throw new TypeError(`unknown regex op ${String((unknownOp as { op: unknown }).op)}`);
    }
  }
}

// ─── Sessions ───────────────────────────────────────────────────────────────

/**
 * One warm worker, reused for every run until a deadline kills it.
 *
 * Open one per tool call (or per batch of related calls) and close it when
 * done. Runs are queued, never concurrent: the worker is single-threaded, and
 * a deadline that terminates it must not take a neighbour's run down too.
 * Measured on an Apple-silicon Mac, Bun 1.3.14: ≈0.02 ms per warm run with
 * the pattern's screen verdict cached, ≈2.2 ms for a one-shot run that
 * starts its own worker.
 */
export type RegexSession = {
  run<R extends RegexRequest>(request: R): Promise<RegexOutcome<ResultOf<R>>>;
  /** Terminate the worker. Runs already queued resolve as `error`/`closed`. */
  close(): void;
};

export function openRegexSession(): RegexSession {
  let slot: Slot | undefined;
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  let nextId = 1;

  const runNow = async (request: RegexRequest): Promise<RegexOutcome<unknown>> => {
    if (closed) return { status: "error", code: "closed", reason: "the regex session is closed" };
    if (request.signal?.aborted) return abortedOutcome();
    const prepared = await prepare(request);
    if (!("message" in prepared)) return prepared;
    if (closed) return { status: "error", code: "closed", reason: "the regex session is closed" };
    if (request.signal?.aborted) return abortedOutcome();
    if (prepared.screenMs >= prepared.deadlineMs) return screenTimeout(prepared.deadlineMs);
    const busy = busyReason(prepared.runawayKey, prepared.maxRunawayWorkers);
    if (busy !== undefined) return { status: "error", code: "busy", reason: busy };
    if (slot === undefined || slot.exited) {
      const spawned = spawnSlot();
      if (typeof spawned === "string") {
        return {
          status: "error",
          code: "worker-unavailable",
          reason: `a regex worker could not be started: ${spawned}`,
        };
      }
      const failed = await waitReady(spawned, REGEX_RUN_DEFAULTS.startupTimeoutMs);
      if (failed !== undefined) {
        retire(spawned);
        return {
          status: "error",
          code: "worker-unavailable",
          reason: `a regex worker could not be started: ${failed}`,
        };
      }
      if (closed) {
        retire(spawned);
        return { status: "error", code: "closed", reason: "the regex session is closed" };
      }
      slot = spawned;
    }
    if (request.signal?.aborted) return abortedOutcome();
    return dispatch(slot, prepared, nextId++, request.signal, () => {
      slot = undefined;
    });
  };

  return {
    run<R extends RegexRequest>(request: R): Promise<RegexOutcome<ResultOf<R>>> {
      const result = queue.then(() => runNow(request));
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result as Promise<RegexOutcome<ResultOf<R>>>;
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (slot !== undefined) {
        const current = slot;
        slot = undefined;
        if (current.onMessage === undefined) {
          retire(current);
        } else {
          // Mid-run: the run resolves as closed; the thread may still be busy.
          const fail = current.onFailure;
          abandon(current);
          fail?.("the regex session was closed");
        }
      }
    },
  };
}

/** What a batch op has answered so far, rebuilt from its progress reports. */
type Progress = {
  completed: number;
  absorb(message: WorkerMessage): void;
  partial(): unknown;
};

function progressFor(prepared: Prepared): Progress | undefined {
  const lists = (message: WorkerMessage, key: string): unknown[] =>
    Array.isArray(message[key]) ? (message[key] as unknown[]) : [];
  switch (prepared.batch) {
    case undefined:
      return undefined;
    case "testEach": {
      const matched: number[] = [];
      const undetermined: number[] = [];
      return {
        completed: 0,
        absorb(message) {
          matched.push(...(lists(message, "matched") as number[]));
          undetermined.push(...(lists(message, "undetermined") as number[]));
        },
        partial() {
          return {
            matched: [...matched],
            scanned: this.completed,
            truncated: false,
            undetermined: [...undetermined],
          };
        },
      };
    }
    case "firstMatchingRule": {
      const ruleIndexes: Array<number | null> = [];
      const undetermined: number[] = [];
      return {
        completed: 0,
        absorb(message) {
          ruleIndexes.push(...(lists(message, "ruleIndexes") as Array<number | null>));
          undetermined.push(...(lists(message, "undetermined") as number[]));
        },
        partial() {
          return { ruleIndexes: [...ruleIndexes], undetermined: [...undetermined] };
        },
      };
    }
    case "testMatrix": {
      const hits: number[] = [];
      const unknown: number[] = [];
      const count = prepared.patternCount;
      return {
        completed: 0,
        absorb(message) {
          hits.push(...(lists(message, "hits") as number[]));
          unknown.push(...(lists(message, "unknown") as number[]));
        },
        partial() {
          return matrixResult(hits, unknown, count);
        },
      };
    }
    case "replaceEach": {
      const outputs: Array<string | null> = [];
      const undetermined: number[] = [];
      let replacements = 0;
      return {
        completed: 0,
        absorb(message) {
          outputs.push(...(lists(message, "outputs") as Array<string | null>));
          undetermined.push(...(lists(message, "undetermined") as number[]));
          replacements = Number(message["replacements"] ?? replacements);
        },
        partial() {
          return { outputs: [...outputs], replacements, undetermined: [...undetermined] };
        },
      };
    }
  }
}

/** Per-pattern lists from the worker's flat `[pattern, input, …]` pairs. */
function matrixResult(
  hits: ReadonlyArray<number>,
  unknown: ReadonlyArray<number>,
  count: number,
): TestMatrixResult {
  const matched: number[][] = Array.from({ length: count }, () => []);
  const undetermined: number[][] = Array.from({ length: count }, () => []);
  for (let k = 0; k + 1 < hits.length; k += 2)
    matched[hits[k] as number]?.push(hits[k + 1] as number);
  for (let k = 0; k + 1 < unknown.length; k += 2) {
    undetermined[unknown[k] as number]?.push(unknown[k + 1] as number);
  }
  return { matched, undetermined };
}

function dispatch(
  slot: Slot,
  prepared: Prepared,
  id: number,
  signal: AbortSignal | undefined,
  discard: () => void,
): Promise<RegexOutcome<unknown>> {
  return new Promise((resolve) => {
    let settled = false;
    const progress = progressFor(prepared);
    slot.runawayKey = prepared.runawayKey;
    const onAbort = (): void => {
      discard();
      abandon(slot);
      finish(abortedOutcome());
    };
    const finish = (outcome: RegexOutcome<unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      slot.onMessage = undefined;
      slot.onFailure = undefined;
      resolve(outcome);
    };

    // The screen already spent part of the deadline.
    const budget = Math.max(1, prepared.deadlineMs - prepared.screenMs);
    const timer = setTimeout(() => {
      discard();
      abandon(slot);
      const reason = `the pattern did not finish within ${prepared.deadlineMs} ms, so whether it matches is undetermined; the worker running it was stopped`;
      finish(
        progress === undefined
          ? { status: "timeout", reason, deadlineMs: prepared.deadlineMs }
          : {
              status: "timeout",
              reason,
              deadlineMs: prepared.deadlineMs,
              completed: progress.completed,
              partial: progress.partial(),
            },
      );
    }, budget);
    signal?.addEventListener("abort", onAbort, { once: true });

    slot.onFailure = (why) => {
      discard();
      abandon(slot);
      finish({
        status: "error",
        code: why.includes("closed") ? "closed" : "worker-crashed",
        reason: why,
      });
    };

    slot.onMessage = (message) => {
      if (message.id !== id) return;
      if (message.kind === "progress") {
        if (progress !== undefined) {
          progress.completed = message["completed"] as number;
          progress.absorb(message);
        }
        return;
      }
      if (message.kind === "done") finish(fromWorker(message, prepared));
    };

    try {
      slot.worker.postMessage({ ...prepared.message, id });
    } catch (err) {
      discard();
      retire(slot);
      finish({
        status: "error",
        code: "worker-crashed",
        reason: `the request could not be sent to the worker: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}

/** A batch result or partial in the shape the caller sees. */
function shapeResult(value: unknown, prepared: Prepared): unknown {
  if (prepared.batch !== "testMatrix" || value === null || typeof value !== "object") return value;
  const raw = value as { hits?: number[]; unknown?: number[] };
  return matrixResult(raw.hits ?? [], raw.unknown ?? [], prepared.patternCount);
}

function fromWorker(message: WorkerMessage, prepared: Prepared): RegexOutcome<unknown> {
  const status = message["status"];
  const elapsedMs = Number(message["elapsedMs"] ?? 0);
  if (status === "ok") {
    return { status: "ok", result: shapeResult(message["result"], prepared), elapsedMs };
  }
  if (status === "gave-up") {
    const execMs = Math.round(Number(message["execMs"] ?? 0));
    const index = message["index"] as number | undefined;
    const ruleIndex = message["ruleIndex"] as number | undefined;
    const where =
      index === undefined
        ? ""
        : ` on input ${index}${ruleIndex === undefined ? "" : ` (rule ${ruleIndex})`}`;
    return {
      status: "gave-up",
      reason: `the regex engine abandoned the match${where} after ${execMs} ms and reported "no match" — JavaScriptCore does that when a pattern exceeds its backtracking budget — so whether it matches is undetermined; simplify the pattern`,
      execMs,
      ...(index === undefined ? {} : { index }),
      ...(ruleIndex === undefined ? {} : { ruleIndex }),
      ...(message["partial"] === undefined
        ? {}
        : { partial: shapeResult(message["partial"], prepared) }),
    };
  }
  if (status === "output-too-large") {
    return {
      status: "output-too-large",
      reason: "the result would exceed maxOutputChars; it was not produced rather than cut short",
    };
  }
  if (status === "item-too-large") {
    return { status: "input-too-large", reason: "an input is longer than maxItemChars" };
  }
  return {
    status: "error",
    code: "exec-threw",
    reason: String(message["reason"] ?? "the regex engine failed"),
  };
}

/**
 * Run one request on a fresh worker and stop it afterwards. Costs a worker
 * start (≈2.2 ms in all); a tool making several calls should hold a session
 * ({@link openRegexSession}) or use a batch op (`testEach`,
 * `firstMatchingRule`, `testMatrix`, `replaceEach`) instead.
 */
export async function runRegex<R extends RegexRequest>(
  request: R,
): Promise<RegexOutcome<ResultOf<R>>> {
  const session = openRegexSession();
  try {
    return await session.run(request);
  } finally {
    session.close();
  }
}
