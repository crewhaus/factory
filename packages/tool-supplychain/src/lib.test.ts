import { describe, expect, test } from "bun:test";
/**
 * The pure half of this package: the YAML subset reader, the CVSS
 * calculator, the OSV record shaping, and the workflow rules. Nothing here
 * touches the filesystem or a socket, so everything here is exact.
 */
import { cvssRating, parseCvss, severityRank } from "./lib/cvss";
import {
  affectedFor,
  buildQueryBatch,
  chunk,
  describeInterval,
  osvEcosystem,
  parseQueryBatchResponse,
  parseVulnRecord,
} from "./lib/osv";
import {
  auditWorkflow,
  classifyExpression,
  classifyRunsOn,
  expressionsIn,
  inventoryUses,
  parseUses,
  readPermissions,
  readWorkflow,
  sortFindings,
} from "./lib/workflow";
import {
  asList,
  asString,
  mapEntry,
  mapGet,
  mapKeys,
  parseYamlSubset,
  sourceLinesOf,
} from "./lib/yaml";

const coord = (name: string, version: string, ecosystem: "npm" | "cargo" = "npm") => ({
  ecosystem,
  name,
  version,
  source: "bun.lock",
});

// ---------------------------------------------------------------------------

describe("the YAML subset reader", () => {
  test("reads a workflow into maps, sequences and inline step mappings", () => {
    const parsed = parseYamlSubset(
      [
        "name: CI",
        "on:",
        "  push:",
        "    branches: [main]",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "        with:",
        "          fetch-depth: 0",
        "      - run: bun test",
        "",
      ].join("\n"),
    );
    expect(parsed.warnings).toEqual([]);
    expect(mapKeys(parsed.doc)).toEqual(["name", "on", "jobs"]);
    const steps = asList(mapGet(mapGet(mapGet(parsed.doc, "jobs"), "build"), "steps"));
    expect(steps.length).toBe(2);
    expect(asString(mapGet(steps[0], "uses"))).toBe("actions/checkout@v4");
    expect(asString(mapGet(mapGet(steps[0], "with"), "fetch-depth"))).toBe("0");
    expect(asString(mapGet(steps[1], "run"))).toBe("bun test");
  });

  test("`on` stays the string `on` and is not resolved to a boolean", () => {
    // A YAML 1.1 loader turns the bare word into `true`, which is how a
    // round-tripped workflow ends up with a literal `true:` key.
    expect(mapKeys(parseYamlSubset("on: push\n").doc)).toEqual(["on"]);
    expect(mapKeys(parseYamlSubset('"on": push\n').doc)).toEqual(["on"]);
    expect(asString(mapGet(parseYamlSubset("on: push\n").doc, "on"))).toBe("push");
  });

  test("a literal block scalar keeps its newlines, its `#` and its line numbers", () => {
    const parsed = parseYamlSubset(
      ["steps:", "  - run: |", "      echo one # kept", "      echo two", "    shell: bash"].join(
        "\n",
      ),
    );
    const step = asList(mapGet(parsed.doc, "steps"))[0];
    expect(asString(mapGet(step, "run"))).toBe("echo one # kept\necho two\n");
    expect(sourceLinesOf(mapGet(step, "run")).map((l) => l.line)).toEqual([3, 4]);
    expect(asString(mapGet(step, "shell"))).toBe("bash");
  });

  test("a folded block scalar folds line breaks and keeps paragraph breaks", () => {
    const parsed = parseYamlSubset(["a: >", "  one", "  two", "", "  three", "b: x"].join("\n"));
    // n blank lines fold to n newlines, not n+1 — the break that ended the
    // previous text line is the one that was folded away.
    expect(asString(mapGet(parsed.doc, "a"))).toBe("one two\nthree\n");
    expect(asString(mapGet(parsed.doc, "b"))).toBe("x");
  });

  test("chomping and an explicit indentation indicator are honoured", () => {
    expect(asString(mapGet(parseYamlSubset("a: |-\n  x\n  y\n").doc, "a"))).toBe("x\ny");
    expect(asString(mapGet(parseYamlSubset("a: |+\n  x\n").doc, "a"))).toBe("x\n");
    expect(asString(mapGet(parseYamlSubset("a: |+\n  x\n\n\nb: 1\n").doc, "a"))).toBe("x\n\n\n");
    expect(asString(mapGet(parseYamlSubset("a: |\n  x\n\n\nb: 1\n").doc, "a"))).toBe("x\n");
    expect(asString(mapGet(parseYamlSubset("a: |2\n    x\nb: 1\n").doc, "a"))).toBe("  x\n");
    expect(asString(mapGet(parseYamlSubset("a: |2-\n    x\nb: 1\n").doc, "b"))).toBe("1");
  });

  test("a plain scalar loses a trailing comment; a colon without a space does not split", () => {
    const parsed = parseYamlSubset(
      ["a: echo hi # note", "b: docker run -p 8080:80 img", "c: 'has # inside'"].join("\n"),
    );
    expect(asString(mapGet(parsed.doc, "a"))).toBe("echo hi");
    expect(asString(mapGet(parsed.doc, "b"))).toBe("docker run -p 8080:80 img");
    expect(asString(mapGet(parsed.doc, "c"))).toBe("has # inside");
  });

  test("flow collections parse, including the empty mapping", () => {
    const parsed = parseYamlSubset(
      ["permissions: {}", "runs-on: [self-hosted, linux]", "env: {A: 1, B: 'two'}"].join("\n"),
    );
    expect(mapKeys(mapGet(parsed.doc, "permissions"))).toEqual([]);
    expect(asList(mapGet(parsed.doc, "runs-on")).map(asString)).toEqual(["self-hosted", "linux"]);
    expect(asString(mapGet(mapGet(parsed.doc, "env"), "B"))).toBe("two");
  });

  test("a wrapped plain scalar folds, and the next key is not swallowed by it", () => {
    const parsed = parseYamlSubset(
      ["steps:", "  - if: a == 'x' &&", "      b == 'y'", "    run: echo hi"].join("\n"),
    );
    const step = asList(mapGet(parsed.doc, "steps"))[0];
    expect(asString(mapGet(step, "if"))).toBe("a == 'x' && b == 'y'");
    expect(asString(mapGet(step, "run"))).toBe("echo hi");
  });

  test("double-quoted escapes and multi-line quoted scalars are resolved", () => {
    expect(asString(mapGet(parseYamlSubset('a: "x\\ny\\u0041"\n').doc, "a"))).toBe("x\nyA");
    expect(asString(mapGet(parseYamlSubset("a: 'it''s'\n").doc, "a"))).toBe("it's");
    expect(asString(mapGet(parseYamlSubset('a: "one\n  two"\nb: 1\n').doc, "a"))).toBe("one two");
  });

  test("last key wins on a duplicate, and the duplicate is reported", () => {
    const parsed = parseYamlSubset("permissions: read-all\npermissions: write-all\n");
    expect(asString(mapGet(parsed.doc, "permissions"))).toBe("write-all");
    expect(parsed.warnings.map((w) => w.code)).toContain("duplicate-key");
  });

  test("every construct outside the subset is reported rather than skipped", () => {
    const cases: Array<[string, string]> = [
      ["tab-indent", "a:\n\tb: 1\n"],
      ["multiple-documents", "a: 1\n---\nb: 2\n"],
      ["anchor-unsupported", "a: &anchor 1\n"],
      ["alias-unsupported", "a: *anchor\n"],
      ["merge-key-unsupported", "a:\n  <<: *base\n  b: 1\n"],
      ["unterminated-quote", 'a: "never closed\n'],
      ["unterminated-flow", "a: [1, 2\n"],
      ["unparsed-line", "a:\n  - - nested\n"],
    ];
    for (const [code, text] of cases) {
      expect({ code, seen: parseYamlSubset(text).warnings.map((w) => w.code) }).toEqual({
        code,
        seen: expect.arrayContaining([code]),
      });
    }
  });

  test("warnings are capped, and the cap says so", () => {
    // Five thousand duplicate keys are five thousand true warnings and none
    // of them worth a context window; de-duplicating by scanning a growing
    // array also made this file quadratic.
    const parsed = parseYamlSubset("a:\n".repeat(5_000));
    expect(parsed.warnings.length).toBe(201);
    expect(parsed.warnings[200]?.code).toBe("warning-limit");
    expect(parsed.warnings[200]?.message).toContain("not listed");
  });

  test("a file too large to be a workflow is refused, not walked", () => {
    const huge = `a: ${"x".repeat(4_000_001)}`;
    const parsed = parseYamlSubset(huge);
    expect(parsed.doc).toBeUndefined();
    expect(parsed.warnings[0]?.code).toBe("too-large");
  });

  test("nesting past the depth limit is reported and consumed, not looped on", () => {
    let text = "";
    for (let n = 0; n < 130; n += 1) text += `${" ".repeat(n * 2)}k${n}:\n`;
    const parsed = parseYamlSubset(`${text}${" ".repeat(260)}leaf: 1\n`);
    expect(parsed.warnings.map((w) => w.code)).toContain("depth-limit");
  });

  test("accessors answer the same for a scalar, a sequence and a mapping", () => {
    expect(
      asList(parseYamlSubset("a: one\n").doc && mapGet(parseYamlSubset("a: one\n").doc, "a"))
        .length,
    ).toBe(1);
    expect(asList(mapGet(parseYamlSubset("a: [1, 2]\n").doc, "a")).length).toBe(2);
    expect(asList(mapGet(parseYamlSubset("a:\n  x: 1\n  y: 2\n").doc, "a")).length).toBe(2);
    expect(asList(undefined)).toEqual([]);
    expect(asString(mapGet(parseYamlSubset("a:\n").doc, "a"))).toBeUndefined();
    expect(mapEntry(parseYamlSubset("a: 1\n").doc, "a")?.line).toBe(1);
    expect(mapEntry(parseYamlSubset("a: 1\n").doc, "zz")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("CVSS base scores", () => {
  test("published vectors score what the specification says they score", () => {
    const cases: Array<[string, number]> = [
      ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8],
      ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", 10],
      ["CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N", 6.1],
      ["CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H", 7.8],
      ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H", 7.5],
      ["CVSS:3.1/AV:N/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N", 2],
      ["CVSS:3.1/AV:P/AC:H/PR:H/UI:R/S:U/C:N/I:N/A:N", 0],
      ["CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8],
    ];
    for (const [vector, expected] of cases) {
      expect({ vector, score: parseCvss(vector).baseScore }).toEqual({ vector, score: expected });
    }
  });

  test("a version this file does not compute is reported, never scored with v3 weights", () => {
    // `AV:N` means the same in v2, v3 and v4 and the coefficients do not, so a
    // v3 calculation over either produces a plausible, wrong number.
    const v2 = parseCvss("AV:N/AC:L/Au:N/C:P/I:P/A:P");
    expect({ version: v2.version, score: v2.baseScore }).toEqual({
      version: "2.0",
      score: undefined,
    });
    const v4 = parseCvss("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N");
    expect({ version: v4.version, score: v4.baseScore }).toEqual({
      version: "4.0",
      score: undefined,
    });
    expect(v4.note).toContain("v4.0");
  });

  test("a malformed or incomplete vector yields no score and says why", () => {
    expect(parseCvss("").version).toBe("unknown");
    expect(parseCvss("garbage").baseScore).toBeUndefined();
    const missingScope = parseCvss("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/C:H/I:H/A:H");
    expect(missingScope.baseScore).toBeUndefined();
    expect(missingScope.note).toContain("Scope");
    const missingMetric = parseCvss("CVSS:3.1/AV:N/AC:L/PR:N/S:U/C:H/I:H/A:H");
    expect(missingMetric.note).toContain("UI");
  });

  test("ratings fall on the specification's boundaries", () => {
    expect([0, 0.1, 3.9, 4, 6.9, 7, 8.9, 9, 10].map(cvssRating)).toEqual([
      "NONE",
      "LOW",
      "LOW",
      "MEDIUM",
      "MEDIUM",
      "HIGH",
      "HIGH",
      "CRITICAL",
      "CRITICAL",
    ]);
  });

  test("an unscored advisory ranks below every scored one instead of vanishing", () => {
    const ranks = [
      severityRank(9.8, undefined),
      severityRank(4.1, undefined),
      severityRank(undefined, "CRITICAL"),
      severityRank(undefined, "MODERATE"),
      severityRank(undefined, undefined),
    ];
    expect(ranks[0]).toBeLessThan(ranks[1] as number);
    expect(ranks[2]).toBeLessThan(ranks[3] as number);
    // "OSV recorded no severity" is not "not severe" — it sorts last, present.
    expect(Math.max(...ranks)).toBe(severityRank(undefined, undefined));
  });
});

// ---------------------------------------------------------------------------

describe("OSV request and response shaping", () => {
  test("cargo is crates.io to OSV", () => {
    // Getting this wrong returns an empty result set, which reads exactly like
    // "nothing known about these packages".
    expect(osvEcosystem("cargo")).toBe("crates.io");
    expect(osvEcosystem("npm")).toBe("npm");
    expect(buildQueryBatch([coord("serde", "1.0.0", "cargo")]).queries[0]).toEqual({
      package: { name: "serde", ecosystem: "crates.io" },
      version: "1.0.0",
    });
  });

  test("chunk splits evenly and refuses a size of zero", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 10)).toEqual([]);
    expect(() => chunk([1], 0)).toThrow("chunk size");
  });

  test("results are matched to queries by position, and a mismatch is refused", () => {
    const coords = [coord("a", "1"), coord("b", "2")];
    const ok = parseQueryBatchResponse({ results: [{}, { vulns: [{ id: "GHSA-b" }] }] }, coords);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.hits.length).toBe(1);
      expect(ok.hits[0]?.coordinate.name).toBe("b");
    }
    // A short array would silently attribute one package's advisories to
    // another, so it is an error rather than a partial answer.
    const short = parseQueryBatchResponse({ results: [{}] }, coords);
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.reason).toContain("by position");
  });

  test("a response that is not an OSV response is refused with a reason", () => {
    expect(parseQueryBatchResponse(null, [])).toEqual({
      ok: false,
      reason: "OSV returned something that is not a JSON object",
    });
    expect(parseQueryBatchResponse({ nope: 1 }, [])).toEqual({
      ok: false,
      reason: "OSV response has no `results` array",
    });
  });

  test("pagination on one package is carried through, not silently dropped", () => {
    const parsed = parseQueryBatchResponse(
      { results: [{ vulns: [{ id: "GHSA-a" }], next_page_token: "tok" }] },
      [coord("a", "1")],
    );
    expect(parsed.ok && parsed.hits[0]?.morePages).toBe(true);
  });

  test("a vulnerability record prefers a scorable vector but keeps the label too", () => {
    const record = parseVulnRecord({
      id: "GHSA-x",
      aliases: ["CVE-2021-1"],
      summary: "bad",
      severity: [
        {
          type: "CVSS_V4",
          score: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N",
        },
        { type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" },
      ],
      database_specific: { severity: "MODERATE" },
      affected: [],
    });
    // The computed 9.8 and GitHub's "MODERATE" are two claims from two
    // sources; collapsing them would invent an agreement that is not there.
    expect(record?.severity).toMatchObject({
      baseScore: 9.8,
      rating: "CRITICAL",
      label: "MODERATE",
    });
  });

  test("a vector with no computable score is still reported, with the reason", () => {
    const record = parseVulnRecord({
      id: "X",
      severity: [{ type: "CVSS_V2", score: "AV:N/AC:L/Au:N/C:P/I:P/A:P" }],
      affected: [],
    });
    expect(record?.severity.baseScore).toBeUndefined();
    expect(record?.severity.cvssVector).toBe("AV:N/AC:L/Au:N/C:P/I:P/A:P");
    expect(record?.severity.scoreNote).toContain("v2");
  });

  test("a per-ecosystem label on `affected` is found when the record has none", () => {
    const record = parseVulnRecord({
      id: "X",
      affected: [
        { package: { ecosystem: "npm", name: "a" }, database_specific: { severity: "HIGH" } },
      ],
    });
    expect(record?.severity.label).toBe("HIGH");
  });

  test("a record with no id, or that is not an object, is rejected", () => {
    expect(parseVulnRecord({ summary: "no id" })).toBeUndefined();
    expect(parseVulnRecord("string")).toBeUndefined();
    expect(parseVulnRecord(null)).toBeUndefined();
  });

  test("withdrawal is carried through so a stale match can be recognised", () => {
    expect(parseVulnRecord({ id: "X", withdrawn: "2024-01-01T00:00:00Z" })?.withdrawn).toBe(
      "2024-01-01T00:00:00Z",
    );
  });
});

describe("which affected range matched, and what fixes it", () => {
  const record = (affected: unknown[]) => parseVulnRecord({ id: "GHSA-r", affected });

  test("a single closed range gives the range and the fix", () => {
    const rec = record([
      {
        package: { ecosystem: "npm", name: "lodash" },
        ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }],
        versions: ["4.17.15"],
      },
    ]);
    const summary = affectedFor(rec as never, "npm", "lodash", "4.17.15");
    expect(summary).toMatchObject({
      matchedByVersionList: true,
      affectedRange: "all versions, < 4.17.21",
      fixedVersion: "4.17.21",
      fixedVersionsReported: ["4.17.21"],
    });
  });

  test("the interval holding the version is the one whose fix is reported", () => {
    const rec = record([
      {
        package: { ecosystem: "npm", name: "p" },
        ranges: [
          {
            type: "SEMVER",
            events: [
              { introduced: "1.0.0" },
              { fixed: "1.2.0" },
              { introduced: "2.0.0" },
              { fixed: "2.3.0" },
            ],
          },
        ],
      },
    ]);
    expect(affectedFor(rec as never, "npm", "p", "2.1.0").fixedVersion).toBe("2.3.0");
    expect(affectedFor(rec as never, "npm", "p", "1.1.0").fixedVersion).toBe("1.2.0");
    // Between the two ranges: no interval contains it, so no fix is asserted.
    const between = affectedFor(rec as never, "npm", "p", "1.5.0");
    expect(between.fixedVersion).toBeUndefined();
    expect(between.fixedVersionsReported).toEqual(["1.2.0", "2.3.0"]);
  });

  test("events arriving out of order still build intervals that face forwards", () => {
    const rec = record([
      {
        package: { ecosystem: "npm", name: "p" },
        ranges: [{ type: "SEMVER", events: [{ fixed: "2.0.0" }, { introduced: "1.0.0" }] }],
      },
    ]);
    expect(affectedFor(rec as never, "npm", "p", "1.5.0").fixedVersion).toBe("2.0.0");
  });

  test("`last_affected` closes a range inclusively", () => {
    const rec = record([
      {
        package: { ecosystem: "npm", name: "p" },
        ranges: [
          { type: "ECOSYSTEM", events: [{ introduced: "1.0.0" }, { last_affected: "1.9.0" }] },
        ],
      },
    ]);
    expect(affectedFor(rec as never, "npm", "p", "1.9.0").affectedRange).toBe(">= 1.0.0, <= 1.9.0");
    expect(affectedFor(rec as never, "npm", "p", "1.9.1").affectedRange).toBeUndefined();
  });

  test("a GIT range is reported as unevaluated and contributes no `fixedVersion`", () => {
    // A GIT range's `fixed` is a commit hash. Listing it beside "1.2.0" under
    // a field named `fixedVersionsReported` would read as a release.
    const rec = record([
      {
        package: { ecosystem: "crates.io", name: "z" },
        ranges: [
          { type: "GIT", events: [{ introduced: "abc123" }, { fixed: "def456" }] },
          { type: "SEMVER", events: [{ introduced: "1.0.0" }, { fixed: "1.2.0" }] },
        ],
      },
    ]);
    const summary = affectedFor(rec as never, "cargo", "z", "1.1.0");
    expect(summary.unevaluatedRangeTypes).toEqual(["GIT"]);
    expect(summary.fixedVersionsReported).toEqual(["1.2.0"]);
    expect(summary.fixedVersion).toBe("1.2.0");
  });

  test("an entry for another ecosystem or another package is not read", () => {
    const rec = record([
      {
        package: { ecosystem: "npm", name: "lodash" },
        ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "9.9.9" }] }],
      },
    ]);
    expect(affectedFor(rec as never, "cargo", "lodash", "1.0.0").intervals).toEqual([]);
    expect(affectedFor(rec as never, "npm", "other", "1.0.0").intervals).toEqual([]);
  });

  test("a malformed affected entry is skipped rather than throwing", () => {
    const rec = record([null, "text", { package: null }, { package: { ecosystem: "npm" } }]);
    expect(affectedFor(rec as never, "npm", "p", "1.0.0")).toMatchObject({
      intervals: [],
      fixedVersionsReported: [],
    });
  });

  test("an interval is rendered the way an advisory page writes one", () => {
    expect(describeInterval({ rangeType: "SEMVER", introduced: "0", containsVersion: true })).toBe(
      "all versions (no fix recorded)",
    );
    expect(
      describeInterval({
        rangeType: "SEMVER",
        introduced: "2.0.0",
        fixed: "2.1.0",
        containsVersion: true,
      }),
    ).toBe(">= 2.0.0, < 2.1.0");
  });
});

// ---------------------------------------------------------------------------

const wf = (text: string) => readWorkflow(".github/workflows/w.yml", text);
const audit = (text: string, options = {}) => auditWorkflow(wf(text), options);
const rulesOf = (findings: ReadonlyArray<{ rule: string }>) => findings.map((f) => f.rule);

describe("`uses:` is four grammars in one field", () => {
  test("each grammar is classified before anything is looked up", () => {
    expect(parseUses("actions/checkout@v4")).toMatchObject({
      kind: "action-repo",
      owner: "actions",
      repo: "checkout",
      ref: "v4",
      refKind: "mutable",
      pinned: false,
    });
    expect(parseUses("aws-actions/amazon-ecr-login/sub/dir@main")).toMatchObject({
      kind: "action-subpath",
      subpath: "sub/dir",
    });
    expect(parseUses("org/repo/.github/workflows/build.yml@v1")).toMatchObject({
      kind: "reusable-workflow",
    });
    expect(parseUses("./.github/actions/local")).toMatchObject({
      kind: "local",
      refKind: "not-applicable",
      pinned: true,
    });
    expect(parseUses("docker://alpine:3.19")).toMatchObject({
      kind: "docker",
      repo: "alpine",
      ref: "3.19",
      pinned: false,
    });
    expect(parseUses("docker://ghcr.io/o/i@sha256:abc")).toMatchObject({
      kind: "docker",
      refKind: "docker-digest",
      pinned: true,
    });
    expect(parseUses("docker://alpine")).toMatchObject({ refKind: "absent", pinned: false });
    expect(parseUses("notarepo@v1")).toMatchObject({ kind: "unrecognized", pinned: false });
    expect(parseUses("")).toMatchObject({ kind: "unrecognized", pinned: false });
  });

  test("only a 40-character commit SHA counts as pinned", () => {
    const sha = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
    expect(parseUses(`a/b@${sha}`).pinned).toBe(true);
    // A 39-character string is a prefix, and a prefix is not a pin.
    expect(parseUses(`a/b@${sha.slice(0, 39)}`).pinned).toBe(false);
    // An UPPER-CASE one is the same commit: `git rev-parse` resolves it, and
    // so does GitHub (api.github.com/.../commits/<SHA> answers 200 for either
    // spelling). Calling it mutable was a false positive on an immutable pin.
    expect(parseUses(`a/b@${sha.toUpperCase()}`)).toMatchObject({
      refKind: "commit-sha",
      pinned: true,
    });
    expect(parseUses("a/b@v4.2.1").pinned).toBe(false);
  });

  test("a pinned action produces no finding and a mutable one names the risk", () => {
    const sha = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
    const text = [
      "on: push",
      "permissions: {}",
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      `      - uses: actions/checkout@${sha}`,
      "      - uses: tj-actions/changed-files@main",
      "      - uses: actions/setup-node@v4",
      "      - uses: ./.github/actions/local",
    ].join("\n");
    const findings = audit(text).filter((f) => f.rule === "unpinned-action");
    expect(findings.length).toBe(2);
    expect(findings.map((f) => f.evidence)).toEqual([
      "tj-actions/changed-files@main",
      "actions/setup-node@v4",
    ]);
    // A branch moves on every push; a version tag moves when the owner says so.
    expect(findings[0]?.severity).toBe("high");
    expect(findings[1]?.severity).toBe("medium");
    expect(findings[0]?.line).toBe(8);
  });

  test("the inventory covers job-level reusable-workflow calls, not just steps", () => {
    const view = wf(
      ["on: push", "jobs:", "  call:", "    uses: org/repo/.github/workflows/b.yml@v1"].join("\n"),
    );
    expect(inventoryUses(view).map((u) => u.ref.kind)).toEqual(["reusable-workflow"]);
    expect(rulesOf(auditWorkflow(view, { rules: ["unpinned-action"] }))).toEqual([
      "unpinned-action",
    ]);
  });
});

describe("pull_request_target is only a finding with a checkout of the head", () => {
  const sha = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
  const labeler = [
    "on: pull_request_target",
    "permissions:",
    "  pull-requests: write",
    "jobs:",
    "  label:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    `      - uses: actions/labeler@${sha}`,
    `      - uses: actions/checkout@${sha}`,
  ].join("\n");

  test("a safe labeler workflow produces no finding for this rule", () => {
    // Firing on the trigger alone is what teaches a reader to ignore the rule.
    expect(rulesOf(audit(labeler))).not.toContain("pull-request-target-checkout");
  });

  test("checking out the PR head under that trigger is critical", () => {
    const text = `${labeler}\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n`;
    const finding = audit(text).find((f) => f.rule === "pull-request-target-checkout");
    expect(finding?.severity).toBe("critical");
    expect(finding?.line).toBe(11);
    expect(finding?.message).toContain("pull_request_target");
  });

  test("checking out the base, or a literal branch, is not a finding", () => {
    for (const ref of ["${{ github.event.pull_request.base.sha }}", "main"]) {
      const text = `${labeler}\n        with:\n          ref: ${ref}\n`;
      expect(rulesOf(audit(text))).not.toContain("pull-request-target-checkout");
    }
  });

  test("`workflow_run` is the same class and is covered", () => {
    const text = [
      "on: workflow_run",
      "jobs:",
      "  j:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      `      - uses: actions/checkout@${sha}`,
      "        with:",
      "          ref: ${{ github.event.workflow_run.head_sha }}",
    ].join("\n");
    expect(audit(text).find((f) => f.rule === "pull-request-target-checkout")?.severity).toBe(
      "critical",
    );
  });

  test("checking out the fork's repository is the same defect as its ref", () => {
    const text = [
      "on: pull_request_target",
      "jobs:",
      "  j:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      `      - uses: actions/checkout@${sha}`,
      "        with:",
      "          repository: ${{ github.event.pull_request.head.repo.full_name }}",
    ].join("\n");
    expect(audit(text).find((f) => f.rule === "pull-request-target-checkout")?.severity).toBe(
      "critical",
    );
  });

  test("a ref this rule cannot resolve is reported as undetermined, not as clean", () => {
    const text = `${labeler}\n        with:\n          ref: \${{ needs.setup.outputs.ref }}\n`;
    const finding = audit(text).find((f) => f.rule === "pull-request-target-checkout");
    expect(finding?.severity).toBe("medium");
    expect(finding?.conditionalOn).toContain("expression");
  });

  test("the same checkout under `pull_request` is not this rule's business", () => {
    const text = [
      "on: pull_request",
      "jobs:",
      "  j:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      `      - uses: actions/checkout@${sha}`,
      "        with:",
      "          ref: ${{ github.event.pull_request.head.sha }}",
    ].join("\n");
    expect(rulesOf(audit(text))).not.toContain("pull-request-target-checkout");
  });
});

describe("permissions", () => {
  test("the three spellings of a permissions block read the same way", () => {
    const parsed = parseYamlSubset(
      ["a: write-all", "b: {}", "c:", "  contents: write", "  issues: read"].join("\n"),
    );
    expect(readPermissions(mapGet(parsed.doc, "a"), 1).writeAll).toBe(true);
    expect(readPermissions(mapGet(parsed.doc, "b"), 1)).toMatchObject({
      declared: true,
      writeAll: false,
      writeScopes: [],
    });
    expect(readPermissions(mapGet(parsed.doc, "c"), 1).writeScopes).toEqual(["contents"]);
    expect(readPermissions(undefined, 7)).toMatchObject({ declared: false, line: 7 });
  });

  test("write-all is high on its own and critical under a privileged trigger", () => {
    const body = [
      "jobs:",
      "  j:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: x",
    ].join("\n");
    const plain = audit(`on: push\npermissions: write-all\n${body}`).find(
      (f) => f.rule === "broad-permissions",
    );
    expect(plain?.severity).toBe("high");
    const privileged = audit(`on: pull_request_target\npermissions: write-all\n${body}`).find(
      (f) => f.rule === "broad-permissions",
    );
    expect(privileged?.severity).toBe("critical");
  });

  test("a narrow write under a privileged trigger is not graded as a breach", () => {
    // pull_request_target plus `pull-requests: write` is the canonical safe
    // labeler; grading it high is the noise this rule set avoids.
    const text = [
      "on: pull_request_target",
      "permissions:",
      "  pull-requests: write",
      "jobs:",
      "  j:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: x",
    ].join("\n");
    expect(audit(text).find((f) => f.rule === "broad-permissions")?.severity).toBe("low");
  });

  test("a scope that changes what the repository ships is graded above one that does not", () => {
    const build = (scope: string) =>
      audit(
        [
          "on: push",
          "permissions:",
          `  ${scope}: write`,
          "jobs:",
          "  j:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: x",
        ].join("\n"),
      ).find((f) => f.rule === "broad-permissions");
    expect(build("id-token")?.severity).toBe("medium");
    expect(build("contents")?.severity).toBe("medium");
    expect(build("issues")?.severity).toBe("low");
  });

  test("declaring nothing anywhere is reported as conditional on a repository setting", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: x",
    ].join("\n");
    const finding = audit(text).find((f) => f.rule === "broad-permissions");
    expect(finding?.severity).toBe("low");
    expect(finding?.conditionalOn).toContain("default workflow-permissions");
    // A job that declares its own block is not reported for the missing one.
    const scoped = [
      "on: push",
      "jobs:",
      "  j:",
      "    permissions: {}",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: x",
    ].join("\n");
    expect(rulesOf(audit(scoped))).not.toContain("broad-permissions");
  });
});

describe("runners", () => {
  test("every spelling of a self-hosted runner is recognised", () => {
    const parsed = parseYamlSubset(
      [
        "a: self-hosted",
        "b: [self-hosted, linux, x64]",
        "c: ubuntu-latest",
        "d: ${{ matrix.os }}",
        "e:",
        "  group: big",
        "f:",
        "  group: big",
        "  labels: [self-hosted]",
      ].join("\n"),
    );
    const verdicts = ["a", "b", "c", "d", "e", "f"].map((k) =>
      classifyRunsOn(mapGet(parsed.doc, k)),
    );
    expect(verdicts).toEqual([
      "self-hosted",
      "self-hosted",
      "github-hosted",
      // A matrix expression is genuinely unknown from this file, and a runner
      // group may hold either kind — neither is reported as clean.
      "undetermined",
      "undetermined",
      "self-hosted",
    ]);
    expect(classifyRunsOn(undefined)).toBe("undetermined");
  });

  test("visibility decides whether a self-hosted runner is a finding or a question", () => {
    const text = [
      "on: pull_request",
      "jobs:",
      "  j:",
      "    runs-on: self-hosted",
      "    steps:",
      "      - run: x",
    ].join("\n");
    const pub = audit(text, { repositoryVisibility: "public" }).find(
      (f) => f.rule === "self-hosted-runner",
    );
    expect(pub?.severity).toBe("high");
    expect(pub?.conditionalOn).toBeUndefined();
    const unknown = audit(text, { repositoryVisibility: "unknown" }).find(
      (f) => f.rule === "self-hosted-runner",
    );
    expect(unknown?.severity).toBe("medium");
    expect(unknown?.conditionalOn).toContain("public");
    expect(rulesOf(audit(text, { repositoryVisibility: "private" }))).not.toContain(
      "self-hosted-runner",
    );
  });
});

describe("script injection", () => {
  const step = (run: string) =>
    [
      "on: pull_request_target",
      "jobs:",
      "  j:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      run,
    ].join("\n");

  test("an attacker-chosen field interpolated into a run block is critical", () => {
    const finding = audit(step("      - run: echo ${{ github.event.issue.title }}")).find(
      (f) => f.rule === "script-injection",
    );
    expect(finding?.severity).toBe("critical");
    expect(finding?.message).toContain("before the interpreter sees the line");
    expect(finding?.line).toBe(6);
  });

  test("the documented remediation is not flagged", () => {
    // `env:` plus `$VAR` is exactly what GitHub's hardening guide says to do.
    const text = [
      "on: pull_request_target",
      "jobs:",
      "  j:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - env:",
      "          TITLE: ${{ github.event.issue.title }}",
      '        run: echo "$TITLE"',
    ].join("\n");
    expect(rulesOf(audit(text))).not.toContain("script-injection");
  });

  test("a value that cannot be chosen as text is not a finding", () => {
    for (const expr of [
      "github.event.number",
      "github.event.pull_request.head.sha",
      "github.event.action",
      "github.sha",
      "env.FOO",
      "matrix.os",
      "secrets.TOKEN",
      "steps.x.outputs.y",
    ]) {
      expect({ expr, tainted: classifyExpression(expr).tainted }).toEqual({ expr, tainted: false });
    }
  });

  test("an unknown event field is reported as high rather than assumed safe", () => {
    const unknown = classifyExpression("github.event.some_new_field.value");
    expect(unknown).toMatchObject({ tainted: true, severity: "high" });
    expect(unknown.reason).toContain("no evidence");
    expect(classifyExpression("toJSON(github.event)")).toMatchObject({
      tainted: true,
      severity: "high",
    });
  });

  test("a function wrapper or index syntax does not hide the reference", () => {
    expect(classifyExpression("format('{0}', github.event.issue.title)").severity).toBe("critical");
    expect(classifyExpression("github.event.commits[0].message").severity).toBe("critical");
    expect(classifyExpression("github['event']['issue']['title']").severity).toBe("high");
    expect(classifyExpression("github.head_ref").severity).toBe("critical");
  });

  test("a workflow input is reported, at the severity its access requirement earns", () => {
    expect(classifyExpression("github.event.inputs.branch")).toMatchObject({
      tainted: true,
      severity: "medium",
    });
  });

  test("the worst reference in one expression decides its severity", () => {
    expect(
      classifyExpression("format('{0}{1}', github.event.number, github.event.issue.body)").severity,
    ).toBe("critical");
  });

  test("the line reported is the line inside the block, not the `run:` key", () => {
    const text = [
      "on: pull_request_target",
      "jobs:",
      "  j:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: |",
      "          echo safe",
      "          echo safe again",
      "          echo ${{ github.event.comment.body }}",
    ].join("\n");
    expect(audit(text).find((f) => f.rule === "script-injection")?.line).toBe(9);
  });

  test("an expression wrapped across lines is still found", () => {
    const text = [
      "on: pull_request_target",
      "jobs:",
      "  j:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: |",
      "          echo ${{",
      "            github.event.issue.title",
      "          }}",
    ].join("\n");
    const finding = audit(text).find((f) => f.rule === "script-injection");
    expect(finding?.severity).toBe("critical");
    // The finding names the line the expression OPENS on.
    expect(finding?.line).toBe(7);
  });

  test("`actions/github-script` runs its `script:` input the same way", () => {
    const sha = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
    const text = [
      "on: issue_comment",
      "jobs:",
      "  j:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      `      - uses: actions/github-script@${sha}`,
      "        with:",
      "          script: |",
      "            console.log(`${{ github.event.comment.body }}`)",
    ].join("\n");
    const finding = audit(text).find((f) => f.rule === "script-injection");
    expect(finding?.message).toContain("github-script");
    expect(finding?.line).toBe(9);
  });

  test("expressionsIn finds several per line and stops at its limit", () => {
    const lines = [{ line: 1, text: "a ${{ x }} b ${{ y }} c" }];
    expect(expressionsIn(lines)).toEqual([
      { line: 1, text: "x" },
      { line: 1, text: "y" },
    ]);
    expect(expressionsIn(lines, 1).length).toBe(1);
    expect(expressionsIn([{ line: 1, text: "no expressions" }])).toEqual([]);
  });
});

describe("the audit as a whole", () => {
  test("only the requested rules run", () => {
    const text = [
      "on: pull_request_target",
      "permissions: write-all",
      "jobs:",
      "  j:",
      "    runs-on: self-hosted",
      "    steps:",
      "      - uses: a/b@main",
      "      - run: echo ${{ github.event.issue.title }}",
    ].join("\n");
    expect(new Set(rulesOf(audit(text, { repositoryVisibility: "public" })))).toEqual(
      new Set(["unpinned-action", "broad-permissions", "self-hosted-runner", "script-injection"]),
    );
    expect(rulesOf(audit(text, { rules: ["script-injection"] }))).toEqual(["script-injection"]);
    expect(audit(text, { rules: [] })).toEqual([]);
  });

  test("findings come back most severe first, then by file and line", () => {
    const sorted = sortFindings([
      { rule: "unpinned-action", severity: "low", file: "b.yml", line: 1, message: "" },
      { rule: "unpinned-action", severity: "critical", file: "z.yml", line: 9, message: "" },
      { rule: "unpinned-action", severity: "low", file: "a.yml", line: 5, message: "" },
    ]);
    expect(sorted.map((f) => `${f.severity}:${f.file}:${f.line}`)).toEqual([
      "critical:z.yml:9",
      "low:a.yml:5",
      "low:b.yml:1",
    ]);
  });

  test("a workflow with no jobs, and an empty file, are read without throwing", () => {
    expect(audit("on: push\n")).toEqual([]);
    expect(audit("")).toEqual([]);
    expect(wf("").jobs).toEqual([]);
    expect(wf("name: x\n").triggers).toEqual([]);
  });

  test("triggers are read from every spelling, including the YAML 1.1 round-trip", () => {
    expect(wf("on: push\n").triggers.map((t) => t.name)).toEqual(["push"]);
    expect(wf("on: [push, pull_request]\n").triggers.map((t) => t.name)).toEqual([
      "push",
      "pull_request",
    ]);
    expect(wf("on:\n  pull_request_target:\n    types: [opened]\n").triggers[0]?.name).toBe(
      "pull_request_target",
    );
    // A workflow round-tripped through a YAML 1.1 loader comes back as `true:`.
    expect(wf("true:\n  push:\n").triggers.map((t) => t.name)).toEqual(["push"]);
  });
});

// ---------------------------------------------------------------------------
// Shapes that made a rule answer "clean" about a file it had not read, or had
// read wrongly. Every one of these was a silent pass before the fix.

describe("a valid workflow the reader used to skip", () => {
  const HEAD_CHECKOUT = "${{ github.event.pull_request.head.sha }}";

  test("a block sequence at its key's own column is read, not turned into a key", () => {
    // `steps:` then `- uses:` at the SAME indent is standard YAML and the
    // spelling half of GitHub's own starter workflows use. Requiring a deeper
    // indent made the sequence parse as a mapping key spelled `- uses`, so the
    // job kept its line and lost every step — and the audit reported nothing
    // on the workflow it is most important to read.
    const text = [
      "on: pull_request_target",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "    - uses: actions/checkout@v4",
      "      with:",
      `        ref: ${HEAD_CHECKOUT}`,
    ].join("\n");
    const view = wf(text);
    expect(view.jobs.length).toBe(1);
    expect(view.jobs[0]?.steps.length).toBe(1);
    expect(rulesOf(audit(text, { repositoryVisibility: "public" }))).toContain(
      "pull-request-target-checkout",
    );
  });

  test("a sequence at its key's column does not swallow the sibling key below it", () => {
    const parsed = parseYamlSubset(["a:", "- one", "- two", "b: kept"].join("\n"));
    expect(asList(mapGet(parsed.doc, "a")).map(asString)).toEqual(["one", "two"]);
    expect(asString(mapGet(parsed.doc, "b"))).toBe("kept");
    // A MAPPING at the key's own column is a sibling, never the key's value.
    const siblings = parseYamlSubset(["a:", "b: two"].join("\n"));
    expect(mapGet(siblings.doc, "a")?.kind).toBe("null");
    expect(asString(mapGet(siblings.doc, "b"))).toBe("two");
  });

  test("a step written as a flow mapping is a step, not a key named `{uses`", () => {
    // `- {uses: x, with: {ref: y}}` contains `uses: `, so a block-mapping read
    // of it produced the key `{uses` and a step with no `uses` and no `run`
    // for any rule to find — with no parse warning to say so.
    const text = [
      "on: pull_request_target",
      "jobs:",
      "  build:",
      "    steps:",
      `      - {uses: actions/checkout@v4, with: {ref: "${HEAD_CHECKOUT}"}}`,
    ].join("\n");
    const view = wf(text);
    expect(mapKeys(view.jobs[0]?.steps[0]?.node)).toEqual(["uses", "with"]);
    expect(rulesOf(audit(text, { repositoryVisibility: "public" }))).toContain(
      "pull-request-target-checkout",
    );
  });
});

describe("a rule that a capital letter used to switch off", () => {
  const HEAD = "${{ github.event.pull_request.head.sha }}";

  test("`Actions/Checkout` is actions/checkout — github.com paths ignore case", () => {
    const text = [
      "on: pull_request_target",
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: Actions/Checkout@v4",
      "        with:",
      `          ref: ${HEAD}`,
    ].join("\n");
    const finding = audit(text, { repositoryVisibility: "public" }).find(
      (f) => f.rule === "pull-request-target-checkout",
    );
    expect(finding?.severity).toBe("critical");
  });

  test("`Self-Hosted` is a self-hosted runner, and was called github-hosted", () => {
    // The exact-case comparison did not merely miss the label: it fell through
    // to the last line and POSITIVELY answered "github-hosted" about a
    // self-hosted runner, so it was not even counted as undetermined.
    const parsed = parseYamlSubset(
      [
        "a: Self-Hosted",
        "b: [SELF-HOSTED, linux]",
        "c:",
        "  group: g",
        "  labels: [Self-Hosted]",
      ].join("\n"),
    );
    expect(["a", "b", "c"].map((k) => classifyRunsOn(mapGet(parsed.doc, k)))).toEqual([
      "self-hosted",
      "self-hosted",
      "self-hosted",
    ]);
  });

  test("`actions/GitHub-Script` has its `script:` body scanned", () => {
    const text = [
      "on: issues",
      "jobs:",
      "  b:",
      "    steps:",
      "      - uses: actions/GitHub-Script@v7",
      "        with:",
      "          script: |",
      "            console.log('${{ github.event.issue.title }}')",
    ].join("\n");
    const finding = audit(text).find((f) => f.rule === "script-injection");
    expect(finding?.severity).toBe("critical");
    expect(finding?.message).toContain("github-script");
  });
});

describe("script-injection reads what the runner substitutes into", () => {
  test("an expression in a YAML comment is not in the script and is not a finding", () => {
    // `run: make # ${{ … }}` has the value `make`; YAML ended the plain scalar
    // at the ` #`, so the expression never reaches the shell. Scanning the raw
    // line reported a CRITICAL injection on a comment.
    const text = [
      "on: issues",
      "jobs:",
      "  b:",
      "    steps:",
      "      - run: make # ${{ github.event.issue.title }}",
    ].join("\n");
    expect(asString(mapGet(wf(text).jobs[0]?.steps[0]?.node, "run"))).toBe("make");
    expect(rulesOf(audit(text))).not.toContain("script-injection");
  });

  test("a `#` inside a `|` block IS script, and is still scanned on its own line", () => {
    // The other half of the same rule: inside a block scalar a `#` is a shell
    // comment, the runner substitutes into it, and the line must be named.
    const text = [
      "on: issues",
      "jobs:",
      "  b:",
      "    steps:",
      "      - run: |",
      "          echo start",
      "          # ${{ github.event.issue.title }}",
    ].join("\n");
    const finding = audit(text).find((f) => f.rule === "script-injection");
    expect(finding?.line).toBe(7);
  });
});

// ---------------------------------------------------------------------------

describe("the reader survives files nobody wrote on purpose", () => {
  test("4000 seeded-random fragments and eight pathological shapes: no throw, no hang", () => {
    // The parser is the part of this package that a repository hands
    // attacker-influenced bytes to, and the failure that matters is not a
    // wrong answer — it is a hang or a throw that takes the whole audit down.
    // Seeded, so a failure here is reproducible rather than a flake.
    let seed = 1337;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const fragments = [
      "on:",
      "- push",
      "  - push",
      "jobs:",
      "  b:",
      "    steps:",
      "    - uses: a/b@v1",
      "- {uses: a/b@v1, with: {ref: x}}",
      "      - run: |",
      "        echo ${{ github.event.issue.title }}",
      "  run: >-",
      "\t- tabbed",
      "key: 'unterminated",
      'k: "esc\\',
      "<<: *base",
      "&anchor v",
      "*alias",
      "---",
      "a: [1, {b: c}",
      "permissions: write-all",
      "  group: g",
      "- - nested",
      "? explicit",
      "key:",
      "  : weird",
      "run: docker run -p 8080:80 i",
      "x: |+2",
      "y: >3-",
      "#comment",
      "",
      "   ",
      'q: "a',
      "name: ${{",
      "}}",
      "z: {a",
      "- [1,2",
      "on: {push: {branches: [main]}}",
    ];
    for (let n = 0; n < 4_000; n += 1) {
      const lines: string[] = [];
      const length = 1 + Math.floor(rnd() * 25);
      for (let k = 0; k < length; k += 1) {
        lines.push(fragments[Math.floor(rnd() * fragments.length)] as string);
      }
      const text = lines.join("\n");
      expect(() => auditWorkflow(wf(text), { repositoryVisibility: "public" })).not.toThrow();
    }
    // Shapes chosen for the loops they could turn quadratic, not for realism.
    for (const shape of [
      "a:\n".repeat(5_000),
      "- ".repeat(2_000),
      `k: ${"${{".repeat(5_000)}`,
      `run: |\n${"  ${{ github.event.issue.title }}\n".repeat(2_000)}`,
      `a:\n${"- x\n".repeat(20_000)}`,
      `${" ".repeat(10_000)}a: b`,
      "{".repeat(5_000),
      `a: ${"[".repeat(200)}${"]".repeat(200)}`,
    ]) {
      expect(() => auditWorkflow(wf(shape), {})).not.toThrow();
    }
  }, 20_000); // pays for 4000 parses plus eight large shapes on a loaded runner
});
