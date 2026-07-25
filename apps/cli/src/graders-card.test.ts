/**
 * NEW-HUNT-11 — unit tests for the graders rubric card renderer. Pure
 * renderer: every test parses a real graders.yaml through
 * `parseGradersConfig` (the card documents the PARSED instrument, exactly
 * what history hashes) and asserts on the markdown. No credentials, no
 * filesystem, no wall clock.
 */
import { describe, expect, test } from "bun:test";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import { renderGradersCard } from "./graders-card";

const HASH = "a".repeat(64);

function card(yaml: string): string {
  return renderGradersCard({
    config: parseGradersConfig(yaml).config,
    gradersHash: HASH,
    source: "eval/graders.yaml",
  });
}

const FULL_YAML = `
combine: weighted
passing_threshold: 0.7
graders:
  - name: math_exact
    type: exact_match
    trim: true
    weight: 2
  - name: schema_check
    type: regex
    pattern: '^The answer is \\d+'
  - name: tool_use
    type: tool_call_sequence
    expected: [bash, read]
    mode: subseq
  - name: judge_correct
    type: llm_judge
    weight: 3
    temperature: 0.2
    repeats: 3
    target: transcript
    judges: [claude-sonnet-4-5, openai/gpt-4o]
    rubric:
      passing_score: 4
      criteria:
        - name: correctness
          description: Factually correct and complete.
          anchors:
            "1": wrong
            "2": mostly wrong
            "3": adequate
            "4": good
            "5": excellent
  - name: close_enough
    type: registry
    grader: semantic.similarity
    opts:
      threshold: 0.8
      disableFallback: true
`;

describe("renderGradersCard", () => {
  test("deterministic: two renders of the same config are byte-identical", () => {
    expect(card(FULL_YAML)).toBe(card(FULL_YAML));
  });

  test("header carries the caller-supplied gradersHash and source — never a timestamp", () => {
    const md = card(FULL_YAML);
    expect(md).toContain("# Grader rubric card — eval/graders.yaml");
    expect(md).toContain(`\`${HASH}\``);
    expect(md).toContain("run-history index");
    // Identity is CONTENT-derived only: no wall clock, no file mtime — a
    // timestamp of any kind would make a regenerated card diff against the
    // committed one on a fresh clone/checkout with zero instrument change.
    const timestamps = md.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g) ?? [];
    expect(timestamps).toEqual([]);
    expect(md).not.toContain("file mtime");
  });

  test("combine policy renders with the declared weighted threshold", () => {
    const md = card(FULL_YAML);
    expect(md).toContain("`weighted`");
    expect(md).toContain(">= 0.7");
    expect(md).toContain("- **graders**: 5 (1 llm_judge, 1 registry, 3 deterministic)");
  });

  test("policy-less config reads as the `all` default", () => {
    const md = card("graders:\n  - name: g\n    type: exact_match\n");
    expect(md).toContain("`all` (default)");
  });

  test("deterministic graders document their thresholds/options", () => {
    const md = card(FULL_YAML);
    expect(md).toContain("## 1. math_exact — `exact_match`");
    expect(md).toContain("| weight | 2 |");
    expect(md).toContain("| trim | true |");
    expect(md).toContain("| pattern | `^The answer is \\d+` |");
    expect(md).toContain("| expected | bash, read |");
    expect(md).toContain("| mode | subseq |");
  });

  test("llm_judge documents panel/repeats/temperature/target + the passing cut + anchors", () => {
    const md = card(FULL_YAML);
    expect(md).toContain("## 4. judge_correct — `llm_judge` (scalar rubric)");
    expect(md).toContain("claude-sonnet-4-5, openai/gpt-4o");
    expect(md).toContain("| temperature | 0.2 |");
    expect(md).toContain("| repeats | 3 (median, per panelist) |");
    expect(md).toContain("| target | transcript |");
    expect(md).toContain("score >= 4 of 5");
    expect(md).toContain("**correctness** — Factually correct and complete.");
    expect(md).toContain("| 5 | excellent |");
  });

  test("judge decoding defaults are documented as the pinned defaults", () => {
    const md = card(
      "graders:\n" +
        "  - name: j\n" +
        "    type: llm_judge\n" +
        "    rubric:\n" +
        "      criteria:\n" +
        "        - name: c\n" +
        "          description: d\n" +
        '          anchors: { "1": a, "2": b, "3": c, "4": d, "5": e }\n',
    );
    expect(md).toContain("| model | (runner default / --judge-model) |");
    expect(md).toContain("| temperature | 0 (pinned default) |");
    expect(md).toContain("| repeats | 1 (default) |");
    expect(md).toContain("| target | output (default) |");
    // No declared passing_score: the schema default AND the calibrated-cut
    // override are both part of the instrument's documentation.
    expect(md).toContain("score >= 3 of 5 (schema default");
    expect(md).toContain("judge calibrate --apply");
  });

  test("categorical rubrics render labels, declared scores, and the passing set", () => {
    const md = card(
      "graders:\n" +
        "  - name: label_judge\n" +
        "    type: llm_judge\n" +
        "    rubric:\n" +
        "      kind: categorical\n" +
        "      labels:\n" +
        "        - name: correct\n" +
        "          score: 1\n" +
        "          description: factually correct\n" +
        "        - name: wrong\n" +
        "          score: 0\n" +
        "          description: contains an error\n" +
        "      passing_labels: [correct]\n",
    );
    expect(md).toContain("`llm_judge` (categorical rubric)");
    expect(md).toContain("| passing labels | correct |");
    expect(md).toContain("| `correct` | score 1, **passes** — factually correct |");
    expect(md).toContain("| `wrong` | score 0 — contains an error |");
  });

  test("registry entries render the pack name and every opts key", () => {
    const md = card(FULL_YAML);
    expect(md).toContain("## 5. close_enough — `registry` → `semantic.similarity`");
    expect(md).toContain("| opts.threshold | 0.8 |");
    expect(md).toContain("| opts.disableFallback | true |");
  });

  test("registry entries without opts read as pack defaults", () => {
    const md = card("graders:\n  - name: r\n    type: registry\n    grader: nlg.rougeL\n");
    expect(md).toContain("| opts | (none — pack defaults) |");
  });

  test("pipes and newlines in user content are escaped/flattened so table cells never split", () => {
    const md = card(
      "graders:\n" +
        "  - name: yesno\n" +
        "    type: regex\n" +
        "    pattern: '^(yes|no)$'\n" +
        "  - name: pipe_sub\n" +
        "    type: contains\n" +
        "    substring: 'a | b'\n" +
        "  - name: j\n" +
        "    type: llm_judge\n" +
        "    rubric:\n" +
        "      criteria:\n" +
        "        - name: c\n" +
        "          description: d\n" +
        "          anchors:\n" +
        '            "1": bad\n' +
        '            "2": poor\n' +
        '            "3": |-\n' +
        "              either|or\n" +
        "              on two lines\n" +
        '            "4": good\n' +
        '            "5": great\n',
    );
    // Alternation regex: the interior pipe is escaped (GFM splits cells on
    // unescaped pipes even inside code spans), keeping a 2-column row.
    expect(md).toContain("| pattern | `^(yes\\|no)$` |");
    expect(md).not.toContain("| pattern | `^(yes|");
    expect(md).toContain("| substring | a \\| b |");
    // A multi-line anchor flattens to one row; its pipe is escaped too.
    expect(md).toContain("| 3 | either\\|or on two lines |");
    // No data row anywhere carries a third column from an unescaped pipe.
    for (const line of md.split("\n")) {
      if (!line.startsWith("| ")) continue;
      const unescapedPipes = line.match(/(?<!\\)\|/g) ?? [];
      expect(unescapedPipes.length).toBe(3);
    }
  });
});
