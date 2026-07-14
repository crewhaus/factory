/**
 * v0.3.0 §7.2 — eval state ISOLATION leak test (PR 11).
 *
 * With continuity DEFAULT-ON, `defaultInvoker` wires the memory fabric per
 * sample with every store rooted under the sample's own artifact directory.
 * The pin: focus/plan state written while sample N runs must be INVISIBLE
 * to sample N+1 — Pillar 2 assumes spec patches are the only cross-run
 * channel, so cross-sample store bleed would corrupt every measurement.
 *
 * `wire-once` and `runChatLoop` are stubbed (no tools, no model call), but
 * `wireMemory` runs FOR REAL: the stub loop receives the genuinely-wired
 * FocusWrite/FocusRead tools + continuity seam, writes a sample-specific
 * focus, and records what a fresh read saw beforehand. `mock.module` is
 * process-global, so this lives in its own file.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import type { IrNode, IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import type { RegisteredTool } from "@crewhaus/tool-catalog";

type ChatLoopCall = {
  tools?: RegisteredTool[];
  seedMessages?: Array<{ content: string }>;
  continuity?: { loadPlan: () => Promise<string | null> };
  memory?: unknown;
};

/** Per-sample observations made INSIDE the stub loop, while the sample's
 *  wired tools were live. */
const observed: Array<{
  sample: string;
  focusBefore: string;
  planTailBefore: string | null;
  hadContinuitySeam: boolean;
}> = [];

const realWireOnce = { ...(await import("./wire-once")) };
const realRuntimeCore = { ...(await import("@crewhaus/runtime-core")) };

mock.module("./wire-once", () => ({
  wireRunOnce: async () => ({
    tools: [],
    hooks: [],
    skills: [],
    slashCommands: new Map(),
    permissionRules: { flag: [], settings: [], yaml: [], hooks: [], builtin: [] },
    model: "claude-stub",
    instructions: "stub instructions",
    sessionName: "iso",
    sessionTarget: "cli",
  }),
}));

mock.module("@crewhaus/runtime-core", () => ({
  ...realRuntimeCore,
  runChatLoop: async (opts: ChatLoopCall) => {
    const sample = opts.seedMessages?.[0]?.content ?? "?";
    const tools = opts.tools ?? [];
    const focusRead = tools.find((t) => t.name === "FocusRead");
    const focusWrite = tools.find((t) => t.name === "FocusWrite");
    if (focusRead === undefined || focusWrite === undefined) {
      throw new Error("expected the wired FocusRead/FocusWrite tools");
    }
    const focusBefore = String(await focusRead.execute({}));
    const planTailBefore = opts.continuity !== undefined ? await opts.continuity.loadPlan() : null;
    observed.push({
      sample,
      focusBefore,
      planTailBefore,
      hadContinuitySeam: opts.continuity !== undefined,
    });
    // Leave sample-specific state behind — the NEXT sample must not see it.
    await focusWrite.execute({ focus: `leak-canary from sample ${sample}` });
    return `answer for ${sample}`;
  },
}));

const { runEval } = await import("./index");

function narrowToAgent(ir: IrNode): IrV0 {
  if (ir.target !== "cli") throw new Error(`expected target:cli, got ${ir.target}`);
  return ir;
}

// No `continuity:` key → DEFAULT-ON (the 0.3.0 sanctioned change).
const SPEC = `name: iso-test
target: cli
agent:
  model: claude-opus-4-7
  instructions: spec instructions
`;

async function* yieldSamples(samples: Sample[]): AsyncIterable<Sample> {
  for (const s of samples) yield s;
}

const TMP_ROOTS: string[] = [];
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
  mock.module("./wire-once", () => realWireOnce);
  mock.module("@crewhaus/runtime-core", () => realRuntimeCore);
});

describe("eval state isolation (§7.2) — two-sample leak test", () => {
  test("sample N's focus/plan never leaks into sample N+1", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "crewhaus-eval-iso-"));
    TMP_ROOTS.push(outDir);
    observed.length = 0;

    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    expect(ir.continuity).toBeDefined(); // default-on precondition
    const samples: Sample[] = [
      { id: "s1", input: "one", expected_output: "answer for one" },
      { id: "s2", input: "two", expected_output: "answer for two" },
    ];
    const { compiled } = parseGradersConfig("graders:\n  - name: m\n    type: exact_match\n");

    const summary = await runEval({
      ir,
      dataset: { name: "iso", samples: yieldSamples(samples) },
      compiledGraders: compiled,
      // concurrency 1 → strictly sequential, so a leaking store WOULD be
      // visible to the second sample if isolation were broken.
      opts: { outDir, concurrency: 1 },
    });
    expect(summary.aggregates.passRate).toBe(1);

    // Both samples got the fabric (seam + tools) …
    expect(observed).toHaveLength(2);
    for (const o of observed) {
      expect(o.hadContinuitySeam).toBe(true);
      // … and each saw a PRISTINE store at start: no focus, no plan tail.
      expect(o.focusBefore).toContain("no focus set");
      expect(o.planTailBefore).toBeNull();
      expect(o.focusBefore).not.toContain("leak-canary");
    }

    // The stores landed inside each sample's own artifact directory —
    // ephemeral, namespaced, cleaned with the eval run dir.
    for (const id of ["s1", "s2"]) {
      expect(existsSync(join(outDir, id, ".crewhaus", "state", "iso-test", "focus.md"))).toBe(true);
    }
  });
});
