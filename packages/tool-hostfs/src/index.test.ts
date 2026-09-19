/**
 * The three tools, driven through `execute` with every host seam replaced.
 *
 * No test in this file spawns a command, and none of them asks the machine
 * what platform it is: the runner, the clock, the identity, the path probe
 * and the watcher are all injected, so the macOS-only and Linux-only paths
 * are both exercised wherever the suite runs. The filesystem IS real, in a
 * temporary directory, because a trash that has never moved a file on a real
 * filesystem has not been tested.
 *
 * Two conventions worth knowing while reading:
 *
 *   - Tests that wait on the watcher use a small settle window and a deadline
 *     of a few seconds, and never assert a duration. A slow CI box only makes
 *     a gap between two bursts LONGER, which is the direction that cannot
 *     flake. The deadline is kept well under each test's own budget because
 *     it is the fallback path: if the event cap ever stopped firing early,
 *     these tests would still pass and would cost their whole deadline each,
 *     and a suite that slow on CI is a suite somebody turns off.
 *   - Every "it failed" assertion also asserts the REASON, because a timeout
 *     can satisfy a bare failure assertion and then hide the bug it was
 *     written to catch.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  MDFIND_APPS_STDOUT,
  MDFIND_BAD_QUERY_STDOUT,
  MDUTIL_DISABLED_STDOUT_UNVERIFIED,
  MDUTIL_ENABLED_STDOUT,
  MDUTIL_UNKNOWN_STDOUT,
  PLOCATE_NO_DATABASE,
  PLOCATE_NO_MATCH,
} from "./fixtures";
import type { PathFacts } from "./host";
import {
  HOSTFS_TOOLS,
  _resetHostSeams,
  _setClock,
  _setIdentity,
  _setPathProbe,
  _setPlatform,
  _setRenamer,
  _setRunner,
  _setWatchFactory,
  osIndexSearch,
  trashPath,
  watchPath,
} from "./index";
import { removeClaimedInfoFile } from "./lib/trash-engine";
import type { RunRequest, RunResult } from "./run";

const originalCwd = process.cwd();
let workspace: string;
/** Every command a test's tool call tried to run, in order. */
let commands: RunRequest[] = [];

const FIXED_NOW = Date.parse("2026-09-19T01:29:18Z");

function ok(stdout: string, code = 0): RunResult {
  return { code, stdout, stderr: "", timedOut: false, missing: false };
}

/** Answer each command from a table keyed by the program name. */
function serve(table: Record<string, RunResult | ((request: RunRequest) => RunResult)>): void {
  _setRunner(async (request) => {
    commands.push(request);
    const program = request.argv[0] as string;
    const entry = table[program];
    if (entry === undefined) {
      return { code: 127, stdout: "", stderr: "", timedOut: false, missing: true };
    }
    return typeof entry === "function" ? entry(request) : entry;
  });
}

async function call(tool: RegisteredTool, input: unknown): Promise<string> {
  const parsed = tool.inputSchema.parse(input);
  const result = await tool.execute(parsed);
  return typeof result === "string" ? result : JSON.stringify(result);
}

async function callJson(tool: RegisteredTool, input: unknown): Promise<Record<string, unknown>> {
  const text = await call(tool, input);
  return JSON.parse(text) as Record<string, unknown>;
}

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-hostfs-")));
  process.chdir(workspace);
  commands = [];
  // Start every test on a platform none of the backends support, so a test
  // that FORGOT `_setPlatform` fails the same way everywhere instead of
  // quietly inheriting whoever ran it. Without this the default is
  // `process.platform`: the mdfind truncation test below passed on macOS for
  // exactly that reason and failed on CI, where it took the plocate branch
  // and got an empty listing. A host-dependent default turns a missing seam
  // into a machine-dependent result, which is the one failure this file is
  // most supposed to prevent.
  _setPlatform("other");
  // The clock is NOT frozen here. `WatchPath` reads it to decide when a
  // settle window has closed, so a fixed clock would mean no window ever
  // closes and every watch ran to its full deadline — which is how this file
  // first took fifteen seconds to assert a twenty-millisecond fold. It is
  // frozen only where the output depends on it, in `linuxHost()` below.
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
  _resetHostSeams();
  _setRunner(undefined);
  _setWatchFactory(undefined);
});

// ===========================================================================
// WatchPath
// ===========================================================================

type Emit = (eventType: string, filename: string | null) => void;

/**
 * A watcher that replays a script instead of asking the kernel.
 *
 * Bursts are emitted SYNCHRONOUSLY: a timer cannot fire between two
 * synchronous calls, so events in one burst always land in one settle window
 * no matter how loaded the machine is. Separate bursts are spaced by a real
 * sleep that is an order of magnitude longer than the window, which a slow
 * box can only make longer still.
 */
function scriptedWatcher(script: (emit: Emit) => void | Promise<void>): void {
  _setWatchFactory((_target, _options, emit) => {
    queueMicrotask(() => {
      void script(emit);
    });
    return { close: () => undefined };
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("WatchPath: containment and input", () => {
  test("a path outside the workspace is refused", async () => {
    const result = await call(watchPath, { path: "../escape", timeoutMs: 50 });
    expect(result).toContain("refused path");
    expect(result).toContain("outside the workspace root");
  });

  test("an absolute path outside the workspace is refused", async () => {
    const result = await call(watchPath, { path: "/etc", timeoutMs: 50 });
    expect(result).toContain("refused path");
  });

  test("a symlink pointing out of the workspace is refused, not followed", async () => {
    symlinkSync(tmpdir(), join(workspace, "out"));
    const result = await call(watchPath, { path: "out", timeoutMs: 50 });
    expect(result).toContain("refused path");
  });

  test("a path that does not exist is refused with that reason", async () => {
    const result = await call(watchPath, { path: "nope", timeoutMs: 50 });
    expect(result).toContain("no such path");
  });

  test("recursive on a file is refused rather than quietly ignored", async () => {
    writeFileSync(join(workspace, "a.txt"), "x");
    const result = await call(watchPath, { path: "a.txt", timeoutMs: 50, recursive: true });
    expect(result).toContain("not a directory");
  });

  test("the deadline is required by the schema", () => {
    expect(() => watchPath.inputSchema.parse({ path: "." })).toThrow();
  });

  test("a deadline longer than the ceiling is refused by the schema", () => {
    expect(() => watchPath.inputSchema.parse({ path: ".", timeoutMs: 10_000_000 })).toThrow();
  });
});

describe("WatchPath: the bounds", () => {
  test("a quiet watch ends at the deadline and says so", async () => {
    scriptedWatcher(() => undefined);
    const result = await callJson(watchPath, { path: ".", timeoutMs: 60 });
    expect(result["eventCount"]).toBe(0);
    // The reason, not just the emptiness: this is exactly the answer a caller
    // would otherwise mistake for "the file never changed".
    expect(result["stoppedBy"]).toBe("deadline");
  }, 10_000);

  test("the event cap ends the watch and says so", async () => {
    writeFileSync(join(workspace, "a.txt"), "x");
    scriptedWatcher((emit) => {
      // The write is real. A notification about a file that did not actually
      // change is dropped as stale, so a test that only emitted would be
      // asserting nothing.
      writeFileSync(join(workspace, "a.txt"), "xx");
      emit("change", "a.txt");
    });
    const result = await callJson(watchPath, {
      path: ".",
      timeoutMs: 5_000,
      maxEvents: 1,
      settleMs: 20,
    });
    expect(result["stoppedBy"]).toBe("eventCap");
    expect(result["eventCount"]).toBe(1);
  }, 20_000);

  test("an already-aborted signal returns at once, and says it was aborted", async () => {
    scriptedWatcher(() => undefined);
    const controller = new AbortController();
    controller.abort();
    const parsed = watchPath.inputSchema.parse({ path: ".", timeoutMs: 600_000 });
    const text = await watchPath.execute(parsed, {
      toolUseId: "t1",
      signal: controller.signal,
    });
    const result = JSON.parse(String(text)) as Record<string, unknown>;
    // A ten-minute deadline: if the abort were not honoured this test would
    // hit its own budget instead of passing.
    expect(result["stoppedBy"]).toBe("aborted");
  }, 20_000);

  test("an abort mid-watch is reported as an abort, never as a deadline", async () => {
    scriptedWatcher(() => undefined);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const parsed = watchPath.inputSchema.parse({ path: ".", timeoutMs: 600_000 });
    const text = await watchPath.execute(parsed, {
      toolUseId: "t2",
      signal: controller.signal,
    });
    expect((JSON.parse(String(text)) as Record<string, unknown>)["stoppedBy"]).toBe("aborted");
  }, 20_000);
});

describe("WatchPath: what it reports", () => {
  test("three notifications for one save are reported as one event", async () => {
    writeFileSync(join(workspace, "app.ts"), "x");
    scriptedWatcher((emit) => {
      // The recorded Linux shape: one logical save, three writes, three
      // notifications. The writes are real and each one grows the file, so
      // every notification is about a genuine change.
      writeFileSync(join(workspace, "app.ts"), "");
      emit("change", "app.ts");
      writeFileSync(join(workspace, "app.ts"), "yy");
      emit("change", "app.ts");
      writeFileSync(join(workspace, "app.ts"), "yyzz");
      emit("change", "app.ts");
    });
    const result = await callJson(watchPath, {
      path: ".",
      timeoutMs: 5_000,
      maxEvents: 1,
      settleMs: 20,
    });
    const events = result["events"] as Array<Record<string, unknown>>;
    expect(events.length).toBe(1);
    expect(events[0]?.["path"]).toBe("app.ts");
    expect(events[0]?.["kind"]).toBe("modified");
    expect(events[0]?.["rawCount"]).toBe(3);
    expect(result["rawCount"]).toBe(3);
  }, 20_000);

  test("two bursts a long way apart are two events", async () => {
    writeFileSync(join(workspace, "app.ts"), "x");
    scriptedWatcher(async (emit) => {
      writeFileSync(join(workspace, "app.ts"), "first");
      emit("change", "app.ts");
      // Ten times the settle window. A slow machine only widens this gap.
      await sleep(200);
      writeFileSync(join(workspace, "app.ts"), "second, longer");
      emit("change", "app.ts");
    });
    const result = await callJson(watchPath, {
      path: ".",
      timeoutMs: 5_000,
      maxEvents: 2,
      settleMs: 20,
    });
    expect(result["eventCount"]).toBe(2);
    expect(result["stoppedBy"]).toBe("eventCap");
  }, 25_000);

  test("a file created during the watch is reported as created", async () => {
    scriptedWatcher((emit) => {
      writeFileSync(join(workspace, "new.txt"), "hello");
      emit("rename", "new.txt");
    });
    const result = await callJson(watchPath, {
      path: ".",
      timeoutMs: 5_000,
      maxEvents: 1,
      settleMs: 20,
    });
    const events = result["events"] as Array<Record<string, unknown>>;
    expect(events[0]?.["kind"]).toBe("created");
  }, 20_000);

  test("a file deleted during the watch is reported as deleted", async () => {
    writeFileSync(join(workspace, "gone.txt"), "x");
    scriptedWatcher((emit) => {
      rmSync(join(workspace, "gone.txt"));
      emit("rename", "gone.txt");
    });
    const result = await callJson(watchPath, {
      path: ".",
      timeoutMs: 5_000,
      maxEvents: 1,
      settleMs: 20,
    });
    const events = result["events"] as Array<Record<string, unknown>>;
    expect(events[0]?.["kind"]).toBe("deleted");
    expect(events[0]?.["transient"]).toBeUndefined();
  }, 20_000);

  test("macOS's 'rename' for a plain modification still reads as modified", async () => {
    _setPlatform("darwin");
    writeFileSync(join(workspace, "log.txt"), "x");
    scriptedWatcher((emit) => {
      // Recorded: appending one byte on macOS arrives as `rename`.
      writeFileSync(join(workspace, "log.txt"), "xx");
      emit("rename", "log.txt");
    });
    const result = await callJson(watchPath, {
      path: ".",
      timeoutMs: 5_000,
      maxEvents: 1,
      settleMs: 20,
    });
    const events = result["events"] as Array<Record<string, unknown>>;
    expect(events[0]?.["kind"]).toBe("modified");
    expect(events[0]?.["eventTypes"]).toEqual(["rename"]);
  }, 20_000);

  test("an editor's temp file is dropped by default, and does not fill the cap", async () => {
    writeFileSync(join(workspace, "doc.md"), "one");
    scriptedWatcher(async (emit) => {
      // The atomic save, in the order it happens: a temp file appears and is
      // gone again, then the target is replaced. The two are separated here
      // so the temp file's window closes first — which is what proves it did
      // not consume the single event the caller asked for.
      emit("rename", "doc.md.tmp12345");
      emit("rename", "doc.md.tmp12345");
      await sleep(200);
      writeFileSync(join(workspace, "doc.md"), "two");
      emit("rename", "doc.md");
    });
    const result = await callJson(watchPath, {
      path: ".",
      timeoutMs: 5_000,
      maxEvents: 1,
      settleMs: 20,
    });
    const events = result["events"] as Array<Record<string, unknown>>;
    expect(events.map((event) => event["path"])).toEqual(["doc.md"]);
    expect(result["transientDropped"]).toBe(1);
    expect(result["stoppedBy"]).toBe("eventCap");
  }, 25_000);

  test("includeTransient reports the temp file, flagged as transient", async () => {
    writeFileSync(join(workspace, "doc.md"), "one");
    scriptedWatcher((emit) => {
      emit("rename", "doc.md.tmp12345");
    });
    const result = await callJson(watchPath, {
      path: ".",
      timeoutMs: 5_000,
      maxEvents: 1,
      settleMs: 20,
      includeTransient: true,
    });
    const events = result["events"] as Array<Record<string, unknown>>;
    expect(events[0]?.["path"]).toBe("doc.md.tmp12345");
    expect(events[0]?.["transient"]).toBe(true);
  }, 20_000);

  test("a glob filter decides what counts towards the cap", async () => {
    writeFileSync(join(workspace, "noise.log"), "x");
    writeFileSync(join(workspace, "wanted.ts"), "x");
    scriptedWatcher(async (emit) => {
      writeFileSync(join(workspace, "noise.log"), "xx");
      emit("change", "noise.log");
      await sleep(200);
      writeFileSync(join(workspace, "wanted.ts"), "xx");
      emit("change", "wanted.ts");
    });
    const result = await callJson(watchPath, {
      path: ".",
      timeoutMs: 5_000,
      maxEvents: 1,
      settleMs: 20,
      match: "**/*.ts",
    });
    const events = result["events"] as Array<Record<string, unknown>>;
    expect(events.map((event) => event["path"])).toEqual(["wanted.ts"]);
    expect(result["filteredOut"]).toBe(1);
  }, 25_000);

  test("a kind filter drops the kinds nobody asked about", async () => {
    writeFileSync(join(workspace, "a.txt"), "x");
    scriptedWatcher(async (emit) => {
      writeFileSync(join(workspace, "a.txt"), "xx");
      emit("change", "a.txt");
      await sleep(200);
      rmSync(join(workspace, "a.txt"));
      emit("rename", "a.txt");
    });
    const result = await callJson(watchPath, {
      path: ".",
      timeoutMs: 5_000,
      maxEvents: 1,
      settleMs: 20,
      kinds: ["deleted"],
    });
    const events = result["events"] as Array<Record<string, unknown>>;
    expect(events[0]?.["kind"]).toBe("deleted");
  }, 25_000);

  test("a watched FILE reports its own changes under '.'", async () => {
    writeFileSync(join(workspace, "solo.txt"), "x");
    scriptedWatcher((emit) => {
      writeFileSync(join(workspace, "solo.txt"), "xx");
      emit("change", "solo.txt");
    });
    const result = await callJson(watchPath, {
      path: "solo.txt",
      timeoutMs: 5_000,
      maxEvents: 1,
      settleMs: 20,
    });
    const events = result["events"] as Array<Record<string, unknown>>;
    expect(events[0]?.["path"]).toBe(".");
    expect(events[0]?.["kind"]).toBe("modified");
  }, 20_000);

  test("a save the runtime never reported is still found", async () => {
    // The recorded Bun-on-macOS shape: the temp file's events arrive and the
    // rename onto the target does not. Without reconciliation this watch
    // returns nothing at all for the save it was watching for.
    writeFileSync(join(workspace, "doc.md"), "one");
    scriptedWatcher((emit) => {
      writeFileSync(join(workspace, "doc.md"), "a much longer second version");
      writeFileSync(join(workspace, "doc.md.tmpABC"), "x");
      rmSync(join(workspace, "doc.md.tmpABC"));
      emit("rename", "doc.md.tmpABC");
      emit("rename", "doc.md.tmpABC");
    });
    const result = await callJson(watchPath, {
      path: ".",
      timeoutMs: 5_000,
      maxEvents: 1,
      settleMs: 20,
    });
    const events = result["events"] as Array<Record<string, unknown>>;
    expect(events.map((event) => event["path"])).toEqual(["doc.md"]);
    expect(events[0]?.["kind"]).toBe("modified");
    // Tagged, so the caller can see the answer came from a re-read rather
    // than from the OS.
    expect(events[0]?.["eventTypes"]).toEqual(["reconciled"]);
    expect((result["notes"] as string[]).join(" ")).toContain("re-reading the directory");
  }, 20_000);

  test("the same recovery works when the temp file arrives as two events", async () => {
    // Linux reports the create and the delete separately, macOS coalesces
    // them into one. Both shapes have to reach the same answer.
    writeFileSync(join(workspace, "doc.md"), "one");
    scriptedWatcher((emit) => {
      writeFileSync(join(workspace, "doc.md.tmpABC"), "x");
      emit("rename", "doc.md.tmpABC");
      writeFileSync(join(workspace, "doc.md"), "a much longer second version");
      rmSync(join(workspace, "doc.md.tmpABC"));
      emit("rename", "doc.md.tmpABC");
    });
    const result = await callJson(watchPath, {
      path: ".",
      timeoutMs: 5_000,
      maxEvents: 1,
      settleMs: 20,
    });
    const events = result["events"] as Array<Record<string, unknown>>;
    expect(events.map((event) => event["path"])).toEqual(["doc.md"]);
    expect(events[0]?.["kind"]).toBe("modified");
  }, 20_000);

  test("reconciliation invents nothing when only the temp file happened", async () => {
    writeFileSync(join(workspace, "doc.md"), "one");
    scriptedWatcher((emit) => {
      writeFileSync(join(workspace, "doc.md.tmpABC"), "x");
      rmSync(join(workspace, "doc.md.tmpABC"));
      emit("rename", "doc.md.tmpABC");
    });
    const result = await callJson(watchPath, { path: ".", timeoutMs: 400, settleMs: 20 });
    expect(result["eventCount"]).toBe(0);
    expect(result["transientDropped"]).toBe(1);
    expect(result["stoppedBy"]).toBe("deadline");
    expect(result["notes"]).toBeUndefined();
  }, 15_000);

  test("a wall-clock jump does not disturb the fold", async () => {
    // The settle window is measured on a monotonic clock, so an NTP
    // correction or a laptop waking up mid-watch cannot leave a window that
    // never closes. Here the wall clock lurches backwards by an hour while
    // the events arrive, and the answer is unchanged.
    writeFileSync(join(workspace, "app.ts"), "x");
    let wall = Date.parse("2026-09-19T01:29:18Z");
    _setClock(() => {
      wall -= 3_600_000;
      return wall;
    });
    scriptedWatcher((emit) => {
      writeFileSync(join(workspace, "app.ts"), "xx");
      emit("change", "app.ts");
      writeFileSync(join(workspace, "app.ts"), "xxyy");
      emit("change", "app.ts");
    });
    const result = await callJson(watchPath, {
      path: ".",
      timeoutMs: 5_000,
      maxEvents: 1,
      settleMs: 20,
    });
    expect(result["stoppedBy"]).toBe("eventCap");
    expect((result["events"] as Array<Record<string, unknown>>)[0]?.["rawCount"]).toBe(2);
  }, 20_000);

  test("a notification with no filename is attributed to the watched path", async () => {
    // Some platforms report a change without saying which entry changed.
    // "Something happened here" is still the answer to the question asked.
    scriptedWatcher((emit) => {
      emit("rename", null);
    });
    const result = await callJson(watchPath, {
      path: ".",
      timeoutMs: 5_000,
      maxEvents: 1,
      settleMs: 20,
    });
    const events = result["events"] as Array<Record<string, unknown>>;
    expect(events[0]?.["path"]).toBe(".");
  }, 20_000);

  test("a notification about a file that did not change is not an event", async () => {
    // Observed on macOS 15.6 under Bun 1.3.14: a write made moments before
    // the watch was attached arrives as the watch's FIRST event. A caller who
    // writes a file and then waits for the next change would be told
    // immediately that it changed.
    writeFileSync(join(workspace, "settled.txt"), "unchanged");
    scriptedWatcher((emit) => {
      emit("rename", "settled.txt");
    });
    const result = await callJson(watchPath, { path: ".", timeoutMs: 400, settleMs: 20 });
    expect(result["eventCount"]).toBe(0);
    expect(result["stoppedBy"]).toBe("deadline");
    expect((result["notes"] as string[]).join(" ")).toContain("unchanged");
  }, 15_000);

  test("a chmod is a change, even though it leaves mtime alone", async () => {
    // Which is why ctime is compared too: a permission change moves ctime
    // and nothing else, and a watcher that only looked at mtime would call
    // it nothing.
    writeFileSync(join(workspace, "perm.txt"), "x");
    scriptedWatcher((emit) => {
      chmodSync(join(workspace, "perm.txt"), 0o600);
      emit("rename", "perm.txt");
    });
    const result = await callJson(watchPath, {
      path: ".",
      timeoutMs: 5_000,
      maxEvents: 1,
      settleMs: 20,
    });
    expect(result["eventCount"]).toBe(1);
    expect((result["events"] as Array<Record<string, unknown>>)[0]?.["kind"]).toBe("modified");
  }, 20_000);

  test("a notification naming a path outside the tree is ignored", async () => {
    scriptedWatcher((emit) => {
      emit("rename", "../outside.txt");
    });
    const result = await callJson(watchPath, { path: ".", timeoutMs: 60, settleMs: 10 });
    expect(result["eventCount"]).toBe(0);
    expect(result["stoppedBy"]).toBe("deadline");
  }, 10_000);

  test("nested changes are reported when the watch is recursive", async () => {
    mkdirSync(join(workspace, "pkg/src"), { recursive: true });
    scriptedWatcher((emit) => {
      writeFileSync(join(workspace, "pkg/src/new.ts"), "x");
      emit("rename", join("pkg", "src", "new.ts"));
    });
    const result = await callJson(watchPath, {
      path: ".",
      timeoutMs: 5_000,
      maxEvents: 1,
      settleMs: 20,
      recursive: true,
    });
    const events = result["events"] as Array<Record<string, unknown>>;
    expect(events[0]?.["path"]).toBe("pkg/src/new.ts");
    expect(events[0]?.["kind"]).toBe("created");
  }, 20_000);
});

describe("WatchPath: the platform's own failures", () => {
  test("a recursive watch on Linux carries the caveat about new directories", async () => {
    _setPlatform("linux");
    mkdirSync(join(workspace, "tree"));
    scriptedWatcher(() => undefined);
    const result = await callJson(watchPath, {
      path: "tree",
      timeoutMs: 60,
      recursive: true,
    });
    const notes = result["notes"] as string[];
    expect(notes.join(" ")).toContain("created inside a directory");
  }, 10_000);

  test("macOS gets no Linux caveat", async () => {
    _setPlatform("darwin");
    mkdirSync(join(workspace, "tree"));
    scriptedWatcher(() => undefined);
    const result = await callJson(watchPath, {
      path: "tree",
      timeoutMs: 60,
      recursive: true,
    });
    expect(result["notes"]).toBeUndefined();
  }, 10_000);

  test("the inotify limit is reported by name, not swallowed as silence", async () => {
    _setWatchFactory(() => {
      const error = new Error("ENOSPC: System limit for number of file watchers reached");
      (error as NodeJS.ErrnoException).code = "ENOSPC";
      throw error;
    });
    const result = await callJson(watchPath, { path: ".", timeoutMs: 5_000 });
    // Swallowed, this looks exactly like a directory where nothing happened.
    expect(result["stoppedBy"]).toBe("watchError");
    const notes = (result["notes"] as string[]).join(" ");
    expect(notes).toContain("max_user_watches");
  }, 20_000);

  test("any other attach failure is reported too", async () => {
    _setWatchFactory(() => {
      throw new Error("EPERM: operation not permitted");
    });
    const result = await callJson(watchPath, { path: ".", timeoutMs: 5_000 });
    expect(result["stoppedBy"]).toBe("watchError");
    expect((result["notes"] as string[]).join(" ")).toContain("EPERM");
  }, 20_000);
});

// ===========================================================================
// TrashPath
// ===========================================================================

/** A home directory and a uid, so the FreeDesktop layout is a known place. */
function linuxHost(home = join(workspace, "home")): string {
  _setPlatform("linux");
  // The trash writes a DeletionDate into a file whose bytes a test asserts.
  _setClock(() => FIXED_NOW);
  mkdirSync(home, { recursive: true });
  _setIdentity({ home, xdgDataHome: undefined, uid: 1000 });
  return join(home, ".local/share/Trash");
}

/**
 * The real facts about a path, with the device number replaced.
 *
 * Everything else is genuine — this is the probe the tools would have used,
 * with the one field a single-filesystem machine cannot vary.
 */
function facts(path: string, device: number): PathFacts | undefined {
  try {
    const stats = lstatSync(path, { bigint: true });
    return {
      exists: true,
      device,
      isDirectory: stats.isDirectory(),
      isSymlink: stats.isSymbolicLink(),
      mode: Number(stats.mode),
      mtimeMs: Number(stats.mtimeMs),
      changeStamp: `${stats.mtimeNs}:${stats.ctimeNs}`,
      sizeBytes: Number(stats.size),
    };
  } catch {
    return undefined;
  }
}

describe("TrashPath: platforms it refuses", () => {
  test("macOS is refused, and the refusal names what it would take", async () => {
    _setPlatform("darwin");
    writeFileSync(join(workspace, "a.txt"), "x");
    const result = await callJson(trashPath, { paths: ["a.txt"] });
    expect(result["supported"]).toBe(false);
    expect(result["trashed"]).toBe(0);
    expect(String(result["reason"])).toContain("trashItemAtURL");
    // And the file is still exactly where it was. This is the whole point:
    // an unsupported platform must not become a deletion.
    expect(existsSync(join(workspace, "a.txt"))).toBe(true);
  });

  test("the macOS refusal explicitly rejects the ~/.Trash shortcut", async () => {
    _setPlatform("darwin");
    const result = await callJson(trashPath, { paths: ["a.txt"] });
    expect(String(result["reason"])).toContain("~/.Trash");
  });

  test("Windows is refused, naming the shell API and the missing evidence", async () => {
    _setPlatform("win32");
    const result = await callJson(trashPath, { paths: ["a.txt"] });
    expect(result["supported"]).toBe(false);
    expect(String(result["reason"])).toContain("Recycle Bin");
    expect(String(result["reason"])).toContain("unverified");
  });

  test("an unknown platform is refused rather than guessed at", async () => {
    _setPlatform("other");
    const result = await callJson(trashPath, { paths: ["a.txt"] });
    expect(result["supported"]).toBe(false);
  });
});

describe("TrashPath: the FreeDesktop move", () => {
  test("a file is MOVED into the trash, with a record beside it", async () => {
    const trash = linuxHost();
    writeFileSync(join(workspace, "simple.txt"), "hello\n");
    const result = await callJson(trashPath, { paths: ["simple.txt"] });

    expect(result["trashed"]).toBe(1);
    expect(existsSync(join(workspace, "simple.txt"))).toBe(false);
    expect(readFileSync(join(trash, "files/simple.txt"), "utf8")).toBe("hello\n");
    expect(readFileSync(join(trash, "info/simple.txt.trashinfo"), "utf8")).toBe(
      `[Trash Info]\nPath=${encodeURI(join(workspace, "simple.txt"))}\nDeletionDate=${localStamp()}\n`,
    );
  });

  test("the record names the original location, so it can be restored", async () => {
    const trash = linuxHost();
    mkdirSync(join(workspace, "deep"), { recursive: true });
    writeFileSync(join(workspace, "deep/report.txt"), "x");
    await call(trashPath, { paths: ["deep/report.txt"] });
    const record = readFileSync(join(trash, "info/report.txt.trashinfo"), "utf8");
    expect(record).toContain(`Path=${join(workspace, "deep/report.txt")}`);
  });

  test("a directory goes whole, contents and all", async () => {
    const trash = linuxHost();
    mkdirSync(join(workspace, "tree/sub"), { recursive: true });
    writeFileSync(join(workspace, "tree/sub/deep.txt"), "z\n");
    const result = await callJson(trashPath, { paths: ["tree"] });
    expect(result["trashed"]).toBe(1);
    expect(readFileSync(join(trash, "files/tree/sub/deep.txt"), "utf8")).toBe("z\n");
  });

  test("a second file with the same name becomes name.2.ext, not an overwrite", async () => {
    const trash = linuxHost();
    writeFileSync(join(workspace, "simple.txt"), "first\n");
    await call(trashPath, { paths: ["simple.txt"] });
    writeFileSync(join(workspace, "simple.txt"), "second\n");
    const result = await callJson(trashPath, { paths: ["simple.txt"] });

    const entries = result["entries"] as Array<Record<string, unknown>>;
    expect(entries[0]?.["storedAs"]).toBe("simple.2.txt");
    // The first one is untouched: a trash that overwrites is a trash that
    // loses the thing you were trying not to lose.
    expect(readFileSync(join(trash, "files/simple.txt"), "utf8")).toBe("first\n");
    expect(readFileSync(join(trash, "files/simple.2.txt"), "utf8")).toBe("second\n");
  });

  test("a symlink is trashed as the LINK, and its target is untouched", async () => {
    const trash = linuxHost();
    writeFileSync(join(workspace, "target.txt"), "keep me\n");
    symlinkSync(join(workspace, "target.txt"), join(workspace, "link.txt"));
    const result = await callJson(trashPath, { paths: ["link.txt"] });
    expect(result["trashed"]).toBe(1);
    expect(lstatSync(join(trash, "files/link.txt")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(workspace, "target.txt"), "utf8")).toBe("keep me\n");
  });

  test("the trash directories are created 0700, as the spec requires", async () => {
    const trash = linuxHost();
    writeFileSync(join(workspace, "a.txt"), "x");
    await call(trashPath, { paths: ["a.txt"] });
    // A world-readable trash leaks the name of everything ever deleted.
    expect(lstatSync(join(trash, "files")).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(trash, "info")).mode & 0o777).toBe(0o700);
  });

  test("several paths move in one call, each reported separately", async () => {
    linuxHost();
    writeFileSync(join(workspace, "a.txt"), "a");
    writeFileSync(join(workspace, "b.txt"), "b");
    const result = await callJson(trashPath, { paths: ["a.txt", "b.txt"] });
    expect(result["trashed"]).toBe(2);
    expect((result["entries"] as unknown[]).length).toBe(2);
  });

  test("$XDG_DATA_HOME is honoured when it is set", async () => {
    _setPlatform("linux");
    _setClock(() => FIXED_NOW);
    const data = join(workspace, "xdg");
    mkdirSync(data, { recursive: true });
    _setIdentity({ home: join(workspace, "home"), xdgDataHome: data, uid: 1000 });
    writeFileSync(join(workspace, "a.txt"), "x");
    await call(trashPath, { paths: ["a.txt"] });
    expect(existsSync(join(data, "Trash/files/a.txt"))).toBe(true);
  });

  test("with no home at all the call is refused, not redirected somewhere", async () => {
    _setPlatform("linux");
    _setClock(() => FIXED_NOW);
    _setIdentity({ home: undefined, xdgDataHome: undefined, uid: 1000 });
    writeFileSync(join(workspace, "a.txt"), "x");
    const result = await callJson(trashPath, { paths: ["a.txt"] });
    const entries = result["entries"] as Array<Record<string, unknown>>;
    expect(entries[0]?.["status"]).toBe("refused");
    expect(String(entries[0]?.["reason"])).toContain("HOME");
    expect(existsSync(join(workspace, "a.txt"))).toBe(true);
  });
});

describe("TrashPath: the dry run is the same plan", () => {
  test("dryRun moves nothing and writes nothing", async () => {
    const trash = linuxHost();
    writeFileSync(join(workspace, "a.txt"), "x");
    const result = await callJson(trashPath, { paths: ["a.txt"], dryRun: true });
    expect(result["dryRun"]).toBe(true);
    expect(result["trashed"]).toBe(0);
    expect(result["wouldTrash"]).toBe(1);
    expect(existsSync(join(workspace, "a.txt"))).toBe(true);
    expect(existsSync(trash)).toBe(false);
  });

  test("what the dry run predicts is what the real call does", async () => {
    linuxHost();
    writeFileSync(join(workspace, "simple.txt"), "one");
    await call(trashPath, { paths: ["simple.txt"] });
    writeFileSync(join(workspace, "simple.txt"), "two");

    const preview = await callJson(trashPath, { paths: ["simple.txt"], dryRun: true });
    const real = await callJson(trashPath, { paths: ["simple.txt"] });
    const predicted = (preview["entries"] as Array<Record<string, unknown>>)[0];
    const actual = (real["entries"] as Array<Record<string, unknown>>)[0];
    expect(predicted?.["wouldStoreAs"]).toBe("simple.2.txt");
    expect(actual?.["storedAs"]).toBe(predicted?.["wouldStoreAs"]);
    expect(actual?.["trashDir"]).toBe(predicted?.["trashDir"]);
  });

  test("a dry run reports a refusal exactly as the real call would", async () => {
    linuxHost();
    const preview = await callJson(trashPath, { paths: ["missing.txt"], dryRun: true });
    const real = await callJson(trashPath, { paths: ["missing.txt"] });
    const previewEntry = (preview["entries"] as Array<Record<string, unknown>>)[0];
    const realEntry = (real["entries"] as Array<Record<string, unknown>>)[0];
    expect(previewEntry?.["reason"]).toBe(realEntry?.["reason"]);
    expect(previewEntry?.["status"]).toBe("refused");
  });
});

describe("TrashPath: what it refuses to guess", () => {
  test("the same path twice is refused rather than counted twice", async () => {
    linuxHost();
    writeFileSync(join(workspace, "a.txt"), "x");
    const result = await callJson(trashPath, { paths: ["a.txt", "./a.txt"] });
    const entries = result["entries"] as Array<Record<string, unknown>>;
    expect(result["trashed"]).toBe(1);
    expect(entries[1]?.["status"]).toBe("refused");
    expect(String(entries[1]?.["reason"])).toContain("listed twice");
  });

  test("a path nested inside another path in the same call is refused", async () => {
    linuxHost();
    mkdirSync(join(workspace, "tree"), { recursive: true });
    writeFileSync(join(workspace, "tree/inner.txt"), "x");
    const result = await callJson(trashPath, { paths: ["tree", "tree/inner.txt"] });
    const entries = result["entries"] as Array<Record<string, unknown>>;
    // Trashing the parent takes the child with it; reporting two moves would
    // tell the caller something that did not happen.
    expect(entries[1]?.["status"]).toBe("refused");
    expect(String(entries[1]?.["reason"])).toContain("inside");
  });

  test("a path that does not exist is refused, and the others still move", async () => {
    linuxHost();
    writeFileSync(join(workspace, "real.txt"), "x");
    const result = await callJson(trashPath, { paths: ["ghost.txt", "real.txt"] });
    expect(result["trashed"]).toBe(1);
    expect(result["refused"]).toBe(1);
  });

  test("the workspace root itself is refused", async () => {
    linuxHost();
    const result = await callJson(trashPath, { paths: ["."] });
    const entries = result["entries"] as Array<Record<string, unknown>>;
    expect(String(entries[0]?.["reason"])).toContain("workspace root");
  });

  test("a path outside the workspace is refused before anything is planned", async () => {
    linuxHost();
    const result = await callJson(trashPath, { paths: ["../escape.txt"] });
    expect(result["trashed"]).toBe(0);
    expect(String(result["reason"])).toContain("outside the workspace root");
  });

  test("a directory that contains the trash is refused, not moved into itself", async () => {
    _setPlatform("linux");
    _setClock(() => FIXED_NOW);
    const home = join(workspace, "home");
    mkdirSync(home, { recursive: true });
    _setIdentity({ home, xdgDataHome: undefined, uid: 1000 });
    const result = await callJson(trashPath, { paths: ["home"] });
    const entries = result["entries"] as Array<Record<string, unknown>>;
    expect(String(entries[0]?.["reason"])).toContain("into itself");
    expect(existsSync(home)).toBe(true);
  });

  test("something already in the trash is not trashed again", async () => {
    // The home trash is inside the workspace in these tests, which is exactly
    // the shape that would otherwise recurse.
    _setPlatform("linux");
    _setClock(() => FIXED_NOW);
    const home = join(workspace, "home");
    mkdirSync(join(home, ".local/share/Trash/files"), { recursive: true });
    _setIdentity({ home, xdgDataHome: undefined, uid: 1000 });
    writeFileSync(join(home, ".local/share/Trash/files/old.txt"), "x");
    const result = await callJson(trashPath, {
      paths: ["home/.local/share/Trash/files/old.txt"],
    });
    const entries = result["entries"] as Array<Record<string, unknown>>;
    expect(String(entries[0]?.["reason"])).toContain("already inside the trash");
  });
});

describe("TrashPath: the same-filesystem rule", () => {
  /**
   * Report everything under `otherRoot` as living on a different device.
   *
   * The device number is the one fact a single-filesystem machine cannot
   * produce, and it decides the whole branch: this is why the probe is a seam
   * rather than a direct `lstat`.
   */
  function pretendSeparateFilesystem(otherRoot: string, stickyTrash = false): void {
    _setPathProbe((path) => {
      const found = facts(path, path.startsWith(otherRoot) ? 99 : 1);
      if (found === undefined) return undefined;
      // The sticky bit is applied through the probe rather than with chmod:
      // macOS silently drops it on a directory in a temp folder, so a test
      // that set it for real would assert one thing here and another on CI.
      if (stickyTrash && path === join(otherRoot, ".Trash")) {
        return { ...found, mode: found.mode | 0o1000 };
      }
      return found;
    });
  }

  test("a file on another filesystem goes to that volume's own trash", async () => {
    linuxHost();
    const volume = join(workspace, "volume");
    mkdirSync(volume, { recursive: true });
    writeFileSync(join(volume, "onvol.txt"), "precious\n");
    pretendSeparateFilesystem(volume);

    const result = await callJson(trashPath, { paths: ["volume/onvol.txt"] });
    const entries = result["entries"] as Array<Record<string, unknown>>;
    // The spec's answer to a cross-device delete is a trash directory at the
    // top of the other filesystem, NOT a copy into the home trash.
    expect(entries[0]?.["trashDir"]).toBe(join(volume, ".Trash-1000"));
    expect(readFileSync(join(volume, ".Trash-1000/files/onvol.txt"), "utf8")).toBe("precious\n");
    expect(existsSync(join(volume, "onvol.txt"))).toBe(false);
  });

  test("the record on a volume trash is RELATIVE to the volume", async () => {
    linuxHost();
    const volume = join(workspace, "volume");
    mkdirSync(volume, { recursive: true });
    writeFileSync(join(volume, "onvol.txt"), "x\n");
    pretendSeparateFilesystem(volume);
    await call(trashPath, { paths: ["volume/onvol.txt"] });
    const record = readFileSync(join(volume, ".Trash-1000/info/onvol.txt.trashinfo"), "utf8");
    // So the entry still means something when the volume is mounted
    // somewhere else, which a removable disk does every time.
    expect(record).toContain("Path=onvol.txt\n");
  });

  test("a sticky $topdir/.Trash is used in preference, under the uid", async () => {
    linuxHost();
    const volume = join(workspace, "volume");
    mkdirSync(join(volume, ".Trash"), { recursive: true });
    writeFileSync(join(volume, "onvol.txt"), "x\n");
    pretendSeparateFilesystem(volume, true);

    const result = await callJson(trashPath, { paths: ["volume/onvol.txt"] });
    const entries = result["entries"] as Array<Record<string, unknown>>;
    expect(entries[0]?.["trashDir"]).toBe(join(volume, ".Trash/1000"));
    expect(existsSync(join(volume, ".Trash/1000/files/onvol.txt"))).toBe(true);
  });

  test("a $topdir/.Trash WITHOUT the sticky bit is not used", async () => {
    linuxHost();
    const volume = join(workspace, "volume");
    mkdirSync(join(volume, ".Trash"), { recursive: true });
    writeFileSync(join(volume, "onvol.txt"), "x\n");
    // Without the sticky bit any user on the machine could replace another
    // user's trashed files, so the spec says not to use the directory.
    pretendSeparateFilesystem(volume, false);

    const result = await callJson(trashPath, { paths: ["volume/onvol.txt"] });
    const entries = result["entries"] as Array<Record<string, unknown>>;
    expect(entries[0]?.["trashDir"]).toBe(join(volume, ".Trash-1000"));
    expect(readdirSync(join(volume, ".Trash"))).toEqual([]);
  });

  test("a $topdir/.Trash that is a symlink is not trusted", async () => {
    linuxHost();
    const volume = join(workspace, "volume");
    mkdirSync(volume, { recursive: true });
    mkdirSync(join(workspace, "attacker"), { recursive: true });
    symlinkSync(join(workspace, "attacker"), join(volume, ".Trash"));
    writeFileSync(join(volume, "onvol.txt"), "x\n");
    pretendSeparateFilesystem(volume, true);

    const result = await callJson(trashPath, { paths: ["volume/onvol.txt"] });
    const entries = result["entries"] as Array<Record<string, unknown>>;
    expect(entries[0]?.["trashDir"]).toBe(join(volume, ".Trash-1000"));
    // Nothing was written through the link.
    expect(readdirSync(join(workspace, "attacker"))).toEqual([]);
  });

  test("a volume whose trash cannot be created refuses, and the file stays", async () => {
    linuxHost();
    const volume = join(workspace, "volume");
    mkdirSync(volume, { recursive: true });
    writeFileSync(join(volume, "onvol.txt"), "precious\n");
    pretendSeparateFilesystem(volume);
    // Read-only volume: `mkdir` fails, and the only correct answer is to
    // leave the file where it is.
    chmodSync(volume, 0o500);
    try {
      const result = await callJson(trashPath, { paths: ["volume/onvol.txt"] });
      const entries = result["entries"] as Array<Record<string, unknown>>;
      expect(result["trashed"]).toBe(0);
      expect(entries[0]?.["status"]).toBe("refused");
      expect(readFileSync(join(volume, "onvol.txt"), "utf8")).toBe("precious\n");
    } finally {
      chmodSync(volume, 0o700);
    }
  });

  test("an EXDEV from the move leaves the file AND removes the claimed record", async () => {
    const trash = linuxHost();
    writeFileSync(join(workspace, "precious.txt"), "precious\n");
    // The rename is the last thing that can discover a device boundary the
    // probes missed. A copy-and-unlink fallback here is exactly what this
    // package refuses to do, so the test asserts the file survives.
    _setRenamer(() => {
      const error = new Error("EXDEV: cross-device link not permitted");
      (error as NodeJS.ErrnoException).code = "EXDEV";
      throw error;
    });
    try {
      const result = await callJson(trashPath, { paths: ["precious.txt"] });
      const entries = result["entries"] as Array<Record<string, unknown>>;
      expect(result["trashed"]).toBe(0);
      expect(String(entries[0]?.["reason"])).toContain("different filesystem");
      expect(String(entries[0]?.["reason"])).toContain("nothing was deleted");
      expect(readFileSync(join(workspace, "precious.txt"), "utf8")).toBe("precious\n");
      // And no orphan record pointing at a file that is not in the trash.
      expect(readdirSync(join(trash, "info"))).toEqual([]);
      // A refused entry must not report a destination: the planned path
      // exists, but nothing was written to it.
      expect(entries[0]?.["trashedTo"]).toBeUndefined();
      expect(entries[0]?.["record"]).toBeUndefined();
    } finally {
      _setRenamer(undefined);
    }
  });

  test("a mount point cannot be trashed", async () => {
    linuxHost();
    const volume = join(workspace, "volume");
    mkdirSync(volume, { recursive: true });
    pretendSeparateFilesystem(volume);
    const result = await callJson(trashPath, { paths: ["volume"] });
    const entries = result["entries"] as Array<Record<string, unknown>>;
    expect(String(entries[0]?.["reason"])).toContain("mount point");
  });
});

describe("TrashPath: it cannot delete by accident", () => {
  test("the only unlink in the package refuses anything but its own record", () => {
    const trashDir = join(workspace, "Trash");
    mkdirSync(join(trashDir, "info"), { recursive: true });
    writeFileSync(join(workspace, "victim.txt"), "x");
    writeFileSync(join(trashDir, "info/a.txt.trashinfo"), "x");

    // Not inside the info directory.
    expect(removeClaimedInfoFile(join(workspace, "victim.txt"), trashDir)).toBe(false);
    // Not inside it, but WEARING THE SUFFIX. This is the case the directory
    // check exists for, and the only one that isolates it: every other path
    // here is already refused by the suffix check, so deleting the directory
    // check left this test green while the package's single unlink would
    // happily remove a caller's file from anywhere on the filesystem.
    writeFileSync(join(workspace, "keepme.trashinfo"), "x");
    expect(removeClaimedInfoFile(join(workspace, "keepme.trashinfo"), trashDir)).toBe(false);
    expect(existsSync(join(workspace, "keepme.trashinfo"))).toBe(true);
    // A sibling directory whose name merely starts with the info directory's.
    mkdirSync(join(trashDir, "info-not-really"), { recursive: true });
    writeFileSync(join(trashDir, "info-not-really/b.trashinfo"), "x");
    expect(removeClaimedInfoFile(join(trashDir, "info-not-really/b.trashinfo"), trashDir)).toBe(
      false,
    );
    expect(existsSync(join(trashDir, "info-not-really/b.trashinfo"))).toBe(true);
    // Inside it, but not a record.
    expect(removeClaimedInfoFile(join(trashDir, "info/not-a-record"), trashDir)).toBe(false);
    // A bare ".trashinfo" names the suffix and nothing else.
    expect(removeClaimedInfoFile(join(trashDir, "info/.trashinfo"), trashDir)).toBe(false);
    expect(existsSync(join(workspace, "victim.txt"))).toBe(true);

    // Its own record, which is the one case it exists for.
    expect(removeClaimedInfoFile(join(trashDir, "info/a.txt.trashinfo"), trashDir)).toBe(true);
  });

  test("no source file in this package deletes anything else", () => {
    // A source scan, because the guarantee is about the whole package and not
    // about one function: a future edit that reaches for `rmSync` in the trash
    // path fails here rather than in somebody's home directory.
    const offenders: string[] = [];
    for (const file of sourceFiles(join(import.meta.dir))) {
      if (file.endsWith(".test.ts")) continue;
      const text = readFileSync(file, "utf8");
      for (const call of ["rmSync", "rmdirSync", "unlinkSync", "rm -rf", "rimraf"]) {
        if (!text.includes(call)) continue;
        // The one sanctioned exception, fenced by its own assertions.
        if (call === "unlinkSync" && file.endsWith("trash-engine.ts")) continue;
        offenders.push(`${file}: ${call}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the sanctioned unlink appears exactly once", () => {
    const text = readFileSync(join(import.meta.dir, "lib/trash-engine.ts"), "utf8");
    const occurrences = text.split("unlinkSync(").length - 1;
    // Import plus one call site. More than that means a second deletion was
    // added somewhere the guard does not cover.
    expect(occurrences).toBe(1);
  });
});

// ===========================================================================
// OsIndexSearch
// ===========================================================================

describe("OsIndexSearch: macOS", () => {
  beforeEach(() => {
    _setPlatform("darwin");
  });

  test("matches come back scoped to the workspace", async () => {
    mkdirSync(join(workspace, "src"), { recursive: true });
    serve({
      mdfind: ok(
        [join(workspace, "src/a.ts"), join(workspace, "src/b.ts"), "/etc/passwd"].join("\0"),
      ),
    });
    const result = await callJson(osIndexSearch, { query: "a" });
    expect(result["outcome"]).toBe("matches");
    expect(result["matches"]).toEqual([join(workspace, "src/a.ts"), join(workspace, "src/b.ts")]);
    // The index knows about the whole machine; this tool answers about the
    // workspace, and says how much it dropped.
    expect(result["outOfScope"]).toBe(1);
  });

  test("the caller's text never becomes an argv element of its own", async () => {
    serve({ mdfind: ok(""), mdutil: ok(MDUTIL_ENABLED_STDOUT) });
    await call(osIndexSearch, { query: "-count" });
    const argv = commands[0]?.argv as string[];
    expect(argv[0]).toBe("mdfind");
    expect(argv).not.toContain("-count");
    expect(argv.at(-1)).toBe('kMDItemFSName == "*-count*"c');
    // And nothing anywhere resembles a shell.
    expect(argv.some((part) => part === "-c" || part === "sh" || part.includes("&&"))).toBe(false);
  });

  test("each search root becomes its own -onlyin", async () => {
    mkdirSync(join(workspace, "a"), { recursive: true });
    mkdirSync(join(workspace, "b"), { recursive: true });
    serve({ mdfind: ok(""), mdutil: ok(MDUTIL_ENABLED_STDOUT) });
    await call(osIndexSearch, { query: "x", roots: ["a", "b"] });
    const argv = commands[0]?.argv as string[];
    expect(argv.filter((part) => part === "-onlyin").length).toBe(2);
  });

  test("a content query searches content", async () => {
    serve({ mdfind: ok(MDFIND_APPS_STDOUT) });
    await call(osIndexSearch, { query: "invoice", mode: "content", roots: ["."] });
    expect((commands[0]?.argv as string[]).at(-1)).toBe('kMDItemTextContent == "*invoice*"cd');
  });

  test("nothing found on an indexed volume is 'noMatches', with the caveat", async () => {
    serve({ mdfind: ok(""), mdutil: ok(MDUTIL_ENABLED_STDOUT) });
    const result = await callJson(osIndexSearch, { query: "nothing" });
    expect(result["outcome"]).toBe("noMatches");
    expect((result["index"] as Record<string, unknown>)["state"]).toBe("enabled");
    // Measured on a real machine: an indexed volume can still hold a directory
    // Spotlight was told to skip.
    expect(String(result["caveat"])).toContain("excluded from Spotlight");
  });

  test("nothing found on a DISABLED index is a different outcome entirely", async () => {
    serve({ mdfind: ok(""), mdutil: ok(MDUTIL_DISABLED_STDOUT_UNVERIFIED) });
    const result = await callJson(osIndexSearch, { query: "nothing" });
    expect(result["outcome"]).toBe("indexUnavailable");
  });

  test("an unknown index state is not reported as a disabled one", async () => {
    serve({ mdfind: ok(""), mdutil: ok(MDUTIL_UNKNOWN_STDOUT) });
    const result = await callJson(osIndexSearch, { query: "nothing" });
    // Not `indexUnavailable`: nobody said the index is unavailable. Not a
    // plain `noMatches` either — see the adversarial-review block below,
    // which is where this outcome is pinned down.
    expect(result["outcome"]).toBe("noMatchesUnverified");
    expect((result["index"] as Record<string, unknown>)["state"]).toBe("unknown");
  });

  test("the index is not probed when there were matches", async () => {
    serve({ mdfind: ok(`${join(workspace, "a.ts")}\0`), mdutil: ok(MDUTIL_ENABLED_STDOUT) });
    await call(osIndexSearch, { query: "a" });
    expect(commands.map((command) => command.argv[0])).toEqual(["mdfind"]);
  });

  test("checkIndex probes anyway", async () => {
    serve({ mdfind: ok(`${join(workspace, "a.ts")}\0`), mdutil: ok(MDUTIL_ENABLED_STDOUT) });
    const result = await callJson(osIndexSearch, { query: "a", checkIndex: true });
    expect(commands.map((command) => command.argv[0])).toEqual(["mdfind", "mdutil"]);
    expect((result["index"] as Record<string, unknown>)["state"]).toBe("enabled");
  });

  test("a malformed query is a failure, not an empty result", async () => {
    serve({ mdfind: ok(MDFIND_BAD_QUERY_STDOUT, 1) });
    const result = await callJson(osIndexSearch, { query: "x" });
    expect(result["outcome"]).toBe("failed");
    expect(String(result["reason"])).toContain("Failed to create query");
  });

  test("a missing mdfind is an unavailable index, with a reason", async () => {
    serve({});
    const result = await callJson(osIndexSearch, { query: "x" });
    expect(result["outcome"]).toBe("indexUnavailable");
    expect(String(result["reason"])).toContain("mdfind");
  });

  test("a timeout is reported as a timeout, not as 'nothing found'", async () => {
    serve({
      mdfind: { code: -1, stdout: "", stderr: "", timedOut: true, missing: false },
    });
    const result = await callJson(osIndexSearch, { query: "x" });
    expect(result["outcome"]).toBe("failed");
    expect(String(result["reason"])).toContain("timeout");
  });

  test("the limit is applied after the scope filter, so in-scope hits survive", async () => {
    mkdirSync(join(workspace, "src"), { recursive: true });
    const noise = Array.from({ length: 30 }, (_, n) => `/elsewhere/f${n}.ts`);
    serve({ mdfind: ok([...noise, join(workspace, "src/wanted.ts")].join("\0")) });
    const result = await callJson(osIndexSearch, { query: "wanted", limit: 5 });
    expect(result["matches"]).toEqual([join(workspace, "src/wanted.ts")]);
  });

  test("an exclude glob drops matches and counts them", async () => {
    mkdirSync(join(workspace, "src"), { recursive: true });
    serve({
      mdfind: ok([join(workspace, "src/a.ts"), join(workspace, "src/a.test.ts")].join("\0")),
    });
    const result = await callJson(osIndexSearch, {
      query: "a",
      exclude: ["**/*.test.ts"],
    });
    expect(result["matches"]).toEqual([join(workspace, "src/a.ts")]);
    expect(result["excluded"]).toBe(1);
  });

  test("more matches than the limit are truncated, and say so", async () => {
    const many = Array.from({ length: 10 }, (_, n) => join(workspace, `f${n}.ts`));
    serve({ mdfind: ok(many.join("\0")) });
    const result = await callJson(osIndexSearch, { query: "f", limit: 3 });
    expect((result["matches"] as string[]).length).toBe(3);
    expect(result["truncated"]).toBe(true);
    expect(result["moreAvailable"]).toBe(10);
  });
});

describe("OsIndexSearch: Linux", () => {
  beforeEach(() => {
    _setPlatform("linux");
  });

  test("matches parse out of plocate's NUL listing", async () => {
    serve({ plocate: ok([join(workspace, "a.ts"), join(workspace, "b.ts")].join("\0")) });
    const result = await callJson(osIndexSearch, { query: "a" });
    expect(result["outcome"]).toBe("matches");
    expect(result["backend"]).toBe("plocate");
    expect((result["matches"] as string[]).length).toBe(2);
  });

  test("the pattern is passed after --, so a leading dash is a pattern", async () => {
    serve({ plocate: ok("") });
    await call(osIndexSearch, { query: "-dashfile" });
    const argv = commands[0]?.argv as string[];
    expect(argv[argv.length - 2]).toBe("--");
    expect(argv.at(-1)).toBe("-dashfile");
  });

  test("the backend is asked for more hits than the caller wants", async () => {
    serve({ plocate: ok("") });
    await call(osIndexSearch, { query: "x", limit: 10 });
    const argv = commands[0]?.argv as string[];
    // Because the answer is filtered to the roots afterwards, and plocate
    // cannot scope a search at all.
    expect(argv[argv.indexOf("--limit") + 1]).toBe("200");
  });

  test("EXIT 1 WITH NO OUTPUT is 'no matches'", async () => {
    serve({ plocate: { ...PLOCATE_NO_MATCH, timedOut: false, missing: false } });
    const result = await callJson(osIndexSearch, { query: "zzz" });
    expect(result["outcome"]).toBe("noMatches");
  });

  test("EXIT 1 WITH A DATABASE MESSAGE is 'indexUnavailable', the same exit code", async () => {
    serve({ plocate: { ...PLOCATE_NO_DATABASE, timedOut: false, missing: false } });
    const result = await callJson(osIndexSearch, { query: "zzz" });
    // The headline of this package: these two answers are indistinguishable by
    // exit code, and only one of them means the filesystem has nothing.
    expect(result["outcome"]).toBe("indexUnavailable");
    expect(String(result["reason"])).toContain("plocate.db");
  });

  test("when plocate is missing, locate is tried, and reported as the backend", async () => {
    serve({ locate: ok(`${join(workspace, "a.ts")}\0`) });
    const result = await callJson(osIndexSearch, { query: "a" });
    expect(result["backend"]).toBe("locate");
    expect(commands.map((command) => command.argv[0])).toEqual(["plocate", "locate"]);
  });

  test("with neither backend installed the answer is unavailable, with advice", async () => {
    serve({});
    const result = await callJson(osIndexSearch, { query: "a" });
    expect(result["outcome"]).toBe("indexUnavailable");
    expect(String(result["reason"])).toContain("updatedb");
  });

  test("an option this build does not know is not reported as an empty result", async () => {
    serve({
      plocate: {
        code: 1,
        stdout: "",
        stderr: "plocate: unrecognized option: limit\n",
        timedOut: false,
        missing: false,
      },
    });
    const result = await callJson(osIndexSearch, { query: "a" });
    expect(result["outcome"]).toBe("indexUnavailable");
    expect(String(result["reason"])).toContain("unrecognized option");
  });

  test("a content search is refused, because the database holds names only", async () => {
    serve({ plocate: ok("") });
    const result = await callJson(osIndexSearch, { query: "a", mode: "content" });
    expect(result["outcome"]).toBe("unsupported");
    expect(String(result["reason"])).toContain("NAMES only");
    expect(commands.length).toBe(0);
  });

  test("the index's age is reported from the database file", async () => {
    _setClock(() => FIXED_NOW);
    const dbPath = join(workspace, "plocate.db");
    writeFileSync(dbPath, "x");
    // The real database lives at an absolute path; the probe seam is how a
    // test on macOS gets to answer for it.
    _setPathProbe((path) =>
      path === "/var/lib/plocate/plocate.db"
        ? { ...(facts(dbPath, 1) as PathFacts), mtimeMs: FIXED_NOW - 3_600_000 }
        : facts(path, 1),
    );
    serve({ plocate: ok(`${join(workspace, "a.ts")}\0`) });
    const result = await callJson(osIndexSearch, { query: "a" });
    const index = result["index"] as Record<string, unknown>;
    expect(index["ageSeconds"]).toBe(3_600);
    expect(index["stale"]).toBe(false);
  });

  test("a stale index turns an empty answer into a warning", async () => {
    _setClock(() => FIXED_NOW);
    const dbPath = join(workspace, "plocate.db");
    writeFileSync(dbPath, "x");
    _setPathProbe((path) =>
      path === "/var/lib/plocate/plocate.db"
        ? { ...(facts(dbPath, 1) as PathFacts), mtimeMs: FIXED_NOW - 30 * 86_400_000 }
        : facts(path, 1),
    );
    serve({ plocate: { ...PLOCATE_NO_MATCH, timedOut: false, missing: false } });
    const result = await callJson(osIndexSearch, { query: "a" });
    expect(result["outcome"]).toBe("noMatches");
    expect((result["index"] as Record<string, unknown>)["stale"]).toBe(true);
    expect(String(result["caveat"])).toContain("not in it");
  });

  test("a database that is not there at all is reported as missing", async () => {
    _setPathProbe((path) => (path.startsWith("/var/lib/") ? undefined : facts(path, 1)));
    serve({ plocate: ok(`${join(workspace, "a.ts")}\0`) });
    const result = await callJson(osIndexSearch, { query: "a" });
    expect((result["index"] as Record<string, unknown>)["state"]).toBe("missing");
  });
});

describe("OsIndexSearch: input and other platforms", () => {
  test("Windows is unsupported, and says what it would take", async () => {
    _setPlatform("win32");
    const result = await callJson(osIndexSearch, { query: "a" });
    expect(result["outcome"]).toBe("unsupported");
    expect(String(result["reason"])).toContain("Windows Search");
  });

  test("a root outside the workspace is refused", async () => {
    _setPlatform("linux");
    const result = await call(osIndexSearch, { query: "a", roots: ["../elsewhere"] });
    expect(result).toContain("outside the workspace root");
  });

  test("a root that does not exist is refused rather than silently empty", async () => {
    _setPlatform("darwin");
    serve({ mdfind: ok("") });
    // Recorded: `mdfind -onlyin /no/such/dir` exits 0 with no output, which
    // would otherwise read as a confident "nothing found".
    const result = await call(osIndexSearch, { query: "a", roots: ["missing"] });
    expect(result).toContain("is not a directory that exists");
    expect(commands.length).toBe(0);
  });

  test("a file used as a search root is refused", async () => {
    _setPlatform("darwin");
    writeFileSync(join(workspace, "a.txt"), "x");
    const result = await call(osIndexSearch, { query: "a", roots: ["a.txt"] });
    expect(result).toContain("is not a directory that exists");
  });

  test("a control character in the query is refused before any command runs", async () => {
    _setPlatform("darwin");
    serve({ mdfind: ok("") });
    const result = await call(osIndexSearch, { query: "a b" });
    expect(result).toContain("control character");
    expect(commands.length).toBe(0);
  });

  test("an empty query is refused by the schema", () => {
    expect(() => osIndexSearch.inputSchema.parse({ query: "" })).toThrow();
  });

  test("a limit beyond the ceiling is refused by the schema", () => {
    expect(() => osIndexSearch.inputSchema.parse({ query: "a", limit: 100_000 })).toThrow();
  });
});

// ===========================================================================
// the package's contract
// ===========================================================================

describe("the tool contracts", () => {
  test("the destructive tool is the only one declaring itself destructive", () => {
    expect(trashPath.destructive).toBe(true);
    expect(watchPath.destructive).toBe(false);
    expect(osIndexSearch.destructive).toBe(false);
  });

  test("the tool that spawns a program declares the process capability", () => {
    // The `compile --strict` audit requires scope "external" of anything that
    // crosses a process boundary.
    expect(osIndexSearch.ioCapability).toBe("process");
    expect(osIndexSearch.scope).toBe("external");
  });

  test("the reading tools are read-only and concurrency-safe", () => {
    expect(watchPath.readOnly).toBe(true);
    expect(osIndexSearch.readOnly).toBe(true);
    expect(trashPath.readOnly).toBe(false);
  });

  test("every tool name is unique within the package", () => {
    const names = HOSTFS_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("OsIndexSearch is named apart from tool-state's IndexSearch", () => {
    // Two tools with one name make the catalog throw at registration, for
    // every harness, at boot.
    expect(HOSTFS_TOOLS.map((tool) => tool.name)).not.toContain("IndexSearch");
    expect(osIndexSearch.name).toBe("OsIndexSearch");
  });

  test("each description says which platforms it serves", () => {
    expect(trashPath.description).toContain("LINUX ONLY");
    expect(osIndexSearch.description).toContain("macOS");
  });

  test("no schema uses zod's .default(), which does not compile in this repo", () => {
    for (const tool of HOSTFS_TOOLS) {
      const shape = (tool.inputSchema as unknown as { shape: Record<string, unknown> }).shape;
      for (const [field, schema] of Object.entries(shape)) {
        const typeName = (schema as { _def: { typeName: string } })._def.typeName;
        expect(`${tool.name}.${field}: ${typeName}`).not.toContain("ZodDefault");
      }
    }
  });
});

// ===========================================================================
// adversarial review: the cases where an answer was more confident than the
// evidence behind it
// ===========================================================================

describe("TrashPath: the dry run predicts the destination the real call uses", () => {
  test("two files with the SAME name in one call get two different destinations", async () => {
    // The preview is the only thing a caller sees before an irreversible
    // move, and it used to promise both of these `files/notes.txt` — because
    // the prediction asked the filesystem, which held neither of them yet.
    // The real call claims names one at a time with O_EXCL, so the second
    // file actually lands at `files/notes.2.txt`.
    const trash = linuxHost();
    mkdirSync(join(workspace, "a"), { recursive: true });
    mkdirSync(join(workspace, "b"), { recursive: true });
    writeFileSync(join(workspace, "a/notes.txt"), "1");
    writeFileSync(join(workspace, "b/notes.txt"), "2");

    const preview = await callJson(trashPath, {
      paths: ["a/notes.txt", "b/notes.txt"],
      dryRun: true,
    });
    const planned = preview["entries"] as Array<Record<string, unknown>>;
    expect(planned[0]?.["wouldStoreAs"]).toBe("notes.txt");
    expect(planned[1]?.["wouldStoreAs"]).toBe("notes.2.txt");
    expect(planned[0]?.["wouldTrashTo"]).not.toBe(planned[1]?.["wouldTrashTo"]);

    // And the real call agrees, entry for entry.
    const real = await callJson(trashPath, { paths: ["a/notes.txt", "b/notes.txt"] });
    const moved = real["entries"] as Array<Record<string, unknown>>;
    expect(moved.map((entry) => entry["storedAs"])).toEqual(
      planned.map((entry) => entry["wouldStoreAs"]),
    );
    expect(moved.map((entry) => entry["trashedTo"])).toEqual(
      planned.map((entry) => entry["wouldTrashTo"]),
    );
    expect(existsSync(join(trash, "files/notes.txt"))).toBe(true);
    expect(existsSync(join(trash, "files/notes.2.txt"))).toBe(true);
  });

  test("a third file with that name is predicted as the third name", async () => {
    linuxHost();
    for (const dir of ["a", "b", "c"]) {
      mkdirSync(join(workspace, dir), { recursive: true });
      writeFileSync(join(workspace, dir, "notes.txt"), dir);
    }
    const preview = await callJson(trashPath, {
      paths: ["a/notes.txt", "b/notes.txt", "c/notes.txt"],
      dryRun: true,
    });
    expect(
      (preview["entries"] as Array<Record<string, unknown>>).map((entry) => entry["wouldStoreAs"]),
    ).toEqual(["notes.txt", "notes.2.txt", "notes.3.txt"]);
  });
});

describe("OsIndexSearch: an answer cut off by the output cap is not a listing", () => {
  test("mdfind: the half path left by the cap is not reported as a match", async () => {
    // A `-0` listing is NUL-SEPARATED. Cut it at the capture ceiling and the
    // last element is whatever fitted of a path — which is inside the root,
    // so it survives the scope filter and is handed back as a file that
    // exists. It does not.
    _setPlatform("darwin");
    mkdirSync(join(workspace, "src"), { recursive: true });
    const real = join(workspace, "src/real.ts");
    const half = join(workspace, "src/half-a-pa");
    serve({ mdfind: { ...ok(`${real}\0${half}`), stdoutTruncated: true } });
    const result = await callJson(osIndexSearch, { query: "a" });
    expect(result["matches"]).toEqual([real]);
    expect(result["partialDropped"]).toBe(1);
    expect(result["backendOutputTruncated"]).toBe(true);
    expect(String(result["caveat"])).toContain("incomplete");
  });

  test("plocate: the same cut listing is reported as cut, not as complete", async () => {
    _setPlatform("linux");
    const real = join(workspace, "real.ts");
    serve({
      plocate: { ...ok(`${real}\0${join(workspace, "half-a-pa")}`), stdoutTruncated: true },
    });
    const result = await callJson(osIndexSearch, { query: "a" });
    expect(result["matches"]).toEqual([real]);
    expect(result["backendOutputTruncated"]).toBe(true);
    expect(result["partialDropped"]).toBe(1);
  });

  test("a cut listing with nothing left in scope is not reported as 'noMatches'", async () => {
    _setPlatform("linux");
    serve({ plocate: { ...ok("/elsewhere/only-hit-was-cu"), stdoutTruncated: true } });
    const result = await callJson(osIndexSearch, { query: "a" });
    // "nothing found" would be a claim about the filesystem. The truth is
    // that the listing ran out of room before this tool saw all of it.
    expect(result["outcome"]).toBe("noMatchesUnverified");
  });
});

describe("OsIndexSearch: an index state that could not be read is not a miss", () => {
  test("mdutil could not say, so an empty answer says it could not say", async () => {
    // `mdutil -s` answers "Error: unknown indexing state" for anything it
    // cannot report on, and `mdfind` prints nothing and exits 0 for a miss,
    // an unindexed volume AND a directory Spotlight was told to skip. With
    // the index state unknown, all three are still on the table.
    _setPlatform("darwin");
    serve({ mdfind: ok(""), mdutil: ok(MDUTIL_UNKNOWN_STDOUT) });
    const result = await callJson(osIndexSearch, { query: "nothing" });
    expect(result["outcome"]).toBe("noMatchesUnverified");
    expect((result["index"] as Record<string, unknown>)["state"]).toBe("unknown");
    expect(String(result["caveat"])).toContain("not evidence");
  });

  test("a missing mdutil is the same unverified answer, not a confident miss", async () => {
    _setPlatform("darwin");
    // mdfind answers; mdutil is not installed, so the probe cannot report.
    serve({ mdfind: ok("") });
    const result = await callJson(osIndexSearch, { query: "nothing" });
    expect(result["outcome"]).toBe("noMatchesUnverified");
    expect((result["index"] as Record<string, unknown>)["state"]).toBe("unknown");
  });

  test("an index confirmed enabled still gives a plain, confident noMatches", async () => {
    _setPlatform("darwin");
    serve({ mdfind: ok(""), mdutil: ok(MDUTIL_ENABLED_STDOUT) });
    expect((await callJson(osIndexSearch, { query: "nothing" }))["outcome"]).toBe("noMatches");
  });
});

describe("WatchPath: a re-read that could not happen says so", () => {
  test("a directory removed before it can be re-read leaves a note, not silence", async () => {
    // The re-read is how a save is seen at all on the runtime this package is
    // compiled for — Bun on macOS reports the temp file and nothing for the
    // rename onto the target. When it cannot be done, "no events" would tell
    // a caller their file was not saved.
    mkdirSync(join(workspace, "sub"), { recursive: true });
    writeFileSync(join(workspace, "sub/doc.md"), "one");
    scriptedWatcher((emit) => {
      // The temp-file signature: a path never known, already gone. It asks
      // for a re-read of `sub/` — which has just been removed.
      rmSync(join(workspace, "sub"), { recursive: true });
      emit("rename", "sub/doc.md.tmpABC");
    });
    const result = await callJson(watchPath, {
      path: ".",
      timeoutMs: 400,
      settleMs: 20,
      recursive: true,
    });
    expect(result["stoppedBy"]).toBe("deadline");
    expect((result["notes"] as string[]).join(" ")).toContain("re-read(s) were skipped");
  }, 15_000);
});

describe("WatchPath: an unattributed notification is not a creation", () => {
  test("a null filename reports the watched directory as MODIFIED, not created", async () => {
    // Some platforms say only "something happened here". The watched
    // directory demonstrably existed — this tool stat'd it before attaching —
    // so reporting it as `created` is a claim the evidence contradicts, and
    // it made a `kinds: ["modified"]` filter drop the only signal the
    // platform gave.
    scriptedWatcher((emit) => {
      emit("rename", null);
    });
    const result = await callJson(watchPath, {
      path: ".",
      timeoutMs: 5_000,
      maxEvents: 1,
      settleMs: 20,
      kinds: ["modified"],
    });
    const events = result["events"] as Array<Record<string, unknown>>;
    expect(result["stoppedBy"]).toBe("eventCap");
    expect(events[0]?.["path"]).toBe(".");
    expect(events[0]?.["kind"]).toBe("modified");
  }, 20_000);

  test("the same notification for a directory that has gone reports a deletion", async () => {
    // And it is not swallowed: classed against an empty known-set this was a
    // path never seen to exist and now absent, which is the temp-file
    // signature — dropped by default, so the watched tree disappearing was
    // reported as nothing at all.
    mkdirSync(join(workspace, "doomed"), { recursive: true });
    scriptedWatcher((emit) => {
      rmSync(join(workspace, "doomed"), { recursive: true });
      emit("rename", null);
    });
    const result = await callJson(watchPath, {
      path: "doomed",
      timeoutMs: 5_000,
      maxEvents: 1,
      settleMs: 20,
    });
    const events = result["events"] as Array<Record<string, unknown>>;
    expect(result["eventCount"]).toBe(1);
    expect(events[0]?.["kind"]).toBe("deleted");
    expect(events[0]?.["transient"]).toBeUndefined();
  }, 20_000);
});

/** The local-time stamp the fixed clock renders to, on whatever host runs this. */
function localStamp(): string {
  const local = new Date(FIXED_NOW - new Date(FIXED_NOW).getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 19);
}

/** Every `.ts` file in the package's source tree. */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}
