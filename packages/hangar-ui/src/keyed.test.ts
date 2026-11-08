import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { keyedPlan } from "../assets/js/ui/keyed.js";

describe("keyedPlan", () => {
  test("a refresh that changed nothing moves nothing", () => {
    expect(keyedPlan(["a", "b", "c"], ["a", "b", "c"])).toEqual({
      remove: [],
      insert: [],
      stay: ["a", "b", "c"],
      move: [],
      moves: 0,
    });
  });

  test("an insert builds one node and moves none", () => {
    const plan = keyedPlan(["a", "c"], ["a", "b", "c"]);
    expect(plan.insert).toEqual(["b"]);
    expect(plan.moves).toBe(0);
    expect(plan.stay).toEqual(["a", "c"]);
  });

  test("a removal moves nothing that stays", () => {
    const plan = keyedPlan(["a", "b", "c"], ["a", "c"]);
    expect(plan.remove).toEqual(["b"]);
    expect(plan.moves).toBe(0);
  });

  test("a reorder moves the fewest nodes", () => {
    expect(keyedPlan(["a", "b", "c", "d"], ["d", "a", "b", "c"]).moves).toBe(1);
    expect(keyedPlan(["a", "b", "c", "d"], ["b", "a", "d", "c"]).moves).toBe(2);
    const reversed = keyedPlan(["a", "b", "c", "d"], ["d", "c", "b", "a"]);
    expect(reversed.moves).toBe(3);
    expect(reversed.stay).toHaveLength(1);
  });

  test("everything new is all inserts", () => {
    const plan = keyedPlan([], ["x", "y"]);
    expect(plan).toMatchObject({ insert: ["x", "y"], moves: 0, remove: [] });
  });

  test("a duplicate key keeps its first place", () => {
    expect(keyedPlan(["a"], ["a", "a", "b"]).insert).toEqual(["b"]);
  });
});
