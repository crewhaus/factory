import { describe, expect, test } from "bun:test";
/**
 * 0.6.0 §6.2 (PR 13) — `graders.yaml` `per_model:`: the grammar, the
 * grader-level/file-level merge, the loud rejections, and the two
 * compatibility claims that matter most —
 *
 *   - an existing graders.yaml parses to a byte-identical compiled shape (no
 *     `perModel` key appears from nowhere), and
 *   - introducing a `per_model:` map CHANGES the config the run-history
 *     `gradersHash` is computed over, so it starts a new lineage by design.
 */
import { createHash } from "node:crypto";
import { parseGradersConfig, perModelArmKey, perModelOverrideFor } from "./graders-config";
import type { GradersConfig } from "./graders-config";

const RUBRIC = `    rubric:
      criteria:
        - name: q
          description: is it good
          anchors:
            "1": bad
            "2": meh
            "3": ok
            "4": good
            "5": great`;

function judgeConfig(extra = "", top = ""): string {
  return `graders:
  - name: quality
    type: llm_judge
    model: claude-sonnet-5
${RUBRIC}
${extra}${top}`;
}

/**
 * The run-history instrument identity, computed exactly as the CLI's
 * `hashGradersConfig` does: sha256 over a key-sorted serialization of the
 * PARSED config. Mirrored here (it lives in the CLI's self-executing entry
 * file) so the lineage claim is assertable where the grammar lives.
 */
function gradersHash(config: GradersConfig): string {
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value !== null && typeof value === "object") {
      return `{${Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  };
  return createHash("sha256").update(stable(config)).digest("hex");
}

describe("per_model grammar", () => {
  test("a grader-level map compiles to normalized, camelCase overrides", () => {
    const { compiled } = parseGradersConfig(
      judgeConfig(`    per_model:
      $fast:
        judge: $strong
        passing_score: 4
        weight: 1.2
`),
    );
    expect(compiled[0]?.judgeSpec?.perModel).toEqual({
      fast: { judge: "$strong", passingScore: 4, weight: 1.2 },
    });
    // The `$` sigil is stripped on BOTH sides of the lookup, so an arm
    // reported as `fast` finds a `$fast` entry and vice versa.
    expect(perModelArmKey("$fast")).toBe("fast");
    expect(perModelOverrideFor(compiled[0]?.judgeSpec?.perModel, "fast")?.judge).toBe("$strong");
    expect(perModelOverrideFor(compiled[0]?.judgeSpec?.perModel, "$fast")?.judge).toBe("$strong");
    // No arm at all (an unrouted run) resolves nothing.
    expect(perModelOverrideFor(compiled[0]?.judgeSpec?.perModel, undefined)).toBeUndefined();
  });

  test("the file-level map merges UNDER the grader's own, per arm and field", () => {
    const { compiled } = parseGradersConfig(
      judgeConfig(
        `    per_model:
      $fast:
        judge: $strong
`,
        `per_model:
  $fast:
    judge: some-other-judge
    passing_score: 4
  $slow:
    weight: 3
`,
      ),
    );
    expect(compiled[0]?.judgeSpec?.perModel).toEqual({
      // grader-level `judge` wins; file-level `passing_score` survives
      fast: { judge: "$strong", passingScore: 4 },
      slow: { weight: 3 },
    });
  });

  test("two keys naming the same arm are a loud error", () => {
    expect(() =>
      parseGradersConfig(
        judgeConfig(`    per_model:
      $fast:
        judge: a
      fast:
        judge: b
`),
      ),
    ).toThrow(/name the same arm "fast"/);
  });

  test("a typoed override key fails at parse instead of being stripped", () => {
    expect(() =>
      parseGradersConfig(
        judgeConfig(`    per_model:
      $fast:
        judge_model: $strong
`),
      ),
    ).toThrow(/invalid graders config/);
  });

  test("a categorical rubric rejects per_model", () => {
    expect(() =>
      parseGradersConfig(`graders:
  - name: label
    type: llm_judge
    rubric:
      kind: categorical
      labels:
        - name: correct
          score: 1
          description: right
        - name: wrong
          score: 0
          description: not right
      passing_labels: [correct]
    per_model:
      $fast:
        judge: $strong
`),
    ).toThrow(/declares `per_model` with a categorical rubric/);
  });

  test("a `judges:` panel plus a per_model `judge:` is a loud error", () => {
    // `createJudgeGrader` takes the panel branch and never reads the single
    // model, so the per-arm judge would be dropped while run.json reported it
    // as the model that graded that arm.
    expect(() =>
      parseGradersConfig(
        judgeConfig(`    judges: [claude-haiku-4-5, claude-sonnet-5, claude-opus-4-7]
    per_model:
      $fast:
        judge: $strong
`),
      ),
    ).toThrow(/declares a `judges:` panel and a `per_model` `judge:` for arm "fast"/);
  });

  test("a panel plus a per_model entry carrying no judge still compiles", () => {
    // Only `judge:` collides with a panel — a per-arm cut and weight are
    // honoured by the panel path unchanged.
    const { compiled } = parseGradersConfig(
      judgeConfig(`    judges: [claude-haiku-4-5, claude-sonnet-5, claude-opus-4-7]
    per_model:
      $fast:
        passing_score: 4
`),
    );
    expect(compiled[0]?.judgeSpec?.perModel).toEqual({ fast: { passingScore: 4 } });
  });

  test("a FILE-level judge reaching a panel grader is rejected too", () => {
    // The file-level map merges onto every scalar llm_judge, the panel one
    // included — where it would be just as silently ignored.
    expect(() =>
      parseGradersConfig(`graders:
  - name: panel
    type: llm_judge
    judges: [claude-haiku-4-5, claude-sonnet-5, claude-opus-4-7]
${RUBRIC}
per_model:
  $fast:
    judge: $strong
`),
    ).toThrow(/move it onto the single-judge graders that consume it/);
  });

  test("a file-level map with no scalar llm_judge to consume it is a loud error", () => {
    expect(() =>
      parseGradersConfig(`graders:
  - name: exact
    type: exact_match
per_model:
  $fast:
    passing_score: 4
`),
    ).toThrow(/no scalar `type: llm_judge` grader can consume them/);
  });
});

describe("per_model and the graders lineage", () => {
  test("an existing graders.yaml parses unchanged — no perModel appears", () => {
    const { config, compiled } = parseGradersConfig(judgeConfig());
    expect(compiled[0]?.judgeSpec?.perModel).toBeUndefined();
    expect(Object.hasOwn(compiled[0]?.judgeSpec ?? {}, "perModel")).toBe(false);
    expect(Object.hasOwn(config, "per_model")).toBe(false);
    // The deterministic entries a mixed file carries are untouched too.
    const mixed = parseGradersConfig(`graders:
  - name: exact
    type: exact_match
`);
    expect(mixed.compiled[0]).toEqual({ name: "exact", grader: expect.any(Function), weight: 1 });
  });

  test("introducing a per_model map changes the gradersHash (a new lineage)", () => {
    const before = parseGradersConfig(judgeConfig()).config;
    const after = parseGradersConfig(
      judgeConfig(`    per_model:
      $fast:
        judge: $strong
`),
    ).config;
    expect(gradersHash(before)).not.toBe(gradersHash(after));
    // …and re-parsing the same file is stable (the hash is content identity,
    // not object identity).
    expect(gradersHash(parseGradersConfig(judgeConfig()).config)).toBe(gradersHash(before));
  });

  test("changing only the per_model judge changes the hash too", () => {
    const a = parseGradersConfig(
      judgeConfig(`    per_model:
      $fast:
        judge: $strong
`),
    ).config;
    const b = parseGradersConfig(
      judgeConfig(`    per_model:
      $fast:
        judge: $stronger
`),
    ).config;
    expect(gradersHash(a)).not.toBe(gradersHash(b));
  });
});

describe("per_model and categorical judges", () => {
  test("the file-level map is NOT merged onto a categorical judge", () => {
    const { compiled } = parseGradersConfig(`graders:
  - name: label
    type: llm_judge
    rubric:
      kind: categorical
      labels:
        - name: correct
          score: 1
          description: right
        - name: wrong
          score: 0
          description: not right
      passing_labels: [correct]
  - name: quality
    type: llm_judge
${RUBRIC}
per_model:
  $fast:
    judge: $strong
`);
    // A label-gated rubric has no scalar cut to move, and quietly handing it
    // a map it cannot honour is the silently-ignored-knob trap.
    expect(compiled[0]?.judgeSpec?.perModel).toBeUndefined();
    expect(compiled[1]?.judgeSpec?.perModel).toEqual({ fast: { judge: "$strong" } });
  });
});
