import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
/**
 * Both tools through their own `execute`, against a real temporary workspace
 * and a real git repository.
 *
 * Containment is relative to `process.cwd()`, so every test runs inside a
 * temporary directory and the escape tests reach for a path outside it. The
 * workspace is realpath'd before the chdir: on macOS `/tmp` is a symlink to
 * `/private/tmp`, and a root that is not already real makes every contained
 * path look like an escape.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHANGESET_TOOLS, diffLint, docsSymbolCheck } from "./index";

// biome-ignore lint/suspicious/noExplicitAny: the executor supplies this context, and neither tool reads anything but `signal` from it.
const ctx = {} as any;

async function callRaw(tool: (typeof CHANGESET_TOOLS)[number], input: unknown): Promise<string> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`schema rejected the input: ${parsed.error.message}`);
  return tool.execute(parsed.data, ctx);
}

async function call<T = Record<string, unknown>>(
  tool: (typeof CHANGESET_TOOLS)[number],
  input: unknown,
): Promise<T> {
  const out = await callRaw(tool, input);
  return JSON.parse(out) as T;
}

type LintResponse = {
  source: string;
  filesScanned: number;
  addedLinesScanned: number;
  findings: Array<{ rule: string; severity: string; file: string; line: number | null }>;
  counts: { byRule: Record<string, number>; bySeverity: Record<string, number> };
  clean?: boolean;
  warnings?: string[];
  skipped?: Array<{ file: string; why: string }>;
};

type DocsResponse = {
  docsScanned: number;
  sourceFilesScanned: number;
  references: number;
  resolved: number;
  missing: Array<{ symbol: string; doc: string; line: number; evidence: string }>;
  coverage: Array<{ doc: string; references: number; resolved: number; suppressed?: string }>;
  withheld?: number;
  findingsTruncated?: boolean;
  warnings?: string[];
};

function git(args: string[], cwd: string): void {
  const run = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${run.stderr.toString()}`);
  }
}

const originalCwd = process.cwd();
let workspace: string;
let savedGlobal: string | undefined;
let savedSystem: string | undefined;

beforeAll(() => {
  // The operator's own git config must not decide what these tests see.
  savedGlobal = process.env["GIT_CONFIG_GLOBAL"];
  savedSystem = process.env["GIT_CONFIG_SYSTEM"];
  process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  process.env["GIT_CONFIG_SYSTEM"] = "/dev/null";
});

afterAll(() => {
  if (savedGlobal === undefined) Reflect.deleteProperty(process.env, "GIT_CONFIG_GLOBAL");
  else process.env["GIT_CONFIG_GLOBAL"] = savedGlobal;
  if (savedSystem === undefined) Reflect.deleteProperty(process.env, "GIT_CONFIG_SYSTEM");
  else process.env["GIT_CONFIG_SYSTEM"] = savedSystem;
});

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-changeset-")));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

/** A repository with one commit, ready for a working-tree change. */
function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(["init", "-b", "main"], dir);
  git(["config", "user.name", "A U Thor"], dir);
  git(["config", "user.email", "author@example.com"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/app.ts"), "export const version = 1;\n");
  git(["add", "-A"], dir);
  git(["commit", "-m", "initial"], dir);
}

describe("package-wide contract", () => {
  test("both tools are exported and named uniquely", () => {
    expect(CHANGESET_TOOLS.map((t) => t.name)).toEqual(["DiffLint", "DocsSymbolCheck"]);
    expect(new Set(CHANGESET_TOOLS.map((t) => t.name)).size).toBe(CHANGESET_TOOLS.length);
  });

  test("both are read-only, and only the one that spawns git says so", () => {
    for (const tool of CHANGESET_TOOLS) {
      expect(tool.readOnly).toBe(true);
      expect(tool.destructive).toBe(false);
    }
    expect(diffLint.ioCapability).toBe("process");
    expect(diffLint.scope).toBe("external");
    expect(docsSymbolCheck.ioCapability).toBeUndefined();
    expect(docsSymbolCheck.scope).toBe("internal");
  });
});

describe("DiffLint on caller-supplied text", () => {
  const diff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,1 +1,3 @@",
    " export const version = 1;",
    "+debugger;",
    "+console.log(version);",
    "",
  ].join("\n");

  test("finds what was added, with the line number in the new file", async () => {
    const result = await call<LintResponse>(diffLint, { diff });
    expect(result.findings.map((f) => [f.rule, f.line])).toEqual([
      ["debugger", 2],
      ["consoleLog", 3],
    ]);
    expect(result.counts.bySeverity).toEqual({ error: 1, warning: 1 });
    expect(result.source).toBe("caller-supplied diff");
  });

  test("a clean change set says so, rather than returning an empty object", async () => {
    const clean = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,1 +1,2 @@",
      " export const version = 1;",
      "+export const name = 'x';",
      "",
    ].join("\n");
    const result = await call<LintResponse>(diffLint, { diff: clean });
    expect(result.clean).toBe(true);
    expect(result.addedLinesScanned).toBe(1);
  });

  test("an empty diff is a clean answer, not an error", async () => {
    const result = await call<LintResponse>(diffLint, { diff: "" });
    expect(result.filesScanned).toBe(0);
    expect(result.clean).toBe(true);
  });

  test("a rule can be turned off by name", async () => {
    const result = await call<LintResponse>(diffLint, { diff, disable: ["consoleLog"] });
    expect(result.findings.map((f) => f.rule)).toEqual(["debugger"]);
  });

  test("a parser warning is surfaced instead of a clean bill of health", async () => {
    // A combined (merge) diff has one marker column per parent, so the parser
    // refuses to number it — and a caller must be told that, not handed "no
    // findings" for a change set nobody looked at.
    const merge = [
      "diff --cc src/app.ts",
      "index 1111111,2222222..3333333",
      "@@@ -1,1 -1,1 +1,2 @@@",
      "++debugger;",
      "",
    ].join("\n");
    const result = await call<LintResponse>(diffLint, { diff: merge });
    expect(result.clean).toBeUndefined();
    expect(result.warnings?.join(" ")).toContain("combined (merge) diff");
  });
});

describe("DiffLint refusals", () => {
  test("text and a git selector together is a caller mistake", async () => {
    const out = await callRaw(diffLint, { diff: "x", staged: true });
    expect(out).toContain("either `diff` text or a git selector");
  });

  test("a ref and a range together is a caller mistake", async () => {
    initRepo(join(workspace, "repo"));
    const out = await callRaw(diffLint, { cwd: "repo", ref: "HEAD", range: "main...HEAD" });
    expect(out).toContain("either `ref` or `range`");
  });

  test("a ref that git would read as an option is refused by name", async () => {
    initRepo(join(workspace, "repo"));
    const out = await callRaw(diffLint, { cwd: "repo", ref: "--output=/tmp/pwned" });
    expect(out).toContain("may not begin with");
    expect(out).toContain("option");
  });

  test("a pathspec that climbs out of the workspace is refused", async () => {
    initRepo(join(workspace, "repo"));
    const out = await callRaw(diffLint, { cwd: "repo", paths: ["../../etc"] });
    expect(out).toContain("pathspecs must be relative");
  });

  test("git pathspec magic is refused too", async () => {
    initRepo(join(workspace, "repo"));
    const out = await callRaw(diffLint, { cwd: "repo", paths: [":/"] });
    expect(out).toContain("pathspec magic");
  });

  test("a cwd outside the workspace root is refused, symlink or not", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-outside-")));
    try {
      initRepo(outside);
      symlinkSync(outside, join(workspace, "link"));
      const direct = await callRaw(diffLint, { cwd: outside });
      const throughLink = await callRaw(diffLint, { cwd: "link" });
      expect(direct).toContain("outside the workspace root");
      expect(throughLink).toContain("outside the workspace root");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a directory that is not a repository is named as such", async () => {
    mkdirSync(join(workspace, "plain"));
    const out = await callRaw(diffLint, { cwd: "plain" });
    expect(out).toContain("not a git repository");
  });

  test("a directory that does not exist is named as such", async () => {
    const out = await callRaw(diffLint, { cwd: "nope" });
    expect(out).toContain("not an existing directory");
  });

  test("a revision that does not exist is reported as that, not as a clean diff", async () => {
    initRepo(join(workspace, "repo"));
    const out = await callRaw(diffLint, { cwd: "repo", ref: "v9.9.9" });
    expect(out).toContain("could not resolve");
  });

  test("an unusable ticketPattern is a caller mistake, not an empty result", async () => {
    const out = await callRaw(diffLint, { diff: "", ticketPattern: "([unclosed" });
    expect(out).toContain("could not use ticketPattern");
  });

  test("an unusable machine-path pattern is reported the same way", async () => {
    const out = await callRaw(diffLint, { diff: "", machinePathPatterns: ["(("] });
    expect(out).toContain("machine-path pattern");
  });

  test("the schema's stated default for maxLineChars is the one the rule uses", async () => {
    // The description is what a model reads before deciding whether to pass
    // an override, and it said 500 while the rule used 1000 — so a caller who
    // trusted it expected findings on every line past 500 and got none. The
    // number is read back out of the schema so the two cannot drift again.
    const described = (diffLint.inputSchema.shape.maxLineChars as { description?: string })
      .description;
    const stated = Number(/default (\d+)/.exec(described ?? "")?.[1]);
    expect(Number.isInteger(stated)).toBe(true);

    const lineOf = (length: number) =>
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,0 +1,1 @@",
        `+${"x".repeat(length)}`,
        "",
      ].join("\n");
    // `longLine` fires on a line LONGER than the budget, so the budget itself
    // is the last length that is allowed through.
    const atThreshold = await call<LintResponse>(diffLint, { diff: lineOf(stated) });
    const overThreshold = await call<LintResponse>(diffLint, { diff: lineOf(stated + 1) });
    expect(atThreshold.findings.map((f) => f.rule)).toEqual([]);
    expect(overThreshold.findings.map((f) => f.rule)).toEqual(["longLine"]);
  });

  test("a rule id that does not exist is rejected by the schema, not ignored", () => {
    const parsed = diffLint.inputSchema.safeParse({ diff: "", disable: ["consoleLogs"] });
    expect(parsed.success).toBe(false);
  });
});

describe("DiffLint against a real repository", () => {
  test("lints the working tree and reports the file git named", async () => {
    const repo = join(workspace, "repo");
    initRepo(repo);
    writeFileSync(join(repo, "src/app.ts"), "export const version = 1;\ndebugger;\n");
    const result = await call<LintResponse>(diffLint, { cwd: "repo" });
    expect(result.findings.map((f) => [f.file, f.line, f.rule])).toEqual([
      ["src/app.ts", 2, "debugger"],
    ]);
    expect(result.source).toContain("git diff");
  });

  test("`staged` looks at the index, which is what a pre-commit hook wants", async () => {
    const repo = join(workspace, "repo");
    initRepo(repo);
    writeFileSync(join(repo, "src/app.ts"), "export const version = 1;\ndebugger;\n");
    const beforeAdd = await call<LintResponse>(diffLint, { cwd: "repo", staged: true });
    expect(beforeAdd.findings).toEqual([]);
    git(["add", "-A"], repo);
    const afterAdd = await call<LintResponse>(diffLint, { cwd: "repo", staged: true });
    expect(afterAdd.findings.map((f) => f.rule)).toEqual(["debugger"]);
  });

  test("`paths` narrows the change set", async () => {
    const repo = join(workspace, "repo");
    initRepo(repo);
    writeFileSync(join(repo, "src/app.ts"), "export const version = 1;\ndebugger;\n");
    writeFileSync(join(repo, "src/other.ts"), "debugger;\n");
    git(["add", "-A"], repo);
    const result = await call<LintResponse>(diffLint, {
      cwd: "repo",
      staged: true,
      paths: ["src/other.ts"],
    });
    expect(result.findings.map((f) => f.file)).toEqual(["src/other.ts"]);
  });

  test("a binary file is skipped rather than scanned as text", async () => {
    const repo = join(workspace, "repo");
    initRepo(repo);
    writeFileSync(join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    git(["add", "-A"], repo);
    const result = await call<LintResponse>(diffLint, { cwd: "repo", staged: true });
    expect(result.skipped?.map((s) => s.file)).toEqual(["logo.png"]);
    expect(result.findings).toEqual([]);
  });
});

describe("DocsSymbolCheck", () => {
  /** A tiny project: one source file, one document about it. */
  function project(source: string, doc: string): void {
    mkdirSync(join(workspace, "src"), { recursive: true });
    mkdirSync(join(workspace, "docs"), { recursive: true });
    writeFileSync(join(workspace, "src/index.ts"), source);
    writeFileSync(join(workspace, "docs/guide.md"), doc);
  }

  test("reports a documented symbol the code no longer has", async () => {
    project(
      "export function renderReport() {\n  return 1;\n}\nexport const REPORT_LIMIT = 5;\n",
      [
        "# Guide",
        "",
        "Call `renderReport` to build one, and read `REPORT_LIMIT` for the cap.",
        "The old `renderSummary` helper is described here too.",
        "",
      ].join("\n"),
    );
    const result = await call<DocsResponse>(docsSymbolCheck, {
      docs: ["docs/guide.md"],
      source: "src",
    });
    expect(result.missing.map((m) => [m.symbol, m.line])).toEqual([["renderSummary", 4]]);
    expect(result.resolved).toBe(2);
  });

  test("a symbol that survives only in a comment or a string is not reported", async () => {
    project(
      "// renderSummary was folded into renderReport\nexport function renderReport() {\n  return 'renderSummary';\n}\n",
      "Call `renderReport`; `renderSummary` is gone.\n",
    );
    const result = await call<DocsResponse>(docsSymbolCheck, {
      docs: ["docs/guide.md"],
      source: "src",
    });
    expect(result.missing).toEqual([]);
  });

  test("a named import in a fenced block is checked", async () => {
    project(
      "export function renderReport() {\n  return 1;\n}\n",
      ["```ts", 'import { renderReport, renderSummary } from "./src/index";', "```", ""].join("\n"),
    );
    const result = await call<DocsResponse>(docsSymbolCheck, {
      docs: ["docs/guide.md"],
      source: "src",
      minResolvedRatio: 0.5,
    });
    expect(result.missing.map((m) => [m.symbol, m.evidence])).toEqual([
      ["renderSummary", "import"],
    ]);
  });

  test("a whole documentation directory can be checked at once", async () => {
    project("export function renderReport() {}\n", "`renderReport` lives here.\n");
    writeFileSync(join(workspace, "docs/other.md"), "`renderReport` and `renderGone` here.\n");
    const result = await call<DocsResponse>(docsSymbolCheck, { docs: ["docs"], source: "src" });
    expect(result.docsScanned).toBe(2);
    expect(result.missing.map((m) => [m.doc, m.symbol])).toEqual([["docs/other.md", "renderGone"]]);
  });

  test("docsText is checked without touching the filesystem for the document", async () => {
    project("export function renderReport() {}\n", "unused\n");
    const result = await call<DocsResponse>(docsSymbolCheck, {
      docsText: "`renderReport` stays, `renderGone` does not.\n",
      docsLabel: "release-notes",
      source: "src",
    });
    expect(result.missing.map((m) => [m.doc, m.symbol])).toEqual([["release-notes", "renderGone"]]);
  });

  test("a document that resolves almost nothing is withheld, with the reason", async () => {
    project(
      "export function renderReport() {}\n",
      "`alphaWidget`, `betaWidget`, `gammaWidget` and `deltaWidget`.\n",
    );
    const result = await call<DocsResponse>(docsSymbolCheck, {
      docs: ["docs/guide.md"],
      source: "src",
    });
    expect(result.missing).toEqual([]);
    expect(result.withheld).toBe(4);
    expect(result.coverage[0]?.suppressed).toContain("does not describe this tree");
  });

  test("an incomplete source scan is refused rather than answered", async () => {
    project("export function renderReport() {}\n", "`renderGone` is documented.\n");
    writeFileSync(join(workspace, "src/b.ts"), "export const b = 1;\n");
    writeFileSync(join(workspace, "src/c.ts"), "export const c = 1;\n");
    const out = await callRaw(docsSymbolCheck, {
      docs: ["docs/guide.md"],
      source: "src",
      maxFiles: 2,
    });
    expect(out).toContain("symbol index is incomplete");
  });

  test("a source file too large to read is refused, and can be accepted explicitly", async () => {
    project("export function renderReport() {}\n", "`renderReport` and `renderGone`.\n");
    writeFileSync(join(workspace, "src/huge.ts"), `const big = "${"x".repeat(4_200_000)}";\n`);
    const refused = await callRaw(docsSymbolCheck, { docs: ["docs/guide.md"], source: "src" });
    expect(refused).toContain("could not read");
    const allowed = await call<DocsResponse>(docsSymbolCheck, {
      docs: ["docs/guide.md"],
      source: "src",
      allowUnreadableSources: true,
      minResolvedRatio: 0.5,
    });
    expect(allowed.warnings?.join(" ")).toContain("too large to index");
    expect(allowed.missing.map((m) => m.symbol)).toEqual(["renderGone"]);
  }, 20_000); // pays for writing and reading a 4MB file on a loaded runner

  test("an empty source tree is refused: everything would look deleted", async () => {
    mkdirSync(join(workspace, "docs"), { recursive: true });
    mkdirSync(join(workspace, "empty"), { recursive: true });
    writeFileSync(join(workspace, "docs/guide.md"), "`renderReport` here.\n");
    const out = await callRaw(docsSymbolCheck, { docs: ["docs/guide.md"], source: "empty" });
    expect(out).toContain("no source files");
  });

  test("nothing to read is a caller mistake", async () => {
    const out = await callRaw(docsSymbolCheck, { source: "." });
    expect(out).toContain("pass `docs`");
  });

  test("a symlink inside a documentation DIRECTORY does not read what it points at", async () => {
    // Containment has to survive the walk, not only the path the caller typed.
    // `docs` names a directory inside the workspace; a link inside it points
    // out, `readFileSync` follows links, and this tool quotes a document's
    // own line back in `context` — so a link is a read of an outside file and
    // an echo of its contents. Nothing here passes an outside path.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-outside-walk-")));
    try {
      project("export function renderReport() {}\n", "`renderReport` lives here.\n");
      writeFileSync(
        join(outside, "private.md"),
        "Rotate `renderReport` with the key `deployKeyRotationAlpha`.\n",
      );
      symlinkSync(join(outside, "private.md"), join(workspace, "docs/linked.md"));

      const raw = await callRaw(docsSymbolCheck, { docs: ["docs"], source: "src" });
      expect(raw).not.toContain("deployKeyRotationAlpha");
      const result = JSON.parse(raw) as DocsResponse;
      expect(result.docsScanned).toBe(1);
      expect(result.coverage.map((c) => c.doc)).toEqual(["docs/guide.md"]);
      expect(result.warnings?.join(" ")).toContain("linked.md");
      expect(result.warnings?.join(" ")).toContain("outside the workspace root");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a symlink inside the SOURCE tree is not pulled into the symbol index", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-outside-src-")));
    try {
      project("export function renderReport() {}\n", "`renderReport` and `outsideOnlySymbol`.\n");
      writeFileSync(join(outside, "leak.ts"), "export const outsideOnlySymbol = 1;\n");
      symlinkSync(join(outside, "leak.ts"), join(workspace, "src/linked.ts"));

      const result = await call<DocsResponse>(docsSymbolCheck, { docs: ["docs"], source: "src" });
      expect(result.sourceFilesScanned).toBe(1);
      // The point is not that the symbol is reported — it is that a file
      // outside the workspace never decided the answer either way.
      expect(result.missing.map((m) => m.symbol)).toEqual(["outsideOnlySymbol"]);
      expect(result.warnings?.join(" ")).toContain("linked.ts");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a directory the walk cannot list is refused, not counted as empty", async () => {
    // The tool promises to refuse an incomplete scan because an incomplete
    // index invents missing symbols. A directory that cannot be listed is the
    // largest hole there is, and it used to be swallowed by a bare `catch`:
    // every symbol living only inside it was reported as deleted.
    project(
      "export function renderReport() {}\n",
      "`renderReport` and `onlyInTheLockedDir` are both real.\n",
    );
    mkdirSync(join(workspace, "src/private"), { recursive: true });
    writeFileSync(
      join(workspace, "src/private/hidden.ts"),
      "export const onlyInTheLockedDir = 1;\n",
    );
    chmodSync(join(workspace, "src/private"), 0o000);
    try {
      const refused = await callRaw(docsSymbolCheck, { docs: ["docs"], source: "src" });
      expect(refused).toContain("could not list");
      expect(refused).toContain("private");
      expect(refused).not.toContain("onlyInTheLockedDir");

      // Accepting the gap explicitly is allowed, and then the gap is named.
      const allowed = await call<DocsResponse>(docsSymbolCheck, {
        docs: ["docs"],
        source: "src",
        allowUnreadableSources: true,
      });
      expect(allowed.warnings?.join(" ")).toContain("could not be listed");
    } finally {
      chmodSync(join(workspace, "src/private"), 0o755);
    }
  });

  test("a tree with exactly maxFiles sources is complete, not refused", async () => {
    // The cap used to be checked once per directory ENTRY, so a tree holding
    // exactly `maxFiles` sources plus any other file sorted after them was
    // refused as incomplete although nothing had gone unread.
    project("export function renderReport() {}\n", "`renderReport` is here.\n");
    writeFileSync(join(workspace, "src/zz-not-a-source.png"), "not source");
    const result = await call<DocsResponse>(docsSymbolCheck, {
      docs: ["docs"],
      source: "src",
      maxFiles: 1,
    });
    expect(result.sourceFilesScanned).toBe(1);
    expect(result.missing).toEqual([]);
  });

  test("a document walk that stops at the cap says so", async () => {
    project("export function renderReport() {}\n", "`renderReport` is here.\n");
    for (let i = 0; i < 520; i++) {
      writeFileSync(
        join(workspace, `docs/page-${String(i).padStart(4, "0")}.md`),
        "`renderReport`\n",
      );
    }
    const result = await call<DocsResponse>(docsSymbolCheck, { docs: ["docs"], source: "src" });
    expect(result.docsScanned).toBe(500);
    expect(result.warnings?.join(" ")).toContain("document walk stopped");
  }, 20_000); // pays for writing 520 small files on a loaded runner

  test("a capped list of missing symbols says it was capped", async () => {
    const gone = Array.from({ length: 12 }, (_, i) => `\`renderGoneNumber${i}\``).join(" ");
    project("export function renderReport() {}\n", `\`renderReport\` stays. ${gone}\n`);
    const result = await call<DocsResponse>(docsSymbolCheck, {
      docs: ["docs"],
      source: "src",
      minResolvedRatio: 0,
      maxFindings: 5,
    });
    expect(result.missing).toHaveLength(5);
    expect(result.findingsTruncated).toBe(true);
    // The counts stay whole, which is what makes the flag readable.
    expect(result.references - result.resolved).toBe(12);
  });

  test("a source path outside the workspace is refused", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-outside-docs-")));
    try {
      writeFileSync(join(outside, "x.ts"), "export const x = 1;\n");
      mkdirSync(join(workspace, "docs"), { recursive: true });
      writeFileSync(join(workspace, "docs/guide.md"), "`renderReport`\n");
      const out = await callRaw(docsSymbolCheck, { docs: ["docs/guide.md"], source: outside });
      expect(out).toContain("outside the workspace root");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a document path outside the workspace is refused", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-outside-doc2-")));
    try {
      writeFileSync(join(outside, "secret.md"), "`renderReport`\n");
      mkdirSync(join(workspace, "src"), { recursive: true });
      writeFileSync(join(workspace, "src/index.ts"), "export const x = 1;\n");
      symlinkSync(join(outside, "secret.md"), join(workspace, "linked.md"));
      const direct = await callRaw(docsSymbolCheck, {
        docs: [join(outside, "secret.md")],
        source: "src",
      });
      const throughLink = await callRaw(docsSymbolCheck, { docs: ["linked.md"], source: "src" });
      expect(direct).toContain("outside the workspace root");
      expect(throughLink).toContain("outside the workspace root");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a document that is not there is named", async () => {
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src/index.ts"), "export const x = 1;\n");
    const out = await callRaw(docsSymbolCheck, { docs: ["docs/missing.md"], source: "src" });
    expect(out).toContain("no such file or directory");
  });

  test("a source path that is a file, not a tree, is refused", async () => {
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src/index.ts"), "export const x = 1;\n");
    const out = await callRaw(docsSymbolCheck, { docsText: "`x`", source: "src/index.ts" });
    expect(out).toContain("must be a directory");
  });

  test("the same tree twice gives the same bytes", async () => {
    project(
      "export function renderReport() {}\nexport const REPORT_LIMIT = 1;\n",
      "`renderReport`, `REPORT_LIMIT`, `renderGone`.\n",
    );
    const first = await callRaw(docsSymbolCheck, { docs: ["docs"], source: "src" });
    const second = await callRaw(docsSymbolCheck, { docs: ["docs"], source: "src" });
    expect(first).toBe(second);
  });
});
