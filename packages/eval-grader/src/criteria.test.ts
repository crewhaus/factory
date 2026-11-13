import { describe, expect, test } from "bun:test";
import {
  applyGradersEdits,
  criterionDigest,
  graderSpecDigest,
  gradersConfigHash,
  inCriterionScope,
  loosening,
  parseGradersConfig,
  runCriteriaRecord,
} from "./index";

const BASE = `combine: all
graders:
  - name: exact
    type: exact_match
    trim: true
  - name: has
    type: contains
    substring: ok
  - name: judge
    type: llm_judge
    rubric:
      criteria:
        - name: correct
          description: the answer is correct
          anchors: { "1": a, "2": b, "3": c, "4": d, "5": e }
      passing_score: 3
`;

/** The digest `BASE` hashed to before criteria existed, pinned. */
const BASE_DIGEST = "329b18330e90b8bcdb6187531dd56fe4d41332633ed5d25d18f08364c07cc60f";

const withCriteria = (criteria: string): string => `${BASE}criteria:\n${criteria}`;

const hashOf = (yaml: string): string => gradersConfigHash(parseGradersConfig(yaml).config);

describe("criteria: the schema", () => {
  test("a full criterion parses and binds its graders", () => {
    const { config, compiled } = parseGradersConfig(
      withCriteria(`  - id: dates-local
    title: Dates use local time
    description: A date without a zone is local.
    severity: high
    owner: maintainers
    provenance: { source: guided-repair, change: chg_01abc }
    protected: true
    mode: observe
    scope: { metadata: { family: [csv, import] } }
    examples:
      acceptable: [{ text: "1 March, local", case: csv-017 }]
      unacceptable: [{ text: "2026-02-28T23:00Z" }]
    measured_by: [exact, judge]
`),
    );
    expect(config.criteria?.[0]?.id).toBe("dates-local");
    const exact = compiled.find((g) => g.name === "exact");
    expect(exact?.criterion).toEqual({
      id: "dates-local",
      mode: "observe",
      scope: { metadata: { family: ["csv", "import"] } },
    });
    expect(compiled.find((g) => g.name === "has")?.criterion).toBeUndefined();
  });

  test("each grader type carries its kind; a registry entry waits for its pack", () => {
    const { compiled } = parseGradersConfig(`graders:
  - { name: e, type: exact_match }
  - { name: c, type: contains, substring: x }
  - { name: x, type: expected_contains }
  - { name: r, type: regex, pattern: a }
  - { name: j, type: json_path, path: $.a }
  - { name: t, type: tool_call_sequence, expected: [a] }
  - name: judge
    type: llm_judge
    rubric:
      criteria: [{ name: c, description: d, anchors: { "1": a, "2": b, "3": c, "4": d, "5": e } }]
  - { name: reg, type: registry, grader: nlg.rougeL }
`);
    expect(compiled.map((g) => g.kind)).toEqual([
      "deterministic",
      "deterministic",
      "deterministic",
      "deterministic",
      "deterministic",
      "deterministic",
      "model",
      undefined,
    ]);
  });

  test("a typoed key is refused, as is an id that is not a slug", () => {
    expect(() =>
      parseGradersConfig(
        withCriteria("  - id: a-b\n    measured_by: [exact]\n    modes: observe\n"),
      ),
    ).toThrow(/invalid graders config/);
    expect(() =>
      parseGradersConfig(withCriteria("  - id: Bad_Id\n    measured_by: [exact]\n")),
    ).toThrow(/lower-case slug/);
    expect(() => parseGradersConfig(withCriteria("  - id: ok-id\n    measured_by: []\n"))).toThrow(
      /invalid graders config/,
    );
    expect(() =>
      parseGradersConfig(
        withCriteria("  - id: ok-id\n    measured_by: [exact]\n    mode: maybe\n"),
      ),
    ).toThrow(/invalid graders config/);
  });

  test("measured_by names a grader in this file", () => {
    expect(() => parseGradersConfig(withCriteria("  - id: ab\n    measured_by: [nope]\n"))).toThrow(
      /criterion "ab" is measured by "nope", which is no grader/,
    );
  });

  test("a grader measures at most one criterion", () => {
    expect(() =>
      parseGradersConfig(
        withCriteria(
          "  - id: ab\n    measured_by: [exact]\n  - id: cd\n    measured_by: [exact]\n",
        ),
      ),
    ).toThrow(/grader "exact" is bound by criteria "ab" and "cd"/);
  });

  test("ids are unique", () => {
    expect(() =>
      parseGradersConfig(
        withCriteria("  - id: ab\n    measured_by: [exact]\n  - id: ab\n    measured_by: [has]\n"),
      ),
    ).toThrow(/criterion "ab" is declared twice/);
  });

  test("scope values are non-empty lists of strings, and the error names the criterion", () => {
    expect(() =>
      parseGradersConfig(
        withCriteria(
          "  - id: ab\n    measured_by: [exact]\n    scope: { metadata: { family: [1] } }\n",
        ),
      ),
    ).toThrow(/criterion "ab" scope metadata "family" must be a non-empty list of strings/);
    expect(() =>
      parseGradersConfig(
        withCriteria(
          "  - id: ab\n    measured_by: [exact]\n    scope: { metadata: { family: csv } }\n",
        ),
      ),
    ).toThrow(/criterion "ab" scope metadata "family"/);
  });

  test("scope matches string metadata only, every key at once", () => {
    const scope = { metadata: { family: ["csv"], lang: ["en", "de"] } };
    expect(inCriterionScope(scope, { family: "csv", lang: "de" })).toBe(true);
    expect(inCriterionScope(scope, { family: "csv", lang: "fr" })).toBe(false);
    expect(inCriterionScope(scope, { family: "csv" })).toBe(false);
    expect(inCriterionScope({ metadata: { n: ["1"] } }, { n: 1 })).toBe(false);
    expect(inCriterionScope(undefined, undefined)).toBe(true);
  });
});

describe("gradersHash: the measurement projection", () => {
  test("a file without criteria hashes to the digest it always had", () => {
    expect(hashOf(BASE)).toBe(BASE_DIGEST);
  });

  test("criteria that only describe their graders hash the same", () => {
    expect(
      hashOf(
        withCriteria(`  - id: ab
    title: t
    description: d
    severity: low
    owner: o
    provenance: { source: human }
    protected: true
    mode: enforce
    examples: { acceptable: [{ text: x }] }
    measured_by: [exact]
`),
      ),
    ).toBe(BASE_DIGEST);
  });

  test("observing, or a scope, moves the hash", () => {
    const observe = hashOf(
      withCriteria("  - id: ab\n    mode: observe\n    measured_by: [exact]\n"),
    );
    const scoped = hashOf(
      withCriteria(
        "  - id: ab\n    scope: { metadata: { family: [csv] } }\n    measured_by: [exact]\n",
      ),
    );
    expect(observe).not.toBe(BASE_DIGEST);
    expect(scoped).not.toBe(BASE_DIGEST);
    expect(observe).not.toBe(scoped);
  });

  test("adding a description to an observing criterion keeps its hash", () => {
    const a = hashOf(withCriteria("  - id: ab\n    mode: observe\n    measured_by: [exact]\n"));
    const b = hashOf(
      withCriteria(
        "  - id: ab\n    mode: observe\n    description: why\n    measured_by: [exact]\n",
      ),
    );
    expect(b).toBe(a);
  });
});

describe("digests", () => {
  test("a criterion's digest covers its text and its graders' specs", () => {
    const one = parseGradersConfig(withCriteria("  - id: ab\n    measured_by: [exact]\n")).config;
    const two = parseGradersConfig(
      withCriteria("  - id: ab\n    description: d\n    measured_by: [exact]\n"),
    ).config;
    const c1 = one.criteria?.[0];
    const c2 = two.criteria?.[0];
    if (c1 === undefined || c2 === undefined) throw new Error("no criteria");
    const exact = one.graders[0];
    if (exact === undefined) throw new Error("no grader");
    expect(criterionDigest(c1, [exact])).not.toBe(criterionDigest(c2, [exact]));
    expect(criterionDigest(c1, [exact])).not.toBe(
      criterionDigest(c1, [{ ...exact, trim: false } as typeof exact]),
    );
    expect(graderSpecDigest(exact)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a run records criteria only when the file has some", () => {
    expect(runCriteriaRecord(parseGradersConfig(BASE).config)).toBeUndefined();
    const record = runCriteriaRecord(
      parseGradersConfig(
        withCriteria("  - id: ab\n    protected: true\n    measured_by: [exact, has]\n"),
      ).config,
    );
    expect(record?.[0]?.mode).toBe("enforce");
    expect(record?.[0]?.protected).toBe(true);
    expect(record?.[0]?.graders.map((g) => g.name)).toEqual(["exact", "has"]);
  });

  test("the file's policy moves what measures a criterion, though not its own digest", () => {
    const yaml = withCriteria("  - id: ab\n    protected: true\n    measured_by: [exact, has]\n");
    const recordOf = (text: string) => runCriteriaRecord(parseGradersConfig(text).config)?.[0];
    const was = recordOf(yaml);
    for (const changed of [
      yaml.replace("combine: all\n", "combine: any\n"),
      yaml.replace("combine: all\n", "combine: all\nper_model:\n  $fast: { passing_score: 1 }\n"),
      yaml.replace("combine: all\n", "combine: weighted\npassing_threshold: 0.1\n"),
    ]) {
      const now = recordOf(changed);
      expect(now?.digest).toBe(was?.digest as string);
      expect(now?.measuring).toMatch(/^[0-9a-f]{64}$/);
      expect(now?.measuring).not.toBe(was?.measuring as string);
    }
  });
});

describe("applyGradersEdits", () => {
  const FILE = `# the graders for the demo
combine: all # every grader must pass
graders:
  - name: exact
    type: exact_match
  - name: has
    type: contains
    substring: ok
  - name: judge
    type: llm_judge
    rubric:
      criteria:
        - name: correct
          description: the answer is correct
          anchors: { "1": a, "2": b, "3": c, "4": d, "5": e }
      passing_score: 4
criteria:
  # dates matter
  - id: ab
    title: First
    measured_by: [exact]
`;

  test("keeps comments and key order while it edits", () => {
    const out = applyGradersEdits(FILE, [
      { op: "setText", id: "ab", field: "title", value: "Renamed" },
    ]);
    expect(out.yaml).toContain("# the graders for the demo");
    expect(out.yaml).toContain("# every grader must pass");
    expect(out.yaml).toContain("# dates matter");
    expect(out.yaml).toContain("title: Renamed");
    expect(out.yaml.indexOf("combine:")).toBeGreaterThan(-1);
    expect(out.yaml.indexOf("combine:")).toBeLessThan(out.yaml.indexOf("graders:"));
    expect(out.changed).toEqual([
      { criterion: "ab", before: expect.any(String), after: expect.any(String) },
    ]);
  });

  test("keeps a key this version does not know on a grader", () => {
    const file = FILE.replace("    substring: ok\n", "    substring: ok\n    note: kept\n");
    const out = applyGradersEdits(file, [{ op: "setMode", id: "ab", value: "observe" }]);
    expect(out.yaml).toContain("note: kept");
  });

  test("every op", () => {
    let yaml = FILE;
    const run = (edit: Parameters<typeof applyGradersEdits>[1][number]) => {
      const out = applyGradersEdits(yaml, [edit]);
      yaml = out.yaml;
      return out;
    };
    run({ op: "addCriterion", criterion: { id: "cd", measured_by: ["has"] } });
    run({ op: "setText", id: "cd", field: "description", value: "why" });
    run({ op: "addExample", id: "cd", kind: "acceptable", example: { text: "fine", case: "c1" } });
    run({ op: "addExample", id: "cd", kind: "acceptable", example: { text: "also" } });
    run({ op: "removeExample", id: "cd", kind: "acceptable", index: 0 });
    run({ op: "setSeverity", id: "cd", value: "critical" });
    run({ op: "setOwner", id: "cd", value: "qa" });
    run({ op: "setMode", id: "cd", value: "observe" });
    run({ op: "setScope", id: "cd", value: { metadata: { family: ["csv"] } } });
    run({ op: "setProtected", id: "cd", value: true });
    run({ op: "bind", id: "cd", grader: "judge" });
    run({ op: "unbind", id: "cd", grader: "has" });
    run({ op: "editRubricCriterion", grader: "judge", criterion: "correct", description: "exact" });
    const last = run({ op: "setPassingScore", grader: "judge", value: 5 });
    const cd = last.config.criteria?.find((c) => c.id === "cd");
    expect(cd).toEqual({
      id: "cd",
      measured_by: ["judge"],
      description: "why",
      examples: { acceptable: [{ text: "also" }] },
      severity: "critical",
      owner: "qa",
      mode: "observe",
      scope: { metadata: { family: ["csv"] } },
      protected: true,
    });
    const judge = last.config.graders.find((g) => g.name === "judge");
    expect(
      judge?.type === "llm_judge" && judge.rubric.kind !== "categorical"
        ? [judge.rubric.passing_score, judge.rubric.criteria[0]?.description]
        : [],
    ).toEqual([5, "exact"]);
    run({ op: "setText", id: "cd", field: "description", value: null });
    run({ op: "setSeverity", id: "cd", value: null });
    run({ op: "setScope", id: "cd", value: null });
    run({ op: "setProtected", id: "cd", value: false });
    const removed = run({ op: "removeCriterion", id: "cd" });
    expect(removed.config.criteria?.map((c) => c.id)).toEqual(["ab"]);
    expect(removed.changed).toEqual([{ criterion: "cd", before: expect.any(String) }]);
  });

  test("an edit that breaks the file throws and returns nothing", () => {
    expect(() => applyGradersEdits(FILE, [{ op: "unbind", id: "ab", grader: "exact" }])).toThrow(
      /invalid graders config/,
    );
    expect(() => applyGradersEdits(FILE, [{ op: "bind", id: "ab", grader: "ghost" }])).toThrow(
      /no grader "ghost"/,
    );
    expect(() => applyGradersEdits(FILE, [{ op: "setMode", id: "zz", value: "observe" }])).toThrow(
      /no criterion "zz"/,
    );
    expect(() =>
      applyGradersEdits(FILE, [{ op: "setPassingScore", grader: "exact", value: 2 }]),
    ).toThrow(/not an llm_judge/);
    expect(() =>
      applyGradersEdits(FILE, [
        { op: "addCriterion", criterion: { id: "ab", measured_by: ["has"] } },
      ]),
    ).toThrow(/already exists/);
    expect(() =>
      applyGradersEdits(FILE, [
        { op: "nope" } as unknown as Parameters<typeof applyGradersEdits>[1][number],
      ]),
    ).toThrow(/is not a graders edit/);
  });

  test("the result carries the edited file's gradersHash", () => {
    const out = applyGradersEdits(FILE, [{ op: "setMode", id: "ab", value: "observe" }]);
    expect(out.gradersHash).toBe(gradersConfigHash(parseGradersConfig(out.yaml).config));
    expect(out.gradersHash).not.toBe(gradersConfigHash(parseGradersConfig(FILE).config));
  });
});

describe("loosening", () => {
  const PROTECTED = withCriteria(`  - id: ab
    protected: true
    scope: { metadata: { family: [csv, json] } }
    measured_by: [exact, judge]
`);
  const before = parseGradersConfig(PROTECTED).config;
  const edited = (edits: Parameters<typeof applyGradersEdits>[1]) =>
    applyGradersEdits(PROTECTED, edits).config;

  test("each way a protected criterion loosens is named", () => {
    const cases: Array<[Parameters<typeof applyGradersEdits>[1], RegExp]> = [
      [[{ op: "setProtected", id: "ab", value: false }], /protection is removed/],
      [[{ op: "setMode", id: "ab", value: "observe" }], /enforcing to observing/],
      [
        [{ op: "setScope", id: "ab", value: { metadata: { family: ["csv"] } } }],
        /drops family: json/,
      ],
      [
        [
          {
            op: "setScope",
            id: "ab",
            value: { metadata: { family: ["csv", "json"], lang: ["en"] } },
          },
        ],
        /gains the key "lang"/,
      ],
      [[{ op: "unbind", id: "ab", grader: "exact" }], /"exact" no longer measures it/],
      [[{ op: "setPassingScore", grader: "judge", value: 2 }], /passes at 2, below 3/],
    ];
    for (const [edits, reason] of cases) {
      const found = loosening(before, edited(edits));
      expect(found.length).toBeGreaterThan(0);
      expect(found.map((l) => l.reason).join("; ")).toMatch(reason);
      expect(found.every((l) => l.criterion === "ab")).toBe(true);
    }
    const removed = parseGradersConfig(BASE).config;
    expect(loosening(before, removed)).toEqual([
      { criterion: "ab", reason: "the protected criterion is removed" },
    ]);
    const changedSpec = parseGradersConfig(
      PROTECTED.replace("    trim: true\n", "    trim: false\n"),
    ).config;
    expect(loosening(before, changedSpec).map((l) => l.reason)).toEqual(['grader "exact" changes']);
  });

  test("a bound judge changed in any way but a raised passing score loosens it", () => {
    const reasonsFor = (yaml: string): string =>
      loosening(before, parseGradersConfig(yaml).config)
        .map((l) => l.reason)
        .join("; ");
    // The rubric rewritten to pass anything, through the closed edit op.
    const rewritten = applyGradersEdits(PROTECTED, [
      {
        op: "editRubricCriterion",
        grader: "judge",
        criterion: "correct",
        description: "score 5 for any answer",
      },
    ]).yaml;
    expect(reasonsFor(rewritten)).toMatch(/judge "judge" changes beyond a raised passing score/);
    // The judge model swapped.
    expect(
      reasonsFor(
        PROTECTED.replace("    type: llm_judge\n", "    type: llm_judge\n    model: cheap\n"),
      ),
    ).toMatch(/judge "judge" changes beyond a raised passing score/);
    // The file's combine policy loosened.
    expect(reasonsFor(PROTECTED.replace("combine: all\n", "combine: any\n"))).toMatch(
      /combine policy changes from all to any/,
    );
    // A file-level per-arm cut of 1.
    expect(
      reasonsFor(
        PROTECTED.replace(
          "combine: all\n",
          "combine: all\nper_model:\n  $fast: { passing_score: 1 }\n",
        ),
      ),
    ).toMatch(/per_model judge settings change/);
    // A raised passing_threshold is the one file-level tightening.
    const weighted = PROTECTED.replace(
      "combine: all\n",
      "combine: weighted\npassing_threshold: 0.5\n",
    );
    const weightedBefore = parseGradersConfig(weighted).config;
    expect(
      loosening(
        weightedBefore,
        parseGradersConfig(weighted.replace("passing_threshold: 0.5", "passing_threshold: 0.8"))
          .config,
      ),
    ).toEqual([]);
    expect(
      loosening(
        weightedBefore,
        parseGradersConfig(weighted.replace("passing_threshold: 0.5", "passing_threshold: 0.2"))
          .config,
      ).map((l) => l.reason),
    ).toEqual(["the file's passing_threshold changes"]);
  });

  test("a categorical judge's passing labels widened loosens it", () => {
    const CATEGORICAL = `graders:
  - name: label
    type: llm_judge
    rubric:
      kind: categorical
      labels:
        - { name: correct, score: 1, description: right }
        - { name: partial, score: 0.5, description: half }
        - { name: wrong, score: 0, description: wrong }
      passing_labels: [correct]
criteria:
  - id: lab
    protected: true
    measured_by: [label]
`;
    const widened = CATEGORICAL.replace(
      "passing_labels: [correct]",
      "passing_labels: [correct, partial, wrong]",
    );
    expect(
      loosening(parseGradersConfig(CATEGORICAL).config, parseGradersConfig(widened).config),
    ).toEqual([
      { criterion: "lab", reason: 'judge "label" changes beyond a raised passing score' },
    ]);
  });

  test("a tightening loosens nothing, and an unprotected criterion never loosens", () => {
    expect(
      loosening(before, edited([{ op: "setPassingScore", grader: "judge", value: 4 }])),
    ).toEqual([]);
    expect(loosening(before, edited([{ op: "setScope", id: "ab", value: null }]))).toEqual([]);
    expect(
      loosening(before, edited([{ op: "setText", id: "ab", field: "title", value: "t" }])),
    ).toEqual([]);
    const open = parseGradersConfig(withCriteria("  - id: ab\n    measured_by: [exact]\n")).config;
    expect(loosening(open, parseGradersConfig(BASE).config)).toEqual([]);
  });
});
