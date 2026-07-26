/**
 * NEW-HUNT-4 — the tool record/replay cassette: canonical args hashing, the
 * JSONL format, the replayer's key semantics, and the two
 * `RegisteredTool.execute` wrappers.
 *
 * No module mocks: the wrappers are pure functions over a tool array, so the
 * tests hand them a counting stub tool and assert whether it was executed.
 * Every file this touches lives in a per-test `mkdtemp` directory.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRunFailedError } from "@crewhaus/errors";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import {
  TOOL_RECORDING_FILENAME,
  TOOL_REPLAY_MISS_MARKER,
  ToolRecorder,
  ToolReplayer,
  canonicalJson,
  formatReusedRecordingWarning,
  hashToolArgs,
  loadToolRecording,
  recordingTools,
  replayingTools,
  toolRecordKey,
} from "./tool-record";

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-tool-record-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

/** A counting stub tool: records every execution, answers deterministically. */
function stubTool(opts: { name?: string; throws?: string } = {}): {
  tool: RegisteredTool;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const tool: RegisteredTool = {
    name: opts.name ?? "Echo",
    description: "echo",
    inputSchema: z.unknown(),
    concurrencySafe: true,
    readOnly: true,
    destructive: false,
    requiresSandbox: false,
    classifyOutput: true,
    scope: "internal",
    requireJustification: false,
    execute: async (input: unknown) => {
      calls.push(input);
      if (opts.throws !== undefined) throw new Error(opts.throws);
      return `live:${JSON.stringify(input)}`;
    },
  };
  return { tool, calls };
}

describe("canonical args hashing", () => {
  test("key order does not change the encoding or the hash", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(hashToolArgs({ path: "x", mode: "r" })).toBe(hashToolArgs({ mode: "r", path: "x" }));
  });

  test("nested objects sort recursively; arrays keep their order", () => {
    expect(canonicalJson({ o: { z: 1, a: 2 } })).toBe('{"o":{"a":2,"z":1}}');
    expect(canonicalJson([2, 1])).toBe("[2,1]");
    expect(hashToolArgs([1, 2])).not.toBe(hashToolArgs([2, 1]));
  });

  test("a present-but-undefined KEY hashes the same as an absent one", () => {
    // The contract the module docstring states, and the one a round-trip
    // needs: JSON.stringify drops an undefined-valued key on write, so a hash
    // recomputed from a recording's `args` must match the live call's.
    expect(canonicalJson({ a: undefined })).toBe("{}");
    expect(hashToolArgs({ a: undefined })).toBe(hashToolArgs({}));
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(hashToolArgs({ path: "x", extra: undefined })).toBe(hashToolArgs({ path: "x" }));
    // An explicit null is a VALUE, not an absent key — those still differ.
    expect(hashToolArgs({ a: null })).not.toBe(hashToolArgs({}));
  });

  test("inside an array undefined stays a positional null (no index shift)", () => {
    expect(canonicalJson([1, undefined, 2])).toBe("[1,null,2]");
    expect(canonicalJson(undefined)).toBe("null");
  });

  test("different values hash differently, always 64 hex chars", () => {
    expect(hashToolArgs({ path: "a" })).not.toBe(hashToolArgs({ path: "b" }));
    expect(hashToolArgs({ path: "a" })).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the key is NUL-joined so ids cannot forge one another", () => {
    expect(toolRecordKey("a", "b", "c")).toBe("a\u0000b\u0000c");
    // A separator a sample id or tool name CAN contain (a space, a colon)
    // would let one triple spell another key; NUL can appear in neither.
    expect(toolRecordKey("a:b", "c", "d")).not.toBe(toolRecordKey("a", "b:c", "d"));
  });
});

describe("ToolRecorder / loadToolRecording", () => {
  test("appends one JSON line per call and hashes the file bytes", () => {
    const dir = newTempRoot();
    const recorder = new ToolRecorder({ dir, now: () => new Date("2026-07-26T00:00:00.000Z") });
    recorder.record({
      sampleId: "s1",
      toolName: "Echo",
      argsHash: "h1",
      args: { a: 1 },
      result: "r1",
    });
    recorder.record({
      sampleId: "s1",
      toolName: "Echo",
      argsHash: "h2",
      args: { a: 2 },
      error: "boom",
    });

    const path = join(dir, TOOL_RECORDING_FILENAME);
    const text = readFileSync(path, "utf-8");
    expect(text.trimEnd().split("\n")).toHaveLength(2);

    const loaded = loadToolRecording(dir);
    expect(loaded.records).toHaveLength(2);
    expect(loaded.records[0]).toEqual({
      sampleId: "s1",
      toolName: "Echo",
      argsHash: "h1",
      args: { a: 1 },
      result: "r1",
      ts: "2026-07-26T00:00:00.000Z",
    });
    expect(loaded.records[1]?.error).toBe("boom");
    expect(loaded.hash).toBe(createHash("sha256").update(text).digest("hex"));
    expect(loaded.path).toBe(path);
  });

  test("a directory with no recording is a loud refusal, not an all-miss replay", () => {
    const dir = newTempRoot();
    expect(() => loadToolRecording(dir)).toThrow(/tool recording not found/);
  });

  test("torn or shapeless lines are skipped, the rest still load", () => {
    const dir = newTempRoot();
    writeFileSync(
      join(dir, TOOL_RECORDING_FILENAME),
      [
        JSON.stringify({ sampleId: "s1", toolName: "Echo", argsHash: "h1", result: "ok" }),
        '{"sampleId":"s2","toolNam', // torn append
        JSON.stringify({ nonsense: true }),
        "",
      ].join("\n"),
    );
    const loaded = loadToolRecording(dir);
    expect(loaded.records.map((r) => r.argsHash)).toEqual(["h1"]);
  });

  test("the append seam keeps a recorder off the filesystem entirely", () => {
    const lines: Array<{ path: string; line: string }> = [];
    const recorder = new ToolRecorder({
      dir: "/nonexistent/never-created",
      append: (path, line) => lines.push({ path, line }),
    });
    recorder.record({ sampleId: "s", toolName: "T", argsHash: "h", args: {}, result: "x" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]?.line ?? "{}")).toMatchObject({ sampleId: "s", toolName: "T" });
  });
});

describe("ToolReplayer key semantics", () => {
  const recording = {
    dir: "/rec",
    path: "/rec/tools.jsonl",
    hash: "deadbeef",
    records: [
      { sampleId: "s1", toolName: "Echo", argsHash: "h", args: {}, result: "first", ts: "t1" },
      { sampleId: "s1", toolName: "Echo", argsHash: "h", args: {}, result: "second", ts: "t2" },
    ],
  };

  test("repeated identical calls consume the recorded entries in order", () => {
    const replayer = new ToolReplayer(recording);
    expect(replayer.take("s1", "Echo", "h")?.result).toBe("first");
    expect(replayer.take("s1", "Echo", "h")?.result).toBe("second");
  });

  test("an exhausted key keeps replaying its last entry — and COUNTS the reuse", () => {
    const replayer = new ToolReplayer(recording);
    replayer.take("s1", "Echo", "h");
    replayer.take("s1", "Echo", "h");
    // Both recorded entries consumed: nothing was reused yet.
    expect(replayer.reusedEntries).toEqual([]);

    expect(replayer.take("s1", "Echo", "h")?.result).toBe("second");
    expect(replayer.take("s1", "Echo", "h")?.result).toBe("second");
    // The replayed trajectory called the tool twice more than the recording
    // did — a divergence that must never be silent.
    expect(replayer.reusedEntries).toEqual([
      { sampleId: "s1", toolName: "Echo", argsHash: "h" },
      { sampleId: "s1", toolName: "Echo", argsHash: "h" },
    ]);
  });

  test("a MISS is not counted as a reuse (it has its own loud path)", () => {
    const replayer = new ToolReplayer(recording);
    expect(replayer.take("s2", "Echo", "h")).toBeUndefined();
    expect(replayer.reusedEntries).toEqual([]);
  });

  test("formatReusedRecordingWarning is silent on a clean replay, loud otherwise", () => {
    expect(formatReusedRecordingWarning([], "/rec/tools.jsonl")).toBeUndefined();
    const msg = formatReusedRecordingWarning(
      [{ sampleId: "s1", toolName: "Echo", argsHash: "abcdef0123456789" }],
      "/rec/tools.jsonl",
    );
    expect(msg).toContain("[eval] warning:");
    expect(msg).toContain("1 tool call(s) replayed a REUSED recording entry");
    expect(msg).toContain("s1/Echo@abcdef012345");
    expect(msg).toContain("/rec/tools.jsonl");
  });

  test("another sample's identical call is a MISS — the key carries sampleId", () => {
    const replayer = new ToolReplayer(recording);
    expect(replayer.take("s2", "Echo", "h")).toBeUndefined();
    expect(replayer.take("s1", "Other", "h")).toBeUndefined();
    expect(replayer.take("s1", "Echo", "nope")).toBeUndefined();
  });
});

describe("recordingTools", () => {
  test("delegates to the real tool, returns its value, and records the call", async () => {
    const dir = newTempRoot();
    const recorder = new ToolRecorder({ dir });
    const { tool, calls } = stubTool();
    const [wrapped] = recordingTools([tool], "s1", recorder);

    const out = await wrapped?.execute({ path: "x" });
    expect(out).toBe('live:{"path":"x"}');
    expect(calls).toHaveLength(1);

    const loaded = loadToolRecording(dir);
    expect(loaded.records).toHaveLength(1);
    expect(loaded.records[0]).toMatchObject({
      sampleId: "s1",
      toolName: "Echo",
      argsHash: hashToolArgs({ path: "x" }),
      args: { path: "x" },
      result: 'live:{"path":"x"}',
    });
  });

  test("records a THROW and re-raises it verbatim", async () => {
    const dir = newTempRoot();
    const recorder = new ToolRecorder({ dir });
    const { tool } = stubTool({ throws: "tool exploded" });
    const [wrapped] = recordingTools([tool], "s1", recorder);

    await expect(wrapped?.execute({ a: 1 })).rejects.toThrow("tool exploded");
    const loaded = loadToolRecording(dir);
    expect(loaded.records[0]?.error).toBe("tool exploded");
    expect(loaded.records[0]?.result).toBeUndefined();
  });

  test("every other RegisteredTool field survives the wrap", () => {
    const recorder = new ToolRecorder({ dir: "/x", append: () => {} });
    const { tool } = stubTool();
    const [wrapped] = recordingTools([tool], "s1", recorder);
    expect(wrapped?.name).toBe(tool.name);
    expect(wrapped?.readOnly).toBe(true);
    expect(wrapped?.scope).toBe("internal");
    expect(wrapped?.inputSchema).toBe(tool.inputSchema);
  });
});

describe("replayingTools", () => {
  const recorded = (result: string) => ({
    dir: "/rec",
    path: "/rec/tools.jsonl",
    hash: "h",
    records: [
      {
        sampleId: "s1",
        toolName: "Echo",
        argsHash: hashToolArgs({ path: "x" }),
        args: { path: "x" },
        result,
        ts: "t",
      },
    ],
  });

  test("a HIT returns the recorded result and never executes the tool", async () => {
    const { tool, calls } = stubTool();
    const [wrapped] = replayingTools(
      [tool],
      "s1",
      new ToolReplayer(recorded("from-the-cassette")),
      "error",
    );
    expect(await wrapped?.execute({ path: "x" })).toBe("from-the-cassette");
    expect(calls).toHaveLength(0);
  });

  test("a recorded THROW replays as an error carrying the original message", async () => {
    const { tool, calls } = stubTool();
    const replayer = new ToolReplayer({
      dir: "/rec",
      path: "/rec/tools.jsonl",
      hash: "h",
      records: [
        {
          sampleId: "s1",
          toolName: "Echo",
          argsHash: hashToolArgs({ path: "x" }),
          args: { path: "x" },
          error: "recorded failure",
          ts: "t",
        },
      ],
    });
    const [wrapped] = replayingTools([tool], "s1", replayer, "error");
    await expect(wrapped?.execute({ path: "x" })).rejects.toThrow("recorded failure");
    expect(calls).toHaveLength(0);
  });

  test("a MISS under the default policy fails terminally, naming the key", async () => {
    const { tool, calls } = stubTool();
    const [wrapped] = replayingTools([tool], "s1", new ToolReplayer(recorded("r")), "error");
    let thrown: unknown;
    try {
      await wrapped?.execute({ path: "unrecorded" });
    } catch (err) {
      thrown = err;
    }
    expect(calls).toHaveLength(0);
    expect(isRunFailedError(thrown)).toBe(true);
    const msg = (thrown as Error).message;
    expect(msg).toContain(TOOL_REPLAY_MISS_MARKER);
    expect(msg).toContain('sample "s1"');
    expect(msg).toContain('tool "Echo"');
    expect(msg).toContain(hashToolArgs({ path: "unrecorded" }));
    expect(msg).toContain("/rec/tools.jsonl");
    // The remediation rides on the classified report, not the message.
    const report = (thrown as { report: { remediation?: string; class: string } }).report;
    expect(report.remediation).toContain("--replay-miss live");
    expect(report.class).toBe("config");
  });

  test("a MISS under `live` executes the real tool", async () => {
    const { tool, calls } = stubTool();
    const [wrapped] = replayingTools([tool], "s1", new ToolReplayer(recorded("r")), "live");
    expect(await wrapped?.execute({ path: "unrecorded" })).toBe('live:{"path":"unrecorded"}');
    expect(calls).toHaveLength(1);
  });
});
