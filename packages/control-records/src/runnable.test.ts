import { afterAll, describe, expect, test } from "bun:test";
import { type OperatorRead, createOperatorReader } from "./operator";
import { type RunnableMode, type RunnableVerdict, assertRunnable } from "./runnable";
import {
  UNREADABLE_OPERATOR,
  controlFile,
  jsonLine,
  plant,
  removeTempDirs,
  tempDir,
} from "./test-helpers";

afterAll(removeTempDirs);

const PAUSED = { paused: true, since: "s", by: "b", cmd: "c" };
const DISABLED = { disabled: true, since: "s2", by: "b2", cmd: "c2" };

function recordRead(body: object): OperatorRead {
  return {
    state: "present",
    record: { v: 1, rev: 1, intake: null, deployment: null, desired: "running", ...body },
  };
}

const OK: RunnableVerdict = { ok: true };
const REFUSED_PAUSED: RunnableVerdict = {
  ok: false,
  exitName: "paused",
  reason: "paused",
  since: "s",
  by: "b",
  cmd: "c",
};
const REFUSED_DISABLED: RunnableVerdict = {
  ok: false,
  exitName: "disabled",
  reason: "disabled",
  since: "s2",
  by: "b2",
  cmd: "c2",
};

function check(read: OperatorRead, mode: RunnableMode, ignorePause?: boolean): RunnableVerdict {
  let calls = 0;
  const verdict = assertRunnable("/h", {
    mode,
    ...(ignorePause !== undefined ? { ignorePause } : {}),
    read: () => {
      calls += 1;
      return read;
    },
  });
  // It reads through one intake verdict, once.
  expect(calls).toBe(1);
  return verdict;
}

describe("assertRunnable, cell by cell", () => {
  const absent: OperatorRead = { state: "absent" };
  const open = recordRead({ intake: { paused: false } });
  const paused = recordRead({ intake: PAUSED });
  const disabled = recordRead({ deployment: DISABLED });
  const both = recordRead({ intake: PAUSED, deployment: DISABLED });
  const unreadable: OperatorRead = { state: "unreadable", reason: "operator.json: torn" };

  test("absent, or open: ok in every mode", () => {
    for (const read of [absent, open]) {
      for (const mode of ["interactive", "run", "start"] as const) {
        expect(check(read, mode)).toEqual(OK);
      }
    }
  });

  test("intake paused, interactive: ok", () => {
    expect(check(paused, "interactive")).toEqual(OK);
  });

  test("intake paused, run: refused as paused", () => {
    expect(check(paused, "run")).toEqual(REFUSED_PAUSED);
    expect(check(paused, "run", false)).toEqual(REFUSED_PAUSED);
  });

  test("intake paused, run with ignorePause: ok, and says the pause was ignored", () => {
    expect(check(paused, "run", true)).toEqual({ ok: true, pauseIgnored: true });
  });

  test("intake paused, start: ok", () => {
    expect(check(paused, "start")).toEqual(OK);
  });

  test("deployment disabled refuses every mode, and ignorePause changes nothing", () => {
    for (const mode of ["interactive", "run", "start"] as const) {
      expect(check(disabled, mode)).toEqual(REFUSED_DISABLED);
      expect(check(disabled, mode, true)).toEqual(REFUSED_DISABLED);
    }
  });

  test("disabled wins over paused", () => {
    for (const mode of ["interactive", "run", "start"] as const) {
      expect(check(both, mode)).toEqual(REFUSED_DISABLED);
      expect(check(both, mode, true)).toEqual(REFUSED_DISABLED);
    }
  });

  test("unreadable, interactive: ok", () => {
    expect(check(unreadable, "interactive")).toEqual(OK);
  });

  test("unreadable, run: exit paused, reason unreadable, and ignorePause does not lift it", () => {
    const refused = { ok: false, exitName: "paused", reason: "unreadable" };
    expect(check(unreadable, "run")).toEqual(refused as RunnableVerdict);
    expect(check(unreadable, "run", true)).toEqual(refused as RunnableVerdict);
  });

  test("unreadable, start: exit disabled, reason unreadable", () => {
    expect(check(unreadable, "start")).toEqual({
      ok: false,
      exitName: "disabled",
      reason: "unreadable",
    });
  });
});

describe("assertRunnable against real files", () => {
  const read = (): ((dir: string) => OperatorRead) => {
    let t = 0;
    return createOperatorReader({
      now: () => {
        t += 10_000;
        return t;
      },
    });
  };

  test("a torn file refuses a run and a start, and leaves the REPL", () => {
    const root = tempDir();
    UNREADABLE_OPERATOR["torn"]?.(root);
    expect(assertRunnable(root, { mode: "run", read: read() })).toMatchObject({
      ok: false,
      reason: "unreadable",
    });
    expect(assertRunnable(root, { mode: "start", read: read() })).toMatchObject({
      ok: false,
      exitName: "disabled",
    });
    expect(assertRunnable(root, { mode: "interactive", read: read() })).toEqual({ ok: true });
  });

  test("the default reader answers too", () => {
    const root = tempDir();
    expect(assertRunnable(root, { mode: "run" })).toEqual({ ok: true });
    plant(
      controlFile(root, "operator.json"),
      jsonLine({ v: 1, rev: 1, desired: "running", deployment: { disabled: true } }),
    );
    const other = tempDir();
    plant(
      controlFile(other, "operator.json"),
      jsonLine({ v: 1, rev: 1, desired: "running", deployment: { disabled: true } }),
    );
    expect(assertRunnable(other, { mode: "run" })).toMatchObject({
      ok: false,
      exitName: "disabled",
    });
  });
});
