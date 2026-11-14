/**
 * Ending standing rules on Home's tick: a rule past its end is ended with its settings
 * entry, and a harness with nothing due is never touched.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readStandingRules } from "@crewhaus/control-records";
import { createStandingRule, endExpiredRules } from "./rules";
import { NOW, removeTempDirs, settingsOf, tempDir, treeBytes } from "./test-helpers";

afterAll(removeTempDirs);

const ACTOR = `local:#${"a".repeat(64)}`;
const HOUR = 3_600_000;

async function ruleEnding(harnessDir: string, pattern: string, endsAt: number): Promise<void> {
  const made = await createStandingRule({
    harnessDir,
    tool: "Write",
    pattern,
    createdBy: ACTOR,
    reason: "approval",
    expiresAt: new Date(endsAt).toISOString(),
    now: NOW,
  });
  if (!made.ok) throw new Error(made.reason);
}

function allows(harnessDir: string): readonly string[] {
  const settings = settingsOf(harnessDir) as {
    permissions?: { rules?: ReadonlyArray<{ type: string; pattern: string }> };
  };
  return (settings?.permissions?.rules ?? [])
    .filter((rule) => rule.type === "alwaysAllow")
    .map((rule) => rule.pattern);
}

describe("endExpiredRules", () => {
  test("a rule past its end is ended and its settings entry removed; a live one stays", async () => {
    const harness = tempDir();
    await ruleEnding(harness, "Write(out.txt)", NOW + HOUR);
    await ruleEnding(harness, "Write(keep.txt)", NOW + 10 * HOUR);
    expect(allows(harness)).toEqual(["Write(out.txt)", "Write(keep.txt)"]);
    expect(await endExpiredRules(harness, NOW + 2 * HOUR)).toBe(1);
    const read = readStandingRules(harness);
    if (read.state !== "present") throw new Error(read.state);
    expect(read.rows.map((row) => [row.pattern, row.state])).toEqual([
      ["Write(out.txt)", "expired"],
      ["Write(keep.txt)", "active"],
    ]);
    expect(allows(harness)).toEqual(["Write(keep.txt)"]);
  });

  test("with nothing past its end, nothing is written: not even a lock file", async () => {
    const harness = tempDir();
    await ruleEnding(harness, "Write(out.txt)", NOW + HOUR);
    const before = treeBytes(harness);
    expect(await endExpiredRules(harness, NOW + HOUR - 1)).toBe(0);
    expect(treeBytes(harness)).toEqual(before);
  });

  test("a harness with no rules file is never touched", async () => {
    const harness = tempDir();
    expect(await endExpiredRules(harness, NOW)).toBe(0);
    expect(existsSync(join(harness, ".crewhaus"))).toBe(false);
  });
});
