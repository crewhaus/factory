/**
 * The tools driven the way the runtime drives them: registered in a catalog
 * and dispatched through `executeTool`, which validates the input against the
 * declared schema before `execute` runs and turns a refusal into an error
 * result rather than a thrown stack.
 *
 * It also walks the loop the package exists to close — watch a directory,
 * see the change, trash the file, watch the deletion arrive — because each of
 * these tools is only worth anything if the next one can act on what it said.
 *
 * ONE test in this file touches the real host: the smoke test at the bottom.
 * It runs whatever index this machine actually has and asserts SHAPE only,
 * never content, because the answer legitimately differs between a laptop
 * with Spotlight and a CI container with no locate database at all. Every
 * other test here drives the seams.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import {
  HOSTFS_TOOLS,
  _resetHostSeams,
  _setClock,
  _setIdentity,
  _setPlatform,
  _setRunner,
  _setWatchFactory,
} from "./index";

const originalCwd = process.cwd();
let catalog: ToolCatalog;
let workspace: string;

const FIXED_NOW = Date.parse("2026-09-19T01:29:18Z");

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

async function dispatch(name: string, input: unknown): Promise<{ text: string; isError: boolean }> {
  const result = await executeTool(lookup(name), input, { toolUseId: `t-${name}` });
  return { text: String(result.content), isError: result.isError === true };
}

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of HOSTFS_TOOLS) catalog.register(tool);
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-hostfs-int-")));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
  _resetHostSeams();
  _setRunner(undefined);
  _setWatchFactory(undefined);
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(HOSTFS_TOOLS.length);
  });

  test("the catalog refuses a second registration of the same name", () => {
    // Which is why this package's search tool is OsIndexSearch: tool-state
    // already owns IndexSearch, and a duplicate throws at boot for every
    // harness, not at the call site.
    expect(() => catalog.register(HOSTFS_TOOLS[0] as RegisteredTool)).toThrow();
  });

  test("the catalog can find each one by name", () => {
    for (const tool of HOSTFS_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await dispatch("WatchPath", { path: ".", timeoutMs: "soon" });
    expect(result.isError).toBe(true);
  });

  test("a missing required deadline is refused by the validator", async () => {
    const result = await dispatch("WatchPath", { path: "." });
    expect(result.isError).toBe(true);
  });

  test("a refusal is a readable string, not a thrown stack", async () => {
    _setPlatform("linux");
    _setClock(() => FIXED_NOW);
    _setIdentity({ home: join(workspace, "home"), xdgDataHome: undefined, uid: 1000 });
    const result = await dispatch("TrashPath", { paths: ["../escape.txt"] });
    expect(result.text).toContain("outside the workspace root");
  });

  test("every tool can be dispatched with a minimal valid input", async () => {
    _setPlatform("linux");
    _setClock(() => FIXED_NOW);
    _setIdentity({ home: join(workspace, "home"), xdgDataHome: undefined, uid: 1000 });
    _setWatchFactory(() => ({ close: () => undefined }));
    _setRunner(async () => ({
      code: 1,
      stdout: "",
      stderr: "",
      timedOut: false,
      missing: false,
    }));

    const watch = await dispatch("WatchPath", { path: ".", timeoutMs: 40 });
    expect(JSON.parse(watch.text)["stoppedBy"]).toBe("deadline");

    const trash = await dispatch("TrashPath", { paths: ["nothing.txt"], dryRun: true });
    expect(JSON.parse(trash.text)["dryRun"]).toBe(true);

    const search = await dispatch("OsIndexSearch", { query: "x" });
    expect(JSON.parse(search.text)["outcome"]).toBe("noMatches");
  }, 15_000);
});

describe("the loop the package closes", () => {
  test("watch a directory, trash the file, and see the deletion reported", async () => {
    _setPlatform("linux");
    _setClock(() => FIXED_NOW);
    const home = join(workspace, "home");
    mkdirSync(home, { recursive: true });
    _setIdentity({ home, xdgDataHome: undefined, uid: 1000 });

    mkdirSync(join(workspace, "work"), { recursive: true });
    writeFileSync(join(workspace, "work/draft.md"), "a draft\n");

    // The watcher is scripted, but the filesystem work is real: TrashPath
    // genuinely moves the file, and the watch classifies what it finds.
    _setWatchFactory((_target, _options, emit) => {
      queueMicrotask(async () => {
        const trashed = await dispatch("TrashPath", { paths: ["work/draft.md"] });
        expect(JSON.parse(trashed.text)["trashed"]).toBe(1);
        emit("rename", "draft.md");
      });
      return { close: () => undefined };
    });

    const watched = await dispatch("WatchPath", {
      path: "work",
      timeoutMs: 5_000,
      maxEvents: 1,
      settleMs: 20,
    });
    const result = JSON.parse(watched.text) as Record<string, unknown>;
    const events = result["events"] as Array<Record<string, unknown>>;
    expect(result["stoppedBy"]).toBe("eventCap");
    expect(events[0]?.["path"]).toBe("draft.md");
    expect(events[0]?.["kind"]).toBe("deleted");

    // And the file is in the trash, with a record that names where it was.
    const trashFiles = join(home, ".local/share/Trash/files/draft.md");
    expect(existsSync(trashFiles)).toBe(true);
  }, 25_000);

  test("a dry run followed by the real call trashes exactly what it described", async () => {
    _setPlatform("linux");
    _setClock(() => FIXED_NOW);
    const home = join(workspace, "home");
    mkdirSync(home, { recursive: true });
    _setIdentity({ home, xdgDataHome: undefined, uid: 1000 });
    writeFileSync(join(workspace, "a.txt"), "x");
    writeFileSync(join(workspace, "b.txt"), "x");

    const preview = JSON.parse(
      (await dispatch("TrashPath", { paths: ["a.txt", "b.txt", "ghost.txt"], dryRun: true })).text,
    ) as Record<string, unknown>;
    expect(preview["wouldTrash"]).toBe(2);
    expect(preview["refused"]).toBe(1);

    const real = JSON.parse(
      (await dispatch("TrashPath", { paths: ["a.txt", "b.txt", "ghost.txt"] })).text,
    ) as Record<string, unknown>;
    expect(real["trashed"]).toBe(preview["wouldTrash"]);
    expect(real["refused"]).toBe(preview["refused"]);
  });
});

describe("smoke: the real host", () => {
  /**
   * The one test in this package that runs against the machine underneath:
   * a real `fs.watch` and a real index query, in one test, asserting SHAPE
   * and never content.
   *
   * Content is exactly what cannot be asserted here. macOS reports a plain
   * modification as `rename` and Linux as `change`; `mdfind` exists on one
   * and `plocate` is usually absent on the other. A CI container with no
   * index answers `indexUnavailable`, and that is a pass — the claim being
   * made is that the tools return well-formed, self-describing answers
   * whatever host they land on. Everything about WHAT they say is asserted
   * in the other suites, from recorded output.
   */
  test("both host-facing tools answer in the documented shape on this machine", async () => {
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src/needle.txt"), "x");

    // 1. The real watcher, attached by the real `fs.watch`, with a short
    //    deadline. Whether the write below is delivered before the deadline
    //    is the platform's business, so the assertion is only that the answer
    //    names one of the four bounds and reports a well-formed event list.
    setTimeout(() => {
      try {
        writeFileSync(join(workspace, "src/needle.txt"), "y");
      } catch {
        // The workspace is gone if the watch already returned; nothing to do.
      }
    }, 50);
    const watched = JSON.parse(
      (await dispatch("WatchPath", { path: "src", timeoutMs: 1_500, maxEvents: 1, settleMs: 50 }))
        .text,
    ) as Record<string, unknown>;
    expect(["deadline", "eventCap", "aborted", "watchError"]).toContain(watched["stoppedBy"]);
    expect(Array.isArray(watched["events"])).toBe(true);
    for (const event of watched["events"] as Array<Record<string, unknown>>) {
      expect(["created", "modified", "deleted"]).toContain(event["kind"]);
      expect(typeof event["path"]).toBe("string");
    }

    // 2. The real index, whatever this machine has.
    const searched = JSON.parse(
      (await dispatch("OsIndexSearch", { query: "needle" })).text,
    ) as Record<string, unknown>;
    expect([
      "matches",
      "noMatches",
      "noMatchesUnverified",
      "indexUnavailable",
      "unsupported",
      "failed",
    ]).toContain(searched["outcome"]);
    expect(Array.isArray(searched["matches"])).toBe(true);
    expect(typeof searched["backend"]).toBe("string");
    // Whatever it found is inside the workspace: the scope filter running on
    // a real backend answer rather than on a fixture.
    for (const match of searched["matches"] as string[]) {
      expect(match.startsWith(workspace)).toBe(true);
    }
  }, 60_000);
});
