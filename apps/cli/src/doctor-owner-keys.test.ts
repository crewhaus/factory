/**
 * The owner-keys findings of `doctor --philosophy-alignment` (#514): each passes
 * on this checkout, and each fails when seeded with the regression it catches.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DELTA_090_KEYS, type OwnerKey } from "@crewhaus/spec-patch";
import {
  RENDER_SUBPATH_IMPORTS,
  ownerKeyOptimizerFindings,
  ownerKeyPhilosophyFindings,
  renderSubpathImportFindings,
} from "./doctor-owner-keys";

const REPO_ROOT = join(import.meta.dir.replace(/([/\\])dist$/, "$1src"), "..", "..", "..");

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(files: Record<string, string>, withPackages = true): string {
  const root = mkdtempSync(join(tmpdir(), "doctor-owner-keys-"));
  temps.push(root);
  if (withPackages) mkdirSync(join(root, "packages"), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const JUDGE_FLAG: OwnerKey = {
  pattern: ["judge", "protected"],
  refused: true,
  security: true,
  reason: "a protected bar is its owner's",
  since: "0.9.0",
};

describe("ownerKeyOptimizerFindings", () => {
  test("the real table passes, one finding per row", () => {
    const findings = ownerKeyOptimizerFindings();
    expect(findings.length).toBe(DELTA_090_KEYS.length);
    for (const finding of findings) {
      expect(finding.pass).toBe(true);
      expect(finding.class).toBe("optimizer-exclusion");
      expect(finding.file).toBe("packages/spec-patch/src/owner-keys.ts");
    }
    expect(findings.map((f) => f.symbol)).toContain("intent");
  });

  const seeded: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    ["names the block", ["intent"]],
    ["sits above it through a wildcard", ["*"]],
    ["reaches inside it", ["intent", "purpose"]],
    ["reaches inside it through a wildcard", ["*", "purpose"]],
  ];
  for (const [what, entry] of seeded) {
    test(`a whitelist entry that ${what} fails, naming the target and the entry`, () => {
      const [finding] = ownerKeyOptimizerFindings({ cli: [entry] });
      expect(finding?.pass).toBe(false);
      expect(finding?.reason).toContain("cli");
      expect(finding?.reason).toContain(`[${entry.join(", ")}]`);
      expect(finding?.reason).toContain("intent");
    });
  }

  test("an unrelated entry passes, on the same name deeper down too", () => {
    const [finding] = ownerKeyOptimizerFindings({
      graph: [["nodes"], ["nodes", "intent", "instructions"], ["agent", "instructions"]],
    });
    expect(finding?.pass).toBe(true);
  });

  test("a row that is not root-anchored fails on an entry naming it as a run of segments", () => {
    const fails = ownerKeyOptimizerFindings({ workflow: [["steps", "*", "judge", "protected"]] }, [
      JUDGE_FLAG,
    ]);
    expect(fails[0]?.pass).toBe(false);
    expect(fails[0]?.symbol).toBe("judge.protected");
    expect(fails[0]?.reason).toContain("workflow");
    expect(fails[0]?.reason).toContain("steps, *, judge, protected");

    const passes = ownerKeyOptimizerFindings({ workflow: [["steps"]] }, [JUDGE_FLAG]);
    expect(passes[0]?.pass).toBe(true);
  });

  test("a wildcard in the row or in the entry still matches", () => {
    const row: OwnerKey = { ...JUDGE_FLAG, pattern: ["models", "*", "price"] };
    const named = ownerKeyOptimizerFindings({ cli: [["models", "fast", "price"]] }, [row]);
    expect(named[0]?.pass).toBe(false);
    const wild = ownerKeyOptimizerFindings({ cli: [["models", "*", "*"]] }, [row]);
    expect(wild[0]?.pass).toBe(false);
  });

  test("a finding does not reuse provability's identity", () => {
    expect(ownerKeyOptimizerFindings().map((f) => f.symbol)).not.toContain("provability.level");
  });
});

describe("renderSubpathImportFindings", () => {
  const FILE = "packages/thing/src/render.ts";
  const ENTRY = { file: FILE, allow: ["@crewhaus/ir", "./types"], label: "render imports" };

  test("the shipped list is empty, so a checkout has nothing to report", () => {
    expect(RENDER_SUBPATH_IMPORTS).toEqual([]);
    expect(renderSubpathImportFindings(REPO_ROOT)).toEqual([]);
    expect(renderSubpathImportFindings(tree({}, false))).toEqual([]);
  });

  test("an import on the allow-list passes", () => {
    const root = tree({ [FILE]: 'import { a } from "@crewhaus/ir";\nimport b from "./types";\n' });
    const [finding] = renderSubpathImportFindings(root, [ENTRY]);
    expect(finding?.pass).toBe(true);
    expect(finding?.class).toBe("import-boundary");
    expect(finding?.file).toBe(FILE);
  });

  test("an import outside it fails, naming the specifier, and a type-only import counts", () => {
    const root = tree({
      [FILE]:
        'import { a } from "@crewhaus/ir";\nimport { b } from "node:fs";\nimport type { C } from "@crewhaus/vault";\n',
    });
    const [finding] = renderSubpathImportFindings(root, [ENTRY]);
    expect(finding?.pass).toBe(false);
    expect(finding?.reason).toContain("node:fs");
    expect(finding?.reason).toContain("@crewhaus/vault");
    expect(finding?.reason).not.toContain("imports @crewhaus/ir");
  });

  test("a module it cannot read fails rather than passing unchecked", () => {
    const [finding] = renderSubpathImportFindings(tree({}), [ENTRY]);
    expect(finding?.pass).toBe(false);
    expect(finding?.reason).toContain(FILE);
  });

  test("away from a checkout it warns and passes, for each entry", () => {
    const [finding] = renderSubpathImportFindings(tree({}, false), [ENTRY]);
    expect(finding?.pass).toBe(true);
    expect(finding?.warn).toBe(true);
    expect(finding?.reason).toContain("not a factory checkout");
  });

  test("one finding per entry", () => {
    const root = tree({ [FILE]: "", "packages/other/src/render.ts": 'import "node:fs";\n' });
    const findings = renderSubpathImportFindings(root, [
      ENTRY,
      { file: "packages/other/src/render.ts", allow: [], label: "other" },
    ]);
    expect(findings.map((f) => f.pass)).toEqual([true, false]);
  });
});

describe("ownerKeyPhilosophyFindings", () => {
  test("this checkout passes", () => {
    const findings = ownerKeyPhilosophyFindings(REPO_ROOT);
    expect(findings.length).toBeGreaterThanOrEqual(DELTA_090_KEYS.length);
    expect(findings.filter((f) => !f.pass)).toEqual([]);
  });
});
