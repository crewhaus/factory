/**
 * The research report gate (design/0.8.0-provability-release.md §5.4, §8).
 *
 * A research spec that declares `provability:` has its report verified
 * before it is served: `verifyDocument` — the same verifier the in-loop gate,
 * `ProvabilityPreflight` and `crewhaus provability check` call — runs over the
 * rendered report, with the run's own citation tracker as the evidence. The
 * tracker is the shape's sha256-pinned record of every body the crawler
 * fetched, so it is exactly the `EvidenceIndex` the `grounded` rung needs:
 * each fetched URL is a record whose body is the cached content.
 *
 * The gated report is the ungated one — its visible `## Citations` list line
 * for line, so a rendered report still shows its sources — with two
 * additions and two repairs, and only when the block is on (an ungated report
 * is `writeReport`'s, byte for byte):
 *
 *   - a block of definitions under the title, `[N]: <source> "<snippet>"`,
 *     the citation grammar the gate reads (the visible `[N] url` list is not
 *     it: the marker pattern refuses `[1] url` as a definition and reads it
 *     as a claim). Under the title, because nothing above it can be code: the
 *     grammar's fence reader pairs any two fence-like lines, so one branch's
 *     odd fence would hide definitions written after it from the gate. The
 *     snippet rides as the link title, which the claim extractor reads as
 *     part of the definition, and which a renderer shows as the marker's
 *     tooltip; a renderer hides the block and links every `[N]` through it.
 *     A `file://` source renders as its workspace-relative path, the form the
 *     grammar can locate (it reads `file:` as an unlocatable scheme), or as
 *     its absolute path outside the workspace — spelled so the grammar reads
 *     it back as that same file, or left as its URL when no spelling does
 *     (`pathSpelling`). After them, each assumption a branch declared, under
 *     a label no other branch uses (`[A1]: assume: …`, design §2), its text
 *     shown as the characters it is (`asText`: no tag of the branch's opens
 *     in the writer's lines);
 *   - a `## Provability` section after `## Citations` UNCONDITIONALLY — the
 *     `NO_CITATIONS_NOTICE` posture: an ungated report must never pass for a
 *     gated one, so the verdict is printed whatever it is, and `render:` (a
 *     per-answer footer setting) does not apply to it;
 *   - headings are one line each (a multi-line goal would otherwise put its
 *     second line in the body, where it reads as an uncited claim);
 *   - each branch answer is made self-contained: a definition line the model
 *     wrote is dropped, in whatever form it names its source, with the
 *     lines that are part of it (a line shaped like one that names no
 *     source, only a sentence, stays with its `[` escaped, read as the text
 *     it is), so the
 *     only definitions are the writer's, built from the tracker — a branch
 *     can neither point `[N]` at a page `CiteFact` never accepted nor define
 *     a number the report does not list, and an answer that also lists its
 *     sources reads as the same answer without them. An `assume:` line names
 *     no page, so it is not lost with them: it moves up into the writer's
 *     definitions, renamed with its markers so two branches' `[A1]` stay two
 *     assumptions, and is counted and capped by `assumptions` /
 *     `max_assumptions` as on every shape (design §2). A heading that would
 *     read as one of the writer's own sections (`## Provability`,
 *     `## Citations`, as a renderer shows it however it is spelled) is
 *     escaped, so the only verdict a reader sees is the writer's (§5.4).
 *     And a code fence the
 *     answer leaves open (an answer cut off mid-block) is closed at its end,
 *     so it cannot turn every later branch into code the claim reader skips.
 *     The JSON's `subAnswers` keep each answer as the model wrote it.
 *
 * What is verified is the title, the definitions and the branches — the text
 * before the `## Citations` trailer (`verifiedReportText` recovers it from a
 * served report). The trailer is the writer's own text, not claims the run
 * made, so it is not verified.
 *
 * Paths: the gate verifies path sources inside one root. That is the
 * workspace, unless the crawler was admitted to file roots outside it
 * (`retrieve.allowedFileRoots: [/srv/corpus]`); then it is the deepest
 * directory holding the workspace and those roots, and `./` paths are still
 * measured from the workspace. Only the writer defines a source, and a file
 * under none of the declared roots is defined by its URL, which no root
 * admits — so the wider root admits nothing the crawler's roots do not name.
 * Origins then read relative to that root.
 *
 * The branch agent can only mark a claim with the number its fact will carry
 * in the report if it is told that number, so the daemon wraps `CiteFact` to
 * say it (`withCitationNumbers`) and adds `researchProvabilityGuidance` to
 * each branch's instructions. The numbering is the report's own
 * (`./citations`): by URL on first appearance in the append-only citation
 * log, so a number given at `CiteFact` time is the number the report prints.
 *
 * Research's report gate runs once over the whole report, not per turn, so
 * `on_fail` is `halt` or `note` here (the compiler lowers a declared retry /
 * escalate to `note` with a warning, design §8; `on_fail: retry` per branch is
 * deferred, §12 item 3), `scope` has no turns to narrow to, and
 * `max_assumptions` caps the assumptions of the whole report. The tracker
 * holds fetched bodies only, so the evidence it gives reaches `grounded` at
 * most: a `checked` or `proven` floor has no execution or formal evidence to
 * bind to on this shape in 0.8.0. `provability.judge` is honoured: the
 * daemon passes the waiver judge in as `judgeWaiver`.
 */
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Citation, CitationTracker } from "@crewhaus/citation-tracker";
import {
  citationDefinitions,
  citationMarkers,
  classifyDefinition,
  codeSpanTest,
  definitionGloss,
  extractClaims,
} from "@crewhaus/claim-ledger";
import { EXIT_CODES, type FailureReport } from "@crewhaus/errors";
import type { IrProvability } from "@crewhaus/ir";
import {
  type EvidenceIndex,
  type EvidenceRecord,
  type HeadRefusal,
  type ProofBundle,
  type ProvabilityGradedSummary,
  type UnmetReason,
  type VerifyOptions,
  buildEvidenceIndex,
  claimReasons,
  normalizePath,
  normalizeUrl,
  renderMarkdownSection,
  summarizeBundle,
  unverifiedBundle,
  verifyDocument,
} from "@crewhaus/provability";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  NO_CITATIONS_NOTICE,
  type NumberedCitation,
  citationListLines,
  citationNumber,
  citationNumbersForBranch,
  numberCitations,
} from "./citations";
import type { BranchAnswer, Report, ReportJson, WriteReportArgs } from "./index";

/** The lowered `provability:` block, as the research IR carries it. */
export type ReportProvabilityConfig = IrProvability;

/** Where the gate's path sources resolve (see the module doc). */
export type ReportGateRoots = {
  /** The harness root (default `process.cwd()`). */
  readonly workspaceRoot?: string;
  /**
   * The crawler's file roots, resolved (`retrieve.allowedFileRoots`): a file
   * source under one is admissible even outside the workspace.
   */
  readonly fileRoots?: ReadonlyArray<string>;
};

export type ReportProvabilityOptions = ReportGateRoots & {
  readonly config: ReportProvabilityConfig;
  /**
   * The run's evidence, or the function that builds it: the daemon passes
   * `() => evidenceFromTracker(tracker, roots)`, so a failure building the
   * index happens inside the gate's guard and leaves the report
   * `unverified` (design §5.1) rather than unwritten. Built with the same
   * roots as these options, or file sources will not key alike.
   */
  readonly evidence: EvidenceIndex | (() => EvidenceIndex);
  /** `sources.resolve: head` — one guarded HEAD's status (absent ⇒ such sources are `unresolved`). */
  readonly resolveHead?: (url: string) => Promise<number | HeadRefusal | undefined>;
  /**
   * `provability.judge` — the paraphrase-waiver judge (evaluation-service's
   * `createWaiverJudge`), asked only for a `grounded` miss on wording alone
   * (design §6.2). Absent ⇒ no waiver.
   */
  readonly judgeWaiver?: VerifyOptions["judgeWaiver"];
};

export type WriteProvableReportArgs = WriteReportArgs & {
  readonly provability: ReportProvabilityOptions;
};

/** A gated report: the report, the bundle it was graded with, and the bundle's trace summary. */
export type ProvableReport = Report & {
  readonly json: ReportJson & { readonly proof: ProofBundle };
  readonly proof: ProofBundle;
  /** What the daemon's `provability_graded` line carries (design §5.3). */
  readonly summary: ProvabilityGradedSummary;
};

/** The name every tracker record is filed under: the crawler tool that fetched it. */
const SOURCE_TOOL = "Source";

/** The resolved roots: where `./` is measured from, and what every path must lie under. */
type Roots = {
  /** `VerifyOptions.baseDir`: the workspace. */
  readonly workspace: string;
  /** `VerifyOptions.workspaceRoot`: the workspace, or the directory over it and the file roots. */
  readonly root: string;
  /** The declared file roots outside the workspace, as named and as real paths. */
  readonly outside: ReadonlyArray<string>;
};

function realOf(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** The deepest directory every path lies under; undefined when there is none (two drives). */
function commonAncestor(paths: ReadonlyArray<string>): string | undefined {
  let common: string | undefined;
  for (const path of paths) {
    if (common === undefined) {
      common = path;
      continue;
    }
    while (!within(common, path)) {
      const parent = dirname(common);
      if (parent === common) return undefined;
      common = parent;
    }
  }
  return common;
}

/**
 * The gate's roots. The workspace alone unless a file root lies outside it;
 * then the deepest directory over the workspace and those roots, real paths
 * included — the verifier holds a source to the root's REAL path, so a root
 * reached through a link (`/tmp` on macOS) must be under it both ways.
 */
function gateRoots(opts: ReportGateRoots): Roots {
  const workspace = resolve(opts.workspaceRoot ?? process.cwd());
  const named = (opts.fileRoots ?? [])
    .map((root) => resolve(workspace, root))
    .filter((root) => normalizePath(root, { workspaceRoot: workspace }) === undefined);
  if (named.length === 0) return { workspace, root: workspace, outside: [] };
  const withReal = (paths: ReadonlyArray<string>): string[] =>
    paths.flatMap((path) => {
      const real = realOf(path);
      return real !== undefined && real !== path ? [path, real] : [path];
    });
  const outside = withReal(named);
  const root = commonAncestor([...withReal([workspace]), ...outside]);
  return root === undefined
    ? { workspace, root: workspace, outside: [] }
    : { workspace, root, outside };
}

/**
 * The path a `file://` source's definition names: `./<path>` inside the
 * workspace, or its absolute path outside it — under a declared file root
 * the gate's root covers it, and anywhere else, with the root still the
 * workspace, the gate says `path_outside_workspace`. Undefined for a file
 * under no declared root while the root is widened (the crawler never
 * fetches one; the wider root admits only what the crawler's roots name),
 * and for a URL that does not parse.
 */
function filePathOf(url: string, roots: Roots): string | undefined {
  const rel = normalizePath(url, { workspaceRoot: roots.workspace });
  if (rel !== undefined && rel !== ".") return `./${rel}`;
  let abs: string;
  try {
    abs = fileURLToPath(url);
  } catch {
    return undefined;
  }
  const admitted = roots.root === roots.workspace || roots.outside.some((r) => within(r, abs));
  return admitted ? abs : undefined;
}

/**
 * `path` as a definition writes it so the citation grammar reads back that
 * same file: as it is (in `<…>` when it holds a blank), or with `%` and `#`
 * percent-encoded. Asked of `classifyDefinition` itself, so the spelling
 * cannot drift from the reader the gate uses. The grammar splits a path at
 * `#` (`notes #2.md` names `notes ` and a fragment), so a name holding one
 * has no plain spelling, and the encoded one names it only where the
 * grammar decodes a path's escapes; undefined when neither names it — a
 * definition then names no file at all rather than another one.
 */
function pathSpelling(path: string): string | undefined {
  const encoded = path.replace(/[%#]/g, (c) => (c === "%" ? "%25" : "%23"));
  for (const spelled of [path, encoded]) {
    const written = /\s/.test(spelled) ? `<${spelled}>` : spelled;
    const ref = classifyDefinition(written);
    if (ref.kind === "path" && ref.fragment === undefined && ref.path === path) return written;
  }
  return undefined;
}

/**
 * Where a source's definition points: an `http(s)` URL as the tracker
 * recorded it; a `file://` URL as its path (`filePathOf`), spelled the way
 * the grammar reads back (`pathSpelling`). A file no root admits, or whose
 * name no spelling reaches, keeps its URL, which the gate reads as a scheme
 * it cannot locate (`not_locatable`) — never as a path to some other file.
 */
function destinationOf(url: string, roots: Roots): string {
  if (!/^file:\/\//i.test(url)) return url;
  const path = filePathOf(url, roots);
  return (path !== undefined ? pathSpelling(path) : undefined) ?? url;
}

/**
 * A fetched URL's origin, keyed exactly as the verifier will key the
 * definition the report renders for it: the normalized URL, or the file's
 * path (`filePathOf`), resolved the way `verifyDocument` resolves it.
 */
function sourceOrigin(url: string, roots: Roots): string | undefined {
  if (/^https?:\/\//i.test(url)) return normalizeUrl(url);
  if (!/^file:\/\//i.test(url)) return undefined;
  const path = filePathOf(url, roots);
  if (path === undefined) return undefined;
  return normalizePath(path, { workspaceRoot: roots.root, baseDir: roots.workspace });
}

/**
 * The research run's evidence index: one record per URL the crawler fetched,
 * whose body is the tracker's cached copy. A body is admitted only when it
 * still hashes to the digest the fetch recorded — the cache is a file on
 * disk, and a body that no longer matches is not the one the run read. A
 * fetch whose cache is gone, or cannot be read, is not evidence either (its
 * citations read `not_fetched`: the run can no longer show the body it read).
 * Pass `writeProvableReport` the same roots.
 */
export function evidenceFromTracker(
  tracker: Pick<CitationTracker, "listFetches" | "getFetchedContent">,
  opts: ReportGateRoots = {},
): EvidenceIndex {
  const roots = gateRoots(opts);
  const records: EvidenceRecord[] = [];
  tracker.listFetches().forEach((fetch, i) => {
    let body: string | undefined;
    try {
      body = tracker.getFetchedContent(fetch.url);
    } catch {
      // A cache entry that cannot be read (a directory, no permission) is a
      // body the run can no longer show, exactly like one that is gone.
      return;
    }
    if (body === undefined) return;
    if (createHash("sha256").update(body, "utf8").digest("hex") !== fetch.sha256) return;
    const origin = sourceOrigin(fetch.url, roots);
    records.push({
      toolUseId: `fetch_${i + 1}`,
      toolName: SOURCE_TOOL,
      input: { uri: fetch.url },
      content: body,
      isError: false,
      origins: origin !== undefined ? [origin] : [],
    });
  });
  return buildEvidenceIndex(records);
}

/**
 * The snippet as a Markdown link title: one line, backslashes and brackets
 * escaped (a `[3]` inside a quote must not read as a marker, and a trailing
 * `\` must not escape the closing delimiter — CommonMark would then not end
 * the title, and the line would render as prose while the grammar still read
 * it as a definition), in whichever of the three title delimiters the text
 * does not contain — a title that ends early would put the rest of the
 * snippet on the line as prose. A snippet holding all three has its double
 * quotes swapped for single ones (the JSON keeps it verbatim).
 */
function linkTitle(snippet: string): string {
  const text = snippet
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/[[\]]/g, (c) => `\\${c}`);
  if (text === "") return "";
  if (!text.includes('"')) return ` "${text}"`;
  if (!text.includes("'")) return ` '${text}'`;
  if (!/[()]/.test(text)) return ` (${text})`;
  return ` "${text.replace(/"/g, "'")}"`;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * A line the citation grammar, or a renderer, would take for a definition —
 * `[3]: …`, `[^a]: …` — and what follows its label. At any indent, so it
 * holds every line the grammar's own pattern (three spaces at most) reads.
 */
const DEFINITION_LINE = /^(\s*)\[\^?[\w.-]+\]:(.*)$/;

/**
 * The same line inside a list item or a block quote — `- [1]: …`,
 * `1. [^1]: …`, `> [1]: …` — and what follows its label. The grammar reads
 * no definition there, but a renderer does (a link reference definition may
 * sit in any container), and a source listed so is still a source the
 * branch wrote. Each container marker opens with its own character and
 * takes the blanks after it, so a run of markers (`> > -   -`) splits one
 * way only: no backtracking blow-up on a line of them that never reaches a
 * label.
 */
const CONTAINED_DEFINITION_LINE =
  /^([ \t]*(?:(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t]))[ \t]*)+)\[\^?[\w.-]+\]:(.*)$/;

const isDefinitionLine = (line: string): boolean =>
  DEFINITION_LINE.test(line) || CONTAINED_DEFINITION_LINE.test(line);

/** A fence line at any indent: never taken for a destination, so never dropped as one. */
const FENCE_LINE = /^\s*(?:`{3,}|~{3,})/;

/**
 * A destination alone, with no title after it: what a link reference
 * definition may follow with its title on the next line.
 */
const DESTINATION_ONLY = /^(?:<[^<>]*>|(?:(?:doi|tool|proof):\s*)?\S+)$/i;

/** A line that is a link title and nothing else: `"…"`, `'…'` or `(…)`. */
const TITLE_LINE = /^\s*(?:"[^"]*"|'[^']*'|\([^)]*\))\s*$/;

/**
 * A source named anywhere in a definition's text, not only at its start —
 * `[^1]: Acme, "Refund policy", https://…` and `[1]: Acme Refund Policy —
 * https://…` list a source as often as `[1]: https://… "…"` does: a URI with
 * `//` (`https:`, `file:`), one of the few schemes without it, a `<…>`
 * autolink (a scheme, or an e-mail address), a DOI, or a `./` / `../` path.
 * Each after a boundary, so "Revenue:12% higher" and "Hotel:5 stars" name
 * nothing and stay the sentences they are.
 */
const SOURCE_ANYWHERE = new RegExp(
  [
    String.raw`(?:^|[^\w+.-])(?:[a-z][a-z0-9+.-]*:\/\/|(?:mailto|urn|tel|news):)[^\s<>]`,
    String.raw`<[a-z][a-z0-9+.-]{1,31}:[^\s<>]*>`,
    String.raw`<[^\s<>@]+@[^\s<>@]+>`,
    String.raw`(?:^|[^\w./-])10\.\d{4,9}\/[^\s<>]`,
    String.raw`(?:^|[\s(<"'])\.{1,2}\/[^\s<>]`,
  ].join("|"),
  "i",
);

/**
 * Does `source` open with one — a URL, a path, a DOI, a `tool:` or `proof:`
 * id, an `assume:` (`classifyDefinition`), or a URI of a scheme the gate
 * cannot locate (`file:///…`, `mailto:…`)? What a destination on the line
 * under a bare label must do to be taken as one.
 */
function opensWithSource(source: string): boolean {
  if (classifyDefinition(source).kind !== "text") return true;
  // A scheme with `//`, or one of the few without it, and something after:
  // "Revenue:12% higher" names nothing.
  return /^<?(?:[a-z][a-z0-9+.-]*:\/\/|(?:mailto|urn|tel|news):)\S/i.test(source);
}

/**
 * Does a definition's text name a source — open with one, name one
 * anywhere in it (`SOURCE_ANYWHERE`), or, under `sources.bibliographic`, be
 * a free-text reference — rather than say a sentence (`[1]: Refunds take 14
 * days.`, prose a reader sees)? Generous on purpose: what it calls a source
 * is dropped, and dropped text is neither served nor verified, so reading a
 * sentence as a source costs the answer a line, never the gate a claim.
 */
function namesSource(text: string, bibliographic: boolean): boolean {
  return opensWithSource(text) || bibliographic || SOURCE_ANYWHERE.test(text);
}

/**
 * CommonMark's link reference definition after its label: a destination
 * (`<…>`, or one run of non-blanks) and at most a title. A renderer ends one
 * on its line, or on the next when its title sits there, whatever scheme the
 * destination names — `mailto:…` and `file:///…` as much as `https://…`.
 */
const LINK_REFERENCE = /^(?:<[^<>\r\n]*>|[^\s<]\S*)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?$/;

/**
 * A complete link reference definition, under a `[x]:` label: a destination
 * the grammar locates and at most a title (`definitionGloss` is empty), or
 * any destination CommonMark takes for one (`LINK_REFERENCE`) that names a
 * source. It ends on its line, or on the next when its title sits there, so
 * the lines under it are the answer's — indented or not, a renderer shows
 * them as a paragraph of their own. A footnote (`[^x]:`) is never complete:
 * the lines under it are its content.
 */
function completeDefinition(footnote: boolean, rest: string, bibliographic: boolean): boolean {
  if (footnote) return false;
  const ref = classifyDefinition(rest);
  if (ref.kind !== "text" && ref.kind !== "assume" && definitionGloss(rest, ref) === "")
    return true;
  return LINK_REFERENCE.test(rest) && namesSource(rest, bibliographic);
}

/** A link title alone on the line after a destination alone: part of that definition. */
const titleBelow = (destination: string, below: string | undefined): boolean =>
  below !== undefined && DESTINATION_ONLY.test(destination) && TITLE_LINE.test(below);

/** The column a line's indent reaches, a tab stopping at the next multiple of 4 as in CommonMark. */
function columnOf(indent: string): number {
  let column = 0;
  for (const ch of indent) column = ch === "\t" ? column + 4 - (column % 4) : column + 1;
  return column;
}

/**
 * What a line opens, read after its indent: a list item, a block quote, an
 * ATX heading or a thematic break. Each interrupts a paragraph, so none
 * continues a definition's text — under `  - [1]: Acme — https://…`, the
 * `  - Refunds take 14 days [1].` below is the item's sibling, holding the
 * answer's own claim, not the rest of the source.
 */
const OPENS_BLOCK =
  /^(?:[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|>|#{1,6}(?:[ \t]|$)|(?:\*[ \t]*){3,}$|(?:-[ \t]*){3,}$|(?:_[ \t]*){3,}$)/;

/** Where a definition-shaped line sits, as `definitionBody` measures the lines under it. */
type DefinitionPlace = {
  /** The content column of the block holding it: 0 at the top level, the label's column in a list item or quote. */
  readonly content: number;
  /** The least indent a line under it needs to be indented under it: past the label's own indent, or into its container. */
  readonly indentedFrom: number;
};

/**
 * Does `line` carry a citation marker, `[3]` or `[^a]`, as the grammar reads
 * one (claim-ledger's `citationMarkers` — not a definition's `[3]:`, not a
 * link's `[text](…)`)? A line that carries one is a claim the answer cited,
 * never the rest of a source's text.
 */
const carriesMarker = (line: string): boolean => citationMarkers(line).length > 0;

/** Punctuation a text ends with when it goes on into the next line: `Acme,`, `policy —`, `page -`. */
const RUNS_ON_PUNCTUATION = /(?:[,;:(&–—]|\s-)$/;

/**
 * Does a definition's text, `text` so far, run on into the unindented line
 * under it — `[1]: "Refund policy" — Acme's statement on returns and` over
 * `refunds, https://…`, or `[1]: Acme — https://…, retrieved` over
 * `October 2026.`? It does when it stops mid-phrase: on a comma, a dash or
 * an opening bracket, or on a word that is not itself the source. One that
 * ends a sentence, or ends on its source (`[^1]: Acme — https://…`), has
 * ended, and so has every text before a line holding a marker.
 */
function runsOn(text: string, next: string): boolean {
  if (text === "" || carriesMarker(next)) return false;
  // Only the text's end is read — its last two code units, its last word —
  // so a long definition costs each line under it its own length, never
  // the length of everything above it (design §10).
  const end = text.slice(-2);
  if (RUNS_ON_PUNCTUATION.test(end)) return true;
  let word = text.length;
  while (word > 0 && !/\s/.test(text[word - 1] as string)) word--;
  if (namesSource(text.slice(word), false)) return false;
  return /[\p{L}\p{N}]$/u.test(end);
}

/**
 * The lines under definition line `i` that continue it, with no blank line
 * between: the rest of the paragraph a line that is not a complete
 * definition starts, or a footnote's content. Taken only as far as a
 * renderer would take them:
 *
 *   - a blank line, a definition or a fence ends it, and so does a line
 *     that opens a block (`OPENS_BLOCK`) within four columns of the
 *     content column — a sibling list item, the parent's next item, a
 *     quote, a heading. Further in, CommonMark reads it as text of the
 *     paragraph (an indented code block cannot interrupt one), and in a
 *     footnote as its content;
 *   - a line indented under the label (`indentedFrom`) continues it;
 *   - a line further out, a lazy continuation in CommonMark's terms,
 *     continues it when it opens with a source — `[^1]: Acme,
 *     "Refund policy",` over an unindented URL — or when the text above it
 *     runs on into it (`runsOn`): a title wrapped onto the line that names
 *     its source, or a source's text wrapped past it. The first line under
 *     a bare label continues it when it names a source anywhere (`[^1]:`
 *     over `Acme, "Refund policy", https://…`, the line the grammar reads
 *     as that label's source). A sentence further out stays the answer's,
 *     whatever the label says.
 *
 * `label` is the text on the definition line after its label.
 */
function definitionBody(
  pieces: ReadonlyArray<string>,
  i: number,
  place: DefinitionPlace,
  label: string,
): number[] {
  const below: number[] = [];
  // The end of the text so far, all `runsOn` reads: the last line taken,
  // after the blank that joins it to the text above. Kept whole, the text
  // was re-trimmed on every line — quadratic in the definition's length.
  let end = label;
  for (let j = i + 2; j < pieces.length; j += 2) {
    const line = pieces[j] as string;
    if (line.trim() === "" || isDefinitionLine(line) || FENCE_LINE.test(line)) break;
    const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
    const column = columnOf(indent);
    if (column < place.content + 4 && OPENS_BLOCK.test(line.slice(indent.length))) break;
    const trimmed = line.trim();
    if (column < place.indentedFrom) {
      const source =
        label === "" && below.length === 0
          ? namesSource(trimmed, false)
          : opensWithSource(trimmed) || runsOn(end, trimmed);
      if (!source) break;
    }
    below.push(j);
    end = end === "" ? trimmed : ` ${trimmed}`;
  }
  return below;
}

/**
 * A branch answer without the definitions it wrote: only the writer defines
 * a number (see the module doc).
 *
 * A line that defines a source — at the top level, in a list item or in a
 * block quote — is dropped, with whatever it shows past the
 * source and the lines that are part of it: a title on the line under a
 * destination, the destination on the line under a bare label, and the
 * lines that continue a label (`definitionBody`) — a footnote's content,
 * or the rest of the paragraph a line that is not a complete definition
 * starts, never past the list item or quote it sits in. Whether the label
 * names a source is asked of all of that text, so `[^1]: Acme refund
 * policy page,` over an indented URL is a source too. Kept in any form, it
 * is either a definition or text the gate reads as a sentence (escaped,
 * `[1]: Acme — https://…` is the uncited claim "\: Acme — https://…"), and
 * a correct answer that ends with its sources, as answers conventionally
 * do, would fail on them. Dropped from code samples too: the grammar's loose
 * fence reader can call prose a line a renderer shows as code, so a
 * definition anywhere would define. A label with nothing after it (`[c]:`
 * over a blank line, a fence or an unindented sentence) goes alone, and the
 * sentence under it stays to be read.
 *
 * A definition-shaped line that names no source — `[1]: Refunds take 14
 * days.` — is a sentence a reader sees, so it stays, its `[` escaped at the
 * top level: it renders, and the gate reads it, as the text it is.
 *
 * Lines break where the grammar's `^` breaks them (`\u2028` and `\u2029`
 * too), so no definition it would read starts mid-line here.
 *
 * Also returns, by label, the whole text of each top-level definition it
 * drops (its lines joined, the first per label): how `branchAssumptions`
 * reads an `assume:` that wraps onto a second line.
 */
function withoutDefinitions(
  answer: string,
  bibliographic: boolean,
): { readonly text: string; readonly dropped: ReadonlyMap<string, string> } {
  const dropped = new Map<string, string>();
  const pieces = answer.split(/(\r\n|\r|\n|\u2028|\u2029)/);
  const drop = new Set<number>();
  for (let i = 0; i < pieces.length; i += 2) {
    const line = pieces[i] as string;
    const top = DEFINITION_LINE.exec(line);
    const m = top ?? CONTAINED_DEFINITION_LINE.exec(line);
    if (m === null) continue;
    const indent = m[1] as string;
    const rest = (m[2] as string).trim();
    const footnote = line.startsWith("[^", indent.length);
    const record = (text: string): void => {
      const label = top !== null ? LABEL.exec(line.slice(indent.length))?.[1] : undefined;
      if (label !== undefined && !dropped.has(label)) dropped.set(label, text);
    };
    if (rest !== "" && completeDefinition(footnote, rest, bibliographic)) {
      drop.add(i);
      record(rest);
      if (titleBelow(rest, pieces[i + 2])) {
        drop.add(i + 2);
        i += 2;
      }
      continue;
    }
    // The label's text runs on into the lines under it — never past its own
    // list item or quote: a sibling item under `  - [1]: …` is the answer's.
    const column = columnOf(indent);
    const below = definitionBody(
      pieces,
      i,
      top !== null
        ? { content: 0, indentedFrom: column + 1 }
        : { content: column, indentedFrom: column },
      rest,
    );
    if (rest === "") {
      drop.add(i);
      // A link reference definition may put its destination on the line
      // under the label, and its title under that, and then ends there. A
      // footnote's content runs on, and a bare label over a sentence, a
      // heading or a fence goes alone (`definitionBody` stops before it).
      const first = below[0];
      const destination = first === undefined ? "" : (pieces[first] as string).trim();
      if (first !== undefined && completeDefinition(footnote, destination, bibliographic)) {
        drop.add(first);
        record(destination);
        i = first;
        if (titleBelow(destination, pieces[i + 2])) {
          drop.add(i + 2);
          i += 2;
        }
        continue;
      }
    }
    const text = [rest, ...below.map((j) => (pieces[j] as string).trim())].join(" ").trim();
    if (text !== "" && namesSource(text, bibliographic)) {
      drop.add(i);
      record(text);
      for (const j of below) drop.add(j);
      i = below[below.length - 1] ?? i;
    } else if (rest !== "" && top !== null) {
      // In a list item or a quote the grammar reads no definition, so the
      // sentence is read as written; at the top level the `\` keeps it one.
      pieces[i] = `${indent}\\${line.slice(indent.length)}`;
    }
  }
  if (drop.size === 0) return { text: pieces.join(""), dropped };
  // Each kept line joins the last kept one by the break that stood before
  // it; the blank lines a drop leaves at either end go.
  const out: string[] = [];
  for (let i = 0; i < pieces.length; i += 2) {
    if (drop.has(i)) continue;
    if (out.length > 0) out.push(pieces[i - 1] as string);
    out.push(pieces[i] as string);
  }
  const text = out
    .join("")
    .replace(/^(?:[^\S\r\n\u2028\u2029]*(?:\r\n|\r|\n|\u2028|\u2029))+/, "")
    .trimEnd();
  return { text, dropped };
}

/** A definition line's label, read after its indent: `A1` of `[A1]: …` and of `[^A1]: …`. */
const LABEL = /^\[\^?([\w.-]+)\]:/;

/** A branch's declared assumption: the label its markers use, and what it assumes. */
type BranchAssumption = { readonly label: string; readonly text: string };

/**
 * The assumptions a branch declared, in the order it declared them: each
 * definition the citation grammar reads in its answer (`citationDefinitions`:
 * outside code, the first per label) whose source is `assume:`, read with
 * the whole text `withoutDefinitions` dropped for it, so one that wraps onto
 * a second line is read whole. A number is the report's own (the one
 * `CiteFact` gave), so an `assume:` under one is not carried: it goes with
 * the other definitions the branch wrote.
 */
function branchAssumptions(
  answer: string,
  dropped: ReadonlyMap<string, string>,
): BranchAssumption[] {
  const out: BranchAssumption[] = [];
  for (const [label, source] of citationDefinitions(answer)) {
    if (/^\d+$/.test(label)) continue;
    const whole = classifyDefinition(dropped.get(label) ?? source);
    const ref = whole.kind === "assume" ? whole : classifyDefinition(source);
    if (ref.kind === "assume") out.push({ label, text: oneLine(ref.text) });
  }
  return out;
}

/** Every marker id in `text` outside code: `A1` of `[A1]` and of `[^A1]`. */
function markerIds(text: string): Set<string> {
  const inCode = codeSpanTest(text);
  const ids = new Set<string>();
  for (const { marker, at } of citationMarkers(text)) {
    if (!inCode(at)) ids.add(marker);
  }
  return ids;
}

/**
 * `text` with each marker outside code whose id `rename` maps renamed, its
 * caret kept — the markers the grammar reads (claim-ledger's
 * `citationMarkers`), so what is renamed is what every checker binds.
 */
function renameMarkers(text: string, rename: ReadonlyMap<string, string>): string {
  if (rename.size === 0) return text;
  const inCode = codeSpanTest(text);
  let out = "";
  let from = 0;
  for (const { marker, caret, at, end } of citationMarkers(text)) {
    const to = rename.get(marker);
    if (to === undefined || inCode(at)) continue;
    out += `${text.slice(from, at)}[${caret ? "^" : ""}${to}]`;
    from = end;
  }
  return out + text.slice(from);
}

/**
 * Every branch's assumptions under labels unique in the report, and each
 * branch's text with its markers renamed to match (design §2: assumptions
 * are first-class and always counted). Branches are independent agents, so
 * each numbers its own from `[A1]`; joined as written, the grammar would
 * bind every branch's `[A1]` to the first branch's text, and count the
 * second as past a cap that branch never reached. So they are renamed in
 * order, `A1`, `A2`, …, past any id a branch cites without declaring it: a
 * marker that is not its own branch's assumption keeps its id, and no
 * assumption is renamed onto it.
 */
function hoistAssumptions(
  branches: ReadonlyArray<{
    readonly text: string;
    readonly assumptions: ReadonlyArray<BranchAssumption>;
  }>,
): { readonly texts: string[]; readonly assumptions: BranchAssumption[] } {
  const taken = new Set<string>();
  for (const b of branches) {
    const own = new Set(b.assumptions.map((a) => a.label));
    for (const id of markerIds(b.text)) if (!own.has(id)) taken.add(id);
  }
  let next = 1;
  const assumptions: BranchAssumption[] = [];
  const texts = branches.map((b) => {
    const rename = new Map<string, string>();
    for (const a of b.assumptions) {
      while (taken.has(`A${next}`)) next++;
      const label = `A${next++}`;
      rename.set(a.label, label);
      assumptions.push({ label, text: a.text });
    }
    return renameMarkers(b.text, rename);
  });
  return { texts, assumptions };
}

/**
 * The writer's own sections (design §5.4). A heading reads as one when the
 * first word a reader sees in it is one of these, in any case.
 */
const WRITER_SECTIONS = ["provability", "citations"] as const;

/**
 * Where a reading of a heading's text has got to in the names, one bit per
 * place: before each letter of each name, and past each name's end. A set of
 * readings is one number, and seeing a letter is one shift. `first` holds
 * each name's start, `last` each name's end, `before` the places before
 * each letter, `along` every place before a letter (what any one character
 * may move past).
 */
const PLACES = (() => {
  let first = 0;
  let last = 0;
  let bit = 0;
  const before = new Map<string, number>();
  for (const name of WRITER_SECTIONS) {
    first |= 1 << bit;
    for (const letter of name) before.set(letter, (before.get(letter) ?? 0) | (1 << bit++));
    last |= 1 << bit++;
  }
  return { first, last, along: [...before.values()].reduce((a, b) => a | b, 0), before };
})();

/** A reading that has seen a whole name, then a break: the heading reads as a writer section. */
const NAMED = 1 << 30;

/** The readings after a letter or digit a reader sees: each that expects it moves past it. */
const sawLetter = (s: number, letter: string): number =>
  ((s & (PLACES.before.get(letter) ?? 0)) << 1) | (s & NAMED);

/**
 * The readings after a blank or a mark a reader sees: one before a name has
 * not started (`*:* Provability` opens with the name), one past a name's end
 * has read it, and one mid-name has read some other word.
 */
const sawBreak = (s: number): number =>
  (s & (PLACES.first | NAMED)) | ((s & PLACES.last) !== 0 ? NAMED : 0);

/** The readings after one character that may show as anything, or as nothing. */
const sawAny = (s: number): number => s | ((s & PLACES.along) << 1) | sawBreak(s);

/** Characters that show as nothing, or at most as a break: zero-width ones, the soft hyphen, format marks. */
const INVISIBLE = /^[\p{Default_Ignorable_Code_Point}\p{Cf}]$/u;

const isAsciiLetter = (code: number): boolean => (code | 0x20) >= 0x61 && (code | 0x20) <= 0x7a;

/**
 * The readings after a character a reader sees, as the letters it reads as:
 * compatibility forms folded (`ℙ` is P, `㏚` is PR), lower case, accents
 * dropped (`ö` is o).
 */
function sawChar(s: number, ch: string): number {
  if (s === 0) return 0;
  const code = ch.charCodeAt(0);
  if (code < 0x80) {
    // `| 0x20` lowers a letter and leaves a digit as it is.
    const alnum = isAsciiLetter(code) || (code >= 0x30 && code <= 0x39);
    return alnum ? sawLetter(s, String.fromCharCode(code | 0x20)) : sawBreak(s);
  }
  if (INVISIBLE.test(ch)) return s | sawBreak(s);
  let out = s;
  const letters = ch.normalize("NFKD").toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
  for (const c of letters) out = /[\p{L}\p{N}]/u.test(c) ? sawLetter(out, c) : sawBreak(out);
  return out;
}

/**
 * What a heading's text may be inside of, as a renderer reads it: its text,
 * a character reference's name, a tag (`<` read, `</` read, the tag, a quoted
 * attribute value), a comment or declaration, a link's destination or label.
 * All but the text are hidden.
 */
const IN_TEXT = 0;
const IN_REF_NAME = 1;
const IN_LT = 2;
const IN_LT_SLASH = 3;
const IN_TAG = 4;
const IN_TAG_DQ = 5;
const IN_TAG_SQ = 6;
const IN_COMMENT = 7;
const IN_DESTINATION = 8;
const IN_LABEL = 9;
const MODES = 10;

/** A numeric character reference, read as a browser reads one: every digit, the `;` optional. */
const NUMERIC_REF = /&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));?/y;

/** Markdown a renderer may take as markup and hide, or show: emphasis, strikethrough, code, escapes, marks, inserts, superscripts, an image's `!`, a label's `]`. */
const MAY_HIDE = new Set(["*", "_", "~", "`", "\\", "=", "^", "+", "!", "]"]);

/** The characters that end a hidden reading: a tag's `>` and quotes, a comment's `>`, a destination's `)`, a label's `]`. */
const ENDS_HIDDEN = /["'>)\]]/g;

/** The character a numeric reference shows; a C1 control is a windows-1252 letter to a browser and nothing to markdown, so anything. */
function sawReference(s: number, ref: RegExpExecArray): number {
  const value = ref[1] !== undefined ? Number.parseInt(ref[1], 16) : Number(ref[2]);
  if (value >= 0x80 && value <= 0x9f) return sawAny(s);
  const valid = value > 0 && value <= 0x10ffff && (value < 0xd800 || value > 0xdfff);
  return sawChar(s, valid ? String.fromCodePoint(value) : "\ufffd");
}

/**
 * Reads text as every renderer might show it, for one question: does a
 * heading in it read as one of the writer's sections? Each way a construct
 * can render is a reading, kept apart by what it is inside of (`MODES`) and
 * folded into one set of places per mode, so the text is read once, in
 * linear time, whatever it holds (design §10). What a renderer may hide is
 * read both hidden and shown — emphasis and the like (`MAY_HIDE`), and a
 * `<…>` read as markup (a tag to its `>` outside quotes, a comment to some
 * `>`) and as text; a named reference (`&Popf;`, `&shy;`, `&ocirc` with no
 * `;`) shows any one character or none, its name hidden as far as it might
 * run; a numeric one shows its character, decoded; an invisible character
 * shows nothing, or a break. A link's destination and label are hidden as
 * far as any `)` or `]`.
 *
 * `start` begins a reading where a heading may begin; `names` says whether
 * one has read a writer section's name as the heading's first word — on a
 * break after it, or at the end of what was read.
 */
function sectionReader(): {
  readonly start: () => void;
  readonly reset: () => void;
  readonly read: (text: string) => void;
  readonly names: () => boolean;
} {
  let modes = new Array<number>(MODES).fill(0);
  let next = new Array<number>(MODES).fill(0);
  let named = false;
  const add = (mode: number, s: number): void => {
    next[mode] = (next[mode] as number) | s;
    if ((s & NAMED) !== 0) named = true;
  };
  const inText = (s: number, ch: string): void => {
    if (ch === "<") {
      add(IN_TEXT, sawBreak(s));
      add(IN_LT, s);
    } else if (ch === "&") {
      add(IN_TEXT, sawBreak(s));
      add(IN_REF_NAME, sawAny(s));
    } else if (ch === "(") {
      add(IN_TEXT, sawBreak(s));
      add(IN_DESTINATION, s);
    } else if (ch === "[") {
      add(IN_TEXT, s | sawBreak(s));
      add(IN_LABEL, s);
    } else {
      add(IN_TEXT, MAY_HIDE.has(ch) ? s | sawBreak(s) : sawChar(s, ch));
    }
  };
  const step = (mode: number, s: number, ch: string, code: number): void => {
    switch (mode) {
      case IN_TEXT:
        inText(s, ch);
        return;
      case IN_REF_NAME:
        // The name may run on through this character, hidden, or have ended before it.
        if (isAsciiLetter(code) || (code >= 0x30 && code <= 0x39)) add(IN_REF_NAME, s);
        else if (ch === ";") add(IN_TEXT, s);
        inText(s, ch);
        return;
      case IN_LT:
        if (isAsciiLetter(code)) add(IN_TAG, s);
        else if (ch === "/") add(IN_LT_SLASH, s);
        else if (ch === "!" || ch === "?") add(IN_COMMENT, s);
        return;
      case IN_LT_SLASH:
        if (isAsciiLetter(code)) add(IN_TAG, s);
        return;
      case IN_TAG:
        // A quote opens a value after `=`, and is part of a name anywhere else.
        if (ch === '"') add(IN_TAG_DQ, s);
        else if (ch === "'") add(IN_TAG_SQ, s);
        add(ch === ">" ? IN_TEXT : IN_TAG, s);
        return;
      case IN_TAG_DQ:
        add(ch === '"' ? IN_TAG : IN_TAG_DQ, s);
        return;
      case IN_TAG_SQ:
        add(ch === "'" ? IN_TAG : IN_TAG_SQ, s);
        return;
      default: {
        // A comment, a destination or a label: hidden, and over at some `>`, `)` or `]`.
        const end = mode === IN_COMMENT ? ">" : mode === IN_DESTINATION ? ")" : "]";
        add(mode, s);
        if (ch === end) add(IN_TEXT, s);
      }
    }
  };
  return {
    start: () => {
      modes[IN_TEXT] = (modes[IN_TEXT] as number) | PLACES.first;
    },
    reset: () => {
      modes.fill(0);
      named = false;
    },
    read: (text: string) => {
      let i = 0;
      while (i < text.length && !named) {
        let alive = 0;
        for (const s of modes) alive |= s;
        if (alive === 0) return;
        const shown =
          (modes[IN_TEXT] as number) |
          (modes[IN_REF_NAME] as number) |
          (modes[IN_LT] as number) |
          (modes[IN_LT_SLASH] as number);
        if (shown === 0) {
          // Hidden readings only: nothing changes them before the next character that ends one.
          ENDS_HIDDEN.lastIndex = i;
          if (ENDS_HIDDEN.exec(text) === null) return;
          i = ENDS_HIDDEN.lastIndex - 1;
        }
        const code = text.charCodeAt(i);
        NUMERIC_REF.lastIndex = i;
        const ref = code === 0x26 ? NUMERIC_REF.exec(text) : null;
        const ch =
          code < 0xd800 || code > 0xdbff
            ? (text[i] as string)
            : String.fromCodePoint(text.codePointAt(i) as number);
        next.fill(0);
        for (let mode = 0; mode < MODES; mode++) {
          const s = modes[mode] as number;
          if (s === 0) continue;
          if (ref === null) step(mode, s, ch, code);
          else if (mode === IN_TEXT || mode === IN_REF_NAME) {
            // Decoded, or shown as the characters it is.
            let literal = s;
            for (const c of ref[0]) literal = sawChar(literal, c);
            add(IN_TEXT, sawReference(s, ref) | literal);
          } else if (mode !== IN_LT && mode !== IN_LT_SLASH) add(mode, s);
        }
        [modes, next] = [next, modes];
        i += ref !== null ? ref[0].length : ch.length;
      }
    },
    names: () => named || modes.some((s) => (s & PLACES.last) !== 0),
  };
}

/** Does a heading's text read as one of the writer's own sections (`## Citations`, `## Provability`)? */
function namesWriterSection(text: string): boolean {
  const reader = sectionReader();
  reader.start();
  reader.read(text);
  return reader.names();
}

/** What may open a line before a heading's marker: an indent, block quotes, list item markers. */
const CONTAINER_PREFIX = String.raw`[ \t]*(?:(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t]))[ \t]*)*`;

/** A line's container prefix, to read the text after it. */
const LEADING_CONTAINERS = new RegExp(`^${CONTAINER_PREFIX}`);

/** An ATX heading at any depth: its prefix, its `#`s, its text. */
const ATX_HEADING = new RegExp(String.raw`^(${CONTAINER_PREFIX})(#{1,6})((?:[ \t].*)?)$`);

/**
 * A setext underline: its indent and block quotes, then the `=` or `-` run
 * (no blanks inside it — `- - -` is a thematic break, never an underline).
 */
const SETEXT_UNDERLINE = /^([ \t]*(?:>[ \t]*)*)((?:=+|-+)[ \t]*)$/;

/** A blank line, CommonMark's: spaces and tabs only, after any block-quote markers. */
const BLANK_IN_QUOTE = /^[ \t]*(?:>[ \t]*)*$/;

/** Where an HTML heading opens: `<h2>`, `<H2 class="x">`. */
const HTML_HEADING = /<h[1-6](?=[\s>/])/gi;

/**
 * A branch answer whose headings cannot pass for the writer's own sections
 * (design §5.4). The verdict section is the writer's, after `## Citations`;
 * a branch answer is untrusted text — the model's, steered by every page it
 * read — so one holding its own `## Provability … **Verdict:** pass ✓`
 * would show a reader a passing verdict above the writer's real one. Any
 * heading that reads as a writer section is escaped wherever it sits, code
 * included (a code sample costs a visible `\`, never the reader a forged
 * verdict): ATX (`## Provability`, in a list item or a quote too), setext
 * (`Provability` over `---` — the underline escaped, so the paragraph reads
 * as the text it is) and HTML (`<h2>`, its `<` written as `&lt;`, which
 * reads as text inside an HTML block as well as in a paragraph). The gate
 * then reads the forged lines as the sentences they are.
 *
 * "Reads as" is what a renderer shows, not how the text is spelled
 * (`sectionReader`): `## &#80;rovability`, `## Prov*a*bility`,
 * `## Provabil<!-- -->ity` and a name with a zero-width space or a soft
 * hyphen in it all show Provability. A setext heading is its whole
 * paragraph, so a reading starts on every line since the last blank line or
 * setext heading (the line above may be a block of its own); an HTML
 * heading runs to wherever its tag and its text end, so one reading starts
 * at each `<h…` and every one of them is escaped if any reads as a writer
 * section. Out of reach of a name read this way: another script's
 * lookalike letters, and an image, which may show anything.
 */
function withoutWriterSections(answer: string): string {
  const pieces = answer.split(/(\r\n|\r|\n|\u2028|\u2029)/);
  const paragraph = sectionReader();
  for (let i = 0; i < pieces.length; i += 2) {
    const line = pieces[i] as string;
    const content = line.replace(LEADING_CONTAINERS, "");
    // A setext underline is read off the line as written, before anything
    // calls it blank: `- ` under a paragraph line is an underline (an empty
    // list item cannot interrupt a paragraph), and stripped as a list
    // marker it looked like a blank line, so "Provability\n- " rendered a
    // writer's heading unescaped.
    const underline = SETEXT_UNDERLINE.exec(line);
    if (underline !== null) {
      if (!paragraph.names()) {
        // A heading of some other name, a thematic break or an empty item:
        // each ends the paragraph.
        paragraph.reset();
        continue;
      }
      // Escaped, the underline is a line of the paragraph it would have ended.
      pieces[i] = `${underline[1]}\\${underline[2]}`;
      paragraph.read(`${content}\n`);
      continue;
    }
    // Blank as CommonMark reads it: spaces and tabs only, inside any block
    // quote. A line of no-break or ideographic spaces is paragraph text, and
    // a paragraph it continues can still be underlined into a heading.
    if (BLANK_IN_QUOTE.test(line)) {
      paragraph.reset();
      continue;
    }
    const atx = ATX_HEADING.exec(line);
    if (atx !== null && namesWriterSection(atx[3] as string)) {
      pieces[i] = `${atx[1]}\\${atx[2]}${atx[3]}`;
    }
    paragraph.start();
    paragraph.read(`${content}\n`);
  }
  const joined = pieces.join("");
  const html = sectionReader();
  let from = -1;
  for (const open of joined.matchAll(HTML_HEADING)) {
    if (from !== -1) html.read(joined.slice(from, open.index));
    html.start();
    from = open.index;
  }
  if (from === -1) return joined;
  html.read(joined.slice(from));
  return html.names() ? joined.replace(HTML_HEADING, (tag) => `&lt;${tag.slice(1)}`) : joined;
}

/**
 * Does `text` leave a code fence open, as the claim extractor (and a
 * renderer) reads code? Asked of the extractor itself, so the answer cannot
 * drift from the reader the gate uses: a sentence appended after a blank
 * line is read as a claim unless an open fence swallows it. The sentence
 * carries a fresh nonce, so an answer quoting it cannot pass for it.
 */
function fenceLeftOpen(text: string): boolean {
  const nonce = randomUUID().replace(/-/g, "");
  const probe = `The report writer checks this branch with probe ${nonce} here.`;
  return !extractClaims(`${text}\n\n${probe}`).some((claim) => claim.text.includes(nonce));
}

const FENCE_RUNS = [
  { char: "`", run: /^[ \t]*(`{3,})/gm },
  { char: "~", run: /^[ \t]*(~{3,})/gm },
] as const;

/**
 * A branch answer whose open fence, if it leaves one, is closed at its end:
 * the longest fence run of the open fence's character closes it whatever
 * its opener's length. Only a fence at the top level can be left open — a
 * list item's ends with the item, at the next branch's heading — so a
 * closer at column 0 ends it. One that neither closer ends (none is known)
 * is left as written.
 */
function closeFences(answer: string): string {
  if (!fenceLeftOpen(answer)) return answer;
  for (const { char, run } of FENCE_RUNS) {
    let longest = 3;
    for (const m of answer.matchAll(run)) longest = Math.max(longest, (m[1] as string).length);
    const closed = `${answer}\n${char.repeat(longest)}`;
    if (!fenceLeftOpen(closed)) return closed;
  }
  return answer;
}

/**
 * A branch's text, shown in the writer's own lines as the characters it is:
 * `&` and `<` written as references, so it opens no tag and decodes to
 * nothing else. An assumption is the branch's — untrusted, like its answer
 * — but it moves up into the writer's definitions, under the title, and the
 * verdict section lists it again; an `<h2>Provability</h2>` in it would be
 * a heading there, above every branch (design §5.4). It sits mid-line,
 * after its label, so no other markdown in it opens a block.
 */
const asText = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** The text the gate verifies: the title, the definitions, the branches (module doc). */
function renderVerified(args: {
  readonly goal: string;
  readonly branches: ReadonlyArray<{ readonly question: string; readonly answer: string }>;
  readonly numbered: ReadonlyArray<NumberedCitation>;
  readonly assumptions: ReadonlyArray<BranchAssumption>;
  readonly roots: Roots;
}): string {
  const lines: string[] = [`# ${oneLine(args.goal)}`, ""];
  if (args.numbered.length > 0 || args.assumptions.length > 0) {
    for (const c of args.numbered) {
      const dest = destinationOf(c.url, args.roots);
      const written = /\s/.test(dest) && !dest.startsWith("<") ? `<${dest}>` : dest;
      lines.push(`[${c.number}]: ${written}${linkTitle(c.snippet)}`);
    }
    // A branch's assumptions, under their report labels: a renderer shows
    // each as the line it is, so the reader sees what the report assumes.
    for (const a of args.assumptions) lines.push(`[${a.label}]: assume: ${asText(a.text)}`);
    lines.push("");
  }
  for (const b of args.branches) {
    lines.push(`## ${oneLine(b.question)}`, "", b.answer, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** The writer's trailer heading: everything from here on is the writer's text, not the run's. */
const TRAILER = "\n\n## Citations\n";

/**
 * The part of a served gated report the gate verified — everything before
 * the writer's `## Citations` trailer (the visible list, the notice, the
 * `## Provability` section). Re-verifying THIS with the run's evidence gives
 * the bundle the report carries; re-verifying the whole file reads the
 * writer's own lines as claims. For `crewhaus provability check` over a
 * research report. `undefined` when `markdown` is not a gated report (no
 * `## Citations` trailer ending in a `## Provability` section).
 */
export function verifiedReportText(markdown: string): string | undefined {
  const at = markdown.lastIndexOf(TRAILER);
  if (at === -1 || !markdown.slice(at).includes("\n## Provability\n")) return undefined;
  return `${markdown.slice(0, at)}\n`;
}

/**
 * `writeReport`, gated (see the module doc): render the report with its
 * definitions and self-contained branches, verify it against the run's
 * evidence at the declared floor, and append the visible citations and the
 * verdict as `## Provability`. A verifier that throws — or evidence that
 * cannot be built — is grading-infrastructure failure, not a verdict (design
 * §5.1): the bundle is `unverified`, the section says so, and no `halt`
 * follows from it.
 */
export async function writeProvableReport(args: WriteProvableReportArgs): Promise<ProvableReport> {
  const { config } = args.provability;
  const roots = gateRoots(args.provability);
  const now = args.now ?? (() => new Date());
  const { numbered, numberByUrl } = numberCitations(args.citations);
  const read = args.branches.map((b) => {
    const answer = b.answer.trim();
    const { text, dropped } = withoutDefinitions(answer, config.sources.bibliographic);
    return { text, assumptions: branchAssumptions(answer, dropped) };
  });
  const hoisted = hoistAssumptions(read);
  const verified = renderVerified({
    goal: args.goal,
    branches: args.branches.map((b, i) => ({
      question: b.question,
      answer: closeFences(withoutWriterSections(hoisted.texts[i] ?? "")),
    })),
    numbered,
    assumptions: hoisted.assumptions,
    roots,
  });

  let proof: ProofBundle;
  try {
    const { evidence } = args.provability;
    proof = await verifyDocument(verified, {
      config,
      evidence: typeof evidence === "function" ? evidence() : evidence,
      workspaceRoot: roots.root,
      baseDir: roots.workspace,
      now,
      ...(args.provability.resolveHead !== undefined
        ? { resolveHead: args.provability.resolveHead }
        : {}),
      ...(args.provability.judgeWaiver !== undefined
        ? { judgeWaiver: args.provability.judgeWaiver }
        : {}),
    });
  } catch (err) {
    proof = unverifiedBundle(config, err, 0, now);
  }

  const trailer = [
    "## Citations",
    "",
    ...(numbered.length === 0 ? [NO_CITATIONS_NOTICE] : citationListLines(numbered)),
  ].join("\n");
  const markdown = `${verified}\n${trailer}\n\n${renderMarkdownSection(proof).trimEnd()}\n`;
  const json: ReportJson & { readonly proof: ProofBundle } = {
    version: 1,
    goal: args.goal,
    subAnswers: args.branches.map((b: BranchAnswer) => ({
      question: b.question,
      answer: b.answer,
      citationNumbers: citationNumbersForBranch(b, numberByUrl),
    })),
    citations: numbered,
    generatedAt: now().toISOString(),
    proof,
  };
  return { markdown, json, proof, summary: summarizeBundle(proof) };
}

/**
 * `CiteFact`, telling the model the number its fact will carry in the report.
 * The report numbers citations by URL on first appearance, so once a fact
 * from `uri` is recorded, `[N]` for `uri` is fixed — and a branch agent that
 * is not told it cannot mark its claims, which the gate then reads as
 * uncited. Everything else about the tool is the wrapped tool's: its checks,
 * its refusals (a refused quote gets no number), its flags.
 *
 * A fact counts as recorded when the tracker holds more citations of its
 * `uri` after the call than before. Two concurrent calls on one `uri` may
 * both see the other's record; the number they are told is still that
 * `uri`'s number, which is all the marker needs.
 */
export function withCitationNumbers(
  tool: RegisteredTool,
  tracker: Pick<CitationTracker, "listCitationsOrdered">,
): RegisteredTool {
  const citesOf = (uri: string): number =>
    tracker.listCitationsOrdered().filter((c: Citation) => c.url === uri).length;
  return {
    ...tool,
    description: `${tool.description} This run's report is checked for provability: when the fact is recorded, the result names its citation number — mark each sentence the fact supports with that marker, e.g. [3].`,
    execute: async (input, ctx) => {
      const uri =
        typeof input === "object" && input !== null ? (input as { uri?: unknown }).uri : undefined;
      const before = typeof uri === "string" ? citesOf(uri) : 0;
      const out = await tool.execute(input, ctx);
      if (typeof uri !== "string" || typeof out !== "string" || citesOf(uri) <= before) return out;
      const n = citationNumber(tracker.listCitationsOrdered(), uri);
      if (n === undefined) return out;
      return `${out}\nCite it as [${n}]: put [${n}] right after each sentence this fact supports.`;
    },
  };
}

/**
 * Each floor in a sentence the branch can act on. `checked` and `proven` say
 * plainly that no claim of a research report can meet them in 0.8.0: the
 * run's only evidence is what it fetched, which reaches `grounded` at most.
 */
const LEVEL_GUIDANCE: Readonly<Record<IrProvability["level"], string>> = {
  cited: "At `cited`, a marker whose number the report lists is enough.",
  grounded:
    "At `grounded`, each sentence's words must also appear in the source it cites: keep close to the wording of the snippet you recorded, and quote it when you can.",
  checked:
    "At `checked`, a claim needs evidence of a computation. This report's only evidence is the sources the run fetched, which reach `grounded` at most, so no claim in it can meet this floor in this release: cite and quote as you would for `grounded`, and the report records how far each claim got.",
  proven:
    "At `proven`, a claim needs a machine-checked proof. This report's only evidence is the sources the run fetched, which reach `grounded` at most, so no claim in it can meet this floor in this release: cite and quote as you would for `grounded`, and the report records how far each claim got.",
};

/**
 * What a branch is told about assumptions (design §2): the one definition
 * line it may write, and how many the report accepts — `max_assumptions`
 * caps the whole report, which the gate checks once — or that they are
 * refused.
 */
function assumptionGuidance(config: ReportProvabilityConfig): string {
  const cap = config.maxAssumptions;
  if (config.assumptions === "forbid" || cap === 0) {
    return "- Assumptions are refused here: a claim marked [A1] with an `[A1]: assume: …` line fails the report.";
  }
  const limit =
    cap === undefined
      ? "The report counts and shows each one"
      : `The whole report accepts at most ${cap === 1 ? "one" : String(cap)}, and shows each one`;
  return `- A claim no source can settle may rest on a declared assumption: mark it [A1] (A2, … for more) and end your answer with one line for each, \`[A1]: assume: <what you assume>\` — the only definition line you write. ${limit}, so keep them for what no evidence can settle.`;
}

/**
 * What a research branch agent is told under `provability:` (appended to its
 * instructions): how its answer is checked, how to mark a claim so the check
 * can bind it, and how to declare an assumption. Short on purpose — it is
 * prompt cost on every branch.
 */
export function researchProvabilityGuidance(config: ReportProvabilityConfig): string {
  return [
    `Provability: this run's report is checked at the \`${config.level}\` floor before it is served, and every factual sentence in your answer is a claim the check must bind to a source.`,
    "- Record each fact you rely on with CiteFact; its result names the fact's citation number, e.g. [3]. Put that marker right after each sentence the fact supports.",
    "- Use only numbers CiteFact gave you, and write no source definition lines (`[3]: …`): the report adds its own and leaves out any you write.",
    `- ${LEVEL_GUIDANCE[config.level]}`,
    assumptionGuidance(config),
    "- A sentence with no marker fails the check: leave out what you cannot cite.",
  ].join("\n");
}

/**
 * The classified stop for `on_fail: halt` (class `provability`, exit
 * {@link EXIT_CODES.provability}, design §5.1): the score, every refused
 * assumption and the reasons the unmet claims fell short, tallied — so the
 * operator reads why without opening the bundle — and where the bundle is.
 */
export function provabilityFailureReport(proof: ProofBundle, proofPath?: string): FailureReport {
  const counted = Math.max(0, proof.claimCount - proof.assumptions);
  const parts = [
    `${proof.met}/${counted} ${counted === 1 ? "claim" : "claims"} of the research report met the ${proof.level} floor (threshold ${proof.threshold})`,
  ];
  const refused = proof.assumptionsRefused ?? 0;
  if (refused > 0) {
    parts.push(
      `${refused} declared ${refused === 1 ? "assumption was" : "assumptions were"} refused`,
    );
  }
  const tally = new Map<UnmetReason, number>();
  for (const claim of proof.claims) {
    for (const reason of claimReasons(claim)) tally.set(reason, (tally.get(reason) ?? 0) + 1);
  }
  if (tally.size > 0) {
    const reasons = [...tally].map(([reason, n]) => (n > 1 ? `${reason} ×${n}` : reason));
    parts.push(`unmet: ${reasons.join(", ")}`);
  }
  if (proofPath !== undefined) parts.push(`proof bundle: ${proofPath}`);
  return {
    class: "provability",
    title: "provability gate failed the research report",
    detail: parts.join("; "),
    remediation:
      "mark each claim with the [N] CiteFact names for its fact, lower provability.threshold, or set provability.on_fail: note to keep the report with its ✗ section",
    exitCode: EXIT_CODES.provability,
  };
}
