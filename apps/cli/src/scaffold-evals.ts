/**
 * Item 13 — `crewhaus scaffold-evals` + `init --with-evals`: day-one eval
 * assets generated FROM the spec itself, so a fresh harness can run
 * `crewhaus eval` before its first user rating ever lands.
 *
 * Two generation modes share one pipeline:
 *
 * - **Model mode** (credentials for the spec's model — or an explicit
 *   `--model` — are present): ONE model call through the same model-router
 *   path `optimize --mutator claude` uses (`resolveModel`) asks for N
 *   realistic user prompts. The call itself lives in the CLI entry file
 *   behind an injectable seam; this module owns only the pure halves — the
 *   meta-prompt ({@link buildSampleGenerationPrompt}) and the tolerant
 *   response parser ({@link parseModelSampleInputs}) — so the model path is
 *   unit-testable without a provider.
 * - **Template mode** (offline, and ALWAYS for `init --with-evals` — init
 *   must never require credentials): {@link taskPhrasesFromInstructions}
 *   parses the instruction sentences into task phrases and
 *   {@link templateSampleInputs} wraps them in deterministic prompt
 *   templates. Same inputs → same outputs, byte for byte.
 *
 * Graders reuse feedback.ts's synthesis machinery as a spec-driven
 * front-end: online mode emits ONE `llm_judge` rubric with all five anchors
 * pre-filled from the spec's stated goals; offline mode emits the same safe
 * non-empty-answer floor grader `distill` falls back to
 * (`synthesizeGraders([])`). Either way exactly one grader is emitted —
 * stacking graders hard-ANDs their scores (the eval-grader `all(...)`
 * min-collapse), exactly the gotcha distill's output already documents.
 *
 * E47 adds a THIRD mode on top of both: `--template <family>` consumes a
 * `grader-template` manifest from the CLI's EMBEDDED eval-template library
 * instead of drafting assets from scratch ({@link applyEvalTemplate}). Those
 * families ship inside the binary, so there is nothing to fetch and no
 * signature to check; the manifest KIND is registry-signable, but no consumer
 * resolves a registry-hosted eval template yet. Template mode is offline by
 * construction — a template is static content, so no model call happens on
 * that path even with credentials in the environment.
 *
 * Kept in a side-effect-free module (the CLI entry file runs an argv switch
 * on import) mirroring `feedback.ts` / `datasets.ts`; all filesystem access
 * and the actual model call live in `apps/cli/src/index.ts`.
 */
import type { Sample } from "@crewhaus/eval-dataset";
import { parseSpec } from "@crewhaus/spec";
import { type GradersConfigObject, synthesizeGraders } from "./feedback";

/** Thrown on a spec this scaffold cannot derive eval assets from (and on
 *  invalid flag values). The CLI entry file routes it through `die()`;
 *  tests assert on `.message` without the process exiting. */
export class ScaffoldEvalsError extends Error {
  override readonly name = "ScaffoldEvalsError";
}

/** Default number of Sample stubs `scaffold-evals` generates. */
export const DEFAULT_SCAFFOLD_SAMPLES = 8;

/** Header for the scaffolded graders.yaml (threaded through feedback.ts's
 *  `gradersConfigToYaml`, replacing its distill-specific default). */
export const SCAFFOLD_GRADERS_HEADER: ReadonlyArray<string> = [
  "# Scaffolded by `crewhaus scaffold-evals` from the spec's stated goals.",
  "# Exactly one grader — stacking graders hard-ANDs their scores (see eval-grader `all`).",
];

/** The spec fields the scaffold generates from. */
export type ScaffoldInfo = {
  readonly name: string;
  readonly target: string;
  /** agent.instructions (cli/channel/… agent-block shapes), or the joined
   *  step instructions for workflow specs. */
  readonly instructions: string;
  /** The spec-level tools list, verbatim spec names (e.g. `webSearch`). */
  readonly tools: ReadonlyArray<string>;
  /** agent.model / workflow model — the model whose credentials decide
   *  online vs offline mode when `--model` is not given. */
  readonly model?: string;
  /** True when the spec already declares a `feedback:` block. */
  readonly hasFeedback: boolean;
};

/**
 * Tolerantly extract the scaffold source from a spec. Supports every shape
 * with an `agent.instructions` block (cli, channel, voice, browser, …) plus
 * workflow specs (step instructions joined — each step is a stated goal).
 * Throws ScaffoldEvalsError for shapes carrying no instructions at all;
 * parse failures propagate as SpecParseError (a CrewhausError) so the CLI
 * reports the real YAML problem.
 */
export function extractScaffoldInfo(yamlText: string): ScaffoldInfo {
  const spec = parseSpec(yamlText) as unknown as {
    name: string;
    target: string;
    agent?: { instructions?: string; model?: string };
    model?: string;
    tools?: string[];
    steps?: Array<{ instructions: string; tools?: string[] }>;
    feedback?: unknown;
  };
  const hasFeedback = spec.feedback !== undefined;
  if (typeof spec.agent?.instructions === "string") {
    return {
      name: spec.name,
      target: spec.target,
      instructions: spec.agent.instructions,
      tools: spec.tools ?? [],
      ...(spec.agent.model !== undefined ? { model: spec.agent.model } : {}),
      hasFeedback,
    };
  }
  if (Array.isArray(spec.steps) && spec.steps.length > 0) {
    const tools = [...new Set(spec.steps.flatMap((s) => s.tools ?? []))];
    return {
      name: spec.name,
      target: spec.target,
      instructions: spec.steps.map((s) => s.instructions).join("\n"),
      tools,
      ...(spec.model !== undefined ? { model: spec.model } : {}),
      hasFeedback,
    };
  }
  throw new ScaffoldEvalsError(
    `target "${spec.target}" carries no agent.instructions — scaffold-evals supports agent-block shapes (cli, channel, …) and workflow steps`,
  );
}

// -------- template mode: instructions → task phrases → prompts --------

/** Sentences that describe the agent rather than a task it performs. The
 *  `init` placeholder line is filtered too so `init --with-evals` on a fresh
 *  scaffold falls through to the generic stubs instead of echoing it. */
const PERSONA_PATTERNS: ReadonlyArray<RegExp> = [
  /^you are\b/i,
  /^your name\b/i,
  /^act as\b/i,
  /replace these instructions/i,
];

/** Constraint sentences ("never …", "do not …") are guardrails, not tasks —
 *  a deterministic template can't invert them into a useful probe. */
const CONSTRAINT_PATTERNS: ReadonlyArray<RegExp> = [/^never\b/i, /^do not\b/i, /^don'?t\b/i];

const MODAL_PREFIX = /^you (?:must|should|will|can|typically|generally|always)\s+/i;

/**
 * Parse instruction sentences into task phrases — the deterministic half of
 * sample-input generation. Persona/placeholder sentences and negative
 * constraints are dropped; "You must/should/will/can X" and bare "You X"
 * collapse to "X"; leading "Always" is stripped; short fragments (< 3 words)
 * are discarded. Order follows the instructions; duplicates collapse.
 */
const BULLET_PREFIX = /^(?:[-*•]|\d+[.)])\s+/;

/** Reflow instruction text into segments: YAML block scalars wrap sentences
 *  across lines, so plain continuation lines rejoin the previous one, while
 *  bullet markers and blank lines start a new segment. */
function reflowSegments(instructions: string): string[] {
  const segments: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current.trim() !== "") segments.push(current.trim());
    current = "";
  };
  for (const line of instructions.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      flush();
      continue;
    }
    if (BULLET_PREFIX.test(trimmed)) {
      flush();
      current = trimmed.replace(BULLET_PREFIX, "");
      continue;
    }
    current = current === "" ? trimmed : `${current} ${trimmed}`;
  }
  flush();
  return segments;
}

export function taskPhrasesFromInstructions(instructions: string): string[] {
  const phrases: string[] = [];
  const seen = new Set<string>();
  for (const segment of reflowSegments(instructions)) {
    for (const raw of segment.split(/(?<=[.!?])\s+/)) {
      let s = raw.replace(/\s+/g, " ").trim();
      if (s === "") continue;
      if (PERSONA_PATTERNS.some((p) => p.test(s))) continue;
      if (CONSTRAINT_PATTERNS.some((p) => p.test(s))) continue;
      s = s.replace(/^always\s+/i, "");
      s = s.replace(MODAL_PREFIX, "");
      s = s.replace(/^you\s+/i, "");
      s = s.replace(/[.!?]+$/, "").trim();
      if (s.split(" ").length < 3 || s.length < 12) continue;
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      phrases.push(s);
    }
  }
  return phrases;
}

const capitalize = (s: string): string => (s === "" ? s : s[0]?.toUpperCase() + s.slice(1));
const uncapitalize = (s: string): string => (s === "" ? s : s[0]?.toLowerCase() + s.slice(1));

const TASK_TEMPLATES: ReadonlyArray<(task: string) => string> = [
  (t) => `${capitalize(t)}.`,
  (t) => `Please ${uncapitalize(t)}.`,
  (t) => `Can you ${uncapitalize(t)}?`,
  (t) => `Here is a request for you: ${uncapitalize(t)}. Walk through it step by step.`,
];

const GENERIC_TEMPLATES: ReadonlyArray<(name: string) => string> = [
  (n) => `Handle a typical ${n} request end to end, stating any assumptions you make.`,
  (n) =>
    `A user brings you the most common task ${n} exists for. Complete it and explain your steps.`,
  () =>
    "The request is ambiguous. Ask one clarifying question, then answer for the most likely interpretation.",
  (n) =>
    `Summarize what you can do as ${n}, then demonstrate the most useful capability on a small example.`,
];

/**
 * Deterministic template mode: `n` sample-input prompts derived from the
 * instructions' task phrases (cycling phrase × template), or from generic
 * task-shaped stubs when no phrase survives the filter (e.g. the bare
 * `crewhaus init` placeholder spec). Pure — same info + n always yields the
 * identical list.
 */
export function templateSampleInputs(info: ScaffoldInfo, n: number): string[] {
  const phrases = taskPhrasesFromInstructions(info.instructions);
  const inputs: string[] = [];
  if (phrases.length > 0) {
    for (let i = 0; i < n; i += 1) {
      const phrase = phrases[i % phrases.length] as string;
      const tier = Math.floor(i / phrases.length);
      const template = TASK_TEMPLATES[tier % TASK_TEMPLATES.length] as (t: string) => string;
      const variation = tier >= TASK_TEMPLATES.length ? ` (variation ${tier})` : "";
      inputs.push(`${template(phrase)}${variation}`);
    }
    return inputs;
  }
  for (let i = 0; i < n; i += 1) {
    const template = GENERIC_TEMPLATES[i % GENERIC_TEMPLATES.length] as (name: string) => string;
    const tier = Math.floor(i / GENERIC_TEMPLATES.length);
    const variation = tier >= 1 ? ` (variation ${tier + 1})` : "";
    inputs.push(`${template(info.name)}${variation}`);
  }
  return inputs;
}

// -------- tool implication --------

/**
 * Spec tool name → the RUNTIME (PascalCase) tool name recorded in trace
 * events and expected by tool graders, plus the input keywords that
 * "obviously imply" the tool. Mirrors `loadToolMap` in index.ts /
 * target-cli's BUILTIN_TOOL_MAP — keep the name column in sync. Keyword
 * sets are deliberately conservative: a missed implication is a stub the
 * user fills in; a false one is a failing grader they must debug.
 */
const TOOL_IMPLICATIONS: Readonly<Record<string, { runtime: string; keywords: string[] }>> = {
  read: { runtime: "Read", keywords: ["read the file", "open the file", "file contents"] },
  write: { runtime: "Write", keywords: ["write a file", "create a file", "save to a file"] },
  edit: { runtime: "Edit", keywords: ["edit", "modify the file", "refactor"] },
  glob: { runtime: "Glob", keywords: ["find files", "list files", "matching files"] },
  grep: {
    runtime: "Grep",
    keywords: ["grep", "search the code", "search the codebase", "find references"],
  },
  bash: {
    runtime: "Bash",
    keywords: ["run the", "execute", "shell", "command", "install", "the tests"],
  },
  todoWrite: { runtime: "TodoWrite", keywords: ["todo", "task list", "plan out"] },
  webFetch: { runtime: "WebFetch", keywords: ["fetch", "url", "web page", "website"] },
  webSearch: {
    runtime: "WebSearch",
    keywords: ["search the web", "search online", "look up online", "web search", "latest news"],
  },
  readImage: { runtime: "ReadImage", keywords: ["image", "screenshot", "photo"] },
  fetch: { runtime: "Fetch", keywords: ["fetch", "http", "api", "endpoint", "url"] },
  imageGenerate: {
    runtime: "ImageGenerate",
    keywords: ["generate an image", "draw", "illustration"],
  },
  ingestDocument: { runtime: "IngestDocument", keywords: ["pdf", "document", "docx"] },
};

function keywordImplied(input: string, keyword: string): boolean {
  // Word-boundary match so "read" can't fire inside "already". Keywords are
  // hand-authored lowercase alphanumeric phrases, so no escaping is needed.
  return new RegExp(`\\b${keyword}\\b`, "i").test(input);
}

/**
 * The runtime tool names a sample input obviously implies, drawn ONLY from
 * the spec's own tools list. Builtin spec names map to their runtime
 * PascalCase form (`webSearch` → `WebSearch` — the casing tool graders
 * compare against); unknown/custom tools (e.g. `mcp__*`) are implied only
 * when the input mentions them verbatim and pass through unchanged.
 */
export function impliedTools(input: string, specTools: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  for (const tool of specTools) {
    const known = TOOL_IMPLICATIONS[tool];
    if (known !== undefined) {
      if (known.keywords.some((k) => keywordImplied(input, k))) out.push(known.runtime);
    } else if (input.toLowerCase().includes(tool.toLowerCase())) {
      out.push(tool);
    }
  }
  return [...new Set(out)];
}

// -------- samples --------

export type ScaffoldGenerator = "template" | "model";

/**
 * Wrap generated inputs into SampleSchema-valid stubs: zero-padded stable
 * ids, `expected_tools` where the spec's tools list is obviously implied,
 * and metadata marking them as scaffold stubs to edit.
 */
export function buildScaffoldSamples(
  info: ScaffoldInfo,
  inputs: ReadonlyArray<string>,
  generator: ScaffoldGenerator,
): Sample[] {
  const width = Math.max(2, String(inputs.length).length);
  return inputs.map((input, i) => {
    const tools = impliedTools(input, info.tools);
    return {
      id: `scaffold_${String(i + 1).padStart(width, "0")}`,
      input,
      ...(tools.length > 0 ? { expected_tools: tools } : {}),
      metadata: {
        source: "scaffold-evals",
        generator,
        note: "starter stub — edit into a real task (and add expected_output for gold answers)",
      },
    };
  });
}

// -------- graders --------

/** Clip + quote-strip a goals summary for a rubric description (mirrors
 *  feedback.ts's summarizeComments bounds). */
function summarizeGoals(goals: ReadonlyArray<string>): string | undefined {
  const cleaned = goals.map((g) => g.trim().replace(/'/g, "")).filter((g) => g !== "");
  if (cleaned.length === 0) return undefined;
  const joined = cleaned.slice(0, 4).join("; ");
  return joined.length > 400 ? `${joined.slice(0, 400)}…` : joined;
}

/**
 * The starter graders config — a spec-driven front-end over feedback.ts's
 * synthesis machinery, single-grader in both modes (hard-AND-safe, exactly
 * like distill emits):
 *
 * - `online: true` → one `llm_judge` rubric whose five anchors are
 *   pre-filled against the spec's stated goals (the task phrases parsed
 *   from its instructions). Deterministic text — no model call is needed to
 *   WRITE the rubric; credentials are needed to RUN it, which is why this
 *   mode keys on their presence.
 * - `online: false` → `synthesizeGraders([])`'s safe non-empty-answer floor
 *   grader, so a credential-free `crewhaus eval` still runs end to end.
 */
export function buildScaffoldGraders(
  info: ScaffoldInfo,
  opts: { online: boolean; model?: string },
): GradersConfigObject {
  if (!opts.online) {
    // The floor path of feedback.ts's synthesis (no positive turns yet); the
    // scaffold prints its own offline note, so the distill-flavoured warning
    // is discarded.
    return synthesizeGraders([], []);
  }
  const goals = summarizeGoals(taskPhrasesFromInstructions(info.instructions));
  const goalsNote =
    goals !== undefined
      ? `: '${goals}'`
      : ` of the "${info.name}" harness (see its crewhaus.yaml instructions)`;
  return {
    graders: [
      {
        name: "spec_goal_alignment",
        type: "llm_judge",
        rubric: {
          criteria: [
            {
              name: "spec_goal_alignment",
              description: `Judge how well the response fulfils the spec's stated goals${goalsNote}. Score strictly against the anchors.`,
              anchors: {
                "1": "Off-task or contradicts the stated goals; ignores the harness's purpose.",
                "2": "Barely on-task; most of the stated goals are unmet.",
                "3": "Partially fulfils the stated goals; noticeable gaps or constraint violations.",
                "4": "Fulfils the stated goals with only minor gaps.",
                "5": "Fully fulfils the stated goals and respects the instructions' constraints.",
              },
            },
          ],
          passing_score: 3,
        },
        ...(opts.model !== undefined ? { model: opts.model } : {}),
      },
    ],
  };
}

// -------- E47: template mode (eval-template family library) --------

/** A seed sample carried inside a `grader-template` manifest. Structurally
 *  the template-registry's `EvalTemplateSample`, re-declared here so this
 *  module keeps its pure-function shape (the CLI passes the manifest's
 *  block straight in). */
export type TemplateSeedSample = {
  readonly id: string;
  readonly input: string;
  readonly expected_output?: string;
  readonly expected_tools?: ReadonlyArray<string>;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export type TemplateEvalAssets = {
  readonly gradersYaml: string;
  readonly notes?: string;
  readonly seedDataset?: ReadonlyArray<TemplateSeedSample>;
};

export type TemplateApplication = {
  /** graders.yaml text to write: the template's own, with one provenance
   *  header prepended. The rubric body is byte-for-byte the template's — a
   *  reviewer diffing against the published family must see no edits. */
  readonly gradersYaml: string;
  readonly samples: Sample[];
  /** How many samples came from the template's seed dataset … */
  readonly seedCount: number;
  /** … and how many were topped up from the spec's own instructions. */
  readonly stubCount: number;
  /** True when `--samples N` was capped at the seed count because the
   *  family's graders need a gold answer (see `requiresGold`). The CLI
   *  prints the reason — a silently short dataset would look like a bug. */
  readonly goldCapped: boolean;
};

/**
 * Apply a grader-template family to a spec: the family's graders.yaml is
 * copied verbatim (it is the reviewed artifact — the whole point of a
 * template is that its anchors were written once, carefully), and its seed
 * dataset is used as the starting samples, topped up to `n` with the
 * deterministic spec-derived stubs when the family ships fewer.
 *
 * `requiresGold` SUPPRESSES that top-up: a family whose graders need
 * `expected_output` on every sample (the `classify` family's
 * `expected_contains`, any `nlg.*`/`semantic.similarity` pack) would grade a
 * generated stub — which never carries a gold — as an automatic FAIL, and
 * `crewhaus eval`'s preflight only REFUSES a wholly gold-less dataset, so a
 * topped-up one would run, spend, and score a ceiling of
 * `seeds / --samples`. Fewer real samples beat a dataset that is broken by
 * construction; the caller reports the cap via {@link
 * TemplateApplication.goldCapped}.
 *
 * Pure and offline: same inputs → same bytes, no credentials, no model call.
 * Seed samples keep their own ids and metadata, plus the template provenance
 * (`template` / `template_version`) so a later `dataset audit` can tell
 * generic starter rows from real domain data.
 */
export function applyEvalTemplate(opts: {
  readonly info: ScaffoldInfo;
  readonly family: string;
  readonly version: string;
  readonly assets: TemplateEvalAssets;
  readonly samples: number;
  /** True when every grader in `assets.gradersYaml` needs a gold answer —
   *  computed by the caller with the SAME predicate `dataset lint` and the
   *  eval preflight use (`graderNeedsGold`), never a second heuristic. */
  readonly requiresGold?: boolean;
}): TemplateApplication {
  const seeds = (opts.assets.seedDataset ?? []).slice(0, Math.max(0, opts.samples));
  const seedSamples: Sample[] = seeds.map((s) => ({
    id: s.id,
    input: s.input,
    ...(s.expected_output !== undefined ? { expected_output: s.expected_output } : {}),
    ...(s.expected_tools !== undefined ? { expected_tools: [...s.expected_tools] } : {}),
    metadata: {
      ...(s.metadata ?? {}),
      template: opts.family,
      template_version: opts.version,
    },
  }));
  const requestedTopUp = Math.max(0, opts.samples - seedSamples.length);
  const goldCapped = opts.requiresGold === true && requestedTopUp > 0;
  const remaining = goldCapped ? 0 : requestedTopUp;
  const stubs =
    remaining > 0
      ? buildScaffoldSamples(opts.info, templateSampleInputs(opts.info, remaining), "template").map(
          (s) => ({
            ...s,
            metadata: { ...(s.metadata ?? {}), template: opts.family },
          }),
        )
      : [];
  // Seed ids are template-authored and stub ids are `scaffold_NN` — they
  // cannot collide today, but a duplicate id would corrupt the run's
  // per-sample artifact dirs, so the guard is cheap insurance.
  const seen = new Set(seedSamples.map((s) => s.id));
  const deduped: Sample[] = [...seedSamples];
  for (const stub of stubs) {
    let id = stub.id;
    let n = 2;
    while (seen.has(id)) {
      id = `${stub.id}_${n}`;
      n += 1;
    }
    seen.add(id);
    deduped.push({ ...stub, id });
  }
  return {
    gradersYaml: `${templateGradersHeader(opts.family, opts.version, opts.info.name).join("\n")}\n${opts.assets.gradersYaml}`,
    samples: deduped,
    seedCount: seedSamples.length,
    stubCount: deduped.length - seedSamples.length,
    goldCapped,
  };
}

/** The note printed when {@link applyEvalTemplate} capped the sample count:
 *  it must say WHY, or "I asked for 8 and got 3" reads as a bug. */
export function goldCapNote(family: string, seedCount: number, requested: number): string {
  return [
    `--samples ${requested} capped at the ${seedCount} gold-carrying seed(s): every grader in the`,
    `    "${family}" family needs an expected_output, and a generated stub has none — topping up`,
    "    would write samples that auto-fail. Add rows with your own gold answers instead.",
  ].join("\n");
}

/** The provenance header prepended to a copied family graders.yaml. */
export function templateGradersHeader(
  family: string,
  version: string,
  specName: string,
): ReadonlyArray<string> {
  return [
    `# Copied from the eval-template family "${family}"@${version} by`,
    `# \`crewhaus scaffold-evals --template ${family}\` for the "${specName}" harness.`,
    "# The rubric below is the family's, unedited — review it against YOUR",
    "# definition of a good answer before gating anything on it.",
  ];
}

/** The refusal for an unknown `--template <family>`: never guess, always
 *  list what is available (the gallery IS the discovery surface). */
export function unknownTemplateMessage(
  requested: string,
  catalog: ReadonlyArray<{ readonly name: string; readonly description: string }>,
): string {
  const lines = [`unknown --template "${requested}" — available eval-template families:`];
  for (const entry of catalog) lines.push(`  ${entry.name.padEnd(12)}${entry.description}`);
  lines.push("run without --template for assets derived from the spec itself");
  return lines.join("\n");
}

// -------- model mode (pure halves; the call lives in index.ts) --------

/** System block for the one-shot sample-input generation call. */
export const SCAFFOLD_GENERATION_SYSTEM = `You write starter eval datasets for AI agent harnesses. You will receive an agent's instructions and tool list. Produce realistic, distinct user prompts that exercise the agent's stated tasks — including at least one edge case (ambiguous, adversarial, or out-of-scope request).

Hard rules:
- Output exactly one JSON object: {"inputs": ["...", "..."]} with the requested number of entries. No text outside the JSON.
- Each entry is one user prompt, phrased as a real user would type it.
- Do NOT include expected answers, numbering, or commentary.`;

const MAX_INSTRUCTIONS_IN_PROMPT = 6000;

/** The user message for the generation call — the spec's instructions
 *  (clipped) + tools + the requested sample count. */
export function buildSampleGenerationPrompt(info: ScaffoldInfo, n: number): string {
  const instructions =
    info.instructions.length > MAX_INSTRUCTIONS_IN_PROMPT
      ? `${info.instructions.slice(0, MAX_INSTRUCTIONS_IN_PROMPT)}…`
      : info.instructions;
  const tools = info.tools.length > 0 ? info.tools.join(", ") : "(none declared)";
  return [
    `HARNESS: ${info.name} (target: ${info.target})`,
    "",
    "AGENT INSTRUCTIONS:",
    instructions,
    "",
    `TOOLS: ${tools}`,
    "",
    `Produce exactly ${n} eval input prompts as {"inputs": [...]}.`,
  ].join("\n");
}

/**
 * Tolerant parse of the generation response: first balanced `{…}` substring
 * (```json fences and leading prose tolerated), `inputs` must be an array of
 * non-empty strings. Returns the trimmed, deduped prompts clipped to `max`;
 * `[]` on ANY failure — the caller falls back to (or tops up from) the
 * deterministic template.
 */
export function parseModelSampleInputs(raw: string, max: number): string[] {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return [];
  }
  const inputs = (parsed as { inputs?: unknown }).inputs;
  if (!Array.isArray(inputs)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of inputs) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

/** Top up `primary` (model inputs) from `fallback` (template inputs) to `n`
 *  entries, skipping duplicates — a short model response still yields a full
 *  dataset. */
export function mergeInputs(
  primary: ReadonlyArray<string>,
  fallback: ReadonlyArray<string>,
  n: number,
): string[] {
  const out = primary.slice(0, n);
  const seen = new Set(out);
  for (const f of fallback) {
    if (out.length >= n) break;
    if (seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  return out;
}

// -------- overwrite guard + suggestions --------

/**
 * Never overwrite existing eval assets without `--force`. Returns the error
 * message when blocked (the CLI routes it through `die`), undefined when the
 * write may proceed. `exists` is injected so the guard is unit-testable.
 */
export function checkNoOverwrite(
  paths: ReadonlyArray<string>,
  exists: (path: string) => boolean,
  force: boolean,
): string | undefined {
  if (force) return undefined;
  const existing = paths.filter(exists);
  if (existing.length === 0) return undefined;
  return `refusing to overwrite existing eval asset(s): ${existing.join(", ")} — re-run with --force to replace them`;
}

/** The `feedback:` block suggestion printed (never auto-applied) when the
 *  spec lacks one — ratings are what upgrade these scaffolds into distilled
 *  datasets later. */
export function feedbackBlockSuggestion(): string {
  return ["feedback:", "  modality: binary", "  autoDistill: true"].join("\n");
}
