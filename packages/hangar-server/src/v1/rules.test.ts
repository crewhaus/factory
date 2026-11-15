/**
 * Making a standing rule through the API: a rule is made only from a granted decision
 * that still stands, with its row and its settings entry; a decision that is pending or
 * superseded makes none, and leaves no receipt for the rule.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { foldStates, readStandingRules } from "@crewhaus/control-records";
import { commandsLedgerOf } from "@crewhaus/control-service";
import { type V1Home, v1Home } from "../__test__/v1-home";

const STAMP = "2026-11-11T00:00:00.000Z";
const GRANTED = "appr_00000000000000b1";
const SUPERSEDED = "appr_00000000000000b2";
const PENDING = "appr_00000000000000b3";

let home: V1Home;
let h: { id: string; dir: string };

const approval = (id: string, file: string) => ({
  id,
  toolName: "Write",
  inputHash: `hash-${id}`,
  input: { path: file },
  runId: "run_00000000000000b0",
  sessionId: "sess_00000000000000bb",
  surface: "daemon",
  createdAt: STAMP,
});

const ruleReceipts = (dir: string) => {
  const fold = foldStates(commandsLedgerOf(dir));
  return fold.ok
    ? [...fold.objects.values()].map((o) => o.record).filter((r) => r["kind"] === "rules.create")
    : [];
};

const allows = (dir: string): string[] => {
  try {
    const settings = JSON.parse(readFileSync(join(dir, ".crewhaus", "settings.json"), "utf8")) as {
      permissions?: { rules?: ReadonlyArray<{ type: string; pattern: string }> };
    };
    return (settings.permissions?.rules ?? [])
      .filter((rule) => rule.type === "alwaysAllow")
      .map((rule) => rule.pattern);
  } catch {
    return [];
  }
};

const create = (ref: string, file: string) =>
  home.call("POST", `/api/v1/harnesses/${h.id}/standing-rules`, {
    body: { tool: "Write", pattern: `Write(${file})`, derivedFrom: ref, reason: "other" },
  });

beforeAll(async () => {
  home = await v1Home();
  h = await home.harness("rules", {
    approvals: [
      approval(GRANTED, "notes/a.md"),
      approval(SUPERSEDED, "notes/b.md"),
      approval(PENDING, "notes/c.md"),
    ],
  });
}, 60_000);

afterAll(async () => {
  await home?.t.stop();
});

describe("rules.create", () => {
  test("a superseded or pending decision makes no rule, no settings entry and no rule receipt", async () => {
    const granted = await home.call(
      "POST",
      `/api/v1/decisions/${SUPERSEDED}/resolve?harness=${h.id}`,
      {
        body: { choice: "grant" },
      },
    );
    expect(granted.status).toBeLessThan(300);
    const superseded = await home.call(
      "POST",
      `/api/v1/decisions/${SUPERSEDED}/supersede?harness=${h.id}`,
      {
        body: { reason: "decided-in-error" },
      },
    );
    expect(superseded.status).toBeLessThan(300);
    for (const [ref, file] of [
      [SUPERSEDED, "notes/b.md"],
      [PENDING, "notes/c.md"],
    ] as const) {
      const answer = await create(ref, file);
      const error = answer.body["error"] as { reason?: string } | undefined;
      expect({ ref, status: answer.status, reason: error?.reason }).toEqual({
        ref,
        status: 422,
        reason: "derived_from",
      });
    }
    expect(ruleReceipts(h.dir)).toEqual([]);
    expect(readStandingRules(h.dir).state).toBe("absent");
    expect(allows(h.dir)).toEqual([]);
  }, 30_000);

  test("a granted decision that stands makes its rule and its settings entry", async () => {
    const granted = await home.call(
      "POST",
      `/api/v1/decisions/${GRANTED}/resolve?harness=${h.id}`,
      {
        body: { choice: "grant" },
      },
    );
    expect(granted.status).toBeLessThan(300);
    const answer = await create(GRANTED, "notes/a.md");
    expect(answer.status).toBeLessThan(300);
    expect((answer.body["rule"] as { derivedFrom?: string } | undefined)?.derivedFrom).toBe(
      GRANTED,
    );
    const read = readStandingRules(h.dir);
    expect(
      read.state === "present" && read.rows.map((row) => [row.derivedFrom, row.state]),
    ).toEqual([[GRANTED, "active"]]);
    expect(allows(h.dir)).toEqual(["Write(notes/a.md)"]);
    expect(ruleReceipts(h.dir).map((r) => r["state"])).toEqual(["succeeded"]);
  }, 30_000);
});
