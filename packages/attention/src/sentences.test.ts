/**
 * Every closed text id the contract declares reads as a sentence in a terminal, the
 * envelope a list answers says why it is empty, and names only the harnesses it mentions.
 */
import { describe, expect, test } from "bun:test";
import { ATTENTION_CHOICE_ROWS, ATTENTION_JOBS, TITLE_TEMPLATES } from "@crewhaus/control-contract";
import { assembleInbox } from "./fold";
import { UNREACHABLE_REMEDY, attentionListBody, emptyReasonOf } from "./list-body";
import {
  ATTENTION_SENTENCES,
  CHOICE_EFFECTS,
  JOB_EFFECTS,
  OPEN_IN_ADVICE,
  UNKNOWN_SENTENCE,
  choiceEffectOf,
  classWordOf,
  sentenceOf,
} from "./sentences";

describe("sentences", () => {
  test("every declared id has one, and an unknown id says so", () => {
    expect(TITLE_TEMPLATES.length).toBeGreaterThan(40);
    for (const id of TITLE_TEMPLATES) {
      expect(`${id}:${Object.hasOwn(ATTENTION_SENTENCES, id)}`).toBe(`${id}:true`);
    }
    expect(Object.keys(ATTENTION_SENTENCES).sort()).toEqual([...TITLE_TEMPLATES].sort());
    expect(sentenceOf({ template: "permission.ask", params: { tool: "Bash" } })).toBe(
      "Permission to use Bash",
    );
    expect(sentenceOf({ template: "why.runs-failed", params: { runs: 1 } })).toBe(
      "1 run failed this way.",
    );
    expect(sentenceOf({ template: "nope" })).toBe(UNKNOWN_SENTENCE);
    expect(sentenceOf({ template: "delegation-proposal.pending", params: {} })).toBe(
      "Letting it act on its own is proposed",
    );
    expect(
      sentenceOf({
        template: "delegation-proposal.pending",
        params: { delegationAction: "merge" },
      }),
    ).toBe("Letting it merge on its own is proposed");
    for (const params of [{}, { decisionKind: "other" }]) {
      expect(sentenceOf({ template: "decision.pending", params })).toBe("A decision is waiting");
    }
    expect(sentenceOf({ template: "decision.pending", params: { decisionKind: "merge" } })).toBe(
      "A merge decision is waiting",
    );
    expect(classWordOf("owner")).toBe("Owner only");
  });
});

describe("what each choice does", () => {
  test("every choice of every kind has an effect, and no other line does", () => {
    const ids = ATTENTION_CHOICE_ROWS.map((row) => `${row.kind}.${row.choice}`);
    expect(ids.length).toBeGreaterThan(30);
    expect(Object.keys(CHOICE_EFFECTS).sort()).toEqual([...ids].sort());
    for (const effect of Object.values(CHOICE_EFFECTS)) {
      expect(effect.endsWith(".")).toBe(true);
      expect(effect.length).toBeLessThanOrEqual(80);
    }
    expect(choiceEffectOf("permission", "grant")).toBe(
      "Allows this one call, and the run goes on.",
    );
    expect(choiceEffectOf("permission", "toString")).toBe("");
    // The two budget raises are told apart.
    expect(CHOICE_EFFECTS["budget.raise-spec"]).not.toBe(CHOICE_EFFECTS["budget.raise-period"]);
  });

  test("an Advisor job says what it starts and what it spends; a screen not named opens Advice", () => {
    expect(Object.keys(JOB_EFFECTS).sort()).toEqual([...ATTENTION_JOBS].sort());
    expect(choiceEffectOf("quality-regression", "act", { job: "optimize" })).toBe(
      "Starts an optimize run. It uses model credits and proposes changes for you to review.",
    );
    expect(choiceEffectOf("spec", "act", { job: "compile" })).toBe(
      "Rebuilds the bundle from the spec.",
    );
    expect(choiceEffectOf("setup", "act", { job: "eval" })).toBe(
      "Starts an eval run. It uses model credits.",
    );
    expect(choiceEffectOf("security", "act")).toBe("Starts the suggested job.");
    expect(choiceEffectOf("security", "act", { job: "toString" })).toBe(
      "Starts the suggested job.",
    );
    expect(choiceEffectOf("security", "open", { place: "security" })).toBe("Opens the incident.");
    expect(choiceEffectOf("security", "open")).toBe(OPEN_IN_ADVICE);
    expect(OPEN_IN_ADVICE).toBe("Opens the suggestion in Advice.");
    // A job never words a choice that is not one.
    expect(choiceEffectOf("permission", "grant", { job: "optimize" })).toBe(
      "Allows this one call, and the run goes on.",
    );
    for (const effect of Object.values(JOB_EFFECTS)) expect(effect.endsWith(".")).toBe(true);
  });
});

describe("the list body", () => {
  const SNAP = "snap";
  test("an empty list says why: no access, unreachable, filtered, or nothing", () => {
    const none = assembleInbox([], 0);
    expect(emptyReasonOf(none, { filtered: false, visible: 0 }).reason).toBe("no-access");
    expect(emptyReasonOf(none, { filtered: true, visible: 2 }).reason).toBe("filtered");
    expect(emptyReasonOf(none, { filtered: false, visible: 2 }).reason).toBe("no-data");
    const lost = { ...none, unreachable: ["hrn_000000000000000a"] };
    expect(emptyReasonOf(lost, { filtered: true, visible: 2 })).toEqual({
      reason: "unreachable",
      remedy: UNREACHABLE_REMEDY,
    });
    expect(UNREACHABLE_REMEDY).not.toContain("crewhaus");
  });

  test("names an unreachable harness whether or not anything is listed, with its name", () => {
    const body = attentionListBody(
      { ...assembleInbox([], 0), unreachable: ["hrn_000000000000000a"] },
      {
        limit: 50,
        filtered: false,
        visible: 2,
        nameOf: (id) => (id === "hrn_000000000000000a" ? "release-bot" : undefined),
        snapshotAt: SNAP,
      },
    );
    expect(body.unreachable).toEqual(["hrn_000000000000000a"]);
    expect(body.names).toEqual([{ id: "hrn_000000000000000a", name: "release-bot" }]);
    expect(body.empty?.reason).toBe("unreachable");
    expect(body.truncated).toBeUndefined();
  });
});
