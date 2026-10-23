/**
 * Catalog R-orch `report-writer` — Section 23 RES.
 *
 * Assembles a research run's markdown + JSON report from:
 *   - the goal,
 *   - the planner's sub-questions,
 *   - one answer per branch,
 *   - the citation tracker.
 *
 * Citation numbering is the load-bearing detail: numbers are assigned by
 * URL on first appearance (NOT by the order the agent emitted citations
 * within a branch), so a re-run that takes a slightly different path
 * but ends up with the same citation set produces a byte-identical
 * citation block — the smoke's "deterministic ordering" assertion.
 *
 * The markdown report is structured for terminal `less` reading:
 *   # <goal>
 *
 *   ## <sub-question 1>
 *   <answer 1, with [N] markers>
 *
 *   ## <sub-question 2>
 *   <answer 2, with [N] markers>
 *
 *   ## Citations
 *   [1] <url>
 *       <snippet>
 *   [2] <url>
 *       <snippet>
 *
 * The `## Citations` section is emitted UNCONDITIONALLY: a run that cited
 * nothing renders the heading plus `NO_CITATIONS_NOTICE` rather than
 * dropping the section, so an unsourced report can never pass for a
 * sourced one.
 *
 * The JSON report carries the same data programmatically so studio /
 * downstream consumers don't have to re-parse markdown.
 *
 * 0.8.0 — a spec that declares `provability:` writes the report through
 * `writeProvableReport` (the `@crewhaus/report-writer/provability` subpath,
 * so an ungated bundle never loads the verifier) instead: the same report, gated —
 * a block of `[N]: <source>` definitions the citation grammar reads under the
 * title, verified against the tracker's sha256-pinned fetch cache, the same
 * visible `## Citations` list, then a `## Provability` section and the bundle
 * in the JSON. `writeReport` is untouched, so an ungated report is
 * byte-identical.
 */
import type { Citation } from "@crewhaus/citation-tracker";
import type { ProofBundle } from "@crewhaus/provability";
import {
  NO_CITATIONS_NOTICE,
  type NumberedCitation,
  citationListLines,
  citationNumbersForBranch,
  numberCitations,
} from "./citations";

export { NO_CITATIONS_NOTICE, type NumberedCitation, citationNumber } from "./citations";

export type BranchAnswer = {
  readonly question: string;
  readonly answer: string;
  /** URLs the agent emitted citations against during this branch. */
  readonly citationUrls: ReadonlyArray<string>;
};

export type Report = {
  readonly markdown: string;
  readonly json: ReportJson;
};

export type ReportJson = {
  readonly version: 1;
  readonly goal: string;
  readonly subAnswers: ReadonlyArray<{
    readonly question: string;
    readonly answer: string;
    readonly citationNumbers: ReadonlyArray<number>;
  }>;
  readonly citations: ReadonlyArray<NumberedCitation>;
  readonly generatedAt: string;
  /**
   * 0.8.0 (design/0.8.0-provability-release.md §5.4, §8) — the proof bundle
   * the report gate graded this report against. Present only on a report
   * written by `writeProvableReport` (the spec declares `provability:`);
   * `writeReport` never sets it, so an ungated report's JSON is unchanged.
   */
  readonly proof?: ProofBundle;
};

export type WriteReportArgs = {
  readonly goal: string;
  readonly branches: ReadonlyArray<BranchAnswer>;
  /** Append-ordered list of citations from the tracker. */
  readonly citations: ReadonlyArray<Citation>;
  readonly now?: () => Date;
};

function renderMarkdown(args: {
  goal: string;
  branches: ReadonlyArray<BranchAnswer>;
  numbered: ReadonlyArray<NumberedCitation>;
}): string {
  const lines: string[] = [];
  lines.push(`# ${args.goal}`);
  lines.push("");
  for (const b of args.branches) {
    lines.push(`## ${b.question}`);
    lines.push("");
    lines.push(b.answer.trim());
    lines.push("");
  }
  // The Citations section is UNCONDITIONAL. A research report that quietly
  // drops its citation footer reads as a finished, sourced document while
  // being nothing of the kind — for a shape whose premise is "must cite",
  // silence is the worst possible rendering of "cited nothing". Say it.
  lines.push("## Citations");
  lines.push("");
  if (args.numbered.length === 0) {
    lines.push(NO_CITATIONS_NOTICE);
  } else {
    lines.push(...citationListLines(args.numbered));
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function writeReport(args: WriteReportArgs): Report {
  const { numbered, numberByUrl } = numberCitations(args.citations);
  const subAnswers = args.branches.map((b) => ({
    question: b.question,
    answer: b.answer,
    citationNumbers: citationNumbersForBranch(b, numberByUrl),
  }));
  const now = args.now ?? (() => new Date());
  const json: ReportJson = {
    version: 1,
    goal: args.goal,
    subAnswers,
    citations: numbered,
    generatedAt: now().toISOString(),
  };
  const markdown = renderMarkdown({ goal: args.goal, branches: args.branches, numbered });
  return { markdown, json };
}
