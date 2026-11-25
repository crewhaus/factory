/**
 * Every closed text id the contract declares reads as a sentence in a terminal, the
 * envelope a list answers says why it is empty, and names only the harnesses it mentions.
 */
import { describe, expect, test } from "bun:test";
import { TITLE_TEMPLATES } from "@crewhaus/control-contract";
import { assembleInbox } from "./fold";
import { UNREACHABLE_REMEDY, attentionListBody, emptyReasonOf } from "./list-body";
import { ATTENTION_SENTENCES, UNKNOWN_SENTENCE, classWordOf, sentenceOf } from "./sentences";

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
