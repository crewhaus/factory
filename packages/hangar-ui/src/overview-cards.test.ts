/**
 * The Overview's cards say what a harness may do on its own, from its delegation rules,
 * and what needs a person; the quality card reads only the latest comparable run, never
 * a partial or replayed one, and says when the way it is measured changed. The header
 * strip says the state in words and where it runs.
 */
import { describe, expect, test } from "bun:test";
import {
  LIMITS_UNREAD,
  headerStripModel,
  needsYouCardModel,
  operatingLimitsModel,
  purposeWords,
  qualityModel,
  runsModel,
  // @ts-expect-error — hand-written browser JS, typed as text for the embed map
} from "../assets/js/views/overview-cards.js";

const texts = (lines: { text: string }[]) => lines.map((l) => l.text);

describe("Operating limits", () => {
  test("an active rule says what it does, until when, and how often so far", () => {
    const lines = operatingLimitsModel(
      { items: [{ action: "merge", state: "active", endsAt: "2026-11-16T09:00:00Z", uses: 3 }] },
      null,
      "hrn_000000000000000a",
    );
    expect(texts(lines)).toEqual([
      "Merging delegated until 16 Nov (3 so far)",
      "Rollouts ask a person",
    ]);
  });

  test("a rule turned off after a rollback says so, with a way to review it", () => {
    const lines = operatingLimitsModel(
      { items: [{ action: "rollout", state: "suspended", suspendedReason: "rolled-back" }] },
      null,
      "hrn_000000000000000a",
    );
    expect(texts(lines)).toEqual([
      "Rule turned off after a rollback.",
      "Merges ask a person",
      "Rollouts ask a person",
    ]);
    expect(lines[0]?.review).toBe("#/h/hrn_000000000000000a/setup/delegations");
  });

  test("no rules: everything asks a person, and the spending limit is named", () => {
    expect(
      texts(operatingLimitsModel({ items: [] }, { present: false, why: "no_period" })),
    ).toEqual(["Merges ask a person", "Rollouts ask a person", "No spending limit set."]);
    expect(
      texts(operatingLimitsModel({ items: [] }, { present: true, fold: { unknownCalls: 2 } })).at(
        -1,
      ),
    ).toBe("Cost unknown for some calls.");
  });

  test("rules that could not be read say so, with a retry, and never that anything asks a person", () => {
    const lines = operatingLimitsModel(null, { present: false, why: "no_period" }, "h");
    expect(texts(lines)).toEqual([LIMITS_UNREAD, "No spending limit set."]);
    expect(lines[0]?.retry).toBe(true);
    expect(texts(lines).some((t) => t.includes("ask a person"))).toBe(false);
  });
});

describe("the Needs you card", () => {
  const pending = {
    id: "appr_00000000000000f9",
    state: "pending",
    createdAt: "2026-11-01T00:00:00Z",
  };

  test("the requests waiting here are shown, and a whole list with none says none wait", () => {
    expect(needsYouCardModel({ items: [pending] }).pending).toEqual([pending]);
    expect(needsYouCardModel({ items: [pending] }).empty).toBeNull();
    expect(needsYouCardModel({ items: [] })).toEqual({
      pending: [],
      notes: [],
      empty: "No requests are waiting here.",
    });
  });

  test("a list read only in part never says nothing waits, and says why", () => {
    const cut = needsYouCardModel(
      {
        items: [],
        truncated: { reason: "harness_capped", verb: "crewhaus approvals list" },
        unreachable: ["hrn_000000000000000a"],
      },
      "Alpha",
    );
    expect(cut.empty).toBeNull();
    expect(cut.notes).toHaveLength(2);
    expect(cut.notes[0]).toContain("Alpha");
    expect(cut.notes[1]).toContain("crewhaus approvals list");
  });
});

describe("the quality card", () => {
  const run = (over: Record<string, unknown>) => ({
    runId: "run_1",
    datasetName: "smoke",
    datasetHash: "d1",
    gradersHash: "g1",
    judgeModel: "judge-1",
    passRate: 0.9,
    sampleCount: 10,
    ...over,
  });

  test("the latest run that is neither partial nor replayed, passed and failed only", () => {
    const model = qualityModel([
      run({ runId: "run_3", partial: true }),
      run({ runId: "run_2", replayed: true }),
      run({ runId: "run_1", passRate: 0.8 }),
    ]);
    expect(model.runId).toBe("run_1");
    expect(model.words).toBe("Latest comparable evaluation: 8 of 10 passed · 2 failed");
    expect(model.skipped).toBe("Skipped cases aren't reported yet.");
    expect(model.lineageChanged).toBe(false);
  });

  test("a change in any lineage field is measured differently from here on", () => {
    for (const field of ["datasetName", "datasetHash", "gradersHash", "judgeModel"]) {
      const model = qualityModel([
        run({ runId: "run_2", [field]: "other" }),
        run({ runId: "run_1" }),
      ]);
      expect(`${field}: ${model.lineageChanged}`).toBe(`${field}: true`);
    }
    expect(qualityModel([run({ runId: "run_2" }), run({})]).lineageChanged).toBe(false);
  });

  test("nothing comparable yet says so, never a pass rate", () => {
    expect(qualityModel([run({ partial: true })]).state).toBe("none");
    expect(qualityModel(null).words).toBe("Not evaluated yet.");
  });
});

describe("the header strip and purpose", () => {
  test("the state in words, and a control not enforced yet says so", () => {
    expect(headerStripModel({ display: { state: "paused", enforcement: "enforced" } }).word).toBe(
      "Paused (new work held)",
    );
    expect(
      headerStripModel({ display: { state: "paused", enforcement: "recorded-not-enforced" } }).word,
    ).toBe("Recorded, not enforced");
    expect(headerStripModel({ display: { state: "running" } }, { loopback: true }).host).toBe(
      "Runs on this computer",
    );
    expect(headerStripModel({ display: {} }, { loopback: false, host: "studio" }).host).toBe(
      "Runs on studio",
    );
  });

  test("a harness with no purpose says where to add one", () => {
    expect(purposeWords({ purpose: "Answer tickets." })).toBe("Answer tickets.");
    expect(purposeWords({})).toBe("No purpose yet. Add one in Setup.");
  });

  test("runs split into working now and finished", () => {
    const model = runsModel({
      items: [
        { id: "run_a", state: "running" },
        { id: "run_b", state: "succeeded" },
        { id: "run_c", state: "waiting" },
      ],
    });
    expect(model.working.map((r: { id: string }) => r.id)).toEqual(["run_a", "run_c"]);
    expect(model.finished.map((r: { id: string }) => r.id)).toEqual(["run_b"]);
  });
});

describe("the spending card while a person types a raise", () => {
  /** A card whose raise field holds `value`, and whose focus is or is not inside it. */
  const cardWith = (value: string, focused: boolean) => {
    const amount = { type: "number", value };
    const elsewhere = {};
    return {
      card: {
        contains: (node: unknown) => node === amount,
        querySelectorAll: () => [amount],
      },
      active: focused ? amount : elsewhere,
    };
  };

  test("a typed amount, or focus in the card, keeps it from being replaced", async () => {
    // @ts-expect-error — hand-written browser JS, typed as text for the embed map
    const { holdsDraft } = await import("../assets/js/views/overview.js");
    const typed = cardWith("25", false);
    expect(holdsDraft(typed.card, typed.active)).toBe(true);
    const focused = cardWith("", true);
    expect(holdsDraft(focused.card, focused.active)).toBe(true);
    const idle = cardWith("", false);
    expect(holdsDraft(idle.card, idle.active)).toBe(false);
  });
});
