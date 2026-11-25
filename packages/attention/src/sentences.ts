/**
 * Every closed text id an item carries, as the plain sentence a terminal prints. Home's
 * console keeps its own copy of these words beside its view; both are held to the
 * contract's `TITLE_TEMPLATES` by a test, so a new id never reaches a reader as a raw id.
 * A param is an id, a name or a count, never a person's words. Pure.
 */
import type { AttentionText, DecisionClass } from "@crewhaus/control-contract";

type Params = Readonly<Record<string, string | number>>;

const s = (n: unknown): string => (Number(n) === 1 ? "" : "s");
const word = (value: unknown, fallback: string): string =>
  typeof value === "string" && value !== "" ? value : fallback;

export const ATTENTION_SENTENCES: Readonly<Record<string, (p: Params) => string>> = {
  "permission.ask": (p) => `Permission to use ${word(p["tool"], "a tool")}`,
  "question.ask": (p) => `A question, asked while using ${word(p["tool"], "a tool")}`,
  "review.open": () => "An answer needs review",
  "standing-rule-proposal.pending": () => "A standing permission is proposed",
  "delegation-proposal.pending": (p) =>
    `Letting it ${word(p["delegationAction"], "act")} on its own is proposed`,
  "quality-adoption.pending": () => "A change is ready to adopt",
  "decision.pending": (p) => {
    const kind = word(p["decisionKind"], "other");
    return kind === "other" ? "A decision is waiting" : `A ${kind} decision is waiting`;
  },
  "credential.failing": (p) =>
    `Runs can't sign in to ${word(p["provider"], "the model provider")} (${word(p["envName"], "its key")})`,
  "provider-limit.hit": (p) => `${word(p["provider"], "The model provider")} is limiting requests`,
  "budget.exhausted": () => "Runs stopped at the budget",
  "spec.failing": () => "Runs fail on the spec",
  "deployment.failing": () => "A deployment keeps failing",
  "run-failures.message": (p) => `Runs fail the same way (${word(p["class"], "unknown")})`,
  "run-failures.class": (p) => `Runs fail: ${word(p["class"], "unknown")}`,
  "advisor.spec-unreadable": () => "The spec can't be read",
  "advisor.preflight-blocked": (p) => `A start check fails: ${word(p["check"], "a check")}`,
  "advisor.crash-looping": () => "It keeps crashing",
  "advisor.parked": () => "It stopped and is waiting",
  "advisor.terminal": () => "It stopped and won't restart",
  "advisor.quality-regressed": () => "Quality dropped below the baseline",
  "advisor.incident-open": (p) => `An incident is open: ${word(p["incident"], "unnamed")}`,
  "advisor.dream-overdue": (p) => `A memory review is overdue: ${word(p["spec"], "this harness")}`,
  "advisor.budget-exceeded": () => "Spending is over the budget",
  "advisor.budget-near": (p) =>
    `Spending is at ${word(String(p["percent"] ?? ""), "most")}% of the budget`,
  "advisor.budget-absent": () => "No budget is set",
  "advisor.spec-issue": () => "The spec has an issue",
  "advisor.evals-none": () => "No eval has run yet",
  "advisor.evals-no-baseline": () => "No baseline is pinned for evals",
  "advisor.advice-waiting": () => "Suggestions are waiting",
  "advisor.policy-flip-ready": () => "Model routing has enough data to learn",
  "advisor.candidate-underperforming": () => "A model choice is doing worse",
  "advisor.audition-ready": () => "A model trial is ready",
  "advisor.escalation-rate-high": () => "Many turns move to a stronger model",
  "advisor.judge-spend-dominates": () => "Grading costs more than the work",
  "advisor.model-retiring": (p) => `A model is retiring: ${word(p["model"], "one in use")}`,
  "advisor.pin-not-served": (p) =>
    `A pinned version isn't running in ${word(p["environment"], "an environment")}`,
  "advisor.other": () => "The Advisor has a suggestion",
  "why.waiting": (p) =>
    Number(p["runs"]) > 1
      ? `${p["runs"]} runs are waiting for this.`
      : "A run is waiting for this.",
  "why.asked-again": () => "This was asked before.",
  "why.runs-failed": (p) => `${p["runs"] ?? "Some"} run${s(p["runs"])} failed this way.`,
  "why.review-open": () => "An answer was set aside for a person to check.",
  "why.decision-open": () => "It waits until someone decides.",
  "why.advisor-critical": () => "The harness can't do its job until this is fixed.",
  "why.advisor-warn": () => "The harness is at risk.",
  "why.advisor-suggestion": () => "It would run better.",
  "recommend.refused-before": () => "Refused before: the same request was refused recently.",
  "if-unanswered.continue-independent": () => "If no one answers, it carries on with other work.",
  "if-unanswered.defer": () => "If no one answers, it is put off.",
  "if-unanswered.pause-lane": () => "If no one answers, this line of work pauses.",
  "if-unanswered.deny": () => "If no one answers, it is refused.",
  "if-unanswered.waits": () => "If no one answers, it waits.",
  "if-unanswered.expires": () => "If no one answers, it expires.",
};

/** What an id no table knows reads as. */
export const UNKNOWN_SENTENCE = "Something needs a look";

/** A closed text as a sentence. Pure. */
export function sentenceOf(
  text: Pick<AttentionText, "template"> & { readonly params?: Params },
): string {
  const build = Object.hasOwn(ATTENTION_SENTENCES, text.template)
    ? ATTENTION_SENTENCES[text.template]
    : undefined;
  return build === undefined ? UNKNOWN_SENTENCE : build(text.params ?? {});
}

/** Who may decide, as words. Pure. */
export function classWordOf(requiredClass: DecisionClass): string {
  if (requiredClass === "owner") return "Owner only";
  if (requiredClass === "maintainer") return "Needs a maintainer";
  return "Needs an operator";
}
