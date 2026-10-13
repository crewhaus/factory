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
 * characters its string methods read: every `String.prototype` method is
 * metered, so a rescan through `includes`, `lastIndexOf`, a copy or any other
 * method is counted as one through `indexOf` is. Indexing (`text[i]`) is not
 * a method call, and goes unseen.
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

/** String methods that read the one character at a position. */
const POSITION_READS = new Set<PropertyKey>(["at", "charAt", "charCodeAt", "codePointAt"]);
/** String methods that copy part of the string out, counted by what they copy. */
const COPIES = new Set<PropertyKey>(["slice", "substring", "substr"]);
/** String methods that compare their argument at one place. */
const COMPARES = new Set<PropertyKey>(["startsWith", "endsWith"]);
/** String methods that hand back the string itself. */
const UNMETERED = new Set<PropertyKey>(["constructor", "toString", "valueOf"]);
const realIndexOf = String.prototype.indexOf;

/** A position argument as a search reads it, clamped to the string. */
function clamp(position: unknown, fallback: number, length: number): number {
  const n = Number(position);
  const p = position === undefined || Number.isNaN(n) ? fallback : Math.trunc(n);
  return Math.min(Math.max(p, 0), length);
}

/**
 * The characters one call of the string method `key` read: a forward search
 * from its start to the end of what it found, or to the end of the string
 * when it found nothing; a backward search likewise; a comparison the length
 * of what it compared; one character for a read at a position; and the whole
 * string for anything else. Copies are counted apart, by their length.
 */
function charactersRead(key: PropertyKey, text: string, args: unknown[], result: unknown): number {
  const search = typeof args[0] === "string" ? args[0] : "";
  if (key === "indexOf" || key === "includes") {
    const from = clamp(args[1], 0, text.length);
    const at = key === "indexOf" ? (result as number) : realIndexOf.call(text, search, from);
    return Math.max((at === -1 ? text.length : at + search.length) - from, 0);
  }
  if (key === "lastIndexOf") {
    const from = clamp(args[1], Number.POSITIVE_INFINITY, text.length);
    const at = result as number;
    return Math.max(Math.min(from + search.length, text.length) - (at === -1 ? 0 : at), 0);
  }
  if (COMPARES.has(key)) return search.length;
  if (POSITION_READS.has(key)) return 1;
  return text.length;
}

/**
 * What `body` returned; the characters the string methods it called read,
 * searching (`searched`); and the characters they copied out (`copied`).
 * Every method on `String.prototype` is metered while `body` runs, the
 * iterator included.
 */
function charactersSearched<T>(body: () => T): { value: T; searched: number; copied: number } {
  const proto = String.prototype as unknown as Record<PropertyKey, unknown>;
  const meter = { searched: 0, copied: 0 };
  const saved: Array<readonly [PropertyKey, PropertyDescriptor]> = [];
  for (const key of [...Object.getOwnPropertyNames(proto), Symbol.iterator]) {
    const found = Object.getOwnPropertyDescriptor(proto, key);
    if (found === undefined || typeof found.value !== "function" || UNMETERED.has(key)) continue;
    const real = found.value as (this: string, ...args: unknown[]) => unknown;
    saved.push([key, found]);
    Object.defineProperty(proto, key, {
      ...found,
      value: function (this: string, ...args: unknown[]): unknown {
        const result = real.apply(this, args);
        if (COPIES.has(key)) meter.copied += typeof result === "string" ? result.length : 0;
        else meter.searched += charactersRead(key, this, args, result);
        return result;
      },
    });
  }
  try {
    return { value: body(), searched: meter.searched, copied: meter.copied };
  } finally {
    for (const [key, original] of saved) Object.defineProperty(proto, key, original);
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
    // Each character searched once, and each body copied out once.
    expect(scanned.searched).toBeLessThanOrEqual(text.length);
    expect(scanned.copied).toBeLessThanOrEqual(text.length);
  }, 20_000);

  // Control: the meter sees a scan that tries the next opener after one with
  // no closer, as the old pattern's search did, whichever string method it
  // reads the rest of the text with: each reads 200 times the text or more.
  // The last calls once a character: slow by construction, so each is budgeted.
  const retries: ReadonlyArray<readonly [string, (text: string, open: number) => boolean]> = [
    ["indexOf", (text, open) => text.indexOf("}}", open + 3) !== -1],
    ["includes", (text, open) => text.includes("}}", open + 3)],
    ["lastIndexOf", (text, open) => text.lastIndexOf("}}") > open],
    ["a copy", (text, open) => text.slice(open + 3).length < 0],
    ["split", (text, open) => text.split("}}").length > 1 && open < 0],
    [
      "a character at a time",
      (text, open) => {
        for (let i = open + 3; i + 1 < text.length; i++) {
          if (text.charAt(i) === "}" && text.charAt(i + 1) === "}") return true;
        }
        return false;
      },
    ],
  ];

  test.each(retries)(
    "control: a retry through %s is seen",
    (_, closes) => {
      const text = "${{ ".repeat(400);
      const retrying = charactersSearched(() => {
        let found = 0;
        for (let open = text.indexOf("${{"); open !== -1; open = text.indexOf("${{", open + 1)) {
          if (closes(text, open)) found++;
        }
        return found;
      });
      expect(retrying.value).toBe(0);
      expect(retrying.searched + retrying.copied).toBeGreaterThan(100 * text.length);
    },
    20_000,
  );

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
