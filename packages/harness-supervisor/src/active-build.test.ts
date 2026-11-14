/**
 * Starts and the active deployment: an automatic start runs only the active build, a
 * person's start goes through its head's admission, the spawn carries the deployment's
 * ids, the restart window outlives its manager, and env files never supply a loader
 * setting.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { EXIT_CODES } from "@crewhaus/errors";
import { specRevision } from "@crewhaus/ir/policy";
import {
  BUILD_NOT_ACTIVE_MESSAGE,
  NO_ACTIVE_BUILD_MESSAGE,
  activeDeployment,
  buildLinkMessage,
  buildLinkRefusal,
  verifyActiveBuild,
} from "./active-build";
import { type PrepareOutcome, type PrepareRunner, createPrepareRunner } from "./prepare";
import type { ProcessOps, SpawnRequest, SpawnedProcess } from "./process-ops";
import { readRunfile } from "./runfiles";
import {
  LOADER_ENV_KEYS,
  LOADER_ENV_PREFIXES,
  buildSpawnEnv,
  buildSpawnPlan,
  isLoaderEnvKey,
  loadEnvChain,
  resolveBundle,
} from "./spawn-contracts";
import { type AdmitAnswer, type SupervisorOptions, createHarnessSupervisor } from "./supervisor";
import { activateBuildForTest, createFakeClock, createFakeProcessOps } from "./testkit";

const roots: string[] = [];
function harness(target = "channel", env = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "chsup-active-"));
  roots.push(dir);
  put(dir, "crewhaus.yaml", `name: demo\ntarget: ${target}\n`);
  put(dir, `dist/${target === "channel" ? "daemon.ts" : "agent.ts"}`, "// bundle\n");
  if (env !== "") put(dir, ".env", env);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function put(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

function supervise(
  dir: string,
  options: {
    admit?: SupervisorOptions["admit"];
    prepare?: () => PrepareRunner;
    processEnv?: Record<string, string>;
    maxRestarts?: number;
  } = {},
) {
  const clock = createFakeClock();
  const ops = createFakeProcessOps({ now: clock.now });
  let seq = 0;
  const supervisor = createHarnessSupervisor({
    harnessDir: dir,
    target: "channel",
    ops,
    clock,
    plan: () =>
      buildSpawnPlan({
        harnessDir: dir,
        target: "channel",
        processEnv: options.processEnv ?? {},
        ports: { port: 3000, controlPort: 3001 },
      }),
    managerVersion: "0.9.0-test",
    newRunId: () => `run_${String(++seq).padStart(16, "0")}`,
    ...(options.admit !== undefined ? { admit: options.admit } : {}),
    ...(options.prepare !== undefined ? { prepare: options.prepare } : {}),
    ...(options.maxRestarts !== undefined ? { maxRestarts: options.maxRestarts } : {}),
  });
  return { clock, ops, supervisor };
}

describe("verifyActiveBuild", () => {
  test("no-active with no record, ok for the active build, mismatch once dist/ changes", () => {
    const dir = harness();
    expect(verifyActiveBuild(dir, "channel")).toMatchObject({
      ok: false,
      reason: "no-active",
      message: NO_ACTIVE_BUILD_MESSAGE,
    });
    const { id } = activateBuildForTest(dir, "dist/daemon.ts");
    const ok = verifyActiveBuild(dir, "channel");
    expect(ok.ok && ok.deployment.id).toBe(id);
    put(dir, "dist/planted.ts", "x\n");
    expect(verifyActiveBuild(dir, "channel")).toEqual({
      ok: false,
      reason: "mismatch",
      message: BUILD_NOT_ACTIVE_MESSAGE,
    });
  });

  test("a build holding a link is refused with reason link, naming it", () => {
    const dir = harness();
    const outside = mkdtempSync(join(tmpdir(), "chsup-active-outside-"));
    roots.push(outside);
    put(outside, "daemon.ts", "// bundle\n");
    // The record's digest is taken over the link itself, so only the link refuses.
    unlinkSync(join(dir, "dist/daemon.ts"));
    symlinkSync(join(outside, "daemon.ts"), join(dir, "dist/daemon.ts"));
    activateBuildForTest(dir, "dist/daemon.ts");
    const message = buildLinkMessage("dist/daemon.ts");
    expect(message).toBe(
      "The build holds a link at dist/daemon.ts. A build runs from regular files only: replace it with the file, then run crewhaus compile and crewhaus deploy activate.",
    );
    expect(verifyActiveBuild(dir, "channel")).toEqual({ ok: false, reason: "link", message });
    expect(buildLinkRefusal(dir, { entry: "dist/daemon.ts" })).toBe(message);
  });

  test("a regular build holds no link to refuse", () => {
    const dir = harness();
    expect(buildLinkRefusal(dir, { entry: "dist/daemon.ts" })).toBeUndefined();
  });

  test("unreadable when the records cannot be read", () => {
    const dir = harness();
    mkdirSync(join(dir, ".crewhaus/run/control/deployments.jsonl"), { recursive: true });
    expect(verifyActiveBuild(dir, "channel")).toMatchObject({ ok: false, reason: "unreadable" });
  });
});

describe("an automatic restart runs only the active build", () => {
  test("dist/ changed after activation: the restart spawns nothing and says why", async () => {
    const dir = harness();
    activateBuildForTest(dir, "dist/daemon.ts");
    const { clock, ops, supervisor } = supervise(dir);
    expect((await supervisor.start()).ok).toBe(true);
    expect(ops.children).toHaveLength(1);
    put(dir, "dist/daemon.ts", "// edited after activation\n");
    ops.last()?.exit(EXIT_CODES.tool);
    await tick();
    clock.advance(30_000);
    await tick();
    expect(ops.children).toHaveLength(1);
    const snapshot = supervisor.snapshot();
    expect(snapshot.state).toBe("stopped");
    expect(snapshot.refusal?.message).toBe(BUILD_NOT_ACTIVE_MESSAGE);
  });

  test("dist/ unchanged: the restart spawns", async () => {
    const dir = harness();
    activateBuildForTest(dir, "dist/daemon.ts");
    const { clock, ops, supervisor } = supervise(dir);
    await supervisor.start();
    ops.last()?.exit(EXIT_CODES.tool);
    await tick();
    clock.advance(30_000);
    await tick();
    expect(ops.children).toHaveLength(2);
    expect(supervisor.snapshot().state).toBe("running");
  });
});

describe("the build check covers the entry the launch runs", () => {
  function buildDirHarness(): string {
    const dir = harness();
    rmSync(join(dir, "dist"), { recursive: true, force: true });
    put(dir, "build/daemon.ts", "// bundle in build/\n");
    activateBuildForTest(dir, "build/daemon.ts");
    return dir;
  }

  test("verifyActiveBuild answers mismatch when the launch resolves to another entry", () => {
    const dir = buildDirHarness();
    expect(verifyActiveBuild(dir, "channel").ok).toBe(true);
    put(dir, "dist/daemon.ts", "// a build nobody activated\n");
    expect(verifyActiveBuild(dir, "channel")).toEqual({
      ok: false,
      reason: "mismatch",
      message: BUILD_NOT_ACTIVE_MESSAGE,
    });
    expect(verifyActiveBuild(dir, undefined, "build/daemon.ts").ok).toBe(true);
    expect(verifyActiveBuild(dir, undefined, "dist/daemon.ts").ok).toBe(false);
  });

  test("an active build/ bundle, then a dist/ one appears: the restart spawns nothing", async () => {
    const dir = buildDirHarness();
    const { clock, ops, supervisor } = supervise(dir);
    expect((await supervisor.start()).ok).toBe(true);
    expect(ops.last()?.request.argv.at(-1)).toBe(join(dir, "build", "daemon.ts"));
    put(dir, "dist/daemon.ts", "// a build nobody activated\n");
    ops.last()?.exit(EXIT_CODES.tool);
    await tick();
    clock.advance(30_000);
    await tick();
    expect(ops.children).toHaveLength(1);
    expect(supervisor.snapshot().refusal?.message).toBe(BUILD_NOT_ACTIVE_MESSAGE);
  });

  test("a person's start admitted for another entry than the one it launches is refused", async () => {
    const dir = buildDirHarness();
    put(dir, "dist/daemon.ts", "// a build nobody activated\n");
    const admit = async (): Promise<AdmitAnswer> => {
      const active = activeDeployment(dir);
      return active === undefined
        ? { ok: false, message: "none" }
        : { ok: true, deployment: active };
    };
    const { ops, supervisor } = supervise(dir, { admit });
    expect(await supervisor.start()).toEqual({
      ok: false,
      reason: "build-not-active",
      message: BUILD_NOT_ACTIVE_MESSAGE,
    });
    expect(ops.children).toHaveLength(0);
  });

  test("the head is told which entry the launch runs and whether the harness had records", async () => {
    const dir = buildDirHarness();
    const seen: Array<{ entry: string; ledgerAbsent: boolean }> = [];
    const { supervisor } = supervise(dir, {
      admit: async (request) => {
        seen.push({ entry: request.entry, ledgerAbsent: request.ledgerAbsent });
        const check = verifyActiveBuild(dir, "channel", request.entry);
        return check.ok ? { ok: true, deployment: check.deployment } : check;
      },
    });
    expect((await supervisor.start()).ok).toBe(true);
    expect(seen).toEqual([{ entry: "build/daemon.ts", ledgerAbsent: false }]);
  });
});

describe("a person's start", () => {
  test("goes through admission, after the preSpawn hook", async () => {
    const dir = harness();
    activateBuildForTest(dir, "dist/daemon.ts");
    let order: string[] = [];
    const prepare = (): PrepareRunner => ({
      configured: { compile: false, compileMode: false, hooks: ["preSpawn"] },
      prepare: async (): Promise<PrepareOutcome> => ({ ok: true, replan: false, notes: [] }),
      preSpawn: async (): Promise<PrepareOutcome> => {
        order.push("preSpawn");
        put(dir, "dist/daemon.ts", "// a hook wrote the bundle\n");
        return { ok: true, replan: false, notes: [] };
      },
    });
    const admit = async (): Promise<AdmitAnswer> => {
      order.push("admit");
      const check = verifyActiveBuild(dir, "channel");
      return check.ok ? { ok: true, deployment: check.deployment } : check;
    };
    const { ops, supervisor } = supervise(dir, { prepare, admit });
    const result = await supervisor.start();
    expect(order).toEqual(["preSpawn", "admit"]);
    expect(result).toEqual({
      ok: false,
      reason: "build-not-active",
      message: BUILD_NOT_ACTIVE_MESSAGE,
    });
    expect(ops.children).toHaveLength(0);
    order = [];
  });

  test("an admitted start clears an earlier refusal", async () => {
    const dir = harness();
    let allow = false;
    const admit = async (): Promise<AdmitAnswer> =>
      allow ? { ok: true } : { ok: false, message: "not yet" };
    const { supervisor } = supervise(dir, { admit });
    expect((await supervisor.start()).ok).toBe(false);
    expect(supervisor.snapshot().refusal?.message).toBe("not yet");
    allow = true;
    expect((await supervisor.start()).ok).toBe(true);
    expect(supervisor.snapshot().refusal).toBeUndefined();
  });
});

describe("a launch that runs no compiled bundle", () => {
  test("an interpreter launch is not a build to admit", async () => {
    const dir = harness("cli");
    const clock = createFakeClock();
    const ops = createFakeProcessOps({ now: clock.now });
    let admitted = 0;
    const supervisor = createHarnessSupervisor({
      harnessDir: dir,
      target: "cli",
      ops,
      clock,
      plan: () =>
        buildSpawnPlan({
          harnessDir: dir,
          target: "cli",
          processEnv: {},
          crewhausBin: "/bin/crewhaus",
        }),
      admit: async () => {
        admitted += 1;
        return { ok: false, message: "not reached" };
      },
    });
    expect((await supervisor.start()).ok).toBe(true);
    expect(admitted).toBe(0);
    supervisor.close();
  });
});

describe("manager.autoCompile rebuilds only the active revision", () => {
  function countingOps(): ProcessOps & { compiles: number } {
    const base = createFakeProcessOps();
    const ops = {
      ...base,
      compiles: 0,
      spawn: (request: SpawnRequest): SpawnedProcess => {
        if (request.argv.includes("compile")) ops.compiles += 1;
        return base.spawn(request);
      },
    };
    return ops;
  }

  test("a saved revision that is not the active one compiles nothing and runs the active build", async () => {
    const dir = harness();
    put(dir, ".crewhaus/settings.json", JSON.stringify({ manager: { autoCompile: true } }));
    activateBuildForTest(dir, "dist/daemon.ts", {
      specHash: specRevision("name: demo\ntarget: channel\n"),
    });
    put(dir, "crewhaus.yaml", "name: demo\ntarget: channel\n# a saved edit\n");
    const ops = countingOps();
    const runner = createPrepareRunner({
      harnessDir: dir,
      target: "channel",
      ops,
      env: {},
      crewhausBin: "/bin/crewhaus",
    });
    const outcome = await runner.prepare();
    expect(ops.compiles).toBe(0);
    expect(outcome.ok && outcome.activeOnly).toBe(true);
    expect(outcome.ok && outcome.notes.join("\n")).toContain("the saved revision isn't active");
  });

  test("the start it governs refuses a build that is not the active one", async () => {
    const dir = harness();
    put(dir, ".crewhaus/settings.json", JSON.stringify({ manager: { autoCompile: true } }));
    activateBuildForTest(dir, "dist/daemon.ts", {
      specHash: specRevision("name: demo\ntarget: channel\n"),
    });
    put(dir, "crewhaus.yaml", "name: demo\ntarget: channel\n# a saved edit\n");
    put(dir, "dist/daemon.ts", "// changed by hand\n");
    const ops = countingOps();
    const prepare = (): PrepareRunner =>
      createPrepareRunner({
        harnessDir: dir,
        target: "channel",
        ops,
        env: {},
        crewhausBin: undefined,
      });
    let admitted = 0;
    const { supervisor } = supervise(dir, {
      prepare,
      admit: async () => {
        admitted += 1;
        return { ok: true };
      },
    });
    const result = await supervisor.start();
    expect(result).toMatchObject({ ok: false, reason: "build-not-active" });
    // The active-only check decides, not the head's admission.
    expect(admitted).toBe(0);
    expect(ops.compiles).toBe(0);
  });
});

describe("the spawn carries the active deployment", () => {
  test("both ids from the record, with the run ledger on and off", async () => {
    for (const ledger of ["", "CREWHAUS_RUN_LEDGER=0\n"]) {
      const dir = harness("channel", ledger);
      const specHash = `sha256:${"a".repeat(64)}`;
      const { id } = activateBuildForTest(dir, "dist/daemon.ts", { specHash });
      const { ops, supervisor } = supervise(dir);
      expect((await supervisor.start()).ok).toBe(true);
      const env = ops.last()?.request.env ?? {};
      expect(env["CREWHAUS_DEPLOYMENT_ID"]).toBe(id);
      expect(env["CREWHAUS_SPEC_HASH"]).toBe(specHash);
      const runfile = readRunfile(dir);
      expect(runfile?.deployment).toBe(id);
      expect(runfile?.specHash).toBe(specHash);
      expect(runfile?.artifactDigest).toBe(activeDeployment(dir)?.digest as string);
    }
  });

  test("with no record, a .env line or the manager's environment never supplies them", async () => {
    const dir = harness("channel", "CREWHAUS_DEPLOYMENT_ID=dep_01aaaaaaaaaaaaaaaaaaaaaaaa\n");
    const { ops, supervisor } = supervise(dir, {
      processEnv: { CREWHAUS_SPEC_HASH: "sha256:forged" },
    });
    expect((await supervisor.start()).ok).toBe(true);
    const env = ops.last()?.request.env ?? {};
    expect(env["CREWHAUS_DEPLOYMENT_ID"]).toBeUndefined();
    expect(env["CREWHAUS_SPEC_HASH"]).toBeUndefined();
    expect(readRunfile(dir)?.deployment).toBeUndefined();
  });
});

describe("the spawn carries only a deployment the launch was checked against", () => {
  const SPEC = "name: demo\ntarget: cli\n";
  function interpreter(dir: string) {
    const clock = createFakeClock();
    const ops = createFakeProcessOps({ now: clock.now });
    const supervisor = createHarnessSupervisor({
      harnessDir: dir,
      target: "cli",
      ops,
      clock,
      plan: () =>
        buildSpawnPlan({
          harnessDir: dir,
          target: "cli",
          processEnv: {},
          crewhausBin: "/bin/crewhaus",
        }),
    });
    return { ops, supervisor };
  }

  test("an interpreter launch of the active revision carries both ids", async () => {
    const dir = harness("cli");
    const { id } = activateBuildForTest(dir, "dist/agent.ts", { specHash: specRevision(SPEC) });
    const { ops, supervisor } = interpreter(dir);
    expect((await supervisor.start()).ok).toBe(true);
    expect(ops.last()?.request.argv).toContain("run");
    const env = ops.last()?.request.env ?? {};
    expect(env["CREWHAUS_DEPLOYMENT_ID"]).toBe(id);
    expect(env["CREWHAUS_SPEC_HASH"]).toBe(specRevision(SPEC));
    supervisor.close();
  });

  test("an interpreter launch of an edited spec carries neither", async () => {
    const dir = harness("cli");
    activateBuildForTest(dir, "dist/agent.ts", { specHash: specRevision(SPEC) });
    put(dir, "crewhaus.yaml", `${SPEC}# edited after activation\n`);
    const { ops, supervisor } = interpreter(dir);
    expect((await supervisor.start()).ok).toBe(true);
    const env = ops.last()?.request.env ?? {};
    expect(env["CREWHAUS_DEPLOYMENT_ID"]).toBeUndefined();
    expect(env["CREWHAUS_SPEC_HASH"]).toBeUndefined();
    expect(readRunfile(dir)?.deployment).toBeUndefined();
    supervisor.close();
  });

  test("a compiled launch with no head to admit it is stamped only when its build is active", async () => {
    const dir = harness();
    activateBuildForTest(dir, "dist/daemon.ts");
    put(dir, "dist/daemon.ts", "// changed after activation\n");
    const { ops, supervisor } = supervise(dir);
    expect((await supervisor.start()).ok).toBe(true);
    const env = ops.last()?.request.env ?? {};
    expect(env["CREWHAUS_DEPLOYMENT_ID"]).toBeUndefined();
    expect(env["CREWHAUS_SPEC_HASH"]).toBeUndefined();
  });
});

describe("the restart window outlives its manager", () => {
  test("five recorded restarts, then a new supervisor's next crash is crash-looping", async () => {
    const dir = harness();
    activateBuildForTest(dir, "dist/daemon.ts");
    const first = supervise(dir);
    await first.supervisor.start();
    for (let i = 0; i < 5; i++) {
      first.ops.last()?.exit(EXIT_CODES.tool);
      await tick();
      first.clock.advance(30_000);
      await tick();
    }
    expect(first.supervisor.snapshot().restartsInWindow).toBe(5);
    first.supervisor.close();

    // A new manager on the same harness, at the same moment.
    const second = supervise(dir);
    second.clock.setNow(first.clock.now());
    expect(second.supervisor.snapshot().restartsInWindow).toBe(5);
    await second.supervisor.start({});
    // A manual start clears the window: restarts recorded after it count.
    expect(second.supervisor.snapshot().restartsInWindow).toBe(0);
  });

  test("restarts recorded by an earlier manager count toward crash-looping", async () => {
    const dir = harness();
    activateBuildForTest(dir, "dist/daemon.ts");
    const first = supervise(dir);
    await first.supervisor.start();
    for (let i = 0; i < 5; i++) {
      first.ops.last()?.exit(EXIT_CODES.tool);
      await tick();
      first.clock.advance(30_000);
      await tick();
    }
    const pid = first.supervisor.snapshot().pid as number;
    first.supervisor.close();

    // A new manager adopts the running daemon; its next crash is the sixth in the window.
    const clock2 = createFakeClock(first.clock.now());
    const second = createHarnessSupervisor({
      harnessDir: dir,
      target: "channel",
      ops: first.ops,
      clock: clock2,
      plan: () =>
        buildSpawnPlan({
          harnessDir: dir,
          target: "channel",
          processEnv: {},
          ports: { port: 3000 },
        }),
    });
    expect(await second.adopt()).toBe("adopted");
    expect(second.snapshot().restartsInWindow).toBe(5);
    first.ops.unregister(pid);
    clock2.advance(250);
    await tick();
    expect(second.snapshot().state).toBe("crash-looping");
    second.close();
  });

  test("an unreadable record starts empty and says so", () => {
    const dir = harness();
    put(dir, ".crewhaus/run/supervision.json", "not json");
    const { supervisor } = supervise(dir);
    expect(supervisor.snapshot().restartsInWindow).toBe(0);
    expect(supervisor.snapshot().windowNote).toContain("could not be read");
  });
});

describe("env files never supply a loader setting", () => {
  test("from .env and from a shared file, dropped and listed; the manager's own passes", () => {
    const dir = harness("channel", "BUN_OPTIONS=--preload ./x.ts\nKEEP=1\n");
    put(dir, "../shared.env", "GIT_CONFIG_COUNT=1\nNODE_OPTIONS=--inspect\n");
    const chain = loadEnvChain(dir, { sharedFiles: ["../shared.env"] });
    const spawn = buildSpawnEnv({
      harnessRoot: dir,
      envChain: chain,
      processEnv: { NODE_OPTIONS: "--max-old-space-size=512", BUN_OPTIONS: "--preload ./x.ts" },
    });
    expect(spawn.env["KEEP"]).toBe("1");
    expect(spawn.env["BUN_OPTIONS"]).toBeUndefined();
    expect(spawn.env["GIT_CONFIG_COUNT"]).toBeUndefined();
    expect(spawn.env["NODE_OPTIONS"]).toBe("--max-old-space-size=512");
    expect(spawn.dropped).toEqual(["BUN_OPTIONS", "GIT_CONFIG_COUNT"]);
  });

  const LOADER_LINES = [
    "BUN_OPTIONS=--smol",
    "GIT_CONFIG_COUNT=1",
    "LD_PRELOAD=./x.so",
    "DYLD_INSERT_LIBRARIES=./x.dylib",
    "PATH=./bin",
    "GIT_SSH_COMMAND=./ssh",
    "PYTHONPATH=./py",
    "NODE_PATH=./mods",
    "NODE_ENV=production",
    "APP_TOKEN=plain-app-setting",
  ];
  const LOADER_NAMES = [
    "BUN_OPTIONS",
    "DYLD_INSERT_LIBRARIES",
    "GIT_CONFIG_COUNT",
    "GIT_SSH_COMMAND",
    "LD_PRELOAD",
    "NODE_PATH",
    "PATH",
    "PYTHONPATH",
  ];

  test.each([
    ["the harness's .env", "own"],
    ["a shared envFiles file", "shared"],
  ])(
    "from %s: every loader family is dropped and listed; NODE_ENV and APP_TOKEN pass",
    (_label, where) => {
      const body = `${LOADER_LINES.join("\n")}\n`;
      const dir = harness("channel", where === "own" ? body : "KEEP=1\n");
      const shared = `../${basename(dir)}.shared.env`;
      if (where === "shared") {
        put(dir, shared, body);
        roots.push(join(dir, shared));
      }
      const chain = loadEnvChain(dir, where === "shared" ? { sharedFiles: [shared] } : {});
      const spawn = buildSpawnEnv({ harnessRoot: dir, envChain: chain, processEnv: {} });
      for (const name of LOADER_NAMES) expect(spawn.env[name]).toBeUndefined();
      expect(spawn.env["NODE_ENV"]).toBe("production");
      expect(spawn.env["APP_TOKEN"]).toBe("plain-app-setting");
      expect(spawn.dropped).toEqual(LOADER_NAMES);
      // With the manager's own PATH, the child runs with that one, never the file's.
      const withPath = buildSpawnEnv({
        harnessRoot: dir,
        envChain: chain,
        processEnv: { PATH: "/usr/bin:/bin" },
      });
      expect(withPath.env["PATH"]).toBe("/usr/bin:/bin");
    },
  );

  test("an exported shell function name in the chain is dropped by family", () => {
    const dir = harness("channel");
    const spawn = buildSpawnEnv({
      harnessRoot: dir,
      envChain: { vars: { "BASH_FUNC_git%%": "() { :; }", NODE_ENV: "test" }, files: [], refs: [] },
      processEnv: {},
    });
    expect(spawn.env["BASH_FUNC_git%%"]).toBeUndefined();
    expect(spawn.env["NODE_ENV"]).toBe("test");
    expect(spawn.dropped).toEqual(["BASH_FUNC_git%%"]);
  });

  test("a loader setting exported only in the manager's environment passes", () => {
    const dir = harness("channel", "KEEP=1\n");
    const spawn = buildSpawnEnv({
      harnessRoot: dir,
      processEnv: { LD_PRELOAD: "/opt/lib.so", GIT_SSH_COMMAND: "ssh -4", PATH: "/usr/bin" },
    });
    expect(spawn.env["LD_PRELOAD"]).toBe("/opt/lib.so");
    expect(spawn.env["GIT_SSH_COMMAND"]).toBe("ssh -4");
    expect(spawn.env["PATH"]).toBe("/usr/bin");
    expect(spawn.dropped).toEqual([]);
  });

  test("a manager value equal to the file's is the file's and is dropped, except PATH", () => {
    const dir = harness("channel", "LD_PRELOAD=./x.so\nPATH=/same/bin\n");
    const spawn = buildSpawnEnv({
      harnessRoot: dir,
      processEnv: { LD_PRELOAD: "./x.so", PATH: "/same/bin" },
    });
    expect(spawn.env["LD_PRELOAD"]).toBeUndefined();
    expect(spawn.dropped).toEqual(["LD_PRELOAD"]);
    // A spawn is never left without a PATH.
    expect(spawn.env["PATH"]).toBe("/same/bin");
  });

  test("isLoaderEnvKey: exact names and families, compared as written off Windows, no bare NODE_ or BUN_", () => {
    for (const name of LOADER_ENV_KEYS) expect(isLoaderEnvKey(name, "linux")).toBe(true);
    expect([...LOADER_ENV_PREFIXES]).toEqual(["GIT_CONFIG_", "LD_", "DYLD_", "BASH_FUNC_"]);
    for (const name of [
      "LD_LIBRARY_PATH",
      "DYLD_LIBRARY_PATH",
      "BASH_FUNC_x%%",
      "GIT_CONFIG_KEY_0",
    ])
      expect(isLoaderEnvKey(name, "linux")).toBe(true);
    for (const name of [
      "NODE_ENV",
      "BUN_ENV",
      "path",
      "ld_preload",
      "APP_TOKEN",
      "GIT_AUTHOR_NAME",
    ])
      expect(isLoaderEnvKey(name, "linux")).toBe(false);
    // On Windows every spelling of a loader name matches; other names still do not.
    for (const name of ["path", "Path", "ld_preload", "bun_options", "Git_Config_Key_0"])
      expect(isLoaderEnvKey(name, "win32")).toBe(true);
    for (const name of ["node_env", "bun_env", "app_token"])
      expect(isLoaderEnvKey(name, "win32")).toBe(false);
  });
});

describe("a bundle at the harness root", () => {
  test("a stray root agent.ts with no stamp and no record is no bundle", () => {
    const dir = mkdtempSync(join(tmpdir(), "chsup-root-"));
    roots.push(dir);
    put(dir, "crewhaus.yaml", "name: demo\ntarget: cli\n");
    put(dir, "agent.ts", "// not compiled here\n");
    expect(resolveBundle(dir, "cli")).toBeUndefined();
    put(dir, "package.json", JSON.stringify({ name: "crewhaus-compiled-bundle" }));
    expect(resolveBundle(dir, "cli")?.entry).toBe("agent.ts");
  });

  test("a deployment record naming a root entry counts it", () => {
    const dir = mkdtempSync(join(tmpdir(), "chsup-root-"));
    roots.push(dir);
    put(dir, "crewhaus.yaml", "name: demo\ntarget: cli\n");
    put(dir, "agent.ts", "// compiled with -o .\n");
    activateBuildForTest(dir, "agent.ts");
    expect(resolveBundle(dir, "cli")?.entry).toBe("agent.ts");
  });
});
