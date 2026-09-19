/**
 * The tools as the runtime sees them: registered in a catalog, dispatched
 * through the executor with schema validation in front of them, and carrying
 * the flags a destructive host-touching tool has to carry.
 *
 * One test in this file — and only one in the package — talks to the real
 * machine. It runs `CronList` over this host's crontab and asserts SHAPE
 * only: that the reader came back, that the report says which source it read,
 * and that anything it found has the fields every entry must have. It never
 * asserts what is scheduled, because that differs on every machine, and it
 * never writes anything, because the read-only tool is the only one pointed
 * at the real host here.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { CRONTAB_EVERY_SHAPE } from "./__fixtures__/host-output";
import { CRON_TOOLS, _setClock, _setFs, _setRunner, cronDelete, cronList } from "./index";

let catalog: ToolCatalog;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of CRON_TOOLS) catalog.register(tool);
});

afterEach(() => {
  _setRunner(undefined);
  _setFs(undefined);
  _setClock(undefined);
});

describe("registration", () => {
  test("both tools register under names nothing else in the monorepo uses", () => {
    expect(catalog.list().length).toBe(CRON_TOOLS.length);
    expect(CRON_TOOLS.map((tool) => tool.name).sort()).toEqual(["CronDelete", "CronList"]);
  });

  test("the catalog throws on a second registration of the same name", () => {
    // A duplicate tool name is a boot-time throw for every harness, which is
    // why the names here are CronList/CronDelete and the datetime package's
    // are CronNext/CronDescribe.
    expect(() => catalog.register(CRON_TOOLS[0] as RegisteredTool)).toThrow();
  });

  test("the two schedule tools this package leans on are NOT redefined here", () => {
    const names = new Set(CRON_TOOLS.map((tool) => tool.name));
    expect(names.has("CronNext")).toBe(false);
    expect(names.has("CronDescribe")).toBe(false);
  });
});

describe("the contract each tool declares", () => {
  test("CronList is read-only, concurrency-safe, and declares that it spawns", () => {
    expect(cronList.readOnly).toBe(true);
    expect(cronList.concurrencySafe).toBe(true);
    expect(cronList.destructive).toBe(false);
    expect(cronList.ioCapability).toBe("process");
    expect(cronList.scope).toBe("external");
  });

  test("CronDelete declares itself destructive and not concurrency-safe", () => {
    // Not concurrency-safe is a fact about the world, not a preference: two
    // of these against one crontab is a read-modify-write race.
    expect(cronDelete.destructive).toBe(true);
    expect(cronDelete.readOnly).toBe(false);
    expect(cronDelete.concurrencySafe).toBe(false);
    expect(cronDelete.requireJustification).toBe(true);
    expect(cronDelete.ioCapability).toBe("process");
    expect(cronDelete.scope).toBe("external");
  });

  test("the destructive tool's description tells a caller to dry-run first", () => {
    expect(cronDelete.description).toContain("dryRun");
    expect(cronDelete.description.toUpperCase()).toContain("DESTRUCTIVE");
  });

  test("no schema anywhere takes a path, a directory or a command to run", () => {
    // The package derives every directory from the home directory and every
    // command from a fixed list. A caller-supplied path would be a tool that
    // can be pointed at /etc; a caller-supplied command would be a shell.
    for (const tool of CRON_TOOLS) {
      const shape = Object.keys(
        (tool.inputSchema as unknown as { shape: Record<string, unknown> }).shape,
      );
      for (const field of shape) {
        expect(field.toLowerCase()).not.toContain("path");
        expect(field.toLowerCase()).not.toContain("dir");
        expect(field.toLowerCase()).not.toContain("command");
        expect(field.toLowerCase()).not.toContain("argv");
      }
    }
  });
});

describe("dispatch through executeTool", () => {
  beforeEach(() => {
    _setClock(() => Date.parse("2026-09-18T12:00:00Z"));
    _setFs({
      homedir: () => "/home/alice",
      tmpdir: () => "/tmp",
      readdir: () => ({ kind: "missing" }),
      mkdtemp: () => "/tmp/crewhaus-cron-int",
      writeFile: () => undefined,
      rename: () => undefined,
      unlink: () => undefined,
      removeDir: () => undefined,
    });
    _setRunner(async (cmd) => ({
      argv: cmd.argv,
      exitCode: 0,
      stdout: cmd.argv[1] === "-l" ? CRONTAB_EVERY_SHAPE : "",
      stderr: "",
      timedOut: false,
    }));
  });

  test("every tool dispatches with a minimal valid input", async () => {
    const inputs: Record<string, unknown> = {
      CronList: { sources: ["crontab"], nextRuns: 0 },
      CronDelete: { source: "crontab", id: "line:6", dryRun: true },
    };
    for (const tool of CRON_TOOLS) {
      const result = await executeTool(lookup(tool.name), inputs[tool.name], {
        toolUseId: `min-${tool.name}`,
      });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });

  test("the executor's schema validation rejects an unknown source", async () => {
    const result = await executeTool(
      lookup("CronDelete"),
      {
        source: "taskscheduler",
        id: "x",
      },
      { toolUseId: "bad-source" },
    );
    expect(result.isError).toBe(true);
  });

  test("a dry run dispatched through the executor changes nothing", async () => {
    const result = await executeTool(
      lookup("CronDelete"),
      { source: "crontab", match: "poll.sh", dryRun: true },
      { toolUseId: "dry" },
    );
    expect(result.isError).toBe(false);
    const text = typeof result.content === "string" ? result.content : JSON.stringify(result);
    expect(text).toContain('"dryRun":true');
    expect(text).toContain('"deleted":false');
  });
});

describe("the one test that touches this machine", () => {
  // Read-only, shape-only. `crontab -l` cannot change anything, and nothing
  // in this test names a job, a schedule or a count — all three differ per
  // machine, and CI is not the machine this was written on.
  test("CronList reads the real host's crontab and comes back in the documented shape", async () => {
    _setRunner(undefined);
    _setFs(undefined);
    _setClock(undefined);
    const raw = await cronList.execute({ sources: ["crontab"], nextRuns: 0, timeoutMs: 10_000 });
    expect(typeof raw).toBe("string");
    const out = JSON.parse(raw as string) as Record<string, unknown>;
    expect(out["ok"]).toBe(true);
    expect(typeof out["platform"]).toBe("string");
    expect(typeof out["now"]).toBe("string");
    const sources = out["sources"] as { source: string; available: boolean }[];
    expect(sources.length).toBe(1);
    expect(sources[0]?.source).toBe("crontab");
    expect(typeof sources[0]?.available).toBe("boolean");
    const entries = out["entries"] as Record<string, unknown>[];
    expect(Array.isArray(entries)).toBe(true);
    for (const entry of entries) {
      expect(entry["source"]).toBe("crontab");
      expect(typeof entry["id"]).toBe("string");
      expect(entry["idKind"]).toBe("crontab-line");
      expect(typeof entry["fingerprint"]).toBe("string");
      const schedule = entry["schedule"] as { grammar: string };
      expect(["cron5", "cron-macro", "cron-reboot"]).toContain(schedule.grammar);
    }
  }, 20_000);
});
