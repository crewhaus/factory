import { describe, expect, test } from "bun:test";
import { TurnTransitionError, initialState, transition } from "./index";
import type { TurnEvent, TurnState } from "./index";

const STATES: ReadonlyArray<TurnState> = [
  { kind: "NeedModel" },
  { kind: "NeedTools", toolUses: [{ id: "tu_1", name: "echo", input: {} }] },
  { kind: "NeedCompaction", reason: "approaching_limit" },
  { kind: "NeedRecovery", error: { name: "Err", message: "boom" } },
  { kind: "Done", reason: "no_tools" },
];

const EVENTS: ReadonlyArray<TurnEvent> = [
  { kind: "ModelReturnedText" },
  { kind: "ModelReturnedToolUse", toolUses: [{ id: "tu_2", name: "echo", input: {} }] },
  { kind: "ToolsExecuted" },
  { kind: "BudgetExceeded", reason: "approaching_limit" },
  { kind: "CompactionDone" },
  { kind: "RecoverableError", error: { name: "Err", message: "boom" } },
  { kind: "RecoveryDone" },
  { kind: "Aborted" },
];

/** Exhaustive transition table mirroring the implementation. Tests assert
 *  this table by enumeration; if either side drifts, tests fail. */
const VALID: ReadonlyArray<readonly [TurnState["kind"], TurnEvent["kind"], TurnState["kind"]]> = [
  ["NeedModel", "ModelReturnedText", "Done"],
  ["NeedModel", "ModelReturnedToolUse", "NeedTools"],
  ["NeedModel", "BudgetExceeded", "NeedCompaction"],
  ["NeedModel", "RecoverableError", "NeedRecovery"],
  ["NeedModel", "Aborted", "Done"],
  ["NeedTools", "ToolsExecuted", "NeedModel"],
  ["NeedTools", "Aborted", "Done"],
  ["NeedCompaction", "CompactionDone", "NeedModel"],
  ["NeedCompaction", "Aborted", "Done"],
  ["NeedRecovery", "RecoveryDone", "NeedModel"],
  ["NeedRecovery", "Aborted", "Done"],
];

const validKey = (s: TurnState["kind"], e: TurnEvent["kind"]) => `${s}::${e}`;
const validIndex = new Map(VALID.map(([s, e, t]) => [validKey(s, e), t]));

describe("transition — exhaustive enumeration over (state, event)", () => {
  for (const state of STATES) {
    for (const event of EVENTS) {
      const expectedTarget = validIndex.get(validKey(state.kind, event.kind));
      if (expectedTarget !== undefined) {
        test(`${state.kind} + ${event.kind} -> ${expectedTarget}`, () => {
          const next = transition(state, event);
          expect(next.kind).toBe(expectedTarget);
        });
      } else {
        test(`${state.kind} + ${event.kind} throws`, () => {
          expect(() => transition(state, event)).toThrow(TurnTransitionError);
        });
      }
    }
  }
});

describe("transition — payload propagation", () => {
  test("ModelReturnedToolUse forwards toolUses array into NeedTools", () => {
    const toolUses = [{ id: "tu_42", name: "Bash", input: { command: "ls" } }];
    const next = transition({ kind: "NeedModel" }, { kind: "ModelReturnedToolUse", toolUses });
    expect(next).toEqual({ kind: "NeedTools", toolUses });
  });

  test("BudgetExceeded forwards reason into NeedCompaction", () => {
    const next = transition(
      { kind: "NeedModel" },
      { kind: "BudgetExceeded", reason: "prompt_too_long" },
    );
    expect(next).toEqual({ kind: "NeedCompaction", reason: "prompt_too_long" });
  });

  test("RecoverableError forwards error into NeedRecovery", () => {
    const error = { name: "TypeError", message: "boom" };
    const next = transition({ kind: "NeedModel" }, { kind: "RecoverableError", error });
    expect(next).toEqual({ kind: "NeedRecovery", error });
  });

  test("Aborted from NeedTools sets Done.reason='aborted'", () => {
    const next = transition({ kind: "NeedTools", toolUses: [] }, { kind: "Aborted" });
    expect(next).toEqual({ kind: "Done", reason: "aborted" });
  });

  test("ModelReturnedText sets Done.reason='no_tools'", () => {
    const next = transition({ kind: "NeedModel" }, { kind: "ModelReturnedText" });
    expect(next).toEqual({ kind: "Done", reason: "no_tools" });
  });
});

describe("initialState", () => {
  test("starts in NeedModel", () => {
    expect(initialState).toEqual({ kind: "NeedModel" });
  });
});

describe("TurnTransitionError", () => {
  test("carries runtime error code and a descriptive message", () => {
    try {
      transition({ kind: "Done", reason: "no_tools" }, { kind: "ModelReturnedText" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TurnTransitionError);
      const tte = err as TurnTransitionError;
      expect(tte.code).toBe("runtime");
      expect(tte.message).toContain("Done");
      expect(tte.message).toContain("ModelReturnedText");
    }
  });
});
