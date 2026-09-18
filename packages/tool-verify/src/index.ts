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
import { dirname, join, relative, resolve } from "node:path";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { extractMarkdownLinks, headingAnchors, lintCitations } from "./lib/markdown";
import { NORMALIZERS, type Normalizer, firstDifferences, normalizeOutput } from "./lib/normalize";
import { resolveSafe, workspaceRoot } from "./paths";

const json = (value: unknown): string => JSON.stringify(value);

const LIMITS = {
  files: 20_000,
  fileBytes: 256 * 1024 * 1024,
  textChars: 16 * 1024 * 1024,
  checks: 200,
  diffLines: 50,
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
            ok: body !== null && body.includes(check.text),
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
        if (/^[a-z][a-z0-9+.-]*:/i.test(link.href)) {
          external++;
          continue;
        }
        const [target = "", fragment] = link.href.split("#");
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
        const resolved = resolve(dirname(abs), target);
        // Containment applies to a link's target too: a doc must not be able
        // to make this tool stat something outside the workspace.
        const rel = relative(workspaceRoot(), resolved);
        if (rel.startsWith("..")) {
          broken.push({
            file: label,
            line: link.line,
            href: link.href,
            reason: "the target is outside the workspace",
          });
          continue;
        }
        let ok = false;
        try {
          statSync(resolved);
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
          const targetAnchors = headingAnchors(readCapped(resolved, target).toString("utf-8"));
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

/** Every tool this package registers, in the order a catalog should list them. */
export const VERIFY_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  acceptanceCheck,
  checksumVerify,
  citationLint,
  goldenCompare,
  goldenUpdate,
  markdownLinkCheck,
]);
