import { lower } from "@crewhaus/compiler";
import { CrewhausError } from "@crewhaus/errors";
import { type Spec, parseSpec } from "@crewhaus/spec";
import { isMap, isScalar, parseAllDocuments, parseDocument } from "yaml";
import { auditProvability } from "./lint";

/**
 * Item 39 / v0.3.0 §2.9 — `crewhaus init --interactive`. Folds the demos
 * harness-designer pattern (an agent that interviews the user in plain
 * English and emits a validated crewhaus.yaml) into core. Design commitments:
 *
 *   1. NO dependency on the demos repo. The shape-decision guidance is
 *      bundled inline here ({@link SHAPE_GUIDANCE} / {@link buildInterviewSystemPrompt}),
 *      and validation is `parseSpec` called in-process — the single source of
 *      truth for what compiles.
 *   2. Every draft the model emits is validated against the LIVE Zod union via
 *      `parseSpec`, and on a structured error the error text goes back into
 *      the conversation as a tool error the model fixes in-context. So
 *      `init --interactive` cannot emit a spec that won't parse.
 *   3. The interview is a REAL conversation (v0.3.0 PR 18): a `runChatLoop`
 *      session with `ask_user` + `emit_spec` and NO forced toolChoice —
 *      persisted, ledger-protected, and resumable. The conversational loop
 *      lives in `init-conversation.ts`; this module keeps the pure,
 *      side-effect-free pieces: the shape catalog, the interviewer system
 *      prompt, the tool contracts, and the credential-free fallback
 *      ({@link buildScriptedSpec} over stdin answers). The CLI wrapper in
 *      `index.ts` owns all I/O.
 */

/** The fourteen target shapes, with the one-line "pick me when" guidance the
 *  interviewer uses. Bundled inline so core never reaches into the demos repo. */
export const SHAPE_GUIDANCE: ReadonlyArray<{ target: string; when: string }> = [
  {
    target: "cli",
    when: "a single interactive chat/coding agent run from a terminal (the default)",
  },
  { target: "workflow", when: "a fixed sequence of steps, each a prompt, threaded in order" },
  { target: "channel", when: "a long-running bot that answers Slack/Telegram/Discord messages" },
  { target: "graph", when: "a stateful DAG of LLM nodes with human-in-the-loop pause points" },
  { target: "managed", when: "a multi-tenant gateway daemon with per-tenant token budgets" },
  {
    target: "pipeline",
    when: "RAG: index documents into a vector store, then chat with retrieval",
  },
  {
    target: "crew",
    when: "multiple named roles that hand off to each other (router or match rules)",
  },
  { target: "research", when: "decompose a goal into sub-questions and write a cited report" },
  { target: "batch", when: "a queue worker that runs the agent on each job with idempotency" },
  { target: "voice", when: "a realtime audio agent (OpenAI realtime / Vapi) over telephony" },
  { target: "browser", when: "a computer-use agent that drives a real browser" },
  { target: "eval", when: "run an agent against a dataset and grade it (not a live agent)" },
  { target: "onchain", when: "an event-driven daemon that reacts to on-chain triggers with txns" },
  { target: "onchain-game", when: "a perceive-act loop against a game contract" },
];

/** Shapes the scripted (no-credentials) fallback can emit end-to-end without
 *  additional required blocks the user would have to hand-author. cli is the
 *  overwhelmingly common case; workflow + research + eval are the other simple
 *  single-agent shapes whose minimal spec is fully derivable from a few answers. */
export const SCRIPTED_SHAPES = ["cli", "workflow", "research"] as const;
export type ScriptedShape = (typeof SCRIPTED_SHAPES)[number];

export function isScriptedShape(s: string): s is ScriptedShape {
  return (SCRIPTED_SHAPES as readonly string[]).includes(s);
}

/**
 * The interviewer's system prompt — a focused variant of the `continuity`
 * discipline (v0.3.0 §2.9) on top of the shape catalog + the hard rules the
 * emitted YAML must obey (single-line-safe names, the `$UPPER_SNAKE_CASE`
 * secret convention, no `permissions.mode: bypass`). Kept as a builder so a
 * test can assert the guidance is present without shipping a golden file.
 *
 * `opts.provability` (0.8.0 §11) is `init --interactive --provability <rung>`:
 * the user answered the proof question on the command line, so the
 * interviewer is told the answer instead of being told to ask — a question
 * whose answer the flag would overwrite is a turn the user pays for and
 * loses. {@link setProvability} still applies the flag to whatever the
 * interview emits.
 */
export function buildInterviewSystemPrompt(
  opts: { readonly provability?: InitProvabilityLevel } = {},
): string {
  const shapes = SHAPE_GUIDANCE.map((s) => `  - ${s.target}: ${s.when}`).join("\n");
  return [
    "You are the CrewHaus harness designer, running a real multi-turn interview to",
    "understand what agent the user wants to build and emit ONE valid crewhaus.yaml.",
    "Two interview tools drive the conversation:",
    "",
    "  - `ask_user`: pose ONE focused clarifying question. After calling it, end your",
    "    turn — the user's answer arrives as the next user message. Never bundle",
    "    several questions into one call, and never call it twice in one turn.",
    "  - `emit_spec`: submit the complete crewhaus.yaml as the `yaml` argument. The",
    "    validator replies in the tool result; on an error, FIX exactly that error and",
    "    re-emit in this same conversation — do not restart the interview.",
    "",
    "Requirements discipline (binding, every turn):",
    "  - Turn 1: extract EVERY requirement from the user's opening message into",
    "    verbatim REQ entries (REQ-001, REQ-002, …) — quote the user's exact words,",
    "    never paraphrase — pin them with FocusWrite, and ECHO them back:",
    '    "Got it. Requirements so far: REQ-001 …; open questions: …".',
    '  - Each later answer: pin it, confirm the REQ ("REQ-002 confirmed"), and keep',
    "    the echo current.",
    "  - NEVER re-ask a requirement recorded as confirmed. Check the",
    "    <requirements_ledger> block, <current_plan>, and FocusRead before asking",
    "    anything — a confirmed REQ is already answered, in the user's own words.",
    "  - Before calling emit_spec: read the ledger, verify each REQ maps to a spec",
    "    field, and list the mapping in your reply, one line per REQ, using the →",
    '    arrow: REQ-001 "…" → name',
    '  - On a resumed session, your FIRST reply must start with "Resuming: N',
    '    requirements confirmed, M open questions", computed from the ledger and',
    "    focus — then continue where the interview stopped, without re-asking.",
    "",
    "Pick exactly ONE target shape:",
    shapes,
    "",
    "Hard rules the YAML MUST obey (the validator rejects violations):",
    '  - `name` and every role/step/node name: letters, digits, spaces, and "_ . - :" only',
    "    (no newlines, quotes, slashes, or comment/template delimiters).",
    "  - Secrets (tokens, API keys, channel credentials) MUST be written as a $UPPER_SNAKE_CASE",
    "    environment reference (e.g. $SLACK_BOT_TOKEN), NEVER a literal secret value.",
    "  - Do NOT set `permissions.mode: bypass` — it is rejected; use default/plan/auto.",
    "  - For a cli target: top-level `name`, `target: cli`, and an `agent` block with",
    "    `model` and `instructions`. Tools go in a top-level `tools:` list of names.",
    "  - Keep the spec minimal — only the blocks the user actually asked for.",
    "",
    ...proofGuidance(opts.provability),
  ].join("\n");
}

/** The interviewer's proof paragraph: the ONE question, or the answer the flag already gave. */
function proofGuidance(level: InitProvabilityLevel | undefined): string[] {
  if (level !== undefined) {
    return [
      `Proof: the user already chose \`${level}\` (${levelLine(level)}) with --provability.`,
      "Do NOT ask how much proof answers should carry.",
      level === "off"
        ? "  Write no `provability:` key (absent is off)."
        : `  For a cli, channel, managed or research target, write \`provability: ${level}\` at the top level.`,
    ];
  }
  return [
    "Proof (ONE question, only for a cli, channel, managed or research target): ask how much",
    "proof answers should carry, and write the answer as a top-level `provability:` rung:",
    ...PROVABILITY_LEVEL_LINES.map(({ level, line }) => `  - ${level}: ${line}`),
    "  `off` means omit the key. A research target defaults to `provability: cited`.",
  ];
}

/** The tool the interviewer calls to submit a candidate spec — the SAME
 *  contract the pre-0.3.0 single-shot interview used (`{ yaml: string }`).
 *  Exported so tests can pin the schema and `init-conversation.ts` builds
 *  the RegisteredTool from it. */
export const EMIT_SPEC_TOOL = {
  name: "emit_spec",
  description:
    "Submit the complete crewhaus.yaml as a single YAML string. The validator parses it " +
    "immediately; if it fails you will be told the exact error and must re-emit a corrected spec.",
  input_schema: {
    type: "object" as const,
    properties: {
      yaml: { type: "string" as const, description: "The full crewhaus.yaml document." },
    },
    required: ["yaml"],
  },
};

/** v0.3.0 §2.9 — the interviewer's clarifying-question tool. The loop
 *  surfaces the question on the terminal; the user's answer arrives as the
 *  next user message through the multi-turn REPL (nothing typed is ever
 *  discarded — the exact failure the single-shot path had). */
export const ASK_USER_TOOL = {
  name: "ask_user",
  description:
    "Ask the user ONE focused clarifying question. The question is shown on the terminal; " +
    "end your turn after calling this — the user's answer arrives as the next user message. " +
    "Check the requirements ledger first: never re-ask a confirmed requirement.",
  input_schema: {
    type: "object" as const,
    properties: {
      question: { type: "string" as const, description: "The single question to ask." },
    },
    required: ["question"],
  },
};

/** The answers the scripted (no-credentials) questionnaire collects. Every
 *  field is a plain string/list so the CLI can gather them over stdin and a
 *  test can drive {@link buildScriptedSpec} directly. */
export type ScriptedAnswers = {
  readonly name: string;
  readonly shape: ScriptedShape;
  readonly model: string;
  readonly instructions: string;
  /** Tool names for cli/research; ignored for workflow. */
  readonly tools?: readonly string[];
  /** The research goal (research shape only). */
  readonly goal?: string;
  /**
   * 0.8.0 §11 — the proof floor, for the shapes that carry the block
   * ({@link carriesProvability}). Absent: none on cli, `cited` on research
   * (the researcher template's default).
   */
  readonly provability?: InitProvabilityLevel;
};

/** YAML-quote a scalar that might contain special characters. The scripted
 *  answers are user free-text, so a name/model with a colon or `#` must be
 *  double-quoted to parse. Instructions use a block scalar (see below). */
function yamlScalar(value: string): string {
  // Safe bareword: no YAML-significant leading/embedded chars.
  if (/^[A-Za-z0-9_][\w .-]*$/.test(value) && !/[:#]/.test(value)) return value;
  return JSON.stringify(value); // JSON string is valid YAML double-quoted scalar.
}

/** Render a possibly-multiline instructions string as a literal block scalar. */
function yamlBlock(key: string, value: string, indent: string): string {
  const lines = value.split("\n");
  const body = lines.map((l) => `${indent}  ${l}`).join("\n");
  return `${indent}${key}: |\n${body}`;
}

/**
 * Build a minimal, VALIDATED crewhaus.yaml from scripted answers — the
 * credential-free degrade path. Emits the spec text, runs it through
 * `parseSpec` (so even the scripted path can't produce an invalid spec), and
 * returns both. Throws `SpecParseError` if the answers somehow don't validate
 * (e.g. an unsafe name), which the CLI surfaces so the user can retry the
 * offending answer.
 */
export function buildScriptedSpec(answers: ScriptedAnswers): { yaml: string; spec: Spec } {
  if (!carriesProvability(answers.shape) && answers.provability !== undefined) {
    // parseSpec would refuse the key too, but by schema path; say it plainly.
    throw new InitProvabilityError(provabilityShapeRefusal(answers.shape));
  }
  let yaml: string;
  if (answers.shape === "workflow") {
    yaml = [
      `name: ${yamlScalar(answers.name)}`,
      "target: workflow",
      `model: ${yamlScalar(answers.model)}`,
      "steps:",
      `  - name: ${yamlScalar(answers.name)}-step`,
      // The step's `instructions:` is nested one list-item deep, so the block
      // scalar indents at 4 spaces (2 for the list item + 2 for the map key).
      yamlBlock("instructions", answers.instructions, "    "),
      "",
    ].join("\n");
  } else if (answers.shape === "research") {
    const toolsBlock =
      answers.tools && answers.tools.length > 0
        ? `tools:\n${answers.tools.map((t) => `  - ${yamlScalar(t)}`).join("\n")}\n`
        : "";
    yaml = [
      `name: ${yamlScalar(answers.name)}`,
      "target: research",
      "agent:",
      `  model: ${yamlScalar(answers.model)}`,
      yamlBlock("instructions", answers.instructions, "  "),
      `goal: ${yamlScalar(answers.goal ?? answers.instructions)}`,
      toolsBlock.trimEnd(),
      // The researcher template ships with the `cited` floor (design §11).
      provabilitySection(answers.provability ?? RESEARCH_DEFAULT_PROVABILITY),
      "",
    ]
      .filter((l) => l !== "")
      .join("\n");
  } else {
    // cli (default)
    const toolsBlock =
      answers.tools && answers.tools.length > 0
        ? `tools:\n${answers.tools.map((t) => `  - ${yamlScalar(t)}`).join("\n")}\n`
        : "";
    yaml = [
      `name: ${yamlScalar(answers.name)}`,
      "target: cli",
      "agent:",
      `  model: ${yamlScalar(answers.model)}`,
      yamlBlock("instructions", answers.instructions, "  "),
      toolsBlock.trimEnd(),
      answers.provability !== undefined ? provabilitySection(answers.provability) : "",
      "",
    ]
      .filter((l) => l !== "")
      .join("\n");
  }
  const spec = parseSpec(yaml);
  return { yaml, spec };
}

// ---------------------------------------------------------------------------
// 0.6.0 §9.2 — `crewhaus init --hybrid`
// ---------------------------------------------------------------------------

/**
 * 0.6.0 §9.2 — the fast/strong pair `init --hybrid` writes into the registry.
 *
 * Both members come from ONE provider on purpose. A hybrid setup that spans
 * providers needs a second credential and ships transcript content to a
 * second vendor; that is a decision a person makes, not a default a scaffold
 * takes. The scaffold's job is to make the shape obvious, not to be clever.
 */
export type HybridPair = {
  readonly fast: string;
  readonly strong: string;
};

export type HybridScaffoldAnswers = ScriptedAnswers & {
  /** The pair the registry declares. */
  readonly pair: HybridPair;
};

/**
 * The three-line registry plus the cascade, WITH the comments that explain
 * each line. The comments are the deliverable as much as the keys are: a
 * spec whose reader cannot say what `escalate_to` does is a spec nobody will
 * dare change.
 *
 * `cheap drafts → a stronger checker grades → the strong model redoes it on
 * failure` is §1's motivating scenario, so the scaffold writes exactly that
 * and nothing more: no learned policy (there is no scoreboard yet), no
 * shadow lane (there is nothing to audition against), no rules (there is no
 * traffic to write one from).
 */
export function renderHybridBlocks(pair: HybridPair): string {
  return `# The model registry: per-model settings declared ONCE and referenced as
# \`$name\` from any model slot. Slot-local keys override a profile field by
# field; \`tags\` are the routing identity, so keep them meaningful.
models:
  fast:
    model: ${yamlScalar(pair.fast)}
    tags: [cheap]
  strong:
    model: ${yamlScalar(pair.strong)}
    tags: [strong]

`;
}

/** The `agent:` body `--hybrid` writes: a pool plus the cascade. */
export function renderHybridAgentBody(instructions: string, indent = "  "): string {
  return `${indent}model: $fast
${yamlBlock("instructions", instructions, indent)}
${indent}model_pool:
${indent}  # The roster. Every arm is a \`models:\` profile, so the scoreboard
${indent}  # records under the PROFILE name and survives a model-id change.
${indent}  candidates:
${indent}    - { model: $fast,   tags: [cheap] }
${indent}    - { model: $strong, tags: [strong] }
${indent}  # \`heuristic\` routes on deterministic per-turn signals. Move to
${indent}  # \`learned\` once every arm has samples — \`crewhaus route propose\`
${indent}  # tells you when, and eval-gates the flip.
${indent}  policy: heuristic
${indent}  strategy:
${indent}    # The cascade: the cheap arm DRAFTS, the judge below grades it,
${indent}    # and a failing grade re-runs the turn on the strong arm.
${indent}    cascade: { draft: cheap, escalate_to: strong, clean_prompt: true }
${indent}    max_escalations: 1
# The judge that grades each draft. \`on_fail: escalate\` is what turns the
# grade into the cascade's trigger; \`strongest\` resolves to the strong arm.
#
# \`allow_self_judge\` is the honest part: in a two-arm cascade the checker IS
# the strong arm, so the judge grades a model it also serves as. The compiler
# calls that a measurement-integrity hazard and warns unless you say you meant
# it — which here you do. Declare a THIRD profile and point the judge at it
# the moment the grade is worth trusting on its own (an eval gate, a report).
evaluation:
  grader: { type: llm_judge, criteria: "Does the answer fully and correctly address the user's request?", model: strongest }
  threshold: 0.7
  on_fail: escalate
  allow_self_judge: true
`;
}

/**
 * Build a hybrid `target: cli` spec: the registry, a two-arm pool, the
 * cascade, and the judge that drives it. Validated through `parseSpec` like
 * every other scaffold, so `init --hybrid` cannot emit a spec that will not
 * compile.
 */
export function buildHybridSpec(answers: HybridScaffoldAnswers): { yaml: string; spec: Spec } {
  const toolsBlock =
    answers.tools && answers.tools.length > 0
      ? `tools:\n${answers.tools.map((t) => `  - ${yamlScalar(t)}`).join("\n")}\n`
      : "";
  const yaml = [
    `name: ${yamlScalar(answers.name)}`,
    "target: cli",
    "",
    renderHybridBlocks(answers.pair).trimEnd(),
    "",
    "agent:",
    renderHybridAgentBody(answers.instructions).trimEnd(),
    toolsBlock.trimEnd(),
    answers.provability !== undefined ? provabilitySection(answers.provability) : "",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
  const spec = parseSpec(yaml);
  return { yaml, spec };
}

/**
 * The ONE question `init --interactive` asks about hybrid setups (§9.2).
 * One, deliberately: the answer that matters is "do you want a cheap worker
 * with a strong checker", and everything else follows from the pricing table.
 */
export const HYBRID_INTERVIEW_QUESTION =
  "run cheap drafts with a stronger model checking them (a hybrid cascade)? [y/N]: ";

/** Is a free-text answer to {@link HYBRID_INTERVIEW_QUESTION} a yes? */
export function isHybridYes(answer: string): boolean {
  return /^\s*(y|yes)\s*$/i.test(answer);
}

// ---------------------------------------------------------------------------
// 0.8.0 §11 — `crewhaus init --provability <rung>` and the proof question
// ---------------------------------------------------------------------------

/**
 * The rungs `init` accepts: the spec's own `off | cited | grounded | checked |
 * proven` (design §2), lowest first. `off` is a real answer — on research it
 * turns the template's `cited` default off.
 */
export const INIT_PROVABILITY_LEVELS = ["off", "cited", "grounded", "checked", "proven"] as const;
export type InitProvabilityLevel = (typeof INIT_PROVABILITY_LEVELS)[number];

export function isInitProvabilityLevel(s: string): s is InitProvabilityLevel {
  return (INIT_PROVABILITY_LEVELS as readonly string[]).includes(s);
}

/** The floor the researcher template ships with (design §11, §16). */
export const RESEARCH_DEFAULT_PROVABILITY: InitProvabilityLevel = "cited";

/**
 * Each rung in one line — what an answer must carry for the gate to serve it.
 * Shared by the scripted question, the interviewer's prompt and the comment
 * the scaffold writes, so the three never describe a rung differently.
 */
export const PROVABILITY_LEVEL_LINES: ReadonlyArray<{
  readonly level: InitProvabilityLevel;
  readonly line: string;
}> = [
  { level: "off", line: "no proof gate" },
  { level: "cited", line: "every claim names a source: a URL, a doi: or a workspace file" },
  { level: "grounded", line: "the cited source was read this session and holds the claim" },
  { level: "checked", line: "figures come from a tool result the gate can re-run" },
  { level: "proven", line: "a proof checker accepted a proof of the claim" },
];

function levelLine(level: InitProvabilityLevel): string {
  return PROVABILITY_LEVEL_LINES.find((l) => l.level === level)?.line ?? "";
}

/** The shapes `init` scaffolds that carry a `provability:` block (design §3). */
export function carriesProvability(shape: ScriptedShape): boolean {
  return shape === "cli" || shape === "research";
}

/** The targets whose proof gate is wired (design §8) — the ones `--provability` writes to. */
const GATED_TARGETS: ReadonlySet<string> = new Set(["cli", "channel", "managed", "research"]);

/**
 * Why a shape cannot take `--provability`. Crew is the one shape that
 * ACCEPTS the key without gating on it (design §3/§8: carried, with an
 * `accepted-but-unwired` compile warning; the synthesis-turn seam is
 * deferred, §12) — so it says that, not that the key is refused; every other
 * non-gated shape's strict schema rejects the key outright.
 */
export function provabilityShapeRefusal(shape: string): string {
  const gated = "the proof gate runs on cli, channel, managed and research harnesses";
  return shape === "crew"
    ? `a crew spec accepts provability: but does not gate on it yet (crewhaus compile warns accepted-but-unwired) — ${gated}`
    : `a ${shape} spec does not carry provability: — ${gated}`;
}

/** A `--provability` value or a questionnaire answer that is not a rung. */
export class InitProvabilityError extends CrewhausError {
  override readonly name = "InitProvabilityError";
  constructor(message: string) {
    super("config", message);
  }
}

/** Validate a `--provability` value; the message names every rung. */
export function parseProvabilityFlag(value: string): InitProvabilityLevel {
  const level = value.trim().toLowerCase();
  if (isInitProvabilityLevel(level)) return level;
  throw new InitProvabilityError(
    `--provability must be one of ${INIT_PROVABILITY_LEVELS.join(" | ")} (got "${value}")`,
  );
}

/**
 * The ONE proof question (design §11): the rungs one line each, then the
 * prompt with the shape's default in brackets — `off` on cli, `cited` on
 * research.
 */
export function provabilityQuestion(defaultLevel: InitProvabilityLevel): string {
  const width = Math.max(...INIT_PROVABILITY_LEVELS.map((l) => l.length));
  const lines = PROVABILITY_LEVEL_LINES.map(
    ({ level, line }) => `  ${level.padEnd(width)}  ${line}`,
  );
  return `How much proof should answers carry?\n${lines.join("\n")}\nproof level [${defaultLevel}]: `;
}

/**
 * Read an answer to {@link provabilityQuestion}: blank is the default, a rung
 * name in any case is that rung, anything else is `undefined` (the caller
 * asks again).
 */
export function parseProvabilityAnswer(
  answer: string,
  defaultLevel: InitProvabilityLevel,
): InitProvabilityLevel | undefined {
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "") return defaultLevel;
  return isInitProvabilityLevel(trimmed) ? trimmed : undefined;
}

/**
 * The block a scaffold writes: the comment that says what the knob is and
 * what the chosen rung asks of an answer, then the shorthand key (`level`
 * with every default — design §3). Ends with a newline.
 */
export function renderProvabilityBlock(level: InitProvabilityLevel): string {
  return `# The proof gate: off | cited | grounded | checked | proven.
# ${level} — ${levelLine(level)}.
provability: ${level}
`;
}

/**
 * The tools a scaffold with no tool answer of its own (`init --provability`,
 * `init --hybrid --provability`) declares so its floor is reachable — lint's
 * own remedies for `provability-no-source-tool` and
 * `provability-no-execution-tool`. A floor its tools cannot meet fails every
 * answer, and under the default `on_fail: retry` pays a re-run for each:
 * `grounded` needs a tool that reads a source, `checked` one on the default
 * `execution.allow` (`evaluate` is in `all-compute`). `cited` needs none, and
 * `proven` gets its proof tools from the gate itself.
 */
export function provabilityScaffoldTools(level: InitProvabilityLevel): readonly string[] {
  if (level === "grounded") return ["read", "webFetch"];
  if (level === "checked") return ["evaluate"];
  return [];
}

/**
 * {@link provabilityScaffoldTools} as a commented `tools:` block (ends with a
 * newline), or `""` for a floor that needs none.
 */
export function renderProvabilityToolsBlock(level: InitProvabilityLevel): string {
  const tools = provabilityScaffoldTools(level);
  if (tools.length === 0) return "";
  const why =
    level === "grounded"
      ? "# grounded needs a tool that reads a source: a file (read) or a web page (webFetch)."
      : "# checked needs a tool whose results the gate can re-run: evaluate is on its default allowlist.";
  return `${why}\ntools:\n${tools.map((tool) => `  - ${tool}`).join("\n")}\n`;
}

/** {@link renderProvabilityBlock} as a scaffold section: set off by a blank line, no trailing newline. */
function provabilitySection(level: InitProvabilityLevel): string {
  return `\n${renderProvabilityBlock(level).trimEnd()}`;
}

/**
 * Give a spec someone else wrote (the conversational interview's) the proof
 * floor `level` — the rung and nothing else — and re-validate. The flag
 * answers ONE question, so everything else the interview wrote stands:
 *
 *   - the shorthand `provability: <rung>` gets the new rung;
 *   - the object form keeps every sub-key (a `sources.allow` allowlist is
 *     security config, `max_assumptions` a policy the user asked for) and
 *     gets the new `level:`. `off` there writes `level: off`, the block's
 *     inert form (design §3), rather than throwing the user's settings away;
 *   - no block: the shorthand is appended; `off` writes nothing (absent is
 *     off, and no template default applies to a spec the interview wrote).
 *     An append is only right for a block-mapping document that runs to the
 *     end of the text: after a `...` document-end marker it starts a second
 *     document, and after a top-level flow mapping (`{name: x, …}`) it is
 *     not YAML at all. Either way the append is checked, and one that does
 *     not read back as exactly the new key falls back to a document edit
 *     (re-serialized, so restyled — but valid, and the paid-for spec kept).
 *
 * The edit is spliced into the TEXT at the rung's own source range, so the
 * interview's comments, quoting, flow style and line wrapping are untouched
 * — a re-serialized document restyles all three. Refuses a target that does
 * not gate on the block ({@link provabilityShapeRefusal}).
 */
export function setProvability(
  yaml: string,
  level: InitProvabilityLevel,
): { yaml: string; spec: Spec } {
  const target = parseSpec(yaml).target;
  if (!GATED_TARGETS.has(target)) {
    throw new InitProvabilityError(provabilityShapeRefusal(target));
  }
  const doc = parseDocument(yaml);
  // parseSpec accepted it, so the document is a mapping.
  const node = isMap(doc.contents) ? doc.contents.get("provability", true) : undefined;
  let out: string;
  if (node === undefined || node === null) {
    if (level === "off") {
      out = yaml;
    } else {
      const appended = `${yaml}${yaml.endsWith("\n") ? "" : "\n"}provability: ${level}\n`;
      if (appendsCleanly(appended, level)) {
        out = appended;
      } else {
        doc.set("provability", level);
        out = doc.toString();
      }
    }
  } else {
    // The scalar to rewrite: the shorthand itself, or the object form's
    // `level` (which the schema requires).
    const rung = isMap(node) ? node.get("level", true) : node;
    const range = isScalar(rung) ? rung.range : undefined;
    if (range === undefined || range === null) {
      throw new InitProvabilityError(
        "the interview's provability: block is not in a form --provability can set — edit its level by hand",
      );
    }
    out = `${yaml.slice(0, range[0])}${level}${yaml.slice(range[1])}`;
  }
  return { yaml: out, spec: parseSpec(out) };
}

/**
 * Whether `appended` — a spec with `provability: <level>` appended as text —
 * is still one document whose top-level mapping now carries exactly that
 * rung. False for an append after a `...` end marker (a second document) or
 * after a flow mapping (invalid YAML); {@link setProvability} then edits the
 * document instead.
 */
function appendsCleanly(appended: string, level: InitProvabilityLevel): boolean {
  const docs = parseAllDocuments(appended);
  if (!Array.isArray(docs) || docs.length !== 1) return false;
  const [doc] = docs;
  if (doc === undefined || doc.errors.length > 0 || !isMap(doc.contents)) return false;
  const rung = doc.contents.get("provability", true);
  // `yaml` types a parsed scalar's value as a node; at runtime it is the string.
  const value: unknown = isScalar(rung) ? rung.value : undefined;
  return value === level;
}

/**
 * Ask {@link provabilityQuestion} until the answer is a rung. Blank (and end
 * of input, which reads as blank) is the default, so a piped questionnaire
 * always finishes.
 */
export async function askProvability(
  ask: (prompt: string) => Promise<string>,
  defaultLevel: InitProvabilityLevel,
): Promise<InitProvabilityLevel> {
  let prompt = provabilityQuestion(defaultLevel);
  for (;;) {
    const level = parseProvabilityAnswer(await ask(prompt), defaultLevel);
    if (level !== undefined) return level;
    prompt = `  not a proof level — ${INIT_PROVABILITY_LEVELS.join(" | ")} [${defaultLevel}]: `;
  }
}

/**
 * The `provability` answer a scaffold of `shape` carries for `level`. `off` is
 * what an absent block means, so on cli it writes nothing and the spec stays
 * the pre-0.8.0 one; on research it is written, because there the absent
 * block means the template's `cited`.
 */
export function provabilityAnswer(
  shape: ScriptedShape,
  level: InitProvabilityLevel,
): InitProvabilityLevel | undefined {
  return level === "off" && shape !== "research" ? undefined : level;
}

/**
 * What a fresh scaffold's rung still needs, in `crewhaus lint`'s own words
 * (`auditProvability`): a source-reading tool at `grounded`, an allowlisted
 * tool at `checked`, a sandbox-free checker. Empty when the spec has what its
 * floor asks for. Read off the LOWERED spec, exactly as lint reads it.
 *
 * Advisory, so it never throws: `init` calls it AFTER the spec is written,
 * and not every spec it writes validates. The interview and the
 * questionnaire validate with `parseSpec` only, which accepts a tool token
 * `lower` refuses (`all-nonsense`); the plain scaffold is not validated at
 * all, and writes `name: <arg>` verbatim, so `init ./bot` writes a name
 * `parseSpec` refuses. Pass the YAML text and the parse happens HERE, inside
 * the same guard as the lowering: a spec that does not parse or lower gets
 * one note saying so — the init itself succeeded, and `crewhaus lint` /
 * `compile` report the problem in full.
 */
export function provabilityScaffoldNotes(spec: Spec | string): string[] {
  try {
    const parsed = typeof spec === "string" ? parseSpec(spec) : spec;
    return auditProvability(lower(parsed)).map((finding) => finding.message);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [
      `could not check what this proof level needs, because the spec does not compile yet: ${message} — fix it, then run \`crewhaus lint\``,
    ];
  }
}
