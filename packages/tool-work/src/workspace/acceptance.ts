/**
 * The acceptance check: before a pull request opens, whether the change does what the item
 * asked. Deterministic checks first, then the judge over what is left. Pure over its ports.
 *
 * - Every declared check must have passed for the exact head SHA when the binding requires
 *   checks. A criterion written `check: <name>` passes exactly when that check did, and never
 *   reaches the judge.
 * - The judge reads the item's criteria (its title and goal when it lists none) and, when the
 *   spec declares one, the harness's intent; and, as the thing judged, what the change adds.
 *   Each criterion is classified at the origin it was written through, and the change at the
 *   origin of a tool's output. Text that is withheld fails the check: a criterion nobody
 *   could read safely is not met.
 * - The judge answers one of two labels. An abstention is not met.
 *
 * The verdict is `pass` or `fail` and never the judge's words. Its reasons can quote the
 * intent, so they are returned apart, for the owner's file alone.
 */
import type { BoundaryResult, TrustOrigin } from "@crewhaus/boundary-classifier";
import type { WorkPublishVerdict } from "@crewhaus/control-contract";
import { type RunContext, tagContent } from "@crewhaus/run-context";
import type { WorkRevision } from "../work-items/index";
import type { DeclaredIntent, RepositoryBinding } from "./bindings";
import type { CheckResult } from "./checks";
import type { AddedLine, DiffStat } from "./git";

export const ACCEPTANCE_MEETS = "meets";
export const ACCEPTANCE_DOES_NOT_MEET = "does_not_meet";

/** The most of a change the judge reads, in characters. */
export const JUDGE_DIFF_MAX = 64 * 1024;

export type AcceptanceJudgeAnswer = {
  readonly label: string;
  readonly abstain: boolean;
  readonly rationale: string;
};

/** The judge, as a port: what it is given is data, wrapped so it reads as data. */
export type AcceptanceJudge = (input: {
  /** The criteria, and the intent when declared. */
  readonly input: string;
  /** What the change adds. */
  readonly output: string;
  readonly signal?: AbortSignal;
}) => Promise<AcceptanceJudgeAnswer>;

export type Classify = (
  text: string,
  opts: { readonly origin: TrustOrigin },
) => Promise<BoundaryResult>;

export type AcceptanceInput = {
  readonly binding: RepositoryBinding;
  readonly revision: WorkRevision;
  readonly intent?: DeclaredIntent;
  readonly headSha: string;
  readonly stat: DiffStat;
  readonly added: readonly AddedLine[];
  /** The declared checks' results for this head, `undefined` when they did not run. */
  readonly checks: readonly CheckResult[] | undefined;
  readonly judge: AcceptanceJudge | undefined;
  readonly classify: Classify;
  readonly rc?: RunContext;
  readonly signal?: AbortSignal;
};

export type AcceptanceAnswer = {
  readonly verdict: WorkPublishVerdict;
  /** Set when the change does not pass: which part, in words safe to show anywhere. */
  readonly refused?: "checks_failed" | "gate_failed";
  /** Why, without the judge's words: a check's name, or which kind of reason it was. */
  readonly message?: string;
  /** The judge's own words, for the owner's file. Never the agent, never the pull request. */
  readonly reasons?: string;
};

const CHECK_CRITERION_RE = /^check:\s*(.+)$/i;

/** The criteria a person or a run wrote, with the origin each came through. */
function criteriaOf(revision: WorkRevision): {
  readonly text: string;
  readonly origin: TrustOrigin;
}[] {
  const at = (field: "title" | "goal" | "acceptance"): TrustOrigin =>
    revision.fieldOrigins[field] ?? "memory";
  if (revision.acceptance !== undefined && revision.acceptance.length > 0) {
    const origin = at("acceptance");
    return revision.acceptance.map((text) => ({ text, origin }));
  }
  return [
    { text: revision.title, origin: at("title") },
    ...(revision.goal !== undefined ? [{ text: revision.goal, origin: at("goal") }] : []),
  ];
}

function intentText(intent: DeclaredIntent): string {
  const part = (heading: string, list: readonly string[] | undefined): string[] =>
    list === undefined || list.length === 0 ? [] : [`${heading}:`, ...list.map((l) => `- ${l}`)];
  return [
    "What this harness is for (the change must fit it):",
    intent.purpose,
    ...part("It serves", intent.serves),
    ...part("Outcomes it works toward", intent.outcomes),
    ...part("Not part of its work", intent.excludes),
  ].join("\n");
}

/** What the change adds, as the judge reads it: counts, then lines, cut and said so. */
export function changeText(stat: DiffStat, added: readonly AddedLine[]): string {
  const out: string[] = [`${stat.files} files changed, ${stat.lines} lines changed.`];
  let size = 0;
  let file = "";
  for (const line of added) {
    const heading = line.file === file ? [] : [`--- ${line.file}`];
    const text = `${line.line}: ${line.text}`;
    size += text.length + 1 + heading.reduce((n, h) => n + h.length + 1, 0);
    if (size > JUDGE_DIFF_MAX) {
      out.push("[the rest of the change was cut]");
      break;
    }
    file = line.file;
    out.push(...heading, text);
  }
  return out.join("\n");
}

/**
 * Judge one change. A refusal never carries the judge's words: they can quote the intent, and
 * what is returned as `message` goes to the agent.
 */
export async function acceptanceCheck(input: AcceptanceInput): Promise<AcceptanceAnswer> {
  const { binding, headSha, checks } = input;
  const required = binding.pullRequests.require;
  const ran = checks !== undefined;
  const failing = (checks ?? []).find((c) => c.exit !== 0);
  const checksVerdict: WorkPublishVerdict["checks"] = !ran
    ? required.includes("checks")
      ? "not-run"
      : "skipped"
    : failing === undefined
      ? "pass"
      : "fail";
  const verdict = (acceptance: WorkPublishVerdict["acceptance"]): WorkPublishVerdict => ({
    checks: checksVerdict,
    acceptance,
    sha: headSha,
  });
  if (required.includes("checks") && checksVerdict !== "pass") {
    const unjudged = verdict(required.includes("acceptance") ? "not-run" : "not-required");
    return checksVerdict === "fail"
      ? {
          verdict: unjudged,
          refused: "checks_failed",
          message: `The check "${failing?.name}" failed (exit ${failing?.exit}).`,
        }
      : { verdict: unjudged, refused: "gate_failed", message: "The checks did not run." };
  }
  if (!required.includes("acceptance")) return { verdict: verdict("not-required") };

  const judged: string[] = [];
  for (const criterion of criteriaOf(input.revision)) {
    const named = CHECK_CRITERION_RE.exec(criterion.text.trim());
    if (named !== null) {
      const name = (named[1] as string).trim();
      const result = (checks ?? []).find((c) => c.name === name);
      if (result === undefined || result.exit !== 0) {
        return {
          verdict: verdict("fail"),
          refused: "gate_failed",
          message:
            result === undefined
              ? `A criterion names the check "${name}", which did not run.`
              : `A criterion names the check "${name}", which failed (exit ${result.exit}).`,
        };
      }
      continue;
    }
    const read = await input.classify(criterion.text, { origin: criterion.origin });
    if (read.action === "redact") {
      return {
        verdict: verdict("fail"),
        refused: "gate_failed",
        message: "A criterion could not be read safely. A person can reword it.",
      };
    }
    if (input.rc !== undefined) tagContent(input.rc, criterion.text, criterion.origin);
    judged.push(criterion.text);
  }
  // Every criterion was a check that passed: nothing is left to judge, unless the owner
  // declared an intent the change must fit.
  if (judged.length === 0 && input.intent === undefined) return { verdict: verdict("pass") };
  const { judge } = input;
  if (judge === undefined) {
    return {
      verdict: verdict("fail"),
      refused: "gate_failed",
      message: "No judge is available for the acceptance check.",
    };
  }
  const change = changeText(input.stat, input.added);
  const changeRead = await input.classify(change, { origin: "tool" });
  if (changeRead.action === "redact") {
    return {
      verdict: verdict("fail"),
      refused: "gate_failed",
      message: "The change holds text written to steer whoever reviews it.",
    };
  }
  const asked = [
    ...(judged.length > 0 ? ["The change must do this:", ...judged.map((c) => `- ${c}`)] : []),
    ...(input.intent !== undefined ? ["", intentText(input.intent)] : []),
  ]
    .join("\n")
    .trim();
  let answer: AcceptanceJudgeAnswer;
  try {
    answer = await judge({
      input: asked,
      output: change,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  } catch {
    return {
      verdict: verdict("fail"),
      refused: "gate_failed",
      message: "The acceptance check's judge could not answer. Try again.",
    };
  }
  const met = answer.label === ACCEPTANCE_MEETS && !answer.abstain;
  return met
    ? { verdict: verdict("pass"), reasons: answer.rationale }
    : {
        verdict: verdict("fail"),
        refused: "gate_failed",
        message: answer.abstain
          ? "The acceptance check could not tell whether the change does what was asked."
          : "The change does not do what was asked.",
        reasons: answer.rationale,
      };
}
