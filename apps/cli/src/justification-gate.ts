import { join } from "node:path";
import type { AuditLog } from "@crewhaus/audit-log";
import type { JustificationJudge } from "@crewhaus/permission-engine";
import type { EgressAuditSink, JustificationAuditSink } from "@crewhaus/runtime-core";

/**
 * FR-004 — Pillar 3 intent-gate wiring for `crewhaus run`, factored out of
 * the entry file `index.ts` (which runs a top-level argv switch and so cannot
 * be imported by a test without executing the CLI). Side-effect-free and
 * directly unit-testable, mirroring `scope-audit.ts`.
 *
 * Two halves of the gate the CLI threads into `runChatLoop`:
 *
 *   1. The JUDGE that scores a justification against the compile-time session
 *      goal — `"rule-based"` (the deterministic default; the CLI leaves
 *      `justificationJudge` unset so runtime-core falls back to
 *      `ruleBasedJustificationJudge`) or `"claude"` (the model-backed
 *      `@crewhaus/justification-judge-claude`).
 *
 *   2. The durable AUDIT SINK the gate appends a
 *      `permission_justification_evaluated` record to — a real
 *      `@crewhaus/audit-log` rooted at `<cwd>/.crewhaus/audit`. This is the
 *      hash-chained, tamper-evident artifact the AuditKind was created for;
 *      the trace-bus `permission_decision` event is ephemeral.
 *
 * Resolution precedence for the judge:
 *   `--justification-judge` flag > spec `security.justification.judge` >
 *   `"rule-based"`.
 */

export type JudgeChoice = "rule-based" | "claude";

const VALID_JUDGE_CHOICES: ReadonlyArray<JudgeChoice> = ["rule-based", "claude"];

/** Thrown by `resolveJudgeChoice` on an unrecognised choice. The CLI entry
 *  file catches it and routes the message through `die()`; tests assert on
 *  `.choice` / `.message` without the process exiting. */
export class InvalidJudgeChoiceError extends Error {
  override readonly name = "InvalidJudgeChoiceError";
  constructor(readonly choice: string) {
    super(`invalid --justification-judge "${choice}" — allowed: ${VALID_JUDGE_CHOICES.join(", ")}`);
  }
}

function isJudgeChoice(s: string): s is JudgeChoice {
  return (VALID_JUDGE_CHOICES as ReadonlyArray<string>).includes(s);
}

/**
 * Pure resolution of the judge choice from the flag value + spec block.
 * `flagValue` is the raw `--justification-judge` value (or undefined when the
 * flag is absent). Throws `InvalidJudgeChoiceError` for any value outside the
 * allowed set so the caller can `die()` with a friendly message.
 */
export function resolveJudgeChoice(
  flagValue: string | undefined,
  securityJustification: { judge?: JudgeChoice; model?: string } | undefined,
): JudgeChoice {
  const raw = flagValue ?? securityJustification?.judge ?? "rule-based";
  if (!isJudgeChoice(raw)) throw new InvalidJudgeChoiceError(raw);
  return raw;
}

/**
 * Build the `JustificationJudge` for a resolved choice. Returns `undefined`
 * for `"rule-based"` so the caller omits `justificationJudge` from
 * `runChatLoop` (runtime-core then uses `ruleBasedJustificationJudge`, the
 * documented default for tests/offline runs). For `"claude"` it lazily
 * imports the model-router + `@crewhaus/justification-judge-claude` so
 * that model-backed code only loads when actually selected.
 *
 * The judge model is resolved through the model-router, so the spec's
 * `security.justification.model` accepts the full router grammar
 * (claude-*, openai/*, gemini/*, bedrock/*, local/<m>@<url>) — the judge
 * package only needs a `ProviderAdapter`. The wire model is the
 * resolution's *stripped* modelId; the previous hardcoded
 * `createAnthropicAdapter()` + verbatim model string broke every
 * non-Anthropic judge with model-not-found.
 */
export async function createJustificationJudge(
  choice: JudgeChoice,
  model: string | undefined,
): Promise<JustificationJudge | undefined> {
  if (choice === "rule-based") return undefined;
  const { resolveModel } = await import("@crewhaus/model-router");
  const { createClaudeJustificationJudge } = await import("@crewhaus/justification-judge-claude");
  const resolution = await resolveModel(model ?? "claude-haiku-4-5");
  return createClaudeJustificationJudge({
    adapter: resolution.adapter,
    model: resolution.modelId,
  });
}

/** Directory the run path roots the durable justification audit log at. */
export function justificationAuditDir(cwd: string): string {
  return join(cwd, ".crewhaus", "audit");
}

export type OpenJustificationAuditSinkOptions = {
  /** Working directory; the sink is rooted at `<cwd>/.crewhaus/audit`. */
  readonly cwd: string;
  /**
   * When false, no durable sink is opened (the gate keeps only its ephemeral
   * trace-bus event). Defaults to true: `crewhaus run` writes the durable,
   * hash-chained `permission_justification_evaluated` record by default so
   * the intent gate's decisions are tamper-evident. The `--no-justification-audit`
   * flag flips this off for ephemeral/offline runs.
   */
  readonly enabled?: boolean;
};

/**
 * Open the durable audit log the Pillar 3 gates append to, rooted at
 * `<cwd>/.crewhaus/audit`. Returns `undefined` when disabled (so the caller
 * spreads nothing into `runChatLoop` and the durable path is a no-op).
 *
 * The returned object is a real `@crewhaus/audit-log` `AuditLog`, which
 * structurally satisfies BOTH the `JustificationAuditSink`
 * (`permission_justification_evaluated`) and the `EgressAuditSink`
 * (`egress_decision`) seams — its `append({ kind, payload })`. A single log
 * instance is deliberately shared across both gates so their records land on
 * ONE hash-chained, gapless chain (item 20): two separate logs would each own
 * their own `_chain-tail.json` and interleave inconsistently.
 */
export async function openSecurityAuditSink(
  opts: OpenJustificationAuditSinkOptions,
): Promise<AuditLog | undefined> {
  if (opts.enabled === false) return undefined;
  const { openAuditLog } = await import("@crewhaus/audit-log");
  return await openAuditLog({ rootDir: justificationAuditDir(opts.cwd) });
}

/**
 * Back-compat alias — the justification gate's original opener. Returns the
 * shared `AuditLog` typed down to the `JustificationAuditSink` seam. Prefer
 * {@link openSecurityAuditSink} when a caller also needs the egress sink from
 * the same chain.
 */
export async function openJustificationAuditSink(
  opts: OpenJustificationAuditSinkOptions,
): Promise<JustificationAuditSink | undefined> {
  return await openSecurityAuditSink(opts);
}

/**
 * Narrow a shared security audit log to the `EgressAuditSink` seam. The same
 * `AuditLog` instance already satisfies `EgressAuditSink` structurally; this
 * is a typed pass-through so the run path can thread one log into both
 * `runChatLoop({ justificationAuditSink, egressAuditSink })` fields.
 */
export function asEgressAuditSink(sink: AuditLog | undefined): EgressAuditSink | undefined {
  return sink;
}
