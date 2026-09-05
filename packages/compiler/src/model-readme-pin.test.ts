/**
 * 0.6.0 PR 7 — README byte pins for the ONE sanctioned bundle delta this PR
 * makes on 0.5.x-shaped specs: the generated `README.md` now lists every
 * model a run can route to (pool candidates, tiers, fallbacks, the judge /
 * compaction / degrade / security / watchme slots) and renders a "Model
 * profiles" section when a `models:` registry is declared (plan §4.3).
 * `agent.ts` and every other file stay byte-identical (the `pre-continuity`
 * pins cover those). See `__fixtures__/model-readme/README.md` for the
 * fixture provenance and the regeneration rule.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "./index";

const FIX_DIR = join(import.meta.dir, "__fixtures__", "model-readme");
const opts = { today: "2026-09-04" } as const;

function fixture(name: string): string {
  return readFileSync(join(FIX_DIR, name), "utf-8");
}

describe("the generated README lists every routable model — byte-pinned (0.6.0 PR 7, §4.3)", () => {
  for (const [key, expectedModels] of [
    ["pooled", ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-8"]],
    ["judged", ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-8"]],
    ["profiled", ["claude-haiku-4-5", "claude-opus-4-8"]],
  ] as const) {
    test(`${key}: README.md matches its pin and names ${expectedModels.length} models`, () => {
      const bundle = compile(fixture(`${key}.spec.yaml`), opts);
      const readme = bundle.files.find((f) => f.path === "README.md")?.content;
      expect(readme).toBe(fixture(`${key}.README.md.txt`));
      const modelsRow = readme?.split("\n").find((l) => l.startsWith("| Models |")) ?? "";
      expect(modelsRow).toBe(`| Models | ${expectedModels.map((m) => `\`${m}\``).join(", ")} |`);
    });
  }

  test("the opted-in fixture shows the judge-default flip and the profiles section; the 0.5.x fixtures show neither", () => {
    const profiled = fixture("profiled.README.md.txt");
    expect(profiled).toContain("## Model profiles");
    expect(profiled).toContain("| `strong` | `claude-opus-4-8` | `strong` |");
    for (const key of ["pooled", "judged"] as const) {
      expect(fixture(`${key}.README.md.txt`)).not.toContain("## Model profiles");
    }
    // The flip itself lands on the IR, not only the README.
    const bundle = compile(fixture("profiled.spec.yaml"), opts);
    const agent = bundle.files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agent).toContain('"claude-opus-4-8"');
    expect(bundle.warnings).toEqual([]);
  });
});
