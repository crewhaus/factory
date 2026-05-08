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
 * The JSON report carries the same data programmatically so studio /
 * downstream consumers don't have to re-parse markdown.
 */
import type { Citation } from "@crewhaus/citation-tracker";

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
};

export type NumberedCitation = {
  readonly number: number;
  readonly url: string;
  readonly snippet: string;
  readonly sha256: string;
  readonly retrievedAt: string;
};

export type WriteReportArgs = {
  readonly goal: string;
  readonly branches: ReadonlyArray<BranchAnswer>;
  /** Append-ordered list of citations from the tracker. */
  readonly citations: ReadonlyArray<Citation>;
  readonly now?: () => Date;
};

/**
 * Number citations by URL on first appearance. Same URL appearing in
 * multiple branches reuses the first-assigned number; the snippet text
 * for the numbered entry comes from the FIRST citation against that URL.
 */
function numberCitations(citations: ReadonlyArray<Citation>): {
  numbered: NumberedCitation[];
  numberByUrl: Map<string, number>;
} {
  const numberByUrl = new Map<string, number>();
  const numbered: NumberedCitation[] = [];
  for (const c of citations) {
    if (numberByUrl.has(c.url)) continue;
    const n = numberByUrl.size + 1;
    numberByUrl.set(c.url, n);
    numbered.push({
      number: n,
      url: c.url,
      snippet: c.snippet,
      sha256: c.sha256,
      retrievedAt: c.retrievedAt,
    });
  }
  return { numbered, numberByUrl };
}

function citationNumbersForBranch(
  branch: BranchAnswer,
  numberByUrl: Map<string, number>,
): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const url of branch.citationUrls) {
    const n = numberByUrl.get(url);
    if (n === undefined) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  out.sort((a, b) => a - b);
  return out;
}

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
  if (args.numbered.length > 0) {
    lines.push("## Citations");
    lines.push("");
    for (const c of args.numbered) {
      lines.push(`[${c.number}] ${c.url}`);
      const trimmed = c.snippet.trim().replace(/\n+/g, " ");
      lines.push(`    ${trimmed}`);
    }
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
