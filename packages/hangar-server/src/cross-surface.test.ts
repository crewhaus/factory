/**
 * One run and one decision resolve the same on every surface, under faults, through Home.
 *
 * - A Home killed after it persisted a stop and before the stop's effect ran: the next Home
 *   runs the stop once, and the same request retried changes nothing.
 * - A daemon killed in the middle of a turn: its run is interrupted, never succeeded, and
 *   Home says so.
 * - A stream dropped mid-run resumes with every frame once, across a segment roll; a
 *   copied harness that diverged answers a cursor from the original with a reset.
 * - Home, a Slack click and the CLI's decision service racing on one request: one decides,
 *   the others hear who did and where.
 * - 0.8.x writers and bundles against the 0.9.0 heads.
 * - One `Idempotency-Key` sent twice at once starts one run.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAccess } from "@crewhaus/access-control";
import {
  type ApprovalActionAdapter,
  type ApprovalInteraction,
  createApprovalActions,
  createRuntimeBackedApprovalStore,
  whereDecided,
} from "@crewhaus/channel-adapter-base";
import { IDEMPOTENT_REPLAYED_HEADER, mintRunId } from "@crewhaus/control-contract";
import {
  _setRollBytesForTest,
  append,
  foldStates,
  readApproverProjection,
  readPage,
  runsLedger,
} from "@crewhaus/control-records";
import { commandsLedgerOf, createDecisions, currentLocalIdentity } from "@crewhaus/control-service";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import {
  type ProcessOps,
  RUNFILE_VERSION,
  type SpawnPlan,
  type SpawnedProcess,
  createHarnessSupervisor,
  createProcessOps,
  runDir,
  runEventsPath,
} from "@crewhaus/harness-supervisor";
import { createPendingApprovalStore, foldReadOnly } from "@crewhaus/session-store";
import { bearer } from "./__test__/browser";
import { type V1Home, v1Home } from "./__test__/v1-home";
import { createProcessLayer } from "./process";
import { startHangarServer } from "./server";

const TEST_DIR = join(import.meta.dir, "__test__");
const scratch: string[] = [];

let home: V1Home;

beforeAll(async () => {
  home = await v1Home({
    streamTimings: { pollMs: 10, heartbeatMs: 60_000 },
    apiRunLimits: { perHome: Number.MAX_SAFE_INTEGER, perHarness: Number.MAX_SAFE_INTEGER },
  });
}, 60_000);

afterAll(async () => {
  _setRollBytesForTest(undefined);
  await home?.t.stop();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

/** Wait for an observable state, polling a bounded number of times. */
async function until(what: string, holds: () => boolean, tries = 2_000): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (holds()) return;
    await Bun.sleep(5);
  }
  throw new Error(`never held: ${what}`);
}

const errorOf = (body: Record<string, unknown>) => body["error"] as Record<string, unknown>;

/** Every receipt row in a harness's command ledger, oldest first. */
function receiptRows(dir: string): Record<string, unknown>[] {
  return readPage(commandsLedgerOf(dir), { limit: 1000 })
    .items.map((item) => ({ ...item.record }))
    .reverse();
}

const receiptState = (dir: string, id: string) => {
  const fold = foldStates(commandsLedgerOf(dir));
  return fold.ok ? fold.objects.get(id)?.state : "unreadable";
};

const runState = (dir: string, id: string) => {
  const fold = foldStates(runsLedger(dir));
  return fold.ok ? fold.objects.get(id)?.state : "unreadable";
};

const runRowsOf = (dir: string, id: string) =>
  readPage(runsLedger(dir), { limit: 1000 })
    .items.map((item) => ({ ...item.record }))
    .reverse()
    .filter((row) => row["id"] === id);

/** These variables of this process's environment, those it has. */
function passed(names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

const linesOf = (file: string) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l !== "")
    : [];

// ---------------------------------------------------------------------------
// [FC-1]
// ---------------------------------------------------------------------------

describe("a Home that dies between persisting a command and running it", () => {
  const DAEMON_PID = 999_917;
  const DAEMON_START = Date.parse("2026-11-18T10:00:00.000Z");

  /** The seam a recovering Home sees: the daemon is alive until signalled, once, here. */
  function recoveringOps(effects: string): ProcessOps {
    let gone = false;
    return {
      platform: "posix",
      spawn: () =>
        ({
          pid: 7_002,
          exited: new Promise(() => undefined),
          write: () => undefined,
          closeStdin: () => undefined,
          unref: () => undefined,
        }) as unknown as SpawnedProcess,
      isAlive: (pid) => pid === DAEMON_PID && !gone,
      startTimeMs: (pid) => (pid === DAEMON_PID && !gone ? DAEMON_START : undefined),
      commandLine: () => undefined,
      terminate: (pid) => {
        appendFileSync(effects, `${pid}\n`);
        gone = true;
      },
      forceKill: () => undefined,
    };
  }

  function bootRecovering(ws: string, effects: string) {
    const env = {
      CREWHAUS_REGISTRY_ROOT: join(ws, "registry"),
      CREWHAUS_WATCHME_ROOT: join(ws, "watchme"),
    };
    const processLayer = createProcessLayer({
      registry: openHangarRegistry({ root: join(ws, "registry"), env }),
      env,
      now: Date.now,
      onWarn: () => undefined,
      hangarRoot: join(ws, "hangar"),
      managerVersion: "test",
      ops: recoveringOps(effects),
      noPreflight: true,
      pumpIntervalMs: 10,
      runJob: () => new Promise(() => undefined),
    });
    return startHangarServer({
      port: 0,
      root: join(ws, "hangar"),
      registryRoot: join(ws, "registry"),
      env,
      processLayer,
      onWarn: () => undefined,
    });
  }

  test("[FC-1] a stop persisted before Home was killed runs once in the next Home, and a retry adds nothing", async () => {
    const ws = tempDir("home-dies-");
    const dir = join(ws, "harness");
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "daemon.ts"), "// compiled bundle\n");
    writeFileSync(
      join(dir, "crewhaus.yaml"),
      [
        "name: dies-mid-stop",
        "target: channel",
        "agent:",
        "  model: claude-opus-5",
        "  instructions: |",
        "    You are a fixture.",
        "",
      ].join("\n"),
    );
    const env = {
      CREWHAUS_REGISTRY_ROOT: join(ws, "registry"),
      CREWHAUS_WATCHME_ROOT: join(ws, "watchme"),
    };
    const entry = openHangarRegistry({ root: join(ws, "registry"), env }).upsert({
      dir,
      specName: "dies-mid-stop",
      target: "channel",
      origin: "manual",
      originDetail: "test",
    });
    // A live daemon another head started: the runfile Home adopts.
    mkdirSync(join(dir, ".crewhaus", "run"), { recursive: true });
    writeFileSync(
      join(dir, ".crewhaus", "run", "daemon.json"),
      JSON.stringify({
        v: RUNFILE_VERSION,
        pid: DAEMON_PID,
        pidStartTimeMs: DAEMON_START,
        argvFingerprint: "f",
        entry: "daemon.ts",
        bundleDir: join(dir, "dist"),
        runId: "run_00000000000000f1",
        startedAt: new Date(DAEMON_START).toISOString(),
        managerVersion: "test",
      }),
    );
    const reached = join(ws, "reached");
    const ready = join(ws, "ready.json");
    const effects = join(ws, "effects");

    // The first Home, in its own process.
    const child = Bun.spawn([process.execPath, join(TEST_DIR, "home-dies-mid-stop.ts")], {
      env: {
        // The same local user as this process: Home's own key acts as that user, and a
        // retry's key is that actor's.
        ...passed(["PATH", "HOME", "USER", "LOGNAME", "USERNAME", "USERPROFILE", "SystemRoot"]),
        HOME_DIES_ROOT: ws,
        HOME_DIES_REACHED: reached,
        HOME_DIES_READY: ready,
        HOME_DIES_PID: String(DAEMON_PID),
        HOME_DIES_START: String(DAEMON_START),
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    try {
      await until("the first Home is up", () => existsSync(ready));
      const { url, token } = JSON.parse(readFileSync(ready, "utf8")) as {
        url: string;
        token: string;
      };
      const stopAt = `/api/v1/harnesses/${entry.id}/controls/stop`;
      // Never answered: the process blocks in the stop's effect, then dies.
      const pending = fetch(`${url}${stopAt}`, {
        method: "POST",
        headers: {
          ...bearer(token),
          "content-type": "application/json",
          "Idempotency-Key": "stop-once",
        },
        body: "{}",
      }).catch(() => undefined);
      await until(
        "the stop's effect is reached with its receipt persisted",
        () =>
          existsSync(reached) &&
          receiptRows(dir).some(
            (row) =>
              row["kind"] === "controls.stop" &&
              (row["state"] === "accepted" || row["state"] === "running"),
          ),
      );
      child.kill("SIGKILL");
      await child.exited;
      await pending;
      const stops = () => receiptRows(dir).filter((row) => row["kind"] === "controls.stop");
      const cmd = String(stops()[0]?.["id"]);
      expect(new Set(stops().map((row) => row["id"])).size).toBe(1);
      expect(["accepted", "running"]).toContain(receiptState(dir, cmd));
      expect(linesOf(effects)).toEqual([]);

      // The next Home recovers it.
      const second = bootRecovering(ws, effects);
      try {
        await second.ready;
        await until("the stop settles", () => receiptState(dir, cmd) === "succeeded");
        expect(linesOf(effects)).toEqual([String(DAEMON_PID)]);
        // The same request, retried under its key: the same receipt, no second effect.
        const retried = await fetch(`${second.url}${stopAt}`, {
          method: "POST",
          headers: {
            ...bearer(second.token),
            "content-type": "application/json",
            "Idempotency-Key": "stop-once",
          },
          body: "{}",
        });
        const retriedBody = (await retried.json()) as Record<string, unknown>;
        expect(retried.status).toBeLessThan(300);
        expect(retried.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe("true");
        expect((retriedBody["receipt"] as Record<string, unknown>)["id"]).toBe(cmd);
        // Another body under the same key is refused, and adds nothing.
        const other = await fetch(`${second.url}/api/h/${entry.id}/proc/stop`, {
          method: "POST",
          headers: {
            ...bearer(second.token),
            "content-type": "application/json",
            "Idempotency-Key": "stop-once",
          },
          body: JSON.stringify({ graceMs: 5 }),
        });
        expect(other.status).toBe(422);
        expect(linesOf(effects)).toHaveLength(1);
      } finally {
        await second.stop();
      }
      const settled = receiptRows(dir).length;
      // A second restart changes nothing.
      const third = bootRecovering(ws, effects);
      try {
        await third.ready;
      } finally {
        await third.stop();
      }
      expect(receiptRows(dir)).toHaveLength(settled);
      expect(linesOf(effects)).toHaveLength(1);
      expect(receiptState(dir, cmd)).toBe("succeeded");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }, 60_000); // a child Home's boot and kill, then two more Homes over the same root
});

// ---------------------------------------------------------------------------
// [FC-2], the supervised half
// ---------------------------------------------------------------------------

describe("a daemon killed in the middle of a turn", () => {
  // The supervisor's real-spawn seam (a detached child writing to a log file, then a
  // SIGKILL by pid) is POSIX-only, as harness-supervisor's own real-spawn suite is.
  test.skipIf(process.platform === "win32")(
    "[FC-2] the run it was in is interrupted by the supervisor, never succeeded, and Home says so",
    async () => {
      const h = await home.harness("mid-turn", { target: "channel" });
      const run = mintRunId();
      const marker = join(tempDir("mid-turn-"), "marker");
      const plan: SpawnPlan = {
        runClass: "daemon",
        kind: "daemon",
        argv: [process.execPath, join(TEST_DIR, "daemon-mid-turn.ts")],
        cwd: h.dir,
        env: { ...passed(["PATH", "HOME"]), MID_TURN_RUN: run, MID_TURN_MARKER: marker },
        envFiles: [],
        overrides: [],
        detached: true,
        stdio: "file",
        launchMode: "compiled",
        canResume: false,
        supervised: true,
        entry: "daemon-mid-turn.ts",
        bundleDir: TEST_DIR,
        ports: {},
      };
      const supervisor = createHarnessSupervisor({
        harnessDir: h.dir,
        target: "channel",
        ops: createProcessOps(),
        plan: () => plan,
        pumpIntervalMs: 20,
        // Killed is a crash; a restart would start another turn.
        maxRestarts: 0,
      });
      try {
        const started = await supervisor.start();
        expect(started.ok).toBe(true);
        await until("the turn is running", () => existsSync(marker), 4_000);
        expect(runState(h.dir, run)).toBe("running");
        const pid = Number(readFileSync(marker, "utf8").trim());
        process.kill(pid, "SIGKILL");
        await until("the run is closed", () => runState(h.dir, run) === "interrupted", 4_000);
        await supervisor.idle();
        const rows = runRowsOf(h.dir, run);
        expect(rows.at(-1)).toMatchObject({ state: "interrupted", by: "sys:reconcile" });
        expect(rows.map((row) => row["state"])).not.toContain("succeeded");
        const got = await home.call("GET", `/api/v1/runs/${run}`);
        expect(got.status).toBe(200);
        expect(got.body["state"]).toBe("interrupted");
        const result = await home.call("GET", `/api/v1/runs/${run}/result`);
        expect(result.status).toBe(200);
        expect(result.body["state"]).toBe("interrupted");
      } finally {
        supervisor.close();
      }
    },
    20_000, // a real child process, started and killed
  );
});

// ---------------------------------------------------------------------------
// [FC-3]
// ---------------------------------------------------------------------------

type Frame = { id: string; event: string; data: Record<string, unknown> };

function parseFrames(text: string): Frame[] {
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

/**
 * A stream, open once its headers are in (a harness's stream starts from then); `read` reads
 * until a count of frames or the stream's end, then the client drops it.
 */
async function openStream(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ read(want: number): Promise<{ frames: Frame[]; ended: boolean }> }> {
  const controller = new AbortController();
  const res = await fetch(`${home.t.base}${path}`, {
    headers: { ...bearer(home.session), ...headers },
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  return {
    async read(want) {
      let text = "";
      let ended = false;
      try {
        for (let reads = 0; reads < 1_000 && parseFrames(text).length < want; reads += 1) {
          const got = await reader.read();
          if (got.done) {
            ended = true;
            break;
          }
          text += decoder.decode(got.value, { stream: true });
        }
      } finally {
        controller.abort();
        await reader.cancel().catch(() => undefined);
      }
      return { frames: parseFrames(text).slice(0, want), ended };
    },
  };
}

async function readStream(
  path: string,
  want: number,
  headers: Record<string, string> = {},
): Promise<{ frames: Frame[]; ended: boolean }> {
  return (await openStream(path, headers)).read(want);
}

const AT = "2026-11-18T00:00:00.000Z";

function row(dir: string, id: string, state: string, more: Record<string, unknown> = {}): void {
  const written = append(runsLedger(dir), { id, state, at: AT, trigger: { kind: "api" }, ...more });
  if (!written.ok) throw new Error(written.reason);
}

function traceLine(dir: string, execution: string, run: string, kind: string): void {
  mkdirSync(join(runDir(dir), "logs"), { recursive: true });
  appendFileSync(
    runEventsPath(dir, execution),
    `${JSON.stringify({ kind, runId: run, timestamp: AT })}\n`,
  );
}

const what = (frames: Frame[]) =>
  frames.map((f) =>
    f.event === "run.trace"
      ? `trace:${(f.data["payload"] as Record<string, unknown>)["traceKind"]}`
      : `${f.event}:${(f.data["payload"] as Record<string, unknown> | undefined)?.["state"] ?? ""}`,
  );

describe("a stream dropped mid-run resumes with every frame once", () => {
  test("[FC-3] a run's stream, resumed across a segment roll, sends everything written, once and in order", async () => {
    const h = await home.harness("fc3-run");
    const run = mintRunId();
    const execution = "run_00000000000000c3";
    row(h.dir, run, "queued");
    row(h.dir, run, "preparing", { execution });
    row(h.dir, run, "running", { execution });
    traceLine(h.dir, execution, run, "turn_start");
    const first = await readStream(`/api/v1/runs/${run}/events`, 3);
    expect(first.ended).toBe(false);
    expect(first.frames).toHaveLength(3);
    // While the client is away: more rows, more trace, and the ledger rolls a segment.
    _setRollBytesForTest(1);
    try {
      traceLine(h.dir, execution, run, "tool_call");
      row(h.dir, run, "waiting-for-input", { execution });
      row(h.dir, run, "running", { execution });
      traceLine(h.dir, execution, run, "turn_end");
      row(h.dir, run, "succeeded", { execution });
    } finally {
      _setRollBytesForTest(undefined);
    }
    const last = first.frames.at(-1)?.id as string;
    const second = await readStream(`/api/v1/runs/${run}/events`, 100, { "last-event-id": last });
    expect(second.ended).toBe(true);
    const all = [...first.frames, ...second.frames];
    // Each frame once.
    expect(new Set(all.map((f) => f.id)).size).toBe(all.length);
    // Every row, in the order written, and every trace line, in the order written.
    expect(what(all).filter((w) => !w.startsWith("trace:"))).toEqual([
      "run.queued:queued",
      "run.preparing:preparing",
      "run.started:running",
      "run.waiting:waiting-for-input",
      "run.started:running",
      "run.succeeded:succeeded",
    ]);
    expect(what(all).filter((w) => w.startsWith("trace:"))).toEqual([
      "trace:turn_start",
      "trace:tool_call",
      "trace:turn_end",
    ]);
  }, 20_000);

  test("[FC-3] a harness's stream, resumed across a segment roll, sends everything written, once and in order", async () => {
    const h = await home.harness("fc3-harness");
    const runs = [mintRunId(), mintRunId(), mintRunId()];
    // The stream starts from now: rows written once it is open.
    const opened = await openStream(`/api/v1/harnesses/${h.id}/events`);
    row(h.dir, runs[0] as string, "queued");
    row(h.dir, runs[0] as string, "running");
    const first = await opened.read(2);
    expect(first.frames).toHaveLength(2);
    _setRollBytesForTest(1);
    try {
      row(h.dir, runs[1] as string, "queued");
      row(h.dir, runs[0] as string, "succeeded");
      row(h.dir, runs[2] as string, "queued");
    } finally {
      _setRollBytesForTest(undefined);
    }
    const last = first.frames.at(-1)?.id as string;
    const second = await readStream(`/api/v1/harnesses/${h.id}/events`, 3, {
      "last-event-id": last,
    });
    const all = [...first.frames, ...second.frames];
    expect(new Set(all.map((f) => f.id)).size).toBe(all.length);
    const [r0, r1, r2] = runs;
    expect(all.map((f) => [f.data["run"], what([f])[0]])).toEqual([
      [r0, "run.queued:queued"],
      [r0, "run.started:running"],
      [r1, "run.queued:queued"],
      [r0, "run.succeeded:succeeded"],
      [r2, "run.queued:queued"],
    ]);
  }, 20_000);

  test("a copied harness that diverged answers the original's cursor with a reset; one taken before the copy resumes on it", async () => {
    const h = await home.harness("fc3-original");
    const opened = await openStream(`/api/v1/harnesses/${h.id}/events`);
    const run = mintRunId();
    row(h.dir, run, "queued");
    row(h.dir, run, "running");
    const before = await opened.read(2);
    expect(before.frames).toHaveLength(2);
    const forkCursor = before.frames.at(-1)?.id as string;
    // A byte-for-byte copy, registered as its own harness.
    const copyDir = join(home.t.harnessesRoot, "fc3-copy");
    cpSync(h.dir, copyDir, { recursive: true });
    const copy = (
      (
        await home.t.api("/api/harnesses", {
          method: "POST",
          body: JSON.stringify({ dir: copyDir }),
        })
      ).body["entry"] as { id: string }
    ).id;
    expect(copy).not.toBe(h.id);
    // They diverge: the original's run ends one way, the copy's another.
    row(h.dir, run, "succeeded");
    const onOriginal = await readStream(`/api/v1/harnesses/${h.id}/events`, 1, {
      "last-event-id": forkCursor,
    });
    expect(what(onOriginal.frames)).toEqual(["run.succeeded:succeeded"]);
    const diverged = onOriginal.frames.at(-1)?.id as string;
    row(copyDir, run, "failed", { failureClass: "interrupted", reason: "copied" });
    row(copyDir, mintRunId(), "queued");
    // The original's cursor, on the copy: a reset, not a gap and not a silent replay.
    const reset = await readStream(`/api/v1/harnesses/${copy}/events`, 1, {
      "last-event-id": diverged,
    });
    expect(reset.frames[0]?.event).toBe("stream.reset");
    expect((reset.frames[0]?.data["payload"] as Record<string, unknown>)["reason"]).toBe(
      "diverged",
    );
    // A cursor from before the copy: the copy's own rows after it, each once, no reset.
    const resumed = await readStream(`/api/v1/harnesses/${copy}/events`, 2, {
      "last-event-id": forkCursor,
    });
    expect(what(resumed.frames)).toEqual(["run.failed:failed", "run.queued:queued"]);
    expect(new Set(resumed.frames.map((f) => f.id)).size).toBe(2);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Duplicates by key
// ---------------------------------------------------------------------------

describe("one Idempotency-Key sent twice at once", () => {
  test("starts one run and writes one receipt; the other answer is a replay of the first", async () => {
    const h = await home.harness("same-key");
    const bin = join(h.dir, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "crewhaus"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "crewhaus"), 0o755);
    const send = () =>
      home.call("POST", `/api/v1/harnesses/${h.id}/runs`, {
        body: { input: "x" },
        headers: { "Idempotency-Key": "together-1" },
      });
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status]).toEqual([202, 202]);
    // One receipt, answered to both; the one that did not start it is told it is a replay
    // (while the start is still in flight its answer is the receipt as it stands).
    const receiptOf = (res: typeof a) => (res.body["receipt"] as Record<string, unknown>)["id"];
    expect(receiptOf(a)).toBe(receiptOf(b));
    const replays = [a, b].map((res) => res.headers.get(IDEMPOTENT_REPLAYED_HEADER) === "true");
    expect(replays.filter(Boolean)).toHaveLength(1);
    const started = [a, b].find((_, k) => replays[k] !== true) as typeof a;
    const runId = (started.body["run"] as Record<string, unknown>)["id"];
    const replayed = [a, b].find((_, k) => replays[k] === true) as typeof a;
    const replayedRun = (replayed.body["run"] as Record<string, unknown> | undefined)?.["id"];
    if (replayedRun !== undefined) expect(replayedRun).toBe(runId);
    const queued = readPage(runsLedger(h.dir), { limit: 100 }).items.filter(
      (item) => item.record["state"] === "queued",
    );
    expect(queued).toHaveLength(1);
    const creates = receiptRows(h.dir).filter((row) => row["kind"] === "runs.create");
    expect(new Set(creates.map((row) => row["id"])).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Decisions across Home, Slack and the CLI's decision service
// ---------------------------------------------------------------------------

const TEAM = "T0";
const USER = "U0";
const SLACK_SUBJECT = `slack:${TEAM}:${USER}`;
const SESSION = "sess_00000000000000aa";

function approval(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    toolName: "SendMessage",
    inputHash: `hash-${id}`,
    // Small enough for the card to show in full, so an Approve there can decide it.
    input: { channel: "ops", text: `content of ${id}` },
    runId: "run_00000000000000a0",
    sessionId: SESSION,
    surface: "daemon",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    ...extra,
  };
}

/** Every registered harness, as access-control's projection writer takes them. */
function registered() {
  return openHangarRegistry({ root: home.t.registryRoot, env: {} })
    .list()
    .map((e) => ({ id: e.id, dir: e.dir, groups: [...e.groups] }));
}

let slackLinked = false;

/** A harness governed by Home's access records, its approver list written by `sync`. */
async function governed(name: string, approvals: unknown[]) {
  const h = await home.harness(name, { approvals });
  const access = openAccess(home.t.hangarRoot, { harnesses: registered });
  if (!slackLinked) {
    const linked = await access.link(
      { principal: home.owner },
      { subject: SLACK_SUBJECT, member: home.owner },
    );
    if (!linked.ok) throw new Error(linked.reason);
    slackLinked = true;
  }
  const synced = await access.sync({ principal: home.owner });
  if (!synced.ok) throw new Error(synced.reason);
  return h;
}

/** Let the work a click queues off the request path run: counted event-loop turns. */
async function drain(turns = 50): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** The Slack door on one harness: the gateway's click handler over its own store. */
function slackDoor(dir: string) {
  const root = join(dir, ".crewhaus", "sessions");
  const bridge = createRuntimeBackedApprovalStore(createPendingApprovalStore({ rootDir: root }));
  const answers: string[] = [];
  const resumed: string[] = [];
  const adapter: ApprovalActionAdapter<ApprovalInteraction> = {
    id: "slack",
    parseInteraction: () => undefined,
    async ackApproval() {},
    async answerInteraction(args) {
      answers.push(args.text);
    },
  };
  const actions = createApprovalActions({
    approvals: bridge,
    adapters: new Map([["slack", adapter]]),
    sessionRouter: {
      async resumeApproval(a: { id: string }) {
        resumed.push(a.id);
      },
    },
    harnessDir: dir,
    watch: { onChange: () => undefined, close: () => undefined },
  });
  return {
    answers,
    resumed,
    click: (id: string, decision: "grant" | "deny" = "grant") =>
      actions.handle(
        { kind: "approval_action", approvalId: id, decision, userId: USER, teamId: TEAM },
        adapter,
      ),
    close: () => actions.close(),
  };
}

/** The decision service as `crewhaus approvals` calls it: this machine's user, via the CLI. */
function cliDoor() {
  const decisions = createDecisions({
    hangarRoot: home.t.hangarRoot,
    identity: currentLocalIdentity(),
    now: Date.now,
  });
  return (dir: string, ref: string, choice: "grant" | "deny") =>
    decisions.resolve({
      harnessDir: dir,
      ref,
      choice,
      actor: { kind: "local", identity: currentLocalIdentity() },
      via: "cli",
    });
}

/** What a decision leaves under a session root: decision claims and `decide` lines, for one id. */
function decided(dir: string, id: string): { claims: number; decides: number } {
  const root = join(dir, ".crewhaus", "sessions");
  const claim = join(root, "approvals.d", "claims", "decision", `${id}.json`);
  const log = join(root, "approvals.d", "decisions");
  const decides = (existsSync(log) ? readdirSync(log) : [])
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(log, name), "utf8").split("\n"))
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line["event"] === "decide" && line["decision"] === id);
  return { claims: existsSync(claim) ? 1 : 0, decides: decides.length };
}

const recordOf = (dir: string, id: string) =>
  foldReadOnly(join(dir, ".crewhaus", "sessions")).records.find((r) => r.id === id);

describe("one request, decided from Home, Slack and the CLI at once", () => {
  test("exactly one door decides; the others hear it was decided, and through which door", async () => {
    const DOORS = ["home", "slack", "cli"] as const;
    const ids = Array.from(
      { length: 6 },
      (_, k) => `appr_00000000000c1${k.toString(16).padStart(3, "0")}`,
    );
    const h = await governed(
      "race",
      ids.map((id) => approval(id)),
    );
    const slack = slackDoor(h.dir);
    const cli = cliDoor();
    try {
      for (const [k, id] of ids.entries()) {
        // Each door is started first in turn, twice over.
        const order = [...DOORS.slice(k % 3), ...DOORS.slice(0, k % 3)];
        const answers = new Map<string, { decided: boolean; heard?: string }>();
        const before = slack.answers.length;
        await Promise.all(
          order.map(async (door) => {
            if (door === "home") {
              const res = await home.call(
                "POST",
                `/api/v1/decisions/${h.id}/decision/${id}/resolve`,
                {
                  body: { choice: "grant" },
                },
              );
              const current = errorOf(res.body)?.["current"] as Record<string, unknown> | undefined;
              answers.set("home", {
                decided: res.status === 200,
                ...(res.status === 409 ? { heard: String(current?.["surface"]) } : {}),
              });
            } else if (door === "slack") {
              const res = await slack.click(id);
              expect(res.status).toBe(200);
              answers.set("slack", { decided: false });
            } else {
              const answer = await cli(h.dir, id, "grant");
              answers.set("cli", {
                decided: answer.outcome === "decided",
                ...(answer.outcome === "already-decided"
                  ? { heard: String(answer.winner?.decidedVia ?? answer.record?.decidedVia) }
                  : {}),
              });
            }
          }),
        );
        await drain();
        const record = recordOf(h.dir, id);
        const winner = String(record?.decidedVia);
        expect(record?.decision).toBe("grant");
        expect(DOORS as readonly string[]).toContain(winner);
        // Slack decided when its door is the record's; otherwise its clicker heard where.
        answers.set("slack", { decided: winner === "slack" });
        const slackHeard = slack.answers.slice(before);
        if (winner === "slack") expect(slackHeard).toEqual([]);
        else expect(slackHeard).toEqual([`Already granted ${whereDecided(winner)}.`]);
        expect([...answers.values()].filter((a) => a.decided)).toHaveLength(1);
        for (const door of DOORS) {
          const a = answers.get(door);
          if (door === winner || door === "slack") continue;
          expect(`${door}: ${a?.heard}`).toBe(`${door}: ${winner}`);
        }
        expect(decided(h.dir, id)).toEqual({ claims: 1, decides: 1 });
      }
    } finally {
      slack.close();
    }
  }, 30_000); // eighteen decisions through three doors

  test("a Slack Approve on a card Home already denied decides nothing, says where, and resumes nothing", async () => {
    const id = "appr_00000000000c2001";
    const h = await governed("stale-card", [approval(id)]);
    const slack = slackDoor(h.dir);
    try {
      const denied = await home.call("POST", `/api/v1/decisions/${h.id}/decision/${id}/resolve`, {
        body: { choice: "deny" },
      });
      expect(denied.status).toBe(200);
      const res = await slack.click(id, "grant");
      expect(res.status).toBe(200);
      await drain();
      expect(slack.answers).toEqual([`Already denied ${whereDecided("home")}.`]);
      expect(slack.resumed).toEqual([]);
      expect(recordOf(h.dir, id)).toMatchObject({ decision: "deny", decidedVia: "home" });
      expect(decided(h.dir, id)).toEqual({ claims: 1, decides: 1 });
    } finally {
      slack.close();
    }
  });
});

describe("a grant is spent once, by whoever may still have decided it, for the call it was for", () => {
  /** A spend, as the runtime asks for one just before the call runs. */
  const spendOf = (dir: string) => ({
    runId: mintRunId(),
    resumeScope: `session:${SESSION}`,
    places: [],
    approvers: readApproverProjection(dir),
  });

  test("after one Home grant, two processes spending it at once: one spends it, one consume line", async () => {
    const id = "appr_00000000000c3001";
    const h = await governed("spend-race", [approval(id)]);
    const granted = await home.call("POST", `/api/v1/decisions/${h.id}/decision/${id}/resolve`, {
      body: { choice: "grant" },
    });
    expect(granted.status).toBe(200);
    const root = join(h.dir, ".crewhaus", "sessions");
    const script = join(tempDir("spend-race-"), "spend.ts");
    writeFileSync(
      script,
      [
        `import { createPendingApprovalStore } from ${JSON.stringify(Bun.resolveSync("@crewhaus/session-store", import.meta.dir))};`,
        `import { readApproverProjection } from ${JSON.stringify(Bun.resolveSync("@crewhaus/control-records", import.meta.dir))};`,
        "const [root, dir, id, runId] = process.argv.slice(2);",
        "const store = createPendingApprovalStore({ rootDir: root });",
        `const answer = await store.consume(id, { runId, resumeScope: ${JSON.stringify(`session:${SESSION}`)}, places: [], approvers: readApproverProjection(dir) });`,
        "console.log(JSON.stringify({ outcome: answer.outcome, reason: answer.outcome === 'refused' ? answer.reason : undefined }));",
      ].join("\n"),
    );
    const spend = () => {
      const child = Bun.spawn([process.execPath, script, root, h.dir, id, mintRunId()], {
        env: passed(["PATH", "HOME"]),
        stdout: "pipe",
        stderr: "pipe",
      });
      return Promise.all([new Response(child.stdout).text(), child.exited]).then(([out, code]) => {
        expect(code).toBe(0);
        return JSON.parse(out.trim()) as { outcome: string; reason?: string };
      });
    };
    const answers = await Promise.all([spend(), spend()]);
    expect(answers.map((a) => a.outcome).sort()).toEqual(["consumed", "refused"]);
    expect(answers.find((a) => a.outcome === "refused")?.reason).toBe("consumed");
    const log = join(root, "approvals.d", "decisions");
    const consumes = readdirSync(log)
      .flatMap((name) => readFileSync(join(log, name), "utf8").split("\n"))
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line["event"] === "consume" && line["decision"] === id);
    expect(consumes).toHaveLength(1);
    expect(readdirSync(join(root, "approvals.d", "claims", "consume"))).toEqual([`${id}.json`]);
  }, 20_000); // two bun processes, slow by construction on CI

  test("a member removed after granting: the spend is refused and the call is asked again; a changed payload is not covered", async () => {
    const id = "appr_00000000000c4001";
    const h = await governed("revoked-decider", [approval(id)]);
    const mae = await home.member("Mae", "operator");
    const access = openAccess(home.t.hangarRoot, { harnesses: registered });
    expect((await access.sync({ principal: home.owner })).ok).toBe(true);
    const granted = await home.call("POST", `/api/v1/decisions/${h.id}/decision/${id}/resolve`, {
      body: { choice: "grant" },
      secret: mae.secret,
    });
    expect(granted.status).toBe(200);
    expect(recordOf(h.dir, id)?.decidedByPrincipal).toBe(mae.principal);
    const store = createPendingApprovalStore({ rootDir: join(h.dir, ".crewhaus", "sessions") });
    // A different payload for the same tool: the grant does not cover it.
    expect(await store.get("SendMessage", `hash-${id}-changed`)).toBeNull();
    expect((await store.get("SendMessage", `hash-${id}`))?.id).toBe(id);
    // The owner removes the member; the list is written again.
    const removed = await access.removeMember({ principal: home.owner }, mae.principal);
    if (!removed.ok) throw new Error(removed.reason);
    expect((await access.sync({ principal: home.owner })).ok).toBe(true);
    // Past the approver list's one-second cache, on a faked clock.
    const realNow = Date.now.bind(Date);
    const clock = spyOn(Date, "now").mockImplementation(() => realNow() + 2_000);
    let answer: Awaited<ReturnType<typeof store.consume>>;
    try {
      answer = await store.consume(id, spendOf(h.dir));
    } finally {
      clock.mockRestore();
    }
    expect(answer.outcome).toBe("refused");
    if (answer.outcome !== "refused") return;
    expect(answer.reason).toBe("decider-not-authorized");
    // Asked again: a fresh request for the same call, waiting for a decision.
    expect(answer.fresh?.status ?? answer.fresh?.decision ?? "pending").toBe("pending");
    expect(answer.fresh?.inputHash).toBe(`hash-${id}`);
    expect(recordOf(h.dir, id)?.consumedAt).toBeUndefined();
    expect(recordOf(h.dir, id)?.supersededBy).toBe(answer.fresh?.id);
  }, 30_000); // a member's device sign-in, and the list written twice
});

// ---------------------------------------------------------------------------
// 0.8.x against the 0.9.0 heads
// ---------------------------------------------------------------------------

describe("an 0.8.x writer and an 0.8.x bundle meet the 0.9.0 heads", () => {
  test("after a Home grant, an 0.8.x flip and compaction: Home and Slack still answer granted by the owner in Home, and the spent grant stays spent", async () => {
    const id = "appr_00000000000d1001";
    const h = await governed("old-writer", [approval(id)]);
    const root = join(h.dir, ".crewhaus", "sessions");
    const granted = await home.call("POST", `/api/v1/decisions/${h.id}/decision/${id}/resolve`, {
      body: { choice: "grant" },
    });
    expect(granted.status).toBe(200);
    const store = createPendingApprovalStore({ rootDir: root });
    const spent = await store.consume(id, {
      runId: mintRunId(),
      resumeScope: `session:${SESSION}`,
      places: [],
      approvers: readApproverProjection(h.dir),
    });
    expect(spent.outcome).toBe("consumed");
    const file = join(root, "approvals.jsonl");
    const lastOf = (text: string) => {
      const byId = new Map<string, string>();
      for (const line of text.split("\n").filter((l) => l !== "")) {
        byId.set(String((JSON.parse(line) as Record<string, unknown>)["id"]), line);
      }
      return [...byId.values()];
    };
    // An 0.8.x deny, appended as 0.8.x appended one.
    appendFileSync(
      file,
      `${JSON.stringify({ ...approval(id), decision: "deny", decidedBy: "eve", decidedAt: new Date().toISOString() })}\n`,
    );
    // An 0.8.x compaction: each id's last line.
    writeFileSync(file, `${lastOf(readFileSync(file, "utf8")).join("\n")}\n`);
    const filesBefore = decided(h.dir, id);

    const got = await home.call("GET", `/api/v1/decisions/${h.id}/decision/${id}`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ decision: "grant", decidedByPrincipal: home.owner });
    // A second decider in Home hears it was granted, and through which door.
    const again = await home.call("POST", `/api/v1/decisions/${h.id}/decision/${id}/resolve`, {
      body: { choice: "deny" },
    });
    expect(again.status).toBe(409);
    expect(errorOf(again.body)["current"]).toMatchObject({ decision: "grant", surface: "home" });
    expect(recordOf(h.dir, id)).toMatchObject({
      decision: "grant",
      decidedVia: "home",
      decidedByPrincipal: home.owner,
    });
    const slack = slackDoor(h.dir);
    try {
      expect((await slack.click(id, "deny")).status).toBe(200);
      await drain();
      expect(slack.answers).toEqual([`Already granted ${whereDecided("home")}.`]);
    } finally {
      slack.close();
    }
    // Nothing new was decided, and the grant stays spent.
    expect(decided(h.dir, id)).toEqual(filesBefore);
    expect(recordOf(h.dir, id)?.consumedAt).toBeDefined();
    expect(await store.get("SendMessage", `hash-${id}`)).toBeNull();
  }, 20_000);

  test("a crew bundle compiled by 0.8.3: runs.create is 501 with `crewhaus compile` and writes no run; Home still reads it", async () => {
    const h = await home.harness("old-bundle", { target: "crew" });
    mkdirSync(join(h.dir, "dist"), { recursive: true });
    writeFileSync(join(h.dir, "dist", "daemon.ts"), "// bundle\n");
    writeFileSync(
      join(h.dir, "dist", "package.json"),
      JSON.stringify({
        name: "crewhaus-compiled-bundle",
        crewhaus: { specHash: "x", compiledWith: "0.8.3" },
      }),
    );
    const res = await home.call("POST", `/api/v1/harnesses/${h.id}/runs`, {
      body: { input: "Brief." },
    });
    expect(res.status).toBe(501);
    expect(errorOf(res.body)).toMatchObject({
      code: "unsupported",
      reason: "bundle_too_old",
      verb: "crewhaus compile",
    });
    expect(readPage(runsLedger(h.dir), { limit: 10 }).items).toEqual([]);
    const list = await home.call("GET", "/api/v1/harnesses");
    expect(list.status).toBe(200);
    expect((list.body["items"] as { id: string }[]).map((i) => i.id)).toContain(h.id);
    const one = await home.call("GET", `/api/v1/harnesses/${h.id}`);
    expect(one.status).toBe(200);
  });
});
