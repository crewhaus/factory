/**
 * A checksum manifest's lines are read in one pass.
 *
 * ChecksumVerify read each `sha256sum` line with
 * `/^([0-9a-fA-F]{64})\s+\*?(.+)$/`, which matches only when the path holds
 * no line break. A manifest is split on \n alone, so a stray \r or U+2028
 * inside a line survives, and with text between a whitespace run and that
 * break the pattern tried every shorter run and rescanned the rest from
 * each: quadratic in the run's length, in a file the workspace supplies.
 *
 * The equivalence test walks every code unit and many generated inputs. It
 * compares the two reads one input at a time, never holding the corpus or
 * its answers as strings, and declares a 60 s budget, as the house does for
 * a test that is slow by construction.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checksumVerify } from "./index";
import { digestLine } from "./lib/digest-line";

/**
 * Every regular expression run over a string holding `run` while `body`
 * runs. Each is recorded once, and one whose source is not in `allowed` is
 * refused on the spot (it throws instead of running), so a pattern that
 * would rescan the run from every position in it fails the test at once
 * instead of being waited out. `String#replace`, `match`, `split`, `search`
 * and `RegExp#test` all go through `exec` once it is replaced. Counted, not
 * timed: the machine's speed decides nothing.
 */
async function regexRunsOver<T>(
  run: string,
  body: () => T | Promise<T>,
  allowed: ReadonlyArray<string> = [],
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
      const seen = `/${this.source}/`;
      if (!runs.includes(seen)) runs.push(seen);
      if (!allowed.includes(this.source)) throw new Error(`/${this.source}/ ran over the run`);
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

/** Every string up to `max` characters long over `alphabet`. */
function* allStrings(alphabet: ReadonlyArray<string>, max: number): Generator<string> {
  let layer = [""];
  yield "";
  for (let n = 1; n <= max; n++) {
    layer = layer.flatMap((s) => alphabet.map((c) => s + c));
    yield* layer;
  }
}

/** `v` as JSON with every code unit outside printable ASCII escaped, so a failure shows it. */
function shown(v: unknown): string {
  return (JSON.stringify(v) ?? String(v)).replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * The inputs on which `now` and `then` answer differently, compared one at
 * a time as `inputs` yields them, so the walk costs the two reads and little
 * else. Names the first 20 that differ, with both answers, and counts every
 * input, so a corpus that shrank shows up as well.
 */
function disagreements<T>(
  inputs: Iterable<string>,
  now: (s: string) => T,
  then: (s: string) => T,
  same: (a: T, b: T) => boolean,
): { checked: number; differ: string[] } {
  let checked = 0;
  const differ: string[] = [];
  for (const s of inputs) {
    checked++;
    const a = now(s);
    const b = then(s);
    if (!same(a, b) && differ.length < 20) {
      differ.push(`${shown(s)} -> ${shown(a)}, was ${shown(b)}`);
    }
  }
  return { checked, differ };
}

// The pattern as it was.
const DIGEST_LINE = /^([0-9a-fA-F]{64})\s+\*?(.+)$/;
const H = "0123456789abcdefABCDEF".repeat(3).slice(0, 64);

type Entry = { digest: string; path: string } | null;

/** Every input the comparison walks, generated as it is read. */
function* digestLines(): Generator<string> {
  for (const s of allStrings([" ", "*", "\r", "\u2028", "x", "\t", "\n"], 5)) yield H + s;
  yield `${H}  ./a.txt`;
  yield `${H} *bin/tool`;
  yield H.slice(0, 63);
  yield `${H.slice(0, 63)} x`;
  yield `${H}a x`;
  yield "";
  // Every code unit, in each place the pattern reads.
  for (let c = 0; c <= 0xffff; c++) {
    const ch = String.fromCharCode(c);
    yield `${ch}${H.slice(1)} x`;
    yield `${H.slice(0, 63)}${ch} x`;
    yield `${H}${ch}x`;
    yield `${H} ${ch}`;
    yield `${H}  ${ch}`;
    yield `${H} *${ch}`;
    yield `${H} x${ch}`;
    yield `${H}${ch}`;
  }
}

test("digestLine captures what the pattern captured", () => {
  const { checked, differ } = disagreements<Entry>(
    digestLines(),
    digestLine,
    (s) => {
      const m = DIGEST_LINE.exec(s);
      return m === null ? null : { digest: m[1] as string, path: m[2] as string };
    },
    (a, b) => (a === null ? b === null : b !== null && a.digest === b.digest && a.path === b.path),
  );
  expect(differ).toEqual([]);
  // Strings up to length 5 over 7 characters, 6 fixed lines, and 8 places
  // for each of the 65 536 code units.
  expect(checked).toBe(19_608 + 6 + 8 * 65_536);
}, 60_000);

describe("no pattern rescans a run in a manifest the workspace holds", () => {
  const originalCwd = process.cwd();
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "crewhaus-verify-linear-"));
    process.chdir(workspace);
  });
  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(workspace, { recursive: true, force: true });
  });

  const run = " ".repeat(100_000);

  test("the old pattern did", async () => {
    // Control: the hook sees the old pattern run over its run.
    const line = `${H}${run}x\ry`;
    expect((await regexRunsOver(run, () => DIGEST_LINE.exec(line))).runs).toEqual([
      `/${DIGEST_LINE.source}/`,
    ]);
  });

  test("a line with a run before text and a stray carriage return is not an entry", async () => {
    writeFileSync(join(workspace, "a.txt"), "a");
    const digest = "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb";
    writeFileSync(
      join(workspace, "SHA256SUMS"),
      [`${H}${run}x\ry`, `${H} *${run}x\u2028y`, `${digest}  a.txt`, ""].join("\n"),
    );
    // The `#` line reader runs over a line only when it starts with `#`.
    const checked = await regexRunsOver(run, async () =>
      JSON.parse(await checksumVerify.execute({ manifest: "SHA256SUMS" }, {} as never)),
    );
    expect(checked.runs).toEqual([]);
    // As before: neither long line is an entry, and the one that is matches.
    expect(checked.outcome).toMatchObject({
      ok: true,
      checked: 1,
      mismatched: [],
      missing: [],
      unexpected: [],
    });
  });
});
