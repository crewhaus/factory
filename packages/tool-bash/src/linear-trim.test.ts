/**
 * The trailing newlines of a command's output are stripped in one pass.
 *
 * `/\n+$/` tries every start inside a run of newlines that is not at the end
 * of the output and rescans the rest of the run from each: quadratic in the
 * run's length. A command prints whatever the workspace or the model makes
 * it print, so the strip is a loop from the end.
 *
 * Counted, not timed. While a call runs, every regular expression run over a
 * string holding a long run of newlines is refused on the spot and recorded,
 * so a pattern that would rescan the run fails the test at once instead of
 * being waited out. The child process is a fake whose streams close after
 * one chunk, and the drain and deadline timers are held, so the output read
 * always arrives and how fast anything ran decides nothing.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { __resetBackgroundProcsForTest, bash, bashOutput } from "./index";
import { withoutTrailingNewlines } from "./trailing";

/** A stream that delivers `text` in one chunk and closes. */
function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

/** Every regular expression run over a string holding `run` while `body` runs, refused. */
async function regexRunsOver<T>(
  run: string,
  body: () => Promise<T>,
): Promise<{ runs: string[]; outcome: T | Error }> {
  const runs: string[] = [];
  const realExec = RegExp.prototype.exec;
  let last: string | undefined;
  let holds = false;
  RegExp.prototype.exec = function (this: RegExp, input: string) {
    if (input !== last) {
      last = input;
      holds = typeof input === "string" && input.includes(run);
    }
    if (holds) {
      runs.push(`/${this.source}/ over ${input.length} characters`);
      throw new Error(`/${this.source}/ ran over the run`);
    }
    return realExec.call(this, input);
  };
  try {
    return { runs, outcome: await body() };
  } catch (err) {
    return { runs, outcome: err as Error };
  } finally {
    RegExp.prototype.exec = realExec;
  }
}

const spies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
  __resetBackgroundProcsForTest();
});

/** Every spawned child prints `out` on both streams and exits 0. */
function fakeChild(out: string): void {
  spies.push(
    spyOn(Bun, "spawn").mockImplementation(
      ((): ReturnType<typeof Bun.spawn> =>
        ({
          stdout: streamOf(out),
          stderr: streamOf(out),
          exited: Promise.resolve(0),
          kill: mock((_sig?: unknown) => {}),
        }) as unknown as ReturnType<typeof Bun.spawn>) as unknown as typeof Bun.spawn,
    ),
  );
}

/** Hold every timer: the drain fallback and the deadline never fire. */
function holdTimers(): void {
  spies.push(
    spyOn(globalThis, "setTimeout").mockImplementation(
      ((): ReturnType<typeof setTimeout> =>
        0 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
    ),
  );
  spies.push(
    spyOn(globalThis, "clearTimeout").mockImplementation(
      (() => {}) as unknown as typeof clearTimeout,
    ),
  );
}

/** Every string up to `max` characters long over `alphabet`. */
function allStrings(alphabet: ReadonlyArray<string>, max: number): string[] {
  const out = [""];
  let layer = [""];
  for (let n = 1; n <= max; n++) {
    layer = layer.flatMap((s) => alphabet.map((c) => s + c));
    out.push(...layer);
  }
  return out;
}

const RUN = "\n".repeat(1_000);
// The newlines are not at the end, so the regex form would rescan them.
const PRINTED = `${"\n".repeat(100_000)}END\n\n`;
const BODY = `${"\n".repeat(100_000)}END`;

describe("trailing newlines", () => {
  test("withoutTrailingNewlines returns what /\\n+$/ returned", () => {
    for (const text of [
      ...allStrings(["\n", "\r", "a"], 5),
      "out\n",
      "a\n\nb\n\n\n",
      "\u2028\n",
      "é\n",
      "\u{1F600}\n\n",
    ]) {
      expect(`${JSON.stringify(text)} -> ${JSON.stringify(withoutTrailingNewlines(text))}`).toBe(
        `${JSON.stringify(text)} -> ${JSON.stringify(text.replace(/\n+$/, ""))}`,
      );
    }
  });

  test("Bash runs no pattern over a run of newlines in what the command printed", async () => {
    // Control: the count sees a pattern String#replace runs over the newlines.
    const control = await regexRunsOver(RUN, async () => PRINTED.replace(/\n+$/, ""));
    expect(control.runs).toEqual([`/\\n+$/ over ${PRINTED.length} characters`]);

    fakeChild(PRINTED);
    holdTimers();
    const ran = await regexRunsOver(RUN, () => bash.execute({ command: "print" }));
    expect(ran.runs).toEqual([]);
    expect(ran.outcome).toBe(`${BODY}\n[stderr]\n${BODY}\n[exit] 0`);
  });

  test("BashOutput runs no pattern over a run of newlines in a background command's output", async () => {
    fakeChild(PRINTED);
    const started = await bash.execute({ command: "print", background: true });
    const id = /bash_[0-9a-f]{12}/.exec(started)?.[0] as string;
    const ran = await regexRunsOver(RUN, async () => {
      // Poll until both streams' text is in and the exit is recorded; each
      // poll returns only what is new. No clock is read.
      let seen = "";
      for (;;) {
        const poll = await bashOutput.execute({ bash_id: id });
        seen += `${poll}\n`;
        if (seen.split("END").length === 3 && poll.includes("[status] exited 0")) return seen;
        await new Promise((resolve) => setImmediate(resolve));
      }
    });
    expect(ran.runs).toEqual([]);
    expect(String(ran.outcome)).toContain(`${BODY}\n[stderr]\n${BODY}\n`);
  });
});
