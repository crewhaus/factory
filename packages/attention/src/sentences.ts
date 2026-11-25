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

/** Two names side by side, or a fallback when neither is one. */
const words = (a: unknown, b: unknown, fallback: string): string =>
  [a, b].filter((v) => typeof v === "string" && v !== "").join(" ") || fallback;

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
  "checkpoint.waiting": (p) =>
    typeof p["node"] === "string" && p["node"] !== ""
      ? `A graph run is paused before ${p["node"]}`
      : "A graph run is paused for a decision",
  "deploy-approval.pending": (p) =>
    `Approve ${words(p["spec"], p["version"], "a version")} for ${word(p["environment"], "an environment")}`,
  "deploy-approval.ready": (p) =>
    `${words(p["spec"], p["version"], "A version")} is approved for ${word(p["environment"], "an environment")}`,
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
  "why.graph-paused": () => "The run goes no further until someone decides.",
  "why.deploy-blocked": () => "The environment is protected: it takes approvals.",
  "why.deploy-approved": () => "It has its approvals and is not there yet.",
  "why.advisor-critical": () => "The harness can't do its job until this is fixed.",
  "why.advisor-warn": () => "The harness is at risk.",
  "why.advisor-suggestion": () => "It would run better.",
  "recommend.refused-before": () => "Refused before: the same request was refused recently.",
  "budget.raise-spec": () => "Raise the limit in the spec",
  "budget.raise-period": () => "Raise this period's limit",
  "note.deadline-unchanged": () => "Its own deadline is unchanged.",
  "if-unanswered.continue-independent": () => "If no one answers, it carries on with other work.",
  "if-unanswered.defer": () => "If no one answers, it is put off.",
  "if-unanswered.pause-lane": () => "If no one answers, this line of work pauses.",
  "if-unanswered.deny": () => "If no one answers, it is refused.",
  "if-unanswered.waits": () => "If no one answers, it waits.",
  "if-unanswered.expires": () => "If no one answers, it expires.",
};

/**
 * What each choice does, by its item's kind: closed words, never an item's text. A
 * `decide` verdict cannot be undone, so every surface shows this before it is taken.
 */
export const CHOICE_EFFECTS: Readonly<Record<string, string>> = {
  "permission.grant": "Allows this one call, and the run goes on.",
  "permission.deny": "Refuses this one call, and the run goes on without it.",
  "permission.grant-always": "Allows this call, and calls like it for 30 days.",
  "permission.grant-propose": "Allows this one call, and asks the owner about next time.",
  "review.pass": "Records that the answer is right.",
  "review.fail": "Records that the answer is wrong.",
  "review.up": "Settles the raters' disagreement as a good answer.",
  "review.down": "Settles the raters' disagreement as a bad answer.",
  "standing-rule-proposal.grant": "Makes the standing permission that was asked for.",
  "standing-rule-proposal.deny": "Refuses the standing permission.",
  "standing-rule-proposal.review": "Opens what turning it on would allow.",
  "quality-adoption.grant": "Says the change may be adopted. Nothing is applied yet.",
  "quality-adoption.deny": "Refuses the change. Nothing is applied.",
  "quality-adoption.adopt": "Opens the change, to review and adopt it.",
  "decision.grant": "Allows it to go ahead.",
  "decision.deny": "Refuses it. It does not go ahead.",
  "checkpoint.approve": "Lets the paused run go on.",
  "checkpoint.reject": "Skips the paused step, and the run goes on without it.",
  "deploy-approval.approve": "Adds your approval. Once enough people approve, it can be put there.",
  "deploy-approval.deny": "Refuses it for this environment.",
  "deploy-approval.promote": "Puts the approved version in the environment.",
  "credential.acknowledge": "Sets it aside until it fails again.",
  "credential.inspect": "Opens the runs it stopped.",
  "provider-limit.acknowledge": "Sets it aside until it happens again.",
  "provider-limit.inspect": "Opens the runs it stopped.",
  "budget.raise-spec": "Opens the spec's budget, to raise the limit for good.",
  "budget.raise-period": "Opens this period's budget, to raise it once.",
  "budget.wait-for-renewal": "Puts it off until the budget renews.",
  "budget.acknowledge": "Sets it aside until it happens again.",
  "budget.act": "Starts the suggested check.",
  "budget.open": "Opens the budget.",
  "spec.acknowledge": "Sets it aside until it fails again.",
  "spec.inspect": "Opens the runs it stopped.",
  "spec.act": "Starts the suggested check.",
  "spec.open": "Opens the spec.",
  "run-failures.acknowledge": "Sets it aside until it fails again.",
  "run-failures.inspect": "Opens the runs that failed.",
  "security.act": "Starts the suggested check.",
  "security.open": "Opens the incident.",
  "quality-regression.act": "Starts the suggested check.",
  "quality-regression.open": "Opens the results.",
  "setup.act": "Starts the suggested check.",
  "setup.open": "Opens the place that fixes it.",
};

/** What a choice does, or an empty string for one no table knows. Pure. */
export function choiceEffectOf(kind: string, choice: string): string {
  const id = `${kind}.${choice}`;
  return Object.hasOwn(CHOICE_EFFECTS, id) ? (CHOICE_EFFECTS[id] as string) : "";
}

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
