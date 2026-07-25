/**
 * Item 1 — the one-keystroke exit rating prompt, owned by the RUNTIME so both
 * cli surfaces get it.
 *
 * The spec's `feedback:` block declares that a harness collects human ratings
 * on responses. Until now only `crewhaus run` honoured it: the prompt lived in
 * the CLI's own post-session teardown, and the cli emitter dropped the block
 * entirely — a compiled bundle had no rating prompt, so the improvement
 * contract the spec advertised silently vanished from the shipped artifact.
 * The prompt belongs where the REPL is, and the REPL is `runChatLoop`, so it
 * lives here and both surfaces reach it by threading `feedback` into the loop.
 *
 * On a CLEAN REPL exit (the loop returned — not aborted, not thrown) with at
 * least one assistant answer, a TTY stdin, and no opt-out, the runtime asks
 *
 *     rate this session? [g]ood / [b]ad / [enter] skip:
 *
 * and appends the answer as the SAME durable `user_feedback` event-log record
 * `crewhaus rate` writes (`source: "cli"`, rating the last turn) — so
 * `crewhaus rate`/`feedback`/`distill` and `optimize --ratings` read a
 * compiled bundle's ratings exactly as they read an interpreted run's.
 *
 * Opt out with `CREWHAUS_NO_EXIT_RATING=1` or spec `feedback.exitPrompt:
 * false`. NEVER prompts in non-TTY/piped mode, so scripts and CI are unaffected.
 *
 * Everything decidable is a pure function here (unit-tested); the raw-mode
 * keystroke read is the one thin IO helper.
 */
import { randomBytes } from "node:crypto";

/** Opt-out env for the exit rating prompt. */
export const NO_EXIT_RATING_ENV = "CREWHAUS_NO_EXIT_RATING";

export const EXIT_RATING_PROMPT = "rate this session? [g]ood / [b]ad / [enter] skip: ";

export const EXIT_RATING_TIMEOUT_MS = 10_000;

/** The event-log EventKind a rating is persisted under (mirrors the CLI's
 *  `FEEDBACK_EVENT_KIND` and the channel target's reaction codegen). */
export const FEEDBACK_EVENT_KIND = "user_feedback" as const;

/**
 * The subset of the spec's `feedback:` block (IR `IrFeedback`) the runtime
 * needs. Presence of the block is the opt-in; `enabled: false` disables the
 * whole contract and `exitPrompt: false` disables just the prompt.
 */
export type ExitRatingFeedback = {
  readonly enabled?: boolean;
  readonly exitPrompt?: boolean;
};

export type ExitRatingDecision = {
  readonly prompt: boolean;
  readonly reason: string;
};

/**
 * The pure gate. Prompts only when ALL hold: the spec has a feedback block
 * (presence opts in), it isn't disabled (`enabled: false`) or prompt-opted-out
 * (`exitPrompt: false`), `CREWHAUS_NO_EXIT_RATING` is not set, the loop exited
 * cleanly (an aborted or crashed run is not a session anyone wants to rate),
 * stdin is a real TTY (NEVER in piped/CI mode), and the session produced at
 * least one assistant answer.
 */
export function shouldPromptExitRating(opts: {
  readonly stdinIsTTY: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly feedback: ExitRatingFeedback | undefined;
  readonly assistantTurns: number;
  readonly cleanExit: boolean;
}): ExitRatingDecision {
  if (opts.feedback === undefined) return { prompt: false, reason: "spec has no feedback block" };
  if (opts.feedback.enabled === false) {
    return { prompt: false, reason: "feedback block is disabled (enabled: false)" };
  }
  if (opts.feedback.exitPrompt === false) {
    return { prompt: false, reason: "feedback.exitPrompt is false" };
  }
  const optOut = opts.env[NO_EXIT_RATING_ENV];
  if (optOut !== undefined && optOut !== "" && optOut !== "0") {
    return { prompt: false, reason: `${NO_EXIT_RATING_ENV} is set` };
  }
  if (!opts.cleanExit) return { prompt: false, reason: "run did not exit cleanly" };
  if (!opts.stdinIsTTY) return { prompt: false, reason: "stdin is not a TTY" };
  if (opts.assistantTurns < 1) {
    return { prompt: false, reason: "session has no assistant turns to rate" };
  }
  return { prompt: true, reason: "feedback block present, TTY, rated-able session" };
}

export type ExitRatingChoice = "up" | "down" | "skip";

/** Map the raw keystroke to a rating: g/G → good (thumbs up), b/B → bad
 *  (thumbs down), anything else — enter, timeout (undefined), Ctrl-C/D —
 *  skips. One keystroke, no confirmation, zero-cost to ignore. */
export function parseExitRatingKey(key: string | undefined): ExitRatingChoice {
  if (key === undefined || key.length === 0) return "skip";
  const first = key[0] as string;
  if (first === "g" || first === "G") return "up";
  if (first === "b" || first === "B") return "down";
  return "skip";
}

/**
 * The `user_feedback` payload for an exit rating — byte-compatible with the
 * record `crewhaus rate --thumbs` builds, so one distill reads both.
 */
export function buildExitRatingRecord(input: {
  readonly sessionId: string;
  readonly turnNumber: number;
  readonly thumbs: "up" | "down";
  readonly id?: string;
  readonly ts?: string;
}): {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  turnNumber: number;
  modality: "binary";
  rating: { thumbs: "up" | "down" };
  source: "cli";
  ts: string;
} {
  return {
    schemaVersion: 1,
    id: input.id ?? `fb_${randomBytes(6).toString("hex")}`,
    sessionId: input.sessionId,
    turnNumber: input.turnNumber,
    modality: "binary",
    rating: { thumbs: input.thumbs },
    source: "cli",
    ts: input.ts ?? new Date().toISOString(),
  };
}

export type ExitRatingRecord = ReturnType<typeof buildExitRatingRecord>;

/**
 * The whole prompt, with every IO edge injected so the decision + append are
 * unit-testable without a TTY. Returns the recorded choice, or `undefined`
 * when the gate declined to prompt.
 *
 * Best-effort by contract: `readKey`/`append` failures are surfaced to the
 * caller's `onError` (the runtime logs a warning) and never propagate — a
 * rating prompt must not turn a clean session into a failed one.
 */
export async function runExitRating(opts: {
  readonly feedback: ExitRatingFeedback | undefined;
  readonly stdinIsTTY: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly assistantTurns: number;
  readonly cleanExit: boolean;
  readonly sessionId: string;
  readonly turnNumber: number;
  /** Reads one keystroke; defaults to the raw-mode {@link readExitRatingKey}. */
  readonly readKey?: () => Promise<string | undefined>;
  readonly append: (record: ExitRatingRecord) => Promise<void>;
  readonly write: (line: string) => void;
  readonly onError?: (err: unknown) => void;
}): Promise<ExitRatingChoice | undefined> {
  const decision = shouldPromptExitRating({
    stdinIsTTY: opts.stdinIsTTY,
    env: opts.env,
    feedback: opts.feedback,
    assistantTurns: opts.assistantTurns,
    cleanExit: opts.cleanExit,
  });
  if (!decision.prompt) return undefined;
  try {
    const choice = parseExitRatingKey(await (opts.readKey ?? readExitRatingKey)());
    if (choice === "skip") return "skip";
    await opts.append(
      buildExitRatingRecord({
        sessionId: opts.sessionId,
        turnNumber: opts.turnNumber,
        thumbs: choice,
      }),
    );
    opts.write(
      `[feedback] recorded ${choice === "up" ? "good" : "bad"} on ${opts.sessionId} turn ${opts.turnNumber}\n`,
    );
    return choice;
  } catch (err) {
    opts.onError?.(err);
    return undefined;
  }
}

/**
 * One raw-mode keystroke with a timeout (undefined on timeout or when stdin
 * is unusable). Thin IO by design — the gate and the key mapping above are
 * the unit-tested pure functions.
 */
export async function readExitRatingKey(
  timeoutMs: number = EXIT_RATING_TIMEOUT_MS,
): Promise<string | undefined> {
  const stdin = process.stdin;
  if (stdin.isTTY !== true || stdin.destroyed) return undefined;
  process.stdout.write(EXIT_RATING_PROMPT);
  return await new Promise<string | undefined>((resolveKey) => {
    let done = false;
    const finish = (v: string | undefined): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.off("data", onData);
      if (typeof stdin.setRawMode === "function") stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      resolveKey(v);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    const onData = (chunk: Buffer | string): void => finish(chunk.toString());
    if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}
