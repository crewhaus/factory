/**
 * 0.8.0 §10 — the three provability findings of `doctor
 * --philosophy-alignment`: each passes on this checkout, and each fails on a
 * temp tree seeded with exactly the regression it exists to catch. The
 * seeded copies of the citation-marker pattern live in strings below, which
 * is fine: this is a test file, and the scan skips test files (as it must —
 * tool-verify's linear-citations test carries the pattern to test against).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CITATION_MARKER_OWNER,
  citationMarkerFindings,
  findCitationMarkerDefinitions,
  foldRegexSource,
  importSpecifiers,
  isModelPackage,
  isTestFile,
  markerLine,
  provabilityLevelOptimizerFindings,
  provabilityModelImportFindings,
  provabilityPhilosophyFindings,
} from "./doctor-provability";
import { buildScopeAuditSnapshot, findingId } from "./scope-audit-drift";

const REPO_ROOT = join(import.meta.dir.replace(/([/\\])dist$/, "$1src"), "..", "..", "..");

/** The pattern exactly as claim-ledger spells it, and as a RegExp-constructor string. */
const LITERAL = String.raw`const CITATION_MARKER = /\[\^?([\w.-]+)\](?!\(|:|\[)/g;`;
const RENAMED = String.raw`const MARKERS = /\[\^?([\w.-]+)\](?!\(|:|\[)/g;`;
const CONSTRUCTED = String.raw`const re = new RegExp("\\[\\^?([\\w.-]+)\\](?!\\(|:|\\[)", "g");`;

const temps: string[] = [];
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true });
});

/** A miniature factory tree: `files` maps repo-relative paths to contents. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "doctor-provability-"));
  temps.push(root);
  mkdirSync(join(root, "packages"), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const OWNER = { [CITATION_MARKER_OWNER]: `// the grammar\n${LITERAL}\n` };
const CLEAN_PROVABILITY = {
  "packages/provability/package.json": JSON.stringify({
    name: "@crewhaus/provability",
    dependencies: { "@crewhaus/claim-ledger": "workspace:*" },
    devDependencies: { "@crewhaus/adapter-anthropic": "workspace:*" },
  }),
  "packages/provability/src/index.ts":
    'import { x } from "@crewhaus/claim-ledger";\nexport { x };\n',
};

describe("finding 1 — the citation-marker regex has exactly one definition", () => {
  test("this checkout: one definition, in claim-ledger (the linear-citations test copy is skipped)", () => {
    const defs = findCitationMarkerDefinitions(REPO_ROOT);
    expect(defs.map((d) => d.file)).toEqual([CITATION_MARKER_OWNER]);
    const findings = citationMarkerFindings(REPO_ROOT);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      class: "single-definition",
      file: CITATION_MARKER_OWNER,
      symbol: "CITATION_MARKER",
      pass: true,
    });
  });

  test("a second copy — by name, renamed, or as a RegExp string — fails, one finding per copy", () => {
    const root = tree({
      ...OWNER,
      "packages/tool-verify/src/lib/markdown.ts": `${LITERAL}\n`,
      "packages/grader-x/src/faithfulness.ts": `${RENAMED}\n`,
      "apps/cli/src/lint.ts": `${CONSTRUCTED}\n`,
    });
    const findings = citationMarkerFindings(root);
    expect(findings.every((f) => !f.pass)).toBe(true);
    expect(findings.map((f) => f.file).sort()).toEqual([
      "apps/cli/src/lint.ts",
      "packages/grader-x/src/faithfulness.ts",
      "packages/tool-verify/src/lib/markdown.ts",
    ]);
    expect(findings[0]?.reason).toContain("import the grammar from @crewhaus/claim-ledger");
  });

  test("copies in test files, build output and dependencies are not definitions", () => {
    const root = tree({
      ...OWNER,
      "packages/tool-verify/src/linear-citations.test.ts": `${LITERAL}\n`,
      "packages/tool-verify/src/__fixtures__/copy.ts": `${LITERAL}\n`,
      "packages/claim-ledger/dist/citations.js": `${LITERAL}\n`,
      "packages/tool-verify/node_modules/x/src/index.ts": `${LITERAL}\n`,
      "packages/tool-verify/src/types.d.ts": `${LITERAL}\n`,
    });
    expect(citationMarkerFindings(root)).toMatchObject([{ pass: true }]);
  });

  test("the definition moved out of claim-ledger fails at the owner AND at the copy", () => {
    const root = tree({ "packages/tool-verify/src/lib/markdown.ts": `${LITERAL}\n` });
    const findings = citationMarkerFindings(root);
    expect(findings.map((f) => [f.file, f.pass])).toEqual([
      [CITATION_MARKER_OWNER, false],
      ["packages/tool-verify/src/lib/markdown.ts", false],
    ]);
    expect(findings[0]?.reason).toContain(
      "it is defined in packages/tool-verify/src/lib/markdown.ts:1",
    );
  });

  test("no definition anywhere fails at the owner", () => {
    const findings = citationMarkerFindings(tree({}));
    expect(findings).toMatchObject([{ file: CITATION_MARKER_OWNER, pass: false }]);
  });

  test("a NEW copy is a NEW stable id — what the --baseline gate fails on", () => {
    const one = tree({ ...OWNER, "packages/a/src/x.ts": `${LITERAL}\n` });
    const two = tree({
      ...OWNER,
      "packages/a/src/x.ts": `${LITERAL}\n`,
      "packages/b/src/y.ts": `${RENAMED}\n`,
    });
    const before = buildScopeAuditSnapshot(citationMarkerFindings(one)).findings.map((f) => f.id);
    const after = buildScopeAuditSnapshot(citationMarkerFindings(two)).findings.map((f) => f.id);
    expect(before).toHaveLength(1);
    expect(after).toContain(before[0] as string);
    expect(after.filter((id) => !before.includes(id))).toEqual([
      findingId({
        class: "single-definition",
        file: "packages/b/src/y.ts",
        symbol: "CITATION_MARKER",
      }),
    ]);
  });

  test("outside a factory checkout the check says so and passes", () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-provability-empty-"));
    temps.push(root);
    expect(citationMarkerFindings(root)).toMatchObject([{ pass: true, warn: true }]);
  });

  test("markerLine / isTestFile units", () => {
    expect(markerLine(LITERAL)).toBe(true);
    expect(markerLine(RENAMED)).toBe(true);
    expect(markerLine(CONSTRUCTED)).toBe(true);
    expect(markerLine("for (const m of text.matchAll(CITATION_MARKER)) {")).toBe(false);
    expect(markerLine("export const CITATION_MARKER_OWNER = 'x';")).toBe(false);
    // The DEFINITION pattern (a colon after the bracket) is a different grammar.
    expect(markerLine(String.raw`/^\s{0,3}\[\^?([\w.-]+)\]:[ \t]*/gm`)).toBe(false);
    expect(isTestFile("linear-citations.test.ts")).toBe(true);
    // A helper module is imported by the suite: a copy there is a copy.
    expect(isTestFile("test-helpers.ts")).toBe(false);
    expect(isTestFile("citations.ts")).toBe(false);
  });

  test("a copy is caught by its structure, not one spelling", () => {
    for (const variant of [
      // the group moved before the optional caret
      String.raw`const a = /\[(\^?[\w.-]+)\](?!\(|:|\[)/g;`,
      // the class reordered and escaped
      String.raw`const b = /\[\^?([\w\-.]+)\](?!\(|:|\[)/g;`,
      // the class spelled out
      String.raw`const c = /\[\^?([A-Za-z0-9_.-]+)\](?!\(|:|\[)/g;`,
      // a non-capturing / named group, and a constructor string
      String.raw`const d = /\[\^?(?<label>[\w.-]+)\](?!\()/g;`,
      String.raw`const e = new RegExp("\\[(?:\\^?)([A-Za-z0-9_.-]+)\\](?!\\()", "g");`,
      // a label of class escapes, not a class: the numeric `[n]` the
      // provability skill teaches, widened to any non-space, in a
      // constructor string too
      String.raw`const f = /\[\^?(\d+)\](?!\(|:|\[)/g;`,
      String.raw`const g = /\[(\S+?)\](?![(:\[])/g;`,
      String.raw`const h = new RegExp("\\[\\^?(\\d+)\\](?!\\(|:|\\[)", "g");`,
      // the wildcard, a bounded quantifier, a Unicode property, an alternation
      String.raw`const i = /\[(.+?)\](?!\()/g;`,
      String.raw`const j = /\[\^?([\w.-]{1,64})\](?!\(|:|\[)/g;`,
      String.raw`const k = /\[\^?(\p{L}+)\](?!\()/gu;`,
      String.raw`const l = /\[\^?(\d+|[a-z]+)\](?!\()/g;`,
    ]) {
      expect(markerLine(variant)).toBe(true);
    }
    // Other bracket grammars are not the marker: a markdown link, the
    // definition line, a footnote definition, an array index.
    for (const other of [
      String.raw`const link = /\[([^\]]+)\]\(([^)]+)\)/g;`,
      String.raw`const def = /^\[\^?([\w.-]+)\]:\s*(.+)$/gm;`,
      String.raw`const x = rows[i](?!0);`,
      "const y = items[index];",
    ]) {
      expect(markerLine(other)).toBe(false);
    }
    expect(foldRegexSource(String.raw`/\[\^?([\w.-]+)\](?!x)/`)).toBe(String.raw`/\[\^?C+\](?!x/`);
  });

  test("a numeric-only copy — narrower than the owner's grammar, the drift itself — fails the doctor", () => {
    // `[0-9]+` was always caught (a class folds to one token); its twin
    // `\d+` slipped through while the label took only classes and `\w`.
    for (const copy of [
      String.raw`const NUMERIC = /\[\^?(\d+)\](?!\(|:|\[)/g;`,
      String.raw`const LOOSE = /\[(\S+?)\](?![(:\[])/g;`,
    ]) {
      const root = tree({ ...OWNER, "packages/grader-x/src/index.ts": `${copy}\n` });
      expect(citationMarkerFindings(root).map((f) => [f.file, f.pass])).toEqual([
        ["packages/grader-x/src/index.ts", false],
      ]);
    }
  });

  test("every defining line counts: a second copy in the owner file, and a helper module's copy", () => {
    const root = tree({
      [CITATION_MARKER_OWNER]: `${LITERAL}\nconst again = /\\[\\^?([\\w\\-.]+)\\](?!\\()/g;\n`,
      "packages/grader-x/src/test-helpers.ts": `// line 1\n${RENAMED}\n${RENAMED}\n`,
    });
    const defs = findCitationMarkerDefinitions(root);
    expect(defs.map((d) => [d.file, d.lines])).toEqual([
      ["packages/claim-ledger/src/citations.ts", [1, 2]],
      ["packages/grader-x/src/test-helpers.ts", [2, 3]],
    ]);
    const findings = citationMarkerFindings(root);
    expect(findings.map((f) => [f.file, f.symbol, f.pass])).toEqual([
      [CITATION_MARKER_OWNER, "CITATION_MARKER (second definition)", false],
      ["packages/grader-x/src/test-helpers.ts", "CITATION_MARKER", false],
    ]);
    expect(findings[0]?.reason).toContain(`${CITATION_MARKER_OWNER}:2 defines`);
    expect(findings[1]?.reason).toContain("packages/grader-x/src/test-helpers.ts:2, 3 defines");
  });
});

describe("finding 2 — @crewhaus/provability imports no model adapter", () => {
  test("this checkout passes", () => {
    expect(provabilityModelImportFindings(REPO_ROOT)).toMatchObject([
      {
        class: "import-boundary",
        file: "packages/provability",
        symbol: "no-model-adapter",
        pass: true,
      },
    ]);
  });

  test("a clean package passes (a devDependency and a test file are the suite's business)", () => {
    const root = tree({
      ...CLEAN_PROVABILITY,
      "packages/provability/src/judge.test.ts": 'import { a } from "@crewhaus/eval-judge";\n',
    });
    expect(provabilityModelImportFindings(root)).toMatchObject([{ pass: true }]);
  });

  test("a shipped dependency on an adapter fails, naming package.json", () => {
    const root = tree({
      ...CLEAN_PROVABILITY,
      "packages/provability/package.json": JSON.stringify({
        dependencies: { "@crewhaus/adapter-openai": "workspace:*", "@crewhaus/ir": "workspace:*" },
        peerDependencies: { "@anthropic-ai/sdk": "^1" },
      }),
    });
    const findings = provabilityModelImportFindings(root);
    expect(findings.map((f) => [f.file, f.symbol, f.pass])).toEqual([
      ["packages/provability/package.json", "@crewhaus/adapter-openai", false],
      ["packages/provability/package.json", "@anthropic-ai/sdk", false],
    ]);
  });

  test("a source import of the judge or the router fails, naming the file — static, dynamic or require", () => {
    const root = tree({
      ...CLEAN_PROVABILITY,
      "packages/provability/src/waiver.ts":
        'import { gradeWithJudge } from "@crewhaus/eval-judge";\n',
      "packages/provability/src/lazy.ts":
        'const r = await import("@crewhaus/model-router/resolve");\nconst o = require("openai");\n',
    });
    const findings = provabilityModelImportFindings(root);
    expect(findings.map((f) => [f.file, f.symbol])).toEqual([
      ["packages/provability/src/lazy.ts", "@crewhaus/model-router/resolve"],
      ["packages/provability/src/lazy.ts", "openai"],
      ["packages/provability/src/waiver.ts", "@crewhaus/eval-judge"],
    ]);
    expect(findings[0]?.reason).toContain("move the model call to @crewhaus/evaluation-service");
  });

  test("a missing package fails; a non-checkout passes with a warning", () => {
    expect(provabilityModelImportFindings(tree({}))).toMatchObject([{ pass: false }]);
    const bare = mkdtempSync(join(tmpdir(), "doctor-provability-bare-"));
    temps.push(bare);
    expect(provabilityModelImportFindings(bare)).toMatchObject([{ pass: true, warn: true }]);
  });

  test("a dependency that reaches a model through the workspace closure fails, naming the chain", () => {
    const pkg = (name: string, deps: Record<string, string> = {}): string =>
      JSON.stringify({ name, dependencies: deps });
    const root = tree({
      ...CLEAN_PROVABILITY,
      "packages/provability/package.json": pkg("@crewhaus/provability", {
        "@crewhaus/claim-ledger": "workspace:*",
        "@crewhaus/report-kit": "workspace:*",
      }),
      "packages/claim-ledger/package.json": pkg("@crewhaus/claim-ledger"),
      "packages/report-kit/package.json": pkg("@crewhaus/report-kit", {
        "@crewhaus/scorer": "workspace:*",
      }),
      "packages/scorer/package.json": pkg("@crewhaus/scorer", {
        "@crewhaus/justification-judge-claude": "workspace:*",
      }),
      "packages/justification-judge-claude/package.json": pkg(
        "@crewhaus/justification-judge-claude",
        { "@anthropic-ai/sdk": "^1" },
      ),
      // A source import of a workspace package that reaches model-service.
      "packages/compiler/package.json": pkg("@crewhaus/compiler", {
        "@crewhaus/model-service": "workspace:*",
      }),
      "packages/provability/src/lower.ts": 'import { lower } from "@crewhaus/compiler/lower";\n',
    });
    const findings = provabilityModelImportFindings(root);
    expect(findings.map((f) => [f.file, f.symbol, f.pass])).toEqual([
      ["packages/provability/package.json", "@crewhaus/report-kit", false],
      ["packages/provability/src/lower.ts", "@crewhaus/compiler/lower", false],
    ]);
    expect(findings[0]?.reason).toContain(
      "@crewhaus/provability → @crewhaus/report-kit → @crewhaus/scorer → @crewhaus/justification-judge-claude",
    );
    expect(findings[1]?.reason).toContain("reaches @crewhaus/model-service");
  });

  test("isModelPackage / importSpecifiers units", () => {
    for (const yes of [
      "@crewhaus/adapter-anthropic",
      "@crewhaus/adapter-bedrock/stream",
      "@crewhaus/eval-judge",
      "@crewhaus/model-router",
      "@crewhaus/model-service",
      "@crewhaus/justification-judge-claude",
      "@anthropic-ai/sdk",
      "openai",
      "@google/genai",
      "@aws-sdk/client-bedrock-runtime",
    ]) {
      expect(isModelPackage(yes)).toBe(true);
    }
    for (const no of [
      "@crewhaus/channel-adapter-slack",
      "@crewhaus/chain-adapter-evm",
      "@crewhaus/model-plan",
      "@crewhaus/eval-judgement",
      "openai-compatible-mock",
    ]) {
      expect(isModelPackage(no)).toBe(false);
    }
    expect(
      importSpecifiers(
        'import a from "x";\nimport "y";\nexport { b } from \'z\';\nawait import("w");\nrequire("v");',
      ).sort(),
    ).toEqual(["v", "w", "x", "y", "z"]);
  });
});

describe("finding 3 — provability.level is not optimizable", () => {
  test("this checkout passes", () => {
    expect(provabilityLevelOptimizerFindings()).toMatchObject([
      {
        class: "optimizer-exclusion",
        file: "packages/spec-patch/src/index.ts",
        symbol: "provability.level",
        pass: true,
      },
    ]);
  });

  const never = (): boolean => false;
  const prefix =
    (table: Record<string, string[][]>) =>
    (target: string, path: ReadonlyArray<string>): boolean =>
      (table[target] ?? []).some((entry) =>
        entry.every((seg, i) => seg === "*" || seg === path[i]),
      );

  test("a literal entry fails, naming the targets", () => {
    const table = {
      cli: [
        ["agent", "instructions"],
        ["provability", "level"],
      ],
      channel: [],
    };
    const [finding] = provabilityLevelOptimizerFindings(table, prefix(table));
    expect(finding?.pass).toBe(false);
    expect(finding?.reason).toContain("listed in OPTIMIZABLE_PATHS for cli");
  });

  test("a wildcard spelling of it fails even if the matcher were to refuse it", () => {
    const table = { managed: [["provability", "*"]] };
    const [finding] = provabilityLevelOptimizerFindings(table, never);
    expect(finding?.pass).toBe(false);
    expect(finding?.reason).toContain("listed in OPTIMIZABLE_PATHS for managed");
  });

  test("a wholesale block entry admits it by prefix — that fails too", () => {
    const table = { research: [["provability"]] };
    const [finding] = provabilityLevelOptimizerFindings(table, prefix(table));
    expect(finding?.pass).toBe(false);
    expect(finding?.reason).toContain("admitted by a broader entry for research");
    expect(finding?.reason).toContain("OPTIMIZER_REFUSED_LEAVES");
  });

  test("a wholesale block entry fails under the REAL admission rule, which refuses the leaf itself", () => {
    // spec-patch's isOptimizable answers "no" for provability.level whatever
    // the table holds (OPTIMIZER_REFUSED_LEAVES wins first), yet a wholesale
    // entry admits a patch AT the block — `provability: cited`, or a remove —
    // that moves the floor without naming the leaf. The table itself is read.
    for (const entry of [["provability"], ["*"]]) {
      const [finding] = provabilityLevelOptimizerFindings({
        cli: [["agent", "instructions"], entry],
      });
      expect(finding?.pass).toBe(false);
      expect(finding?.reason).toContain("admitted by a broader entry for cli");
    }
    // A deeper entry under the leaf's own block is a sibling, not a cover.
    expect(
      provabilityLevelOptimizerFindings({ cli: [["provability", "grounded", "coverage"]] }),
    ).toMatchObject([{ pass: true }]);
  });

  test("a sibling knob is fine", () => {
    const table = {
      cli: [
        ["provability", "threshold"],
        ["provability", "grounded", "coverage"],
      ],
    };
    expect(provabilityLevelOptimizerFindings(table, prefix(table))).toMatchObject([{ pass: true }]);
  });
});

describe("the three together", () => {
  test("this checkout is green on all three, with three distinct stable ids", () => {
    const findings = provabilityPhilosophyFindings(REPO_ROOT);
    expect(findings.map((f) => f.class)).toEqual([
      "single-definition",
      "import-boundary",
      "optimizer-exclusion",
    ]);
    expect(findings.every((f) => f.pass && f.warn !== true)).toBe(true);
    expect(new Set(findings.map(findingId)).size).toBe(3);
    // Green findings are not actionable, so they never enter a baseline.
    expect(buildScopeAuditSnapshot(findings).findings).toEqual([]);
  });
});
