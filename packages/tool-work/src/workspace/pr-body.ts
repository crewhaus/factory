/**
 * A pull request's text, rendered from records: what the agent wrote about its change, then
 * the item it delivers, its checks and their results, the acceptance verdict as a word, and
 * the agent's open concerns. It never carries the judge's reasons, the declared intent, a
 * decision's note, a model's thinking or a profile, and no link in it holds a token.
 */
import type { WorkPublishVerdict } from "@crewhaus/control-contract";
import type { CheckResult } from "./checks";

export const TITLE_MAX = 120;
export const SUMMARY_MAX = 4096;
export const CONCERNS_MAX = 10;
export const CONCERN_MAX = 300;

/** What the agent says about its change: kept beside the check logs, so a retry says the same. */
export type PublishText = {
  readonly title: string;
  readonly summary: string;
  readonly concerns?: readonly string[];
};

export type PullBodyInput = {
  readonly text: PublishText;
  readonly wi: string;
  /** Home's page for the item, when the harness knows where Home is. Never a token in it. */
  readonly homeLink?: string;
  readonly parent?: string;
  /** Plan steps or goals the item came from, by id. */
  readonly plan?: readonly string[];
  /** The runs that worked on it, by id. */
  readonly runs?: readonly string[];
  /** The decisions behind it, by id. */
  readonly decisions?: readonly string[];
  readonly checks?: readonly Pick<CheckResult, "name" | "exit">[];
  readonly verdict: WorkPublishVerdict;
  /** The base commit the change was rebased onto and checked again on. */
  readonly rebasedOnto?: string;
};

const ACCEPTANCE_WORDS: Readonly<Record<WorkPublishVerdict["acceptance"], string>> = {
  pass: "passed",
  fail: "did not pass",
  "not-required": "not required",
  "not-run": "did not run",
};

/** A mention notifies a person: an unseen space after the `@` keeps the words and tells nobody. */
function withoutMentions(text: string): string {
  return text.replace(/@(?=[A-Za-z0-9])/g, `@${String.fromCodePoint(0x200b)}`);
}

/** One line of text. */
function plain(text: string): string {
  return withoutMentions(text.replace(/\s+/g, " ").trim());
}

/** A title as it is published: one line, bounded. */
export function pullTitle(title: string): string {
  return plain(title).slice(0, TITLE_MAX);
}

export function pullBody(input: PullBodyInput): string {
  const out: string[] = [withoutMentions(input.text.summary.trim()), "", "---", ""];
  out.push(
    input.homeLink !== undefined
      ? `Work item: [${input.wi}](${input.homeLink})`
      : `Work item: \`${input.wi}\``,
  );
  const ids = (label: string, list: readonly string[] | undefined): void => {
    if (list !== undefined && list.length > 0) {
      out.push(`${label}: ${list.map((id) => `\`${id}\``).join(", ")}`);
    }
  };
  ids("Part of", input.parent !== undefined ? [input.parent] : undefined);
  ids("Plan", input.plan);
  ids("Runs", input.runs);
  ids("Decisions", input.decisions);
  if (input.rebasedOnto !== undefined) {
    out.push(`Rebased onto \`${input.rebasedOnto}\` and checked again.`);
  }
  out.push("");
  const checks = input.checks ?? [];
  if (checks.length === 0) {
    out.push(
      input.verdict.checks === "skipped" ? "Checks: none required." : "Checks: none recorded.",
    );
  } else {
    out.push("Checks:", "");
    for (const c of checks) {
      const name = c.name.replace(/`/g, "'");
      out.push(`- \`${name}\`: ${c.exit === 0 ? "passed" : `failed (exit ${c.exit})`}`);
    }
  }
  out.push("", `Acceptance check: ${ACCEPTANCE_WORDS[input.verdict.acceptance]}.`);
  const concerns = input.text.concerns ?? [];
  if (concerns.length > 0) {
    out.push("", "Open concerns:", "");
    for (const c of concerns) out.push(`- ${plain(c)}`);
  }
  return `${out.join("\n")}\n`;
}
