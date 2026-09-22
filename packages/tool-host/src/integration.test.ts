/**
 * The tools as the runtime sees them: registered in a catalog, dispatched
 * through the executor, with their schemas doing the validating.
 *
 * And, at the bottom, the ONE test in this package that touches the real
 * machine. It runs the three tools against whatever host it is on — a Mac, a
 * two-core Linux CI box, anything — and asserts SHAPE only: that the result
 * is JSON with the fields the contract promises. It asserts no value,
 * because a test that asserts this machine's core count fails on the next
 * machine, and a test that asserts a port is listening fails whenever
 * something else on the box takes it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { type HostFacts, type HostFs, _setFs, _setHostFacts } from "./facts";
import * as F from "./fixtures";
import { HOST_TOOLS } from "./index";
import { HOST_COMMANDS, _setRunner, capOutput, defaultRunner, hostSpawnEnv } from "./run";

let catalog: ToolCatalog;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

const FAKE_FACTS: HostFacts = {
  platform: "darwin",
  arch: "arm64",
  release: "25.6.0",
  type: "Darwin",
  version: "Darwin Kernel Version 25.6.0",
  hostname: "fixture-host",
  uptimeSeconds: 3600,
  totalMemBytes: 16 * 1024 ** 3,
  freeMemBytes: 1024 ** 3,
  cpus: [{ model: "Apple M1", speed: 24 }],
  loadAverage: [0.1, 0.2, 0.3],
  uid: 501,
  env: {},
  dnsServers: ["1.1.1.1"],
  interfaces: {},
  runtime: { name: "bun", version: "1.3.11" },
};

const FAKE_FS: HostFs = {
  readText: () => undefined,
  listDir: () => undefined,
  statfs: () => ({ bsize: 4096, blocks: 1000, bfree: 500, bavail: 400 }),
};

const FAKE_COMMANDS: Record<string, string> = {
  [HOST_COMMANDS.uname.join(" ")]: F.MACOS_UNAME,
  [HOST_COMMANDS.swVers.join(" ")]: F.MACOS_SW_VERS,
  [HOST_COMMANDS.sysctl.join(" ")]: F.MACOS_SYSCTL,
  [HOST_COMMANDS.ifconfig.join(" ")]: F.MACOS_IFCONFIG,
  [HOST_COMMANDS.netstatBsd.join(" ")]: F.MACOS_NETSTAT_TCP,
  [HOST_COMMANDS.lsofFields.join(" ")]: F.MACOS_LSOF_FIELDS,
};

function useFixtureHost(): void {
  _setHostFacts(FAKE_FACTS);
  _setFs(FAKE_FS);
  _setRunner(async (argv) => {
    const stdout = FAKE_COMMANDS[argv.join(" ")];
    if (stdout === undefined) {
      return {
        argv,
        ok: false,
        exitCode: -1,
        stdout: "",
        stderr: "ENOENT",
        failure: "not-installed",
      };
    }
    return { argv, ok: true, exitCode: 0, stdout, stderr: "" };
  });
}

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of HOST_TOOLS) catalog.register(tool);
});

afterEach(() => {
  _setRunner(undefined);
  _setFs(undefined);
  _setHostFacts(undefined);
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(HOST_TOOLS.length);
    expect(
      catalog
        .list()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["NetworkInfo", "PortInspect", "SystemInfo"]);
  });

  test("the catalog refuses a second registration of the same name", () => {
    // A tool name must be unique monorepo-wide or this throws at boot, for
    // every harness — which is why the names are checked against the whole
    // catalog before a package is wired in.
    expect(() => catalog.register(HOST_TOOLS[0] as RegisteredTool)).toThrow();
  });
});

describe("dispatch through executeTool", () => {
  test("every tool answers a minimal valid input", async () => {
    useFixtureHost();
    const inputs: Record<string, unknown> = {
      SystemInfo: {},
      NetworkInfo: {},
      PortInspect: { ports: [22] },
    };
    for (const tool of HOST_TOOLS) {
      const result = await executeTool(lookup(tool.name), inputs[tool.name], {
        toolUseId: `min-${tool.name}`,
      });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
      expect(JSON.parse(String(result.content))).toHaveProperty("unknown");
    }
  });

  test("an input the schema rejects never reaches the tool", async () => {
    useFixtureHost();
    const result = await executeTool(
      lookup("PortInspect"),
      { ports: ["--all"] },
      { toolUseId: "bad-port" },
    );
    expect(result.isError).toBe(true);
  });

  test("a disk path outside the workspace comes back as a refusal", async () => {
    useFixtureHost();
    const result = await executeTool(
      lookup("SystemInfo"),
      { diskPath: "/etc", sections: [] },
      { toolUseId: "escape" },
    );
    expect(String(result.content)).toContain("refused path");
  });
});

describe("the spawn environment", () => {
  test("the locale is pinned and the harness's secrets are not forwarded", () => {
    // Every parser here reads English keywords (LISTEN, 'AC Power', status:
    // active). On a host with a different locale the same command prints
    // different words, so LC_ALL is what keeps the parsers applicable.
    const env = hostSpawnEnv({
      PATH: "/usr/bin",
      HOME: "/home/agent",
      ANTHROPIC_API_KEY: "sk-secret",
      LANG: "de_DE.UTF-8",
    });
    expect(env["LC_ALL"]).toBe("C");
    expect(env["LANG"]).toBe("C");
    expect(env["TZ"]).toBe("UTC");
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  test("a host with no PATH still gets one the system tools are on", () => {
    expect(hostSpawnEnv({})["PATH"]).toContain("/usr/sbin");
  });

  test("a stream that hit the cap says so, instead of looking short", () => {
    // The cap is reachable: `netstat -an -p tcp` and `netstat -ano` print
    // every socket in every state, so a busy host overruns it. A cut answer
    // that does not say it was cut is indistinguishable from a machine with
    // that many sockets and no more — and PortInspect would then call the
    // ports whose rows were dropped free.
    expect(capOutput("short", 100)).toEqual({ text: "short", truncated: false });
    expect(capOutput("exactly-ten", 11)).toEqual({ text: "exactly-ten", truncated: false });
    expect(capOutput("abcdefghij", 4)).toEqual({ text: "abcd", truncated: true });
  });

  test("Windows keeps the variables its loader needs to find a command", () => {
    const env = hostSpawnEnv({ SystemRoot: "C:\\WINDOWS", PATHEXT: ".COM;.EXE" });
    expect(env["SystemRoot"]).toBe("C:\\WINDOWS");
    expect(env["PATHEXT"]).toBe(".COM;.EXE");
  });
});

describe("smoke: the real machine", () => {
  /**
   * The one host-touching test. Shape only.
   *
   * Budget: three tools, up to eight short probe commands between them, on a
   * loaded two-core CI box. Local wall-clock is no guide — a probe that
   * takes 30ms here has taken seconds there — so the budget is set by the
   * work, not by the stopwatch.
   */
  test("all three tools answer on whatever host this is", async () => {
    // Part of the same one test, not a second one: a probe that is missing
    // must be reported as missing rather than as a probe that answered
    // nothing, and only a real spawn can show that the runner recognises it.
    // The name exists on no host, so this asserts nothing about THIS machine.
    const missing = await defaultRunner(["crewhaus-no-such-probe-9d3f"], { timeoutMs: 5_000 });
    expect(missing.ok).toBe(false);
    expect(missing.failure).toBe("not-installed");
    expect(missing.exitCode).toBe(-1);

    const system = JSON.parse(
      String((await executeTool(lookup("SystemInfo"), {}, { toolUseId: "smoke-sys" })).content),
    );
    expect(Array.isArray(system["unknown"])).toBe(true);
    expect(typeof system["os"]["platform"]).toBe("string");
    // A count is a number or null — never anything else, and in particular
    // the assertion is NOT that this machine has cores, because a machine
    // where the probe fails is a valid outcome this tool has to survive.
    const cores = system["cpu"]["logicalCores"];
    expect(cores === null || (typeof cores === "number" && cores > 0)).toBe(true);
    expect(system["runtime"]["name"]).toBe("bun");

    const network = JSON.parse(
      String((await executeTool(lookup("NetworkInfo"), {}, { toolUseId: "smoke-net" })).content),
    );
    expect(network["interfaces"] === null || Array.isArray(network["interfaces"])).toBe(true);
    expect(network["dns"]["resolvers"] === null || Array.isArray(network["dns"]["resolvers"])).toBe(
      true,
    );

    const ports = JSON.parse(
      String((await executeTool(lookup("PortInspect"), {}, { toolUseId: "smoke-ports" })).content),
    );
    expect(ports["sockets"] === null || Array.isArray(ports["sockets"])).toBe(true);
    expect(["all-users", "self-only", null]).toContain(ports["socketCoverage"]);
    expect(Array.isArray(ports["sources"])).toBe(true);
    for (const socket of (ports["sockets"] ?? []) as Array<Record<string, unknown>>) {
      expect(typeof socket["port"]).toBe("number");
      expect(typeof socket["ownerKnown"]).toBe("boolean");
    }
  }, 60_000);
});
