import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { _setIoTapForTest } from "./io";
import { type OperatorRead, createOperatorReader, operatorVerdict } from "./operator";
import {
  UNREADABLE_OPERATOR,
  controlFile,
  jsonLine,
  plant,
  removeTempDirs,
  tempDir,
} from "./test-helpers";

afterEach(() => _setIoTapForTest(undefined));
afterAll(removeTempDirs);

const BASE = { v: 1, rev: 3, desired: "running" };
const PAUSED = { paused: true, since: "2026-11-07T00:00:00.000Z", by: "prn_x", cmd: "pause" };
const DISABLED = { disabled: true, since: "2026-11-07T01:00:00.000Z", by: "prn_y", cmd: "disable" };

function reader(): (dir: string) => OperatorRead {
  // A clock that moves on every call, so nothing is served from the cache by accident.
  let t = 0;
  return createOperatorReader({
    now: () => {
      t += 10_000;
      return t;
    },
  });
}

function harnessWith(body: string): string {
  const root = tempDir();
  plant(controlFile(root, "operator.json"), body);
  return root;
}

describe("readOperatorRecord", () => {
  test("absent reads as absent, and creates nothing", () => {
    const root = tempDir();
    expect(reader()(root)).toEqual({ state: "absent" });
  });

  test("a record reads back with its blocks, and an absent block as null", () => {
    const root = harnessWith(jsonLine({ ...BASE, intake: PAUSED, desired: "stopped" }));
    expect(reader()(root)).toEqual({
      state: "present",
      record: { v: 1, rev: 3, intake: PAUSED, deployment: null, desired: "stopped" },
    });
    const both = harnessWith(jsonLine({ ...BASE, intake: null, deployment: DISABLED }));
    expect(reader()(both)).toEqual({
      state: "present",
      record: { v: 1, rev: 3, intake: null, deployment: DISABLED, desired: "running" },
    });
  });

  test("notice keeps its three forms: text, null for quiet, absent for the fixed text", () => {
    for (const notice of ["back soon", null]) {
      const root = harnessWith(jsonLine({ ...BASE, intake: { paused: true, notice } }));
      const read = reader()(root);
      expect(read.state === "present" && read.record.intake?.notice).toBe(notice);
    }
    const root = harnessWith(jsonLine({ ...BASE, intake: { paused: true } }));
    const read = reader()(root);
    expect(read.state === "present" && "notice" in (read.record.intake ?? {})).toBe(false);
  });

  test("an unknown extra key is ignored, at the top and inside a block", () => {
    const root = harnessWith(
      jsonLine({ ...BASE, future: 1, intake: { paused: false, future: 2 } }),
    );
    expect(reader()(root)).toEqual({
      state: "present",
      record: { v: 1, rev: 3, intake: { paused: false }, deployment: null, desired: "running" },
    });
  });

  for (const [form, make] of Object.entries(UNREADABLE_OPERATOR)) {
    test(`${form} is unreadable, with its reason, and the verdict is paused and refused`, () => {
      const root = tempDir();
      make(root);
      const read = reader()(root);
      expect(read.state).toBe("unreadable");
      if (read.state !== "unreadable") throw new Error(read.state);
      expect(read.reason.length).toBeGreaterThan(0);
      expect(operatorVerdict(read)).toEqual({
        intake: "paused",
        start: "refused",
        unreadable: true,
      });
    });
  }

  test("a good record followed by padding past the cap is still over the cap", () => {
    const root = harnessWith(`${jsonLine(BASE)}${" ".repeat(64 * 1024)}`);
    const read = reader()(root);
    expect(read.state).toBe("unreadable");
    expect(read.state === "unreadable" && read.reason).toContain("larger than");
  });

  test("a record exactly at the cap is read", () => {
    const line = jsonLine(BASE);
    const root = harnessWith(`${line}${" ".repeat(64 * 1024 - line.length)}`);
    expect(reader()(root).state).toBe("present");
  });

  test("each required field and each wrong type is refused", () => {
    const bad: readonly unknown[] = [
      { v: 1, desired: "running" },
      { ...BASE, rev: -1 },
      { ...BASE, rev: 1.5 },
      { ...BASE, desired: "maybe" },
      { ...BASE, intake: 7 },
      { ...BASE, intake: [] },
      { ...BASE, intake: {} },
      { ...BASE, intake: { paused: "yes" } },
      { ...BASE, intake: { paused: true, since: 1 } },
      { ...BASE, intake: { paused: true, by: false } },
      { ...BASE, intake: { paused: true, reason: {} } },
      { ...BASE, intake: { paused: true, cmd: 2 } },
      { ...BASE, intake: { paused: true, notice: 3 } },
      { ...BASE, deployment: {} },
      { ...BASE, deployment: { disabled: 1 } },
      { ...BASE, deployment: { disabled: true, since: 1 } },
    ];
    for (const body of bad) {
      expect(reader()(harnessWith(jsonLine(body))).state).toBe("unreadable");
    }
  });

  test("a refusal names the file and the fault, never a value from it", () => {
    const secret = "do-not-repeat-this";
    const root = harnessWith(jsonLine({ v: secret, rev: 1, desired: "running" }));
    const read = reader()(root);
    if (read.state !== "unreadable") throw new Error(read.state);
    expect(read.reason).toContain("operator.json");
    expect(read.reason).not.toContain(secret);
    const garbled = harnessWith(`{"v":1,${secret}`);
    const torn = reader()(garbled);
    if (torn.state !== "unreadable") throw new Error(torn.state);
    expect(torn.reason).toContain("operator.json");
    expect(torn.reason).not.toContain(secret);
  });

  test("two reads inside one second open the file once; a rewrite shows after the second", () => {
    const root = harnessWith(jsonLine({ ...BASE, rev: 1 }));
    let t = 1000;
    const read = createOperatorReader({ now: () => t });
    let opens = 0;
    _setIoTapForTest({
      open: () => {
        opens += 1;
      },
    });
    const first = read(root);
    t += 999;
    const second = read(root);
    expect(opens).toBe(1);
    expect(second).toBe(first);

    writeFileSync(controlFile(root, "operator.json"), jsonLine({ ...BASE, rev: 2 }));
    t += 2;
    const third = read(root);
    expect(opens).toBe(2);
    expect(third.state === "present" && third.record.rev).toBe(2);
  });

  test("an absent answer is cached too, and appears when the second has passed", () => {
    const root = tempDir();
    let t = 0;
    const read = createOperatorReader({ now: () => t });
    expect(read(root)).toEqual({ state: "absent" });
    plant(controlFile(root, "operator.json"), jsonLine(BASE));
    expect(read(root)).toEqual({ state: "absent" });
    t = 1000;
    expect(read(root).state).toBe("present");
  });

  test("a clock that went backwards does not keep an old answer", () => {
    const root = harnessWith(jsonLine(BASE));
    let t = 5000;
    const read = createOperatorReader({ now: () => t });
    read(root);
    rmSync(controlFile(root, "operator.json"));
    t = 4000;
    expect(read(root)).toEqual({ state: "absent" });
  });

  test("expired entries are dropped on insert: the cache does not grow per path forever", () => {
    let t = 0;
    let opens = 0;
    const read = createOperatorReader({ now: () => t });
    _setIoTapForTest({
      open: () => {
        opens += 1;
      },
    });
    const one = tempDir();
    const two = tempDir();
    read(one);
    t = 5000;
    read(two);
    // Back inside `one`'s original second: its entry is gone, so it is read again.
    t = 500;
    read(one);
    expect(opens).toBe(3);
  });

  test("each path has its own entry", () => {
    const a = harnessWith(jsonLine({ ...BASE, rev: 1 }));
    const b = harnessWith(jsonLine({ ...BASE, rev: 2 }));
    const read = createOperatorReader({ now: () => 0 });
    const ra = read(a);
    const rb = read(b);
    expect(ra.state === "present" && ra.record.rev).toBe(1);
    expect(rb.state === "present" && rb.record.rev).toBe(2);
  });
});

describe("operatorVerdict", () => {
  const present = (body: object): OperatorRead =>
    reader()(harnessWith(jsonLine({ ...BASE, ...body })));

  test("absent is open and allowed", () => {
    expect(operatorVerdict({ state: "absent" })).toEqual({
      intake: "open",
      start: "allowed",
      unreadable: false,
    });
  });

  test("no restriction set is open and allowed", () => {
    const open = { intake: "open", start: "allowed", unreadable: false };
    expect(operatorVerdict(present({}))).toEqual(open);
    expect(operatorVerdict(present({ intake: null, deployment: null }))).toEqual(open);
    expect(operatorVerdict(present({ intake: { paused: false } }))).toEqual(open);
    expect(operatorVerdict(present({ deployment: { disabled: false } }))).toEqual(open);
  });

  test("paused still allows a start", () => {
    expect(operatorVerdict(present({ intake: PAUSED }))).toEqual({
      intake: "paused",
      start: "allowed",
      unreadable: false,
    });
  });

  test("disabled refuses a start, and wins over paused", () => {
    const disabled = { intake: "disabled", start: "refused", unreadable: false };
    expect(operatorVerdict(present({ deployment: DISABLED }))).toEqual(disabled);
    expect(operatorVerdict(present({ intake: PAUSED, deployment: DISABLED }))).toEqual(disabled);
  });
});
