import { describe, expect, test } from "bun:test";
import type { WorkCorrection } from "./fold";
import { type RankInput, rankWork } from "./ranker";

const at = (day: number) => `2026-11-${String(day).padStart(2, "0")}T00:00:00.000Z`;

function item(wi: string, more: Partial<RankInput> = {}): RankInput {
  return { wi, kind: "fix", basis: "user-pain", createdAt: at(1), ...more };
}

function order(items: readonly RankInput[], options: Parameters<typeof rankWork>[1] = {}) {
  return rankWork(items, options).items.map((row) => row.wi);
}

let seq = 0;
function correction(wi: string, below: string, scope: WorkCorrection["scope"]): WorkCorrection {
  seq += 1;
  return { wi, below, scope, by: "prn_x", at: at(10), seq };
}

const OBSERVED = (n: number) =>
  Array.from({ length: n }, () => ({
    label: "observed" as const,
    kind: "observed-usage" as const,
    ref: "r",
    note: "n",
  }));

describe("the order", () => {
  test("priority first, then age, then id", () => {
    const items = [
      item("c", { priority: 2, createdAt: at(3) }),
      item("a", { priority: 2, createdAt: at(1) }),
      item("b", { priority: 1, createdAt: at(5) }),
      item("d", { createdAt: at(1) }),
      item("e", { priority: 2, createdAt: at(1) }),
    ];
    expect(order(items)).toEqual(["b", "a", "e", "c", "d"]);
  });

  test("weights reorder within a priority only when they are declared", () => {
    const cheap = item("cheap", {
      createdAt: at(5),
      assessment: { problem: "p", evidence: OBSERVED(2), counterEvidence: [], cost: 0 },
    });
    const costly = item("costly", {
      createdAt: at(1),
      assessment: { problem: "p", evidence: [], counterEvidence: [], cost: 3 },
    });
    const first = item("first", { priority: 1, createdAt: at(9) });
    expect(order([cheap, costly, first])).toEqual(["first", "costly", "cheap"]);
    expect(order([cheap, costly, first], { weights: { evidence: 2, cost: 1 } })).toEqual([
      "first",
      "cheap",
      "costly",
    ]);
    const ranked = rankWork([cheap], { weights: { evidence: 2 } }).items[0];
    expect(ranked?.ranking).toBe("weights");
    expect(ranked?.dimensions.find((d) => d.name === "evidence")).toEqual({
      name: "evidence",
      level: 2,
      weight: 2,
    });
    expect(rankWork([cheap]).items[0]?.ranking).toBe("priority");
  });

  test("no output field holds a composite number: every number is a position, a level or a weight", () => {
    const items = [
      item("a", {
        assessment: {
          problem: "p",
          evidence: OBSERVED(3),
          counterEvidence: [],
          cost: 2,
          upkeep: 1,
        },
      }),
      item("b", {
        assessment: { problem: "p", evidence: OBSERVED(1), counterEvidence: [], uncertainty: 3 },
      }),
    ];
    const answer = rankWork(items, {
      weights: { evidence: 3, cost: 2, upkeep: 1, uncertainty: 1 },
    });
    const numericKeys = new Set<string>();
    const walk = (value: unknown, key: string): void => {
      if (typeof value === "number") numericKeys.add(key);
      else if (Array.isArray(value)) for (const v of value) walk(v, key);
      else if (typeof value === "object" && value !== null) {
        for (const [k, v] of Object.entries(value)) walk(v, k);
      }
    };
    walk(answer.items, "");
    expect([...numericKeys].sort()).toEqual(["level", "position", "weight"]);
  });
});

describe("corrections by example", () => {
  const items = [
    item("a1", { kind: "fix", basis: "user-pain", createdAt: at(1) }),
    item("a2", { kind: "fix", basis: "user-pain", createdAt: at(2) }),
    item("b1", { kind: "feature", basis: "user-pain", createdAt: at(3) }),
    item("c1", { kind: "fix", basis: "speculative", createdAt: at(4) }),
    item("c2", { kind: "feature", basis: "speculative", createdAt: at(5) }),
  ];

  test("item moves only the one item", () => {
    const moved = order(items, { corrections: [correction("c2", "a1", "item")] });
    expect(moved).toEqual(["c2", "a1", "a2", "b1", "c1"]);
    const answer = rankWork(items, { corrections: [correction("c2", "a1", "item")] });
    expect(answer.items.filter((row) => row.corrected !== undefined).map((row) => row.wi)).toEqual([
      "c2",
    ]);
  });

  test("similar moves the items of the same kind and basis", () => {
    // c1's group: fix + speculative = {c1}; a1's group: fix + user-pain = {a1, a2}.
    expect(order(items, { corrections: [correction("c1", "a1", "similar")] })).toEqual([
      "c1",
      "a1",
      "a2",
      "b1",
      "c2",
    ]);
  });

  test("all moves every item of the basis", () => {
    const answer = rankWork(items, { corrections: [correction("c1", "a1", "all")] });
    expect(answer.items.map((row) => row.wi)).toEqual(["c1", "c2", "a1", "a2", "b1"]);
    expect(
      answer.items
        .filter((row) => row.corrected?.scope === "all")
        .map((row) => row.wi)
        .sort(),
    ).toEqual(["c1", "c2"]);
  });

  test("a correction never crosses priority bands", () => {
    const banded = [item("p1", { priority: 1 }), item("p2", { priority: 2 })];
    expect(order(banded, { corrections: [correction("p2", "p1", "item")] })).toEqual(["p1", "p2"]);
  });

  test("a cycle drops the older correction and counts it", () => {
    const older = correction("a2", "a1", "item");
    const newer = correction("a1", "a2", "item");
    const answer = rankWork(items, { corrections: [older, newer] });
    expect(answer.items.map((row) => row.wi).slice(0, 2)).toEqual(["a1", "a2"]);
    expect(answer.dropped).toBe(1);
    const flipped = rankWork(items, {
      corrections: [correction("a1", "a2", "item"), correction("a2", "a1", "item")],
    });
    expect(flipped.items.map((row) => row.wi).slice(0, 2)).toEqual(["a2", "a1"]);
  });
});
