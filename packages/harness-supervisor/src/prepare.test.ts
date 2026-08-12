/**
 * The prepare seams: compile-if-stale, the operator hooks, and the refusal
 * contract that makes a failed prep step stop a start instead of leaking
 * into a spawn nobody connects back to it.
 *
 * Everything runs against an injected `ProcessOps` — no compiler is invoked
 * and no hook is really executed. What is under test is the CONTRACT: what
 * gets spawned, in what order, with what cwd/env, and what a non-zero exit
 * turns into.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashSpecSource } from "./bundle-freshness";
import { readManagerSettings } from "./manager-settings";
import {
  bundleStaleness,
  compileIfStale,
  compileOutDir,
  createPrepareRunner,
  formatPrepareRefusal,
  readHookRunLog,
  resolveHookCommand,
  runManagerHook,
  runPrepareCommand,
} from "./prepare";
import {
  type ProcessOps,
  type SpawnRequest,
  type SpawnedProcess,
  createProcessOps,
} from "./process-ops";
import type { Clock } from "./types";

// --- seams -----------------------------------------------------------------

type Recorded = { request: SpawnRequest; kill: boolean };

/** ProcessOps whose spawns resolve with scripted exit codes and output. */
function fakeOps(
  script: Array<{ code: number; out?: string; hang?: boolean }> = [],
): ProcessOps & { seen: Recorded[] } {
  const seen: Recorded[] = [];
  let index = 0;
  const real = createProcessOps();
  return {
    ...real,
    seen,
    spawn: (request: SpawnRequest): SpawnedProcess => {
      const step = script[index] ?? { code: 0 };
      index += 1;
      const record: Recorded = { request, kill: false };
      seen.push(record);
      const pid = 5_000 + index;
      const chunks = step.out !== undefined ? [new TextEncoder().encode(step.out)] : [];
      let settle: (v: { code: number | null; signal: string | null }) => void = () => {};
      const exited = new Promise<{ code: number | null; signal: string | null }>((r) => {
        settle = r;
      });
      if (step.hang !== true) settle({ code: step.code, signal: null });
      else {
        // Only the forceKill below ends it — the timeout path.
        record.kill = false;
      }
      return {
        pid,
        exited,
        stdout: (async function* () {
          for (const c of chunks) yield c;
        })(),
        stderr: (async function* () {
          // nothing
        })(),
      } as SpawnedProcess;
    },
    isAlive: () => true,
    startTimeMs: () => 1,
    commandLine: () => undefined,
    terminate: () => {},
    forceKill: (pid: number) => {
      const record = seen[pid - 5_001];
      if (record !== undefined) record.kill = true;
    },
  };
}

/** A clock whose timers fire only when the test says so. */
function manualClock(): Clock & { fire(): void } {
  const pending: Array<() => void> = [];
  return {
    now: () => 1_700_000_000_000,
    setTimeout: (fn) => {
      pending.push(fn);
      return pending.length;
    },
    clearTimeout: () => {},
    fire: () => {
      for (const fn of pending.splice(0)) fn();
    },
  };
}

const roots: string[] = [];
function harness(
  options: {
    spec?: string;
    bundleDir?: string;
    stamp?: string | false;
    settings?: unknown;
  } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "chsup-prep-"));
  roots.push(dir);
  const spec = options.spec ?? "name: demo\ntarget: channel\n";
  writeFileSync(join(dir, "crewhaus.yaml"), spec);
  const bundleDir = join(dir, options.bundleDir ?? "dist");
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(join(bundleDir, "daemon.ts"), "// bundle\n");
  if (options.stamp !== false) {
    writeFileSync(
      join(bundleDir, "package.json"),
      JSON.stringify({
        name: "crewhaus-compiled-bundle",
        crewhaus: { specHash: options.stamp ?? hashSpecSource(spec), compiledWith: "0.5.2" },
      }),
    );
  }
  if (options.settings !== undefined) {
    mkdirSync(join(dir, ".crewhaus"), { recursive: true });
    writeFileSync(join(dir, ".crewhaus", "settings.json"), JSON.stringify(options.settings));
  }
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const deps = (dir: string, ops: ProcessOps, clock?: Clock) => ({
  harnessDir: dir,
  target: "channel",
  ops,
  env: {},
  crewhausBin: "/bin/crewhaus",
  ...(clock !== undefined ? { clock } : {}),
});

// --- staleness -------------------------------------------------------------

describe("bundleStaleness", () => {
  test("a stamped bundle matching the spec is fresh, EXACTLY", () => {
    const verdict = bundleStaleness(harness(), "channel");
    expect(verdict.state).toBe("fresh");
    expect(verdict.exact).toBe(true);
  });

  test("an edited spec makes the stamped bundle stale, EXACTLY", () => {
    const dir = harness({ stamp: "sha256:0000" });
    expect(bundleStaleness(dir, "channel")).toMatchObject({ state: "stale", exact: true });
  });

  test("no bundle at all is `unknown`, not stale", () => {
    const dir = mkdtempSync(join(tmpdir(), "chsup-prep-none-"));
    roots.push(dir);
    writeFileSync(join(dir, "crewhaus.yaml"), "name: demo\ntarget: channel\n");
    expect(bundleStaleness(dir, "channel").state).toBe("unknown");
  });
});

describe("compileOutDir", () => {
  test("recompiles into the dir the CURRENT bundle lives in", () => {
    expect(compileOutDir(harness({ bundleDir: "build" }), "channel")).toBe("build");
  });

  test("defaults to dist when nothing is compiled yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "chsup-prep-out-"));
    roots.push(dir);
    writeFileSync(join(dir, "crewhaus.yaml"), "name: demo\ntarget: channel\n");
    expect(compileOutDir(dir, "channel")).toBe("dist");
  });
});

// --- compile ---------------------------------------------------------------

describe("compileIfStale", () => {
  test("a fresh bundle is left alone — nothing is spawned", async () => {
    const ops = fakeOps();
    const outcome = await compileIfStale(deps(harness(), ops));
    expect(outcome).toMatchObject({ ok: true, replan: false });
    expect(ops.seen).toHaveLength(0);
  });

  test("a stale bundle is recompiled, then its dependencies installed", async () => {
    const dir = harness({ stamp: "sha256:0000" });
    const ops = fakeOps([{ code: 0 }, { code: 0 }]);
    const outcome = await compileIfStale(deps(dir, ops));
    expect(outcome.ok).toBe(true);
    expect(outcome).toMatchObject({ replan: true });
    expect(ops.seen.map((s) => s.request.argv.slice(1, 3))).toEqual([
      ["compile", join(dir, "crewhaus.yaml")],
      ["install", "--cwd"],
    ]);
    // cwd is ALWAYS the harness root, like every other spawn here.
    expect(ops.seen.every((s) => s.request.cwd === dir)).toBe(true);
  });

  test("a failed compile refuses with the compiler's own output", async () => {
    const dir = harness({ stamp: "sha256:0000" });
    const ops = fakeOps([{ code: 20, out: "spec error: agent.model is required\n" }]);
    const outcome = await compileIfStale(deps(dir, ops));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.stage).toBe("compile");
    expect(outcome.refusal.exitCode).toBe(20);
    expect(outcome.refusal.output).toEqual(["spec error: agent.model is required"]);
    // The stale bundle is still the one on disk, and the message says so.
    expect(outcome.refusal.message).toContain("still the stale one");
  });

  test("a failed install refuses too — a fresh bundle that cannot resolve is not a start", async () => {
    const dir = harness({ stamp: "sha256:0000" });
    const ops = fakeOps([{ code: 0 }, { code: 1, out: "error: lockfile\n" }]);
    const outcome = await compileIfStale(deps(dir, ops));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.message).toContain("bun install");
  });

  test("no resolvable CLI refuses rather than silently skipping the recompile", async () => {
    const dir = harness({ stamp: "sha256:0000" });
    const outcome = await compileIfStale({ ...deps(dir, fakeOps()), crewhausBin: undefined });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.message).toContain("no `crewhaus` CLI resolves");
  });

  test("an UNSTAMPED bundle is not recompiled — an inexact verdict must not nag", async () => {
    const ops = fakeOps();
    const dir = harness({ stamp: false });
    // Bundle newer than the spec (just written in that order) ⇒ approximate-fresh.
    const outcome = await compileIfStale(deps(dir, ops));
    expect(outcome.ok).toBe(true);
    expect(ops.seen).toHaveLength(0);
  });
});

// --- hooks -----------------------------------------------------------------

describe("resolveHookCommand", () => {
  test("path-shaped declarations resolve against the harness root", () => {
    expect(resolveHookCommand("/h", "./prep.sh")).toBe("/h/prep.sh");
    expect(resolveHookCommand("/h/x", "../prep.sh")).toBe("/h/prep.sh");
    expect(resolveHookCommand("/h", "/opt/prep.sh")).toBe("/opt/prep.sh");
  });

  test("a bare name is left for the OS to resolve on PATH", () => {
    expect(resolveHookCommand("/h", "make")).toBe("make");
  });
});

describe("runManagerHook", () => {
  test("no hook declared ⇒ nothing spawned, nothing recorded", async () => {
    const dir = harness();
    const ops = fakeOps();
    expect(await runManagerHook("preSpawn", undefined, deps(dir, ops), 1000)).toMatchObject({
      ok: true,
    });
    expect(ops.seen).toHaveLength(0);
    expect(readHookRunLog(dir)).toEqual({});
  });

  test("a passing hook runs in the harness root with the spawn env, and is recorded", async () => {
    const dir = harness();
    const ops = fakeOps([{ code: 0 }]);
    const outcome = await runManagerHook(
      "preSpawn",
      { argv: ["./prep.sh", "--fast"], declaredAs: "./prep.sh --fast" },
      { ...deps(dir, ops), env: { ANTHROPIC_API_KEY: "k" } },
      1000,
    );
    expect(outcome.ok).toBe(true);
    expect(ops.seen[0]?.request.argv).toEqual([join(dir, "prep.sh"), "--fast"]);
    expect(ops.seen[0]?.request.cwd).toBe(dir);
    expect(ops.seen[0]?.request.env["ANTHROPIC_API_KEY"]).toBe("k");
    expect(readHookRunLog(dir).preSpawn).toMatchObject({
      ok: true,
      exitCode: 0,
      declaredAs: "./prep.sh --fast",
    });
  });

  test("a non-zero hook REFUSES the start and carries its own output", async () => {
    const dir = harness();
    const ops = fakeOps([{ code: 3, out: "patch failed: no such schema\n" }]);
    const outcome = await runManagerHook(
      "postCompile",
      { argv: ["./patch.ts"], declaredAs: "./patch.ts" },
      deps(dir, ops),
      1000,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.stage).toBe("postCompile");
    expect(outcome.refusal.exitCode).toBe(3);
    expect(outcome.refusal.output).toEqual(["patch failed: no such schema"]);
    expect(readHookRunLog(dir).postCompile).toMatchObject({ ok: false, exitCode: 3 });
  });

  test("a hook that cannot be launched at all says so instead of throwing", async () => {
    const dir = harness();
    const ops = {
      ...fakeOps(),
      spawn: () => {
        throw new Error("spawn ./nope ENOENT");
      },
    } as unknown as ProcessOps;
    const outcome = await runManagerHook(
      "preSpawn",
      { argv: ["./nope"], declaredAs: "./nope" },
      deps(dir, ops),
      1000,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.message).toContain("could not run");
    expect(outcome.refusal.message).toContain("ENOENT");
  });

  test("a credential the hook echoes is SCRUBBED out of the captured output", async () => {
    // Built from parts: this repo's push protection rejects realistic secret
    // literals, and a fixture never needs one.
    const secret = ["sk", "prep", "0123456789abcdefghij"].join("-");
    const dir = harness();
    const ops = fakeOps([{ code: 1, out: `+ curl -H "authorization: ${secret}"\n` }]);
    const outcome = await runManagerHook(
      "preSpawn",
      { argv: ["./prep.sh"], declaredAs: "./prep.sh" },
      { ...deps(dir, ops), env: { MY_API_KEY: secret } },
      1000,
    );
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.output.join("\n")).not.toContain(secret);
    expect(outcome.refusal.output.join("\n")).toContain("MY_API_KEY");
  });
});

describe("runPrepareCommand", () => {
  test("a wedged step is killed at the timeout and reported as timed out", async () => {
    const clock = manualClock();
    const ops = fakeOps([{ code: 0 }]);
    const pending = runPrepareCommand({
      argv: ["./slow.sh"],
      cwd: "/tmp",
      env: {},
      ops,
      clock,
      timeoutMs: 10,
    });
    clock.fire();
    await pending;
    expect(ops.seen[0]?.kill).toBe(true);
  });

  test("a prep step gets its own process group — killing it must reach the tree", async () => {
    const ops = fakeOps([{ code: 0 }]);
    await runPrepareCommand({ argv: ["./x"], cwd: "/tmp", env: {}, ops, timeoutMs: 100 });
    expect(ops.seen[0]?.request.detached).toBe(true);
  });
});

// --- the composed runner ---------------------------------------------------

describe("createPrepareRunner", () => {
  test("nothing configured ⇒ both seams are no-ops", async () => {
    const dir = harness();
    const ops = fakeOps();
    const runner = createPrepareRunner(deps(dir, ops));
    expect(runner.configured).toEqual({ compile: false, hooks: [] });
    expect(await runner.prepare()).toMatchObject({ ok: true, replan: false });
    expect(await runner.preSpawn()).toMatchObject({ ok: true });
    expect(ops.seen).toHaveLength(0);
  });

  test("manager.autoCompile turns the recompile on without a flag", async () => {
    const dir = harness({ stamp: "sha256:0000", settings: { manager: { autoCompile: true } } });
    const ops = fakeOps([{ code: 0 }, { code: 0 }]);
    const runner = createPrepareRunner(deps(dir, ops));
    expect(runner.configured.compile).toBe(true);
    const outcome = await runner.prepare();
    expect(outcome).toMatchObject({ ok: true, replan: true });
    expect(ops.seen[0]?.request.argv[1]).toBe("compile");
  });

  test("an explicit `compile: false` beats manager.autoCompile", async () => {
    const dir = harness({ stamp: "sha256:0000", settings: { manager: { autoCompile: true } } });
    const ops = fakeOps();
    const runner = createPrepareRunner({ ...deps(dir, ops), compile: false });
    expect(await runner.prepare()).toMatchObject({ ok: true });
    expect(ops.seen).toHaveLength(0);
  });

  test("order is compile → postCompile, and preSpawn is its own seam", async () => {
    const dir = harness({
      stamp: "sha256:0000",
      settings: {
        manager: {
          autoCompile: true,
          hooks: { postCompile: "./patch.ts", preSpawn: ["bun", "run", "warm.ts"] },
        },
      },
    });
    const ops = fakeOps([{ code: 0 }, { code: 0 }, { code: 0 }, { code: 0 }]);
    const runner = createPrepareRunner(deps(dir, ops));
    expect(runner.configured.hooks).toEqual(["postCompile", "preSpawn"]);
    await runner.prepare();
    await runner.preSpawn();
    expect(ops.seen.map((s) => s.request.argv[1] ?? s.request.argv[0])).toEqual([
      "compile",
      "install",
      join(dir, "patch.ts"),
      "run",
    ]);
  });

  test("the postCompile hook fires even when nothing was recompiled", async () => {
    // A console compile job may have replaced the bundle behind the
    // operator's back; the patch is needed just the same.
    const dir = harness({ settings: { manager: { hooks: { postCompile: "./patch.ts" } } } });
    const ops = fakeOps([{ code: 0 }]);
    await createPrepareRunner(deps(dir, ops)).prepare();
    expect(ops.seen).toHaveLength(1);
    expect(ops.seen[0]?.request.argv[0]).toBe(join(dir, "patch.ts"));
  });

  test("a refused postCompile stops prepare before anything else runs", async () => {
    const dir = harness({ settings: { manager: { hooks: { postCompile: "./patch.ts" } } } });
    const ops = fakeOps([{ code: 1, out: "nope\n" }]);
    const outcome = await createPrepareRunner(deps(dir, ops)).prepare();
    expect(outcome.ok).toBe(false);
  });

  test("string and array hook declarations both work; a string is NOT word-split", () => {
    const dir = harness({
      settings: {
        manager: { hooks: { postCompile: "./my prep.sh", preSpawn: ["bun", "x.ts", "--flag"] } },
      },
    });
    const settings = readManagerSettings(dir);
    expect(settings.hooks.postCompile?.argv).toEqual(["./my prep.sh"]);
    expect(settings.hooks.preSpawn?.argv).toEqual(["bun", "x.ts", "--flag"]);
  });
});

describe("formatPrepareRefusal", () => {
  test("names the stage, the reason, and quotes the step's own output", () => {
    const lines = formatPrepareRefusal({
      stage: "preSpawn",
      message: "preSpawn hook `./prep.sh` exited 2 — the start was refused",
      exitCode: 2,
      output: ["patching…", "error: no schema"],
    });
    expect(lines[0]).toContain("preSpawn refused the start");
    expect(lines.join("\n")).toContain("│ error: no schema");
  });
});

describe("the hook run record", () => {
  test("survives a re-read and keeps the other hook's entry", async () => {
    const dir = harness();
    const ops = fakeOps([{ code: 0 }, { code: 0 }]);
    await runManagerHook(
      "postCompile",
      { argv: ["./a.sh"], declaredAs: "./a.sh" },
      deps(dir, ops),
      100,
    );
    await runManagerHook(
      "preSpawn",
      { argv: ["./b.sh"], declaredAs: "./b.sh" },
      deps(dir, ops),
      100,
    );
    const log = readHookRunLog(dir);
    expect(log.postCompile?.declaredAs).toBe("./a.sh");
    expect(log.preSpawn?.declaredAs).toBe("./b.sh");
  });

  test("an unreadable record reads as no record, never an error on the start path", () => {
    const dir = harness();
    mkdirSync(join(dir, ".crewhaus", "run"), { recursive: true });
    writeFileSync(join(dir, ".crewhaus", "run", "hooks.json"), "{ not json");
    expect(readHookRunLog(dir)).toEqual({});
  });

  test("is written 0600 — it names commands, and lives beside the runfile", async () => {
    const dir = harness();
    await runManagerHook(
      "preSpawn",
      { argv: ["./b.sh"], declaredAs: "./b.sh" },
      deps(dir, fakeOps([{ code: 0 }])),
      100,
    );
    const raw = readFileSync(join(dir, ".crewhaus", "run", "hooks.json"), "utf8");
    expect(JSON.parse(raw)).toHaveProperty("preSpawn");
  });
});
