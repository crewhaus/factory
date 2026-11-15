/**
 * A harness's decision log is read from that harness's own records only. With one
 * harness's `.crewhaus/sessions` a link to another's, its event stream, the overview model
 * Home's projector folds for it and the fleet log the projector writes for it carry none
 * of the other harness's decisions.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { mintRunId } from "@crewhaus/control-contract";
import { append, fleetChangesLedger, readPage, runsLedger } from "@crewhaus/control-records";
import { OVERVIEW_PROJECTION, projectOnce, readModel } from "@crewhaus/control-service";
import { approvalsLedger } from "@crewhaus/session-store";
import { bearer } from "../__test__/browser";
import { type V1Home, v1Home } from "../__test__/v1-home";

const AT = "2026-11-14T00:00:00.000Z";
const B_FIRST = "appr_00000000000000b1";
const B_SECOND = "appr_00000000000000b2";

let home: V1Home;
let a: { id: string; dir: string };
let b: { id: string; dir: string };

function park(dir: string, decision: string): void {
  const sessions = join(dir, ".crewhaus", "sessions");
  mkdirSync(sessions, { recursive: true });
  const written = append(approvalsLedger(sessions), {
    v: 1,
    at: AT,
    event: "park",
    decision,
    sessionId: "sess_00000000000000bb",
  });
  if (!written.ok) throw new Error(written.reason);
}

beforeAll(async () => {
  home = await v1Home({ streamTimings: { pollMs: 10, heartbeatMs: 60_000 } });
  a = await home.harness("linked-a");
  b = await home.harness("parked-b");
  park(b.dir, B_FIRST);
  rmSync(join(a.dir, ".crewhaus", "sessions"), { recursive: true, force: true });
  symlinkSync(join(b.dir, ".crewhaus", "sessions"), join(a.dir, ".crewhaus", "sessions"));
}, 60_000);

afterAll(async () => {
  await home?.t.stop();
});

describe.skipIf(process.platform === "win32")("a linked sessions folder", () => {
  test("the harness's stream sends its own lines and none of the other harness's decisions", async () => {
    const controller = new AbortController();
    const res = await fetch(`${home.t.base}/api/v1/harnesses/${a.id}/events`, {
      headers: bearer(home.session),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      // Give the stream a first batch from now, then write: the other harness's decision
      // first, then a run of this harness's own, so any batch that holds the run holds both.
      const opened = await reader.read();
      text += decoder.decode(opened.value, { stream: true });
      park(b.dir, B_SECOND);
      const run = mintRunId();
      const written = append(runsLedger(a.dir), {
        id: run,
        state: "queued",
        at: AT,
        trigger: { kind: "api" },
      });
      if (!written.ok) throw new Error(written.reason);
      while (!text.includes(run)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      expect(text).toContain("event: run.queued");
      expect(text).not.toContain(B_FIRST);
      expect(text).not.toContain(B_SECOND);
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
  }, 20_000); // a stream over a booted Home; slow on a loaded runner

  test("its projected overview holds no decision of the other harness, and the fleet log names none for it", async () => {
    const harnesses = [{ id: a.id, dir: a.dir }];
    const B_THIRD = "appr_00000000000000b3";
    await projectOnce({ hangarRoot: home.t.hangarRoot, harnesses, now: Date.now() });
    park(b.dir, B_THIRD);
    await projectOnce({ hangarRoot: home.t.hangarRoot, harnesses, now: Date.now() });
    // The other harness's own model holds the decision, so the fixture parks where the
    // projector reads.
    const own = readModel(home.t.hangarRoot, b.id, b.dir, OVERVIEW_PROJECTION, Date.now());
    expect(Object.keys(own.state.open)).toContain(B_THIRD);
    const model = readModel(home.t.hangarRoot, a.id, a.dir, OVERVIEW_PROJECTION, Date.now());
    expect(Object.keys(model.state.open).filter((id) => id.startsWith("appr_"))).toEqual([]);
    const lines = readPage(fleetChangesLedger(home.t.hangarRoot), { limit: 1000 }).items.map(
      (item) => item.record,
    );
    const forA = lines.filter((line) => line["harness"] === a.id);
    expect(JSON.stringify(forA)).not.toContain("appr_00000000000000b");
  });
});
