/**
 * Catalog R-orch `planner` — Section 23 RES.
 *
 * `decompose(goal, opts)` calls the LLM to break a research goal into
 * `branchingFactor` (default 3) sub-questions. Each sub-question is one
 * branch the daemon will research independently.
 *
 * Determinism: the planner is INTENTIONALLY low-temperature and the
 * prompt asks the model to emit a fenced JSON object. Output is parsed
 * via a tolerant JSON-fence extractor; if parsing fails, the planner
 * retries once before throwing.
 *
 * Pluggability: the model is resolved via `@crewhaus/model-router` so
 * planner can sit on Anthropic, OpenAI, etc. via the prefix grammar.
 * Tests inject a scripted `ProviderAdapter` directly.
 */
import {
  type ProviderAdapter,
  type StreamEvent,
  consumeStream,
  extractFirstText,
} from "@crewhaus/adapter-anthropic";
import { CrewhausError } from "@crewhaus/errors";
import { resolveModel } from "@crewhaus/model-router";

export class PlannerError extends CrewhausError {
  override readonly name = "PlannerError";
  constructor(message: string, cause?: unknown) {
    super("runtime", message, cause);
  }
}

export type Plan = {
  readonly version: 1;
  readonly goal: string;
  readonly subQuestions: ReadonlyArray<string>;
  readonly branchingFactor: number;
  readonly model: string;
  readonly createdAt: string;
};

export type DecomposeOptions = {
  readonly model: string;
  readonly branchingFactor?: number;
  readonly maxTokens?: number;
  /** Test injection; bypasses the model-router. */
  readonly _adapter?: ProviderAdapter;
  readonly now?: () => Date;
};

const DEFAULT_BRANCHING = 3;
const DEFAULT_MAX_TOKENS = 1024;

const SYSTEM_PROMPT = `You are a research planner. The user gives you a research goal.
You return a JSON object with this exact shape:

{ "subQuestions": ["question 1", "question 2", "question 3"] }

Rules:
- Emit ONLY the JSON object inside a single \`\`\`json fenced code block. No prose before or after.
- Each sub-question must be a self-contained question that, on its own,
  would advance answering the main goal.
- Each sub-question should target a different facet of the goal — avoid
  near-duplicates.
- The number of questions must equal the user's requested branching factor.
- Questions should be short (one sentence each).`;

function userPrompt(goal: string, branchingFactor: number): string {
  return `Goal: ${goal}\n\nBranching factor: ${branchingFactor}\n\nReturn ${branchingFactor} sub-questions in the JSON format above.`;
}

const FENCE_RE = /```(?:json)?\s*([\s\S]*?)\s*```/;

function extractJson(text: string): string {
  const m = FENCE_RE.exec(text);
  if (m?.[1]) return m[1].trim();
  // Permissive fallback — first { ... } block.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  throw new PlannerError(`could not locate JSON block in planner output: ${text.slice(0, 200)}`);
}

function parsePlanShape(jsonText: string): { subQuestions: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new PlannerError(`planner output is not valid JSON: ${jsonText.slice(0, 120)}`, err);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new PlannerError("planner output JSON is not an object");
  }
  const obj = parsed as { subQuestions?: unknown };
  if (!Array.isArray(obj.subQuestions)) {
    throw new PlannerError("planner output is missing `subQuestions` array");
  }
  const subs: string[] = [];
  for (const q of obj.subQuestions) {
    if (typeof q !== "string" || q.trim().length === 0) {
      throw new PlannerError("planner output contains a non-string or empty sub-question");
    }
    subs.push(q.trim());
  }
  return { subQuestions: subs };
}

async function callModel(
  adapter: ProviderAdapter,
  modelId: string,
  goal: string,
  branchingFactor: number,
  maxTokens: number,
): Promise<string> {
  const stream: AsyncIterable<StreamEvent> = adapter.stream({
    model: modelId,
    maxTokens,
    system: [{ type: "text", text: SYSTEM_PROMPT }],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: userPrompt(goal, branchingFactor) }],
      },
    ],
  });
  const message = await consumeStream(stream);
  const text = extractFirstText(message);
  if (text === undefined) {
    throw new PlannerError("planner: model returned a non-text message");
  }
  return text;
}

export async function decompose(goal: string, opts: DecomposeOptions): Promise<Plan> {
  if (typeof goal !== "string" || goal.trim().length === 0) {
    throw new PlannerError("decompose: goal must be a non-empty string");
  }
  const branchingFactor = opts.branchingFactor ?? DEFAULT_BRANCHING;
  if (branchingFactor < 1 || branchingFactor > 8) {
    throw new PlannerError(`decompose: branchingFactor must be 1..8 (got ${branchingFactor})`);
  }
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const now = opts.now ?? (() => new Date());

  const resolution = opts._adapter
    ? { adapter: opts._adapter, modelId: opts.model, providerId: opts._adapter.providerId }
    : await resolveModel(opts.model);

  // One attempt + one retry on parse failure. Retry uses the same prompt;
  // model often self-corrects format errors on the second try.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await callModel(
        resolution.adapter,
        resolution.modelId,
        goal,
        branchingFactor,
        maxTokens,
      );
      const json = extractJson(text);
      const shape = parsePlanShape(json);
      if (shape.subQuestions.length !== branchingFactor) {
        throw new PlannerError(
          `planner returned ${shape.subQuestions.length} sub-questions, expected ${branchingFactor}`,
        );
      }
      return {
        version: 1,
        goal: goal.trim(),
        subQuestions: shape.subQuestions,
        branchingFactor,
        model: opts.model,
        createdAt: now().toISOString(),
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new PlannerError(
    `planner failed after retry: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    lastErr,
  );
}
