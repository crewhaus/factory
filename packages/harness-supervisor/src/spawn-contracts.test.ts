import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DAEMON_ENTRY_TARGETS,
  SpawnPlanError,
  buildSpawnEnv,
  buildSpawnPlan,
  cliTwin,
  entryFileFor,
  findHarnessRoot,
  findSpecPath,
  isInside,
  isSupervisedClass,
  loadEnvChain,
  parseEnvText,
  resolveBundle,
  resolveCrewhausBin,
  runClassFor,
  runKindFor,
  runOptionFlags,
} from "./spawn-contracts";

const roots: string[] = [];
function tempHarness(options: { bundle?: string; spec?: boolean; env?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "chsup-spawn-"));
  roots.push(dir);
  if (options.spec !== false)
    writeFileSync(join(dir, "crewhaus.yaml"), "name: demo\ntarget: cli\n");
  if (options.bundle !== undefined) {
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", options.bundle), "// bundle\n");
  }
  if (options.env !== undefined) writeFileSync(join(dir, ".env"), options.env);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the shape table", () => {
  test("every target maps to its documented run class", () => {
    const expected: Record<string, string> = {
      cli: "interactive",
      browser: "interactive",
      channel: "daemon",
      managed: "daemon",
      crew: "daemon",
      voice: "daemon",
      batch: "worker",
      workflow: "one-shot",
      graph: "one-shot",
      pipeline: "one-shot",
      research: "one-shot",
      eval: "one-shot",
      onchain: "one-shot",
      "onchain-game": "one-shot",
    };
    for (const [target, runClass] of Object.entries(expected)) {
      expect(runClassFor(target)).toBe(runClass as never);
    }
  });

  test("an unknown target degrades to one-shot (run it, never restart it)", () => {
    expect(runClassFor("some-future-shape")).toBe("one-shot");
  });

  test("only channel/managed/crew/voice have a daemon.ts entry — batch does NOT", () => {
    expect([...DAEMON_ENTRY_TARGETS].sort()).toEqual(["channel", "crew", "managed", "voice"]);
    expect(entryFileFor("batch")).toBe("agent.ts");
    expect(entryFileFor("channel")).toBe("daemon.ts");
    expect(entryFileFor("workflow")).toBe("agent.ts");
  });

  test("batch gets daemon-class supervision despite its agent.ts entry", () => {
    expect(isSupervisedClass(runClassFor("batch"))).toBe(true);
    expect(isSupervisedClass(runClassFor("workflow"))).toBe(false);
    expect(runKindFor("worker")).toBe("daemon");
    expect(runKindFor("one-shot")).toBe("job");
    expect(runKindFor("interactive")).toBe("interactive");
    expect(runKindFor("mcp-server")).toBe("mcp-server");
  });
});

describe("locating the harness", () => {
  test("the root is the dir holding crewhaus.yaml, even given the bundle dir", () => {
    const dir = tempHarness({ bundle: "agent.ts" });
    expect(findHarnessRoot(join(dir, "dist"))).toBe(dir);
    expect(findSpecPath(dir)).toBe(join(dir, "crewhaus.yaml"));
  });

  test("a dir with no spec anywhere above resolves to itself", () => {
    const dir = tempHarness({ spec: false });
    expect(findHarnessRoot(dir)).toBe(dir);
    expect(findSpecPath(dir)).toBeUndefined();
  });

  test("the bundle is found under dist/, then build/, then the root", () => {
    const dir = tempHarness({ bundle: "daemon.ts" });
    const found = resolveBundle(dir, "channel");
    expect(found?.bundleDir).toBe(join(dir, "dist"));
    expect(found?.entry).toBe("daemon.ts");
    expect(resolveBundle(dir, "cli")).toBeUndefined();
  });

  test("the harness's own CLI wins over PATH", () => {
    const calls: string[] = [];
    expect(
      resolveCrewhausBin("/h", {
        exists: (p) => p === join("/h", "node_modules", ".bin", "crewhaus"),
        which: (c) => {
          calls.push(c);
          return "/usr/local/bin/crewhaus";
        },
      }),
    ).toBe(join("/h", "node_modules", ".bin", "crewhaus"));
    expect(calls).toHaveLength(0);
    expect(
      resolveCrewhausBin("/h", { exists: () => false, which: () => undefined }),
    ).toBeUndefined();
  });
});

describe("the env chain", () => {
  test("parses dotenv tolerantly", () => {
    const parsed = parseEnvText(
      [
        "# comment",
        "export A=1",
        'B = "two"',
        "C='three'",
        "D=four # trailing",
        "garbage",
        "",
      ].join("\n"),
    );
    expect(parsed).toEqual({ A: "1", B: "two", C: "three", D: "four" });
  });

  test(".env.local wins over .env", () => {
    const dir = tempHarness({ env: "A=one\nB=b\n" });
    writeFileSync(join(dir, ".env.local"), "A=two\n");
    const chain = loadEnvChain(dir);
    expect(chain.vars).toEqual({ A: "two", B: "b" });
    expect(chain.files).toEqual([".env", ".env.local"]);
  });

  test("the harness .env is merged UNDER process.env, and the trace stamps win", () => {
    const dir = tempHarness({ env: "SHARED=from-file\nONLY_FILE=file\nCREWHAUS_TRACE=pretty\n" });
    const { env, envFiles } = buildSpawnEnv({
      harnessRoot: dir,
      processEnv: { SHARED: "from-process", ONLY_PROCESS: "proc" },
    });
    expect(env["SHARED"]).toBe("from-process");
    expect(env["ONLY_FILE"]).toBe("file");
    expect(env["ONLY_PROCESS"]).toBe("proc");
    expect(env["CREWHAUS_TRACE"]).toBe("json");
    expect(env["CREWHAUS_COST_TRACKING"]).toBe("1");
    expect(envFiles).toEqual([".env"]);
  });

  test("relocation variables are honoured AND reported with their source", () => {
    const dir = tempHarness({ env: "CREWHAUS_SESSION_DIR=/elsewhere/sessions\n" });
    const { overrides } = buildSpawnEnv({
      harnessRoot: dir,
      processEnv: { CREWHAUS_WATCHME_ROOT: "/wm" },
      extra: { CREWHAUS_SHARED_DIR: "/shared" },
    });
    expect(overrides).toEqual([
      { name: "CREWHAUS_SESSION_DIR", value: "/elsewhere/sessions", source: "env-file" },
      { name: "CREWHAUS_WATCHME_ROOT", value: "/wm", source: "process" },
      { name: "CREWHAUS_SHARED_DIR", value: "/shared", source: "caller" },
    ]);
  });
});

describe("buildSpawnPlan", () => {
  test("cli with a resolvable CLI takes the interpreter path and CAN resume", () => {
    const dir = tempHarness({ bundle: "agent.ts" });
    const plan = buildSpawnPlan({
      harnessDir: dir,
      target: "cli",
      processEnv: {},
      crewhausBin: "/bin/crewhaus",
      options: { resumeSessionId: "sess_0123456789abcdef", model: "sonnet", streaming: true },
    });
    expect(plan.launchMode).toBe("interpreter");
    expect(plan.canResume).toBe(true);
    expect(plan.argv).toEqual([
      "/bin/crewhaus",
      "run",
      join(dir, "crewhaus.yaml"),
      "--model",
      "sonnet",
      "--streaming",
      "--resume",
      "sess_0123456789abcdef",
    ]);
    expect(plan.stdio).toBe("pipe");
    expect(plan.detached).toBe(false);
    expect(plan.supervised).toBe(false);
  });

  test("a malformed session id is never passed through as --resume", () => {
    const dir = tempHarness({ bundle: "agent.ts" });
    const plan = buildSpawnPlan({
      harnessDir: dir,
      target: "cli",
      processEnv: {},
      crewhausBin: "/bin/crewhaus",
      options: { resumeSessionId: "../../etc/passwd" },
    });
    expect(plan.argv).not.toContain("--resume");
  });

  test("cli WITHOUT a CLI falls back to the compiled bundle and cannot resume", () => {
    const dir = tempHarness({ bundle: "agent.ts" });
    const plan = buildSpawnPlan({ harnessDir: dir, target: "cli", processEnv: {} });
    expect(plan.launchMode).toBe("compiled");
    expect(plan.canResume).toBe(false);
    expect(plan.argv).toEqual(["bun", join(dir, "dist", "agent.ts")]);
    expect(plan.stdio).toBe("pipe");
  });

  test("a daemon shape is detached, fd-logged, and supervised", () => {
    const dir = tempHarness({ bundle: "daemon.ts" });
    const plan = buildSpawnPlan({
      harnessDir: join(dir, "dist"), // given the BUNDLE dir on purpose
      target: "channel",
      processEnv: {},
      ports: { port: 3000, controlPort: 3001, gatewayPort: 8080 },
      controlToken: "token-value",
      controlTokenPath: join(dir, ".crewhaus", "run", "control-token"),
    });
    expect(plan.runClass).toBe("daemon");
    expect(plan.kind).toBe("daemon");
    expect(plan.detached).toBe(true);
    expect(plan.stdio).toBe("file");
    expect(plan.supervised).toBe(true);
    // cwd is the harness ROOT, never the bundle dir.
    expect(plan.cwd).toBe(dir);
    expect(plan.argv).toEqual(["bun", join(dir, "dist", "daemon.ts")]);
    expect(plan.env["PORT"]).toBe("3000");
    expect(plan.env["CREWHAUS_CONTROL_PORT"]).toBe("3001");
    expect(plan.env["CREWHAUS_CONTROL_TOKEN"]).toBe("token-value");
    // The token is stamped into the ENV only — argv is world-readable.
    expect(plan.argv.join(" ")).not.toContain("token-value");
    expect(plan.controlTokenPath).toContain("control-token");
  });

  test("batch runs agent.ts with daemon-class supervision", () => {
    const dir = tempHarness({ bundle: "agent.ts" });
    const plan = buildSpawnPlan({ harnessDir: dir, target: "batch", processEnv: {} });
    expect(plan.runClass).toBe("worker");
    expect(plan.kind).toBe("daemon");
    expect(plan.supervised).toBe(true);
    expect(plan.argv[1]).toBe(join(dir, "dist", "agent.ts"));
  });

  test("a one-shot job is detached, ledgered as a job, and never supervised", () => {
    const dir = tempHarness({ bundle: "agent.ts" });
    const plan = buildSpawnPlan({ harnessDir: dir, target: "workflow", processEnv: {} });
    expect(plan.kind).toBe("job");
    expect(plan.supervised).toBe(false);
    expect(plan.stdio).toBe("file");
  });

  test("the mcp-server class runs `crewhaus serve --mcp`, port-tracked under --sse", () => {
    const dir = tempHarness({ bundle: "agent.ts" });
    const plan = buildSpawnPlan({
      harnessDir: dir,
      target: "cli",
      runClass: "mcp-server",
      processEnv: {},
      crewhausBin: "/bin/crewhaus",
      mcpSse: true,
      ports: { port: 7788 },
    });
    expect(plan.argv).toEqual([
      "/bin/crewhaus",
      "serve",
      "--mcp",
      join(dir, "crewhaus.yaml"),
      "--sse",
      "--port",
      "7788",
    ]);
    expect(plan.kind).toBe("mcp-server");
    expect(plan.launchMode).toBe("cli-verb");
  });

  test("a missing bundle refuses with a Compile remedy instead of a stack trace", () => {
    const dir = tempHarness();
    try {
      buildSpawnPlan({ harnessDir: dir, target: "channel", processEnv: {} });
      throw new Error("expected a SpawnPlanError");
    } catch (err) {
      expect(err).toBeInstanceOf(SpawnPlanError);
      expect((err as SpawnPlanError).remedy).toBe("compile");
      expect((err as SpawnPlanError).message).toContain("daemon.ts");
    }
  });

  test("non-process shapes say so rather than pretending to launch", () => {
    const dir = tempHarness();
    for (const runClass of ["serverless", "export"] as const) {
      expect(() =>
        buildSpawnPlan({ harnessDir: dir, target: "cli", runClass, processEnv: {} }),
      ).toThrow(SpawnPlanError);
    }
  });

  test("the mcp-server class without a CLI names the remedy", () => {
    const dir = tempHarness();
    try {
      buildSpawnPlan({ harnessDir: dir, target: "cli", runClass: "mcp-server", processEnv: {} });
      throw new Error("expected a SpawnPlanError");
    } catch (err) {
      expect((err as SpawnPlanError).remedy).toBe("install-cli");
    }
  });
});

describe("runOptionFlags + cliTwin", () => {
  test("flags render in a stable order", () => {
    expect(
      runOptionFlags({
        streaming: true,
        model: "haiku",
        budgetUsd: 1.5,
        askMode: "pause",
        permissionMode: "auto",
        prompt: "hi",
        trace: "json",
      }),
    ).toEqual([
      "--model",
      "haiku",
      "--prompt",
      "hi",
      "--budget-usd",
      "1.5",
      "--permission-mode",
      "auto",
      "--ask-mode",
      "pause",
      "--trace",
      "json",
      "--streaming",
    ]);
    expect(runOptionFlags({})).toEqual([]);
  });

  test("the CLI twin shows the cwd and the argv, never the env", () => {
    const dir = tempHarness({ bundle: "daemon.ts" });
    const plan = buildSpawnPlan({
      harnessDir: dir,
      target: "channel",
      processEnv: {},
      controlToken: "token-value",
    });
    const twin = cliTwin(plan);
    expect(twin).toContain(`cd ${dir}`);
    expect(twin).toContain("bun ");
    expect(twin).not.toContain("token-value");
  });
});

describe("isInside", () => {
  test("keeps siblings out", () => {
    expect(isInside("/a/b", "/a/b/c")).toBe(true);
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/bc")).toBe(false);
    expect(isInside("/a/b", "/a/b/../c")).toBe(false);
  });
});
