/**
 * A restart decides everything its start would refuse before it stops the running daemon,
 * and an automatic start of a launch that runs the saved spec runs only the active spec.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_CODES } from "@crewhaus/errors";
import { specRevision } from "@crewhaus/ir/policy";
import { type PreflightItem, buildReport, workspaceItems } from "@crewhaus/preflight";
import { SPEC_NOT_ACTIVE_MESSAGE, buildLinkMessage, verifyActiveBuild } from "./active-build";
import { type GateDecision, type GateOptions, evaluateGate } from "./gate";
import { compileActiveRevision, createPrepareRunner, forecastCompile } from "./prepare";
import { buildSpawnPlan } from "./spawn-contracts";
import { automaticSpecRefusal } from "./start-decision";
import { type AdmitAnswer, type SupervisorOptions, createHarnessSupervisor } from "./supervisor";
import { activateBuildForTest, createFakeClock, createFakeProcessOps } from "./testkit";

const roots: string[] = [];
function harness(target = "channel"): string {
  const dir = mkdtempSync(join(tmpdir(), "chsup-decide-"));
  roots.push(dir);
  put(dir, "crewhaus.yaml", `name: demo\ntarget: ${target}\n`);
  put(dir, `dist/${target === "channel" ? "daemon.ts" : "agent.ts"}`, "// bundle\n");
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function put(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

/** Every file under the harness's `.crewhaus`, with its bytes. */
function controlTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string): void => {
    const abs = join(dir, rel);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else out[child] = readFileSync(join(dir, child), "utf8");
    }
  };
  walk(".crewhaus");
  return out;
}

const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A gate over the real workspace check, with the real acknowledgement rules. */
function workspaceGate(dir: string, env: Record<string, string>) {
  return async (options: GateOptions): Promise<GateDecision> =>
    evaluateGate(buildReport(workspaceItems(dir, env)), options);
}

/** A home directory inside the harness, as the gate's environment names it. */
function homeInside(dir: string): Record<string, string> {
  mkdirSync(join(dir, "home"), { recursive: true });
  return { HOME: join(dir, "home") };
}

function portItem(port: number): PreflightItem {
  return {
    id: `ports.${port}`,
    area: "ports",
    level: "blocking",
    message: `port ${port} is in use`,
  };
}

function supervise(
  dir: string,
  options: Partial<Pick<SupervisorOptions, "gate" | "prepare" | "admit" | "plan">> & {
    readonly target?: string;
  } = {},
) {
  const target = options.target ?? "channel";
  const clock = createFakeClock();
  const ops = createFakeProcessOps({ now: clock.now });
  let seq = 0;
  let stops = 0;
  const supervisor = createHarnessSupervisor({
    harnessDir: dir,
    target,
    ops: {
      ...ops,
      terminate: (pid) => {
        stops += 1;
        ops.terminate(pid);
      },
    },
    clock,
    plan:
      options.plan ??
      (() =>
        buildSpawnPlan({
          harnessDir: dir,
          target,
          processEnv: {},
          ports: { port: 3000, controlPort: 3001 },
        })),
    managerVersion: "0.9.0-test",
    newRunId: () => `run_${String(++seq).padStart(16, "0")}`,
    ...(options.gate !== undefined ? { gate: options.gate } : {}),
    ...(options.prepare !== undefined ? { prepare: options.prepare } : {}),
    ...(options.admit !== undefined ? { admit: options.admit } : {}),
  });
  return { clock, ops, supervisor, stops: () => stops };
}

/** Restart; a fake child exits on the stop's SIGTERM. */
function restart(h: ReturnType<typeof supervise>, gateOptions?: GateOptions) {
  return h.supervisor.restart(gateOptions);
}

describe("a restart that would be refused leaves the daemon running", () => {
  test("a directory holding the home directory, unacknowledged", async () => {
    const dir = harness();
    activateBuildForTest(dir, "dist/daemon.ts");
    const h = supervise(dir, { gate: workspaceGate(dir, homeInside(dir)) });
    expect(await h.supervisor.start({ acknowledge: ["workspace.holds-home"] })).toMatchObject({
      ok: true,
    });
    const before = controlTree(dir);
    const result = await restart(h);
    expect(result).toMatchObject({ ok: false, reason: "preflight-blocked", kept: true });
    if (result.ok || result.reason !== "preflight-blocked") throw new Error("unreachable");
    expect(result.gate.refused.map((item) => item.id)).toEqual(["workspace.holds-home"]);
    expect(h.stops()).toBe(0);
    expect(h.ops.children).toHaveLength(1);
    expect(h.ops.last()?.alive).toBe(true);
    expect(h.supervisor.snapshot().state).toBe("running");
    expect(controlTree(dir)).toEqual(before);
    // Acknowledged for this restart, it goes ahead.
    expect(await restart(h, { acknowledge: ["workspace.holds-home"] })).toMatchObject({
      ok: true,
    });
    expect(h.stops()).toBe(1);
    expect(h.ops.children).toHaveLength(2);
  });

  test("an active-only start whose build is not the active one", async () => {
    const dir = harness();
    put(dir, ".crewhaus/settings.json", JSON.stringify({ manager: { autoCompile: true } }));
    activateBuildForTest(dir, "dist/daemon.ts", {
      specHash: specRevision("name: demo\ntarget: channel\n"),
    });
    let admitted = 0;
    const h = supervise(dir, {
      prepare: () =>
        createPrepareRunner({
          harnessDir: dir,
          target: "channel",
          ops: createFakeProcessOps(),
          env: {},
          crewhausBin: "/bin/crewhaus",
        }),
      admit: async () => {
        admitted += 1;
        return { ok: true };
      },
    });
    expect(await h.supervisor.start()).toMatchObject({ ok: true });
    // A saved edit (so no compile runs) and a changed build.
    put(dir, "crewhaus.yaml", "name: demo\ntarget: channel\n# a saved edit\n");
    put(dir, "dist/daemon.ts", "// changed by hand\n");
    const result = await restart(h);
    expect(result).toMatchObject({ ok: false, reason: "build-not-active", kept: true });
    expect(admitted).toBe(0);
    expect(h.stops()).toBe(0);
    expect(h.ops.last()?.alive).toBe(true);
  });

  test("the head's admission, asked to decide only, refuses", async () => {
    const dir = harness();
    const requests: Array<{ readonly decideOnly: boolean }> = [];
    let refuse = false;
    const h = supervise(dir, {
      admit: async (request): Promise<AdmitAnswer> => {
        requests.push({ decideOnly: request.decideOnly });
        return refuse ? { ok: false, message: "not this build" } : { ok: true };
      },
    });
    expect(await h.supervisor.start()).toMatchObject({ ok: true });
    expect(requests).toEqual([{ decideOnly: false }]);
    refuse = true;
    const before = controlTree(dir);
    const result = await restart(h);
    expect(result).toEqual({
      ok: false,
      reason: "build-not-active",
      message: "not this build",
      kept: true,
    });
    expect(requests).toEqual([{ decideOnly: false }, { decideOnly: true }]);
    expect(h.stops()).toBe(0);
    expect(h.ops.children).toHaveLength(1);
    // A refused restart writes nothing: no run row, no deployment row.
    expect(controlTree(dir)).toEqual(before);
  });

  test("a plan that cannot be built", async () => {
    const dir = harness();
    let fail = false;
    const h = supervise(dir, {
      plan: () => {
        if (fail) throw new Error("no compiled bundle");
        return buildSpawnPlan({ harnessDir: dir, target: "channel", processEnv: {} });
      },
    });
    expect(await h.supervisor.start()).toMatchObject({ ok: true });
    fail = true;
    const result = await restart(h);
    expect(result).toMatchObject({ ok: false, reason: "plan-failed", stage: "plan", kept: true });
    expect(h.stops()).toBe(0);
    expect(h.ops.last()?.alive).toBe(true);
  });

  test("a port the running daemon holds does not refuse before the stop", async () => {
    const dir = harness();
    // The first daemon holds port 3000 while it lives.
    const first: { pid?: number } = {};
    const h = supervise(dir, {
      gate: async (options) =>
        evaluateGate(
          buildReport(
            first.pid !== undefined && h.ops.isAlive(first.pid) === true ? [portItem(3000)] : [],
          ),
          options,
        ),
    });
    expect(await h.supervisor.start()).toMatchObject({ ok: true });
    first.pid = h.ops.last()?.pid;
    const result = await restart(h);
    expect(result).toMatchObject({ ok: true });
    expect(h.stops()).toBe(1);
    expect(h.ops.children).toHaveLength(2);
  });

  test("with no daemon running, a restart is a start", async () => {
    const dir = harness();
    activateBuildForTest(dir, "dist/daemon.ts");
    const h = supervise(dir, { gate: workspaceGate(dir, homeInside(dir)) });
    const result = await h.supervisor.restart();
    expect(result).toMatchObject({ ok: false, reason: "preflight-blocked" });
    expect(result.ok === false && result.kept).toBeUndefined();
    expect(await h.supervisor.restart({ acknowledge: ["workspace.holds-home"] })).toMatchObject({
      ok: true,
    });
    expect(h.ops.children).toHaveLength(1);
  });
});

describe("while a deployment is active, an automatic restart runs only its spec", () => {
  const SPEC = "name: demo\ntarget: cli\n";
  // The plans are marked supervised, so a crash schedules the automatic start the check
  // runs in.
  function interpreter(dir: string) {
    return supervise(dir, {
      target: "cli",
      plan: () => ({
        ...buildSpawnPlan({
          harnessDir: dir,
          target: "cli",
          processEnv: {},
          crewhausBin: "/bin/crewhaus",
        }),
        supervised: true,
      }),
    });
  }
  async function crash(h: ReturnType<typeof supervise>): Promise<void> {
    h.ops.last()?.exit(EXIT_CODES.tool);
    await tick();
    h.clock.advance(30_000);
    await tick();
  }

  test("a saved spec that is not the active one: the restart spawns nothing and says why", async () => {
    const dir = harness("cli");
    activateBuildForTest(dir, "dist/agent.ts", { specHash: specRevision(SPEC) });
    const h = interpreter(dir);
    expect(await h.supervisor.start()).toMatchObject({ ok: true });
    expect(h.ops.last()?.request.argv).toContain("run");
    put(dir, "crewhaus.yaml", `${SPEC}# edited after activation\n`);
    await crash(h);
    expect(h.ops.children).toHaveLength(1);
    const snapshot = h.supervisor.snapshot();
    expect(snapshot.state).toBe("stopped");
    expect(snapshot.refusal).toMatchObject({
      reason: "build-not-active",
      message: SPEC_NOT_ACTIVE_MESSAGE,
    });
  });

  test("the active spec: the restart spawns", async () => {
    const dir = harness("cli");
    activateBuildForTest(dir, "dist/agent.ts", { specHash: specRevision(SPEC) });
    const h = interpreter(dir);
    await h.supervisor.start();
    await crash(h);
    expect(h.ops.children).toHaveLength(2);
  });

  test("no deployment: the restart spawns", async () => {
    const dir = harness("cli");
    const h = interpreter(dir);
    await h.supervisor.start();
    put(dir, "crewhaus.yaml", `${SPEC}# edited\n`);
    await crash(h);
    expect(h.ops.children).toHaveLength(2);
  });

  test("a person's start of an edited spec is not refused", async () => {
    const dir = harness("cli");
    activateBuildForTest(dir, "dist/agent.ts", { specHash: specRevision(SPEC) });
    put(dir, "crewhaus.yaml", `${SPEC}# edited after activation\n`);
    const h = interpreter(dir);
    expect(await h.supervisor.start()).toMatchObject({ ok: true });
  });

  test("an mcp-server launch is held to the same rule", async () => {
    const dir = harness("cli");
    activateBuildForTest(dir, "dist/agent.ts", { specHash: specRevision(SPEC) });
    const h = supervise(dir, {
      plan: () => ({
        ...buildSpawnPlan({
          harnessDir: dir,
          target: "cli",
          runClass: "mcp-server",
          processEnv: {},
          crewhausBin: "/bin/crewhaus",
        }),
        supervised: true,
      }),
    });
    expect(await h.supervisor.start()).toMatchObject({ ok: true });
    expect(h.ops.last()?.request.argv).toContain("--mcp");
    put(dir, "crewhaus.yaml", `${SPEC}# edited after activation\n`);
    await crash(h);
    expect(h.ops.children).toHaveLength(1);
    expect(h.supervisor.snapshot().refusal?.message).toBe(SPEC_NOT_ACTIVE_MESSAGE);
  });
});

describe("automaticSpecRefusal", () => {
  const SPEC = "name: demo\ntarget: cli\n";
  test("no record, the active spec, another spec, no spec, an active record naming none", () => {
    const dir = harness("cli");
    const specPath = join(dir, "crewhaus.yaml");
    expect(automaticSpecRefusal(dir, specPath)).toBeUndefined();
    activateBuildForTest(dir, "dist/agent.ts", { specHash: specRevision(SPEC) });
    expect(automaticSpecRefusal(dir, specPath)).toBeUndefined();
    put(dir, "crewhaus.yaml", `${SPEC}# edited\n`);
    expect(automaticSpecRefusal(dir, specPath)).toBe(SPEC_NOT_ACTIVE_MESSAGE);
    expect(automaticSpecRefusal(dir, undefined)).toBe(SPEC_NOT_ACTIVE_MESSAGE);
    expect(automaticSpecRefusal(dir, join(dir, "missing.yaml"))).toBe(SPEC_NOT_ACTIVE_MESSAGE);
    const other = harness("cli");
    activateBuildForTest(other, "dist/agent.ts", { specHash: "" });
    expect(automaticSpecRefusal(other, join(other, "crewhaus.yaml"))).toBe(SPEC_NOT_ACTIVE_MESSAGE);
  });

  test("records that cannot be read refuse", () => {
    const dir = harness("cli");
    mkdirSync(join(dir, ".crewhaus/run/control/deployments.jsonl"), { recursive: true });
    expect(automaticSpecRefusal(dir, join(dir, "crewhaus.yaml"))).toContain("can't be read");
  });
});

describe("forecastCompile decides what the compile step would, without compiling", () => {
  const SPEC = "name: demo\ntarget: channel\n";
  const deps = (dir: string) => ({
    harnessDir: dir,
    target: "channel",
    ops: createFakeProcessOps(),
    env: {},
    crewhausBin: "/bin/crewhaus",
  });

  test("no compile asked for: nothing may compile, and the start is not active-only", () => {
    expect(forecastCompile(deps(harness()), false)).toEqual({
      compileMayRun: false,
      activeOnly: false,
    });
  });

  test("autoCompile with the active build on disk: no compile, active-only", () => {
    const dir = harness();
    activateBuildForTest(dir, "dist/daemon.ts", { specHash: specRevision(SPEC) });
    expect(forecastCompile(deps(dir), "auto")).toEqual({ compileMayRun: false, activeOnly: true });
  });

  test("autoCompile with a saved spec that is not active: no compile, active-only", () => {
    const dir = harness();
    activateBuildForTest(dir, "dist/daemon.ts", { specHash: specRevision(SPEC) });
    put(dir, "crewhaus.yaml", `${SPEC}# saved edit\n`);
    put(dir, "dist/daemon.ts", "// changed\n");
    expect(forecastCompile(deps(dir), "auto")).toEqual({ compileMayRun: false, activeOnly: true });
  });

  test("autoCompile with the active revision's build changed: it may compile", () => {
    const dir = harness();
    activateBuildForTest(dir, "dist/daemon.ts", { specHash: specRevision(SPEC) });
    put(dir, "dist/daemon.ts", "// changed\n");
    expect(forecastCompile(deps(dir), "auto")).toEqual({ compileMayRun: true, activeOnly: true });
  });

  test("an explicit compile of a bundle stamped from another spec may compile", () => {
    const dir = harness();
    put(
      dir,
      "dist/package.json",
      JSON.stringify({
        name: "crewhaus-compiled-bundle",
        crewhaus: { specHash: specRevision("name: other\n") },
      }),
    );
    expect(forecastCompile(deps(dir), "explicit")).toEqual({
      compileMayRun: true,
      activeOnly: false,
    });
  });
});

describe("a restart whose start compiles first decides its build after the compile", () => {
  const SPEC = "name: demo\ntarget: channel\n";

  /**
   * A supervisor whose stops and compiles land in one ordered list. A compile's child
   * exits 1 at once, so its start ends at the compile and spawns no daemon.
   */
  function ordered(dir: string, compile: true | undefined, admit?: SupervisorOptions["admit"]) {
    const events: string[] = [];
    const clock = createFakeClock();
    const ops = createFakeProcessOps({ now: clock.now });
    const compileOps = createFakeProcessOps();
    const runnerOps = {
      ...compileOps,
      spawn: (request: Parameters<typeof compileOps.spawn>[0]) => {
        events.push(`spawn ${request.argv.slice(1).join(" ")}`);
        const spawned = compileOps.spawn(request);
        compileOps.last()?.exit(1);
        return spawned;
      },
    };
    const supervisor = createHarnessSupervisor({
      harnessDir: dir,
      target: "channel",
      ops: {
        ...ops,
        terminate: (pid) => {
          events.push(`SIGTERM ${pid}`);
          ops.terminate(pid);
        },
      },
      clock,
      plan: () =>
        buildSpawnPlan({
          harnessDir: dir,
          target: "channel",
          processEnv: {},
          ports: { port: 3000, controlPort: 3001 },
        }),
      managerVersion: "0.9.0-test",
      prepare: () =>
        createPrepareRunner({
          harnessDir: dir,
          target: "channel",
          ops: runnerOps,
          env: {},
          crewhausBin: "/bin/crewhaus",
          ...(compile !== undefined ? { compile } : {}),
        }),
      ...(admit !== undefined ? { admit } : {}),
    });
    return { events, ops, supervisor };
  }

  test("autoCompile, the active revision's build changed: the stop comes before the compile", async () => {
    const dir = harness();
    put(dir, ".crewhaus/settings.json", JSON.stringify({ manager: { autoCompile: true } }));
    activateBuildForTest(dir, "dist/daemon.ts", { specHash: specRevision(SPEC) });
    const h = ordered(dir, undefined);
    expect(await h.supervisor.start()).toMatchObject({ ok: true });
    const daemon = h.ops.last()?.pid;
    expect(h.events).toEqual([]);
    put(dir, "dist/daemon.ts", "// changed by hand\n");
    const result = await h.supervisor.restart();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.kept).toBeUndefined();
    const stop = h.events.indexOf(`SIGTERM ${daemon}`);
    const compile = h.events.findIndex((e) => e.startsWith("spawn compile"));
    expect(stop).toBeGreaterThan(-1);
    expect(compile).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(compile);
  });

  test("an explicit compile of a stale bundle from Home: the stop comes before the compile", async () => {
    const dir = harness();
    const asked: boolean[] = [];
    const h = ordered(dir, true, async (request) => {
      asked.push(request.decideOnly);
      return { ok: true };
    });
    expect(await h.supervisor.start()).toMatchObject({ ok: true });
    expect(asked).toEqual([false]);
    const daemon = h.ops.last()?.pid;
    // The bundle is stamped from another spec, so the compile step compiles.
    put(
      dir,
      "dist/package.json",
      JSON.stringify({
        name: "crewhaus-compiled-bundle",
        crewhaus: { specHash: specRevision("name: other\n") },
      }),
    );
    const result = await h.supervisor.restart();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.kept).toBeUndefined();
    // The admission is the start's own, after its compile: never asked before the stop.
    expect(asked).toEqual([false]);
    const stop = h.events.indexOf(`SIGTERM ${daemon}`);
    const compile = h.events.findIndex((e) => e.startsWith("spawn compile"));
    expect(stop).toBeGreaterThan(-1);
    expect(compile).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(compile);
  });
});

describe.skipIf(process.platform === "win32")("an active build whose files hold a link", () => {
  const SPEC = "name: demo\ntarget: channel\n";
  const deps = (dir: string, ops = createFakeProcessOps()) => ({
    harnessDir: dir,
    target: "channel",
    ops,
    env: {},
    crewhausBin: "/bin/crewhaus",
  });

  /** Replace the active build's entry with a link, and activate the build over the link. */
  function linkTheActiveBuild(dir: string): void {
    const outside = mkdtempSync(join(tmpdir(), "chsup-decide-outside-"));
    roots.push(outside);
    put(outside, "daemon.ts", "// bundle\n");
    unlinkSync(join(dir, "dist/daemon.ts"));
    symlinkSync(join(outside, "daemon.ts"), join(dir, "dist/daemon.ts"));
    activateBuildForTest(dir, "dist/daemon.ts", {
      id: "dep_01linklinklinklinklinklink",
      specHash: specRevision(SPEC),
      at: "2026-11-02T00:00:00.000Z",
    });
    expect(verifyActiveBuild(dir, "channel")).toMatchObject({ ok: false, reason: "link" });
  }

  test("autoCompile compiles nothing for it, and the start runs only the active build", async () => {
    const dir = harness();
    activateBuildForTest(dir, "dist/daemon.ts", { specHash: specRevision(SPEC) });
    linkTheActiveBuild(dir);
    expect(forecastCompile(deps(dir), "auto")).toEqual({ compileMayRun: false, activeOnly: true });
    const ops = createFakeProcessOps();
    const outcome = await compileActiveRevision(deps(dir, ops));
    expect(outcome).toMatchObject({ ok: true, replan: false, activeOnly: true });
    expect(ops.children).toHaveLength(0);
  });

  test("a restart under autoCompile refuses before its stop, naming the link", async () => {
    const dir = harness();
    put(dir, ".crewhaus/settings.json", JSON.stringify({ manager: { autoCompile: true } }));
    activateBuildForTest(dir, "dist/daemon.ts", { specHash: specRevision(SPEC) });
    const compiles = createFakeProcessOps();
    const h = supervise(dir, { prepare: () => createPrepareRunner(deps(dir, compiles)) });
    expect(await h.supervisor.start()).toMatchObject({ ok: true });
    linkTheActiveBuild(dir);
    const result = await restart(h);
    expect(result).toEqual({
      ok: false,
      reason: "build-not-active",
      message: buildLinkMessage("dist/daemon.ts"),
      kept: true,
    });
    expect(h.stops()).toBe(0);
    expect(h.ops.last()?.signals).toEqual([]);
    expect(h.ops.children).toHaveLength(1);
    expect(compiles.children).toHaveLength(0);
  });
});
