/**
 * The v1 event streams over HTTP, on fixture harnesses with nothing spawned: a run's, a
 * harness's and Home's. Each resumes from `Last-Event-ID` or `?after=` with nothing
 * repeated, says what it missed, what was replaced and what it withheld, ends its
 * re-check when it ends, and closes when its caller loses access.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openAccess } from "@crewhaus/access-control";
import { decodeCursor, encodeCursor, mintId, mintRunId } from "@crewhaus/control-contract";
import { makeSeal } from "@crewhaus/control-contract/http";
import { SCHEMAS } from "@crewhaus/control-contract/schemas";
import {
  _setRollBytesForTest,
  append,
  appendFleetChanges,
  controlPaths,
  decisionsLedger,
  deploymentsLedger,
  keepFleetSegments,
  runsLedger,
} from "@crewhaus/control-records";
import { commandsLedgerOf, projectOnce } from "@crewhaus/control-service";
import {
  appendRunLedger,
  patchRunLedger,
  prunedRunsPath,
  runDir,
  runEventsPath,
} from "@crewhaus/harness-supervisor";
import { approvalsLedger } from "@crewhaus/session-store";
import { acceptInvite, bearer } from "../__test__/browser";
import { type V1Home, v1Home } from "../__test__/v1-home";

let home: V1Home;

beforeAll(async () => {
  home = await v1Home({ streamTimings: { pollMs: 10, heartbeatMs: 60_000 } });
}, 60_000);

afterAll(async () => {
  await home?.t.stop();
});

afterEach(() => _setRollBytesForTest(undefined));

const AT = "2026-11-14T00:00:00.000Z";

type Frame = { id: string; event: string; data: Record<string, unknown> };

type Feed = {
  readonly status: number;
  frames(): Frame[];
  /** Read until `predicate` holds or the stream ends; `false` on timeout. */
  until(predicate: (frames: Frame[]) => boolean, ms?: number): Promise<boolean>;
  ended(): boolean;
  close(): Promise<void>;
  body: () => Record<string, unknown>;
};

function parse(text: string): Frame[] {
  const out: Frame[] = [];
  for (const block of text.split("\n\n")) {
    let id = "";
    let event = "";
    let data: Record<string, unknown> | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith("id: ")) id = line.slice(4);
      else if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data = JSON.parse(line.slice(6));
    }
    if (event !== "" && data !== undefined) out.push({ id, event, data });
  }
  return out;
}

async function open(
  path: string,
  opts: { secret?: string; headers?: Record<string, string>; on?: V1Home } = {},
): Promise<Feed> {
  // Not `fetchRaw`, whose own timeout signal would keep the connection open past `close`.
  const controller = new AbortController();
  const res = await fetch(`${(opts.on ?? home).t.base}${path}`, {
    headers: { ...bearer(opts.secret ?? home.session), ...(opts.headers ?? {}) },
    signal: controller.signal,
  });
  let text = "";
  let ended = false;
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const body = await res.text();
    return {
      status: res.status,
      frames: () => [],
      until: async () => false,
      ended: () => true,
      close: async () => undefined,
      body: () => JSON.parse(body) as Record<string, unknown>,
    };
  }
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  return {
    status: res.status,
    frames: () => parse(text),
    ended: () => ended,
    body: () => ({}),
    async until(predicate, ms = 5000) {
      const deadline = Date.now() + ms;
      while (!predicate(parse(text))) {
        if (ended) return false;
        pending ??= reader.read();
        const timeout = new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), Math.max(1, deadline - Date.now())),
        );
        const got = await Promise.race([pending, timeout]);
        if (got === "timeout") return false;
        pending = undefined;
        if (got.done) {
          ended = true;
          return predicate(parse(text));
        }
        text += decoder.decode(got.value, { stream: true });
      }
      return true;
    },
    async close() {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    },
  };
}

const events = (frames: Frame[]) => frames.map((f) => f.event);
const states = (frames: Frame[]) =>
  frames
    .filter((f) => f.event.startsWith("run.") && f.event !== "run.trace")
    .map((f) => (f.data["payload"] as Record<string, unknown>)["state"]);

async function settled(predicate: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

function row(dir: string, id: string, state: string, more: Record<string, unknown> = {}): void {
  const written = append(runsLedger(dir), { id, state, at: AT, trigger: { kind: "api" }, ...more });
  if (!written.ok) throw new Error(written.reason);
}

function traceLine(dir: string, execution: string, line: Record<string, unknown> | string): void {
  mkdirSync(join(runDir(dir), "logs"), { recursive: true });
  appendFileSync(
    runEventsPath(dir, execution),
    typeof line === "string" ? line : `${JSON.stringify(line)}\n`,
  );
}

function everyFrameParses(frames: Frame[]): void {
  for (const frame of frames) {
    const parsed = SCHEMAS.eventFrame.safeParse(frame);
    if (!parsed.success) throw new Error(`${frame.event}: ${parsed.error.message}`);
    expect(frame.data["id"]).toBe(frame.id);
  }
}

// ---------------------------------------------------------------------------

describe("a run's stream", () => {
  test("its rows, then its trace, and it ends once the run has ended", async () => {
    const h = await home.harness("run-stream");
    const run = mintRunId();
    const execution = "run_00000000000000a1";
    row(h.dir, run, "queued");
    row(h.dir, run, "running", { execution });
    traceLine(h.dir, execution, { kind: "turn_start", runId: run, timestamp: AT });
    traceLine(h.dir, execution, { kind: "turn_start", runId: mintRunId(), timestamp: AT });
    row(h.dir, run, "succeeded", { execution });
    row(h.dir, mintRunId(), "running");
    const feed = await open(`/api/v1/runs/${run}/events`);
    expect(feed.status).toBe(200);
    await feed.until(() => false, 3000);
    expect(feed.ended()).toBe(true);
    const frames = feed.frames();
    expect(states(frames)).toEqual(["queued", "running", "succeeded"]);
    // The trace line of another run in the same file is read past.
    expect(frames.filter((f) => f.event === "run.trace")).toHaveLength(1);
    expect(frames.find((f) => f.event === "run.trace")?.data["payload"]).toEqual({
      traceKind: "turn_start",
    });
    everyFrameParses(frames);
  });

  test("resumed with Last-Event-ID, or ?after=, it sends the rest and nothing twice", async () => {
    const h = await home.harness("run-resume");
    const run = mintRunId();
    for (const state of ["queued", "preparing", "running"]) row(h.dir, run, state);
    const first = await open(`/api/v1/runs/${run}/events`);
    await first.until((f) => f.length >= 3);
    await first.close();
    const last = first.frames()[2]?.id as string;
    row(h.dir, run, "waiting-for-approval");
    row(h.dir, run, "failed");
    for (const how of ["header", "query"] as const) {
      const feed = await open(
        how === "header"
          ? `/api/v1/runs/${run}/events`
          : `/api/v1/runs/${run}/events?after=${last}`,
        how === "header" ? { headers: { "last-event-id": last } } : {},
      );
      await feed.until(() => false, 2000);
      expect([how, states(feed.frames())]).toEqual([how, ["waiting-for-approval", "failed"]]);
      expect(feed.ended()).toBe(true);
    }
  });

  test("a client gone after the 2nd frame of a 5-line batch resumes at the 3rd, each once", async () => {
    const h = await home.harness("run-mid-batch");
    const run = mintRunId();
    const five = ["queued", "preparing", "running", "waiting-for-input", "running"];
    for (const state of five) row(h.dir, run, state);
    const first = await open(`/api/v1/runs/${run}/events`);
    await first.until((f) => f.length >= 2);
    await first.close();
    const second = first.frames()[1]?.id as string;
    const resumed = await open(`/api/v1/runs/${run}/events`, {
      headers: { "last-event-id": second },
    });
    await resumed.until((f) => f.length >= 3);
    await resumed.close();
    expect(states(resumed.frames()).slice(0, 3)).toEqual(five.slice(2));
    expect(resumed.frames()).toHaveLength(3);
  });

  test("two cursors that differ, a garbage cursor, and one of another kind are 400 cursor", async () => {
    const h = await home.harness("run-cursor");
    const run = mintRunId();
    row(h.dir, run, "running");
    const a = encodeCursor({
      v: 1,
      kind: "vector",
      sources: { rows: [{ seg: 0, off: 0, tail: "" }] },
    });
    const b = encodeCursor({
      v: 1,
      kind: "vector",
      sources: { rows: [{ seg: 1, off: 0, tail: "" }] },
    });
    const fleet = encodeCursor({ v: 1, kind: "fleet", epoch: 1, seq: 1 });
    for (const [path, headers] of [
      [`/api/v1/runs/${run}/events?after=${a}`, { "last-event-id": b }],
      [`/api/v1/runs/${run}/events?after=garbage`, {}],
      [`/api/v1/runs/${run}/events?after=${fleet}`, {}],
      [`/api/v1/runs/${run}/events`, { "last-event-id": "nope" }],
    ] as const) {
      const res = await home.call("GET", path, { headers });
      expect([path, res.status]).toEqual([path, 400]);
      const error = res.body["error"] as Record<string, unknown>;
      expect(error["reason"]).toBe("cursor");
    }
    // The same cursor twice is one cursor.
    const same = await open(`/api/v1/runs/${run}/events?after=${a}`, {
      headers: { "last-event-id": a },
    });
    expect(same.status).toBe(200);
    await same.close();
  });

  test("a torn last line waits, and is sent once it is whole; a malformed one is a gap and the stream goes on", async () => {
    const h = await home.harness("run-torn");
    const run = mintRunId();
    row(h.dir, run, "queued");
    const seg = join(h.dir, controlPaths(h.dir).runsDir, "000001.jsonl");
    appendFileSync(seg, "not json\n");
    const whole = JSON.stringify({ id: run, state: "running", at: AT, trigger: { kind: "api" } });
    appendFileSync(seg, whole.slice(0, 20));
    const feed = await open(`/api/v1/runs/${run}/events`);
    await feed.until((f) => f.length >= 2);
    expect(events(feed.frames())).toEqual(["run.queued", "stream.gap"]);
    expect(feed.frames()[1]?.data["payload"]).toEqual({ reason: "unreadable", source: "rows" });
    appendFileSync(seg, `${whole.slice(20)}\n`);
    await feed.until((f) => f.length >= 3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await feed.close();
    expect(events(feed.frames())).toEqual(["run.queued", "stream.gap", "run.started"]);
  });

  test("a file replaced under the cursor answers stream.reset diverged, with where it now starts", async () => {
    const h = await home.harness("run-reset");
    const run = mintRunId();
    row(h.dir, run, "queued");
    row(h.dir, run, "running");
    const first = await open(`/api/v1/runs/${run}/events`);
    await first.until((f) => f.length >= 2);
    await first.close();
    const seg = join(h.dir, controlPaths(h.dir).runsDir, "000001.jsonl");
    writeFileSync(seg, `${JSON.stringify({ id: run, state: "cancelled", at: AT })}\n`);
    const feed = await open(`/api/v1/runs/${run}/events`, {
      headers: { "last-event-id": first.frames()[1]?.id as string },
    });
    await feed.until(() => false, 2000);
    expect(events(feed.frames())).toEqual(["stream.reset", "run.cancelled"]);
    const payload = feed.frames()[0]?.data["payload"] as Record<string, unknown>;
    expect(payload["reason"]).toBe("diverged");
    const earliest = decodeCursor(payload["earliest"]);
    expect(earliest.ok && earliest.cursor.kind).toBe("vector");
    everyFrameParses(feed.frames());
  });

  test("a line landing in the previous segment after a roll is delivered", async () => {
    _setRollBytesForTest(1);
    const h = await home.harness("run-roll");
    const run = mintRunId();
    row(h.dir, run, "queued"); // segment 1
    row(h.dir, run, "preparing"); // segment 2
    const feed = await open(`/api/v1/runs/${run}/events`);
    await feed.until((f) => f.length >= 2);
    // A late appender still holds segment 1.
    appendFileSync(
      join(h.dir, controlPaths(h.dir).runsDir, "000001.jsonl"),
      `${JSON.stringify({ id: run, state: "running", at: AT })}\n`,
    );
    await feed.until((f) => f.length >= 3);
    await feed.close();
    expect(states(feed.frames())).toEqual(["queued", "preparing", "running"]);
  });

  test("a run with no trace and no session says so; a caller without content reads no trace", async () => {
    const h = await home.harness("run-no-trace");
    const bare = mintRunId();
    row(h.dir, bare, "running");
    const feed = await open(`/api/v1/runs/${bare}/events`);
    await feed.until((f) => f.length >= 1);
    await feed.close();
    expect(feed.frames()[0]?.data["payload"]).toEqual({ state: "running", trace: false });

    const traced = mintRunId();
    const execution = "run_00000000000000b2";
    row(h.dir, traced, "running", { execution });
    traceLine(h.dir, execution, { kind: "turn_start", runId: traced, timestamp: AT });
    row(h.dir, traced, "succeeded");
    const viewer = await home.service("reader-no-content", [h.id]);
    const plain = await open(`/api/v1/runs/${traced}/events`, { secret: viewer.secret });
    await plain.until(() => false, 2000);
    expect(events(plain.frames())).toEqual(["run.started", "run.succeeded"]);
    const reader = await home.service("reader-content", [h.id], { contentRead: true });
    const full = await open(`/api/v1/runs/${traced}/events`, { secret: reader.secret });
    await full.until(() => false, 2000);
    expect(events(full.frames())).toEqual(["run.started", "run.succeeded", "run.trace"]);
  });

  test("a row naming a person's records arrives as the withheld gap, with nothing of the row", async () => {
    const h = await home.harness("run-people");
    const run = mintRunId();
    row(h.dir, run, "running");
    row(h.dir, run, "succeeded", { peopleProjection: [`home/person/${mintId("psn")}`] });
    const feed = await open(`/api/v1/runs/${run}/events`);
    await feed.until(() => false, 2000);
    const frames = feed.frames();
    expect(events(frames)).toEqual(["run.started", "stream.gap"]);
    expect(frames[1]?.data).toMatchObject({
      type: "stream.gap",
      sensitivity: "internal",
      payload: { reason: "withheld", hidden: ["people"] },
    });
    expect(frames[1]?.data["run"]).toBeUndefined();
    expect(frames[1]?.data["harness"]).toBeUndefined();
    everyFrameParses(frames);
  });

  test("a later row naming another execution pauses the stream; the reconnect reads that trace", async () => {
    const h = await home.harness("run-moves");
    const run = mintRunId();
    const one = "run_00000000000000c1";
    const two = "run_00000000000000c2";
    row(h.dir, run, "running", { execution: one });
    traceLine(h.dir, one, { kind: "a", runId: run, timestamp: AT });
    const feed = await open(`/api/v1/runs/${run}/events`);
    await feed.until((f) => f.length >= 2);
    row(h.dir, run, "running", { execution: two });
    traceLine(h.dir, two, { kind: "b", runId: run, timestamp: AT });
    await feed.until(() => false, 2000);
    const pause = feed.frames().at(-1);
    expect(pause?.event).toBe("stream.pause");
    const resumeFrom = (pause?.data["payload"] as Record<string, unknown>)["resumeFrom"] as string;
    expect((pause?.data["payload"] as Record<string, unknown>)["reason"]).toBe("execution");
    row(h.dir, run, "succeeded");
    const again = await open(`/api/v1/runs/${run}/events`, {
      headers: { "last-event-id": resumeFrom },
    });
    await again.until(() => false, 2000);
    const traces = again
      .frames()
      .filter((f) => f.event === "run.trace")
      .map((f) => (f.data["payload"] as Record<string, unknown>)["traceKind"]);
    expect(traces).toEqual(["b"]);
    expect(states(again.frames())).toEqual(["succeeded"]);
  });
});

describe("a supervisor execution's stream", () => {
  function execution(dir: string): string {
    const runId = `run_${Math.random().toString(16).slice(2, 10).padEnd(16, "0")}`;
    appendRunLedger(dir, {
      runId,
      kind: "daemon",
      argv: ["crewhaus", "run", "--secret-flag"],
      startedAt: AT,
      logFile: `logs/${runId}.log`,
    });
    return runId;
  }

  test("its ledger lines are run.started and run.succeeded, with no argv or log path", async () => {
    const h = await home.harness("exec-stream");
    const id = execution(h.dir);
    patchRunLedger(h.dir, { runId: id, sessionId: "sess_00000000000000aa" });
    patchRunLedger(h.dir, { runId: id, endedAt: AT, exitCode: 0 });
    traceLine(h.dir, id, { kind: "turn_end", runId: id, timestamp: AT, ingestedAt: AT });
    const feed = await open(`/api/v1/runs/${id}/events`);
    await feed.until(() => false, 2000);
    expect(events(feed.frames())).toEqual(["run.started", "run.succeeded", "run.trace"]);
    expect(feed.frames()[1]?.data["payload"]).toEqual({ exitCode: 0 });
    expect(JSON.stringify(feed.frames())).not.toContain("secret-flag");
    expect(JSON.stringify(feed.frames())).not.toContain(".log");
    everyFrameParses(feed.frames());
  });

  test("one whose files retention removed says so once, before its rows", async () => {
    const h = await home.harness("exec-pruned");
    const id = execution(h.dir);
    patchRunLedger(h.dir, { runId: id, endedAt: AT, exitCode: 1 });
    writeFileSync(prunedRunsPath(h.dir), `${JSON.stringify({ v: 1, at: AT, runs: [id] })}\n`);
    const feed = await open(`/api/v1/runs/${id}/events`);
    await feed.until(() => false, 2000);
    expect(events(feed.frames())).toEqual(["stream.gap", "run.started", "run.failed"]);
    expect(feed.frames()[0]?.data["payload"]).toEqual({ reason: "evicted" });
  });

  test("an execution id reaches only the stream: the other run operations answer run_unknown", async () => {
    const h = await home.harness("exec-only-stream");
    const id = execution(h.dir);
    for (const [method, path] of [
      ["GET", `/api/v1/runs/${id}`],
      ["GET", `/api/v1/runs/${id}/result`],
      ["POST", `/api/v1/runs/${id}/cancel`],
    ] as const) {
      const res = await home.call(method, path, method === "POST" ? { body: {} } : {});
      expect([
        path,
        res.status,
        (res.body["error"] as Record<string, unknown>)?.["reason"],
      ]).toEqual([path, 404, "run_unknown"]);
    }
    const unknown = await home.call("GET", "/api/v1/runs/run_ffffffffffff0000/events");
    expect(unknown.status).toBe(404);
  });
});

describe("a harness's stream", () => {
  test("one frame per line, from all five core sources in one vector beside the work records' and the inbox's, from now", async () => {
    const h = await home.harness("harness-stream");
    row(h.dir, mintRunId(), "running"); // before the stream: not sent
    const feed = await open(`/api/v1/harnesses/${h.id}/events`);
    await feed.until(() => false, 300);
    expect(feed.frames()).toEqual([]);
    const run = mintRunId();
    row(h.dir, run, "queued");
    append(commandsLedgerOf(h.dir), {
      id: mintId("cmd"),
      v: 1,
      kind: "controls.pause",
      state: "accepted",
      acceptedAt: AT,
      target: `home/harness/${h.id}`,
    });
    append(deploymentsLedger(h.dir), { id: mintId("dep"), state: "prepared", at: AT });
    append(decisionsLedger(h.dir), { id: mintId("dec"), state: "pending", at: AT });
    mkdirSync(join(h.dir, ".crewhaus", "sessions"), { recursive: true });
    append(approvalsLedger(join(h.dir, ".crewhaus", "sessions")), {
      v: 1,
      at: AT,
      event: "park",
      decision: "appr_00000000000000aa",
      sessionId: "sess_00000000000000aa",
    });
    await feed.until((f) => f.length >= 5);
    await feed.close();
    const frames = feed.frames();
    expect(events(frames).sort()).toEqual(
      [
        "command.accepted",
        "decision.opened",
        "decision.opened",
        "deployment.prepared",
        "run.queued",
      ].sort(),
    );
    for (const frame of frames) expect(frame.data["harness"]).toBe(h.id);
    const last = decodeCursor(frames.at(-1)?.id);
    expect(
      last.ok && last.cursor.kind === "vector" && Object.keys(last.cursor.sources).sort(),
    ).toEqual([
      "approvals",
      "attention",
      "commands",
      "decisions",
      "deployments",
      "outcomes",
      "publish",
      "runs",
      "work",
      "workspaces",
    ]);
    everyFrameParses(frames);
  });
});

describe("Home's stream", () => {
  async function change(harness: string, type = "harness.paused") {
    const done = await appendFleetChanges(home.t.hangarRoot, [
      { v: 1, type, at: AT, ingestedAt: AT, harness, sensitivity: "internal" },
    ]);
    if (!done.ok) throw new Error(done.reason);
    return done;
  }

  test("a frame about a harness the caller cannot read is not sent; a grant arriving mid-stream lets the next through", async () => {
    const x = await home.harness("fleet-x");
    const y = await home.harness("fleet-y");
    await change(x.id);
    const member = await home.member("Fern", "viewer", { scope: `harness:${y.id}` });
    const feed = await open("/api/v1/events", { secret: member.secret });
    expect(feed.status).toBe(200);
    await change(x.id, "harness.resumed");
    await change(y.id, "harness.disabled");
    await feed.until((f) => f.length >= 1);
    const granted = await openAccess(home.t.hangarRoot).grant(
      { principal: home.owner },
      { member: member.principal, role: "viewer", scope: `harness:${x.id}` },
    );
    if (!granted.ok) throw new Error(granted.reason);
    await change(x.id, "harness.enabled");
    await feed.until((f) => f.length >= 2);
    await feed.close();
    expect(feed.frames().map((f) => [f.event, f.data["harness"]])).toEqual([
      ["harness.disabled", y.id],
      ["harness.enabled", x.id],
    ]);
    everyFrameParses(feed.frames());
  });

  test("after cache/index is deleted, a reconnect answers stream.reset epoch and reads the new log", async () => {
    const h = await home.harness("fleet-epoch");
    const done = await change(h.id);
    const old = encodeCursor({ v: 1, kind: "fleet", epoch: done.epoch, seq: done.seq });
    rmSync(join(home.t.hangarRoot, "cache", "index"), { recursive: true, force: true });
    const feed = await open("/api/v1/events", { headers: { "last-event-id": old } });
    await change(h.id, "harness.resumed");
    await feed.until((f) => f.length >= 2);
    await feed.close();
    expect(events(feed.frames())).toEqual(["stream.reset", "harness.resumed"]);
    expect(feed.frames()[0]?.data["payload"]).toEqual({ reason: "epoch" });
  });

  test("a seq below what retention kept is a gap, then the oldest kept", async () => {
    _setRollBytesForTest(1);
    const h = await home.harness("fleet-evicted");
    rmSync(join(home.t.hangarRoot, "cache", "index"), { recursive: true, force: true });
    const first = await change(h.id);
    for (let i = 0; i < 4; i++) await change(h.id, "harness.resumed");
    const kept = await keepFleetSegments(home.t.hangarRoot, 2);
    expect(kept.ok).toBe(true);
    const from = encodeCursor({ v: 1, kind: "fleet", epoch: first.epoch, seq: 1 });
    const feed = await open("/api/v1/events", { headers: { "last-event-id": from } });
    await feed.until((f) => f.length >= 3);
    await feed.close();
    expect(events(feed.frames())).toEqual(["stream.gap", "harness.resumed", "harness.resumed"]);
    expect(feed.frames()[0]?.data["payload"]).toEqual({ reason: "evicted" });
    const seqs = feed
      .frames()
      .slice(1)
      .map((f) => {
        const c = decodeCursor(f.id);
        return c.ok && c.cursor.kind === "fleet" ? c.cursor.seq : -1;
      });
    expect(seqs).toEqual([4, 5]);
  });

  test("the projector's own pass feeds it", async () => {
    const h = await home.harness("fleet-projector");
    const harnesses = [{ id: h.id, dir: h.dir }];
    await projectOnce({ hangarRoot: home.t.hangarRoot, harnesses, now: Date.now() });
    const feed = await open("/api/v1/events");
    row(h.dir, mintRunId(), "running");
    await projectOnce({ hangarRoot: home.t.hangarRoot, harnesses, now: Date.now() });
    await feed.until((f) => f.some((frame) => frame.data["harness"] === h.id));
    await feed.close();
    const mine = feed.frames().filter((f) => f.data["harness"] === h.id);
    expect(events(mine)).toEqual(["run.started"]);
  });
});

describe("a stream ends its re-check, and closes when its caller loses access", () => {
  test("each of the three streams, opened and closed, leaves no check; a later access change checks nothing for it", async () => {
    const h = await home.harness("checks");
    const run = mintRunId();
    row(h.dir, run, "running");
    for (const path of [
      `/api/v1/runs/${run}/events`,
      `/api/v1/harnesses/${h.id}/events`,
      "/api/v1/events",
    ]) {
      const before = home.t.server.openStreamChecks();
      const feed = await open(path);
      expect(feed.status).toBe(200);
      expect(await settled(() => home.t.server.openStreamChecks() === before + 1)).toBe(true);
      await feed.close();
      expect([path, await settled(() => home.t.server.openStreamChecks() === before)]).toEqual([
        path,
        true,
      ]);
      // An access-record change re-checks the open streams only.
      const moved = await openAccess(home.t.hangarRoot).grant(
        { principal: home.owner },
        { member: `Gus ${path.length}`, create: true, role: "viewer", scope: "home" },
      );
      if (!moved.ok) throw new Error(moved.reason);
      home.t.server.checkSessions();
      expect(home.t.server.openStreamChecks()).toBe(before);
    }
  });

  test("a run stream that ends on its own leaves no check either", async () => {
    const h = await home.harness("checks-end");
    const run = mintRunId();
    row(h.dir, run, "succeeded");
    const before = home.t.server.openStreamChecks();
    const feed = await open(`/api/v1/runs/${run}/events`);
    await feed.until(() => false, 2000);
    expect(feed.ended()).toBe(true);
    expect(await settled(() => home.t.server.openStreamChecks() === before)).toBe(true);
  });

  test("a member who loses h.read on the harness, and keeps it on another, is closed with auth.revoked", async () => {
    const x = await home.harness("revoke-x");
    const y = await home.harness("revoke-y");
    const member = await home.member("Hal", "viewer", { scope: `harness:${x.id}` });
    const access = openAccess(home.t.hangarRoot);
    const onY = await access.grant(
      { principal: home.owner },
      { member: member.principal, role: "viewer", scope: `harness:${y.id}` },
    );
    if (!onY.ok) throw new Error(onY.reason);
    const feed = await open(`/api/v1/harnesses/${x.id}/events`, { secret: member.secret });
    expect(feed.status).toBe(200);
    // A re-check with nothing moved closes nothing.
    home.t.server.checkSessions();
    await feed.until(() => false, 200);
    expect(feed.ended()).toBe(false);
    const read = (await import("@crewhaus/access-control")).loadAccessSnapshot(home.t.hangarRoot);
    if (read.state !== "present") throw new Error("no access records");
    const grant = read.snapshot.grants.find(
      (g) => g.principal === member.principal && g.scope === `harness:${x.id}`,
    );
    const revoked = await access.revoke({ principal: home.owner }, grant?.id as string);
    if (!revoked.ok) throw new Error(revoked.reason);
    home.t.server.checkSessions();
    await feed.until((f) => f.some((frame) => frame.event === "auth.revoked"));
    expect(events(feed.frames())).toEqual(["auth.revoked"]);
    await feed.until(() => false, 1000);
    expect(feed.ended()).toBe(true);
  });

  test("a member who loses h.read is closed with auth.revoked at the next batch, and is sent nothing written after", async () => {
    const x = await home.harness("batch-x");
    const member = await home.member("Bea", "viewer", { scope: `harness:${x.id}` });
    const feed = await open(`/api/v1/harnesses/${x.id}/events`, { secret: member.secret });
    expect(feed.status).toBe(200);
    expect(await settled(() => home.t.server.openStreamChecks() > 0)).toBe(true);
    const access = openAccess(home.t.hangarRoot);
    const read = (await import("@crewhaus/access-control")).loadAccessSnapshot(home.t.hangarRoot);
    if (read.state !== "present") throw new Error("no access records");
    const grant = read.snapshot.grants.find(
      (g) => g.principal === member.principal && g.scope === `harness:${x.id}`,
    );
    // Revoked through the library alone: no request reaches Home and no periodic check runs
    // before the stream's own next batch decides.
    const revoked = await access.revoke({ principal: home.owner }, grant?.id as string);
    if (!revoked.ok) throw new Error(revoked.reason);
    const run = mintRunId();
    row(x.dir, run, "queued");
    expect(await feed.until((f) => f.some((frame) => frame.event === "auth.revoked"))).toBe(true);
    await feed.until(() => false, 1000);
    expect(feed.ended()).toBe(true);
    expect(events(feed.frames())).toEqual(["auth.revoked"]);
    expect(JSON.stringify(feed.frames())).not.toContain(run);
  });

  test("a scoped token's run stream closes with auth.expired at the next batch past its end, and is sent nothing written after", async () => {
    let clock = Date.now();
    const own = await v1Home({
      now: () => clock,
      streamTimings: { pollMs: 10, heartbeatMs: 60_000 },
    });
    try {
      const h = await own.harness("scoped-expiry");
      const run = mintRunId();
      row(h.dir, run, "running");
      const service = await own.service("expiry-portal", [h.id], { contentRead: true });
      const pair = await makeSeal();
      const minted = await own.call("POST", "/api/v1/access/scoped-tokens", {
        body: {
          refs: [`${h.id}/run/${run}`],
          acts: ["run.events.read"],
          ttlSeconds: 300,
          seal: pair.seal,
        },
        secret: service.secret,
      });
      expect(minted.status).toBe(200);
      const token = await pair.open(minted.body["issued"], "access.scopedTokens.mint");
      const feed = await open(`/api/v1/runs/${run}/events`, { secret: token, on: own });
      expect(feed.status).toBe(200);
      expect(await feed.until((f) => f.some((frame) => frame.event === "run.started"))).toBe(true);
      clock += 600_000;
      row(h.dir, run, "succeeded");
      expect(await feed.until((f) => f.some((frame) => frame.event === "auth.expired"))).toBe(true);
      await feed.until(() => false, 1000);
      expect(feed.ended()).toBe(true);
      expect(events(feed.frames())).toEqual(["run.started", "auth.expired"]);
    } finally {
      await own.t.stop();
    }
  }, 30_000); // a Home of its own, a service token and a stream; slow on a loaded runner

  test("a session that signs out closes its open stream with auth.revoked", async () => {
    const h = await home.harness("revoke-session");
    const invite = await openAccess(home.t.hangarRoot).createInvite(
      { principal: home.owner },
      { role: "viewer", scope: `harness:${h.id}` },
    );
    if (!invite.ok) throw new Error(invite.reason);
    const member = await acceptInvite(home.t.fetchRaw, invite.result.code, "Jo");
    const feed = await open(`/api/v1/harnesses/${h.id}/events`, { secret: member.session });
    expect(feed.status).toBe(200);
    const out = await home.call("POST", "/api/v1/auth/sign-out", {
      body: {},
      secret: member.session,
    });
    expect(out.status).toBe(200);
    await feed.until((f) => f.some((frame) => frame.event === "auth.revoked"));
    expect(events(feed.frames())).toEqual(["auth.revoked"]);
    await feed.until(() => false, 1000);
    expect(feed.ended()).toBe(true);
  });

  test("a revoked token's open stream closes with auth.revoked", async () => {
    const h = await home.harness("revoke-token");
    const member = await home.member("Ivy", "viewer", { scope: `harness:${h.id}` });
    const feed = await open(`/api/v1/harnesses/${h.id}/events`, { secret: member.secret });
    expect(feed.status).toBe(200);
    const revoked = await openAccess(home.t.hangarRoot).revoke(
      { principal: home.owner },
      member.credential,
    );
    if (!revoked.ok) throw new Error(revoked.reason);
    home.t.server.checkSessions();
    await feed.until((f) => f.some((frame) => frame.event === "auth.revoked"));
    await feed.until(() => false, 1000);
    expect(feed.ended()).toBe(true);
  });
});

// ---------------------------------------------------------------------------

const traceKinds = (frames: Frame[]) =>
  frames
    .filter((f) => f.event === "run.trace")
    .map((f) => (f.data["payload"] as Record<string, unknown>)["traceKind"]);

const pauseOf = (frames: Frame[]): string => {
  const pause = frames.at(-1);
  expect(pause?.event).toBe("stream.pause");
  return (pause?.data["payload"] as Record<string, unknown>)["resumeFrom"] as string;
};

describe("a stream over a run that has ended ends wherever it resumes", () => {
  test("resumed from the terminal frame's id, a run's stream ends with nothing more", async () => {
    const h = await home.harness("ended-resume");
    const run = mintRunId();
    row(h.dir, run, "queued");
    row(h.dir, run, "succeeded");
    const first = await open(`/api/v1/runs/${run}/events`);
    await first.until(() => false, 2000);
    expect(first.ended()).toBe(true);
    const terminal = first.frames().find((f) => f.event === "run.succeeded")?.id as string;
    expect(terminal).toBeDefined();
    const again = await open(`/api/v1/runs/${run}/events`, {
      headers: { "last-event-id": terminal },
    });
    await again.until(() => false, 2000);
    expect(again.ended()).toBe(true);
    expect(again.frames()).toEqual([]);
  });

  test("resumed from an ended execution's terminal frame, it sends the trace left and ends", async () => {
    const h = await home.harness("ended-exec-resume");
    const id = `run_${"e".repeat(8)}${"0".repeat(7)}1`;
    appendRunLedger(h.dir, {
      runId: id,
      kind: "daemon",
      argv: ["crewhaus", "run"],
      startedAt: AT,
      logFile: `logs/${id}.log`,
    });
    patchRunLedger(h.dir, { runId: id, endedAt: AT, exitCode: 0 });
    traceLine(h.dir, id, { kind: "turn_end", runId: id, timestamp: AT, ingestedAt: AT });
    const first = await open(`/api/v1/runs/${id}/events`);
    await first.until(() => false, 2000);
    expect(first.ended()).toBe(true);
    const terminal = first.frames().find((f) => f.event === "run.succeeded")?.id as string;
    const again = await open(`/api/v1/runs/${id}/events`, {
      headers: { "last-event-id": terminal },
    });
    await again.until(() => false, 2000);
    expect(again.ended()).toBe(true);
    expect(events(again.frames())).toEqual(["run.trace"]);
  });

  test("an execution only the prune record names says what was removed, and ends", async () => {
    const h = await home.harness("pruned-only");
    const id = `run_${"f".repeat(8)}${"0".repeat(7)}2`;
    mkdirSync(runDir(h.dir), { recursive: true });
    writeFileSync(prunedRunsPath(h.dir), `${JSON.stringify({ v: 1, at: AT, runs: [id] })}\n`);
    const feed = await open(`/api/v1/runs/${id}/events`);
    expect(feed.status).toBe(200);
    await feed.until(() => false, 2000);
    expect(feed.ended()).toBe(true);
    expect(events(feed.frames())).toEqual(["stream.gap"]);
  });
});

describe("a run that moves to another execution", () => {
  test("the old trace's last lines are sent before the stream pauses for the new one", async () => {
    const h = await home.harness("move-drain");
    const run = mintRunId();
    const one = "run_00000000000000d1";
    const two = "run_00000000000000d2";
    row(h.dir, run, "running", { execution: one });
    traceLine(h.dir, one, { kind: "a", runId: run, timestamp: AT });
    const feed = await open(`/api/v1/runs/${run}/events`);
    await feed.until((f) => f.length >= 2);
    // The old execution's last line and the row naming the new one land together.
    traceLine(h.dir, one, { kind: "a-tail", runId: run, timestamp: AT });
    row(h.dir, run, "running", { execution: two });
    traceLine(h.dir, two, { kind: "b", runId: run, timestamp: AT });
    await feed.until(() => false, 2000);
    const resumeFrom = pauseOf(feed.frames());
    row(h.dir, run, "succeeded");
    const again = await open(`/api/v1/runs/${run}/events`, {
      headers: { "last-event-id": resumeFrom },
    });
    await again.until(() => false, 2000);
    expect(again.ended()).toBe(true);
    const all = [...feed.frames(), ...again.frames()];
    expect(traceKinds(all)).toEqual(["a", "a-tail", "b"]);
    expect(states(all)).toEqual(["running", "running", "succeeded"]);
    expect(events(all)).not.toContain("stream.gap");
    everyFrameParses(all.filter((f) => f.event !== "stream.pause"));
  });

  test("a client away while the run moved reads the old trace past its cursor, then the new one", async () => {
    const h = await home.harness("move-away");
    const run = mintRunId();
    const one = "run_00000000000000e1";
    const two = "run_00000000000000e2";
    row(h.dir, run, "running", { execution: one });
    traceLine(h.dir, one, { kind: "a1", runId: run, timestamp: AT });
    const first = await open(`/api/v1/runs/${run}/events`);
    await first.until((f) => f.length >= 2);
    await first.close();
    const last = first.frames().at(-1)?.id as string;
    // While it is away: one more line of the old trace, a park, and a resume elsewhere.
    traceLine(h.dir, one, { kind: "a2-missed", runId: run, timestamp: AT });
    row(h.dir, run, "waiting-for-approval");
    row(h.dir, run, "running", { execution: two });
    traceLine(h.dir, two, { kind: "b1", runId: run, timestamp: AT });
    row(h.dir, run, "succeeded");
    const back = await open(`/api/v1/runs/${run}/events`, { headers: { "last-event-id": last } });
    await back.until(() => false, 2000);
    const resumeFrom = pauseOf(back.frames());
    const again = await open(`/api/v1/runs/${run}/events`, {
      headers: { "last-event-id": resumeFrom },
    });
    await again.until(() => false, 2000);
    expect(again.ended()).toBe(true);
    const after = [...back.frames(), ...again.frames()];
    expect(traceKinds(after)).toEqual(["a2-missed", "b1"]);
    expect(states(after)).toEqual(["waiting-for-approval", "running", "succeeded"]);
    expect(events(after)).not.toContain("stream.gap");
  });
});

describe("a run that moves away from a trace that cannot be read", () => {
  test("says so once and pauses for the new execution, without waiting on it", async () => {
    const h = await home.harness("move-unreadable");
    const run = mintRunId();
    const one = "run_00000000000000d3";
    const two = "run_00000000000000d4";
    row(h.dir, run, "running", { execution: one });
    // A directory where the old trace file would be: it can never be opened.
    mkdirSync(runEventsPath(h.dir, one), { recursive: true });
    row(h.dir, run, "running", { execution: two });
    traceLine(h.dir, two, { kind: "b", runId: run, timestamp: AT });
    // A fresh open reads the newest execution: resume from the first row's frame instead.
    const first = await open(`/api/v1/runs/${run}/events`, {});
    await first.until((f) => f.length >= 1);
    await first.close();
    const cursor = decodeCursor(first.frames()[0]?.id);
    if (!cursor.ok || cursor.cursor.kind !== "vector") throw new Error("no vector cursor");
    const rowsOnly = encodeCursor({
      v: 1,
      kind: "vector",
      sources: { rows: cursor.cursor.sources.rows ?? [] },
    });
    const back = await open(`/api/v1/runs/${run}/events`, {
      headers: { "last-event-id": rowsOnly },
    });
    expect(await back.until((f) => f.at(-1)?.event === "stream.pause", 2000)).toBe(true);
    const gaps = back.frames().filter((f) => f.event === "stream.gap");
    expect(gaps).toHaveLength(1);
    expect(states(back.frames())).toEqual(["running"]);
  });
});

describe("an execution's prune record is read contained and bounded", () => {
  test("a linked prune record names no execution: its stream answers run_unknown", async () => {
    const h = await home.harness("prune-link");
    const id = "run_00000000000000f3";
    const outside = join(home.t.harnessesRoot, "prune-link-elsewhere.jsonl");
    writeFileSync(outside, `${JSON.stringify({ v: 1, at: AT, runs: [id] })}\n`);
    mkdirSync(runDir(h.dir), { recursive: true });
    symlinkSync(outside, prunedRunsPath(h.dir));
    const res = await home.call("GET", `/api/v1/runs/${id}/events?harness=${h.id}`);
    expect([res.status, (res.body["error"] as Record<string, unknown>)?.["reason"]]).toEqual([
      404,
      "run_unknown",
    ]);
  });

  test("a prune older than the lines read names no execution", async () => {
    const h = await home.harness("prune-long");
    const id = "run_00000000000000f4";
    mkdirSync(runDir(h.dir), { recursive: true });
    const filler = `${JSON.stringify({ v: 1, at: AT, runs: [] })}\n`.repeat(1001);
    writeFileSync(
      prunedRunsPath(h.dir),
      `${JSON.stringify({ v: 1, at: AT, runs: [id] })}\n${filler}`,
    );
    const res = await home.call("GET", `/api/v1/runs/${id}/events`);
    expect([res.status, (res.body["error"] as Record<string, unknown>)?.["reason"]]).toEqual([
      404,
      "run_unknown",
    ]);
  });
});

describe("a {run} operation other than the stream is answered from canonical runs only", () => {
  test("a run ledger row named like another harness's execution reaches no one through it", async () => {
    const a = await home.harness("planted-a");
    const b = await home.harness("planted-b");
    const exec = "run_00000000deadbe01";
    appendRunLedger(a.dir, {
      runId: exec,
      kind: "daemon",
      argv: ["crewhaus", "run"],
      startedAt: AT,
      logFile: `logs/${exec}.log`,
    });
    row(b.dir, exec, "running", { session: "sess_00000000000000bb", execution: exec });
    const member = await home.member("Planted", "maintainer", { scope: `harness:${a.id}` });
    const ops = [
      ["GET", `/api/v1/runs/${exec}`],
      ["GET", `/api/v1/runs/${exec}/result`],
      ["POST", `/api/v1/runs/${exec}/cancel`],
      ["POST", `/api/v1/runs/${exec}/resume`],
    ] as const;
    for (const [method, path] of ops) {
      const asMember = await home.call(method, path, {
        secret: member.secret,
        ...(method === "POST" ? { body: {} } : {}),
      });
      // The member hears what it hears for any run this Home does not have.
      expect([path, asMember.status]).toEqual([path, 403]);
      expect(JSON.stringify(asMember.body)).not.toContain(b.id);
      const asOwner = await home.call(method, path, method === "POST" ? { body: {} } : {});
      expect([
        path,
        asOwner.status,
        (asOwner.body["error"] as Record<string, unknown>)?.["reason"],
      ]).toEqual([path, 404, "run_unknown"]);
    }
    // The stream itself is A's execution, decided and served on A.
    const feed = await open(`/api/v1/runs/${exec}/events`, { secret: member.secret });
    expect(feed.status).toBe(200);
    await feed.until((f) => f.length >= 1);
    await feed.close();
    expect(feed.frames()[0]?.data["harness"]).toBe(a.id);
  });
});

describe("a frame cap that lands on a run's terminal frame", () => {
  let capped: V1Home;
  beforeAll(async () => {
    capped = await v1Home({ streamTimings: { pollMs: 10, heartbeatMs: 60_000, maxFrames: 2 } });
  }, 60_000);
  afterAll(async () => {
    await capped?.t.stop();
  });

  test("pauses there, and the reconnect from it ends", async () => {
    const h = await capped.harness("cap-terminal");
    const run = mintRunId();
    row(h.dir, run, "queued");
    row(h.dir, run, "succeeded");
    const get = (path: string, headers: Record<string, string> = {}) =>
      fetch(`${capped.t.base}${path}`, { headers: { ...bearer(capped.session), ...headers } });
    const first = parse(await (await get(`/api/v1/runs/${run}/events`)).text());
    expect(events(first)).toEqual(["run.queued", "run.succeeded", "stream.pause"]);
    const resumeFrom = pauseOf(first);
    // Read whole: the body ends only when the stream does.
    const again = parse(
      await (await get(`/api/v1/runs/${run}/events`, { "last-event-id": resumeFrom })).text(),
    );
    expect(again).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")(
  "a run's session trace comes only from the harness's own sessions folder",
  () => {
    const SESS = "sess_00000000000000bb";

    /** A harness with a run whose rows name {@link SESS}, and that session's trace at `at`. */
    async function sessionRun(name: string, sessions: (dir: string) => string) {
      const h = await home.harness(name);
      const run = mintRunId();
      const folder = sessions(h.dir);
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, `${SESS}.events.jsonl`),
        `${JSON.stringify({ kind: "turn_start", runId: run, timestamp: AT })}\n`,
      );
      row(h.dir, run, "running", { session: SESS });
      return { h, run };
    }

    async function framesOf(run: string): Promise<Frame[]> {
      const feed = await open(`/api/v1/runs/${run}/events`);
      expect(feed.status).toBe(200);
      // The run's row arrives first; the trace, or the word that it is unreadable, with it.
      await feed.until((f) => f.some((x) => x.event.startsWith("run.") && x.event !== "run.trace"));
      await feed.until(() => false, 300);
      await feed.close();
      return feed.frames();
    }

    /** Point `dir`'s sessions folder at `target`, and answer `target`. */
    function linkSessions(dir: string, target: string): string {
      const sessions = join(dir, ".crewhaus", "sessions");
      rmSync(sessions, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      symlinkSync(target, sessions);
      return target;
    }

    test("its own folder's trace is streamed", async () => {
      const { run } = await sessionRun("session-own", (dir) => join(dir, ".crewhaus", "sessions"));
      const frames = await framesOf(run);
      expect(frames.filter((f) => f.event === "run.trace")).toHaveLength(1);
      expect(frames.some((f) => f.event === "stream.gap")).toBe(false);
    });

    for (const [label, where] of [
      [
        "a folder linked out of the harness",
        (dir: string) => join(dir, "..", "elsewhere-sessions"),
      ],
      [
        "a folder linked into a harness nested in it",
        (dir: string) => join(dir, "b", ".crewhaus", "sessions"),
      ],
    ] as const) {
      test(`${label} is never opened, and the stream says the trace is unreadable`, async () => {
        const { run } = await sessionRun(`session-${label.length}`, (dir) =>
          linkSessions(dir, where(dir)),
        );
        const frames = await framesOf(run);
        expect(frames.filter((f) => f.event === "run.trace")).toEqual([]);
        const gap = frames.find((f) => f.event === "stream.gap");
        expect(gap?.data["payload"]).toEqual({ reason: "unreadable", source: "session" });
        everyFrameParses(frames);
      });
    }
  },
);
