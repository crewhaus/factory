/**
 * A checkout's `${{ … }}` expressions are found in one pass.
 *
 * `/\$\{\{([\s\S]*?)\}\}/g` ran from every `${{` to the end of the text when
 * no `}}` followed, so a checkout's `ref:` or `repository:` value with many
 * unclosed openers was quadratic in its length, in CiWorkflowAudit's
 * pull_request_target rule. The value comes from a workflow in the repository
 * under audit, which can be a pull request's. expressionBodies
 * searches from each `${{` to the first `}}` after it and stops at the first
 * opener that has none, since no later opener has one either.
 *
 * Counted, not timed. The audit's regular expressions are counted in
 * backtracking steps by the step model in tool-text's
 * src/__test__/regex-work.ts, imported by path so its copies stay as they
 * are; it walks each in ECMAScript's order and must agree with the engine on
 * every match. The scan itself runs no pattern, so it is counted in the
 * characters its `indexOf` searches read.
 */
import { describe, expect, test } from "bun:test";
import { regexWork } from "../../tool-text/src/__test__/regex-work";
import { auditWorkflow, expressionBodies, readWorkflow } from "./lib/workflow";

/** The pattern as it was. */
const OLD_EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
const oldBodies = (text: string): string[] =>
  [...text.matchAll(OLD_EXPRESSION)].map((m) => m[1] ?? "");

/** Every sequence of up to `max` pieces. */
function allJoins(pieces: ReadonlyArray<string>, max: number): string[] {
  const out = [""];
  let layer = [""];
  for (let n = 1; n <= max; n++) {
    layer = layer.flatMap((s) => pieces.map((p) => s + p));
    out.push(...layer);
  }
  return out;
}

/** `input -> answer` for each input, as one string, so a failure names the input. */
function answers(inputs: ReadonlyArray<string>, f: (s: string) => unknown): string[] {
  return inputs.map((s) => `${JSON.stringify(s)} -> ${JSON.stringify(f(s))}`);
}

/**
 * What `body` returned, and how many characters the `String#indexOf` calls it
 * made read: from where each search started to the end of what it found, or
 * to the end of the string when it found nothing.
 */
function charactersSearched<T>(body: () => T): { value: T; read: number } {
  const real = String.prototype.indexOf;
  const meter = { read: 0 };
  String.prototype.indexOf = function (this: string, search: string, position?: number): number {
    const from = Math.min(Math.max(Math.trunc(Number(position)) || 0, 0), this.length);
    const at = real.call(this, search, position);
    meter.read += (at === -1 ? this.length : at + search.length) - from;
    return at;
  };
  try {
    return { value: body(), read: meter.read };
  } finally {
    String.prototype.indexOf = real;
  }
}

/** A pull_request_target workflow that checks out `ref`. */
function checkoutOf(ref: string): string {
  return [
    "on: pull_request_target",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "        with:",
    `          ref: '${ref}'`,
    "",
  ].join("\n");
}

test("expressionBodies finds what /\\$\\{\\{([\\s\\S]*?)\\}\\}/g captured", () => {
  const inputs = [
    ...allJoins(["$", "{", "}", "${{", "}}", "a", " ", "\n"], 5),
    "${{ github.event.pull_request.base.sha }}",
    "refs/heads/${{ github.base_ref }}-${{ github.sha }}",
    "${{ github.head_ref }} ${{ unclosed",
    "${{ a }}}} ${{{ b }}",
  ];
  // Some 37 000 generated values: budgeted, as the house does for a test
  // that is slow by construction.
  expect(answers(inputs, expressionBodies)).toEqual(answers(inputs, oldBodies));
}, 20_000);

describe("a run of unclosed openers is read once", () => {
  test("the scan reads each character once", () => {
    const text = `${"${{ github.sha }} ".repeat(1_000)}${"${{ ".repeat(2_000)}`;
    const scanned = charactersSearched(() => expressionBodies(text));
    expect(scanned.value).toHaveLength(1_000);
    expect(scanned.read).toBeLessThanOrEqual(text.length);
    // Control: the meter sees a scan that tries the next opener after one
    // with no closer, as the old pattern's search did.
    const retrying = charactersSearched(() => {
      let found = 0;
      for (let open = text.indexOf("${{"); open !== -1; open = text.indexOf("${{", open + 1)) {
        if (text.indexOf("}}", open + 3) !== -1) found++;
      }
      return found;
    });
    expect(retrying.read).toBeGreaterThan(100 * text.length);
  }, 20_000);

  // The audit now takes about 25 steps a character on this workflow, parse
  // included. The old pattern took about 4 n² on n openers: at 2 000, 16
  // million against this bound's 520 000.
  const STEPS_PER_CHARACTER = 64;

  test("through the audit, the finding unchanged", () => {
    const audit = (n: number) => {
      const text = checkoutOf("${{ ".repeat(n));
      return auditWorkflow(readWorkflow(".github/workflows/x.yml", text))
        .filter((f) => f.rule === "pull-request-target-checkout")
        .map((f) => `${f.rule}/${f.severity}`);
    };
    const text = checkoutOf("${{ ".repeat(2_000));
    const bound = STEPS_PER_CHARACTER * text.length;
    const counted = regexWork(bound, () => audit(2_000));
    expect(counted.unmodelled).toEqual([]);
    expect(counted.steps).toBeLessThanOrEqual(bound);
    // An expression the rule cannot resolve: read it, at medium.
    expect(counted.value).toEqual(["pull-request-target-checkout/medium"]);
    // Twice the openers, twice the steps (a rescan would be four times).
    const half = regexWork(bound, () => audit(1_000));
    expect(counted.steps).toBeLessThanOrEqual(2.1 * half.steps);
    // Control: the count sees the old pattern go past the bound.
    const ref = "${{ ".repeat(2_000);
    expect(regexWork(bound, () => oldBodies(ref)).steps).toBe(Number.POSITIVE_INFINITY);
  }, 20_000);
});
