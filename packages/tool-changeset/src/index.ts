/**
 * @crewhaus/tool-changeset — everything you can decide about a change set
 * before it becomes a pull request.
 *
 * Two questions, both of which a model answers plausibly and incompletely:
 *
 *   - `DiffLint`: does this change add anything the team already decided it
 *     does not want — a focused test, a `debugger`, a merge marker, a TODO
 *     nobody will find, a path that only exists on one laptop.
 *   - `DocsSymbolCheck`: does the documentation still name things the code
 *     still has.
 *
 * Both are review passes, and a review pass earns its place only by being
 * boring: same change set, same findings, every time, with no judgement about
 * whether the code is any good. Where a rule has to guess it says so, ships
 * at warning severity, and can be turned off by name — a check that cries
 * wolf is turned off wholesale, and then it catches nothing at all.
 */
import { type Dirent, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { parseUnifiedDiff } from "@crewhaus/tool-text";
import { z } from "zod";
import { MAX_DIFF_CHARS, MAX_TIMEOUT_MS, collectDiff } from "./git";
import {
  type CheckOptions,
  type DocRef,
  type ExtractOptions,
  buildTokenIndex,
  checkRefs,
  extractDocRefs,
} from "./lib/docs";
import { RULE_IDS, type RuleId, lintParsedDiff } from "./lib/rules";
import { ToolPermissionError, resolveSafe, toPosix, workspaceRoot } from "./paths";

/** Compact JSON — the reader is a model, not a person, so no indentation. */
const json = (value: unknown): string => JSON.stringify(value);

const LIMITS = {
  /** Documents read in one call. */
  docs: 500,
  /** Source files read in one call, before the scan is refused as incomplete. */
  sourceFiles: 5_000,
  /** A single file this big is not documentation or source. */
  fileBytes: 4 * 1024 * 1024,
  docChars: 4_000_000,
} as const;

const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "target",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__",
]);

// ---------------------------------------------------------------------------
// DiffLint

const ruleIdField = z.enum(RULE_IDS);

export const diffLint: RegisteredTool = buildTool({
  name: "DiffLint",
  description:
    "Run a policy pass over ONLY the added lines of a change set: focused tests, debugger statements, console.log, committed merge-conflict markers, new @ts-ignore, TODOs with no ticket, machine-specific absolute paths, CRLF, and files that added more than they should. Use it before committing or opening a pull request, in place of reading a diff and hoping to notice. Every finding carries the line number in the NEW file, so it can be fixed without re-reading anything. Give it `diff` text if you already have the patch; otherwise it runs `git diff` for you. The commented-out-code rule is a heuristic and is off unless you enable it.",
  inputSchema: z.object({
    diff: z
      .string()
      .max(MAX_DIFF_CHARS)
      .optional()
      .describe("unified diff text; pass this when you already have the patch"),
    cwd: z.string().optional().describe("directory inside the workspace to run git in"),
    ref: z.string().min(1).optional().describe("diff against this single ref"),
    range: z.string().min(1).optional().describe("a commit range such as 'main...HEAD'"),
    staged: z.boolean().optional().describe("diff the index against HEAD instead of the worktree"),
    paths: z.array(z.string().min(1)).max(256).optional().describe("limit to these paths"),
    timeout: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
    enable: z.array(ruleIdField).max(RULE_IDS.length).optional().describe("turn opt-in rules on"),
    disable: z.array(ruleIdField).max(RULE_IDS.length).optional(),
    ticketPattern: z
      .string()
      .max(400)
      .optional()
      .describe("regex a TODO must match to count as ticketed; default 'ABC-123', '#123' or a URL"),
    machinePathPatterns: z
      .array(z.string().max(400))
      .max(32)
      .optional()
      .describe("extra machine-specific path shapes, as regex sources"),
    maxLineChars: z.number().int().positive().max(100_000).optional().describe("default 1000"),
    maxAddedLinesPerFile: z.number().int().positive().max(1_000_000).optional(),
    maxFindings: z.number().int().positive().max(5_000).optional().describe("default 500"),
  }),
  readOnly: true,
  concurrencySafe: true,
  // Static flags describe the worst case: given `diff` text this tool spawns
  // nothing, but the same tool can spawn git, and a capability that is
  // sometimes true is true.
  scope: "external",
  ioCapability: "process",
  execute: async (input, ctx) => {
    const usesGit =
      input.cwd !== undefined ||
      input.ref !== undefined ||
      input.range !== undefined ||
      input.staged !== undefined ||
      input.paths !== undefined;
    if (input.diff !== undefined && usesGit) {
      return "DiffLint takes either `diff` text or a git selector (cwd/ref/range/staged/paths), not both — with the text in hand there is nothing for git to do.";
    }

    // Compiling the caller's patterns before anything else: a bad regex is a
    // caller mistake, and it should be reported as one rather than as an
    // empty result that looks like a clean change set.
    let ticket: RegExp | undefined;
    if (input.ticketPattern !== undefined) {
      try {
        ticket = new RegExp(input.ticketPattern);
      } catch (err) {
        return `DiffLint could not use ticketPattern /${input.ticketPattern}/: ${(err as Error).message}`;
      }
    }
    const machinePatterns: RegExp[] = [];
    for (const source of input.machinePathPatterns ?? []) {
      try {
        machinePatterns.push(new RegExp(source));
      } catch (err) {
        return `DiffLint could not use the machine-path pattern /${source}/: ${(err as Error).message}`;
      }
    }

    let diffText: string;
    let source: string;
    let spawnTruncated = false;
    if (input.diff !== undefined) {
      diffText = input.diff;
      source = "caller-supplied diff";
    } else {
      const collected = await collectDiff(
        "DiffLint",
        {
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          ...(input.ref !== undefined ? { ref: input.ref } : {}),
          ...(input.range !== undefined ? { range: input.range } : {}),
          ...(input.staged !== undefined ? { staged: input.staged } : {}),
          ...(input.paths !== undefined ? { paths: input.paths } : {}),
          ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
        },
        ctx?.signal,
      );
      if (!collected.ok) return collected.message;
      diffText = collected.value.diff;
      source = collected.value.command;
      spawnTruncated = collected.value.truncated;
    }

    if (diffText.length > MAX_DIFF_CHARS) {
      return `DiffLint refused a ${diffText.length}-character diff, over the ${MAX_DIFF_CHARS} limit — lint it a directory at a time with \`paths\`.`;
    }

    const parsed = parseUnifiedDiff(diffText);
    const result = lintParsedDiff(parsed, {
      ...(input.enable !== undefined ? { enable: input.enable as ReadonlyArray<RuleId> } : {}),
      ...(input.disable !== undefined ? { disable: input.disable as ReadonlyArray<RuleId> } : {}),
      ...(ticket !== undefined ? { ticketPattern: ticket } : {}),
      ...(machinePatterns.length > 0 ? { machinePathPatterns: machinePatterns } : {}),
      ...(input.maxLineChars !== undefined ? { maxLineChars: input.maxLineChars } : {}),
      ...(input.maxAddedLinesPerFile !== undefined
        ? { maxAddedLinesPerFile: input.maxAddedLinesPerFile }
        : {}),
      ...(input.maxFindings !== undefined ? { maxFindings: input.maxFindings } : {}),
    });

    // A patch that could not be parsed whole is reported as such rather than
    // as a clean bill of health: the parser's warnings are the only thing
    // standing between "no findings" and "no findings in the part I read".
    const warnings = [...parsed.warnings];
    if (spawnTruncated) {
      warnings.push(
        `git's output hit the ${MAX_DIFF_CHARS}-character cap and the tail of the change set was not linted — narrow it with \`paths\``,
      );
    }

    return json({
      source,
      filesScanned: result.filesScanned,
      addedLinesScanned: result.addedLinesScanned,
      findings: result.findings,
      counts: result.counts,
      ...(result.skipped.length > 0 ? { skipped: result.skipped } : {}),
      ...(result.truncated ? { findingsTruncated: true } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(result.findings.length === 0 && warnings.length === 0 ? { clean: true } : {}),
    });
  },
});

// ---------------------------------------------------------------------------
// DocsSymbolCheck

type Collected = {
  readonly files: Array<{ path: string; text: string }>;
  /** Files that exist but were not read, which makes the scan incomplete. */
  readonly oversized: string[];
  /**
   * Directories the walk could not list. Every file under one of these is a
   * hole in the index, and a hole is how "I never looked there" turns into
   * "this symbol is gone" — so the caller has to be told, not spared.
   */
  readonly unreadableDirs: string[];
  /** Symlinked entries whose target is outside the workspace; never opened. */
  readonly escaped: string[];
  hitFileCap: boolean;
};

const newCollected = (): Collected => ({
  files: [],
  oversized: [],
  unreadableDirs: [],
  escaped: [],
  hitFileCap: false,
});

/** Read one file, or report it as oversized rather than pulling it into memory. */
function readIfSmall(abs: string, rel: string, into: Collected): void {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(abs);
  } catch {
    return; // vanished between the listing and the read, or a dangling link
  }
  // A link to a directory, a fifo, a device: `readFileSync` either fails or
  // blocks, and calling that "too large to read" would refuse the whole scan
  // with a reason that is not true.
  if (!stat.isFile()) return;
  if (stat.size > LIMITS.fileBytes) {
    into.oversized.push(rel);
    return;
  }
  try {
    into.files.push({ path: rel, text: readFileSync(abs, "utf-8") });
  } catch {
    into.oversized.push(rel);
  }
}

/**
 * Every file under `root` with one of `extensions`, workspace-relative and in
 * a stable order.
 *
 * `readdirSync` order is filesystem order, not an order anything should
 * depend on, so each directory is sorted before it is walked: the same tree
 * produces the same listing on macOS and on a Linux runner.
 *
 * Containment does not stop at the root the caller named. `resolveSafe` gates
 * that path, but a walk of it opens files the caller never named, and
 * `readFileSync` FOLLOWS a symlink (CWE-59): a `docs/notes.md -> ~/.ssh/known_hosts`
 * inside the workspace reads a file outside it, and this tool quotes a
 * document's line back in `context`. So every symlinked entry is resolved
 * before it is opened, and one that lands outside the workspace is recorded
 * and skipped. A symlinked DIRECTORY is not walked at all — `isDirectory()`
 * is false for a link — which is also what keeps a link cycle from recursing.
 */
function collectFiles(
  toolName: string,
  root: string,
  extensions: ReadonlySet<string>,
  cap: number,
  into: Collected = newCollected(),
  rel = "",
): Collected {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    into.unreadableDirs.push(rel === "" ? "." : toPosix(rel));
    return into;
  }
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (into.hitFileCap) return into;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectFiles(toolName, root, extensions, cap, into, join(rel, entry.name));
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const dot = entry.name.lastIndexOf(".");
    if (dot <= 0 || !extensions.has(entry.name.slice(dot).toLowerCase())) continue;
    // The cap is checked at the file that would actually be read, not once
    // per directory entry: a tree holding exactly `cap` sources and one image
    // sorted after them had nothing left unread, and used to refuse anyway.
    if (into.files.length >= cap) {
      into.hitFileCap = true;
      return into;
    }
    const abs = join(root, rel, entry.name);
    const relPath = toPosix(join(rel, entry.name));
    if (entry.isSymbolicLink()) {
      try {
        resolveSafe(toolName, abs);
      } catch {
        into.escaped.push(relPath);
        continue;
      }
    }
    readIfSmall(abs, relPath, into);
  }
  return into;
}

/** Extensions scanned for "does this identifier still exist anywhere". */
const DEFAULT_SOURCE_EXTENSIONS: ReadonlyArray<string> = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".swift",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
];

const DOC_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".mdx", ".markdown"]);

export const docsSymbolCheck: RegisteredTool = buildTool({
  name: "DocsSymbolCheck",
  description:
    "Find documentation that names symbols the code no longer has. Point it at markdown and at the source tree the markdown is about; it reports each documented symbol whose identifier appears NOWHERE in the scanned sources, with the document and line. It is built to under-report: only backticked identifiers and named imports inside fenced blocks count as references, a name shaped like an English word is skipped unless written as a call, and a document whose references mostly do not resolve is reported as probably describing a different tree rather than as a page full of dead symbols. A scan that could not read the whole source tree is refused rather than answered, because an incomplete index invents missing symbols.",
  inputSchema: z.object({
    docs: z
      .array(z.string().min(1))
      .max(LIMITS.docs)
      .optional()
      .describe("markdown files or directories, relative to the workspace root"),
    docsText: z.string().max(LIMITS.docChars).optional().describe("or the document text itself"),
    docsLabel: z.string().max(200).optional().describe("what to call `docsText` in findings"),
    source: z
      .string()
      .min(1)
      .optional()
      .describe("the source tree the docs describe; defaults to the working directory"),
    extensions: z
      .array(z.string().min(2).max(16))
      .max(64)
      .optional()
      .describe("source extensions to index, each with its dot"),
    localPrefixes: z
      .array(z.string().min(1).max(200))
      .max(64)
      .optional()
      .describe("module specifier prefixes that mean 'this project', e.g. '@acme/'"),
    include: z.enum(["imports", "backticks", "both"]).optional().describe("default 'both'"),
    minLength: z.number().int().min(1).max(64).optional().describe("default 4"),
    requireDistinctive: z
      .boolean()
      .optional()
      .describe("skip plain lowercase words like `build`; default true"),
    ignore: z.array(z.string().min(1).max(200)).max(500).optional(),
    minResolvedRatio: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        "share of a document's references that must resolve before misses count; default 0.25",
      ),
    reportUnmatchedDocs: z
      .boolean()
      .optional()
      .describe("report misses even from a document that mostly does not resolve"),
    allowUnreadableSources: z
      .boolean()
      .optional()
      .describe("continue when a source file was too large to read; default false, which refuses"),
    maxFiles: z.number().int().positive().max(LIMITS.sourceFiles).optional(),
    maxFindings: z.number().int().positive().max(2_000).optional().describe("default 200"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    if (input.docs === undefined && input.docsText === undefined) {
      return "DocsSymbolCheck needs something to read: pass `docs` (files or directories) or `docsText`.";
    }

    const root = workspaceRoot();
    const extensions = new Set(
      (input.extensions ?? DEFAULT_SOURCE_EXTENSIONS).map((e) =>
        (e.startsWith(".") ? e : `.${e}`).toLowerCase(),
      ),
    );

    let sourceDir: string;
    try {
      sourceDir = resolveSafe("DocsSymbolCheck", input.source ?? ".").real;
    } catch (err) {
      if (err instanceof ToolPermissionError) {
        return `DocsSymbolCheck refused the source path "${input.source ?? "."}": it resolves outside the workspace root.`;
      }
      throw err;
    }
    try {
      if (!statSync(sourceDir).isDirectory()) {
        return `DocsSymbolCheck refused "${input.source ?? "."}": \`source\` must be a directory containing the code the docs describe.`;
      }
    } catch {
      return `DocsSymbolCheck could not read "${input.source ?? "."}": no such directory.`;
    }

    const sources = collectFiles(
      "DocsSymbolCheck",
      sourceDir,
      extensions,
      input.maxFiles ?? LIMITS.sourceFiles,
    );

    // All three of these make the index incomplete, and an incomplete index
    // turns "I did not look there" into "this symbol is gone". Refusing is
    // the only honest answer; the alternative is a confident lie in the
    // direction that costs this tool its credibility.
    if (sources.hitFileCap) {
      return `DocsSymbolCheck stopped after ${input.maxFiles ?? LIMITS.sourceFiles} source files, so the symbol index is incomplete and a missing symbol could simply be one it never read. Point \`source\` at a narrower tree, or raise \`maxFiles\`.`;
    }
    if (sources.unreadableDirs.length > 0 && input.allowUnreadableSources !== true) {
      return `DocsSymbolCheck could not list ${sources.unreadableDirs.length} directory(ies) under "${input.source ?? "."}" (${sources.unreadableDirs.slice(0, 5).join(", ")}), so the symbol index is missing everything inside them and a symbol that lives only there would be reported as deleted. Fix the permissions, narrow \`source\`, or pass allowUnreadableSources to accept the gap.`;
    }
    if (sources.oversized.length > 0 && input.allowUnreadableSources !== true) {
      return `DocsSymbolCheck could not read ${sources.oversized.length} source file(s) over ${LIMITS.fileBytes} bytes (${sources.oversized.slice(0, 5).join(", ")}), so the symbol index is incomplete. Exclude them with \`extensions\`, or pass allowUnreadableSources to accept the gap.`;
    }
    if (sources.files.length === 0) {
      return `DocsSymbolCheck found no source files under "${input.source ?? "."}" with the extensions it was given, so every documented symbol would look deleted. Check the path, or pass \`extensions\`.`;
    }

    const index = new Set<string>();
    for (const file of sources.files) buildTokenIndex(file.text, index);

    const extractOptions: ExtractOptions = {
      ...(input.include !== undefined ? { include: input.include } : {}),
      ...(input.localPrefixes !== undefined ? { localPrefixes: input.localPrefixes } : {}),
      ...(input.minLength !== undefined ? { minLength: input.minLength } : {}),
      ...(input.requireDistinctive !== undefined
        ? { requireDistinctive: input.requireDistinctive }
        : {}),
      ...(input.ignore !== undefined ? { ignore: input.ignore } : {}),
    };

    const refs: DocRef[] = [];
    const docNames: string[] = [];
    const unreadable: string[] = [];
    const docDirsUnreadable: string[] = [];
    const docsEscaped: string[] = [];
    let docsHitCap = false;
    if (input.docsText !== undefined) {
      const label = input.docsLabel ?? "(docsText)";
      docNames.push(label);
      refs.push(...extractDocRefs(input.docsText, label, extractOptions));
    }
    for (const given of input.docs ?? []) {
      let target: string;
      try {
        target = resolveSafe("DocsSymbolCheck", given).real;
      } catch (err) {
        if (err instanceof ToolPermissionError) {
          return `DocsSymbolCheck refused the document path "${given}": it resolves outside the workspace root.`;
        }
        throw err;
      }
      let isDir = false;
      try {
        isDir = statSync(target).isDirectory();
      } catch {
        return `DocsSymbolCheck could not read "${given}": no such file or directory.`;
      }
      const found = isDir
        ? collectFiles("DocsSymbolCheck", target, DOC_EXTENSIONS, LIMITS.docs)
        : (() => {
            const one = newCollected();
            readIfSmall(target, toPosix(relative(root, target)), one);
            return one;
          })();
      unreadable.push(...found.oversized);
      docDirsUnreadable.push(...found.unreadableDirs);
      docsEscaped.push(...found.escaped);
      docsHitCap ||= found.hitFileCap;
      for (const file of found.files) {
        // A directory walk yields paths relative to that directory; a
        // workspace-relative name is what a reader can act on.
        const name = isDir ? toPosix(join(toPosix(relative(root, target)), file.path)) : file.path;
        docNames.push(name);
        refs.push(...extractDocRefs(file.text, name, extractOptions));
      }
    }

    if (docNames.length === 0) {
      return `DocsSymbolCheck found no markdown to read in ${JSON.stringify(input.docs ?? [])}. Pass a .md file, a directory containing one, or \`docsText\`.`;
    }

    const checkOptions: CheckOptions = {
      ...(input.minResolvedRatio !== undefined ? { minResolvedRatio: input.minResolvedRatio } : {}),
      ...(input.reportUnmatchedDocs !== undefined
        ? { reportUnmatchedDocs: input.reportUnmatchedDocs }
        : {}),
      ...(input.maxFindings !== undefined ? { maxFindings: input.maxFindings } : {}),
    };
    const verdict = checkRefs(refs, index, checkOptions);

    const warnings: string[] = [];
    if (unreadable.length > 0) {
      warnings.push(
        `${unreadable.length} document(s) were too large to read: ${unreadable.slice(0, 5).join(", ")}`,
      );
    }
    // A document walk that stopped early reads FEWER docs, which under-reports
    // rather than inventing — so it warns instead of refusing. Saying nothing
    // would still be wrong: "no findings" and "no findings in the 500 pages I
    // got to" are different answers.
    if (docsHitCap) {
      warnings.push(
        `the document walk stopped after ${LIMITS.docs} files, so any document past that was not checked — pass a narrower \`docs\` list`,
      );
    }
    if (docDirsUnreadable.length > 0) {
      warnings.push(
        `${docDirsUnreadable.length} documentation directory(ies) could not be listed and were not checked: ${docDirsUnreadable.slice(0, 5).join(", ")}`,
      );
    }
    for (const [kind, escaped] of [
      ["document", docsEscaped],
      ["source", sources.escaped],
    ] as const) {
      if (escaped.length === 0) continue;
      warnings.push(
        `${escaped.length} ${kind} symlink(s) point outside the workspace root and were not read: ${escaped.slice(0, 5).join(", ")}${kind === "source" ? " — a symbol that lives only behind one of them reads as missing" : ""}`,
      );
    }
    if (sources.oversized.length > 0) {
      warnings.push(
        `${sources.oversized.length} source file(s) were too large to index, so a symbol that lives only in one of them reads as missing`,
      );
    }
    if (sources.unreadableDirs.length > 0) {
      warnings.push(
        `${sources.unreadableDirs.length} source directory(ies) could not be listed, so a symbol that lives only inside one of them reads as missing: ${sources.unreadableDirs.slice(0, 5).join(", ")}`,
      );
    }

    return json({
      docsScanned: docNames.length,
      sourceFilesScanned: sources.files.length,
      identifiersIndexed: index.size,
      references: verdict.references,
      resolved: verdict.resolved,
      missing: verdict.missing.map((ref) => ({
        symbol: ref.symbol,
        doc: ref.doc,
        line: ref.line,
        evidence: ref.evidence,
        context: ref.context,
      })),
      ...(verdict.withheld > 0 ? { withheld: verdict.withheld } : {}),
      ...(verdict.truncated ? { findingsTruncated: true } : {}),
      coverage: verdict.coverage,
      ...(warnings.length > 0 ? { warnings } : {}),
      method:
        "a documented symbol is reported only when its identifier appears nowhere in the scanned sources — code, comments, strings and config alike",
    });
  },
});

/** Every tool this package registers, in the order a catalog should list them. */
export const CHANGESET_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  diffLint,
  docsSymbolCheck,
]);

/**
 * The rule vocabulary, for a caller that builds its own `enable`/`disable`
 * list and wants to validate it before the call rather than read a schema
 * rejection afterwards.
 */
export { RULE_IDS, type RuleId, unknownRuleIds } from "./lib/rules";
