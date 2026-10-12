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
 * A test that walks many generated inputs, or every code unit, declares a
 * 20 s budget, as the house does for a test that is slow by construction.
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
function allStrings(alphabet: ReadonlyArray<string>, max: number): string[] {
  const out = [""];
  let layer = [""];
  for (let n = 1; n <= max; n++) {
    layer = layer.flatMap((s) => alphabet.map((c) => s + c));
    out.push(...layer);
  }
  return out;
}

/** `[input, output]` for each input, as one string, so a failure names the input. */
function answers(inputs: ReadonlyArray<string>, f: (s: string) => unknown): string[] {
  return inputs.map((s) => `${JSON.stringify(s)} -> ${JSON.stringify(f(s))}`);
}

// The pattern as it was.
const DIGEST_LINE = /^([0-9a-fA-F]{64})\s+\*?(.+)$/;
const H = "0123456789abcdefABCDEF".repeat(3).slice(0, 64);

test("digestLine captures what the pattern captured", () => {
  const inputs = [
    ...allStrings([" ", "*", "\r", "\u2028", "x", "\t", "\n"], 5).map((s) => H + s),
    `${H}  ./a.txt`,
    `${H} *bin/tool`,
    H.slice(0, 63),
    `${H.slice(0, 63)} x`,
    `${H}a x`,
    "",
  ];
  // Every code unit, in each place the pattern reads.
  for (let c = 0; c <= 0xffff; c++) {
    const ch = String.fromCharCode(c);
    inputs.push(
      `${ch}${H.slice(1)} x`,
      `${H.slice(0, 63)}${ch} x`,
      `${H}${ch}x`,
      `${H} ${ch}`,
      `${H}  ${ch}`,
      `${H} *${ch}`,
      `${H} x${ch}`,
      `${H}${ch}`,
    );
  }
  expect(answers(inputs, digestLine)).toEqual(
    answers(inputs, (s) => {
      const m = DIGEST_LINE.exec(s);
      return m === null ? null : { digest: m[1], path: m[2] };
    }),
  );
}, 20_000);

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
