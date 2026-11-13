/**
 * The absent corpus (#514): a spec that declares none of the 0.9.0 keys compiles
 * to the same bytes on every shape, README included, and `intent:` changes no
 * compiled byte for a spec that does declare it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type Spec, parseSpec } from "@crewhaus/spec";
import { CORPUS_TODAY, corpusFileDigests } from "./__fixtures__/delta-090/regenerate";
import { LOOP_PROJECTION_SPECS } from "./__fixtures__/loop-projection-specs";
import { ABSENT_CORPUS } from "./absent-corpus";
import { compile, lower } from "./index";

const DIGESTS = JSON.parse(
  readFileSync(
    new URL("./__fixtures__/delta-090/absent-corpus.digests.json", import.meta.url),
    "utf8",
  ),
) as Record<string, Record<string, string>>;

const INTENT = `intent:
  purpose: Keep the budgeting app reliable and fast.
  serves: [people who budget offline]
  outcomes: [fewer crash reports, fast startup]
  excludes: [new integrations, UI redesigns]
`;

describe("the corpus", () => {
  test("has one spec per target shape, each its own target", () => {
    const targets = Object.keys(ABSENT_CORPUS).sort();
    expect(targets.length).toBe(14);
    for (const target of targets) {
      const yaml = ABSENT_CORPUS[target as Spec["target"]];
      expect(parseSpec(yaml).target as string).toBe(target);
    }
  });

  test("the digest file covers exactly the corpus", () => {
    expect(Object.keys(DIGESTS).sort()).toEqual(Object.keys(ABSENT_CORPUS).sort());
  });

  for (const [target, yaml] of Object.entries(ABSENT_CORPUS)) {
    test(`${target}: every file matches its digest, and the README is one of them`, () => {
      const digests = corpusFileDigests(yaml);
      expect(Object.keys(digests)).toContain("README.md");
      expect(
        digests,
        "compiled bytes moved for a spec that declares no new key: fix the leak, or for a deliberate emitter change run __fixtures__/delta-090/regenerate.ts and add a delta note",
      ).toEqual(DIGESTS[target] as Record<string, string>);
    });

    test(`${target}: passes compile --strict, as the compiler worker runs it`, () => {
      expect(compile(yaml, { strict: true, today: CORPUS_TODAY }).files.length).toBeGreaterThan(0);
    });
  }
});

describe("a present intent changes nothing a compile returns", () => {
  const sets: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]> = [
    ["the absent corpus", ABSENT_CORPUS],
    ["the loop-projection specs", LOOP_PROJECTION_SPECS],
  ];
  for (const [label, specs] of sets) {
    for (const [target, yaml] of Object.entries(specs)) {
      test(`${label}, ${target}: files, warnings and the IR are deep-equal`, () => {
        const declared = `${yaml}${INTENT}`;
        // The append really did declare it: the parser kept the block.
        const parsed = parseSpec(declared);
        expect(parsed.intent?.purpose).toBeDefined();
        const opts = { today: CORPUS_TODAY };
        const without = compile(yaml, opts);
        const withIntent = compile(declared, opts);
        expect(withIntent.files).toEqual(without.files);
        expect(withIntent.warnings).toEqual(without.warnings);
        expect(lower(parsed, opts)).toEqual(lower(parseSpec(yaml), opts));
      });
    }
  }
});

describe("a protected bar changes nothing a compile returns", () => {
  /** `protected: true` under every `judge:` of a loop-projection spec. */
  const protectJudges = (yaml: string): string =>
    yaml.replace(
      /^(\s*)judge:\n/gm,
      (_m, indent: string) => `${indent}judge:\n${indent}  protected: true\n`,
    );

  const CLI = `name: guarded
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: Answer briefly.
evaluation:
  grader: { type: llm_judge, criteria: answers the question }
  threshold: 0.8
provability:
  level: cited
  threshold: 0.9
`;
  const PROTECTED_CLI = CLI.replace(
    "  threshold: 0.8\n",
    "  threshold: 0.8\n  protected: true\n",
  ).replace("  threshold: 0.9\n", "  threshold: 0.9\n  protected: true\n");

  const cases: ReadonlyArray<readonly [string, string, string, (s: Spec) => boolean]> = [
    [
      "workflow",
      LOOP_PROJECTION_SPECS["workflow"] as string,
      protectJudges(LOOP_PROJECTION_SPECS["workflow"] as string),
      (s) =>
        "steps" in s && s.steps.some((step) => "judge" in step && step.judge?.protected === true),
    ],
    [
      "graph",
      LOOP_PROJECTION_SPECS["graph"] as string,
      protectJudges(LOOP_PROJECTION_SPECS["graph"] as string),
      (s) =>
        "nodes" in s &&
        Object.values(s.nodes).some((node) => "judge" in node && node.judge?.protected === true),
    ],
    [
      "cli",
      CLI,
      PROTECTED_CLI,
      (s) =>
        "evaluation" in s &&
        s.evaluation?.protected === true &&
        typeof s.provability === "object" &&
        s.provability.protected === true,
    ],
  ];

  for (const [label, plain, declared, parsedIt] of cases) {
    test(`${label}: files, warnings and the IR are deep-equal`, () => {
      const parsed = parseSpec(declared);
      // The flag really parsed.
      expect(parsedIt(parsed)).toBe(true);
      const opts = { today: CORPUS_TODAY };
      const without = compile(plain, opts);
      const withFlag = compile(declared, opts);
      expect(withFlag.files).toEqual(without.files);
      expect(withFlag.warnings).toEqual(without.warnings);
      expect(lower(parsed, opts)).toEqual(lower(parseSpec(plain), opts));
    });
  }

  test("a parked provability block's warning does not name protected", () => {
    const parked = `name: parked
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: Answer.
provability:
  level: off
  threshold: 0.9
  protected: true
`;
    const warnings = JSON.stringify(compile(parked, { today: CORPUS_TODAY }).warnings);
    expect(warnings).toContain("provability.threshold has no effect");
    expect(warnings).not.toContain("protected");
  });
});
