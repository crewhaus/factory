/**
 * @crewhaus/tool-verify — did the thing actually work.
 *
 * These are the gates a harness puts between doing something and claiming it
 * is done. Each answers a question with a right answer, and each is the kind
 * of check a model performs plausibly and incompletely: it will read four of
 * the six links, or miss the one citation marker with no source behind it.
 *
 * Nothing here runs a command or reaches a network. `MarkdownLinkCheck`
 * resolves links against the filesystem and reports external ones as
 * unchecked rather than fetching them — a link checker that made requests
 * would be a crawler, and would leak which documents are being reviewed.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  type Element,
  type StructuredData,
  extractStructuredData,
  normalizeText,
  outline,
  parseHtml,
  queryAll,
  queryFirst,
  readableText,
  textOf,
} from "@crewhaus/tool-html";
import { textSimilarity } from "@crewhaus/tool-text";
import { z } from "zod";
import {
  citationDefinitions,
  citedClaims,
  extractMarkdownLinks,
  hasUriScheme,
  headingAnchors,
  lintCitations,
  splitLinkTarget,
} from "./lib/markdown";
import { NORMALIZERS, type Normalizer, firstDifferences, normalizeOutput } from "./lib/normalize";
import {
  LONG_SENTENCE_WORDS,
  SCHEMA_RULES,
  altIsFilename,
  canonicalForm,
  containsKeyword,
  declaresSchemaOrg,
  hasValue,
  isUninformativeAnchor,
  jsonLdNodes,
  parseTarget,
  passiveCandidates,
  pathForm,
  phraseOccurrences,
  primarySubtag,
  readKeyword,
  readLanguage,
  readabilityBand,
  schemaRuleFor,
  sentencesOf,
  slugIssues,
  tokenize,
  typeOf,
} from "./lib/seo";
import {
  type SourceIndex,
  type SourceToken,
  bestSpan,
  contentTokens,
  findSequence,
  indexSource,
  lineOf,
  quotedRuns,
  spanExcerpt,
} from "./lib/spans";
import { type SafePath, ToolPermissionError, resolveSafe, toPosix, workspaceRoot } from "./paths";

const json = (value: unknown): string => JSON.stringify(value);

const LIMITS = {
  files: 20_000,
  fileBytes: 256 * 1024 * 1024,
  textChars: 16 * 1024 * 1024,
  checks: 200,
  diffLines: 50,
  claims: 200,
  claimChars: 4_000,
  // A source is tokenized end to end, so its cap is about the work rather
  // than the memory, and is far below the per-file one above.
  sourceBytes: 8 * 1024 * 1024,
} as const;

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".turbo"]);

/** Every file under a directory, workspace-relative and sorted. */
function filesUnder(root: string, rel = "", out: string[] = []): string[] {
  if (out.length >= LIMITS.files) return out;
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (entry.name.startsWith(".") && entry.name !== ".gitignore") continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      filesUnder(root, join(rel, entry.name), out);
      continue;
    }
    if (entry.isFile()) out.push(join(rel, entry.name));
    if (out.length >= LIMITS.files) return out;
  }
  return out;
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function readCapped(abs: string, what: string): Buffer {
  const size = statSync(abs).size;
  if (size > LIMITS.fileBytes) {
    throw new Error(`${what} is ${size} bytes, over the ${LIMITS.fileBytes}-byte limit`);
  }
  return readFileSync(abs);
}

const normalizerField = z
  .array(z.enum(NORMALIZERS))
  .max(NORMALIZERS.length)
  .optional()
  .describe("which varying parts to mask before comparing");

const replaceField = z
  .array(z.object({ pattern: z.string(), with: z.string(), flags: z.string().optional() }))
  .max(64)
  .optional()
  .describe("extra substitutions, applied after the builtin ones");

// ---------------------------------------------------------------------------

export const goldenCompare: RegisteredTool = buildTool({
  name: "GoldenCompare",
  description:
    "Compare output, a file or a whole directory tree against stored goldens, masking the parts that are allowed to vary. Use it as the gate that says whether a change did anything it did not mean to. Timestamps, durations, uuids, hashes, ports, absolute paths and ANSI escapes can each be masked, and every mask is reported WITH A COUNT — a normalizer that quietly rewrote output would let a real regression hide inside a masked span, which is worse than a golden that fails too often.",
  inputSchema: z
    .object({
      actual: z.string().max(LIMITS.textChars).optional().describe("the output to check"),
      actualFile: z.string().optional().describe("or a file, or a directory for a tree compare"),
      golden: z.string().min(1).describe("workspace-relative path to the stored golden"),
      normalize: normalizerField,
      replace: replaceField,
      maxDiffLines: z.number().int().positive().max(1_000).optional().describe("default 20"),
    })
    .strict()
    .refine((v) => (v.actual === undefined) !== (v.actualFile === undefined), {
      message: "give exactly one of actual or actualFile",
    }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const root = workspaceRoot();
    const apply = (input.normalize ?? []) as ReadonlyArray<Normalizer>;
    const goldenAt = resolveSafe("GoldenCompare", input.golden);
    const maxDiffLines = input.maxDiffLines ?? 20;

    const isTree =
      input.actualFile !== undefined &&
      (() => {
        try {
          return statSync(
            resolveSafe("GoldenCompare", input.actualFile as string).real,
          ).isDirectory();
        } catch {
          return false;
        }
      })();

    if (isTree) {
      const actualAt = resolveSafe("GoldenCompare", input.actualFile as string);
      let goldenFiles: string[];
      try {
        goldenFiles = filesUnder(goldenAt.real);
      } catch {
        return `the golden directory "${goldenAt.rel}" does not exist — create it with GoldenUpdate once the output is right`;
      }
      const actualFiles = filesUnder(actualAt.real);
      const added = actualFiles.filter((f) => !goldenFiles.includes(f));
      const removed = goldenFiles.filter((f) => !actualFiles.includes(f));
      const changed: string[] = [];
      for (const file of goldenFiles.filter((f) => actualFiles.includes(f))) {
        const a = normalizeOutput(readCapped(join(goldenAt.real, file), file).toString("utf-8"), {
          apply,
          root,
          replace: input.replace,
        }).text;
        const b = normalizeOutput(readCapped(join(actualAt.real, file), file).toString("utf-8"), {
          apply,
          root,
          replace: input.replace,
        }).text;
        if (a !== b) changed.push(file);
      }
      return json({
        mode: "tree",
        golden: goldenAt.rel,
        actual: actualAt.rel,
        match: added.length === 0 && removed.length === 0 && changed.length === 0,
        fileCount: actualFiles.length,
        added,
        removed,
        changed,
      });
    }

    let goldenText: string;
    try {
      goldenText = readCapped(goldenAt.real, goldenAt.rel).toString("utf-8");
    } catch {
      return `the golden "${goldenAt.rel}" does not exist yet — run GoldenUpdate once the output is right, then compare against it`;
    }
    const actualRaw =
      input.actual ??
      readCapped(resolveSafe("GoldenCompare", input.actualFile as string).real, "actual").toString(
        "utf-8",
      );

    const expected = normalizeOutput(goldenText, { apply, root, replace: input.replace });
    const actual = normalizeOutput(actualRaw, { apply, root, replace: input.replace });
    const match = expected.text === actual.text;

    return json({
      mode: "text",
      golden: goldenAt.rel,
      match,
      normalized: actual.applied,
      ...(match
        ? {}
        : {
            differences: firstDifferences(expected.text, actual.text, maxDiffLines),
            expectedLines: expected.text.split("\n").length,
            actualLines: actual.text.split("\n").length,
          }),
    });
  },
});

export const goldenUpdate: RegisteredTool = buildTool({
  name: "GoldenUpdate",
  description:
    "Write the current output to a golden file, atomically. Use it to accept a change you have reviewed and intend. It writes through a temporary file and a rename, so an interrupted run leaves the old golden intact rather than a half-written one — a truncated golden passes nothing and is easy to mistake for a real diff. This overwrites a reviewed baseline, so it is destructive and asks for a justification.",
  inputSchema: z
    .object({
      actual: z.string().max(LIMITS.textChars).describe("the output to store"),
      golden: z.string().min(1).describe("workspace-relative path to write"),
      normalize: normalizerField,
      replace: replaceField,
    })
    .strict(),
  readOnly: false,
  destructive: true,
  requireJustification: true,
  concurrencySafe: false,
  execute: async (input) => {
    const at = resolveSafe("GoldenUpdate", input.golden);
    const normalized = normalizeOutput(input.actual, {
      apply: (input.normalize ?? []) as ReadonlyArray<Normalizer>,
      root: workspaceRoot(),
      replace: input.replace,
    });
    let previous: string | null = null;
    try {
      previous = readFileSync(at.real, "utf-8");
    } catch {
      previous = null;
    }
    // Temp file plus rename: an interrupted write leaves the old golden in
    // place rather than a truncated one that passes nothing.
    const temp = `${at.real}.tmp-${process.pid}`;
    writeFileSync(temp, normalized.text);
    renameSync(temp, at.real);
    return json({
      golden: at.rel,
      created: previous === null,
      changed: previous !== normalized.text,
      bytes: Buffer.byteLength(normalized.text),
      normalized: normalized.applied,
    });
  },
});

export const checksumVerify: RegisteredTool = buildTool({
  name: "ChecksumVerify",
  description:
    "Hash files and check them against a SHA256SUMS-style manifest, or write one. Use it to prove an artifact is the one you built, or that a directory has not changed. A file listed in the manifest and missing from disk is reported separately from one whose contents differ, and a file on disk that the manifest does not mention is reported too — an unexpected extra file is how something gets shipped that nobody meant to ship.",
  inputSchema: z
    .object({
      directory: z.string().optional().describe("what to hash; defaults to the workspace root"),
      manifest: z
        .string()
        .optional()
        .describe("workspace-relative SHA256SUMS file to check against"),
      files: z.array(z.string()).max(LIMITS.files).optional().describe("hash just these"),
      write: z
        .boolean()
        .optional()
        .describe("emit a manifest body in the result instead of checking"),
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const base = resolveSafe("ChecksumVerify", input.directory ?? ".");
    const relatives =
      input.files ??
      (() => {
        try {
          return filesUnder(base.real);
        } catch {
          return [];
        }
      })();

    const digests = new Map<string, string>();
    const unreadable: string[] = [];
    for (const rel of relatives) {
      try {
        const at = resolveSafe("ChecksumVerify", join(input.directory ?? ".", rel));
        digests.set(rel, sha256(readCapped(at.real, rel)));
      } catch (err) {
        unreadable.push(`${rel}: ${(err as Error).message}`);
      }
    }

    if (input.manifest === undefined || input.write === true) {
      const body = [...digests.entries()].map(([rel, hash]) => `${hash}  ${rel}`).join("\n");
      return json({
        directory: base.rel,
        fileCount: digests.size,
        unreadable,
        manifest: `${body}\n`,
      });
    }

    const manifestAt = resolveSafe("ChecksumVerify", input.manifest);
    let manifestText: string;
    try {
      manifestText = readCapped(manifestAt.real, manifestAt.rel).toString("utf-8");
    } catch {
      return `the manifest "${manifestAt.rel}" does not exist; run with write:true to produce one`;
    }
    const expected = new Map<string, string>();
    for (const line of manifestText.split("\n")) {
      const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
      if (m === null) continue;
      expected.set((m[2] as string).trim(), (m[1] as string).toLowerCase());
    }

    const mismatched: string[] = [];
    const missing: string[] = [];
    const unexpected: string[] = [];
    for (const [rel, want] of expected) {
      const got = digests.get(rel);
      if (got === undefined) missing.push(rel);
      else if (got !== want) mismatched.push(rel);
    }
    for (const rel of digests.keys()) if (!expected.has(rel)) unexpected.push(rel);

    return json({
      directory: base.rel,
      manifest: manifestAt.rel,
      // Each failure mode is separate: missing, changed and extra need
      // different action, and an extra file is how something ships that
      // nobody meant to ship.
      ok: mismatched.length === 0 && missing.length === 0 && unexpected.length === 0,
      checked: expected.size,
      mismatched,
      missing,
      unexpected,
      unreadable,
    });
  },
});

export const acceptanceCheck: RegisteredTool = buildTool({
  name: "AcceptanceCheck",
  description:
    "Run a task's definition of done as one call: files that must exist, files that must not, text that must appear in a file and text that must not. Use it to decide whether work is finished instead of asking a model to look and say yes. Every check is reported with its verdict, so a pass is a list of things that were actually checked rather than an opinion, and one failure does not hide the others.",
  inputSchema: z
    .object({
      checks: z
        .array(
          z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("fileExists"), path: z.string().min(1) }),
            z.object({ kind: z.literal("fileAbsent"), path: z.string().min(1) }),
            z.object({
              kind: z.literal("fileContains"),
              path: z.string().min(1),
              text: z.string().min(1),
            }),
            z.object({
              kind: z.literal("fileOmits"),
              path: z.string().min(1),
              text: z.string().min(1),
            }),
            z.object({
              kind: z.literal("fileMatches"),
              path: z.string().min(1),
              pattern: z.string().min(1),
              flags: z.string().optional(),
            }),
          ]),
        )
        .min(1)
        .max(LIMITS.checks),
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const results = input.checks.map((check, index) => {
      const label = `${check.kind}(${check.path})`;
      let exists = false;
      let body: string | null = null;
      try {
        const at = resolveSafe("AcceptanceCheck", check.path);
        const stat = statSync(at.real);
        exists = true;
        if (stat.isFile() && check.kind !== "fileExists" && check.kind !== "fileAbsent") {
          body = readCapped(at.real, check.path).toString("utf-8");
        }
      } catch (err) {
        if (err instanceof Error && /escapes the workspace/.test(err.message)) {
          return { index, check: label, ok: false, detail: err.message };
        }
        exists = false;
      }

      switch (check.kind) {
        case "fileExists":
          return { index, check: label, ok: exists, detail: exists ? "" : "it is not there" };
        case "fileAbsent":
          return { index, check: label, ok: !exists, detail: exists ? "it is still there" : "" };
        case "fileContains":
          return {
            index,
            check: label,
            ok: body?.includes(check.text) === true,
            detail:
              body === null
                ? "the file could not be read"
                : body.includes(check.text)
                  ? ""
                  : "the text is not in it",
          };
        case "fileOmits":
          return {
            index,
            check: label,
            ok: body !== null && !body.includes(check.text),
            detail:
              body === null
                ? "the file could not be read"
                : body.includes(check.text)
                  ? "the text is still in it"
                  : "",
          };
        default: {
          if (body === null)
            return { index, check: label, ok: false, detail: "the file could not be read" };
          let re: RegExp;
          try {
            re = new RegExp(check.pattern, check.flags ?? "");
          } catch (err) {
            return {
              index,
              check: label,
              ok: false,
              detail: `invalid pattern: ${(err as Error).message}`,
            };
          }
          const hit = re.test(body);
          return { index, check: label, ok: hit, detail: hit ? "" : "the pattern does not match" };
        }
      }
    });

    const failed = results.filter((r) => !r.ok);
    return json({
      ok: failed.length === 0,
      checked: results.length,
      failed: failed.length,
      results,
    });
  },
});

export const markdownLinkCheck: RegisteredTool = buildTool({
  name: "MarkdownLinkCheck",
  description:
    "Resolve every link in Markdown files against the filesystem and report the broken ones, including heading anchors. Use it before publishing docs. Links inside code blocks are ignored, because a path in an example is not a promise. External links are listed as UNCHECKED rather than fetched — a link checker that made requests would be a crawler, and would tell whoever is watching which documents are being reviewed.",
  inputSchema: z
    .object({
      path: z.string().optional().describe("a file or directory; defaults to the workspace root"),
      checkAnchors: z.boolean().optional().describe("also verify #fragments against headings"),
      limit: z
        .number()
        .int()
        .positive()
        .max(10_000)
        .optional()
        .describe("default 500 broken links"),
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const at = resolveSafe("MarkdownLinkCheck", input.path ?? ".");
    const isDir = statSync(at.real).isDirectory();
    const docs = isDir ? filesUnder(at.real).filter((f) => /\.(md|mdx|markdown)$/i.test(f)) : [""];
    const root = isDir ? at.real : dirname(at.real);

    const broken: Array<{ file: string; line: number; href: string; reason: string }> = [];
    let checked = 0;
    let external = 0;
    const limit = input.limit ?? 500;

    for (const doc of docs) {
      const abs = isDir ? join(root, doc) : at.real;
      const label = isDir ? doc : at.rel;
      const text = readCapped(abs, label).toString("utf-8");
      const anchors = input.checkAnchors ? headingAnchors(text) : new Set<string>();

      for (const link of extractMarkdownLinks(text)) {
        checked++;
        if (hasUriScheme(link.href)) {
          external++;
          continue;
        }
        const { target, fragment } = splitLinkTarget(link.href);
        if (target === "") {
          // A bare `#anchor` points inside this document.
          if (
            input.checkAnchors &&
            fragment !== undefined &&
            !anchors.has(fragment.toLowerCase())
          ) {
            broken.push({
              file: label,
              line: link.line,
              href: link.href,
              reason: "no heading with that anchor",
            });
          }
          continue;
        }
        // Containment applies to a link's target too — and to the path that
        // is actually OPENED, not the one the link spells. A lexical
        // `relative(root, …)` check passes `./escape.md` while `statSync`
        // follows it to wherever it points, so a link through an
        // in-workspace symlink used to be stat'ed, and with `checkAnchors`
        // READ, outside the workspace: the anchor answer then reports
        // whether a file nobody may read carries a given heading.
        // `resolveSafe` follows the link before deciding.
        let targetAt: SafePath;
        try {
          targetAt = resolveSafe("MarkdownLinkCheck", resolve(dirname(abs), target));
        } catch (err) {
          broken.push({
            file: label,
            line: link.line,
            href: link.href,
            reason:
              err instanceof ToolPermissionError
                ? "the target is outside the workspace"
                : `the target could not be resolved: ${(err as Error).message}`,
          });
          continue;
        }
        let ok = false;
        try {
          statSync(targetAt.real);
          ok = true;
        } catch {
          ok = false;
        }
        if (!ok) {
          broken.push({
            file: label,
            line: link.line,
            href: link.href,
            reason: "the target does not exist",
          });
          continue;
        }
        if (input.checkAnchors && fragment !== undefined && /\.(md|mdx|markdown)$/i.test(target)) {
          const targetAnchors = headingAnchors(readCapped(targetAt.real, target).toString("utf-8"));
          if (!targetAnchors.has(fragment.toLowerCase())) {
            broken.push({
              file: label,
              line: link.line,
              href: link.href,
              reason: "the target has no such heading",
            });
          }
        }
        if (broken.length >= limit) break;
      }
      if (broken.length >= limit) break;
    }

    return json({
      path: at.rel,
      documents: docs.length,
      linksChecked: checked,
      external,
      ok: broken.length === 0,
      broken: broken.slice(0, limit),
      truncated: broken.length >= limit,
      note: "external links are listed as unchecked, never fetched",
    });
  },
});

export const citationLint: RegisteredTool = buildTool({
  name: "CitationLint",
  description:
    "Check that every citation marker in a document has a source behind it, and report sources nobody cited. Use it to gate a brief or a report before delivery. The two findings are kept apart on purpose: a marker with no source is a claim with nothing behind it, while an uncited source is usually only untidy — so a caller can fail on the first alone. Markers inside code blocks are ignored.",
  inputSchema: z
    .object({
      text: z.string().max(LIMITS.textChars).optional(),
      file: z.string().optional(),
    })
    .strict()
    .refine((v) => (v.text === undefined) !== (v.file === undefined), {
      message: "give exactly one of text or file",
    }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const body =
      input.text ??
      readCapped(resolveSafe("CitationLint", input.file as string).real, "document").toString(
        "utf-8",
      );
    const report = lintCitations(body);
    return json({
      from: input.file ?? "inline",
      ok: report.ok,
      markerCount: report.markers.length,
      definedCount: report.defined.length,
      undefinedMarkers: report.undefinedMarkers,
      uncited: report.uncited,
    });
  },
});

// ---------------------------------------------------------------------------

/** Fewer words than this in quotation marks is a phrase, not a quotation. */
const QUOTE_MIN_TOKENS = 4;
/** How much of a quotation a source span must carry to count as a misquote
 *  rather than as nothing at all. Below it there is no "nearly identical
 *  span" to show the caller, and claiming one would be an invention. */
const MISQUOTE_COVERAGE = 0.7;
const MAX_CLAIM_CHARS = 300;
const MAX_EXCERPT_CHARS = 240;

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * What a cited source turned out to be.
 *
 * "Could not be read" and "was never checked" are kept apart from the start,
 * because they stay apart all the way to the verdict: a source this tool
 * declined to fetch is not a broken citation.
 */
type SourceOutcome =
  | { readonly kind: "index"; readonly index: SourceIndex }
  | { readonly kind: "unreadable"; readonly reason: string }
  | { readonly kind: "unchecked"; readonly reason: string };

/**
 * One cited source, read once.
 *
 * The cache is keyed on the REAL path, not on the string the document wrote:
 * two spellings of one file must share an entry, and — the reason it matters —
 * an entry found under a raw string could otherwise be a different file's
 * text than the one the containment check passed. What was validated is what
 * gets read, and what gets read is what gets indexed.
 */
function loadSource(
  raw: string,
  baseAbs: string,
  cache: Map<string, SourceOutcome>,
): { label: string; outcome: SourceOutcome } {
  // A Markdown definition may carry a title after the destination; it is not
  // part of the destination.
  const destination = raw.replace(/\s+"[^"]*"\s*$/, "").trim();
  // What the DOCUMENT wrote, for every answer that is about the citation
  // rather than about a file that was opened. A file that is opened is
  // reported by its workspace-relative path instead, below.
  const written = clip(destination, MAX_CLAIM_CHARS);
  if (destination === "") {
    return {
      label: clip(raw, MAX_CLAIM_CHARS),
      outcome: { kind: "unchecked", reason: "it names nothing" },
    };
  }
  if (hasUriScheme(destination)) {
    return {
      label: written,
      outcome: {
        kind: "unchecked",
        reason: "it is a URL, and nothing in this package fetches",
      },
    };
  }
  // Parse the destination, then act on the parsed value. A citation may carry
  // a fragment exactly as any other Markdown link does, and the file is the
  // part in front of it — asked of the same `splitLinkTarget` MarkdownLinkCheck
  // asks, because a second rule here would drift from that one and have the
  // two tools disagree about which file a citation names. The fragment itself
  // is not honoured: narrowing the search to one section would decide which
  // span of a source a claim is allowed to be in, and getting that wrong
  // reports a source that does say the thing as one that does not.
  const { target } = splitLinkTarget(destination);
  if (target === "") {
    return {
      label: written,
      outcome: {
        kind: "unchecked",
        reason: "it points inside the document itself, not at a source",
      },
    };
  }
  // A source with a space in it is usually a bibliographic reference — but
  // "docs/my report.md" is a file, and deciding on the shape of the string
  // alone would report it as unreadable prose. So the filesystem answers
  // first, and the shape only decides what a MISS means.
  const looksWritten = /\s/.test(target);
  const prose: SourceOutcome = {
    kind: "unchecked",
    reason: "it is a written reference, not a file in the workspace",
  };

  let at: SafePath;
  try {
    // Containment is applied to the path that will actually be opened — the
    // document's own directory joined with what the document asked for —
    // never to the string as written. `resolveSafe` follows symlinks, which
    // `join` and `existsSync` do not.
    at = resolveSafe("FactCrossCheck", resolve(baseAbs, target));
  } catch (err) {
    if (looksWritten) return { label: written, outcome: prose };
    if (err instanceof ToolPermissionError) {
      return {
        label: written,
        outcome: { kind: "unreadable", reason: "it is outside the workspace" },
      };
    }
    return { label: written, outcome: { kind: "unreadable", reason: (err as Error).message } };
  }

  // A file that was opened is named by its workspace-relative path; a source
  // that turned out never to be a file is named the way the document wrote
  // it. Reporting `docs/Smith, J. (2024)` for a printed reference cited in a
  // document under `docs/` would describe a path nobody ever asked for.
  // Past this point the only `unchecked` outcome is `prose`.
  const labelFor = (outcome: SourceOutcome): string =>
    outcome.kind === "unchecked" ? written : clip(at.rel, MAX_CLAIM_CHARS);

  const cached = cache.get(at.real);
  if (cached !== undefined) return { label: labelFor(cached), outcome: cached };

  const outcome = ((): SourceOutcome => {
    let size: number;
    try {
      const stat = statSync(at.real);
      if (stat.isDirectory()) {
        return { kind: "unreadable", reason: "it is a directory, not a document" };
      }
      if (!stat.isFile()) return { kind: "unreadable", reason: "it is not a regular file" };
      size = stat.size;
    } catch {
      return looksWritten ? prose : { kind: "unreadable", reason: "it is not there" };
    }
    // A smaller cap than the rest of the package uses: every byte of a source
    // is tokenized, so the limit is about the work, not the memory.
    if (size > LIMITS.sourceBytes) {
      return {
        kind: "unreadable",
        reason: `it is ${size} bytes, over the ${LIMITS.sourceBytes}-byte limit for a source`,
      };
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(at.real);
    } catch (err) {
      return { kind: "unreadable", reason: (err as Error).message };
    }
    // A NUL byte means this is not text; tokenizing it would produce
    // nonsense and a confident "not found".
    if (bytes.includes(0)) return { kind: "unreadable", reason: "it is not text" };
    return { kind: "index", index: indexSource(bytes.toString("utf-8")) };
  })();

  cache.set(at.real, outcome);
  return { label: labelFor(outcome), outcome };
}

type Verdict =
  | "supported"
  | "misquoted"
  | "polarityConflict"
  | "unreadable"
  | "unchecked"
  | "notFound"
  | "noSource";

/**
 * Which answer a claim takes when its sources disagree about how much they
 * know. Lower wins.
 *
 * `notFound` sits BELOW `unreadable` and `unchecked` on purpose: a claim can
 * only be reported as absent from its sources once every one of them was
 * actually read. A source that could not be opened leaves the claim
 * undetermined, which is a different answer and needs a different fix.
 */
const VERDICT_RANK: Readonly<Record<Verdict, number>> = {
  supported: 0,
  misquoted: 1,
  polarityConflict: 2,
  unreadable: 3,
  unchecked: 4,
  notFound: 5,
  noSource: 6,
};

type SourceFinding = {
  source: string;
  status: Verdict;
  reason: string;
  coverage?: number;
  missing?: string[];
  differing?: string[];
  line?: number;
  excerpt?: string;
};

/** Locate one claim's words in one source. */
function checkOneSource(
  label: string,
  index: SourceIndex,
  claim: PreparedClaim,
  windowTokens: number,
): SourceFinding {
  if (claim.quotes.length > 0) {
    let worst: SourceFinding | null = null;
    let firstHit = -1;
    for (const run of claim.quotes) {
      const at = findSequence(index, run);
      if (at !== -1) {
        if (firstHit === -1) firstHit = at;
        continue;
      }
      // The quotation is not there word for word. A span that carries most of
      // it is the useful answer — the caller needs to see what the source
      // actually wrote — and a span that carries little of it is no answer at
      // all, only a coincidence of vocabulary.
      const distinct = [...new Set(run)];
      const near = bestSpan(index, distinct, run.length);
      const coverage = near.total === 0 ? 0 : near.matched / near.total;
      const enough = coverage >= MISQUOTE_COVERAGE && near.matched >= 3;
      const finding: SourceFinding = enough
        ? {
            source: label,
            status: "misquoted",
            reason: `"${label}" has a nearly identical span, but not the words the claim puts in quotation marks`,
            coverage: Math.round(coverage * 100) / 100,
            missing: [...near.missing],
            differing: [...near.extra],
            line: lineOf(index, (index.tokens[near.firstToken] as SourceToken).at),
            excerpt: spanExcerpt(index, near.firstToken, near.lastToken, MAX_EXCERPT_CHARS),
          }
        : {
            source: label,
            status: "notFound",
            reason: `the quoted words are not in "${label}"; that is not a finding that it says otherwise`,
            coverage: Math.round(coverage * 100) / 100,
            missing: [...near.missing],
          };
      if (worst === null || VERDICT_RANK[finding.status] > VERDICT_RANK[worst.status]) {
        worst = finding;
      }
    }
    if (worst !== null) return worst;
    const last = firstHit + (claim.quotes[0] as ReadonlyArray<string>).length - 1;
    return {
      source: label,
      status: "supported",
      reason: `the quoted words appear in "${label}", in order`,
      coverage: 1,
      line: lineOf(index, (index.tokens[firstHit] as SourceToken).at),
      excerpt: spanExcerpt(index, firstHit, last, MAX_EXCERPT_CHARS),
    };
  }

  const span = bestSpan(index, claim.need, windowTokens);
  const coverage = span.total === 0 ? 0 : Math.round((span.matched / span.total) * 100) / 100;
  if (span.matched < span.total) {
    return {
      source: label,
      status: "notFound",
      reason: `${span.matched} of ${span.total} of the claim's words are in "${label}", never together; that is not a finding that it says otherwise`,
      coverage,
      missing: [...span.missing],
      ...(span.firstToken === -1
        ? {}
        : {
            line: lineOf(index, (index.tokens[span.firstToken] as SourceToken).at),
            excerpt: spanExcerpt(index, span.firstToken, span.lastToken, MAX_EXCERPT_CHARS),
          }),
    };
  }
  const line = lineOf(index, (index.tokens[span.firstToken] as SourceToken).at);
  const excerpt = spanExcerpt(index, span.firstToken, span.lastToken, MAX_EXCERPT_CHARS);
  if (span.extraNegations.length > 0) {
    // Every word matched, and the span carrying them is negated where the
    // claim is not. This is as close to "it says the opposite" as counting
    // words can honestly get, and it is reported as something to read rather
    // than as a contradiction found.
    return {
      source: label,
      status: "polarityConflict",
      reason: `the claim's words are in "${label}", but the span carrying them is negated ("${span.extraNegations.join('", "')}") where the claim is not — read it before relying on either`,
      coverage: 1,
      differing: [...span.extraNegations],
      line,
      excerpt,
    };
  }
  return {
    source: label,
    status: "supported",
    reason: `every word of the claim is in one span of "${label}"`,
    coverage: 1,
    line,
    excerpt,
  };
}

type PreparedClaim = {
  readonly text: string;
  readonly need: ReadonlyArray<string>;
  readonly quotes: ReadonlyArray<ReadonlyArray<string>>;
  readonly mode: "quote" | "paraphrase";
};

function prepareClaim(text: string): PreparedClaim {
  const quotes = quotedRuns(text, QUOTE_MIN_TOKENS);
  return {
    text,
    need: contentTokens(text),
    quotes,
    // An attributed quotation is the strictest promise a citation makes, so
    // when there is one it is what gets verified; the words around it are the
    // author's framing, not the source's.
    mode: quotes.length > 0 ? "quote" : "paraphrase",
  };
}

export const factCrossCheck: RegisteredTool = buildTool({
  name: "FactCrossCheck",
  description:
    "Check that a cited source actually SAYS what the claim citing it says, offline, by locating the claim's words — or the exact span it puts in quotation marks — inside the source. Use it after CitationLint, which only establishes that a marker has something behind it. Read the verdicts literally: SUPPORTED means the source contains the assertion and nothing more, never that the assertion is true; NOT FOUND means the words could not be located, never that the source contradicts them; and a source that could not be read, or that is a URL nobody fetched, is kept apart from both rather than counted as a failure.",
  inputSchema: z
    .object({
      text: z
        .string()
        .max(LIMITS.textChars)
        .optional()
        .describe("a document whose cited sentences to check"),
      file: z.string().optional().describe("or that document's workspace-relative path"),
      claims: z
        .array(
          z
            .object({
              text: z.string().min(1).max(LIMITS.claimChars).describe("the assertion"),
              sources: z
                .array(z.string().min(1))
                .max(32)
                .describe("paths to what it cites; relative to the workspace root"),
              id: z.string().max(120).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(LIMITS.claims)
        .optional()
        .describe("or the claims and their sources, given directly"),
      windowTokens: z
        .number()
        .int()
        .min(4)
        .max(2_000)
        .optional()
        .describe("default 60 — how far apart the claim's words may sit in the source"),
      limit: z.number().int().positive().max(LIMITS.claims).optional().describe("default 200"),
    })
    .strict()
    .refine((v) => [v.text, v.file, v.claims].filter((given) => given !== undefined).length === 1, {
      message: "give exactly one of text, file or claims",
    }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const windowTokens = input.windowTokens ?? 60;
    const limit = input.limit ?? LIMITS.claims;
    const cache = new Map<string, SourceOutcome>();

    // Where a source path is measured from. A document's citations are
    // written relative to the document; a caller's are relative to the
    // workspace root. Both are contained the same way afterwards.
    let baseAbs = workspaceRoot();
    let from = "claims";
    const claims: Array<{
      text: string;
      cites: string[];
      /** Markers the document cites and never defines — nothing to read. */
      unresolved: string[];
      id?: string;
      line?: number;
    }> = [];

    if (input.claims !== undefined) {
      for (const claim of input.claims) {
        claims.push({
          text: claim.text,
          cites: [...claim.sources],
          unresolved: [],
          ...(claim.id === undefined ? {} : { id: claim.id }),
        });
      }
    } else {
      let document: string;
      if (input.file !== undefined) {
        const at = resolveSafe("FactCrossCheck", input.file);
        document = readCapped(at.real, at.rel).toString("utf-8");
        baseAbs = dirname(at.real);
        from = at.rel;
      } else {
        document = input.text as string;
        from = "inline";
      }
      const definitions = citationDefinitions(document);
      for (const claim of citedClaims(document)) {
        const cites: string[] = [];
        const unresolved: string[] = [];
        for (const marker of claim.markers) {
          const definition = definitions.get(marker);
          if (definition === undefined) unresolved.push(marker);
          else cites.push(definition);
        }
        claims.push({
          text: claim.text,
          line: claim.line,
          id: claim.markers.join(","),
          cites,
          unresolved,
        });
      }
    }

    const counts: Record<Verdict, number> = {
      supported: 0,
      misquoted: 0,
      polarityConflict: 0,
      unreadable: 0,
      unchecked: 0,
      notFound: 0,
      noSource: 0,
    };

    const results = claims.slice(0, limit).map((claim, index) => {
      const prepared = prepareClaim(claim.text);
      const head = {
        index,
        ...(claim.id === undefined ? {} : { id: claim.id }),
        ...(claim.line === undefined ? {} : { line: claim.line }),
        claim: clip(prepared.text, MAX_CLAIM_CHARS),
        mode: prepared.mode,
        cites: [
          ...claim.unresolved.map((marker) => `[${marker}]`),
          ...claim.cites.map((raw) => clip(raw, MAX_CLAIM_CHARS)),
        ],
      };

      const settle = (verdict: Verdict, reason: string, sources: SourceFinding[] = []) => {
        counts[verdict]++;
        return { ...head, verdict, reason, sources };
      };

      if (claim.cites.length === 0 && claim.unresolved.length === 0) {
        return settle(
          "noSource",
          "the claim cites nothing, so there was nothing to check it against",
        );
      }
      // A claim with no words of its own cannot be located, and an empty set
      // of words would otherwise be "found" in every source — a pass that
      // checked nothing, which is the one result worse than a failure.
      if (prepared.need.length === 0 && prepared.quotes.length === 0) {
        return settle("unchecked", "the claim has no words to look for");
      }

      const sources: SourceFinding[] = [];
      // A marker the document never defines has nothing behind it to read.
      // It is not a source that failed; it is CitationLint's finding, carried
      // through so this tool never counts an unread claim as a checked one.
      for (const marker of claim.unresolved) {
        sources.push({
          source: `[${marker}]`,
          status: "unchecked",
          reason: `marker [${marker}] has no source behind it — that is CitationLint's finding`,
        });
      }
      for (const raw of claim.cites) {
        const { label, outcome } = loadSource(raw, baseAbs, cache);
        if (outcome.kind === "index") {
          sources.push(checkOneSource(label, outcome.index, prepared, windowTokens));
        } else {
          sources.push({
            source: label,
            status: outcome.kind,
            reason:
              outcome.kind === "unreadable"
                ? `"${label}" could not be read: ${outcome.reason}`
                : `"${label}" was not checked: ${outcome.reason}`,
          });
        }
      }

      const best = sources.reduce((a, b) =>
        VERDICT_RANK[b.status] < VERDICT_RANK[a.status] ? b : a,
      );
      const reason =
        best.status === "notFound" && sources.length > 1
          ? `the claim's words are in none of the ${sources.length} cited sources, together; that is not a finding that they say otherwise`
          : best.reason;
      const found =
        best.status === "supported" || best.status === "polarityConflict"
          ? {
              foundIn: {
                source: best.source,
                ...(best.line === undefined ? {} : { line: best.line }),
                excerpt: best.excerpt ?? "",
              },
            }
          : {};
      counts[best.status]++;
      return { ...head, verdict: best.status, reason, ...found, sources };
    });

    const undetermined = counts.unreadable + counts.unchecked + counts.noSource;
    const unseen = claims.length - results.length;
    return json({
      from,
      // `ok` is deliberately strict: it is true only when every claim was
      // located in a source that could be read. A claim nobody could check is
      // not a claim that passed — and a claim past the limit is a claim
      // nobody LOOKED at, which is the same answer for a stronger reason.
      // Reporting the ones that fit as a pass would be "could not determine"
      // answered as "no problem", with the unread half deciding nothing.
      ok: results.length > 0 && unseen === 0 && counts.supported === results.length,
      checked: results.length,
      claimsFound: claims.length,
      truncated: unseen > 0,
      notSupported: counts.misquoted + counts.polarityConflict + counts.notFound,
      undetermined,
      counts,
      claims: results,
      ...(results.length === 0
        ? { detail: "no cited claim was found, so nothing was checked" }
        : unseen > 0
          ? {
              detail: `${unseen} of the ${claims.length} cited claims were never checked — the limit is ${limit}; raise it, or check the rest separately`,
            }
          : {}),
      note: "supported means the cited source contains the claim's words — or, for a claim in quotation marks, only the quoted span — never that the claim is true; notFound means they could not be located, never that the source disagrees",
    });
  },
});

// ---------------------------------------------------------------------------

/**
 * Title and description lengths, in characters.
 *
 * A search result truncates on PIXEL width, not on characters — a title of
 * capital Ws is cut long before one of lowercase i's — so these are a proxy
 * for the thing that matters and not the thing itself. Two characters over
 * is not a defect, which is why the finding is a warning and says so.
 */
const TITLE_CHARS = { min: 30, max: 60 } as const;
const DESCRIPTION_CHARS = { min: 50, max: 160 } as const;

/** Below this many words every prose statistic below is noise, not a measure. */
const MIN_PROSE_WORDS = 40;

/** Keyword density above this reads as stuffing rather than as a topic. */
const DEFAULT_MAX_DENSITY = 0.03;

/** Trigram similarity at or above this counts as a near-duplicate. */
const DEFAULT_DUPLICATE_THRESHOLD = 0.85;

/**
 * The near-duplicate corpus, bounded.
 *
 * A corpus over `docs` is REFUSED rather than sampled. Comparing the first
 * two hundred of a thousand pages and reporting no duplicate is the silent
 * pass this check exists to prevent, and a partial answer that looks like a
 * whole one is worse here than no answer.
 */
const CORPUS = {
  docs: 200,
  fileBytes: 1024 * 1024,
  totalChars: 8_000_000,
  pageChars: 200_000,
} as const;

/** How many findings one check may report before the rest are only counted. */
const FINDINGS_PER_CHECK = 20;

type SeoSeverity = "error" | "warn" | "info";

/** One check's result, in the shape the survey sketched. */
type SeoFinding = {
  readonly check: string;
  readonly severity: SeoSeverity;
  readonly detail: string;
  readonly location?: string;
  readonly fix_hint?: string;
};

type SeoNotChecked = { readonly check: string; readonly reason: string };
/** See `seoReport().skip` — the two reasons a check does not run are not the same answer. */
type SeoSkipCause = "not-answerable" | "not-requested";

/**
 * The bookkeeping that keeps "looked and it is fine" apart from "did not
 * look".
 *
 * Three states, never two: a check that ran and passed, a check that ran and
 * found something, and a check that did not run. The third is the whole
 * reason this tool is worth building — a near-duplicate check with no corpus
 * behind it, a readability grade on Japanese prose and a density over text
 * with no word boundaries all produce a confident "nothing wrong here" from
 * a plausible implementation, and each of them is a lie.
 *
 * `passed` is derived rather than declared, so a check can only appear there
 * by having called `ran` and found nothing. A check that was never mentioned
 * appears nowhere, which is why the absences that matter are themselves
 * findings (`title.present`, `jsonld.present`) rather than silence.
 */
function seoReport() {
  const findings: SeoFinding[] = [];
  const notChecked: SeoNotChecked[] = [];
  const notRequested: SeoNotChecked[] = [];
  const attempted = new Set<string>();
  const failed = new Set<string>();
  const perCheck = new Map<string, number>();
  const suppressed = new Map<string, number>();
  // A JSON pair rather than a joined key: a reason is free text and any
  // separator could occur inside it.
  const skipped = new Set<string>();

  return {
    ran(check: string): void {
      attempted.add(check);
    },
    fail(
      check: string,
      severity: SeoSeverity,
      detail: string,
      location?: string,
      fixHint?: string,
    ): void {
      attempted.add(check);
      if (severity !== "info") failed.add(check);
      const seen = perCheck.get(check) ?? 0;
      perCheck.set(check, seen + 1);
      if (seen >= FINDINGS_PER_CHECK) {
        suppressed.set(check, (suppressed.get(check) ?? 0) + 1);
        return;
      }
      findings.push({
        check,
        severity,
        detail,
        ...(location === undefined ? {} : { location }),
        ...(fixHint === undefined ? {} : { fix_hint: fixHint }),
      });
    },
    /**
     * Record that a check did not run, and why.
     *
     * A check may both run and be skipped — `jsonld.fields` checks the types
     * it has a rule for and reports the rest by name — so this does not
     * conflict with `ran`. What it must never do is disappear.
     *
     * `cause` separates the two reasons a check does not run, because they
     * mean opposite things to a caller:
     *
     *   "not-answerable" — it was asked and could not be answered. The corpus
     *     was configured and unreadable; the language has no word boundaries;
     *     the page is over a cap. This WITHHOLDS `ok`: the lint was asked a
     *     question it could not answer, and reporting a pass would be the
     *     silent degradation this tool exists to prevent.
     *
     *   "not-requested" — nothing was asked. No `keyword`, no `url`, no
     *     `corpus`. This does NOT withhold `ok`, and the distinction is the
     *     whole point: with both folded together, `ok` was false on every
     *     ordinary invocation — a clean page with no keyword and no corpus
     *     came back `ok: false` with zero errors — and an `ok` that is always
     *     false is an `ok` nobody reads, which costs exactly the signal that
     *     the strict rule was added to protect.
     *
     * It is an argument and not a guess at the reason's wording: deciding
     * from the text would be validating one spelling and acting on another.
     * It defaults to "not-answerable", so a site that forgets to say
     * withholds the pass rather than granting one.
     */
    skip(check: string, reason: string, cause: SeoSkipCause = "not-answerable"): void {
      const key = JSON.stringify([check, reason]);
      if (skipped.has(key)) return;
      skipped.add(key);
      (cause === "not-requested" ? notRequested : notChecked).push({ check, reason });
    },
    finish() {
      const bySeverity = (s: SeoSeverity) => findings.filter((f) => f.severity === s);
      // A check that is partly unchecked is not a check that passed. Some
      // checks both run and skip — `jsonld.fields` checks the types it has a
      // rule for and reports the rest by name, and `duplicate.nearMatch`
      // compares the corpus files it could read and names the ones it could
      // not — and listing those under `passed` hands a caller the one word
      // it reads as a verdict for a look that was only partly taken.
      // Either bucket keeps a check out of `passed`: why it did not run
      // changes what it means for `ok`, never whether it was looked at.
      //
      // HONESTLY: the `notRequested` half is not load-bearing today. Every
      // site that reports a not-requested check returns before calling
      // `ran`, so those names are not in `attempted` and could not reach
      // `passed` anyway — deleting this half leaves the suite green, which
      // was checked rather than assumed. It stays because the rule is about
      // what `passed` MEANS, not about which call sites happen to exist; a
      // site that both runs a check and reports part of it as not-requested
      // (`jsonld.fields` and `duplicate.nearMatch` already do that with the
      // other bucket) must bring the test that makes this branch bite.
      const unchecked = new Set([...notChecked, ...notRequested].map((n) => n.check));
      return {
        errors: bySeverity("error"),
        warnings: bySeverity("warn"),
        observations: bySeverity("info"),
        notChecked,
        notRequested,
        passed: [...attempted].filter((c) => !failed.has(c) && !unchecked.has(c)).sort(),
        suppressed: Object.fromEntries([...suppressed].sort(([a], [b]) => (a < b ? -1 : 1))),
      };
    },
  };
}

/** A corpus document, read once, as the text it will be compared as. */
type CorpusDoc = { readonly rel: string; readonly text: string };

type CorpusRead =
  | {
      readonly kind: "docs";
      readonly rel: string;
      readonly docs: ReadonlyArray<CorpusDoc>;
      readonly skipped: ReadonlyArray<{ file: string; reason: string }>;
      /** The corpus entry that IS the page being linted, when one was. */
      readonly itself: string | undefined;
    }
  | { readonly kind: "unusable"; readonly reason: string };

/**
 * Read the corpus the page will be compared against.
 *
 * Every path opened here is contained, and containment is applied to the
 * LEAF rather than to the directory the caller named: `resolveSafe` follows
 * symlinks and `join` does not, so a corpus directory that is itself inside
 * the workspace can hold a link to somewhere that is not. Containing only
 * the directory would let this tool read, and report the similarity of, a
 * file nobody may read.
 *
 * Every outcome other than "here are the documents" is a REASON, because the
 * caller has to be able to tell "compared against forty pages and found
 * nothing" from "found nothing to compare against".
 */
function readCorpus(given: string, pageReal: string | undefined): CorpusRead {
  let at: SafePath;
  try {
    at = resolveSafe("SeoLint", given);
  } catch (err) {
    return {
      kind: "unusable",
      reason:
        err instanceof ToolPermissionError
          ? `the corpus path "${given}" is outside the workspace`
          : `the corpus path "${given}" could not be resolved: ${(err as Error).message}`,
    };
  }
  let isDir: boolean;
  try {
    isDir = statSync(at.real).isDirectory();
  } catch {
    return { kind: "unusable", reason: `the corpus path "${at.rel}" does not exist` };
  }
  if (!isDir) {
    return {
      kind: "unusable",
      reason: `the corpus path "${at.rel}" is a file; give the directory holding the already-published pages`,
    };
  }

  const names = filesUnder(at.real);
  if (names.length > CORPUS.docs) {
    return {
      kind: "unusable",
      reason: `the corpus at "${at.rel}" holds ${names.length} files, over the ${CORPUS.docs} this tool compares in one run — comparing some of them and reporting no duplicate would be a pass that did not look, so narrow the corpus instead`,
    };
  }

  const docs: CorpusDoc[] = [];
  const skipped: Array<{ file: string; reason: string }> = [];
  let itself: string | undefined;
  let total = 0;
  for (const name of names) {
    let leaf: SafePath;
    try {
      leaf = resolveSafe("SeoLint", join(at.real, name));
    } catch {
      skipped.push({ file: name, reason: "it resolves outside the workspace" });
      continue;
    }
    // The page being linted is not a near-duplicate of itself. Compared on
    // the RESOLVED path, so "published/a.html" and "./published/a.html" are
    // the same file — the alternative is an error reading `the prose is 1.00
    // similar to published/a.html` about the very page the caller passed in.
    if (pageReal !== undefined && leaf.real === pageReal) {
      itself = `${at.rel}/${toPosix(name)}`;
      continue;
    }
    const html = /\.(?:html?|xhtml)$/i.test(name);
    const plain = /\.(?:txt|md|markdown|mdx)$/i.test(name);
    if (!html && !plain) {
      skipped.push({ file: name, reason: "it is not an .html or a text file" });
      continue;
    }
    let raw: string;
    try {
      if (statSync(leaf.real).size > CORPUS.fileBytes) {
        skipped.push({ file: name, reason: `it is over the ${CORPUS.fileBytes}-byte limit` });
        continue;
      }
      raw = readFileSync(leaf.real, "utf-8");
    } catch (err) {
      skipped.push({ file: name, reason: `it could not be read: ${(err as Error).message}` });
      continue;
    }
    // Compared as PROSE, not as markup: two pages sharing a template and
    // nothing else are not near-duplicates, and comparing the markup would
    // score them as if they were.
    const text = html ? readableText(parseHtml(raw), true) : raw;
    total += text.length;
    if (total > CORPUS.totalChars) {
      return {
        kind: "unusable",
        reason: `the corpus at "${at.rel}" holds more than ${CORPUS.totalChars} characters of text — narrow it, rather than have this compare part of it`,
      };
    }
    docs.push({ rel: `${at.rel}/${toPosix(name)}`, text });
  }
  if (docs.length === 0) {
    return {
      kind: "unusable",
      reason:
        itself === undefined
          ? `the corpus at "${at.rel}" holds no readable page — ${names.length} file(s) were looked at and none was usable`
          : `the corpus at "${at.rel}" holds nothing but the page being linted (${itself}), so there was nothing to compare it with`,
    };
  }
  return { kind: "docs", rel: at.rel, docs, skipped, itself };
}

/**
 * How similar two texts are, asked of `@crewhaus/tool-text`.
 *
 * The scoring is NOT re-implemented here. `TextSimilarity` already publishes
 * it, and its description already names near-duplicate detection as what it
 * is for; a second trigram score in this package would be a second answer to
 * one question, and a harness that ran both would get two verdicts on the
 * same pair. It arrives as a tool rather than as a function because tools are
 * that package's module surface — the same bridge `@crewhaus/tool-kyc` uses
 * for its name matching.
 */
async function trigramSimilarity(a: string, b: string): Promise<number> {
  const result = await textSimilarity.execute({ a, b, method: "trigram" });
  if (typeof result !== "string") {
    throw new Error("TextSimilarity did not return a string result");
  }
  return (JSON.parse(result) as { score: number }).score;
}

export const seoLint: RegisteredTool = buildTool({
  name: "SeoLint",
  description:
    "Gate a page on the on-page SEO and readability checks that have a right answer offline: title and description lengths, heading hierarchy, image alt and anchor-text coverage, keyword placement and density, JSON-LD shape and the fields a rich result needs, canonical and OpenGraph consistency, slug shape, and near-duplicate text against a corpus. Use it before publishing. Three of these cannot be answered exactly, and each says so rather than pretending: readability is reported as a BAND and never as a number, because the syllable count behind Flesch-Kincaid is a heuristic and a decimal invites tuning prose against its bugs; keyword density DISABLES ITSELF for Chinese, Japanese, Thai and the other languages written without spaces between words, where a whitespace tokenizer is meaningless; and the near-duplicate check reports NOT CHECKED when no corpus is configured, rather than passing. JSON-LD is checked against rules bundled offline for the common types; any other @type is named as NOT CHECKED, never called valid. Everything a run did not look at is listed with a reason, in one of two places, because they mean opposite things: notChecked is what was asked for and could not be answered, and it makes ok false — a gate that passes on a check it was asked to make and could not is worse than no gate. notRequested is what nobody asked for, such as a keyword or a corpus you did not pass; it is named, it never counts as passed, and it does not make ok false, because a gate that fails every clean page is a gate nobody reads. So ok means nothing failed and everything this run was asked to look at was looked at — read notRequested to see what it did not cover.",
  inputSchema: z
    .object({
      html: z.string().max(LIMITS.textChars).optional().describe("the page markup"),
      file: z.string().optional().describe("or a workspace-relative path to an .html file"),
      keyword: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("the target keyword or phrase; without it the keyword checks do not run"),
      locale: z
        .string()
        .max(35)
        .optional()
        .describe("BCP-47 language tag, overriding the page's lang attribute"),
      url: z
        .string()
        .min(1)
        .max(2_048)
        .optional()
        .describe("the URL the page will publish at, absolute or an absolute path"),
      corpus: z
        .string()
        .optional()
        .describe(
          "workspace-relative directory of already-published pages; without it the near-duplicate check reports NOT CHECKED",
        ),
      duplicateThreshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("trigram similarity counted as a duplicate; default 0.85"),
      maxDensity: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("keyword density counted as stuffing; default 0.03"),
    })
    .strict()
    .refine((v) => (v.html === undefined) !== (v.file === undefined), {
      message: "give exactly one of html or file",
    }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    // ----- the page -----
    let from: string;
    let markup: string;
    /** Where the page really lives, so the corpus can leave it out. */
    let pageReal: string | undefined;
    if (input.file !== undefined) {
      if (/\.(?:md|markdown|mdx)$/i.test(input.file)) {
        throw new Error(
          `SeoLint reads HTML and "${input.file}" is Markdown. Render it and lint the rendered page: converting it here would put a second Markdown parser in this repo, and half of what this checks — canonical, OpenGraph, JSON-LD, the heading markup — only exists after rendering.`,
        );
      }
      const at = resolveSafe("SeoLint", input.file);
      const stat = statSync(at.real);
      if (stat.isDirectory()) {
        throw new Error(`${at.rel} is a directory; SeoLint reads one page`);
      }
      // Measured BEFORE the read, and against the same cap the inline arm
      // carries. `readCapped`'s limit is for an artifact being checksummed;
      // a page over this is not a page, and reading it to find that out is
      // the cost the cap exists to avoid.
      if (stat.size > LIMITS.textChars) {
        throw new Error(
          `${at.rel} is ${stat.size} bytes, over the ${LIMITS.textChars}-character limit for a page`,
        );
      }
      markup = readCapped(at.real, "page").toString("utf-8");
      from = at.rel;
      pageReal = at.real;
    } else {
      markup = input.html as string;
      from = "inline";
    }

    // One parse, from `@crewhaus/tool-html`. Everything below reads this
    // tree — a second parser in this repo would drift from that one, and
    // then two tools in one harness would disagree about the same page.
    const root = parseHtml(markup);
    const page: StructuredData = extractStructuredData(root);
    const report = seoReport();

    // The prose, narrowed the way a reader narrows it. `<main>` or
    // `<article>` when the page marks one, otherwise the body without the
    // navigation chrome — a word count that includes the menu is a word
    // count of the template.
    const main = queryFirst(root, "main") ?? queryFirst(root, "article");
    const region: Element = main ?? root;
    const prose = readableText(region, main === undefined);
    const regionLabel =
      main === undefined
        ? "the body, without nav, header, footer, aside and form"
        : `<${main.tag}>`;

    const declaredLang = queryFirst(root, "html")?.attrs["lang"];
    const language = readLanguage(declaredLang, input.locale, prose);
    // Only ever used once `language` has said the text has word boundaries.
    const proseWords = language.segmentsOnWhitespace ? tokenize(prose) : [];
    const proseSentences = sentencesOf(prose);

    // ----- title and description -----
    const title = page.title.trim();
    report.ran("title.present");
    if (title === "") {
      report.fail(
        "title.present",
        "error",
        "the page has no <title>",
        "<head>",
        "add a <title>; it is the line a search result shows and the strongest single on-page signal",
      );
    } else {
      report.ran("title.length");
      if (title.length < TITLE_CHARS.min) {
        report.fail(
          "title.length",
          "warn",
          `the title is ${title.length} characters, under the ${TITLE_CHARS.min} that usually carries a topic — character count is a proxy for the pixel width a result truncates at, so treat this as a nudge`,
          `<title>${title}</title>`,
          "say what the page is about, not only its name",
        );
      } else if (title.length > TITLE_CHARS.max) {
        report.fail(
          "title.length",
          "warn",
          `the title is ${title.length} characters and is likely to be truncated past about ${TITLE_CHARS.max} — truncation is by pixel width, so this is a proxy and a few over is not a defect`,
          `<title>${title}</title>`,
          "put the distinguishing words first",
        );
      }
    }

    const description = (page.meta["description"] ?? "").trim();
    report.ran("meta.description.present");
    if (description === "") {
      report.fail(
        "meta.description.present",
        "warn",
        "the page has no meta description, so a search engine will compose one from the body",
        "<head>",
        'add <meta name="description" content="…">',
      );
    } else {
      report.ran("meta.description.length");
      if (description.length < DESCRIPTION_CHARS.min) {
        report.fail(
          "meta.description.length",
          "warn",
          `the meta description is ${description.length} characters, under the ${DESCRIPTION_CHARS.min} that usually reads as a summary`,
          "<head>",
          "write a sentence that answers what the page gives the reader",
        );
      } else if (description.length > DESCRIPTION_CHARS.max) {
        report.fail(
          "meta.description.length",
          "warn",
          `the meta description is ${description.length} characters and is likely to be cut past about ${DESCRIPTION_CHARS.max}`,
          "<head>",
          "front-load the sentence",
        );
      }
    }

    const robots = (page.meta["robots"] ?? "").toLowerCase();
    report.ran("meta.robots");
    if (/\bnoindex\b/.test(robots)) {
      report.fail(
        "meta.robots",
        "warn",
        `the page carries robots="${robots}", so it will not be indexed — usually a staging leftover, and harmless to ignore when it is deliberate`,
        "<head>",
        "remove noindex before publishing",
      );
    }

    report.ran("html.lang");
    // Three outcomes, not two. A `lang` that is there but is not a language
    // tag is not the same as a missing one, and it is certainly not a pass:
    // `primarySubtag` has already refused to read it, which is why the
    // readability checks below decline, and a check called `html.lang` that
    // appeared under `passed` for lang="!!!" would say the opposite.
    const declaredTag = declaredLang === undefined ? undefined : primarySubtag(declaredLang);
    if (declaredLang === undefined || declaredLang.trim() === "") {
      report.fail(
        "html.lang",
        "warn",
        "the page declares no lang attribute, which leaves the language to be guessed",
        "<html>",
        'add lang="…" to <html>',
      );
    } else if (declaredTag === undefined) {
      report.fail(
        "html.lang",
        "warn",
        `the page declares lang="${declaredLang}", whose primary subtag is not a BCP-47 language code, so it reads the same as declaring nothing`,
        "<html>",
        'use a tag like lang="en" or lang="en-GB"',
      );
    }

    // ----- headings -----
    // `outline` is tool-html's answer to what a page's heading structure is.
    // It drops headings with no text, which is exactly the difference the
    // empty-heading check below is looking for, so the two counts come from
    // one traversal rather than from two rival ones.
    const headings = outline(root);
    const headingElements = queryAll(root, "h1, h2, h3, h4, h5, h6");
    report.ran("heading.h1");
    const h1s = headings.filter((h) => h.level === 1);
    if (h1s.length === 0) {
      report.fail(
        "heading.h1",
        "error",
        "the page has no <h1>",
        "<body>",
        "give the page one <h1> naming what it is about",
      );
    } else if (h1s.length > 1) {
      report.fail(
        "heading.h1",
        "warn",
        `the page has ${h1s.length} <h1> elements: ${h1s.map((h) => `"${h.text}"`).join(", ")}`,
        "<body>",
        "keep one <h1> and demote the rest",
      );
    }

    report.ran("heading.order");
    let previous = 0;
    headings.forEach((heading, index) => {
      if (previous !== 0 && heading.level > previous + 1) {
        report.fail(
          "heading.order",
          "warn",
          `the outline goes from h${previous} to h${heading.level}, skipping a level`,
          `h${heading.level} (#${index + 1}) "${heading.text}"`,
          `use h${previous + 1} here, or add the level that is missing`,
        );
      }
      previous = heading.level;
    });

    report.ran("heading.empty");
    for (const element of headingElements) {
      if (normalizeText(textOf(element)) !== "") continue;
      report.fail(
        "heading.empty",
        "warn",
        `a <${element.tag}> carries no text, so it is structure with nothing in it`,
        `<${element.tag}>`,
        "remove it, or give it the heading it was meant to carry",
      );
    }

    // ----- images -----
    const images = queryAll(root, "img");
    report.ran("image.alt");
    let decorative = 0;
    images.forEach((image, index) => {
      const src = image.attrs["src"] ?? image.attrs["data-src"] ?? "";
      const at = `img (#${index + 1})${src === "" ? "" : ` src="${src}"`}`;
      const alt = image.attrs["alt"];
      if (alt === undefined) {
        report.fail(
          "image.alt",
          "error",
          "the image has no alt attribute at all, which is different from an empty one: a screen reader falls back to reading the file name",
          at,
          'add alt="…", or alt="" if the image carries no information',
        );
        return;
      }
      if (alt.trim() === "") {
        decorative++;
        return;
      }
      if (altIsFilename(alt, src)) {
        report.fail(
          "image.alt",
          "warn",
          `the alt text "${alt}" is the file's name, which describes nothing`,
          at,
          "describe what the image shows",
        );
      }
    });
    if (decorative > 0) {
      report.fail(
        "image.alt",
        "info",
        `${decorative} image(s) carry alt="" and are treated as decorative, which is right only if they carry no information a reader would miss`,
      );
    }

    // ----- anchors -----
    // Read from the anchors rather than through `extractLinks`: that one
    // answers "where do this page's links GO", and so it resolves hrefs,
    // drops in-page anchors and de-duplicates. Coverage is the opposite
    // question — every anchor a reader can see, counted once each.
    const anchors = queryAll(root, "a");
    report.ran("link.anchorText");
    anchors.forEach((anchor, index) => {
      const href = anchor.attrs["href"];
      if (href === undefined) return;
      const text = normalizeText(textOf(anchor));
      const at = `a (#${index + 1}) href="${href}"`;
      if (text === "") {
        const label = anchor.attrs["aria-label"] ?? queryFirst(anchor, "img")?.attrs["alt"] ?? "";
        if (label.trim() !== "") return;
        report.fail(
          "link.anchorText",
          "warn",
          "the link has no text, no aria-label and no image with alt text, so neither a reader nor a crawler can tell where it goes",
          at,
          "give it text, or an aria-label",
        );
        return;
      }
      if (isUninformativeAnchor(text)) {
        report.fail(
          "link.anchorText",
          "warn",
          `the anchor text is "${text}", which says nothing about the target`,
          at,
          "name the destination in the link text",
        );
      }
    });

    // ----- keyword -----
    const urlTarget = input.url === undefined ? undefined : parseTarget(input.url);
    const canonicalRaw = page.canonical.trim();
    const canonicalTarget = canonicalRaw === "" ? undefined : parseTarget(canonicalRaw);
    const pathname =
      urlTarget?.kind === "absolute"
        ? urlTarget.url.pathname
        : urlTarget?.kind === "path"
          ? urlTarget.pathname
          : canonicalTarget?.kind === "absolute"
            ? canonicalTarget.url.pathname
            : undefined;

    if (input.keyword === undefined) {
      const why =
        "no keyword was given, so nothing was compared against one — pass keyword to run this";
      report.skip("keyword.placement", why, "not-requested");
      report.skip("keyword.density", why, "not-requested");
    } else {
      // Normalised once, and every check below reads the normalised value.
      const keyword = input.keyword.replace(/\s+/g, " ").trim();
      // What the tokenizer makes of it, decided BEFORE anything is compared.
      // Where words are separated, every match below is made on these tokens
      // and not on the string the caller wrote — "C++" is searched for as the
      // word `c`, which is a different question and has to be reported as
      // one. Where words are not separated the test is a substring, so the
      // keyword survives whole and this does not apply.
      // Read unconditionally, so the keyword is tokenized in exactly one
      // place. Where words are NOT separated the match is a substring and
      // the keyword survives whole, so the tokens are simply not consulted.
      const read = readKeyword(keyword);
      if (language.segmentsOnWhitespace && read.kind === "unsearchable") {
        report.skip("keyword.placement", read.reason);
        report.skip("keyword.density", read.reason);
      } else {
        // How every finding below names the term. When the tokens do not
        // spell the keyword, the caller is told what was really looked for
        // rather than handed a verdict under a spelling never searched.
        const term =
          !language.segmentsOnWhitespace || read.kind === "unsearchable" || read.exact
            ? `"${keyword}"`
            : `"${keyword}" (looked for as the word "${read.searched}", which is all a word-by-word match can carry of it)`;
        report.ran("keyword.placement");
        const opening = prose.slice(0, 500);
        const places: Array<{ where: string; text: string; severity: SeoSeverity }> = [
          { where: "the title", text: title, severity: "warn" },
          { where: "the h1", text: h1s.map((h) => h.text).join(" "), severity: "warn" },
          { where: "the meta description", text: description, severity: "warn" },
          { where: "the opening prose", text: opening, severity: "info" },
          {
            where: "the url path",
            text: (pathname ?? "").replace(/[-_/]+/g, " "),
            severity: "info",
          },
        ];
        for (const place of places) {
          if (place.text.trim() === "") continue;
          if (containsKeyword(place.text, keyword, language.segmentsOnWhitespace)) continue;
          report.fail(
            "keyword.placement",
            place.severity,
            `${term} does not appear in ${place.where}`,
            place.where,
            `work "${keyword}" into ${place.where} if it is genuinely what the page is about`,
          );
        }

        if (!language.segmentsOnWhitespace) {
          report.skip(
            "keyword.density",
            `${language.notSegmentingReason}, so a density figure would be meaningless here — placement was still checked, by substring, which needs no word boundaries`,
          );
        } else if (proseWords.length < MIN_PROSE_WORDS) {
          report.skip(
            "keyword.density",
            `the page has ${proseWords.length} words of prose in ${regionLabel}, under the ${MIN_PROSE_WORDS} below which a density is one word moving the answer by percent`,
          );
        } else {
          report.ran("keyword.density");
          // The tokens `readKeyword` produced, never a second tokenization
          // of the raw string: whatever was read is what gets counted, so
          // the two cannot come to disagree about what the keyword is.
          const needle = read.kind === "words" ? [...read.tokens] : [];
          const hits = phraseOccurrences(proseWords, needle);
          const density = (hits * Math.max(1, needle.length)) / proseWords.length;
          const maxDensity = input.maxDensity ?? DEFAULT_MAX_DENSITY;
          const asPercent = `${(density * 100).toFixed(1)}%`;
          if (hits === 0) {
            report.fail(
              "keyword.density",
              "warn",
              `${term} does not appear in the ${proseWords.length} words of prose at all`,
              regionLabel,
              "either the page is not about this keyword, or the keyword is wrong",
            );
          } else if (density > maxDensity) {
            report.fail(
              "keyword.density",
              "warn",
              `${term} is ${hits} of ${proseWords.length} words (${asPercent}), over the ${(maxDensity * 100).toFixed(1)}% that reads as stuffing`,
              regionLabel,
              "cut the repetitions that a reader would not have written",
            );
          } else {
            report.fail(
              "keyword.density",
              "info",
              `${term} occurs ${hits} time(s) in ${proseWords.length} words (${asPercent})`,
              regionLabel,
            );
          }
        }
      }
    }

    // ----- readability, and the three ways it declines to answer -----
    const READABILITY = ["readability.grade", "readability.longSentences", "readability.passive"];
    const declineReadability = (reason: string): void => {
      for (const check of READABILITY) report.skip(check, reason);
    };
    if (!language.segmentsOnWhitespace) {
      declineReadability(
        `${language.notSegmentingReason}, and Flesch-Kincaid counts words and syllables`,
      );
    } else if (!language.isEnglish) {
      // Which of the three is true matters to the caller: a page with no
      // language can be fixed by passing one, a tag that did not parse is a
      // typo, and German is simply not what the formula was fitted on.
      declineReadability(
        language.tag !== undefined
          ? `the page's language is "${language.tag}"; Flesch-Kincaid's coefficients were fitted on English and have no interpretation for it`
          : language.source === "input"
            ? `the locale given is not a language tag this can read; Flesch-Kincaid is English-only, so pass locale:"en" if the page is English`
            : declaredLang !== undefined && declaredLang.trim() !== ""
              ? `the page declares lang="${declaredLang}", which is not a language tag this can read, so it is not known to be English; Flesch-Kincaid is English-only, so pass locale:"en" if this page is English`
              : 'the page declares no language and none was given; Flesch-Kincaid\'s coefficients were fitted on English and mean nothing for anything else, so pass locale:"en" if this page is English',
      );
    } else if (proseWords.length < MIN_PROSE_WORDS || proseSentences.length === 0) {
      declineReadability(
        `${regionLabel} holds ${proseWords.length} words in ${proseSentences.length} sentence(s), under the ${MIN_PROSE_WORDS} words below which a grade is an artefact of the shortest sentence`,
      );
    } else {
      report.ran("readability.grade");
      const band = readabilityBand(proseWords, proseSentences.length);
      report.fail(
        "readability.grade",
        "info",
        `the prose reads at about ${band.band}${
          band.couldAlsoBe === undefined ? "" : `, and could as easily be ${band.couldAlsoBe}`
        } — a BAND and not a number on purpose: the syllable count behind it is a heuristic with a long exception list, so a grade to two decimals would invite writing against this tool's bugs rather than against readability`,
        regionLabel,
      );

      report.ran("readability.longSentences");
      const long = proseSentences
        .map((s) => ({ sentence: s, words: tokenize(s).length }))
        .filter((s) => s.words > LONG_SENTENCE_WORDS)
        .sort((a, b) => b.words - a.words);
      const longShare = long.length / proseSentences.length;
      if (longShare > 0.25 && long.length >= 3) {
        for (const item of long.slice(0, 5)) {
          report.fail(
            "readability.longSentences",
            "warn",
            `a sentence of ${item.words} words, in a page where ${Math.round(longShare * 100)}% run over ${LONG_SENTENCE_WORDS} — sentence boundaries here are decided from punctuation, so a decimal or an unusual abbreviation can merge two sentences into one long one`,
            `"${clip(item.sentence, 80)}"`,
            "split it at the conjunction",
          );
        }
      }

      report.ran("readability.passive");
      const passive = passiveCandidates(proseSentences);
      if (passive.length > 0) {
        report.fail(
          "readability.passive",
          "info",
          `${passive.length} of ${proseSentences.length} sentences LOOK passive to a regex, for example "${clip(passive[0] as string, 80)}" — without a part-of-speech tagger "was" plus an "-ed" word over-fires on "was tired" and "is interested", so these are candidates to read, never a count of passive sentences`,
          regionLabel,
        );
      }
    }

    // ----- JSON-LD -----
    // Read through tool-html's `extractStructuredData`, which already parses
    // the blocks and already reports the ones that do not parse rather than
    // dropping them. A second JSON-LD reader here would find a different
    // number of blocks on the same page.
    report.ran("jsonld.present");
    if (page.jsonLd.length === 0 && page.invalid.length === 0) {
      report.fail(
        "jsonld.present",
        "warn",
        "the page carries no JSON-LD, so nothing tells a search engine what kind of thing it is",
        "<head>",
        'add a <script type="application/ld+json"> block for the page\'s type',
      );
    }
    if (page.invalid.length > 0) {
      report.ran("jsonld.parse");
      page.invalid.forEach((message, index) => {
        report.fail(
          "jsonld.parse",
          "error",
          `a JSON-LD block does not parse: ${message}`,
          `script[type="application/ld+json"] (#${index + 1})`,
          "fix the JSON; a block that does not parse is read as no block at all",
        );
      });
    }
    if (page.jsonLd.length > 0) {
      report.ran("jsonld.shape");
      const unbundled = new Set<string>();
      page.jsonLd.forEach((block, index) => {
        for (const { at, node } of jsonLdNodes(block, `block #${index + 1}`)) {
          const type = typeOf(node);
          if (type === undefined) {
            report.fail(
              "jsonld.shape",
              "warn",
              "a JSON-LD node declares no @type, so nothing can be made of it",
              at,
              "give the node an @type",
            );
            continue;
          }
          if (at === `block #${index + 1}` && !declaresSchemaOrg(node)) {
            report.fail(
              "jsonld.shape",
              "warn",
              `the ${type} block declares no schema.org @context`,
              at,
              'add "@context": "https://schema.org"',
            );
          }
          // `schemaRuleFor`, never `SCHEMA_RULES[...]`: indexing the literal
          // walks Object.prototype, so a page whose @type is "constructor"
          // or "__proto__" finds something that is not a rule and takes the
          // whole lint down with it.
          const rule = schemaRuleFor(type);
          if (rule === undefined) {
            unbundled.add(type);
            continue;
          }
          report.ran("jsonld.fields");
          for (const field of rule.required) {
            if (hasValue(node, field)) continue;
            report.fail(
              "jsonld.fields",
              "error",
              `the ${type} node is missing "${field}", which its rich result requires`,
              at,
              `add "${field}"`,
            );
          }
          for (const field of rule.recommended) {
            if (hasValue(node, field)) continue;
            report.fail(
              "jsonld.fields",
              "warn",
              `the ${type} node has no "${field}", which its rich result uses when it is there`,
              at,
              `add "${field}" if the page has it`,
            );
          }
        }
      });
      for (const type of [...unbundled].sort()) {
        report.skip(
          "jsonld.fields",
          `no offline rule is bundled for @type "${type}", so its fields were NOT checked — this tool cannot reach schema.org, and the types it does carry are listed in SCHEMA_RULES`,
        );
      }
    }

    // ----- canonical, OpenGraph, Twitter -----
    report.ran("canonical.present");
    if (canonicalTarget === undefined) {
      report.fail(
        "canonical.present",
        "warn",
        "the page declares no canonical URL, so a duplicate at another path can outrank it",
        "<head>",
        'add <link rel="canonical" href="…">',
      );
      report.skip(
        "canonical.matchesUrl",
        "the page declares no canonical URL, so there was nothing to compare with",
      );
    } else {
      report.ran("canonical.absolute");
      if (canonicalTarget.kind !== "absolute") {
        report.fail(
          "canonical.absolute",
          "warn",
          `the canonical "${canonicalRaw}" is not an absolute URL, and a relative canonical is resolved differently by different crawlers`,
          "<head>",
          "give the canonical a scheme and a host",
        );
      }
      if (urlTarget === undefined) {
        report.skip(
          "canonical.matchesUrl",
          "no url was given, so the canonical was not compared with where the page will publish — pass url to run this",
          "not-requested",
        );
      } else if (urlTarget.kind === "unparsable") {
        report.skip(
          "canonical.matchesUrl",
          `the url given could not be parsed: ${urlTarget.reason}`,
        );
      } else if (urlTarget.kind !== canonicalTarget.kind) {
        // A genuine MIX. Two paths carry no host between them and compare
        // fine; it is one of each that cannot be compared without inventing
        // the host the path is missing, and the reason has to say which of
        // the two cases it is rather than assert the mix either way.
        report.skip(
          "canonical.matchesUrl",
          `the canonical is ${canonicalTarget.kind === "absolute" ? "an absolute URL" : "a path"} and the url given is ${urlTarget.kind === "absolute" ? "an absolute URL" : "a path"}, so the two cannot be compared without guessing the missing host`,
        );
      } else if (urlTarget.kind === "path" && canonicalTarget.kind === "path") {
        report.ran("canonical.matchesUrl");
        const declared = pathForm(canonicalTarget);
        const intended = pathForm(urlTarget);
        if (declared !== intended) {
          report.fail(
            "canonical.matchesUrl",
            "error",
            `the canonical points at ${declared} while the page will publish at ${intended} — both are paths, compared after dropping a trailing slash and any fragment, so this is a real difference`,
            "<head>",
            "point the canonical at this page, or publish it where the canonical says",
          );
        }
      } else if (urlTarget.kind !== "absolute" || canonicalTarget.kind !== "absolute") {
        report.skip(
          "canonical.matchesUrl",
          "neither the canonical nor the url given is a form this can compare",
        );
      } else {
        // Compared on the PARSED values, never on the two strings: case in
        // the host and a trailing slash are not differences, and comparing
        // spellings reports them as if they were.
        report.ran("canonical.matchesUrl");
        const declared = canonicalForm(canonicalTarget.url);
        const intended = canonicalForm(urlTarget.url);
        if (declared !== intended) {
          report.fail(
            "canonical.matchesUrl",
            "error",
            `the canonical points at ${declared} while the page will publish at ${intended} — compared after lowercasing the scheme and host and dropping a trailing slash and any fragment, so this is a real difference`,
            "<head>",
            "point the canonical at this page, or publish it where the canonical says",
          );
        }
      }
    }

    report.ran("og.present");
    const missingOg = ["title", "description", "image"].filter(
      (key) => (page.openGraph[key] ?? "").trim() === "",
    );
    if (missingOg.length > 0) {
      report.fail(
        "og.present",
        "warn",
        `the page has no og:${missingOg.join(", no og:")}, so a shared link is composed by guesswork`,
        "<head>",
        "add the OpenGraph tags a share card needs",
      );
    }

    report.ran("og.consistency");
    const ogTitle = (page.openGraph["title"] ?? "").trim();
    if (ogTitle !== "" && title !== "" && ogTitle !== title) {
      report.fail(
        "og.consistency",
        "info",
        `og:title is "${ogTitle}" and <title> is "${title}"; a deliberate difference is fine, this only reports that they differ`,
        "<head>",
      );
    }
    const ogDescription = (page.openGraph["description"] ?? "").trim();
    if (ogDescription !== "" && description !== "" && ogDescription !== description) {
      report.fail(
        "og.consistency",
        "info",
        "og:description and the meta description differ; a deliberate difference is fine, this only reports that they differ",
        "<head>",
      );
    }
    const ogUrl = (page.openGraph["url"] ?? "").trim();
    if (ogUrl !== "" && canonicalTarget?.kind === "absolute") {
      const parsed = parseTarget(ogUrl);
      if (
        parsed.kind === "absolute" &&
        canonicalForm(parsed.url) !== canonicalForm(canonicalTarget.url)
      ) {
        report.fail(
          "og.consistency",
          "warn",
          `og:url resolves to ${canonicalForm(parsed.url)} and the canonical to ${canonicalForm(canonicalTarget.url)}; the page is claiming two different addresses for itself`,
          "<head>",
          "make og:url the canonical",
        );
      }
    }

    report.ran("twitter.card");
    const twitterKeys = Object.keys(page.twitter);
    if (twitterKeys.length > 0 && (page.twitter["card"] ?? "").trim() === "") {
      report.fail(
        "twitter.card",
        "warn",
        `the page has twitter:${twitterKeys.join(", twitter:")} but no twitter:card, and without it the rest is ignored`,
        "<head>",
        'add <meta name="twitter:card" content="summary_large_image">',
      );
    }

    // ----- slug -----
    if (pathname === undefined) {
      report.skip(
        "slug.format",
        "no url was given and the page declares no absolute canonical, so there is no path to read a slug from — pass url to run this",
        "not-requested",
      );
    } else {
      report.ran("slug.format");
      for (const issue of slugIssues(pathname)) {
        report.fail("slug.format", "warn", issue.detail, pathname, issue.fix);
      }
    }

    // ----- near-duplicate: the check that must never pass by default -----
    let comparedWith = 0;
    let corpusRel: string | undefined;
    if (input.corpus === undefined) {
      report.skip(
        "duplicate.nearMatch",
        "no corpus was configured, so this page was NOT compared with anything — this check does not pass by default; pass corpus with the directory of already-published pages",
        "not-requested",
      );
    } else {
      const corpus = readCorpus(input.corpus, pageReal);
      if (corpus.kind === "unusable") {
        report.skip("duplicate.nearMatch", corpus.reason);
      } else if (prose.trim() === "") {
        report.skip(
          "duplicate.nearMatch",
          `${regionLabel} holds no prose, so there was nothing to compare against the ${corpus.docs.length} corpus document(s)`,
        );
      } else if (prose.length > CORPUS.pageChars) {
        report.skip(
          "duplicate.nearMatch",
          `the page holds ${prose.length} characters of prose, over the ${CORPUS.pageChars} this compares in one run`,
        );
      } else {
        report.ran("duplicate.nearMatch");
        corpusRel = corpus.rel;
        comparedWith = corpus.docs.length;
        const threshold = input.duplicateThreshold ?? DEFAULT_DUPLICATE_THRESHOLD;
        const matches: Array<{ rel: string; score: number }> = [];
        for (const doc of corpus.docs) {
          const score = await trigramSimilarity(prose, doc.text);
          if (score >= threshold) matches.push({ rel: doc.rel, score });
        }
        for (const match of matches.sort((a, b) => b.score - a.score)) {
          report.fail(
            "duplicate.nearMatch",
            "error",
            `the prose is ${match.score.toFixed(2)} similar to ${match.rel} by trigram overlap (@crewhaus/tool-text TextSimilarity), at or over the ${threshold} threshold`,
            regionLabel,
            "rewrite the overlapping section, or make one of the two canonical to the other",
          );
        }
        if (corpus.skipped.length > 0) {
          report.skip(
            "duplicate.nearMatch",
            `${corpus.skipped.length} file(s) in the corpus were not compared: ${corpus.skipped
              .slice(0, 3)
              .map((s) => `${s.file} (${s.reason})`)
              .join("; ")}${corpus.skipped.length > 3 ? ", and others" : ""}`,
          );
        }
      }
    }

    const { errors, warnings, observations, notChecked, notRequested, passed, suppressed } =
      report.finish();
    return json({
      from,
      // Strict where it means something: a check that WAS asked and could not
      // be answered withholds the pass, so a lint cannot degrade quietly into
      // one. A check nobody asked for does not — `notRequested` is beside it
      // and named, and folding the two together made `ok` false on every
      // ordinary invocation, which costs the signal the strict rule exists to
      // protect. `ok` therefore means: nothing failed, and everything this run
      // was asked to look at was looked at. It does NOT mean every check in
      // the catalog ran; `notRequested` says which did not, and reading `ok`
      // as "no near-duplicate" without passing a corpus is the one misreading
      // to guard against — which is why that entry spells it out in full.
      ok: errors.length === 0 && notChecked.length === 0,
      counts: {
        errors: errors.length,
        warnings: warnings.length,
        observations: observations.length,
        notChecked: notChecked.length,
        notRequested: notRequested.length,
        passed: passed.length,
      },
      language: {
        tag: language.tag ?? null,
        from: language.source,
        wordBoundaries: language.segmentsOnWhitespace,
      },
      prose: {
        region: regionLabel,
        words: language.segmentsOnWhitespace ? proseWords.length : null,
        // Withheld on exactly the same grounds as the word count. The
        // splitter ends a sentence on ".", "!" and "?" and on a block
        // boundary, so over prose that ends its sentences with "。" it
        // counts paragraphs — a confident number for a thing it did not
        // measure, sitting next to a word count that was honestly withheld.
        sentences: language.segmentsOnWhitespace ? proseSentences.length : null,
        characters: prose.length,
      },
      ...(corpusRel === undefined ? {} : { corpus: { path: corpusRel, comparedWith } }),
      errors,
      warnings,
      observations,
      notChecked,
      notRequested,
      passed,
      ...(Object.keys(suppressed).length === 0 ? {} : { suppressed }),
      note: "ok is false whenever a check was asked for and could not be answered, even when nothing failed — read notChecked for what to fix. Checks nobody asked for are listed separately under notRequested and do not withhold ok, so ok: true means nothing failed and everything this run was asked to look at was looked at — never that every check in the catalog ran. In particular a run with no corpus says nothing about near-duplicates. Readability is a band and never a number: the syllable count behind Flesch-Kincaid is a heuristic, and the passive-voice and long-sentence figures over-fire without a part-of-speech tagger, so they are observations rather than findings. Keyword density disables itself where words are not separated by spaces. passed lists the checks that ran, found nothing at error or warning severity, and withheld nothing — a check with an entry in notChecked never appears there, even when the part of it that ran was clean; a check that had nothing to examine is reported by the check that found it missing (title.present, jsonld.present) and never appears in passed. Nothing here fetches: link targets are not resolved, and schema.org is not consulted — JSON-LD is checked for shape and for the fields the rich results require, never for whether a property name exists in the vocabulary or holds the right type.",
    });
  },
});

/** Every tool this package registers, in the order a catalog should list them. */
export const VERIFY_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  acceptanceCheck,
  checksumVerify,
  citationLint,
  factCrossCheck,
  goldenCompare,
  goldenUpdate,
  markdownLinkCheck,
  seoLint,
]);
