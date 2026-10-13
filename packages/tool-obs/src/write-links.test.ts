/**
 * IncidentBundle and EmitTraceEvent write only inside the workspace, whatever
 * sits at the name (net attacker review; C161's defect class at this
 * package's own write sites).
 *
 * The containment check resolved symlinks, but the write itself was a plain
 * `writeFileSync` / `appendFileSync` on the resolved name. A hard link in the
 * workspace to a file outside it is a name inside and a file outside: an
 * overwrite replaced that file's content, and an append added the event to
 * it. And `writeFileSync` on a FIFO blocks the whole event loop until a
 * reader appears, which a tar-extracted fixture can arrange never happens.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as nodeFs from "node:fs";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { emitTraceEvent, incidentBundle } from "./index";

const posix = process.platform !== "win32";
const SESSION = "sess_aaaaaaaaaaaaaaaa";
const LINE = `${JSON.stringify({ ts: 1, version: 1, kind: "error", payload: { message: "boom" } })}\n`;

let tmp = "";
let outside = "";
let sessions = "";
const originalCwd = process.cwd();

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "crewhaus-obs-links-")));
  outside = realpathSync(mkdtempSync(path.join(tmpdir(), "crewhaus-obs-outside-")));
  process.chdir(tmp);
  sessions = path.join(tmp, ".crewhaus", "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(path.join(sessions, `${SESSION}.jsonl`), LINE);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

async function run(tool: RegisteredTool, input: unknown): Promise<string> {
  return String(await tool.execute(input, undefined as never));
}

/**
 * A FIFO with a reader on the other end, so that a write that DOES open it
 * completes instead of blocking the test process: the regression then shows
 * as a failed assertion, never as a hang. The reader is killed afterwards.
 */
function fifoWithReader(at: string): { stop: () => void } {
  const made = Bun.spawnSync(["mkfifo", at]);
  if (made.exitCode !== 0) throw new Error(`mkfifo failed: ${made.stderr.toString()}`);
  const reader = Bun.spawn(["perl", "-e", "alarm 20; exec @ARGV", "--", "cat", at], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return { stop: () => reader.kill() };
}

/**
 * Run `body` with the kernel naming the file at `inside` by its other name,
 * `other`, whenever a path is resolved to it: `realpath` of the name, and
 * `realpath` of `/dev/fd/<n>` for a descriptor open on it. macOS keeps one
 * name per file, the one it last looked up, so for a file with two names it
 * gives either answer; in sequential runs of the tests below the outside
 * one came back now and then (the containment check then refused the
 * bundle, and the append was refused as "changed" rather than as a hard
 * link). Linux, where CI runs, names the one the file was reached by. Here
 * that answer is the outside one every time. Restored before this returns.
 */
async function withOtherNameAnswered<T>(
  inside: string,
  other: string,
  body: () => Promise<T>,
): Promise<T> {
  const realRealpath = nodeFs.realpathSync;
  const realNative = nodeFs.realpathSync.native;
  const named = <A>(answer: A): A => (answer === inside ? (other as A) : answer);
  const resolved = spyOn(nodeFs, "realpathSync").mockImplementation(((
    p: nodeFs.PathLike,
    o?: nodeFs.EncodingOption,
  ) => named(realRealpath(p, o))) as typeof nodeFs.realpathSync);
  // tool-safety asks a descriptor through `realpathSync.native`.
  Object.assign(nodeFs.realpathSync, {
    native: (p: nodeFs.PathLike, o?: nodeFs.EncodingOption) => named(realNative(p, o)),
  });
  try {
    return await body();
  } finally {
    resolved.mockRestore();
  }
}

/** IncidentBundle overwrites `bundle.json`, the second name of a file outside. */
async function overwriteHardLinkedBundle(): Promise<void> {
  const out = JSON.parse(
    await run(incidentBundle, { sessionId: SESSION, out: "bundle.json", overwrite: true }),
  );
  expect(out.wrote).toBe("bundle.json");
  expect(readFileSync(path.join(outside, "victim.json"), "utf8")).toBe("VICTIM");
  expect(JSON.parse(readFileSync(path.join(tmp, "bundle.json"), "utf8")).counts).toBeDefined();
}

/** EmitTraceEvent appends to a session log that is the second name of a file outside. */
async function appendToHardLinkedLog(): Promise<void> {
  const out = await run(emitTraceEvent, { sessionId: "sess_hard", name: "x", tsMs: 1 });
  expect(out).toContain("hard link");
  expect(out).toContain("was not appended to");
  expect(readFileSync(path.join(outside, "victim.log"), "utf8")).toBe("VICTIM\n");
}

describe.if(posix)("IncidentBundle's write", () => {
  test("overwrite replaces a hard-linked name, and the file's other name, outside, is untouched", async () => {
    writeFileSync(path.join(outside, "victim.json"), "VICTIM");
    linkSync(path.join(outside, "victim.json"), path.join(tmp, "bundle.json"));
    await overwriteHardLinkedBundle();
  });

  test("overwrite replaces a hard-linked name when the kernel names the file by its outside name", async () => {
    writeFileSync(path.join(outside, "victim.json"), "VICTIM");
    linkSync(path.join(outside, "victim.json"), path.join(tmp, "bundle.json"));
    await withOtherNameAnswered(
      path.join(tmp, "bundle.json"),
      path.join(outside, "victim.json"),
      overwriteHardLinkedBundle,
    );
  });

  test("a FIFO at the name is refused, not opened", async () => {
    const fifo = fifoWithReader(path.join(tmp, "bundle.fifo"));
    try {
      const out = await run(incidentBundle, {
        sessionId: SESSION,
        out: "bundle.fifo",
        overwrite: true,
      });
      expect(out).toContain('"bundle.fifo"');
      expect(out).toContain("fifo");
      expect(out).toContain("nothing was written");
    } finally {
      fifo.stop();
    }
  });
});

describe.if(posix)("EmitTraceEvent's append", () => {
  test("a hard-linked session log is refused, and the file's other name, outside, is untouched", async () => {
    writeFileSync(path.join(outside, "victim.log"), "VICTIM\n");
    linkSync(path.join(outside, "victim.log"), path.join(sessions, "sess_hard.jsonl"));
    await appendToHardLinkedLog();
  });

  test("a hard-linked session log is refused as one when the kernel names the file by its outside name", async () => {
    writeFileSync(path.join(outside, "victim.log"), "VICTIM\n");
    linkSync(path.join(outside, "victim.log"), path.join(sessions, "sess_hard.jsonl"));
    await withOtherNameAnswered(
      path.join(sessions, "sess_hard.jsonl"),
      path.join(outside, "victim.log"),
      appendToHardLinkedLog,
    );
  });

  test("a FIFO named as a session log is refused, not opened", async () => {
    const fifo = fifoWithReader(path.join(sessions, "sess_fifo.jsonl"));
    try {
      const out = await run(emitTraceEvent, { sessionId: "sess_fifo", name: "x", create: true });
      expect(out).toContain("not a file");
    } finally {
      fifo.stop();
    }
  });

  test("an ordinary log is still appended to, and a missing one created with its directory", async () => {
    const appended = JSON.parse(
      await run(emitTraceEvent, { sessionId: SESSION, name: "checkpoint", tsMs: 2 }),
    );
    expect(appended.appended).toBe(true);
    expect(readFileSync(path.join(sessions, `${SESSION}.jsonl`), "utf8")).toContain(
      "custom.checkpoint",
    );
    const created = JSON.parse(
      await run(emitTraceEvent, {
        dir: "logs/new",
        sessionId: "sess_new",
        name: "x",
        tsMs: 3,
        create: true,
      }),
    );
    expect(created.appended).toBe(true);
    expect(existsSync(path.join(tmp, "logs", "new", "sess_new.jsonl"))).toBe(true);
  });
});
