/**
 * NEW-HUNT-4 — `runEval({ recordToolsDir | replayToolsDir })` end to end
 * through the DEFAULT invoker: the wired tool list really is wrapped, the
 * cassette really is written, and a replayed run really is served from it.
 *
 * No `mock.module`: the run drives a REAL wired tool (`Read`) and injects the
 * session runner through the additive `RunEvalOptions.chatLoop` seam (the
 * exam runner's `chatLoop` pattern), so nothing process-global is patched.
 * The proof that replay never touches the world is a doctored cassette: the
 * recorded result is rewritten to a sentinel, and the replayed call returns
 * the sentinel rather than the file's real bytes.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import type { IrNode, IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { type AgentInvoker, type EvalChatLoopFn, runEval } from "./index";
import {
  TOOL_RECORDING_FILENAME,
  TOOL_REPLAY_MISS_MARKER,
  type ToolRecord,
  hashToolArgs,
  loadToolRecording,
} from "./tool-record";

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-eval-cassette-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

// A spec that wires ONE real, read-only, side-effect-free tool.
const SPEC = `name: cassette-test
target: cli
agent:
  model: claude-opus-4-7
  instructions: read the file
tools: [read]
`;

const GRADERS = "graders:\n  - name: m\n    type: exact_match\n";

function narrowToAgent(ir: IrNode): IrV0 {
  if (ir.target !== "cli") throw new Error(`expected target:cli, got ${ir.target}`);
  return ir;
}

async function* yieldSamples(samples: ReadonlyArray<Sample>): AsyncIterable<Sample> {
  for (const s of samples) yield s;
}

/**
 * A chat-loop stub that calls the wired `Read` tool once with `argsFor(id)`
 * and answers with the tool's result. `package.json` exists at either cwd a
 * scoped `bun test` uses (repo root or the package dir), so the live read is
 * deterministic without writing anything.
 */
function toolCallingChatLoop(argsFor: (sampleId: string) => unknown): {
  chatLoop: EvalChatLoopFn;
  results: Array<{ sampleId: string; output: unknown }>;
} {
  const results: Array<{ sampleId: string; output: unknown }> = [];
  const chatLoop: EvalChatLoopFn = async (opts) => {
    const sampleId = String(opts.sessionName).replace(/^.*_/, "");
    const read = (opts.tools as ReadonlyArray<RegisteredTool> | undefined)?.find(
      (t) => t.name === "Read",
    );
    if (read === undefined) throw new Error("Read tool was not wired");
    const output = await read.execute(argsFor(sampleId));
    results.push({ sampleId, output });
    return typeof output === "string" ? output : JSON.stringify(output);
  };
  return { chatLoop, results };
}

const ONE_SAMPLE: Sample[] = [{ id: "s1", input: "read it" }];

function run(opts: Parameters<typeof runEval>[0]["opts"]) {
  return runEval({
    ir: narrowToAgent(lower(parseSpec(SPEC))),
    dataset: { name: "cassette", samples: yieldSamples(ONE_SAMPLE) },
    compiledGraders: parseGradersConfig(GRADERS).compiled,
    opts,
  });
}

describe("runEval — tool record/replay (NEW-HUNT-4)", () => {
  test("records every tool execution keyed by (sampleId, toolName, argsHash)", async () => {
    const outDir = newTempRoot();
    const recDir = newTempRoot();
    const { chatLoop, results } = toolCallingChatLoop(() => ({ path: "package.json" }));

    const summary = await run({ outDir, recordToolsDir: recDir, chatLoop, concurrency: 1 });

    // The tool really executed (live bytes came back).
    expect(String(results[0]?.output)).toContain('"name"');

    const recording = loadToolRecording(recDir);
    expect(recording.records).toHaveLength(1);
    const rec = recording.records[0] as ToolRecord;
    expect(rec.sampleId).toBe("s1");
    expect(rec.toolName).toBe("Read");
    expect(rec.argsHash).toBe(hashToolArgs({ path: "package.json" }));
    expect(rec.args).toEqual({ path: "package.json" });
    expect(String(rec.result)).toBe(String(results[0]?.output));

    // run.json + results.json note the recording (and nothing else changes).
    const manifest = JSON.parse(readFileSync(join(outDir, "run.json"), "utf-8")) as {
      toolRecording?: { mode: string; dir: string };
    };
    expect(manifest.toolRecording).toEqual({ mode: "record", dir: recDir });
    expect(summary.config.toolRecording).toEqual({ mode: "record", dir: recDir });
  });

  test("replays the recorded result WITHOUT executing the tool", async () => {
    const recDir = newTempRoot();
    const { chatLoop } = toolCallingChatLoop(() => ({ path: "package.json" }));
    await run({ outDir: newTempRoot(), recordToolsDir: recDir, chatLoop, concurrency: 1 });

    // Doctor the cassette: if the replay executed the tool for real, the
    // sentinel could never come back.
    const recPath = join(recDir, TOOL_RECORDING_FILENAME);
    const doctored = JSON.parse(
      readFileSync(recPath, "utf-8").trim(),
    ) as ToolRecord as ToolRecord & { result: string };
    writeFileSync(recPath, `${JSON.stringify({ ...doctored, result: "CASSETTE-SENTINEL" })}\n`);

    const outDir = newTempRoot();
    const replay = toolCallingChatLoop(() => ({ path: "package.json" }));
    const summary = await run({
      outDir,
      replayToolsDir: recDir,
      chatLoop: replay.chatLoop,
      concurrency: 1,
    });

    expect(replay.results[0]?.output).toBe("CASSETTE-SENTINEL");
    expect(summary.samples[0]?.agentOutput).toBe("CASSETTE-SENTINEL");
    expect(summary.aggregates.errorCount).toBe(0);

    // The manifest records the replay AND which cassette served it.
    const expectedHash = loadToolRecording(recDir).hash;
    expect(summary.config.toolRecording).toEqual({
      mode: "replay",
      dir: recDir,
      recordingHash: expectedHash,
      missPolicy: "error",
    });
    const manifest = JSON.parse(readFileSync(join(outDir, "run.json"), "utf-8")) as {
      toolRecording?: { recordingHash?: string };
    };
    expect(manifest.toolRecording?.recordingHash).toBe(expectedHash);
  });

  test("an unrecorded call fails the sample loudly (default miss policy) and is not retried", async () => {
    const recDir = newTempRoot();
    const rec = toolCallingChatLoop(() => ({ path: "package.json" }));
    await run({ outDir: newTempRoot(), recordToolsDir: recDir, chatLoop: rec.chatLoop });

    // Same tool, DIFFERENT args → a different key → a miss.
    const miss = toolCallingChatLoop(() => ({ path: "./package.json" }));
    const summary = await run({
      outDir: newTempRoot(),
      replayToolsDir: recDir,
      chatLoop: miss.chatLoop,
      concurrency: 1,
    });

    expect(summary.aggregates.errorCount).toBe(1);
    const err = summary.samples[0]?.error ?? "";
    expect(err).toContain(TOOL_REPLAY_MISS_MARKER);
    expect(err).toContain('sample "s1"');
    expect(err).toContain('tool "Read"');
    expect(err).toContain(hashToolArgs({ path: "./package.json" }));
    // Deterministic by construction ⇒ the one blunt noise retry is suppressed:
    // exactly one attempt, and the result is not tagged `retried`.
    expect(miss.results).toHaveLength(0);
    expect(summary.samples[0]?.retried).toBeUndefined();
  });

  test("--replay-miss live executes unrecorded calls for real", async () => {
    const recDir = newTempRoot();
    const rec = toolCallingChatLoop(() => ({ path: "package.json" }));
    await run({ outDir: newTempRoot(), recordToolsDir: recDir, chatLoop: rec.chatLoop });

    const live = toolCallingChatLoop(() => ({ path: "./package.json" }));
    const summary = await run({
      outDir: newTempRoot(),
      replayToolsDir: recDir,
      replayMiss: "live",
      chatLoop: live.chatLoop,
      concurrency: 1,
    });

    expect(summary.aggregates.errorCount).toBe(0);
    expect(String(live.results[0]?.output)).toContain('"name"');
    expect(summary.config.toolRecording?.missPolicy).toBe("live");
  });

  test("record and replay are mutually exclusive, and replayMiss needs a replay", async () => {
    await expect(
      run({ outDir: newTempRoot(), recordToolsDir: "/a", replayToolsDir: "/b" }),
    ).rejects.toThrow(/mutually exclusive/);
    await expect(run({ outDir: newTempRoot(), replayMiss: "live" })).rejects.toThrow(
      /replayMiss is only meaningful with replayToolsDir/,
    );
  });

  test("a caller-supplied invoker cannot record or replay — it owns its tools", async () => {
    const invoker: AgentInvoker = async () => ({ agentOutput: "x" });
    await expect(
      run({ outDir: newTempRoot(), invoker, recordToolsDir: newTempRoot() }),
    ).rejects.toThrow(/requires the default invoker/);
  });

  test("a replay directory with no cassette refuses before any spend", async () => {
    const { chatLoop } = toolCallingChatLoop(() => ({ path: "package.json" }));
    await expect(
      run({ outDir: newTempRoot(), replayToolsDir: newTempRoot(), chatLoop }),
    ).rejects.toThrow(/tool recording not found/);
  });

  test("without either flag the tool list is handed over untouched", async () => {
    const outDir = newTempRoot();
    const { chatLoop, results } = toolCallingChatLoop(() => ({ path: "package.json" }));
    const summary = await run({ outDir, chatLoop, concurrency: 1 });
    expect(String(results[0]?.output)).toContain('"name"');
    expect(summary.config).not.toHaveProperty("toolRecording");
    const manifest = JSON.parse(readFileSync(join(outDir, "run.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(manifest).not.toHaveProperty("toolRecording");
  });
});
