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
import { type SafePath, ToolPermissionError, resolveSafe, workspaceRoot } from "./paths";

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

/** Every tool this package registers, in the order a catalog should list them. */
export const VERIFY_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  acceptanceCheck,
  checksumVerify,
  citationLint,
  factCrossCheck,
  goldenCompare,
  goldenUpdate,
  markdownLinkCheck,
]);
