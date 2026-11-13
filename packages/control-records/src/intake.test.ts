import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { composeIntake, intakeVerdict } from "./intake";
import { intakeRoot, registerIntakeRoot, unregisterIntakeRoot } from "./intake-root";
import { type OperatorRead, createOperatorReader } from "./operator";
import {
  UNREADABLE_OPERATOR,
  controlFile,
  jsonLine,
  plant,
  removeTempDirs,
  tempDir,
} from "./test-helpers";

afterAll(removeTempDirs);

const BASE = { v: 1, rev: 1, desired: "running" };
const PAUSED = { paused: true, since: "2026-11-07T00:00:00.000Z", by: "prn_x", cmd: "pause" };
const DISABLED = { disabled: true, since: "2026-11-07T01:00:00.000Z", by: "prn_y", cmd: "disable" };
const PAUSED_TEXT = "Paused by its operator; this message was not processed.";
const DISABLED_TEXT = "Disabled by its operator; this message was not processed.";

function freshRead(): (dir: string) => OperatorRead {
  let t = 0;
  return createOperatorReader({
    now: () => {
      t += 10_000;
      return t;
    },
  });
}

function harnessWith(body: object): string {
  const root = tempDir();
  plant(controlFile(root, "operator.json"), jsonLine({ ...BASE, ...body }));
  return root;
}

describe("a closed verdict names each reason, and an unreadable record closes (brief 324)", () => {
  test("absent is open", () => {
    expect(intakeVerdict(tempDir(), { read: freshRead() })).toEqual({ state: "open" });
  });

  test("a record with no restriction set is open", () => {
    const read = freshRead();
    expect(intakeVerdict(harnessWith({}), { read })).toEqual({ state: "open" });
    expect(intakeVerdict(harnessWith({ intake: { paused: false } }), { read })).toEqual({
      state: "open",
    });
    expect(intakeVerdict(harnessWith({ deployment: { disabled: false } }), { read })).toEqual({
      state: "open",
    });
  });

  test("paused closes with code paused and one reason carrying since, by and cmd", () => {
    expect(intakeVerdict(harnessWith({ intake: PAUSED }), { read: freshRead() })).toEqual({
      state: "closed",
      reasons: [
        { kind: "operator", state: "paused", since: PAUSED.since, by: PAUSED.by, cmd: PAUSED.cmd },
      ],
      notice: PAUSED_TEXT,
      code: "paused",
      exitName: "paused",
    });
  });

  test("disabled closes with code disabled", () => {
    expect(intakeVerdict(harnessWith({ deployment: DISABLED }), { read: freshRead() })).toEqual({
      state: "closed",
      reasons: [
        {
          kind: "operator",
          state: "disabled",
          since: DISABLED.since,
          by: DISABLED.by,
          cmd: DISABLED.cmd,
        },
      ],
      notice: DISABLED_TEXT,
      code: "disabled",
      exitName: "disabled",
    });
  });

  test("paused and disabled list both reasons; lifting one never lifts the other", () => {
    const root = harnessWith({ intake: PAUSED, deployment: DISABLED });
    let t = 0;
    const read = createOperatorReader({ now: () => t });
    const both = intakeVerdict(root, { read });
    if (both.state !== "closed") throw new Error(both.state);
    expect(both.code).toBe("disabled");
    expect(both.reasons.map((r) => r.state).sort()).toEqual(["disabled", "paused"]);

    writeFileSync(controlFile(root, "operator.json"), jsonLine({ ...BASE, intake: PAUSED }));
    t += 1000;
    const one = intakeVerdict(root, { read });
    if (one.state !== "closed") throw new Error(one.state);
    expect(one.code).toBe("paused");
    expect(one.reasons.map((r) => r.state)).toEqual(["paused"]);
  });

  for (const [form, make] of Object.entries(UNREADABLE_OPERATOR)) {
    test(`${form}: closed, code paused, state unreadable, with the reason`, () => {
      const root = tempDir();
      make(root);
      const verdict = intakeVerdict(root, { read: freshRead() });
      if (verdict.state !== "closed") throw new Error(verdict.state);
      expect(verdict.code).toBe("paused");
      expect(verdict.exitName).toBe("paused");
      expect(verdict.notice).toBe(PAUSED_TEXT);
      expect(verdict.reasons).toHaveLength(1);
      expect(verdict.reasons[0]?.state).toBe("unreadable");
      expect(verdict.reasons[0]?.detail?.length ?? 0).toBeGreaterThan(0);
    });
  }

  test("notice is the record's string, null when quiet, and the fixed text when absent", () => {
    const read = freshRead();
    const closed = (intake: object) => {
      const verdict = intakeVerdict(harnessWith({ intake }), { read });
      if (verdict.state !== "closed") throw new Error(verdict.state);
      return verdict;
    };
    expect(closed({ paused: true, notice: "back at noon" }).notice).toBe("back at noon");
    expect(closed({ paused: true, notice: null }).notice).toBeNull();
    expect(closed({ paused: true }).notice).toBe(PAUSED_TEXT);
  });

  test("a notice on a pause that is not in force is not shown", () => {
    const verdict = intakeVerdict(
      harnessWith({ intake: { paused: false, notice: "stale" }, deployment: DISABLED }),
      { read: freshRead() },
    );
    expect(verdict).toMatchObject({ state: "closed", notice: DISABLED_TEXT });
  });

  test("retryAfter is absent from every operator answer", () => {
    const read = freshRead();
    for (const body of [{ intake: PAUSED }, { deployment: DISABLED }]) {
      const verdict = intakeVerdict(harnessWith(body), { read });
      expect("retryAfter" in verdict).toBe(false);
    }
    const root = tempDir();
    UNREADABLE_OPERATOR["torn"]?.(root);
    expect("retryAfter" in intakeVerdict(root, { read })).toBe(false);
  });

  test("the SLO file is not a reason: it says paused, and intake stays open", () => {
    const root = tempDir();
    plant(join(root, ".crewhaus", "slo", "intake.json"), jsonLine({ paused: true }));
    expect(intakeVerdict(root, { read: freshRead() })).toEqual({ state: "open" });
  });
});

describe("composeIntake", () => {
  test("no reasons is open", () => {
    expect(composeIntake([], undefined)).toEqual({ state: "open" });
  });

  test("exitName names the exit for the code: paused, disabled, and paused for unreadable", () => {
    const unreadable = { kind: "operator", state: "unreadable", detail: "torn" } as const;
    expect(composeIntake([{ kind: "operator", state: "paused" }], undefined)).toMatchObject({
      code: "paused",
      exitName: "paused",
    });
    expect(composeIntake([{ kind: "operator", state: "disabled" }], undefined)).toMatchObject({
      code: "disabled",
      exitName: "disabled",
    });
    expect(composeIntake([unreadable], undefined)).toMatchObject({
      code: "paused",
      exitName: "paused",
    });
  });

  test("any disabled reason makes the code disabled, whatever the order", () => {
    const paused = { kind: "operator", state: "paused" } as const;
    const disabled = { kind: "operator", state: "disabled" } as const;
    expect(composeIntake([paused, disabled], undefined)).toMatchObject({ code: "disabled" });
    expect(composeIntake([disabled, paused], undefined)).toMatchObject({ code: "disabled" });
    expect(composeIntake([paused], undefined)).toMatchObject({ code: "paused" });
  });
});

describe("the intake root: the directory of the control plane this process serves", () => {
  const SLOT = Symbol.for("@crewhaus/control-records/intake-root");
  const slot = (): unknown => (globalThis as unknown as Record<symbol, unknown>)[SLOT];

  afterEach(() => {
    Reflect.deleteProperty(globalThis, SLOT);
  });

  test("absent until registered, then the directory, then absent again", () => {
    const root = tempDir();
    expect(intakeRoot()).toBeUndefined();
    registerIntakeRoot(root);
    expect(intakeRoot()).toBe(root);
    unregisterIntakeRoot(root);
    expect(intakeRoot()).toBeUndefined();
  });

  test("a relative directory is kept resolved, and unregistered by either spelling", () => {
    registerIntakeRoot(".");
    expect(intakeRoot()).toBe(process.cwd());
    unregisterIntakeRoot(process.cwd());
    expect(intakeRoot()).toBeUndefined();
  });

  test("unregistering another directory leaves the slot as it is", () => {
    const root = tempDir();
    registerIntakeRoot(root);
    unregisterIntakeRoot(tempDir());
    expect(intakeRoot()).toBe(root);
  });

  test("the slot lives on globalThis, so a second copy of the package reads the same root", () => {
    const root = tempDir();
    registerIntakeRoot(root);
    expect(slot()).toBe(root);
    // What a second copy does: it writes the same well-known symbol.
    const elsewhere = tempDir();
    (globalThis as unknown as Record<symbol, unknown>)[SLOT] = elsewhere;
    expect(intakeRoot()).toBe(elsewhere);
  });
});
