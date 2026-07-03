import { type Spec, SpecParseError, parseSpec } from "@crewhaus/spec";

/**
 * Item 39 — `crewhaus init --interactive`. Folds the demos harness-designer
 * pattern (an agent that interviews the user in plain English and emits a
 * validated crewhaus.yaml) into core. Two design commitments:
 *
 *   1. NO dependency on the demos repo. The shape-decision guidance is
 *      bundled inline here ({@link SHAPE_GUIDANCE} / {@link buildInterviewSystemPrompt}),
 *      and validation is `parseSpec` called in-process — the single source of
 *      truth for what compiles.
 *   2. Every draft the model emits is validated against the LIVE Zod union via
 *      `parseSpec`, and on a structured error the error text is fed back for a
 *      retry. So `init --interactive` cannot emit a spec that won't parse.
 *
 * Everything here is side-effect-free and unit-testable: the interview loop is
 * driven by an INJECTED `proposeSpec` callback (the CLI wires the model
 * adapter behind it), and the credential-free fallback is a pure
 * {@link buildScriptedSpec} over stdin answers. The CLI wrapper in `index.ts`
 * owns all I/O.
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
 * The interviewer's system prompt. Bundles the shape catalog + the hard rules
 * the emitted YAML must obey (single-line-safe names, the `$UPPER_SNAKE_CASE`
 * secret convention, no `permissions.mode: bypass`). Kept as a builder so a
 * test can assert the guidance is present without shipping a golden file.
 */
export function buildInterviewSystemPrompt(): string {
  const shapes = SHAPE_GUIDANCE.map((s) => `  - ${s.target}: ${s.when}`).join("\n");
  return [
    "You are the CrewHaus harness designer. Interview the user in plain English to",
    "understand what agent they want to build, then emit a single valid crewhaus.yaml",
    "by calling the `emit_spec` tool with the full YAML as its `yaml` argument.",
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
    "When the validator reports an error on your draft, FIX exactly that error and re-emit",
    "— do not restart the interview.",
  ].join("\n");
}

/** The tool the interviewer calls to submit a candidate spec. Exported so the
 *  CLI wires the same schema into the adapter request. */
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

/** One turn of the interview: the injected model proposes a spec (the `yaml`
 *  string it passed to `emit_spec`), given the running feedback log of prior
 *  validation errors. Returns undefined if the model declined to emit. */
export type ProposeSpec = (feedback: readonly string[]) => Promise<string | undefined>;

export type InterviewResult = {
  readonly yaml: string;
  readonly spec: Spec;
  /** How many drafts were tried before one validated (1 = first try). */
  readonly attempts: number;
};

export class InterviewError extends SpecParseError {}

/**
 * Drive the validate-and-retry interview loop. Each attempt asks the injected
 * `proposeSpec` for a draft, runs it through `parseSpec` (the LIVE union), and
 * on a `SpecParseError` appends the error to the feedback log for the next
 * attempt. Succeeds on the first draft that validates; throws
 * {@link InterviewError} after `maxAttempts` failed drafts (or if the model
 * declines to emit). Pure given its `proposeSpec` seam — no I/O.
 */
export async function runInterview(opts: {
  readonly proposeSpec: ProposeSpec;
  readonly maxAttempts?: number;
}): Promise<InterviewResult> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const feedback: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const yaml = await opts.proposeSpec(feedback);
    if (yaml === undefined) {
      throw new InterviewError(
        "the interviewer did not emit a spec (no emit_spec tool call) — try a more concrete description",
      );
    }
    try {
      const spec = parseSpec(yaml);
      return { yaml, spec, attempts: attempt };
    } catch (err) {
      if (err instanceof SpecParseError) {
        feedback.push(err.message);
        continue;
      }
      throw err;
    }
  }
  throw new InterviewError(
    `interviewer failed to produce a valid spec after ${maxAttempts} attempts. Last errors:\n${feedback
      .map((f) => `  - ${f}`)
      .join("\n")}`,
  );
}

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
      "",
    ]
      .filter((l) => l !== "")
      .join("\n");
  }
  const spec = parseSpec(yaml);
  return { yaml, spec };
}
