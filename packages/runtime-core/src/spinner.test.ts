import { describe, expect, test } from "bun:test";
import { type CliOutputOptions, createCliOutput, isSpinnerEnabled } from "./spinner";

const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
const CLEAR = "\r\x1b[K";

/**
 * Deterministic harness: captures every raw write, drives the animation tick
 * by hand, and exposes a mutable clock — so the spinner is testable without a
 * real TTY or wall-clock timers.
 */
function harness(overrides: Partial<CliOutputOptions> = {}) {
  const writes: string[] = [];
  let tickFn: (() => void) | undefined;
  let clearedCount = 0;
  let unrefCount = 0;
  let clock = 0;
  const out = createCliOutput({
    enabled: true,
    color: false,
    frames: ["A", "B", "C"],
    intervalMs: 80,
    now: () => clock,
    write: (s) => {
      writes.push(s);
    },
    setIntervalImpl: (fn) => {
      tickFn = fn;
      return {
        unref: () => {
          unrefCount += 1;
        },
      };
    },
    clearIntervalImpl: () => {
      clearedCount += 1;
      tickFn = undefined;
    },
    ...overrides,
  });
  return {
    out,
    writes,
    tick: () => tickFn?.(),
    setClock: (n: number) => {
      clock = n;
    },
    get clearedCount() {
      return clearedCount;
    },
    get unrefCount() {
      return unrefCount;
    },
    get hasTimer() {
      return tickFn !== undefined;
    },
  };
}

describe("createCliOutput — disabled", () => {
  test("start/setLabel/stop are no-ops and write passes through verbatim", () => {
    const h = harness({ enabled: false });
    h.out.spinner.start("thinking", { prefix: "agent> " });
    h.out.spinner.setLabel("working");
    h.out.write("hello");
    h.out.spinner.stop();
    expect(h.out.spinner.active).toBe(false);
    // No cursor codes, no clears — exactly the bytes that were written.
    expect(h.writes).toEqual(["hello"]);
    expect(h.hasTimer).toBe(false);
  });
});

describe("createCliOutput — enabled animation", () => {
  test("start hides the cursor, renders the first frame with prefix+label, and unrefs the timer", () => {
    const h = harness();
    h.out.spinner.start("thinking", { prefix: "agent> " });
    expect(h.out.spinner.active).toBe(true);
    expect(h.writes[0]).toBe(HIDE);
    expect(h.writes[1]).toBe(`${CLEAR}agent> A thinking…`);
    expect(h.unrefCount).toBe(1);
    expect(h.hasTimer).toBe(true);
  });

  test("each tick advances the frame and redraws in place", () => {
    const h = harness();
    h.out.spinner.start("thinking", { prefix: "agent> " });
    h.tick();
    h.tick();
    expect(h.writes.at(-2)).toBe(`${CLEAR}agent> B thinking…`);
    expect(h.writes.at(-1)).toBe(`${CLEAR}agent> C thinking…`);
  });

  test("setLabel updates the text without restarting the timer", () => {
    const h = harness();
    h.out.spinner.start("thinking", { prefix: "agent> " });
    const before = h.clearedCount;
    h.out.spinner.setLabel("running bash");
    expect(h.writes.at(-1)).toBe(`${CLEAR}agent> A running bash…`);
    expect(h.clearedCount).toBe(before); // no new interval churn
  });

  test("relabel via start() keeps the same timer and prefix", () => {
    const h = harness();
    h.out.spinner.start("thinking", { prefix: "agent> " });
    h.out.spinner.start("running 2 tools"); // no prefix override
    expect(h.writes.at(-1)).toBe(`${CLEAR}agent> A running 2 tools…`);
    expect(h.clearedCount).toBe(0);
  });

  test("stop clears the interval, erases the glyph, keeps the prefix, restores the cursor; idempotent", () => {
    const h = harness();
    h.out.spinner.start("thinking", { prefix: "agent> " });
    h.out.spinner.stop();
    expect(h.out.spinner.active).toBe(false);
    expect(h.clearedCount).toBe(1);
    expect(h.writes.at(-1)).toBe(`${CLEAR}agent> ${SHOW}`);
    const n = h.writes.length;
    h.out.spinner.stop(); // second stop is a no-op
    expect(h.writes.length).toBe(n);
    expect(h.clearedCount).toBe(1);
  });

  test("setLabel before start is a no-op", () => {
    const h = harness();
    h.out.spinner.setLabel("nope");
    expect(h.writes).toEqual([]);
    expect(h.out.spinner.active).toBe(false);
  });

  test("elapsed seconds surface only once past 1s", () => {
    const h = harness();
    h.setClock(0);
    h.out.spinner.start("thinking");
    h.setClock(900);
    h.tick();
    expect(h.writes.at(-1)).toBe(`${CLEAR}B thinking…`); // <1s: no readout
    h.setClock(2400);
    h.tick();
    expect(h.writes.at(-1)).toBe(`${CLEAR}C thinking… (2s)`);
  });
});

describe("createCliOutput — write() interplay with a live spinner", () => {
  test("write erases the live line first, then emits the payload", () => {
    const h = harness();
    h.out.spinner.start("running echo", { prefix: "" });
    const base = h.writes.length;
    h.out.write("[tool: echo]\n");
    expect(h.writes.slice(base)).toEqual([CLEAR, "[tool: echo]\n"]);
  });

  test("write is a plain pass-through once the spinner has stopped", () => {
    const h = harness();
    h.out.spinner.start("thinking");
    h.out.spinner.stop();
    const base = h.writes.length;
    h.out.write("answer text");
    expect(h.writes.slice(base)).toEqual(["answer text"]);
  });
});

describe("createCliOutput — color", () => {
  test("color:true wraps glyph and label in ANSI, monochrome otherwise", () => {
    const h = harness({ color: true });
    h.out.spinner.start("thinking", { prefix: "agent> " });
    const line = h.writes[1] ?? "";
    expect(line).toContain("\x1b[36m"); // cyan glyph
    expect(line).toContain("\x1b[2m"); // dim label
    expect(line).toContain("thinking…");
  });
});

describe("isSpinnerEnabled", () => {
  test("requires a TTY by default", () => {
    expect(isSpinnerEnabled({}, false)).toBe(false);
    expect(isSpinnerEnabled({}, true)).toBe(true);
  });

  test("a dumb terminal disables it", () => {
    expect(isSpinnerEnabled({ TERM: "dumb" }, true)).toBe(false);
    expect(isSpinnerEnabled({ TERM: "xterm-256color" }, true)).toBe(true);
  });

  test("CREWHAUS_SPINNER falsy values force off even on a TTY", () => {
    for (const v of ["0", "false", "off", "no", "OFF", " No "]) {
      expect(isSpinnerEnabled({ CREWHAUS_SPINNER: v }, true)).toBe(false);
    }
  });

  test("CREWHAUS_SPINNER truthy values force on, but stay TTY-gated", () => {
    expect(isSpinnerEnabled({ CREWHAUS_SPINNER: "1" }, true)).toBe(true);
    expect(isSpinnerEnabled({ CREWHAUS_SPINNER: "1" }, false)).toBe(false);
    // An explicit truthy value overrides even TERM=dumb.
    expect(isSpinnerEnabled({ CREWHAUS_SPINNER: "1", TERM: "dumb" }, true)).toBe(true);
  });
});
