/**
 * Citation numbering and the citations section's fixed text.
 *
 * Numbering is the load-bearing detail of the report (see the module
 * doc in `./index`): numbers are assigned by URL on first appearance in the
 * tracker's append-only citation log, so a number, once given, never moves.
 *
 * One owner, because two readers depend on it agreeing: the report renders
 * `[N]` against these numbers, and under `provability:` the research daemon
 * tells the model, at the moment `CiteFact` records a fact, which `[N]` that
 * fact will carry in the report (`withCitationNumbers`). That promise holds
 * only because the log is append-only and the numbering is a pure function
 * of its order.
 */
import type { Citation } from "@crewhaus/citation-tracker";

/**
 * Rendered in place of the `[N] url` list when the run recorded no citations.
 * Exported so a caller (or a test) can assert on the exact wording rather than
 * pattern-matching prose.
 */
export const NO_CITATIONS_NOTICE =
  "_No citations were recorded for this run — nothing above is anchored to a fetched source. Treat the findings as unverified._";

export type NumberedCitation = {
  readonly number: number;
  readonly url: string;
  readonly snippet: string;
  readonly sha256: string;
  readonly retrievedAt: string;
};

/**
 * Number citations by URL on first appearance. Same URL appearing in
 * multiple branches reuses the first-assigned number; the snippet text
 * for the numbered entry comes from the FIRST citation against that URL.
 */
export function numberCitations(citations: ReadonlyArray<Citation>): {
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

/**
 * The `## Citations` list a reader sees: `[N] url`, then the snippet on an
 * indented line. One renderer for both reports, so the gated report's visible
 * list is the ungated report's, line for line (the gate reads the separate
 * definitions block instead — see `./provability`).
 */
export function citationListLines(numbered: ReadonlyArray<NumberedCitation>): string[] {
  const lines: string[] = [];
  for (const c of numbered) {
    lines.push(`[${c.number}] ${c.url}`);
    const trimmed = c.snippet.trim().replace(/\n+/g, " ");
    lines.push(`    ${trimmed}`);
  }
  return lines;
}

/** The number `url` carries in a report written from `citations`, or undefined when it is not cited. */
export function citationNumber(
  citations: ReadonlyArray<Citation>,
  url: string,
): number | undefined {
  return numberCitations(citations).numberByUrl.get(url);
}

/** The numbers a branch's fetched URLs carry, sorted, each once. */
export function citationNumbersForBranch(
  branch: { readonly citationUrls: ReadonlyArray<string> },
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
