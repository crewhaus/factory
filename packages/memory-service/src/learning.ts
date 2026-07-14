/**
 * v0.3.0 Goal 2 — the learning side of the composition root (design §3.3,
 * PR 17): continual learning as a first-class, pluggable capability.
 *
 * What lives here:
 *
 *   - the `learning` fragment slice types (`LearningWiringFragment`) and the
 *     compile-time skill substitution helpers — `wireMemory` renders the
 *     builtin `learning-loop` skill via `renderSkill("learning-loop",
 *     learningSkillSubstitutions(learning))` so `{{domain}}`,
 *     `{{curriculum}}`, and `{{sources}}` are resolved before the skill ever
 *     reaches a prompt;
 *   - the FIRST-CLASS EXAM seam ({@link ExamRunner}) + the `run_exam` tool.
 *     The expert demo shelled out to `crewhaus eval` via Bash from inside
 *     the agent — the harness invoking its own CLI. Here the exam is a
 *     programmatic eval-runner invocation injected through `deps.examRunner`
 *     (built by `@crewhaus/eval-runner`'s `createExamRunner` on the CLI run
 *     path and in emitted bundles — this package cannot import eval-runner,
 *     which depends on it), and every failed sample is logged as a knowledge
 *     gap automatically (the design's flywheel edge);
 *   - the UNATTENDED STUDY pieces (§3.3 `study` toggles): the heartbeat
 *     study-rotation preamble (gaps first, ~3:1 study:reflect, bounded per
 *     tick — the expert demo's HEARTBEAT.md policy, productized) and the
 *     dream model-phase seed (top open knowledge gaps + the next unmastered
 *     curriculum rung), composed onto dream-engine's existing `DreamModelPhase`
 *     seam without touching the engine.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DEFAULT_SKILLS, renderSkill } from "@crewhaus/default-skills";
import type { DreamModelPhase } from "@crewhaus/dream-engine";
import type { LoadedSkill } from "@crewhaus/skills-registry";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import type { KnowledgeGap } from "@crewhaus/tool-wiki";
import { z } from "zod";

// ---------------------------------------------------------------------------
// fragment slice (what IrLearning lowers into — structural, no @crewhaus/ir)
// ---------------------------------------------------------------------------

/** The `learning.exam` slice — spec-relative dataset/graders paths. Whether
 *  the files EXIST is checked at run time by the exam runner (clear error),
 *  never at compile time. */
export type LearningExamFragment = {
  readonly dataset: string;
  readonly graders: string;
};

/** The `learning.study` unattended-study toggles. The compiler lowers them
 *  RESOLVED (both default true); optional here so hand-built fragments stay
 *  ergonomic (absent means on — the learning block itself is the opt-in). */
export type LearningStudyFragment = {
  readonly onHeartbeat?: boolean;
  readonly onDream?: boolean;
};

/** The `learning:` slice (§3.3/§9) — `IrLearning` structurally. */
export type LearningWiringFragment = {
  /** One sentence naming the field of expertise. */
  readonly domain: string;
  /** Spec-relative path to the agent-editable curriculum ladder file. */
  readonly curriculum?: string;
  /** Source-allowlist hints (NOT optimizable — allowlist = security §7.5). */
  readonly sources?: readonly string[];
  readonly exam?: LearningExamFragment;
  readonly study?: LearningStudyFragment;
};

/** Structural mirror of `IrLearning` (kept structural so this package never
 *  imports `@crewhaus/ir`). */
export type IrLearningLike = {
  readonly domain: string;
  readonly curriculum?: string;
  readonly sources?: readonly string[];
  readonly exam?: { readonly dataset: string; readonly graders: string };
  readonly study?: { readonly onHeartbeat?: boolean; readonly onDream?: boolean };
};

// ---------------------------------------------------------------------------
// skill substitution (design §3.3 — compile-time {{domain}}/{{curriculum}}/
// {{sources}} templating; the ONLY sanctioned use of skill tokens)
// ---------------------------------------------------------------------------

/**
 * Build the `renderSkill("learning-loop", …)` substitution map from a
 * learning fragment. Every token gets a value even when the spec omitted the
 * optional fields — a half-templated skill (literal `{{curriculum}}` in the
 * prompt) is exactly what renderSkill's strictness exists to prevent:
 *
 *   - `curriculum`: the backticked file path, or a wiki-article fallback
 *     instruction when no file is configured;
 *   - `sources`: the backticked allowlist, or a no-allowlist note that keeps
 *     the skill's own quality bar in force.
 */
export function learningSkillSubstitutions(
  learning: LearningWiringFragment,
): Record<string, string> {
  return {
    domain: learning.domain,
    curriculum:
      learning.curriculum !== undefined
        ? `the \`${learning.curriculum}\` file (agent-editable — Read it, tick it, extend it)`
        : "your `curriculum` wiki article (no curriculum file is configured — keep the ladder there)",
    sources:
      learning.sources !== undefined && learning.sources.length > 0
        ? learning.sources.map((s) => `\`${s}\``).join(", ")
        : "(no allowlist configured — hold every source to the quality bar below)",
  };
}

/**
 * The rendered builtin `learning-loop` skill: the checked-in body with the
 * fragment's domain/curriculum/sources substituted, ready for
 * `discoverSkills({ builtinSkills })` merging at LOWEST precedence — a user
 * or project `learning-loop` skill still overrides by name. The composed
 * body is classified at the `"skill"` TrustOrigin on load like any other.
 */
export function renderedLearningSkill(learning: LearningWiringFragment): LoadedSkill {
  const base = DEFAULT_SKILLS.find((s) => s.name === "learning-loop");
  if (base === undefined) {
    // DEFAULT_SKILLS is built from checked-in files at import time; a missing
    // learning-loop is a broken install, not a config error.
    throw new Error('default skill "learning-loop" missing from DEFAULT_SKILLS');
  }
  return { ...base, body: renderSkill("learning-loop", learningSkillSubstitutions(learning)) };
}

// ---------------------------------------------------------------------------
// unattended study 1/2 — the heartbeat study-rotation preamble (§3.3
// study.on_heartbeat; the expert demo's HEARTBEAT.md policy, productized)
// ---------------------------------------------------------------------------

/**
 * The study-rotation preamble prepended to channel heartbeat instructions
 * when `learning.study.on_heartbeat` is on. target-channel-bot bakes it at
 * CODEGEN time (the emitter already imports this package), so the emitted
 * daemon carries the resolved text. Deterministic and pure — safe to call
 * from codegen.
 */
export function renderStudyRotationPreamble(learning: LearningWiringFragment): string {
  const curriculumNote =
    learning.curriculum !== undefined
      ? `the next unmastered rung in \`${learning.curriculum}\``
      : "the next unmastered rung of your curriculum wiki article";
  return [
    `[learning] This heartbeat is also an unattended study tick for your domain: ${learning.domain}.`,
    "Load the `learning-loop` skill first, then pick this tick's mode:",
    "1. GAPS FIRST — list open knowledge gaps (`GoalList` locally; `task_list` tag `knowledge-gap` on Thredz). Any open gap makes this a STUDY tick aimed at the top gap.",
    `2. Otherwise rotate roughly 3 STUDY ticks (${curriculumNote}, then the frontier) to 1 REFLECT tick — infer the recent mix from wiki activity (\`wiki_list\`, newest first).`,
    "3. Stay bounded: one topic studied or a handful of articles reconciled per tick — commit cited wiki writes, summarize in one line, stop.",
    "Then handle the operator's heartbeat instructions below.",
    "---",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// unattended study 2/2 — the dream model-phase learning seed (§3.3
// study.on_dream): top open gaps + the stalest/next curriculum rung
// ---------------------------------------------------------------------------

/** Cap on gaps folded into the dream prompt — the seed points the pass at
 *  the top of the queue; it is not the queue. */
const DREAM_SEED_MAX_GAPS = 5;

/**
 * The next unmastered curriculum rung: the first unchecked GitHub-style
 * checkbox (`- [ ]` / `* [ ]`) in the curriculum file. Deterministic; null
 * when the file is missing/unreadable or fully mastered.
 */
export function nextCurriculumRung(curriculumText: string): string | null {
  for (const line of curriculumText.split("\n")) {
    const m = /^\s*[-*]\s*\[\s\]\s*(.+)$/.exec(line);
    if (m?.[1] !== undefined && m[1].trim() !== "") return m[1].trim();
  }
  return null;
}

/**
 * Build the `## Learning` block appended to the dream model phase's seeded
 * prompt when `study.on_dream` is on: the top open knowledge gaps (injected
 * lister — the spec-scoped plan store's `[gap]` goals locally; Thredz gaps
 * live server-side as tasks and are noted, not fetched, since the dream
 * engine runs without a Thredz connection) + the next unmastered curriculum
 * rung read from the curriculum file. Returns null when there is nothing to
 * seed (no gaps, no rung) so the prompt stays untouched.
 */
export async function buildLearningDreamSeed(opts: {
  readonly learning: LearningWiringFragment;
  /** The harness working directory `learning.curriculum` resolves against. */
  readonly cwd: string;
  /** Open-gap titles, best-effort (the caller wires the spec-scoped store). */
  readonly listGaps: () => Promise<readonly string[]>;
}): Promise<string | null> {
  let gaps: readonly string[] = [];
  try {
    gaps = (await opts.listGaps()).slice(0, DREAM_SEED_MAX_GAPS);
  } catch {
    // Best-effort — a gap-listing failure never blocks consolidation.
  }
  let rung: string | null = null;
  const curriculum = opts.learning.curriculum;
  if (curriculum !== undefined) {
    try {
      const path = isAbsolute(curriculum) ? curriculum : join(opts.cwd, curriculum);
      rung = nextCurriculumRung(readFileSync(path, "utf-8"));
    } catch {
      // Missing curriculum file is a runtime non-event for the dream.
    }
  }
  if (gaps.length === 0 && rung === null) return null;
  const lines = [
    "## Learning",
    `This harness learns continually (domain: ${opts.learning.domain}). Fold these into the pass:`,
  ];
  if (gaps.length > 0) {
    lines.push(`- top open knowledge gaps (${gaps.length}):`);
    for (const gap of gaps) lines.push(`  - ${gap}`);
  }
  if (rung !== null) {
    lines.push(`- next unmastered curriculum rung: ${rung}`);
  }
  lines.push(
    "- prefer consolidations that close a gap or advance the rung: promote corroborated facts into cited wiki drafts on those topics, and leave the rest as logged gaps.",
  );
  return lines.join("\n");
}

/**
 * Compose the learning seed onto dream-engine's EXISTING `DreamModelPhase`
 * seam (consume, don't rewrite): the wrapped runner appends the `## Learning`
 * block — computed fresh per run — to the engine-built prompt before
 * delegating. The engine's playbook/budget/evidence mechanics are untouched.
 */
export function withLearningDreamSeed(
  inner: DreamModelPhase,
  opts: {
    readonly learning: LearningWiringFragment;
    readonly cwd: string;
    readonly listGaps: () => Promise<readonly string[]>;
  },
): DreamModelPhase {
  return {
    model: inner.model,
    run: async (input) => {
      const seed = await buildLearningDreamSeed(opts);
      if (seed === null) return inner.run(input);
      return inner.run({ ...input, prompt: `${input.prompt}\n\n${seed}` });
    },
  };
}

/** `[gap]` — the plan-store goal-title prefix `log_knowledge_gap` writes
 *  (see wireMemory's gap sink) and the dream seed / study listing read. */
export const GAP_GOAL_PREFIX = "[gap]";

// ---------------------------------------------------------------------------
// the first-class exam (§3.3 EXAM — the run_exam tool + the injected runner)
// ---------------------------------------------------------------------------

/** One graded exam sample, backend-agnostic. */
export type ExamSampleOutcome = {
  readonly sampleId: string;
  /** The question put to the agent. */
  readonly input: string;
  readonly passed: boolean;
  /** Mean grader score in [0,1]. */
  readonly score: number;
  /** The combined grader rationale (verbatim — the skill reports failures
   *  verbatim). */
  readonly rationale?: string;
  readonly agentOutput?: string;
  /** Invoker/grader infrastructure error, when the sample never graded. */
  readonly error?: string;
};

/** The exam runner's report — what the `run_exam` tool renders. */
export type ExamReport = {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  /** passed / total in [0,1]; 0 for an empty run. */
  readonly passRate: number;
  readonly outcomes: readonly ExamSampleOutcome[];
  /** Where per-sample artifacts landed, when the runner persisted them. */
  readonly outDir?: string;
};

/** What the injected exam runner receives — the spec's `learning.exam`
 *  paths, resolved to absolute by the tool before the call. */
export type ExamRunnerRequest = {
  readonly datasetPath: string;
  readonly gradersPath: string;
};

/**
 * THE exam seam (§3.3): a programmatic eval invocation — dataset in, graded
 * report out. `@crewhaus/eval-runner` exports `createExamRunner` (the
 * reference implementation: loadDataset + parseGradersConfig + per-sample
 * single-turn sessions grounded in wiki recall, graded by the configured
 * graders); it is INJECTED here because eval-runner depends on this package.
 * No Bash, no CLI shell-out — the harness's own Bash permission is never
 * required to sit the exam.
 */
export type ExamRunner = (req: ExamRunnerRequest) => Promise<ExamReport>;

const runExamInput = z.object({}).strict();

/** Cap on failed items rendered verbatim into the tool result — the full
 *  list persists in the runner's artifacts. */
const EXAM_REPORT_MAX_FAILURES = 20;

export type CreateExamToolOptions = {
  readonly learning: LearningWiringFragment & { readonly exam: LearningExamFragment };
  readonly examRunner: ExamRunner;
  /** The harness working directory the exam's spec-relative paths resolve
   *  against. */
  readonly cwd: string;
  /** The gap sink exam failures auto-log through (the same routing
   *  `log_knowledge_gap` uses: plan-store `[gap]` goals locally, Thredz
   *  tasks on the hosted backend). Absent → the report tells the model to
   *  log the gaps itself with `log_knowledge_gap`. */
  readonly logGap?: (gap: KnowledgeGap) => string | Promise<string>;
};

/**
 * The `run_exam` tool — EXAM mode's engine (§3.3, PR 17). Runs the
 * configured competency exam programmatically and logs every failed sample
 * as a knowledge gap (the flywheel edge: failures become the next study
 * pass's queue).
 *
 * Flags: `destructive: true` (it spends model budget and writes gaps —
 * audit-and-allow, like `log_knowledge_gap`; no justification gate: sitting
 * the exam is the honest path). `scope` stays internal — the model calls it
 * makes ride the provider adapters exactly like the `Task` sub-agent tool
 * (the established precedent for in-process session-running tools).
 */
export function createExamTool(opts: CreateExamToolOptions): RegisteredTool {
  const exam = opts.learning.exam;
  return buildTool({
    name: "run_exam",
    description:
      "Run the competency exam configured for this harness (learning.exam): every dataset question is answered from the wiki in a fresh session and graded by the configured graders. Failed samples are logged as knowledge gaps automatically. Returns the pass rate and every failed item verbatim.",
    inputSchema: runExamInput,
    concurrencySafe: false,
    readOnly: false,
    destructive: true,
    execute: async () => {
      const datasetPath = isAbsolute(exam.dataset) ? exam.dataset : join(opts.cwd, exam.dataset);
      const gradersPath = isAbsolute(exam.graders) ? exam.graders : join(opts.cwd, exam.graders);
      let report: ExamReport;
      try {
        report = await opts.examRunner({ datasetPath, gradersPath });
      } catch (err) {
        return `[run_exam error] ${(err as Error).message}`;
      }

      const failures = report.outcomes.filter((o) => !o.passed);
      const gapResults: string[] = [];
      if (opts.logGap !== undefined) {
        for (const failure of failures) {
          try {
            gapResults.push(
              await opts.logGap({
                topic: `exam failure ${failure.sampleId}: ${truncate(failure.input, 160)}`,
                detail: failure.rationale ?? failure.error ?? "failed the competency exam",
                tags: ["exam"],
                priority: "high",
              }),
            );
          } catch (err) {
            gapResults.push(`failed to log gap for ${failure.sampleId}: ${(err as Error).message}`);
          }
        }
      }

      const lines = [
        `exam: ${report.passed}/${report.total} passed (${(report.passRate * 100).toFixed(0)}%)${
          report.outDir !== undefined ? ` — artifacts under ${report.outDir}` : ""
        }`,
      ];
      if (failures.length > 0) {
        lines.push("", `failed items (${failures.length}):`);
        for (const failure of failures.slice(0, EXAM_REPORT_MAX_FAILURES)) {
          lines.push(
            `- ${failure.sampleId}: ${truncate(failure.input, 200)}`,
            `  verdict: ${failure.rationale ?? failure.error ?? "failed"}`,
          );
        }
        if (failures.length > EXAM_REPORT_MAX_FAILURES) {
          lines.push(`  … ${failures.length - EXAM_REPORT_MAX_FAILURES} more in the artifacts`);
        }
        lines.push(
          "",
          opts.logGap !== undefined
            ? `knowledge gaps logged automatically (${gapResults.length}) — the next study pass picks them up`
            : "no gap sink is wired — call log_knowledge_gap for each failure so the next study pass picks them up",
        );
      } else if (report.total > 0) {
        lines.push(
          "every sample passed — consider adding questions for newly mastered topics so the exam keeps pace",
        );
      }
      return lines.join("\n");
    },
  });
}

function truncate(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}
