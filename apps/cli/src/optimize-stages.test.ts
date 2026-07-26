/**
 * D36 (Evals Wave 5, cluster O) — the optimize half of multi-stage support.
 *
 * Two units, both hermetic:
 *   1. `prepareBridgedCandidate` — one candidate's compile → emit → import →
 *      bridge-invoker chain. The compiled ENTRY is resolved through the
 *      `importEntry` seam so the test drives the real emitter + the real
 *      `createBridgeInvoker` without needing the emitted bundle's bare
 *      `@crewhaus/*` imports to resolve from an out-of-tree tmpdir (the
 *      constraint `eval-bridge-smoke.test.ts` documents; that file already
 *      covers the real-resolution path in a spawned `bun` process).
 *   2. `runStagedOptimize` — the sequential driver: per-stage independent
 *      gating, composition of accepted stages, and the RUN-level budget.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BridgedCandidateError,
  type StageRunOutcome,
  formatStageSummary,
  prepareBridgedCandidate,
  runStagedOptimize,
  writeBackStagedResult,
} from "./optimize-stages";

const WORKFLOW_YAML = `name: mini-flow
target: workflow
model: claude-sonnet-4-6
steps:
  - name: draft
    instructions: Draft a one-line answer.
  - name: polish
    instructions: POLISHED INSTRUCTIONS MARKER
`;

const CREW_YAML = `name: mini-crew
target: crew
model: claude-sonnet-4-6
entry: solo
roles:
  solo:
    instructions: Answer the request in one line.
`;

const CLI_YAML = `name: hello-cli
target: cli
agent:
  model: claude-sonnet-4-5
  instructions: You are a helpful assistant.
tools:
  - Read
`;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function newTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "opt-bridged-"));
  tempDirs.push(dir);
  return dir;
}

describe("prepareBridgedCandidate", () => {
  test("compiles the candidate with the eval-entry variant and wraps runForEval", async () => {
    const dir = newTmp();
    const candidateDir = join(dir, "candidates", "001");
    const seen: Array<{ input: string; opts: Record<string, unknown> }> = [];
    const prepared = await prepareBridgedCandidate({
      patchedYaml: WORKFLOW_YAML,
      candidateDir,
      importEntry: async (entryPath) => {
        // The REAL emitted entry is on disk — assert the eval-entry variant
        // actually shipped its hook before handing back a stub.
        expect(readFileSync(entryPath, "utf-8")).toContain("export async function runForEval(");
        return {
          runForEval: async (input: string, opts?: Record<string, unknown>) => {
            seen.push({ input, opts: opts ?? {} });
            return `ran:${input}`;
          },
        };
      },
    });

    expect(prepared.invokerKind).toBe("workflow-run");
    expect(prepared.entryPath).toBe(join(candidateDir, "agent.ts"));
    expect(existsSync(join(candidateDir, "agent.ts"))).toBe(true);
    // The candidate carries the rewritten stage — this is the artifact the
    // measurement runs against, not a projection of it.
    expect(readFileSync(join(candidateDir, "agent.ts"), "utf-8")).toContain(
      "POLISHED INSTRUCTIONS MARKER",
    );

    // Descriptor IR — the same bridge-descriptor shape the generated eval
    // bundle records (target: cli for run identity; never chat-invoked).
    expect(prepared.ir.target).toBe("cli");
    expect(prepared.ir.name).toBe("mini-flow");
    expect(prepared.ir.agent.model).toBe("claude-sonnet-4-6");
    expect(prepared.ir.agent.instructions).toContain("[eval bridge] multi-stage workflow");
    // Run identity tracks the DRIVEN stages (cluster S's stage digest).
    expect(prepared.ir.agent.instructions).toMatch(/step digest: [0-9a-f]{16}/);

    const out = await prepared.invoker({
      sample: { id: "s1", input: "write a haiku" },
      runContext: { sessionId: "sess_1" },
      sessionRootDir: join(dir, "sample"),
    });
    expect(out.agentOutput).toBe("ran:write a haiku");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.input).toBe("write a haiku");
    expect(seen[0]?.opts["sessionId"]).toBe("sess_1");
    expect(seen[0]?.opts["sessionRootDir"]).toBe(join(dir, "sample"));
  });

  test("the stage digest MOVES when a stage's instructions change", async () => {
    const dir = newTmp();
    const stub = async () => ({ runForEval: async () => "ok" });
    const a = await prepareBridgedCandidate({
      patchedYaml: WORKFLOW_YAML,
      candidateDir: join(dir, "a"),
      importEntry: stub,
    });
    const b = await prepareBridgedCandidate({
      patchedYaml: WORKFLOW_YAML.replace("POLISHED INSTRUCTIONS MARKER", "A DIFFERENT PROMPT"),
      candidateDir: join(dir, "b"),
      importEntry: stub,
    });
    expect(a.ir.agent.instructions).not.toBe(b.ir.agent.instructions);
  });

  test("crew drives the additive eval-entry.ts, not agent.ts", async () => {
    const dir = newTmp();
    const candidateDir = join(dir, "crew");
    const prepared = await prepareBridgedCandidate({
      patchedYaml: CREW_YAML,
      candidateDir,
      importEntry: async () => ({ runForEval: async () => "crew-ok" }),
    });
    expect(prepared.invokerKind).toBe("crew-run");
    expect(prepared.entryPath).toBe(join(candidateDir, "eval-entry.ts"));
    expect(existsSync(join(candidateDir, "eval-entry.ts"))).toBe(true);
    // The crew bundle's own files ride along (crew has no top-level agent.ts —
    // its eval entry is the ADDITIVE file, and orchestrator/daemon/roles stay
    // byte-identical to a plain compile).
    expect(existsSync(join(candidateDir, "orchestrator.ts"))).toBe(true);
    expect(existsSync(join(candidateDir, "agent_solo.ts"))).toBe(true);
  });

  test("a shape with no compiled entry is refused loudly", async () => {
    const dir = newTmp();
    await expect(
      prepareBridgedCandidate({
        patchedYaml: CLI_YAML,
        candidateDir: join(dir, "cli"),
        importEntry: async () => ({}),
      }),
    ).rejects.toThrow(BridgedCandidateError);
  });

  test("an entry that cannot be imported names the resolution constraint", async () => {
    const dir = newTmp();
    let message = "";
    try {
      await prepareBridgedCandidate({
        patchedYaml: WORKFLOW_YAML,
        candidateDir: join(dir, "boom"),
        importEntry: async () => {
          throw new Error("Cannot find module '@crewhaus/runtime-core'");
        },
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("Cannot find module");
    expect(message).toContain("dependencies are installed");
  });
});

describe("runStagedOptimize", () => {
  const stage = (name: string, index: number) => ({
    name,
    kind: "step",
    path: ["steps", String(index), "instructions"],
    instructions: `${name} instructions`,
  });
  const outcome = (over: Partial<StageRunOutcome> = {}): StageRunOutcome => ({
    applied: true,
    scoreBefore: 0.4,
    scoreAfter: 0.8,
    improvement: 0.4,
    patchedYaml: "patched: yaml\n",
    spentUsdMicros: 0,
    budgetExhausted: false,
    ...over,
  });

  test("composes accepted stages: stage N+1 starts from stage N's patched spec", async () => {
    const dir = newTmp();
    const start = join(dir, "crewhaus.yaml");
    writeFileSync(start, WORKFLOW_YAML);
    const seenPaths: string[] = [];
    const result = await runStagedOptimize({
      stages: [stage("draft", 0), stage("polish", 1)],
      startingYamlPath: start,
      workingDir: join(dir, "stages"),
      runStage: async ({ stage: s, specPath }) => {
        seenPaths.push(specPath);
        return outcome({ patchedYaml: `# after ${s.name}\n${WORKFLOW_YAML}` });
      },
    });
    expect(result.acceptedCount).toBe(2);
    expect(seenPaths[0]).toBe(start);
    // Second stage reads the composed file, not the original.
    expect(seenPaths[1]).not.toBe(start);
    expect(readFileSync(seenPaths[1] as string, "utf-8")).toContain("# after draft");
    expect(readFileSync(result.finalYamlPath, "utf-8")).toContain("# after polish");
  });

  test("each stage is gated INDEPENDENTLY — a rejected stage leaves the working spec alone", async () => {
    const dir = newTmp();
    const start = join(dir, "crewhaus.yaml");
    writeFileSync(start, WORKFLOW_YAML);
    const seenPaths: string[] = [];
    const result = await runStagedOptimize({
      stages: [stage("draft", 0), stage("polish", 1), stage("finish", 2)],
      startingYamlPath: start,
      workingDir: join(dir, "stages"),
      runStage: async ({ stage: s, specPath }) => {
        seenPaths.push(specPath);
        if (s.name === "draft") {
          return outcome({ applied: false, improvement: 0.001, scoreAfter: 0.401 });
        }
        return outcome({ patchedYaml: `# after ${s.name}\n${WORKFLOW_YAML}` });
      },
    });
    // A rejected first stage does NOT abort the run.
    expect(result.perStage).toHaveLength(3);
    expect(result.acceptedCount).toBe(2);
    // Stage 2 still started from the untouched original.
    expect(seenPaths[1]).toBe(start);
    expect(readFileSync(result.finalYamlPath, "utf-8")).toContain("# after finish");
  });

  test("nothing accepted ⇒ finalYamlPath is the untouched starting spec", async () => {
    const dir = newTmp();
    const start = join(dir, "crewhaus.yaml");
    writeFileSync(start, WORKFLOW_YAML);
    const result = await runStagedOptimize({
      stages: [stage("draft", 0), stage("polish", 1)],
      startingYamlPath: start,
      workingDir: join(dir, "stages"),
      runStage: async () => outcome({ applied: false, improvement: 0 }),
    });
    expect(result.acceptedCount).toBe(0);
    expect(result.finalYamlPath).toBe(start);
    expect(readFileSync(start, "utf-8")).toBe(WORKFLOW_YAML);
  });

  test("--budget-usd is a RUN ceiling: each stage gets the REMAINDER, not the full cap", async () => {
    const dir = newTmp();
    const start = join(dir, "crewhaus.yaml");
    writeFileSync(start, WORKFLOW_YAML);
    const offered: Array<number | undefined> = [];
    const result = await runStagedOptimize({
      stages: [stage("a", 0), stage("b", 1), stage("c", 2)],
      startingYamlPath: start,
      workingDir: join(dir, "stages"),
      budgetUsd: 1,
      runStage: async ({ budgetUsd }) => {
        offered.push(budgetUsd);
        // Each stage burns $0.40.
        return outcome({ applied: false, spentUsdMicros: 400_000 });
      },
    });
    expect(offered).toEqual([1, 0.6, 0.2]);
    expect(result.totalSpentUsdMicros).toBe(1_200_000);
    // Three stages ran (the third was offered the remaining $0.20).
    expect(result.perStage).toHaveLength(3);
  });

  test("a stage that reports the budget exhausted stops the run and names the skipped stages", async () => {
    const dir = newTmp();
    const start = join(dir, "crewhaus.yaml");
    writeFileSync(start, WORKFLOW_YAML);
    let ran = 0;
    const result = await runStagedOptimize({
      stages: [stage("a", 0), stage("b", 1), stage("c", 2)],
      startingYamlPath: start,
      workingDir: join(dir, "stages"),
      budgetUsd: 5,
      runStage: async () => {
        ran += 1;
        return outcome({ applied: false, budgetExhausted: true, spentUsdMicros: 10 });
      },
    });
    expect(ran).toBe(1);
    expect(result.stoppedEarly).toBe(true);
    expect(result.skipped.map((s) => s.name)).toEqual(["b", "c"]);
  });

  test("logs one line per stage with its patch path", async () => {
    const dir = newTmp();
    const start = join(dir, "crewhaus.yaml");
    writeFileSync(start, WORKFLOW_YAML);
    const lines: string[] = [];
    await runStagedOptimize({
      stages: [stage("draft", 0)],
      startingYamlPath: start,
      workingDir: join(dir, "stages"),
      log: (l) => lines.push(l),
      runStage: async () => outcome(),
    });
    expect(lines.some((l) => l.includes("stage 1/1: draft (step)"))).toBe(true);
    expect(lines.some((l) => l.includes("steps.0.instructions"))).toBe(true);
    expect(lines.some((l) => l.includes("ACCEPTED"))).toBe(true);
  });
});

/**
 * The DESTRUCTIVE half of the staged path: the single write-back that
 * overwrites the operator's tracked spec. Driven end-to-end through
 * `runStagedOptimize` (a stubbed `runStage` stands in for the per-stage
 * optimizer search) so the composition the write consumes is the real one.
 */
describe("writeBackStagedResult (the staged write-back)", () => {
  const stage = (name: string, index: number) => ({
    name,
    kind: "step",
    path: ["steps", String(index), "instructions"],
    instructions: `${name} instructions`,
  });
  const outcome = (over: Partial<StageRunOutcome> = {}): StageRunOutcome => ({
    applied: true,
    scoreBefore: 0.4,
    scoreAfter: 0.8,
    improvement: 0.4,
    patchedYaml: "patched: yaml\n",
    spentUsdMicros: 0,
    budgetExhausted: false,
    ...over,
  });
  /** Stage k's accepted candidate: the source YAML with stage k rewritten. */
  const rewriteStage = (yaml: string, marker: string, rewritten: string): string =>
    yaml.replace(marker, rewritten);

  /** Drive both stages of the mini workflow; `reject` names a rejected stage. */
  async function driveTwoStages(dir: string, reject?: "draft" | "polish") {
    const start = join(dir, "crewhaus.yaml");
    writeFileSync(start, WORKFLOW_YAML);
    let yaml = WORKFLOW_YAML;
    const staged = await runStagedOptimize({
      stages: [stage("draft", 0), stage("polish", 1)],
      startingYamlPath: start,
      workingDir: join(dir, "stages"),
      runStage: async ({ stage: s, specPath }) => {
        yaml = readFileSync(specPath, "utf-8");
        if (s.name === reject) return outcome({ applied: false, improvement: 0.001 });
        const patchedYaml =
          s.name === "draft"
            ? rewriteStage(yaml, "Draft a one-line answer.", "DRAFT REWRITE ALPHA")
            : rewriteStage(yaml, "POLISHED INSTRUCTIONS MARKER", "POLISH REWRITE BETA");
        return outcome({
          patchedYaml,
          ...(s.name === "polish" ? { scoreBefore: 0.6, scoreAfter: 0.9 } : {}),
        });
      },
    });
    return { start, staged };
  }

  test("without a write-back the source spec is byte-identical", async () => {
    const dir = newTmp();
    const { start, staged } = await driveTwoStages(dir);
    expect(staged.acceptedCount).toBe(2);
    // The composed result exists, but only under the run dir.
    expect(staged.finalYamlPath).not.toBe(start);
    expect(readFileSync(staged.finalYamlPath, "utf-8")).toContain("POLISH REWRITE BETA");
    expect(readFileSync(start, "utf-8")).toBe(WORKFLOW_YAML);
  });

  test("with a write-back the source gains ONE stamp and both accepted stages' text", async () => {
    const dir = newTmp();
    const { start, staged } = await driveTwoStages(dir);
    const r = writeBackStagedResult({
      result: staged,
      targetSpecPath: start,
      runId: "opt_test",
      mutator: "rule-based",
      iterations: 7,
      timestamp: "2026-07-26T00:00:00.000Z",
    });
    expect(r.acceptedStages).toEqual(["draft", "polish"]);

    const written = readFileSync(start, "utf-8");
    expect(written).toBe(r.written);
    // Exactly one provenance stamp (a second run must not double-stamp the
    // composed text this one produced).
    expect(written.match(/# crewhaus optimize: runId/g)).toHaveLength(1);
    expect(written.startsWith("# crewhaus optimize: runId opt_test")).toBe(true);
    // The stamp spans the RUN: first accepted stage's before → last's after,
    // and names which stages moved.
    expect(written).toContain("# - mutator: rule-based (2 stage(s): draft, polish)");
    expect(written).toContain("# - score: 0.400 → 0.900");
    expect(written).toContain("# - iterations: 7");
    // Both accepted stages' rewrites survived the composition.
    expect(written).toContain("DRAFT REWRITE ALPHA");
    expect(written).toContain("POLISH REWRITE BETA");
    expect(written).not.toContain("Draft a one-line answer.");
    expect(written).not.toContain("POLISHED INSTRUCTIONS MARKER");
  });

  test("a REJECTED stage's instructions survive untouched in the written file", async () => {
    const dir = newTmp();
    const { start, staged } = await driveTwoStages(dir, "draft");
    expect(staged.acceptedCount).toBe(1);
    writeBackStagedResult({
      result: staged,
      targetSpecPath: start,
      runId: "opt_test",
      mutator: "claude",
      iterations: 3,
      timestamp: "2026-07-26T00:00:00.000Z",
    });
    const written = readFileSync(start, "utf-8");
    // The rejected stage keeps its ORIGINAL prompt…
    expect(written).toContain("Draft a one-line answer.");
    expect(written).not.toContain("DRAFT REWRITE ALPHA");
    // …while the accepted one carries its rewrite, and the stamp names only it.
    expect(written).toContain("POLISH REWRITE BETA");
    expect(written).toContain("# - mutator: claude (1 stage(s): polish)");
  });

  test("refuses to stamp a run in which nothing was accepted", async () => {
    const dir = newTmp();
    const start = join(dir, "crewhaus.yaml");
    writeFileSync(start, WORKFLOW_YAML);
    const staged = await runStagedOptimize({
      stages: [stage("draft", 0)],
      startingYamlPath: start,
      workingDir: join(dir, "stages"),
      runStage: async () => outcome({ applied: false, improvement: 0 }),
    });
    expect(() =>
      writeBackStagedResult({
        result: staged,
        targetSpecPath: start,
        runId: "opt_test",
        mutator: "rule-based",
        iterations: 1,
      }),
    ).toThrow(BridgedCandidateError);
    // …and the tracked spec is still byte-identical.
    expect(readFileSync(start, "utf-8")).toBe(WORKFLOW_YAML);
  });
});

describe("formatStageSummary", () => {
  test("renders name + kind pairs", () => {
    expect(
      formatStageSummary([
        { name: "draft", kind: "step" },
        { name: "polish", kind: "step" },
      ]),
    ).toBe("draft (step), polish (step)");
  });
});
