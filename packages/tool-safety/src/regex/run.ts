import { type RegexLimits, type RegexRejectCode, compileUserRegex } from "./screen";
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
 *     one over a long input (`\s+$|x` on 80 000 spaces) it can be seconds to
 *     minutes. `maxInputChars` bounds that, and {@link regexWorkerCounts}
 *     reports such "runaway" threads. Past `maxRunawayWorkers` of them a new
 *     run is refused with `error`/`busy` rather than stacking more.
 *   - A terminated worker does not hold the process open (it is `unref`ed).
 *
 * THE ANSWER IS TRI-STATE. `status: "ok"` is the only outcome that carries a
 * definite answer. Every other status means "could not tell", and a caller
 * must never read it as "no match" — see {@link regexVerdict} and the README
 * for how each kind of tool should surface it.
 */

export type RegexOp = "test" | "matchAll" | "replace" | "split" | "testEach" | "firstMatchingRule";

type CommonOptions = {
  /** Wall-clock budget for the match itself, worker start-up excluded. Default 1000. */
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
  /** Refuse to start while this many abandoned workers are still running. Default 2. */
  readonly maxRunawayWorkers?: number;
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
export type TestEachRequest = OnePattern & {
  readonly op: "testEach";
  readonly inputs: ReadonlyArray<string>;
  /** Stop after this many matching inputs and set `truncated`. Default 10 000. */
  readonly maxMatches?: number;
};

export type RegexRule = { readonly pattern: string; readonly flags?: string };

/** Many patterns over many inputs: for each input, the first rule that matches. */
export type FirstMatchingRuleRequest = CommonOptions & {
  readonly op: "firstMatchingRule";
  readonly rules: ReadonlyArray<RegexRule>;
  readonly inputs: ReadonlyArray<string>;
  /** Default 1000. */
  readonly maxRules?: number;
};

export type RegexRequest =
  | TestRequest
  | MatchAllRequest
  | ReplaceRequest
  | SplitRequest
  | TestEachRequest
  | FirstMatchingRuleRequest;

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
  /** How many inputs were answered — all of them unless `truncated`. */
  readonly scanned: number;
  readonly truncated: boolean;
};

export type FirstMatchingRuleResult = {
  /** Per input, the index of the first matching rule, or -1 when none matched. */
  readonly ruleIndexes: ReadonlyArray<number>;
};

type ResultByOp = {
  readonly test: TestResult;
  readonly matchAll: MatchAllResult;
  readonly replace: ReplaceResult;
  readonly split: SplitResult;
  readonly testEach: TestEachResult;
  readonly firstMatchingRule: FirstMatchingRuleResult;
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
  | "closed";

export type RegexOutcome<T> =
  | { readonly status: "ok"; readonly result: T; readonly elapsedMs: number }
  | {
      readonly status: "rejected";
      readonly code: RegexRejectCode;
      readonly reason: string;
      readonly fragment?: string;
      /** For `firstMatchingRule`: which rule. */
      readonly ruleIndex?: number;
    }
  | { readonly status: "input-too-large"; readonly reason: string }
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
      /** `firstMatchingRule`: the rule it gave up on. */
      readonly ruleIndex?: number;
      /** What was determined before it. */
      readonly partial?: T;
    }
  | { readonly status: "error"; readonly code: RegexErrorCode; readonly reason: string };

export const REGEX_RUN_DEFAULTS = {
  deadlineMs: 1_000,
  maxInputChars: 1_000_000,
  giveUpMs: 100,
  maxMatches: 10_000,
  maxOutputChars: 2_000_000,
  maxRules: 1_000,
  maxRunawayWorkers: 2,
  /** How long a fresh worker may take to report ready before it counts as unavailable. */
  startupTimeoutMs: 10_000,
  /** How often a batch op reports progress, so a timeout can say how far it got. */
  progressEveryMs: 10,
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
    exited: false,
    onMessage: undefined,
    onFailure: undefined,
  };
  worker.addEventListener("close", () => {
    if (slot.exited) return;
    slot.exited = true;
    counts.live -= 1;
    if (slot.runaway) counts.runaway -= 1;
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

/** Stop a worker that is (or may be) still matching. */
function abandon(slot: Slot): void {
  slot.onMessage = undefined;
  slot.onFailure = undefined;
  if (!slot.exited && !slot.runaway) {
    slot.runaway = true;
    counts.runaway += 1;
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

// ─── Request preparation (synchronous, on the caller's thread) ──────────────

type Prepared = {
  readonly message: Record<string, unknown>;
  readonly deadlineMs: number;
  readonly batch: "testEach" | "firstMatchingRule" | undefined;
  readonly maxRunawayWorkers: number;
};

function option(name: string, value: number | undefined, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || Number.isNaN(value) || value < min) {
    throw new RangeError(`${name} must be a number >= ${min}, got ${String(value)}`);
  }
  return value;
}

function sizeOf(inputs: ReadonlyArray<unknown>, batch: boolean): number | string {
  let total = 0;
  for (let i = 0; i < inputs.length; i++) {
    const s = inputs[i];
    if (typeof s !== "string") return `input ${i} is not a string`;
    total += s.length + (batch ? 1 : 0);
  }
  return total;
}

function prepare(request: RegexRequest): Prepared | RegexOutcome<never> {
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
  const base = {
    op: request.op,
    giveUpMs,
    progressEveryMs: REGEX_RUN_DEFAULTS.progressEveryMs,
  };

  const tooLarge = (size: number): RegexOutcome<never> => ({
    status: "input-too-large",
    reason: `the input is ${size} characters; the limit is ${maxInputChars}`,
  });

  if (request.op === "firstMatchingRule") {
    const maxRules = option("maxRules", request.maxRules, REGEX_RUN_DEFAULTS.maxRules, 1);
    if (!Array.isArray(request.rules) || request.rules.length > maxRules) {
      return {
        status: "input-too-large",
        reason: `${Array.isArray(request.rules) ? request.rules.length : "no"} rules; the limit is ${maxRules}`,
      };
    }
    const rules: Array<{ pattern: string; flags: string }> = [];
    for (let i = 0; i < request.rules.length; i++) {
      const rule = request.rules[i] as RegexRule;
      const flags = rule.flags ?? "";
      const compiled = compileUserRegex(rule.pattern, flags, request.limits);
      if (!compiled.ok) {
        return {
          status: "rejected",
          code: compiled.code,
          reason: `rule ${i}: ${compiled.reason}`,
          ...(compiled.fragment === undefined ? {} : { fragment: compiled.fragment }),
          ruleIndex: i,
        };
      }
      rules.push({ pattern: rule.pattern, flags });
    }
    const size = sizeOf(request.inputs, true);
    if (typeof size === "string") throw new TypeError(size);
    if (size > maxInputChars) return tooLarge(size);
    return {
      message: { ...base, rules, inputs: request.inputs },
      deadlineMs,
      batch: "firstMatchingRule",
      maxRunawayWorkers,
    };
  }

  const flags = request.flags ?? "";
  const compiled = compileUserRegex(request.pattern, flags, request.limits);
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

  if (request.op === "testEach") {
    const size = sizeOf(request.inputs, true);
    if (typeof size === "string") throw new TypeError(size);
    if (size > maxInputChars) return tooLarge(size);
    return {
      message: {
        ...withPattern,
        inputs: request.inputs,
        maxMatches: maxMatches(request.maxMatches),
      },
      deadlineMs,
      batch: "testEach",
      maxRunawayWorkers,
    };
  }

  const size = sizeOf([request.input], false);
  if (typeof size === "string") throw new TypeError(size);
  if (size > maxInputChars) return tooLarge(size);
  const single = { ...withPattern, input: request.input };
  switch (request.op) {
    case "test":
      return { message: single, deadlineMs, batch: undefined, maxRunawayWorkers };
    case "matchAll":
      return {
        message: {
          ...single,
          maxMatches: maxMatches(request.maxMatches),
          maxOutputChars: maxOutputChars(request.maxOutputChars),
        },
        deadlineMs,
        batch: undefined,
        maxRunawayWorkers,
      };
    case "replace":
      if (typeof request.replacement !== "string") {
        throw new TypeError("replacement must be a string");
      }
      return {
        message: {
          ...single,
          replacement: request.replacement,
          maxOutputChars: maxOutputChars(request.maxOutputChars),
        },
        deadlineMs,
        batch: undefined,
        maxRunawayWorkers,
      };
    case "split":
      return {
        message: {
          ...single,
          limit: request.limit,
          maxMatches: maxMatches(request.maxMatches),
          maxOutputChars: maxOutputChars(request.maxOutputChars),
        },
        deadlineMs,
        batch: undefined,
        maxRunawayWorkers,
      };
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
 * Measured on an Apple-silicon Mac, Bun 1.3.14: ≈0.02 ms per warm run,
 * ≈2.2 ms for a one-shot run that starts its own worker.
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
    const prepared = prepare(request);
    if (!("message" in prepared)) return prepared;
    if (counts.runaway >= prepared.maxRunawayWorkers) {
      return {
        status: "error",
        code: "busy",
        reason: `${counts.runaway} regex worker(s) abandoned at a deadline are still running; refusing to start another until one exits`,
      };
    }
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
    return dispatch(slot, prepared, nextId++, () => {
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

function dispatch(
  slot: Slot,
  prepared: Prepared,
  id: number,
  discard: () => void,
): Promise<RegexOutcome<unknown>> {
  return new Promise((resolve) => {
    let settled = false;
    let completed = 0;
    const matched: number[] = [];
    const ruleIndexes: number[] = [];
    const finish = (outcome: RegexOutcome<unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      slot.onMessage = undefined;
      slot.onFailure = undefined;
      resolve(outcome);
    };
    const partialSoFar = (): unknown =>
      prepared.batch === "testEach"
        ? { matched: [...matched], scanned: completed, truncated: false }
        : { ruleIndexes: [...ruleIndexes] };

    const timer = setTimeout(() => {
      discard();
      abandon(slot);
      const reason = `the pattern did not finish within ${prepared.deadlineMs} ms, so whether it matches is undetermined; the worker running it was stopped`;
      finish(
        prepared.batch === undefined
          ? { status: "timeout", reason, deadlineMs: prepared.deadlineMs }
          : {
              status: "timeout",
              reason,
              deadlineMs: prepared.deadlineMs,
              completed,
              partial: partialSoFar(),
            },
      );
    }, prepared.deadlineMs);

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
        completed = message["completed"] as number;
        if (Array.isArray(message["matched"])) matched.push(...(message["matched"] as number[]));
        if (Array.isArray(message["ruleIndexes"])) {
          ruleIndexes.push(...(message["ruleIndexes"] as number[]));
        }
        return;
      }
      if (message.kind === "done") finish(fromWorker(message));
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

function fromWorker(message: WorkerMessage): RegexOutcome<unknown> {
  const status = message["status"];
  const elapsedMs = Number(message["elapsedMs"] ?? 0);
  if (status === "ok") return { status: "ok", result: message["result"], elapsedMs };
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
      ...(message["partial"] === undefined ? {} : { partial: message["partial"] }),
    };
  }
  if (status === "output-too-large") {
    return {
      status: "output-too-large",
      reason: "the result would exceed maxOutputChars; it was not produced rather than cut short",
    };
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
 * `firstMatchingRule`) instead.
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
