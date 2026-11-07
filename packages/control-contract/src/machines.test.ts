import { describe, expect, test } from "bun:test";
import { checkMachine } from "./__test__/checkers.js";
import type { MachineDef } from "./areas/types.js";
import { CORE_MODULE, HARNESS_DISPLAY_STATES, MACHINES, canTransition } from "./index.js";

const ENTRIES = Object.entries(MACHINES) as [string, MachineDef][];

describe("every machine", () => {
  test("is sound: maps total, all reachable, none stuck, terminals without edges", () => {
    expect(ENTRIES.length).toBeGreaterThanOrEqual(4);
    let states = 0;
    for (const [name, machine] of ENTRIES) {
      states += machine.states.length;
      expect(checkMachine(name, machine)).toEqual([]);
    }
    expect(states).toBeGreaterThanOrEqual(28);
  });

  test("canTransition agrees with the table for every pair", () => {
    let pairs = 0;
    for (const [name, machine] of ENTRIES) {
      for (const from of machine.states) {
        for (const to of machine.states) {
          pairs++;
          const listed = machine.transitions[from]?.includes(to) ?? false;
          if (canTransition(name, from, to) !== listed) throw new Error(`${name} ${from} ${to}`);
        }
      }
    }
    expect(pairs).toBeGreaterThanOrEqual(10 * 10 + 7 * 7 + 6 * 6 + 5 * 5);
  });

  test("the table is frozen", () => {
    expect(Object.isFrozen(MACHINES)).toBe(true);
    expect(Object.isFrozen(MACHINES.run.transitions)).toBe(true);
  });
});

describe("the checker sees a planted defect", () => {
  const sound: MachineDef = {
    states: ["a", "b"],
    entry: ["a"],
    terminal: ["b"],
    transitions: { a: ["b"], b: [] },
    recoveryOwner: { a: "operator", b: "none" },
  };
  test("sound passes", () => expect(checkMachine("m", sound)).toEqual([]));
  test("a dead end", () => {
    const planted = {
      ...sound,
      states: ["a", "b", "stuck"],
      transitions: { a: ["b", "stuck"], b: [], stuck: [] },
      recoveryOwner: { ...sound.recoveryOwner, stuck: "none" },
    };
    expect(checkMachine("m", planted)).toEqual(["m: dead end stuck"]);
  });
  test("an orphan", () => {
    const planted = {
      ...sound,
      states: ["a", "b", "lost"],
      transitions: { a: ["b"], b: [], lost: ["b"] },
      recoveryOwner: { ...sound.recoveryOwner, lost: "none" },
    };
    expect(checkMachine("m", planted)).toEqual(["m: orphan lost"]);
  });
  test("a terminal with an edge", () => {
    const planted = { ...sound, transitions: { a: ["b"], b: ["a"] } };
    expect(checkMachine("m", planted)).toContain("m: terminal b has edges");
  });
  test("a map that is not total", () => {
    expect(checkMachine("m", { ...sound, recoveryOwner: { a: "operator" } })).toEqual([
      "m: b has no recovery owner",
    ]);
    expect(checkMachine("m", { ...sound, transitions: { a: ["b"] } })).toEqual([
      "m: b has no transitions entry",
    ]);
  });
});

/**
 * The core's four machines, whole. A fold applies only legal moves, so a dropped edge
 * turns real rows into anomalies and an added one makes an illegal move legal, and
 * neither is something the soundness walk above can see.
 */
describe("the core's tables, literally", () => {
  test("a run", () => {
    expect(CORE_MODULE.machines.run).toEqual({
      states: [
        "queued",
        "preparing",
        "running",
        "waiting-for-approval",
        "waiting-for-input",
        "paused",
        "interrupted",
        "succeeded",
        "failed",
        "cancelled",
      ],
      entry: ["queued", "running"],
      terminal: ["interrupted", "succeeded", "failed", "cancelled"],
      transitions: {
        queued: ["preparing", "running", "paused", "cancelled"],
        preparing: ["running", "failed", "cancelled", "interrupted"],
        running: [
          "waiting-for-approval",
          "waiting-for-input",
          "succeeded",
          "failed",
          "cancelled",
          "interrupted",
        ],
        "waiting-for-approval": ["preparing", "running", "succeeded", "failed", "cancelled"],
        "waiting-for-input": ["running", "cancelled", "failed"],
        paused: ["queued", "cancelled"],
        interrupted: [],
        succeeded: [],
        failed: [],
        cancelled: [],
      },
      recoveryOwner: {
        queued: "control-core",
        preparing: "control-core",
        running: "runtime",
        "waiting-for-approval": "decision",
        "waiting-for-input": "attention",
        paused: "operator",
        interrupted: "operator",
        succeeded: "none",
        failed: "none",
        cancelled: "none",
      },
    } as never);
  });

  test("a command", () => {
    expect(CORE_MODULE.machines.command).toEqual({
      states: ["accepted", "running", "unknown", "succeeded", "failed", "rejected", "cancelled"],
      entry: ["accepted"],
      terminal: ["succeeded", "failed", "rejected", "cancelled"],
      transitions: {
        accepted: ["running", "succeeded", "failed", "unknown", "rejected", "cancelled"],
        running: ["succeeded", "failed", "unknown"],
        unknown: ["succeeded", "failed"],
        succeeded: [],
        failed: [],
        rejected: [],
        cancelled: [],
      },
      recoveryOwner: {
        accepted: "control-core",
        running: "control-core",
        unknown: "reconcile",
        succeeded: "none",
        failed: "none",
        rejected: "none",
        cancelled: "none",
      },
    } as never);
  });

  test("a decision", () => {
    expect(CORE_MODULE.machines.decision).toEqual({
      states: ["pending", "granted", "denied", "consumed", "superseded", "expired"],
      entry: ["pending"],
      terminal: ["consumed", "superseded", "expired"],
      transitions: {
        pending: ["granted", "denied", "superseded", "expired"],
        granted: ["consumed", "superseded", "expired"],
        denied: ["superseded"],
        consumed: [],
        superseded: [],
        expired: [],
      },
      recoveryOwner: {
        pending: "operator",
        granted: "runtime",
        denied: "operator",
        consumed: "none",
        superseded: "none",
        expired: "none",
      },
    } as never);
  });

  test("a deployment", () => {
    expect(CORE_MODULE.machines.deployment).toEqual({
      states: ["prepared", "active", "superseded", "disabled", "retired"],
      entry: ["prepared"],
      terminal: ["retired"],
      transitions: {
        prepared: ["active"],
        active: ["superseded", "disabled"],
        superseded: ["retired"],
        disabled: ["active", "retired"],
        retired: [],
      },
      recoveryOwner: {
        prepared: "operator",
        active: "operator",
        superseded: "operator",
        disabled: "operator",
        retired: "none",
      },
    } as never);
  });

  test("the core has these four, and MACHINES holds them as they are", () => {
    expect(Object.keys(CORE_MODULE.machines)).toEqual(["run", "command", "decision", "deployment"]);
    for (const [name, machine] of Object.entries(CORE_MODULE.machines)) {
      expect(MACHINES[name as keyof typeof MACHINES]).toBe(machine as never);
    }
  });
});

describe("the promises in the data", () => {
  test("a run", () => {
    expect(MACHINES.run.entry).toEqual(["queued", "running"]);
    expect(MACHINES.run.terminal).toEqual(["interrupted", "succeeded", "failed", "cancelled"]);
    expect(canTransition("run", "queued", "running")).toBe(true);
    // A park is durable: the process ending never interrupts it.
    expect(canTransition("run", "waiting-for-approval", "interrupted")).toBe(false);
    // A retry is a new run, with new authorization.
    expect(canTransition("run", "interrupted", "queued")).toBe(false);
    // A running run is never paused: pause holds work before it starts.
    expect(canTransition("run", "running", "paused")).toBe(false);
  });

  test("a command", () => {
    expect(MACHINES.command.terminal).toEqual(["succeeded", "failed", "rejected", "cancelled"]);
    expect(canTransition("command", "accepted", "succeeded")).toBe(true);
    expect(canTransition("command", "accepted", "failed")).toBe(true);
    expect(canTransition("command", "accepted", "unknown")).toBe(true);
    expect(canTransition("command", "unknown", "succeeded")).toBe(true);
    expect(canTransition("command", "running", "rejected")).toBe(false);
    expect(MACHINES.command.recoveryOwner["unknown"]).toBe("reconcile");
  });

  test("a decision", () => {
    expect(MACHINES.decision.terminal).toEqual(["consumed", "superseded", "expired"]);
    expect(canTransition("decision", "denied", "expired")).toBe(false);
    expect(canTransition("decision", "denied", "consumed")).toBe(false);
    expect(canTransition("decision", "denied", "superseded")).toBe(true);
    expect(canTransition("decision", "granted", "expired")).toBe(true);
    expect(canTransition("decision", "granted", "consumed")).toBe(true);
    expect(canTransition("decision", "pending", "consumed")).toBe(false);
  });

  test("a deployment", () => {
    expect(MACHINES.deployment.terminal).toEqual(["retired"]);
    expect(canTransition("deployment", "disabled", "active")).toBe(true);
    expect(canTransition("deployment", "superseded", "active")).toBe(false);
  });

  test("recovery owners", () => {
    expect(MACHINES.run.recoveryOwner).toEqual({
      queued: "control-core",
      preparing: "control-core",
      running: "runtime",
      "waiting-for-approval": "decision",
      "waiting-for-input": "attention",
      paused: "operator",
      interrupted: "operator",
      succeeded: "none",
      failed: "none",
      cancelled: "none",
    });
    expect(MACHINES.decision.recoveryOwner).toEqual({
      pending: "operator",
      granted: "runtime",
      denied: "operator",
      consumed: "none",
      superseded: "none",
      expired: "none",
    });
    expect(MACHINES.deployment.recoveryOwner["active"]).toBe("operator");
    expect(MACHINES.deployment.recoveryOwner["retired"]).toBe("none");
  });

  test("names that are not there answer false, inherited ones included", () => {
    expect(canTransition("nothing", "a", "b")).toBe(false);
    expect(canTransition("run", "nothing", "running")).toBe(false);
    expect(canTransition("run", "queued", "nothing")).toBe(false);
    expect(canTransition("constructor", "a", "b")).toBe(false);
    expect(canTransition("run", "constructor", "name")).toBe(false);
  });

  test("display states", () => {
    expect([...HARNESS_DISPLAY_STATES]).toEqual([
      "running",
      "paused",
      "draining",
      "stopped",
      "crashed",
      "disabled",
      "disconnected",
    ]);
  });
});
