import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CHANNEL_CONVERSATION_LABEL,
  CHANNEL_MESSAGE_LABEL,
  CHANNEL_SENDER_LABEL,
  LOCAL_ACTOR_LABEL,
} from "./digest";
import { append, foldStates } from "./ledger";
import { controlPaths, runsLedger } from "./paths";
import { RUN_ROW_PAGE_LINES, appendPreparingRun, newestRunRows, settleUnstartedRun } from "./runs";
import { removeTempDirs, tempDir } from "./test-helpers";

afterAll(removeTempDirs);

const AT = "2026-11-12T10:00:00.000Z";
const HOLDER = { pid: 4242, host: "box", startedAt: "2026-11-12T09:00:00.000Z" };
const TRIGGER = { kind: "channel", via: "slack" };

function lines(root: string): Record<string, unknown>[] {
  const dir = join(root, controlPaths(root).runsDir);
  return readdirSync(dir)
    .sort()
    .flatMap((name) => readFileSync(join(dir, name), "utf8").split("\n"))
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("runsLedger", () => {
  test("the run ledger under the control directory, on the run machine", () => {
    const root = tempDir();
    expect(runsLedger(root)).toMatchObject({
      root,
      records: { dir: join(".crewhaus", "run", "control", "runs") },
      machine: "run",
    });
  });

  test("the channel labels are pins, apart from each other and from the local actor's", () => {
    expect(CHANNEL_CONVERSATION_LABEL).toBe("channel-conversation");
    expect(CHANNEL_MESSAGE_LABEL).toBe("channel-message");
    expect(CHANNEL_SENDER_LABEL).toBe("channel-sender");
    const all = [CHANNEL_CONVERSATION_LABEL, CHANNEL_MESSAGE_LABEL, CHANNEL_SENDER_LABEL];
    expect(new Set([...all, LOCAL_ACTOR_LABEL]).size).toBe(4);
  });
});

describe("appendPreparingRun", () => {
  test("queued, then preparing, for one id, folding with no anomaly", () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    expect(
      appendPreparingRun(ledger, { id: "run_a", at: AT, trigger: TRIGGER, holder: HOLDER }),
    ).toEqual({ ok: true });
    const rows = lines(root);
    expect(rows.map((r) => r["state"])).toEqual(["queued", "preparing"]);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["at", "holder", "id", "state", "trigger"]);
    }
    const fold = foldStates(ledger);
    if (!fold.ok) throw new Error(fold.reason);
    expect(fold.anomalies).toEqual([]);
    expect(fold.objects.get("run_a")?.state).toBe("preparing");
    // The runtime's `running` row folds after it.
    append(ledger, { id: "run_a", state: "running", at: AT, trigger: TRIGGER });
    const after = foldStates(ledger);
    if (!after.ok) throw new Error(after.reason);
    expect(after.anomalies).toEqual([]);
    expect(after.objects.get("run_a")?.state).toBe("running");
  });

  test("a row that is not under the bound appends nothing and answers why", () => {
    const root = tempDir();
    const answer = appendPreparingRun(runsLedger(root), {
      id: "run_b",
      at: AT,
      trigger: { kind: "channel", padding: "x".repeat(5000) },
      holder: HOLDER,
    });
    expect(answer.ok).toBe(false);
    expect(!answer.ok && answer.code).toBe("too-large");
  });
});

describe("settleUnstartedRun", () => {
  const close = { state: "cancelled" as const, at: AT, fields: { reason: "not-admitted" } };

  test("a run still preparing is closed, keeping its trigger", async () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    appendPreparingRun(ledger, { id: "run_c", at: AT, trigger: TRIGGER, holder: HOLDER });
    expect(await settleUnstartedRun(ledger, "run_c", close)).toEqual({ ok: true, settled: true });
    const last = lines(root).at(-1);
    expect(last).toEqual({
      reason: "not-admitted",
      id: "run_c",
      state: "cancelled",
      at: AT,
      trigger: TRIGGER,
    });
    const fold = foldStates(ledger);
    if (!fold.ok) throw new Error(fold.reason);
    expect(fold.anomalies).toEqual([]);
    // A second settle finds it closed, and writes nothing.
    expect(await settleUnstartedRun(ledger, "run_c", close)).toEqual({ ok: true, settled: false });
    expect(lines(root)).toHaveLength(3);
  });

  test("a run the runtime started is never written after", async () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    appendPreparingRun(ledger, { id: "run_d", at: AT, trigger: TRIGGER, holder: HOLDER });
    append(ledger, { id: "run_d", state: "running", at: AT, trigger: TRIGGER });
    expect(await settleUnstartedRun(ledger, "run_d", close)).toEqual({ ok: true, settled: false });
    expect(lines(root)).toHaveLength(3);
  });

  test("the caller's check is asked about the row, and a refusal writes nothing", async () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    appendPreparingRun(ledger, { id: "run_e", at: AT, trigger: TRIGGER, holder: HOLDER });
    const seen: unknown[] = [];
    const answer = await settleUnstartedRun(ledger, "run_e", close, (row) => {
      seen.push(row["holder"]);
      return false;
    });
    expect(answer).toEqual({ ok: true, settled: false });
    expect(seen).toEqual([HOLDER]);
    expect(lines(root)).toHaveLength(2);
  });

  test("a close the machine refuses from preparing writes nothing", async () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    appendPreparingRun(ledger, { id: "run_f", at: AT, trigger: TRIGGER, holder: HOLDER });
    const answer = await settleUnstartedRun(ledger, "run_f", {
      state: "succeeded" as never,
      at: AT,
      fields: {},
    });
    expect(answer).toEqual({ ok: true, settled: false });
    expect(lines(root)).toHaveLength(2);
  });

  test("an unknown run, and a run past the newest lines, are left as they are", async () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    expect(await settleUnstartedRun(ledger, "run_none", close)).toEqual({
      ok: true,
      settled: false,
    });
    appendPreparingRun(ledger, { id: "run_old", at: AT, trigger: TRIGGER, holder: HOLDER });
    for (let i = 0; i < RUN_ROW_PAGE_LINES; i++) {
      append(ledger, { id: `run_n${i}`, state: "queued", at: AT, trigger: TRIGGER });
    }
    expect(newestRunRows(ledger).has("run_old")).toBe(false);
    expect(await settleUnstartedRun(ledger, "run_old", close)).toEqual({
      ok: true,
      settled: false,
    });
  });
});
