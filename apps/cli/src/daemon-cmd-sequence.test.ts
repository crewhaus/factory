/**
 * `crewhaus daemon`, pinned as one sequence of verbs against a fake daemon.
 *
 * crewhaus/factory#507's step 03 moves the helpers behind these verbs — the
 * control.v1 client, run detail, the log scrubber — between packages, and a
 * move must not change a single thing an operator sees. So this test drives
 * the verbs an operator chains together and compares EVERYTHING they produce
 * with a literal captured before the move:
 *
 *   start → (the daemon announces its control port and mints its token) →
 *   status → wake → wake again (refused: a tick is in flight) → logs → drain
 *
 * For each verb: the exit code and every line. For each control call: the
 * method, the route, the header names, whether the bearer is the token the
 * daemon minted, and the body. For the spawn: argv, the env NAMES and the
 * control port. Normalized only for what differs per run — the temp dir,
 * pids, run ids, command ids and times. The receipt lines (`Done (cmd_…)`) are
 * the one deliberate addition since the capture.
 *
 * Nothing is spawned: `ProcessOps` and `fetch` are fakes, as in
 * `daemon-cmd.test.ts` (whose helpers are copied here, not shared, so that
 * file stays untouched).
 */
import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessOps, SpawnRequest, SpawnedProcess } from "@crewhaus/harness-supervisor";
import { type DaemonCommandResult, runDaemonCommand } from "./daemon-cmd";

// --- seams (copied from daemon-cmd.test.ts) ---------------------------------

type FakeChild = {
  pid: number;
  request: SpawnRequest;
  signals: string[];
  exit(code: number | null, signal?: string | null): void;
  writeLog(text: string): void;
};

type FakeOps = ProcessOps & { children: FakeChild[]; last(): FakeChild | undefined };

function fakeOps(now: () => number): FakeOps {
  let nextPid = 9_001;
  const children: FakeChild[] = [];
  const live = new Map<number, { startTimeMs: number; commandLine: string }>();
  const childFor = (pid: number): FakeChild | undefined => children.find((c) => c.pid === pid);
  return {
    children,
    last: () => children[children.length - 1],
    spawn: (request) => {
      const pid = nextPid;
      nextPid += 1;
      let settle: (v: { code: number | null; signal: string | null }) => void = () => {};
      const exited = new Promise<{ code: number | null; signal: string | null }>((r) => {
        settle = r;
      });
      const logPath = request.stdio.mode === "file" ? request.stdio.path : undefined;
      const child: FakeChild = {
        pid,
        request,
        signals: [],
        exit: (code, signal = null) => {
          live.delete(pid);
          settle({ code, signal });
        },
        writeLog: (text) => {
          if (logPath !== undefined) appendFileSync(logPath, text);
        },
      };
      children.push(child);
      live.set(pid, { startTimeMs: now(), commandLine: request.argv.join(" ") });
      return {
        pid,
        exited,
        write: () => {},
        closeStdin: () => {},
        unref: () => {},
      } as SpawnedProcess;
    },
    isAlive: (pid) => live.has(pid),
    startTimeMs: (pid) => live.get(pid)?.startTimeMs,
    commandLine: (pid) => live.get(pid)?.commandLine,
    terminate: (pid) => {
      const child = childFor(pid);
      child?.signals.push("SIGTERM");
      child?.exit(null, "SIGTERM");
    },
    forceKill: (pid) => {
      const child = childFor(pid);
      child?.signals.push("SIGKILL");
      child?.exit(null, "SIGKILL");
    },
  };
}

/** Built from parts: this repo's push protection rejects realistic secret
 *  literals, and a fixture never needs one. */
const ENV_SECRET = ["sk", "seq", "0123456789abcdefghij"].join("-");
const CONTROL_TOKEN = ["ctl", "sequence", "token"].join("-");
const CONTROL_PORT = 41_299;

/** What one control call looked like on the wire, minus the secret itself. */
type ControlCall = {
  readonly method: string;
  readonly origin: string;
  readonly path: string;
  readonly headers: readonly string[];
  readonly bearerIsTokenFile: boolean;
  readonly body: unknown;
};

/**
 * A fake daemon's control plane: answers each call from a script, in order,
 * and records what was asked. The bearer is compared with the token file AT
 * CALL TIME, which is what the client is supposed to have read.
 */
function controlPlane(
  harnessDir: string,
  script: ReadonlyArray<{ status: number; body: unknown; afterAnswer?: () => void }>,
): { fetch: typeof fetch; calls: ControlCall[] } {
  const calls: ControlCall[] = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    let tokenFile: string | undefined;
    try {
      tokenFile = readFileSync(
        join(harnessDir, ".crewhaus", "run", "control-token"),
        "utf8",
      ).trim();
    } catch {
      tokenFile = undefined;
    }
    calls.push({
      method: init?.method ?? "GET",
      origin: url.origin,
      path: url.pathname,
      headers: Object.keys(headers).sort(),
      bearerIsTokenFile:
        tokenFile !== undefined && headers["authorization"] === `Bearer ${tokenFile}`,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    const step = script[calls.length - 1];
    if (step === undefined) throw new Error(`unscripted control call #${calls.length}`);
    step.afterAnswer?.();
    return new Response(JSON.stringify(step.body), {
      status: step.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: doFetch, calls };
}

/** Replace what differs per run, and nothing else. */
function normalizer(root: string): (text: string) => string {
  const roots = [...new Set([realpathSync(root), root])].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const r of roots) out = out.split(r).join("<tmp>");
    return out
      .replace(/\brun_[0-9a-f]{16}\b/g, "<run>")
      .replace(/\bcmd_[0-9a-z]{26}\b/g, "cmd_X")
      .replace(/\bpid \d+/g, "pid <pid>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/g, "<time>");
  };
}

/**
 * The sequence, captured from this test on `main` BEFORE the helpers moved.
 * Regenerating it from a tree that has already changed would prove nothing.
 */
const EXPECTED = {
  spawn: {
    argv: ["bun", "<tmp>/harness/dist/daemon.ts"],
    cwd: "<tmp>/harness",
    envKeys: [
      "CREWHAUS_CONTROL_PORT",
      "CREWHAUS_COST_TRACKING",
      // Added on purpose since the capture: the supervisor hands every child
      // its execution id, so the runs it records name the process.
      // Added on purpose: the deployment a run was started from, stamped from the active
      // record (a harness with no record is recorded and activated at its first start).
      "CREWHAUS_DEPLOYMENT_ID",
      "CREWHAUS_EXECUTION_ID",
      "CREWHAUS_NO_REGISTRY",
      "CREWHAUS_REGISTRY_ROOT",
      "CREWHAUS_SPEC_HASH",
      "CREWHAUS_TRACE",
      "SEQ_API_KEY",
    ],
    controlPort: "0",
  },
  verbs: [
    {
      argv: ["start", "--no-preflight"],
      exitCode: 0,
      lines: [
        "sequence-fixture: started <run> (pid <pid>)",
        "  class daemon · state running",
        "  logs: crewhaus daemon logs <tmp>/harness --run <run>",
        "Done (cmd_X)",
      ],
    },
    {
      argv: ["status"],
      exitCode: 0,
      lines: [
        "sequence-fixture: running · pid <pid> · run <run> · since <time>",
        "  control: crewhaus.control.v1 on 127.0.0.1:41299",
        "  recent runs:",
        "    <run>  daemon  <time> (open)",
        "  env files (lowest precedence first, all UNDER process.env):",
        "    .env",
        "  would run: cd '<tmp>/harness' && 'bun' '<tmp>/harness/dist/daemon.ts'",
      ],
    },
    {
      argv: ["wake", "--lane", "heartbeat"],
      exitCode: 0,
      lines: [
        "sequence-fixture: heartbeat tick accepted (session sess_00000000000000a1)",
        "  the tick runs down the daemon's OWN timer path — the same code the schedule fires",
      ],
    },
    {
      argv: ["wake", "--lane", "heartbeat"],
      exitCode: 1,
      lines: [
        "tick_in_flight: a heartbeat tick is already running",
        "  this one is retryable — try again in a moment",
      ],
    },
    {
      argv: ["logs", "--tail", "5"],
      exitCode: 0,
      lines: [
        "— <run> —",
        "[control] crewhaus.control.v1 listening on http://127.0.0.1:41299 (token: .crewhaus/run/control-token)",
        "connecting with «SEQ_API_KEY»",
        "ready",
        "heartbeat armed: every 60000ms",
        "idle",
      ],
    },
    {
      argv: ["drain"],
      exitCode: 0,
      lines: ["sequence-fixture: drained", "Done (cmd_X)"],
    },
  ],
  controlCalls: [
    {
      method: "POST",
      origin: "http://127.0.0.1:41299",
      path: "/control/v1/wake",
      headers: ["authorization", "content-type"],
      bearerIsTokenFile: true,
      body: {
        lane: "heartbeat",
        by: "crewhaus daemon wake",
      },
    },
    {
      method: "POST",
      origin: "http://127.0.0.1:41299",
      path: "/control/v1/wake",
      headers: ["authorization", "content-type"],
      bearerIsTokenFile: true,
      body: {
        lane: "heartbeat",
        by: "crewhaus daemon wake",
      },
    },
    {
      method: "POST",
      origin: "http://127.0.0.1:41299",
      path: "/control/v1/drain",
      headers: ["authorization"],
      bearerIsTokenFile: true,
      body: null,
    },
  ],
  signals: [],
};

describe("crewhaus daemon, as one sequence", () => {
  // Six verbs, two of which adopt a daemon and pump its log, and a drain
  // whose exit is noticed by the pump's liveness poll on the REAL clock (an
  // adopted run is not ours to await), so this is slow by construction.
  test("start, status, wake, a refused wake, logs and drain say exactly what they said before the move", async () => {
    const root = mkdtempSync(join(tmpdir(), "daemon-seq-"));
    const dir = join(root, "harness");
    try {
      mkdirSync(join(dir, "dist"), { recursive: true });
      writeFileSync(join(dir, "dist", "daemon.ts"), "// compiled bundle\n");
      writeFileSync(
        join(dir, "crewhaus.yaml"),
        [
          "name: sequence-fixture",
          "target: channel",
          "agent:",
          "  model: anthropic/claude-sonnet-4",
          "  instructions: |",
          "    You are a fixture.",
          "heartbeat:",
          "  every: 60s",
          "  instructions: check in",
          "",
        ].join("\n"),
      );
      writeFileSync(join(dir, ".env"), `SEQ_API_KEY=${ENV_SECRET}\n`, { mode: 0o600 });

      const ops = fakeOps(() => Date.now());
      const opts = {
        env: { CREWHAUS_REGISTRY_ROOT: join(root, "registry"), CREWHAUS_NO_REGISTRY: "1" },
        ops,
        cwd: dir,
      };
      const norm = normalizer(root);
      const verbs: Array<{ argv: readonly string[]; exitCode: number; lines: string[] }> = [];
      const record = (argv: readonly string[], result: DaemonCommandResult): void => {
        verbs.push({ argv, exitCode: result.exitCode, lines: result.lines.map(norm) });
      };

      const started = await runDaemonCommand(["start", "--no-preflight"], opts);
      record(["start", "--no-preflight"], started);
      const child = ops.last();
      if (child === undefined) throw new Error("start spawned nothing");
      const spawn = {
        argv: child.request.argv.map(norm),
        cwd: norm(child.request.cwd),
        envKeys: Object.keys(child.request.env).sort(),
        controlPort: child.request.env["CREWHAUS_CONTROL_PORT"] ?? null,
      };

      // What a control-serving daemon does at bind: announce the port on
      // stdout (the only place a kernel-assigned port exists) and mint the
      // 0600 token file. Then some ordinary output, one line of which quotes
      // the harness's own .env value.
      child.writeLog("boot: loading spec\n");
      child.writeLog(
        `[control] crewhaus.control.v1 listening on http://127.0.0.1:${CONTROL_PORT} (token: .crewhaus/run/control-token)\n`,
      );
      writeFileSync(join(dir, ".crewhaus", "run", "control-token"), `${CONTROL_TOKEN}\n`, {
        mode: 0o600,
      });
      child.writeLog(`connecting with ${ENV_SECRET}\n`);
      child.writeLog("ready\n");
      child.writeLog("heartbeat armed: every 60000ms\n");
      child.writeLog("idle\n");

      const plane = controlPlane(dir, [
        {
          status: 202,
          body: {
            sessionId: "sess_00000000000000a1",
            lane: "heartbeat",
            reason: "operator poke",
            synthetic: true,
          },
        },
        { status: 409, body: { error: "a heartbeat tick is in flight", code: "tick_in_flight" } },
        // A drained daemon finishes its work and exits on its own.
        {
          status: 202,
          body: { draining: true, alreadyDraining: false },
          afterAnswer: () => child.exit(0),
        },
      ]);
      const withFetch = { ...opts, fetch: plane.fetch };

      record(["status"], await runDaemonCommand(["status"], withFetch));
      record(
        ["wake", "--lane", "heartbeat"],
        await runDaemonCommand(["wake", "--lane", "heartbeat"], withFetch),
      );
      record(
        ["wake", "--lane", "heartbeat"],
        await runDaemonCommand(["wake", "--lane", "heartbeat"], withFetch),
      );
      record(["logs", "--tail", "5"], await runDaemonCommand(["logs", "--tail", "5"], withFetch));
      record(["drain"], await runDaemonCommand(["drain"], withFetch));

      const sequence = { spawn, verbs, controlCalls: plane.calls, signals: child.signals };
      // The .env value never prints, anywhere in the sequence.
      expect(JSON.stringify(sequence)).not.toContain(ENV_SECRET);
      expect(JSON.stringify(sequence)).not.toContain(CONTROL_TOKEN);
      expect(sequence).toEqual(EXPECTED);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
