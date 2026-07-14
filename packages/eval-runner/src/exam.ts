/**
 * v0.3.0 Goal 2 (design §3.3 EXAM, PR 17) — `createExamRunner`: the
 * reference implementation of memory-service's injected `ExamRunner` seam.
 *
 * The expert demo's `/exam` shelled out to `crewhaus eval` via Bash from
 * inside the agent — the harness invoking its own CLI, requiring a Bash
 * permission just to sit an exam. This is the first-class replacement: a
 * PROGRAMMATIC eval invocation built from this package's own machinery
 * (`loadDataset` + `parseGradersConfig` + `runSample`/`Semaphore`), consumed
 * by the `run_exam` tool through `wireMemory({ examRunner })` on both the
 * `crewhaus run` interpreter path and compiled cli bundles.
 *
 * Exam semantics: each dataset question runs in a FRESH single-turn session
 * — the harness's own model + instructions plus an exam preamble — grounded
 * in the REAL wiki through the backend-invariant `wireWiki(...).recall` seam
 * (local store or Thredz MCP client; recall lines are injected through
 * runChatLoop's `memory` seam, so recalled bodies still cross the boundary
 * classifier + delimiter escaping like every other recall). No tools are
 * exposed to the exam session: the question is "can you answer from what the
 * wiki knows", graded by the spec's own graders — never "can you edit the
 * wiki mid-exam". Unlike `runEval`'s per-sample fabric isolation (§7.2),
 * the exam deliberately reads the live wiki — an isolated empty wiki would
 * examine amnesia.
 *
 * Per-sample artifacts land under `.crewhaus/evals/exam-<stamp>/<sampleId>/`
 * via `runSample` (transcript/events/grades/meta), so failed exams are
 * triageable with the same tooling as any eval run.
 */
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Sample } from "@crewhaus/eval-dataset";
import { loadDataset } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import { createJudgeGrader, loadRubric } from "@crewhaus/eval-judge";
import type {
  ExamReport,
  ExamRunner,
  ExamSampleOutcome,
  MemoryWiringFragment,
  ThredzConnection,
} from "@crewhaus/memory-service";
import { wireWiki } from "@crewhaus/memory-service";
import type { RunContext } from "@crewhaus/run-context";
import { runChatLoop } from "@crewhaus/runtime-core";
import { RunnerError } from "./errors";
import { runSample } from "./run-sample";
import { Semaphore } from "./semaphore";
import type { AgentInvoker, GraderEntry, SampleResult } from "./types";

/** Exam sessions run a couple at a time — an exam is an interactive,
 *  user-initiated pass, not a benchmark sweep. */
const DEFAULT_EXAM_CONCURRENCY = 2;

/** Wiki lines recalled per question (mirrors §9's `wiki.recallK` default). */
const DEFAULT_EXAM_RECALL_K = 6;

/** The exam-session preamble appended to the harness instructions — the
 *  grounding contract the demo's graders (`grounded_not_bluffed`) test. */
export const EXAM_SESSION_PREAMBLE = [
  "You are sitting your competency exam. Answer the question in this one turn:",
  "- answer ONLY from the recalled wiki context above, citing article slugs like (topic/slug);",
  "- numbers, ranges, and units must be exact;",
  "- if the recalled context does not support an answer, say plainly what you do not know instead of guessing.",
].join("\n");

/** The exact runChatLoop option subset an exam session uses — a dedicated
 *  type so tests can inject a capturing `chatLoop` and pin every field
 *  (the dream-cli `DreamChatLoopOptions` pattern). */
export type ExamChatLoopOptions = {
  readonly model: string;
  readonly instructions: string;
  readonly runContext: RunContext;
  readonly singleTurn: true;
  readonly seedMessages: ReadonlyArray<{ readonly role: "user"; readonly content: string }>;
  readonly sessionName: string;
  readonly sessionTarget: "eval";
  readonly sessionRootDir: string;
  readonly tools: ReadonlyArray<never>;
  readonly hooks: ReadonlyArray<never>;
  readonly memory?: {
    readonly autoRecall: true;
    readonly recallK: number;
    readonly recallSeed: string;
    readonly recall: (query: string, k: number) => Promise<readonly string[]>;
  };
  readonly spinner: false;
};

export type ExamChatLoopFn = (opts: ExamChatLoopOptions) => Promise<string>;

export type CreateExamRunnerOptions = {
  readonly specName: string;
  /** The harness's own model — exam sessions and (by default) the judge
   *  grader run on it. */
  readonly model: string;
  /** The harness's own instructions — the examinee is THIS harness. */
  readonly instructions: string;
  /** The memory fragment (`memoryFragmentFromIr(ir)`) — `wireWiki` grounds
   *  each question in the same wiki surface the harness runs with. */
  readonly fragment: MemoryWiringFragment;
  /** The harness working directory (stores + default artifact root). */
  readonly cwd: string;
  /** The live Thredz connection when the wiki backend is hosted (§4.3);
   *  null/absent → the local store (or no grounding when no wiki). */
  readonly thredz?: ThredzConnection | null;
  /** Judge model for `llm_judge` graders. Default: the harness model. */
  readonly judgeModel?: string;
  readonly concurrency?: number;
  /** Wiki lines recalled per question. Default 6 (§9 `wiki.recallK`). */
  readonly recallK?: number;
  /** Artifact root override. Default `<cwd>/.crewhaus/evals/exam-<stamp>`. */
  readonly outDir?: string;
  /** Full invoker override (tests / bespoke examinees). */
  readonly invoker?: AgentInvoker;
  /** Session-runner seam under the default invoker (tests pin options). */
  readonly chatLoop?: ExamChatLoopFn;
  readonly now?: () => Date;
};

/**
 * Build the injected exam runner (`wireMemory({ examRunner })`). Pure
 * construction — nothing is read until the returned runner is invoked by
 * the `run_exam` tool, so a harness that never sits its exam pays nothing.
 */
export function createExamRunner(opts: CreateExamRunnerOptions): ExamRunner {
  return async ({ datasetPath, gradersPath }) => {
    // 1. Graders — parse the spec's graders.yaml; `llm_judge` placeholders
    // bind to the judge model (per-grader override > opts.judgeModel > the
    // harness model), exactly like runEval's resolution.
    let gradersYaml: string;
    try {
      gradersYaml = readFileSync(gradersPath, "utf-8");
    } catch (err) {
      throw new RunnerError(
        `exam: cannot read graders "${gradersPath}" (learning.exam.graders): ${(err as Error).message}`,
      );
    }
    const { compiled } = parseGradersConfig(gradersYaml);
    const graders: GraderEntry[] = compiled.map((g) => {
      if (g.judgeSpec) {
        const rubric = loadRubric(g.judgeSpec.rubric);
        const model = g.judgeSpec.model ?? opts.judgeModel ?? opts.model;
        return { name: g.name, grader: createJudgeGrader(rubric, { model }) };
      }
      // v0.3.0 final integration (PR 17 ∩ PR 19): `type: registry` graders
      // resolve against RunEvalOptions.graderRegistry — a seam run_exam does
      // not carry (the exam is invoked from inside a running harness, which
      // has no grader registry to hand over). Reject LOUDLY at exam start,
      // exactly like runEval does, instead of letting the compiled
      // placeholder throw per-sample as confusing grader-infra noise.
      if (g.registrySpec) {
        throw new RunnerError(
          `exam: grader "${g.name}" is \`type: registry\` (→ "${g.registrySpec.grader}") — registry graders resolve via RunEvalOptions.graderRegistry under \`crewhaus eval\` and are not available to \`run_exam\`; use code/llm_judge graders in learning.exam.graders`,
        );
      }
      return { name: g.name, grader: g.grader };
    });

    // 2. Dataset — materialized like runEval (exams are small by design).
    let samples: Sample[];
    try {
      const dataset = await loadDataset(datasetPath);
      samples = [];
      for await (const s of dataset.samples) samples.push(s);
    } catch (err) {
      throw err instanceof RunnerError
        ? err
        : new RunnerError(
            `exam: cannot load dataset "${datasetPath}" (learning.exam.dataset): ${(err as Error).message}`,
          );
    }
    if (samples.length === 0) {
      throw new RunnerError(`exam: dataset "${datasetPath}" yielded zero samples`);
    }

    const invoker = opts.invoker ?? buildExamInvoker(opts);
    const outDir =
      opts.outDir ?? join(opts.cwd, ".crewhaus", "evals", `exam-${examStamp(opts.now)}`);
    mkdirSync(outDir, { recursive: true });

    // 3. Run — per-sample artifacts + grading via the shared runSample path.
    const sem = new Semaphore(opts.concurrency ?? DEFAULT_EXAM_CONCURRENCY);
    const results: SampleResult[] = await Promise.all(
      samples.map(async (sample) => {
        const release = await sem.acquire();
        try {
          return await runSample({
            sample,
            invoker,
            graders,
            outDir,
            model: opts.model,
            // PR 19's artifact seam: stamp the examinee's spec name so any
            // artifact-reading grader addresses the right state root.
            specName: opts.specName,
          });
        } finally {
          release();
        }
      }),
    );

    const bySampleId = new Map(samples.map((s) => [s.id, s] as const));
    const outcomes: ExamSampleOutcome[] = results.map((r) => {
      const sample = bySampleId.get(r.sampleId);
      return {
        sampleId: r.sampleId,
        input: sample?.input ?? "",
        passed: r.grades.overall.passed,
        score: r.grades.overall.score,
        rationale: r.grades.overall.rationale,
        agentOutput: r.agentOutput,
        ...(r.error !== undefined ? { error: r.error } : {}),
      };
    });
    const passed = outcomes.filter((o) => o.passed).length;
    const report: ExamReport = {
      total: outcomes.length,
      passed,
      failed: outcomes.length - passed,
      passRate: outcomes.length === 0 ? 0 : passed / outcomes.length,
      outcomes,
      outDir,
    };
    await Bun.write(join(outDir, "exam.json"), JSON.stringify(report, null, 2));
    return report;
  };
}

/** The default examinee: one fresh single-turn session per question,
 *  wiki-grounded through runChatLoop's memory seam, zero tools. */
function buildExamInvoker(opts: CreateExamRunnerOptions): AgentInvoker {
  const chatLoop: ExamChatLoopFn = opts.chatLoop ?? runChatLoop;
  const wiki = wireWiki(
    {
      specName: opts.fragment.specName,
      ...(opts.fragment.memory !== undefined ? { memory: opts.fragment.memory } : {}),
      ...(opts.fragment.thredz !== undefined ? { thredz: opts.fragment.thredz } : {}),
    },
    {
      // A registrar is required by the deps type but the exam session never
      // advertises the wiki tools — recall is the only surface it gets.
      catalog: { register: () => undefined },
      cwd: opts.cwd,
      ...(opts.thredz !== undefined ? { thredz: opts.thredz } : {}),
    },
  );
  const recallK = opts.recallK ?? opts.fragment.memory?.wiki?.recallK ?? DEFAULT_EXAM_RECALL_K;
  return async (req) => {
    const agentOutput = await chatLoop({
      model: opts.model,
      instructions: `${opts.instructions}\n\n${EXAM_SESSION_PREAMBLE}`,
      runContext: req.runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: req.sample.input }],
      sessionName: `${opts.specName}-exam`,
      sessionTarget: "eval",
      sessionRootDir: req.sessionRootDir,
      tools: [],
      hooks: [],
      ...(wiki !== null
        ? {
            memory: {
              autoRecall: true as const,
              recallK,
              recallSeed: req.sample.input,
              recall: wiki.recall,
            },
          }
        : {}),
      spinner: false,
    });
    return { agentOutput };
  };
}

function examStamp(now?: () => Date): string {
  const d = (now ?? (() => new Date()))();
  return d
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/-\d{3}Z$/, "Z");
}
