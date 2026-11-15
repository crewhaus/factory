/**
 * Ending standing rules on Home's tick: a rule past its end is ended with its settings
 * entry, and a harness with nothing due is never touched. A rule made from a decision is
 * written only while that decision stands, asked under the rule lock, and the rules made
 * from a decision are read and ended under that same lock.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mintId } from "@crewhaus/control-contract";
import {
  type StandingRuleRow,
  casAppendLocked,
  readStandingRules,
  standingRulesLedger,
  withLedgerLock,
} from "@crewhaus/control-records";
import { appendSettingsRule } from "@crewhaus/permission-engine";
import { generateApprovalId } from "@crewhaus/session-store";
import { createStandingRule, endDerivedRules, endExpiredRules } from "./rules";
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

describe("a rule made from a decision", () => {
  const write = (harnessDir: string, extra: object) =>
    createStandingRule({
      harnessDir,
      tool: "Write",
      pattern: "Write(notes/a.md)",
      createdBy: ACTOR,
      reason: "approval",
      expiresAt: new Date(NOW + HOUR).toISOString(),
      now: NOW,
      ...extra,
    } as Parameters<typeof createStandingRule>[0]);

  test("asks whether the decision stands under the rule lock, and writes it when it does", async () => {
    const harness = tempDir();
    const lock = join(harness, standingRulesLedger(harness).lock);
    expect(existsSync(lock)).toBe(false);
    let sawLock: boolean | undefined;
    const from = generateApprovalId();
    const made = await write(harness, {
      derivedFrom: from,
      derivesFrom: () => {
        sawLock = existsSync(lock);
        return undefined;
      },
    });
    expect(sawLock).toBe(true);
    expect(made.ok && made.rule.derivedFrom).toBe(from);
    expect(allows(harness)).toEqual(["Write(notes/a.md)"]);
  });

  test("a decision that does not stand makes no row and no settings entry", async () => {
    const harness = tempDir();
    const made = await write(harness, {
      derivedFrom: generateApprovalId(),
      derivesFrom: () => "gone",
    });
    expect(made).toEqual({ ok: false, reason: "gone" });
    expect(readStandingRules(harness).state).toBe("absent");
    expect(allows(harness)).toEqual([]);
  });

  test("a check that throws makes no row and no settings entry", async () => {
    const harness = tempDir();
    const made = await write(harness, {
      derivedFrom: generateApprovalId(),
      derivesFrom: () => {
        throw new Error("the approvals cannot be read");
      },
    });
    expect(made).toEqual({ ok: false, reason: "the approvals cannot be read" });
    expect(readStandingRules(harness).state).toBe("absent");
    expect(allows(harness)).toEqual([]);
  });

  test("names the check it is asked under whenever it names its decision", () => {
    const harness = tempDir();
    // A rule named by a decision carries the check: this is a type error.
    // @ts-expect-error derivesFrom is required with derivedFrom
    const unchecked: Parameters<typeof createStandingRule>[0] = {
      harnessDir: harness,
      tool: "Write",
      pattern: "Write(notes/a.md)",
      createdBy: ACTOR,
      reason: "approval",
      expiresAt: new Date(NOW + HOUR).toISOString(),
      now: NOW,
      derivedFrom: generateApprovalId(),
    };
    expect(unchecked.derivedFrom).toBeDefined();
  });

  test("endDerivedRules reads the rules under the lock: a rule written while it waits is ended", async () => {
    const harness = tempDir();
    const ref = generateApprovalId();
    const ledger = standingRulesLedger(harness);
    let ending: ReturnType<typeof endDerivedRules> | undefined;
    const id = mintId("rule", { now: NOW });
    await withLedgerLock(ledger, async () => {
      ending = endDerivedRules({
        harnessDir: harness,
        ref,
        end: true,
        revokedBy: async () => ACTOR,
        now: () => NOW,
      });
      const row: StandingRuleRow = {
        id,
        kind: "allow",
        tool: "Write",
        pattern: "Write(notes/a.md)",
        derivedFrom: ref,
        createdBy: ACTOR,
        reason: "approval",
        createdAt: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW + HOUR).toISOString(),
        state: "active",
      };
      const made = await casAppendLocked(ledger, id, null, row);
      expect(made.ok && made.applied).toBe(true);
      appendSettingsRule(harness, { type: "alwaysAllow", pattern: "Write(notes/a.md)" });
    });
    if (ending === undefined) throw new Error("not started");
    const answer = await ending;
    expect(
      answer.state === "read" && answer.rules.map((r) => [r.row.id, r.ended?.outcome]),
    ).toEqual([[id, "revoked"]]);
    const read = readStandingRules(harness);
    expect(read.state === "present" && read.rows.find((row) => row.id === id)?.state).toBe(
      "revoked",
    );
    expect(allows(harness)).toEqual([]);
  });

  test("endDerivedRules without end names the live rules and changes nothing", async () => {
    const harness = tempDir();
    const ref = generateApprovalId();
    const made = await write(harness, { derivedFrom: ref, derivesFrom: () => undefined });
    if (!made.ok) throw new Error(made.reason);
    let asked = 0;
    const answer = await endDerivedRules({
      harnessDir: harness,
      ref,
      end: false,
      revokedBy: async () => {
        asked += 1;
        return ACTOR;
      },
      now: () => NOW,
    });
    expect(answer.state === "read" && answer.rules.map((r) => [r.row.id, r.ended])).toEqual([
      [made.rule.id, undefined],
    ]);
    expect(asked).toBe(0);
    expect(allows(harness)).toEqual(["Write(notes/a.md)"]);
  });
});
