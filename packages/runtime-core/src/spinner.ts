/**
 * Transient "working" indicator for the interactive CLI surface.
 *
 * The chat loop has silent waits where the terminal would otherwise show
 * nothing while the agent is busy:
 *   - waiting on the model's first token ("thinking")
 *   - running a tool to completion ("running bash")
 *   - retrying after a transient error / compacting context
 *
 * This module renders an animated spinner + a short label during those
 * waits, then erases itself the moment real output begins so the streamed
 * answer is never polluted by control codes.
 *
 * Design / safety:
 * - **TTY-only, opt-out via env.** `isSpinnerEnabled()` returns false for
 *   piped/redirected stdout, `TERM=dumb`, and when `CREWHAUS_SPINNER` is set
 *   to a falsy value. Non-interactive runs (tests, CI, channel/voice/workflow
 *   targets, piped input) therefore get byte-identical output to before — the
 *   chat loop additionally disables it for `singleTurn` and injected-input
 *   runs (see `runChatLoop`). `NO_COLOR` degrades to a monochrome animation.
 * - **Single line, redraw-in-place.** Each tick rewrites the current line
 *   with `\r` + clear-to-EOL. A `prefix` (e.g. `"agent> "`) is preserved
 *   across redraws and left behind on `stop()` so the assistant label
 *   survives and streamed text continues the same line.
 * - **Foreign-write aware.** `write()` is the one sink every interactive
 *   stdout write should pass through while a spinner may be live: it erases
 *   the spinner line before emitting, so status lines (`[tool: …]`) and the
 *   animation never collide. The interval redraws on its next tick.
 * - **Cursor-safe.** Hides the cursor while spinning and always restores it
 *   on `stop()`, so an aborted run never leaves the cursor hidden.
 * - **Never holds the event loop open.** The interval is `unref()`'d.
 * - **Zero deps, injectable.** Sink, clock, and timers are all overridable so
 *   the animation is deterministically testable without a real terminal.
 */

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
/** Carriage return + erase-to-end-of-line: rewind and clear the live line. */
const CLEAR_LINE = "\r\x1b[K";

const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

/** Classic braille spinner — one glyph wide, present in every modern font. */
const DEFAULT_FRAMES: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const DEFAULT_INTERVAL_MS = 80;

/** Minimal shape of a timer handle we depend on (Node `Timeout` / Bun `Timer`). */
interface IntervalHandle {
  unref?: () => void;
}

export interface Spinner {
  /**
   * Begin spinning with `label`, or relabel + redraw if already active.
   * No-op when the output is disabled. `prefix` (default: keep current) is
   * redrawn on every frame and left on screen when the spinner stops, so a
   * caller can write e.g. `"agent> "` and have it survive the animation.
   */
  start(label: string, opts?: { readonly prefix?: string }): void;
  /** Update the label in place without restarting the animation. No-op when inactive. */
  setLabel(label: string): void;
  /**
   * Erase the spinner glyph (keeping any `prefix`), restore the cursor, and
   * stop the animation. Idempotent — safe to call when never started.
   */
  stop(): void;
  /** True while the animation is running. */
  readonly active: boolean;
}

export interface CliOutput {
  /**
   * Spinner-aware stdout write. When a spinner is live, the current line is
   * erased before `s` is emitted; the animation redraws on its next tick.
   * When no spinner is active this is a plain pass-through to the sink.
   */
  write(s: string): void;
  /** The spinner bound to this output. */
  readonly spinner: Spinner;
}

export interface CliOutputOptions {
  /**
   * Whether the spinner animates at all. When false, `start`/`setLabel`/`stop`
   * are no-ops and `write` is a plain pass-through — so the byte stream is
   * identical to having no spinner. Defaults to `isSpinnerEnabled()`.
   */
  readonly enabled?: boolean;
  /** Raw output sink. Defaults to `process.stdout.write`. */
  readonly write?: (s: string) => void;
  /** Animation frames. Defaults to a braille spinner. */
  readonly frames?: readonly string[];
  /** Frame interval in ms. Defaults to 80. */
  readonly intervalMs?: number;
  /** Emit ANSI color. Defaults to `!process.env.NO_COLOR`. */
  readonly color?: boolean;
  /** Monotonic clock for the elapsed-time readout. Defaults to `performance.now`. */
  readonly now?: () => number;
  /** Injectable `setInterval` (testing). Defaults to the global. */
  readonly setIntervalImpl?: (fn: () => void, ms: number) => IntervalHandle;
  /** Injectable `clearInterval` (testing). Defaults to the global. */
  readonly clearIntervalImpl?: (handle: IntervalHandle) => void;
}

/**
 * Construct a spinner-aware CLI output. The returned `write` and `spinner`
 * share one line of the terminal: writes erase the live animation, and the
 * animation redraws after them.
 */
export function createCliOutput(opts: CliOutputOptions = {}): CliOutput {
  const rawWrite = opts.write ?? ((s: string) => void process.stdout.write(s));
  const enabled = opts.enabled ?? isSpinnerEnabled();
  const frames = opts.frames && opts.frames.length > 0 ? opts.frames : DEFAULT_FRAMES;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const color = opts.color ?? !process.env["NO_COLOR"];
  const now = opts.now ?? (() => performance.now());
  const setIntervalImpl =
    opts.setIntervalImpl ??
    ((fn: () => void, ms: number) => setInterval(fn, ms) as unknown as IntervalHandle);
  const clearIntervalImpl =
    opts.clearIntervalImpl ??
    ((handle: IntervalHandle) =>
      clearInterval(handle as unknown as ReturnType<typeof setInterval>));

  // Color helpers collapse to identity when color is off (NO_COLOR), so the
  // animation still shows — just monochrome.
  const dim = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const accent = (s: string): string => (color ? `${CYAN}${s}${RESET}` : s);

  let handle: IntervalHandle | undefined;
  let frame = 0;
  let label = "";
  let prefix = "";
  let startedAt = 0;
  let active = false;

  function render(): void {
    const glyph = frames[frame % frames.length] ?? "";
    const elapsedMs = now() - startedAt;
    // Only surface elapsed seconds once it's worth reading, so quick turns
    // don't flash "(0s)".
    const elapsed = elapsedMs >= 1000 ? ` ${dim(`(${Math.floor(elapsedMs / 1000)}s)`)}` : "";
    rawWrite(`${CLEAR_LINE}${prefix}${accent(glyph)} ${dim(`${label}…`)}${elapsed}`);
  }

  const spinner: Spinner = {
    get active(): boolean {
      return active;
    },
    start(newLabel: string, startOpts?: { readonly prefix?: string }): void {
      if (!enabled) return;
      label = newLabel;
      if (startOpts?.prefix !== undefined) prefix = startOpts.prefix;
      if (active) {
        render();
        return;
      }
      active = true;
      frame = 0;
      startedAt = now();
      rawWrite(HIDE_CURSOR);
      render();
      handle = setIntervalImpl(() => {
        frame += 1;
        render();
      }, intervalMs);
      // Never let the heartbeat keep an otherwise-idle process alive.
      handle.unref?.();
    },
    setLabel(newLabel: string): void {
      if (!active) return;
      label = newLabel;
      render();
    },
    stop(): void {
      if (!active) return;
      active = false;
      if (handle !== undefined) {
        clearIntervalImpl(handle);
        handle = undefined;
      }
      // Erase the glyph, keep the prefix, restore the cursor. The cursor sits
      // right after `prefix`, so streamed text continues the same line.
      rawWrite(`${CLEAR_LINE}${prefix}${SHOW_CURSOR}`);
      prefix = "";
    },
  };

  return {
    spinner,
    write(s: string): void {
      // Erase the live animation before foreign output so they never overlap;
      // the interval redraws on its next tick (on whatever line we leave the
      // cursor — newline-terminated status lines therefore stack cleanly above
      // the animation).
      if (active) rawWrite(CLEAR_LINE);
      rawWrite(s);
    },
  };
}

/**
 * Decide whether the working-indicator spinner should animate, based on env
 * and TTY. Centralized so callers don't repeat the parse.
 *
 * Disabled when: stdout is not a TTY (pipes, redirects, CI, tests); the
 * terminal is `dumb`; or `CREWHAUS_SPINNER` is `0`/`false`/`off`/`no`. Any
 * other explicit `CREWHAUS_SPINNER` value forces it on (still TTY-gated).
 */
export function isSpinnerEnabled(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = Boolean(process.stdout.isTTY),
): boolean {
  const raw = env["CREWHAUS_SPINNER"];
  if (raw !== undefined) {
    const v = raw.trim().toLowerCase();
    if (v === "0" || v === "false" || v === "off" || v === "no") return false;
    return isTTY;
  }
  if (!isTTY) return false;
  if ((env["TERM"] ?? "").toLowerCase() === "dumb") return false;
  return true;
}
