/**
 * The harness's budget period reaches every eval sample (#516): each model call a
 * sample makes reserves and settles on the period's ledger with trigger `eval`, a
 * used-up period stops a sample at its first call with the classified budget report
 * (and no second attempt), and a spec without a period writes nothing under `budget/`.
 *
 * The real chat loop runs each sample, with a scripted adapter through its `_adapter`
 * seam; the session runner is injected through `RunEvalOptions.chatLoop`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@crewhaus/adapter-anthropic";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import type { IrNode, IrV0 } from "@crewhaus/ir";
import { runChatLoop } from "@crewhaus/runtime-core";
import { parseSpec } from "@crewhaus/spec";
import { type EvalChatLoopFn, runEval } from "./index";

const ROOTS: string[] = [];
const tempDir = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `crewhaus-eval-period-${label}-`));
  ROOTS.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
});

/** 100 tokens in and 10 out on claude-sonnet-4-6: 450 USD-micros a call. */
const CALL_MICROS = 450;
/** The spec's period cap, $1. */
const CAP_MICROS = 1_000_000;
const SPEC = (budget: string) =>
  `name: eval-period\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: Answer.\n${budget}`;
const WITH_PERIOD = "budget:\n  usd: 5\n  period: {every: month, usd: 1}\n";

/** An adapter that answers every call with one short text turn, and counts its calls. */
function textAdapter(): ProviderAdapter & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    providerId: "anthropic",
    features: { caching: false, tool_use: true, vision: false, thinking: false, web_search: false },
    estimateTokens: () => 0,
    stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
      requests.push(req);
      return (async function* () {
        yield { kind: "message_start", usage: { input: 100, output: 0 } };
        yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
        yield { kind: "content_block_delta", index: 0, delta: { type: "text_delta", text: "4" } };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "end_turn", usage: { input: 100, output: 10 } };
        yield { kind: "message_stop" };
      })();
    },
  };
}

async function* yieldSamples(samples: ReadonlyArray<Sample>): AsyncIterable<Sample> {
  for (const s of samples) yield s;
}

const SAMPLES: Sample[] = [
  { id: "a", input: "2+2?", expected_output: "4" },
  { id: "b", input: "2+2?", expected_output: "4" },
];

async function evalIn(harness: string, budget: string) {
  const adapter = textAdapter();
  const chatLoop: EvalChatLoopFn = (opts) =>
    runChatLoop({ ...opts, _adapter: adapter, installSigintHandler: false, spinner: false });
  const ir = lower(parseSpec(SPEC(budget))) as IrNode;
  if (ir.target !== "cli") throw new Error("expected target cli");
  const summary = await runEval({
    ir: ir as IrV0,
    dataset: { name: "period", samples: yieldSamples(SAMPLES) },
    compiledGraders: parseGradersConfig("graders:\n  - name: m\n    type: exact_match\n").compiled,
    opts: {
      chatLoop,
      outDir: join(harness, "out"),
      specDir: harness,
      concurrency: 1,
      datasetHash: "ds",
      gradersHash: "gr",
    },
  });
  return { summary, adapter };
}

/** The current monthly period's directory (UTC, the default grid). */
function currentPeriodDir(harness: string): string {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return join(
    harness,
    ".crewhaus",
    "run",
    "control",
    "budget",
    `month-${now.getUTCFullYear()}-${month}-01`,
  );
}

/** Settled spend and still-open reservations, summed from the ledger lines. */
function totals(lines: readonly Record<string, unknown>[]): { spent: number; open: number } {
  const open = new Set<string>();
  let spent = 0;
  for (const l of lines) {
    const id = String(l["id"]);
    if (l["op"] === "reserve") open.add(id);
    if (l["op"] === "settle" || l["op"] === "release") open.delete(id);
    if (l["op"] === "settle" && typeof l["usdMicros"] === "number") spent += l["usdMicros"];
  }
  return { spent, open: open.size };
}

/** Every line of the period's ledger segments. */
function ledgerLines(harness: string): Record<string, unknown>[] {
  const root = join(harness, ".crewhaus", "run", "control", "budget");
  const out: Record<string, unknown>[] = [];
  for (const period of readdirSync(root)) {
    if (!period.startsWith("month-")) continue;
    for (const seg of readdirSync(join(root, period))) {
      for (const line of readFileSync(join(root, period, seg), "utf8").split("\n")) {
        if (line !== "") out.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
  }
  return out;
}

describe("an eval under a budget period", () => {
  test("every sample's model call reserves and settles on the harness's period, as eval", async () => {
    const harness = tempDir("spend");
    const { summary, adapter } = await evalIn(harness, WITH_PERIOD);
    expect(summary.samples.every((s) => s.error === undefined)).toBe(true);
    expect(adapter.requests).toHaveLength(2);
    const lines = ledgerLines(harness);
    expect(lines.filter((l) => l["op"] === "reserve")).toHaveLength(2);
    expect(lines.filter((l) => l["op"] === "settle")).toHaveLength(2);
    expect(lines.every((l) => l["trigger"] === "eval")).toBe(true);
    expect(totals(lines)).toEqual({ spent: 2 * CALL_MICROS, open: 0 });
  }, 20_000); // two real chat-loop runs, each wiring the spec's tools

  test("a used-up period stops each sample at its first call with the budget report, once", async () => {
    const harness = tempDir("used-up");
    // Earlier spend took the whole cap.
    const dir = currentPeriodDir(harness);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "000001.jsonl"),
      `${JSON.stringify({ v: 1, at: new Date().toISOString(), op: "settle", id: "earlier", usdMicros: CAP_MICROS })}\n`,
    );
    const { summary, adapter } = await evalIn(harness, WITH_PERIOD);
    // Nothing was dispatched, and no sample was tried twice.
    expect(adapter.requests).toHaveLength(0);
    for (const s of summary.samples) {
      expect(s.error).toContain("budget for this period is used up");
      expect(s.retried).toBeUndefined();
    }
    expect(totals(ledgerLines(harness))).toEqual({ spent: CAP_MICROS, open: 0 });
  }, 20_000); // two real chat-loop runs, each wiring the spec's tools

  test("a spec without a period writes nothing under budget/", async () => {
    const harness = tempDir("none");
    const { summary } = await evalIn(harness, "budget:\n  usd: 5\n");
    expect(summary.samples.every((s) => s.error === undefined)).toBe(true);
    expect(existsSync(join(harness, ".crewhaus", "run", "control", "budget"))).toBe(false);
  }, 20_000); // two real chat-loop runs, each wiring the spec's tools
});
