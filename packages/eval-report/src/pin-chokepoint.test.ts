/**
 * Every pin path refuses the same runs because there is one of them. A new caller
 * of `setBaseline` skips the refusal without a word, so this reads the tree and
 * holds the list.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { isTestOnly } from "../../../scripts/test-only";

const ROOT = join(import.meta.dir, "..", "..", "..");

test("no non-test code outside eval-report writes a pin, and four known paths pin a run", () => {
  const setters: string[] = [];
  const pinners: string[] = [];
  let scanned = 0;
  for (const rel of new Glob("{packages,apps}/*/src/**/*.ts").scanSync({ cwd: ROOT })) {
    if (rel.endsWith(".test.ts") || rel.endsWith(".d.ts") || isTestOnly(rel)) continue;
    scanned += 1;
    if (rel.startsWith("packages/eval-report/")) continue;
    const text = readFileSync(join(ROOT, rel), "utf8");
    if (text.includes("setBaseline(")) setters.push(rel);
    if (text.includes("pinRun(")) pinners.push(rel);
  }
  expect(scanned).toBeGreaterThan(100);
  expect(setters).toEqual([]);
  expect(pinners.sort()).toEqual([
    "apps/cli/src/index.ts",
    "packages/eval-ops/src/eval-history.ts",
    "packages/hangar-server/src/actions.ts",
    "packages/tool-evalops/src/lib/pin.ts",
  ]);
}, 20_000); // reads every package's source
