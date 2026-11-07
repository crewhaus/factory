/**
 * `intent:` (#514): the key parses on every shape, its limits hold, its one
 * cross-field check runs after every older check, and it never echoes what the
 * owner wrote into an error.
 */
import { describe, expect, test } from "bun:test";
import { DELTA_090_ISSUES } from "./blocks/delta-090";
import { intentIssues } from "./blocks/intent";
import { type Spec, Spec as SpecSchema, parseSpec, parseSpecIssues, specJsonSchema } from "./index";

/** One spec per shape, cut to the required fields. */
const SPECS: Record<Spec["target"], string> = {
  cli: "name: a\ntarget: cli\nagent: {model: claude-opus-4-7, instructions: Help.}\n",
  workflow:
    "name: a\ntarget: workflow\nmodel: claude-opus-4-7\nsteps:\n  - {name: s, instructions: Go.}\n",
  channel:
    "name: a\ntarget: channel\nagent: {model: claude-opus-4-7, instructions: Help.}\nchannels:\n  slack: {botToken: $T, signingSecret: $S}\nrouting: {sessionKey: thread}\n",
  graph:
    "name: a\ntarget: graph\nmodel: claude-opus-4-7\nentry: n\nnodes:\n  n: {instructions: Go.}\nedges: []\n",
  managed:
    "name: a\ntarget: managed\nagent: {model: claude-opus-4-7, instructions: Help.}\ntenants:\n  - {id: t, budget: {maxInputTokens: 1, maxOutputTokens: 1}}\n",
  pipeline:
    "name: a\ntarget: pipeline\nagent: {model: claude-opus-4-7, instructions: Help.}\nretrieve: {embedderModel: e, defaultK: 1}\nindexing:\n  documents:\n    - {id: d, text: x}\n",
  crew: "name: a\ntarget: crew\nmodel: claude-opus-4-7\nentry: r\nroles:\n  r: {instructions: Go.}\nrouting: {kind: match, match: {}}\n",
  research:
    "name: a\ntarget: research\nagent: {model: claude-opus-4-7, instructions: Help.}\ngoal: g\nbranchingFactor: 2\n",
  batch:
    "name: a\ntarget: batch\nagent: {model: claude-opus-4-7, instructions: Help.}\nqueue: {adapter: in-memory}\nconcurrency: 1\n",
  voice:
    "name: a\ntarget: voice\nagent: {model: claude-opus-4-7, instructions: Help.}\nvoice: {provider: openai}\n",
  browser:
    "name: a\ntarget: browser\nagent: {model: claude-opus-4-7, instructions: Help.}\nlimits: {turn_timeout_ms: 1000}\n",
  eval: "name: a\ntarget: eval\nagent: {model: claude-opus-4-7, instructions: Help.}\ndataset: {name: d, version: '1'}\ngraders:\n  - {name: exact}\n",
  onchain:
    "name: a\ntarget: onchain\nagent: {model: claude-opus-4-7, instructions: Help.}\nchains:\n  - {id: b, kind: evm, rpcUrls: [$R], finality: {kind: finalized}}\ntriggers:\n  - {kind: block, chainId: b, scanIntervalMs: 1000}\n",
  "onchain-game":
    "name: a\ntarget: onchain-game\nagent: {model: claude-opus-4-7, instructions: Help.}\nchain: {id: b, kind: evm, rpcUrls: [$R], finality: {kind: finalized}}\nwallet: {id: w, chainId: b, custody: local, keyRef: $K}\ngame:\n  contract: {id: g, chainId: b, address: '0x1', abiRef: 'abi://erc20'}\n  stateReader: s\n",
};

const TARGETS = Object.keys(SPECS) as Spec["target"][];

/** A spec with `intent` set to `value` (JSON is valid YAML, whitespace included). */
function withIntent(value: unknown, target: Spec["target"] = "cli"): string {
  return `${SPECS[target]}intent: ${JSON.stringify(value)}\n`;
}

/** The parsed `intent` of a spec text. */
function intentOf(yaml: string): NonNullable<Spec["intent"]> {
  const { intent } = parseSpec(yaml);
  if (intent === undefined) throw new Error("the spec parsed without its intent");
  return intent;
}

const lines = (count: number, length: number): string[] =>
  Array.from({ length: count }, (_, i) => `${i}`.padEnd(length, "x"));

const MAXIMAL = {
  purpose: "p".repeat(500),
  serves: lines(8, 200),
  outcomes: lines(8, 200),
  excludes: lines(8, 200).map((line) => `z${line.slice(1)}`),
};

describe("intent on every shape", () => {
  test("the union has fourteen members and the corpus here covers each", () => {
    expect(SpecSchema.options.length).toBe(14);
    expect(TARGETS.length).toBe(14);
    expect(TARGETS.slice().sort()).toEqual(
      SpecSchema.options.map((option) => option.shape.target.value as string).sort(),
    );
  });

  for (const target of TARGETS) {
    test(`${target}: a maximal intent parses, and its text comes back trimmed`, () => {
      const intent = intentOf(withIntent(MAXIMAL, target));
      expect(intent.purpose).toBe(MAXIMAL.purpose);
      expect(intent.serves).toEqual(MAXIMAL.serves);
      expect(intent.outcomes).toEqual(MAXIMAL.outcomes);
      expect(intent.excludes).toEqual(MAXIMAL.excludes);
      const trimmed = intentOf(
        withIntent({ purpose: "  Keep it fast.  ", serves: [" me "] }, target),
      );
      expect(trimmed.purpose).toBe("Keep it fast.");
      expect(trimmed.serves).toEqual(["me"]);
    });
  }
});

describe("intent's limits", () => {
  const refused: ReadonlyArray<readonly [string, unknown]> = [
    ["an unknown sub-key", { purpose: "p", owner: "me" }],
    ["a missing purpose", { serves: ["me"] }],
    ["an empty purpose", { purpose: "" }],
    ["a whitespace-only purpose", { purpose: "   " }],
    ["a 501-character purpose", { purpose: "p".repeat(501) }],
    ["a ninth line", { purpose: "p", serves: lines(9, 3) }],
    ["a ninth outcome", { purpose: "p", outcomes: lines(9, 3) }],
    ["a ninth exclusion", { purpose: "p", excludes: lines(9, 3) }],
    ["a 201-character line", { purpose: "p", outcomes: ["l".repeat(201)] }],
    ["an empty line", { purpose: "p", excludes: [""] }],
    ["a whitespace-only line", { purpose: "p", serves: ["  "] }],
  ];
  for (const [what, value] of refused) {
    test(`refuses ${what}, at a path under intent`, () => {
      const issues = parseSpecIssues(withIntent(value));
      expect(issues.length).toBeGreaterThan(0);
      for (const issue of issues) expect(issue.path[0]).toBe("intent");
    });
  }
});

describe("intent's cross-field check", () => {
  const CONTRADICTION = { purpose: "p", outcomes: ["fast"], excludes: ["fast"] };
  const INTENT_MESSAGE = "intent.excludes[0] repeats a line from intent.outcomes";

  test("an older check's error is reported first, and both come back from the issue list", () => {
    const yaml = `${withIntent(CONTRADICTION)}provability: {level: grounded, on_fail: escalate}\n`;
    const provability = "provability.on_fail: escalate";
    expect(() => parseSpec(yaml)).toThrow(provability);

    const messages = parseSpecIssues(yaml).map((issue) => issue.message);
    const first = messages.findIndex((message) => message.includes(provability));
    const second = messages.findIndex((message) => message.includes(INTENT_MESSAGE));
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(-1);
    expect(first).toBeLessThan(second);
  });

  test("the check is the list's entry, and the list is frozen", () => {
    expect(DELTA_090_ISSUES).toContain(intentIssues);
    expect(Object.isFrozen(DELTA_090_ISSUES)).toBe(true);
  });

  test("a line under both lists is refused at its own index, case and spaces ignored, and is not echoed", () => {
    const line = "Fast Startup";
    const issues = parseSpecIssues(
      withIntent({
        purpose: "p",
        outcomes: [line, "fewer crashes"],
        excludes: ["new integrations", `${line.toLowerCase()} `],
      }),
    );
    expect(issues).toEqual([
      {
        path: ["intent", "excludes", 1],
        code: "custom",
        message: "intent.excludes[1] repeats a line from intent.outcomes: keep it in one list.",
      },
    ]);
    expect(issues[0]?.message.toLowerCase()).not.toContain("fast");
    expect(() =>
      parseSpec(withIntent({ purpose: "p", outcomes: ["Fast"], excludes: ["fast "] })),
    ).toThrow("intent.excludes[0] repeats a line");
  });

  test("every repeated line gets its own issue", () => {
    const issues = parseSpecIssues(
      withIntent({ purpose: "p", outcomes: ["a", "b"], excludes: ["a", "c", "b"] }),
    );
    expect(issues.map((issue) => issue.path)).toEqual([
      ["intent", "excludes", 0],
      ["intent", "excludes", 2],
    ]);
  });

  test("disjoint lists, an absent list and an absent block all pass", () => {
    for (const value of [
      { purpose: "p", outcomes: ["fast"], excludes: ["slow"] },
      { purpose: "p", outcomes: ["fast"] },
      { purpose: "p", excludes: ["fast"] },
      { purpose: "p", serves: ["fast"], excludes: ["fast"] },
    ]) {
      expect(parseSpecIssues(withIntent(value))).toEqual([]);
    }
    expect(parseSpecIssues(SPECS.cli)).toEqual([]);
  });
});

describe("an absent intent", () => {
  for (const target of TARGETS) {
    test(`${target}: no default appears`, () => {
      expect("intent" in parseSpec(SPECS[target])).toBe(false);
    });
  }
});

describe("the JSON schema", () => {
  /** Follows one `$ref` of the form `#/definitions/<shape>/properties/<key>`. */
  function resolve(
    doc: Record<string, unknown>,
    node: Record<string, unknown>,
  ): Record<string, unknown> {
    const ref = node["$ref"];
    if (typeof ref !== "string") return node;
    let cur: unknown = doc;
    for (const seg of ref.replace(/^#\//, "").split("/")) {
      cur = (cur as Record<string, unknown>)[seg];
    }
    return cur as Record<string, unknown>;
  }

  test("every shape's definition carries intent, with purpose required", () => {
    const doc = specJsonSchema();
    const definitions = doc["definitions"] as Record<
      string,
      { properties: Record<string, Record<string, unknown>> }
    >;
    for (const target of TARGETS) {
      const property = definitions[target]?.properties["intent"];
      expect(property, target).toBeDefined();
      const resolved = resolve(doc, property as Record<string, unknown>);
      expect(resolved["required"], target).toEqual(["purpose"]);
    }
  });
});
