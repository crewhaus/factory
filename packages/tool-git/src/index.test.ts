/**
 * Every tool, exercised against a REAL git repository built in a temp
 * directory per test.
 *
 * A mocked git would prove nothing: the thing most likely to be wrong in this
 * package is which flags it passes and how it reads what comes back, and only
 * the real binary can answer that. Author and committer dates are pinned
 * through the environment so assertions on log and blame output are stable.
 *
 * The temp directory doubles as the workspace root — the tools resolve every
 * caller-supplied path against `process.cwd()` — which is also what lets the
 * containment tests point a tool at somewhere it must refuse to go.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { MAX_OUTPUT_CHARS, runGit } from "./git-run";
import {
  GIT_TOOLS,
  gitAdd,
  gitApplyPatch,
  gitBlame,
  gitBranchCreate,
  gitBranchDelete,
  gitBranchList,
  gitCherryPick,
  gitCommit,
  gitConflicts,
  gitDiff,
  gitFileHistory,
  gitLog,
  gitMergeBase,
  gitRemoteList,
  gitResetPaths,
  gitRevParse,
  gitShow,
  gitStashList,
  gitStashPop,
  gitStashPush,
  gitStatus,
  gitSwitch,
  gitTagCreate,
  gitTagList,
  gitWorktreeAdd,
  gitWorktreeList,
  gitWorktreeRemove,
} from "./index";

const D1 = "2026-01-02T03:04:05+00:00";
const D2 = "2026-01-03T04:05:06+00:00";
const D3 = "2026-01-04T05:06:07+00:00";

type Ran = { code: number; stdout: string; stderr: string };

/** Drive the real binary directly, for building fixtures and for cross-checks. */
function git(args: string[], cwd: string, env: Record<string, string> = {}): Ran {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function commitAll(dir: string, message: string, date: string): void {
  git(["add", "-A"], dir);
  git(["commit", "-m", message], dir, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
}

function initRepo(dir: string): void {
  git(["init", "-b", "main"], dir);
  git(["config", "user.name", "A U Thor"], dir);
  git(["config", "user.email", "author@example.com"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "hello\n");
  writeFileSync(join(dir, "src/app.ts"), "export const a = 1;\n");
  commitAll(dir, "initial commit\n\nbody line one\nbody line two", D1);
  writeFileSync(join(dir, "README.md"), "hello\nworld\n");
  commitAll(dir, "second commit", D2);
}

let workspace: string;
let repo: string;
let originalCwd: string;
let savedGlobal: string | undefined;
let savedSystem: string | undefined;

/** Call a tool against the fixture repo and parse its JSON, or keep the string. */
// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
async function call(tool: RegisteredTool, input: Record<string, unknown> = {}): Promise<any> {
  const out = await tool.execute({ cwd: "repo", ...input });
  if (typeof out !== "string") throw new Error(`${tool.name} returned non-string content`);
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

beforeAll(() => {
  originalCwd = process.cwd();
  savedGlobal = process.env["GIT_CONFIG_GLOBAL"];
  savedSystem = process.env["GIT_CONFIG_SYSTEM"];
  // Isolate every git run — the fixtures' and the tools' — from whatever the
  // machine has in ~/.gitconfig, so these tests behave the same everywhere.
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
  // realpath, because macOS hands out /var/... temp paths that are really
  // /private/var/... — the containment check resolves them and the assertions
  // below compare against the resolved form.
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-tool-git-")));
  process.chdir(workspace);
  repo = join(workspace, "repo");
  mkdirSync(repo);
  mkdirSync(join(workspace, "plain"));
  initRepo(repo);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("package-wide contract", () => {
  const READ_TOOLS = new Set([
    "GitStatus",
    "GitDiff",
    "GitLog",
    "GitShow",
    "GitBlame",
    "GitBranchList",
    "GitTagList",
    "GitRemoteList",
    "GitMergeBase",
    "GitRevParse",
    "GitFileHistory",
    "GitStashList",
    "GitConflicts",
    "GitWorktreeList",
  ]);

  test("GIT_TOOLS holds every exported tool, with unique names", () => {
    expect(GIT_TOOLS.length).toBe(27);
    const names = GIT_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every name is PascalCase and prefixed Git", () => {
    for (const t of GIT_TOOLS) expect(t.name).toMatch(/^Git[A-Z][A-Za-z0-9]*$/);
  });

  test("every description explains what it is for in its second sentence", () => {
    for (const t of GIT_TOOLS) {
      expect(t.description.length).toBeGreaterThan(40);
      const second = t.description.split(". ")[1] ?? "";
      expect({ name: t.name, startsWithUse: second.startsWith("Use ") }).toEqual({
        name: t.name,
        startsWithUse: true,
      });
    }
  });

  test("every tool declares the process boundary it crosses", () => {
    for (const t of GIT_TOOLS) {
      expect({ name: t.name, scope: t.scope, io: t.ioCapability }).toEqual({
        name: t.name,
        scope: "external",
        io: "process",
      });
    }
  });

  test("read tools are read-only, non-destructive and concurrency-safe", () => {
    for (const t of GIT_TOOLS.filter((x) => READ_TOOLS.has(x.name))) {
      expect({
        name: t.name,
        readOnly: t.readOnly,
        destructive: t.destructive,
        safe: t.concurrencySafe,
      }).toEqual({ name: t.name, readOnly: true, destructive: false, safe: true });
    }
  });

  test("write tools are destructive and never concurrency-safe", () => {
    for (const t of GIT_TOOLS.filter((x) => !READ_TOOLS.has(x.name))) {
      expect({
        name: t.name,
        readOnly: t.readOnly,
        destructive: t.destructive,
        safe: t.concurrencySafe,
      }).toEqual({ name: t.name, readOnly: false, destructive: true, safe: false });
    }
  });

  test("nothing here runs untrusted code, so nothing requires a sandbox", () => {
    for (const t of GIT_TOOLS) {
      expect({ name: t.name, sandbox: t.requiresSandbox }).toEqual({
        name: t.name,
        sandbox: false,
      });
    }
  });

  test("every schema rejects a wholly wrong input shape", () => {
    for (const t of GIT_TOOLS) {
      expect({ name: t.name, ok: t.inputSchema.safeParse(42).success }).toEqual({
        name: t.name,
        ok: false,
      });
    }
  });

  test("no tool exposes a way to reach a remote", () => {
    for (const t of GIT_TOOLS) {
      expect({ name: t.name, remote: /GitPush|GitPull|GitFetch|GitClone/.test(t.name) }).toEqual({
        name: t.name,
        remote: false,
      });
    }
  });
});

// ---------------------------------------------------------------------------

describe("containment", () => {
  test("a cwd outside the workspace root is refused", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-tool-git-outside-")));
    try {
      initRepo(outside);
      const out = await gitStatus.execute({ cwd: outside });
      expect(String(out)).toContain("outside the workspace root");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a cwd of .. is refused before git ever runs", async () => {
    const out = await gitStatus.execute({ cwd: ".." });
    expect(String(out)).toContain("outside the workspace root");
  });

  test("an in-root symlink pointing outside is refused, not followed", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-tool-git-link-")));
    try {
      initRepo(outside);
      Bun.spawnSync(["ln", "-s", outside, join(workspace, "link")]);
      const out = await gitStatus.execute({ cwd: "link" });
      expect(String(out)).toContain("outside the workspace root");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a pathspec containing .. is refused", async () => {
    const out = await gitDiff.execute({ cwd: "repo", paths: ["../plain"] });
    expect(String(out)).toContain("refused the path filter");
  });

  test("an absolute pathspec is refused", async () => {
    const out = await gitAdd.execute({ cwd: "repo", paths: ["/etc/passwd"] });
    expect(String(out)).toContain("refused the path filter");
  });

  test("git pathspec magic that would escape to the repo top is refused", async () => {
    const out = await gitLog.execute({ cwd: "repo", paths: [":/"] });
    expect(String(out)).toContain("refused the path filter");
  });

  test("a worktree cannot be created outside the workspace root", async () => {
    const out = await gitWorktreeAdd.execute({ cwd: "repo", path: "../escape-wt" });
    expect(String(out)).toContain("outside the workspace root");
  });
});

/**
 * A ref is a path into the workspace too, because git's option parser reads a
 * bare argv word starting with "-" as an option. `--output=<file>` on a read
 * command writes anywhere on the disk, and `-D` in a name position turns a
 * create into a delete — so each of these asserts the damage did not happen,
 * not merely that a refusal sentence came back.
 */
describe("containment of refs — option injection", () => {
  test("GitLog cannot be turned into a write with --output", async () => {
    const outside = join(tmpdir(), `crewhaus-tool-git-pwned-${process.pid}.txt`);
    rmSync(outside, { force: true });
    const out = await gitLog.execute({ cwd: "repo", range: `--output=${outside}` });
    expect(String(out)).toContain("may not begin with");
    expect(existsSync(outside)).toBe(false);
    rmSync(outside, { force: true });
  });

  test("GitDiff cannot be turned into a write with --output", async () => {
    const outside = join(tmpdir(), `crewhaus-tool-git-pwned-diff-${process.pid}.txt`);
    rmSync(outside, { force: true });
    const out = await gitDiff.execute({ cwd: "repo", ref: `--output=${outside}` });
    expect(String(out)).toContain("may not begin with");
    expect(existsSync(outside)).toBe(false);
    rmSync(outside, { force: true });
  });

  test("GitBranchCreate cannot be turned into a branch delete", async () => {
    git(["branch", "victim"], repo);
    const out = await gitBranchCreate.execute({ cwd: "repo", name: "-D", startPoint: "victim" });
    expect(String(out)).toContain("may not begin with");
    expect(git(["rev-parse", "--verify", "victim"], repo).code).toBe(0);
  });

  test("every tool taking a ref refuses an option-shaped one", async () => {
    const cases: Array<[RegisteredTool, Record<string, unknown>]> = [
      [gitBlame, { path: "README.md", ref: "--reverse" }],
      [gitBranchDelete, { name: "--all" }],
      [gitBranchList, { contains: "--merged" }],
      [gitCherryPick, { refs: ["--quit"] }],
      [gitMergeBase, { a: "--all", b: "HEAD" }],
      [gitResetPaths, { paths: ["README.md"], ref: "--hard" }],
      [gitShow, { ref: "--output=/dev/null" }],
      [gitSwitch, { branch: "--orphan" }],
      [gitTagCreate, { name: "--delete" }],
      [gitWorktreeAdd, { path: "wt", ref: "--force" }],
    ];
    for (const [tool, input] of cases) {
      const out = String(await tool.execute({ cwd: "repo", ...input }));
      expect({ name: tool.name, refused: out.includes("may not begin with") }).toEqual({
        name: tool.name,
        refused: true,
      });
    }
    // The refusals above must have changed nothing.
    expect((await call(gitStatus)).clean).toBe(true);
    expect(existsSync(join(workspace, "wt"))).toBe(false);
  });

  test("GitRevParse refuses a ref carrying a newline, which would misalign the batch", async () => {
    const out = await gitRevParse.execute({ cwd: "repo", refs: ["HEAD\nHEAD", "no-such-ref"] });
    expect(String(out)).toContain("newline");
  });

  test("a dash inside a name is still perfectly legal", async () => {
    const created = await call(gitBranchCreate, { name: "feature-with-dash" });
    expect(created.sha).toMatch(/^[0-9a-f]{40}$/);
    const tagged = await call(gitTagCreate, { name: "v1.0-rc1" });
    expect(tagged.created).toBe("v1.0-rc1");
    const shown = await call(gitShow, { ref: "v1.0-rc1", patch: false });
    expect(shown.commit.subject).toBe("second commit");
  });
});

describe("refusing a directory that is not a repository", () => {
  test("names that as the reason, rather than leaking git's exit code", async () => {
    const out = await gitStatus.execute({ cwd: "plain" });
    expect(String(out)).toContain("not a git repository");
  });

  test("a cwd that does not exist is refused as such", async () => {
    const out = await gitLog.execute({ cwd: "no-such-dir" });
    expect(String(out)).toContain("not an existing directory");
  });

  test("every tool refuses a non-repository rather than throwing", async () => {
    for (const tool of GIT_TOOLS) {
      const out = await tool.execute({
        cwd: "plain",
        // Fields various tools require; extras are ignored by the others.
        paths: ["README.md"],
        path: "README.md",
        message: "m",
        name: "n",
        branch: "b",
        refs: ["HEAD"],
        a: "HEAD",
        b: "HEAD",
        patch: "diff --git a/x b/x\n",
      });
      expect({ name: tool.name, refused: String(out).includes("not a git repository") }).toEqual({
        name: tool.name,
        refused: true,
      });
    }
  });
});

// ---------------------------------------------------------------------------

describe("GitStatus", () => {
  test("a clean checkout reports clean, on the right branch", async () => {
    const out = await call(gitStatus);
    expect(out.clean).toBe(true);
    expect(out.branch).toBe("main");
    expect(out.detached).toBe(false);
    expect(out.head).toMatch(/^[0-9a-f]{40}$/);
  });

  test("separates unstaged, staged and untracked", async () => {
    writeFileSync(join(repo, "README.md"), "hello\nworld\nmore\n");
    writeFileSync(join(repo, "new.txt"), "fresh\n");
    writeFileSync(join(repo, "src/app.ts"), "export const a = 2;\n");
    git(["add", "src/app.ts"], repo);

    const out = await call(gitStatus);
    expect(out.clean).toBe(false);
    expect(out.staged.map((e: { path: string }) => e.path)).toEqual(["src/app.ts"]);
    expect(out.unstaged.map((e: { path: string }) => e.path)).toEqual(["README.md"]);
    expect(out.untracked).toEqual(["new.txt"]);
  });

  test("reports a rename with the path it came from", async () => {
    git(["mv", "src/app.ts", "src/main.ts"], repo);
    const out = await call(gitStatus);
    expect(out.staged[0]).toMatchObject({ path: "src/main.ts", from: "src/app.ts", index: "R" });
  });

  test("a detached HEAD is reported as such", async () => {
    git(["checkout", "--detach", "HEAD"], repo);
    const out = await call(gitStatus);
    expect(out.detached).toBe(true);
    expect(out.branch).toBe(null);
  });
});

describe("GitDiff", () => {
  beforeEach(() => {
    writeFileSync(join(repo, "README.md"), "hello\nworld\nthird\n");
  });

  test("numstat counts the lines that changed", async () => {
    const out = await call(gitDiff, { mode: "numstat" });
    expect(out.files).toBe(1);
    expect(out.added).toBe(1);
    expect(out.removed).toBe(0);
    expect(out.changes[0].path).toBe("README.md");
  });

  test("nameOnly lists paths, sorted", async () => {
    writeFileSync(join(repo, "src/app.ts"), "export const a = 3;\n");
    const out = await call(gitDiff, { mode: "nameOnly" });
    expect(out.paths).toEqual(["README.md", "src/app.ts"]);
  });

  test("patch mode returns the hunks", async () => {
    const out = await call(gitDiff, { mode: "patch" });
    expect(out.patch).toContain("+third");
    expect(out.empty).toBe(false);
  });

  test("stat mode is the default and summarizes", async () => {
    const out = await call(gitDiff);
    expect(out.mode).toBe("stat");
    expect(out.stat).toContain("README.md");
  });

  test("staged diffs the index, so an unstaged edit is invisible to it", async () => {
    const out = await call(gitDiff, { staged: true, mode: "numstat" });
    expect(out.files).toBe(0);
  });

  test("a path filter narrows the diff", async () => {
    const out = await call(gitDiff, { mode: "nameOnly", paths: ["src"] });
    expect(out.paths).toEqual([]);
  });

  test("a range diffs two commits", async () => {
    const out = await call(gitDiff, { mode: "numstat", range: "HEAD~1..HEAD" });
    expect(out.changes[0]).toMatchObject({ path: "README.md", added: 1, removed: 0 });
  });

  test("ref and range together is a caller mistake, reported as a sentence", async () => {
    const out = await gitDiff.execute({ cwd: "repo", ref: "HEAD", range: "a..b" });
    expect(String(out)).toContain("either `ref` or `range`");
  });

  test("an unknown ref comes back as a readable failure, not a throw", async () => {
    const out = await gitDiff.execute({ cwd: "repo", ref: "no-such-ref" });
    expect(String(out)).toContain("GitDiff failed");
  });
});

describe("GitLog", () => {
  test("returns structured commits, newest first, with pinned dates", async () => {
    const out = await call(gitLog);
    expect(out.count).toBe(2);
    expect(out.commits[0].subject).toBe("second commit");
    // git renders a zero offset as "Z" in some versions and "+00:00" in
    // others, so pin the instant rather than the spelling.
    expect(out.commits[0].authorDate).toMatch(/^2026-01-03T04:05:06/);
    expect(out.commits[1].subject).toBe("initial commit");
    expect(out.commits[1].body).toBe("body line one\nbody line two");
    expect(out.commits[0].sha).toMatch(/^[0-9a-f]{40}$/);
    expect(out.commits[0].authorEmail).toBe("author@example.com");
  });

  test("a subject full of separator-looking characters survives the format", async () => {
    const nasty = "fix: a|b\tc %H and 'quotes'";
    writeFileSync(join(repo, "README.md"), "hello\nworld\nnasty\n");
    commitAll(repo, nasty, D3);
    const out = await call(gitLog, { maxCount: 1 });
    expect(out.commits[0].subject).toBe(nasty);
  });

  test("maxCount bounds the result", async () => {
    const out = await call(gitLog, { maxCount: 1 });
    expect(out.count).toBe(1);
  });

  test("a range selects only the commits it names", async () => {
    const out = await call(gitLog, { range: "HEAD~1..HEAD" });
    expect(out.commits.map((c: { subject: string }) => c.subject)).toEqual(["second commit"]);
  });

  test("a path filter selects only commits touching it", async () => {
    const out = await call(gitLog, { paths: ["src/app.ts"] });
    expect(out.count).toBe(1);
    expect(out.commits[0].subject).toBe("initial commit");
  });

  test("an author filter matches on name or email", async () => {
    expect((await call(gitLog, { author: "author@example.com" })).count).toBe(2);
    expect((await call(gitLog, { author: "nobody@example.com" })).count).toBe(0);
  });

  test("the same call twice returns the same bytes", async () => {
    const a = await gitLog.execute({ cwd: "repo" });
    const b = await gitLog.execute({ cwd: "repo" });
    expect(a).toBe(b);
  });
});

describe("GitShow", () => {
  test("returns a file's contents at a ref without checking it out", async () => {
    const out = await call(gitShow, { ref: "HEAD~1", path: "README.md" });
    expect(out.content).toBe("hello\n");
    // The working tree is untouched by a read.
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("hello\nworld\n");
  });

  test("returns a commit's metadata and patch", async () => {
    const out = await call(gitShow);
    expect(out.commit.subject).toBe("second commit");
    expect(out.patch).toContain("+world");
  });

  test("patch can be omitted when only the metadata is wanted", async () => {
    const out = await call(gitShow, { patch: false });
    expect(out.commit.subject).toBe("second commit");
    expect(out.patch).toBeUndefined();
  });

  test("a missing path is a readable failure", async () => {
    const out = await gitShow.execute({ cwd: "repo", path: "nope.txt" });
    expect(String(out)).toContain("GitShow failed");
  });
});

describe("GitBlame", () => {
  test("attributes each line to the commit that introduced it", async () => {
    const log = await call(gitLog);
    const [second, first] = log.commits;
    const out = await call(gitBlame, { path: "README.md" });
    expect(out.count).toBe(2);
    expect(out.lines[0]).toMatchObject({ line: 1, sha: first.sha, content: "hello" });
    expect(out.lines[1]).toMatchObject({ line: 2, sha: second.sha, content: "world" });
    expect(out.lines[0].date).toBe(D1);
  });

  test("a line range narrows the result", async () => {
    const out = await call(gitBlame, { path: "README.md", startLine: 2, endLine: 2 });
    expect(out.count).toBe(1);
    expect(out.lines[0].content).toBe("world");
  });

  test("a backwards range is rejected with an explanation", async () => {
    const out = await gitBlame.execute({
      cwd: "repo",
      path: "README.md",
      startLine: 5,
      endLine: 2,
    });
    expect(String(out)).toContain("runs forwards");
  });

  test("maxLines caps the records and says so", async () => {
    const out = await call(gitBlame, { path: "README.md", maxLines: 1 });
    expect(out.count).toBe(1);
    expect(out.truncated).toBe(true);
  });
});

describe("GitBranchList, GitTagList, GitRemoteList", () => {
  test("branches come back sorted, with the current one named", async () => {
    git(["branch", "topic"], repo);
    git(["branch", "another"], repo);
    const out = await call(gitBranchList);
    expect(out.current).toBe("main");
    expect(out.branches.map((b: { name: string }) => b.name)).toEqual(["another", "main", "topic"]);
  });

  test("contains filters to branches holding a commit", async () => {
    git(["branch", "topic"], repo);
    const out = await call(gitBranchList, { contains: "HEAD" });
    expect(out.branches.map((b: { name: string }) => b.name)).toEqual(["main", "topic"]);
  });

  test("tags report whether they are annotated and which commit they mark", async () => {
    git(["tag", "v1.0"], repo);
    git(["tag", "-a", "v2.0", "-m", "release two"], repo, {
      GIT_AUTHOR_DATE: D3,
      GIT_COMMITTER_DATE: D3,
    });
    const out = await call(gitTagList);
    expect(out.tags.map((t: { name: string }) => t.name)).toEqual(["v1.0", "v2.0"]);
    expect(out.tags[0].annotated).toBe(false);
    expect(out.tags[1].annotated).toBe(true);
    expect(out.tags[1].subject).toBe("release two");
    const head = git(["rev-parse", "HEAD"], repo).stdout.trim();
    expect(out.tags[1].commit).toBe(head);
  });

  test("a tag pattern narrows the list", async () => {
    git(["tag", "v1.0"], repo);
    git(["tag", "other"], repo);
    const out = await call(gitTagList, { pattern: "v*" });
    expect(out.tags.map((t: { name: string }) => t.name)).toEqual(["v1.0"]);
  });

  test("remotes are read from config, never contacted", async () => {
    git(["remote", "add", "origin", "https://example.invalid/x.git"], repo);
    const out = await call(gitRemoteList);
    expect(out.remotes).toEqual([
      {
        name: "origin",
        fetch: "https://example.invalid/x.git",
        push: "https://example.invalid/x.git",
      },
    ]);
  });
});

describe("GitMergeBase and GitRevParse", () => {
  test("finds the common ancestor of two branches", async () => {
    const base = git(["rev-parse", "HEAD"], repo).stdout.trim();
    git(["switch", "-c", "topic"], repo);
    writeFileSync(join(repo, "topic.txt"), "t\n");
    commitAll(repo, "topic commit", D3);
    git(["switch", "main"], repo);
    writeFileSync(join(repo, "main.txt"), "m\n");
    commitAll(repo, "main commit", D3);

    const out = await call(gitMergeBase, { a: "main", b: "topic" });
    expect(out.found).toBe(true);
    expect(out.mergeBase).toBe(base);
  });

  test("two unrelated histories report found:false rather than an error", async () => {
    git(["checkout", "--orphan", "island"], repo);
    writeFileSync(join(repo, "island.txt"), "i\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "island"], repo, { GIT_AUTHOR_DATE: D3, GIT_COMMITTER_DATE: D3 });
    const out = await call(gitMergeBase, { a: "main", b: "island" });
    expect(out.found).toBe(false);
    expect(out.mergeBase).toBe(null);
  });

  test("needs two refs unless asked for a fork point", async () => {
    const out = await gitMergeBase.execute({ cwd: "repo", a: "main" });
    expect(String(out)).toContain("needs two refs");
  });

  test("resolves refs to shas and types in one batch, flagging the unknown", async () => {
    git(["tag", "-a", "v1.0", "-m", "one"], repo, {
      GIT_AUTHOR_DATE: D3,
      GIT_COMMITTER_DATE: D3,
    });
    const head = git(["rev-parse", "HEAD"], repo).stdout.trim();
    const out = await call(gitRevParse, { refs: ["HEAD", "v1.0", "no-such-ref"] });
    expect(out.objects[0]).toEqual({ ref: "HEAD", sha: head, type: "commit", missing: false });
    expect(out.objects[1].type).toBe("tag");
    expect(out.objects[2]).toEqual({
      ref: "no-such-ref",
      sha: null,
      type: null,
      missing: true,
    });
  });

  test("reports repository info with no refs asked for", async () => {
    const out = await call(gitRevParse);
    expect(out.root).toBe(repo);
    expect(out.branch).toBe("main");
    expect(out.detached).toBe(false);
    expect(out.objects).toEqual([]);
  });
});

describe("GitFileHistory", () => {
  test("follows a file across a rename and reports the names it has had", async () => {
    git(["mv", "src/app.ts", "src/main.ts"], repo);
    commitAll(repo, "rename app to main", D3);

    const out = await call(gitFileHistory, { path: "src/main.ts" });
    expect(out.count).toBe(2);
    expect(out.commits[0].subject).toBe("rename app to main");
    expect(out.commits[0].changes[0]).toMatchObject({ path: "src/main.ts", from: "src/app.ts" });
    expect(out.knownPaths).toEqual(["src/app.ts", "src/main.ts"]);
  });
});

describe("GitConflicts", () => {
  beforeEach(() => {
    git(["switch", "-c", "feature"], repo);
    writeFileSync(join(repo, "README.md"), "hello\nfeature side\n");
    commitAll(repo, "feature change", D3);
    git(["switch", "main"], repo);
    writeFileSync(join(repo, "README.md"), "hello\nmain side\n");
    commitAll(repo, "main change", D3);
    const merge = git(["merge", "feature"], repo, {
      GIT_AUTHOR_DATE: D3,
      GIT_COMMITTER_DATE: D3,
    });
    // The fixture is only useful if the merge really did conflict.
    expect(merge.code).not.toBe(0);
  });

  test("lists the conflicted paths and locates the markers by line", async () => {
    const out = await call(gitConflicts);
    expect(out.clean).toBe(false);
    expect(out.conflicted).toBe(1);
    expect(out.files[0].path).toBe("README.md");
    const region = out.files[0].regions[0];
    expect(region.startLine).toBe(2);
    expect(region.separatorLine).toBeGreaterThan(region.startLine);
    expect(region.endLine).toBeGreaterThan(region.separatorLine);
    expect(region.oursLabel).toBe("HEAD");
  });

  test("GitStatus agrees that the path is conflicted", async () => {
    const out = await call(gitStatus);
    expect(out.conflicted).toEqual([{ path: "README.md", code: "UU" }]);
  });

  test("a clean tree reports clean with no files", async () => {
    git(["merge", "--abort"], repo);
    const out = await call(gitConflicts);
    expect(out).toMatchObject({ clean: true, conflicted: 0, files: [] });
  });
});

// ---------------------------------------------------------------------------

describe("GitAdd, GitResetPaths and GitCommit", () => {
  test("staging then unstaging leaves the file on disk untouched", async () => {
    writeFileSync(join(repo, "new.txt"), "fresh\n");

    const added = await call(gitAdd, { paths: ["new.txt"] });
    expect(added.staged).toEqual(["new.txt"]);
    expect((await call(gitStatus)).staged.map((e: { path: string }) => e.path)).toEqual([
      "new.txt",
    ]);

    const reset = await call(gitResetPaths, { paths: ["new.txt"] });
    expect(reset.worktreeUntouched).toBe(true);
    const after = await call(gitStatus);
    expect(after.staged).toEqual([]);
    expect(after.untracked).toEqual(["new.txt"]);
    expect(readFileSync(join(repo, "new.txt"), "utf8")).toBe("fresh\n");
  });

  test("GitResetPaths has no whole-tree or --hard form in its schema", () => {
    const shape = Object.keys(
      (gitResetPaths.inputSchema as unknown as { shape: Record<string, unknown> }).shape,
    ).sort();
    expect(shape).toEqual(["cwd", "paths", "ref", "timeout"]);
    expect(gitResetPaths.inputSchema.safeParse({ paths: ["a"], hard: true }).success).toBe(true);
    // An unknown key is stripped by zod rather than forwarded to git.
    const parsed = gitResetPaths.inputSchema.safeParse({ paths: ["a"], hard: true });
    expect(parsed.success && Object.keys(parsed.data)).toEqual(["paths"]);
  });

  test("update stages tracked edits but not new files", async () => {
    writeFileSync(join(repo, "README.md"), "hello\nworld\nedited\n");
    writeFileSync(join(repo, "untracked.txt"), "x\n");
    await call(gitAdd, { paths: ["."], update: true });
    const out = await call(gitStatus);
    expect(out.staged.map((e: { path: string }) => e.path)).toEqual(["README.md"]);
    expect(out.untracked).toEqual(["untracked.txt"]);
  });

  test("a commit with a pinned date is reproducible in its metadata", async () => {
    writeFileSync(join(repo, "new.txt"), "fresh\n");
    await call(gitAdd, { paths: ["new.txt"] });
    const out = await call(gitCommit, { message: "add new.txt", date: D3 });
    expect(out.committed).toBe(true);
    expect(out.commit.subject).toBe("add new.txt");
    expect(out.commit.authorDate).toMatch(/^2026-01-04T05:06:07/);
    expect(out.commit.commitDate).toMatch(/^2026-01-04T05:06:07/);
    expect(out.amended).toBe(false);
  });

  test("an explicit author is recorded", async () => {
    writeFileSync(join(repo, "new.txt"), "fresh\n");
    await call(gitAdd, { paths: ["new.txt"] });
    const out = await call(gitCommit, {
      message: "authored elsewhere",
      author: "Other Person <other@example.com>",
      date: D3,
    });
    expect(out.commit.author).toBe("Other Person");
    expect(out.commit.authorEmail).toBe("other@example.com");
  });

  test("nothing staged is a readable failure, not a throw", async () => {
    const out = await gitCommit.execute({ cwd: "repo", message: "empty" });
    expect(String(out)).toContain("GitCommit failed");
    expect(String(out)).toContain("nothing to commit");
  });

  test("amend is off unless asked for, and rewrites when it is", async () => {
    const before = (await call(gitLog)).count;
    const out = await call(gitCommit, { message: "reworded", amend: true, date: D3 });
    expect(out.amended).toBe(true);
    const after = await call(gitLog);
    expect(after.count).toBe(before);
    expect(after.commits[0].subject).toBe("reworded");
  });
});

describe("GitSwitch, GitBranchCreate and GitBranchDelete", () => {
  test("creates and switches to a branch", async () => {
    const out = await call(gitSwitch, { branch: "topic", create: true });
    expect(out.switched).toBe(true);
    expect(out.branch).toBe("topic");
    expect(out.detached).toBe(false);
    expect((await call(gitStatus)).branch).toBe("topic");
  });

  test("detaching reports a null branch", async () => {
    const out = await call(gitSwitch, { branch: "HEAD~1", detach: true });
    expect(out.detached).toBe(true);
    expect(out.branch).toBe(null);
  });

  test("create and detach together is refused", async () => {
    const out = await gitSwitch.execute({ cwd: "repo", branch: "x", create: true, detach: true });
    expect(String(out)).toContain("pick one");
  });

  test("creates a branch at a start point without switching", async () => {
    const parent = git(["rev-parse", "HEAD~1"], repo).stdout.trim();
    const out = await call(gitBranchCreate, { name: "from-parent", startPoint: "HEAD~1" });
    expect(out.sha).toBe(parent);
    expect((await call(gitStatus)).branch).toBe("main");
  });

  test("deleting an unmerged branch is refused until forced, and reports where it was", async () => {
    git(["switch", "-c", "topic"], repo);
    writeFileSync(join(repo, "topic.txt"), "t\n");
    commitAll(repo, "topic commit", D3);
    const tip = git(["rev-parse", "topic"], repo).stdout.trim();
    git(["switch", "main"], repo);

    const refused = await gitBranchDelete.execute({ cwd: "repo", name: "topic" });
    expect(String(refused)).toContain("GitBranchDelete failed");

    const out = await call(gitBranchDelete, { name: "topic", force: true });
    expect(out.deleted).toBe("topic");
    expect(out.wasAt).toBe(tip);
    expect(out.forced).toBe(true);
  });
});

describe("GitStashPush, GitStashList and GitStashPop", () => {
  test("parks a change, lists it, and restores it", async () => {
    writeFileSync(join(repo, "README.md"), "hello\nworld\nstashed\n");

    const pushed = await call(gitStashPush, { message: "wip-marker" });
    expect(pushed.pushed).toBe(true);
    expect(pushed.top.subject).toContain("wip-marker");
    expect((await call(gitStatus)).clean).toBe(true);

    const listed = await call(gitStashList);
    expect(listed.count).toBe(1);
    expect(listed.stashes[0].ref).toBe("stash@{0}");

    const popped = await call(gitStashPop, { stash: "stash@{0}" });
    expect(popped.dropped).toBe(true);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toContain("stashed");
    expect((await call(gitStashList)).count).toBe(0);
  });

  test("apply keeps the entry on the stack", async () => {
    writeFileSync(join(repo, "README.md"), "hello\nworld\nstashed\n");
    await call(gitStashPush, { message: "keepme" });
    const out = await call(gitStashPop, { apply: true });
    expect(out.dropped).toBe(false);
    expect((await call(gitStashList)).count).toBe(1);
  });

  test("a free-form revision is refused where a stash entry is expected", async () => {
    const out = await gitStashPop.execute({ cwd: "repo", stash: "HEAD" });
    expect(String(out)).toContain("stash@{0}");
  });
});

describe("GitTagCreate", () => {
  test("creates an annotated tag at HEAD", async () => {
    const head = git(["rev-parse", "HEAD"], repo).stdout.trim();
    const out = await call(gitTagCreate, { name: "v1.0", message: "first release" });
    expect(out.annotated).toBe(true);
    expect(out.commit).toBe(head);
    const listed = await call(gitTagList);
    expect(listed.tags[0].subject).toBe("first release");
  });

  test("creates a lightweight tag at a given ref", async () => {
    const parent = git(["rev-parse", "HEAD~1"], repo).stdout.trim();
    const out = await call(gitTagCreate, { name: "old", ref: "HEAD~1" });
    expect(out.annotated).toBe(false);
    expect(out.commit).toBe(parent);
  });

  test("an existing tag is not moved without force", async () => {
    await call(gitTagCreate, { name: "v1.0" });
    const out = await gitTagCreate.execute({ cwd: "repo", name: "v1.0" });
    expect(String(out)).toContain("GitTagCreate failed");
  });
});

describe("GitApplyPatch", () => {
  test("checks a patch without changing anything, then applies it", async () => {
    writeFileSync(join(repo, "README.md"), "hello\nworld\npatched\n");
    const diff = await call(gitDiff, { mode: "patch" });
    git(["checkout", "--", "README.md"], repo);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("hello\nworld\n");

    const checked = await call(gitApplyPatch, { patch: diff.patch, check: true });
    expect(checked).toMatchObject({ applied: false, checkedOnly: true, wouldApply: true });
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("hello\nworld\n");

    const applied = await call(gitApplyPatch, { patch: diff.patch });
    expect(applied.applied).toBe(true);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("hello\nworld\npatched\n");
  });

  test("a patch that does not apply reports why instead of throwing", async () => {
    const bogus = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,1 +1,2 @@",
      "-nothing like the real file",
      "+replacement",
      "",
    ].join("\n");
    const out = await call(gitApplyPatch, { patch: bogus, check: true });
    expect(out.applied).toBe(false);
    expect(out.reason).toContain("GitApplyPatch failed");
  });

  test("a patch reaching outside the working tree is refused by git itself", async () => {
    const escaping = [
      "diff --git a/../escape.txt b/../escape.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/../escape.txt",
      "@@ -0,0 +1 @@",
      "+pwned",
      "",
    ].join("\n");
    const out = await call(gitApplyPatch, { patch: escaping });
    expect(out.applied).toBe(false);
    // The refusal is only worth anything if the file really is not there.
    expect(existsSync(join(workspace, "escape.txt"))).toBe(false);
    expect(existsSync(join(repo, "escape.txt"))).toBe(false);
  });

  test("a conflicted file past the size cap is reported, not read into memory", async () => {
    git(["switch", "-c", "big-side"], repo);
    writeFileSync(join(repo, "big.txt"), `${"a".repeat(64)}\n`.repeat(40_000));
    commitAll(repo, "big on the side branch", D3);
    git(["switch", "main"], repo);
    writeFileSync(join(repo, "big.txt"), `${"b".repeat(64)}\n`.repeat(40_000));
    commitAll(repo, "big on main", D3);
    expect(
      git(["merge", "big-side"], repo, { GIT_AUTHOR_DATE: D3, GIT_COMMITTER_DATE: D3 }).code,
    ).not.toBe(0);

    const out = await call(gitConflicts);
    const entry = out.files.find((f: { path: string }) => f.path === "big.txt");
    expect(entry.tooLarge).toBe(true);
    expect(entry.regions).toEqual([]);
  });
});

describe("GitCherryPick", () => {
  test("replays a commit onto the current branch", async () => {
    git(["switch", "-c", "topic"], repo);
    writeFileSync(join(repo, "topic.txt"), "t\n");
    commitAll(repo, "topic commit", D3);
    const pick = git(["rev-parse", "HEAD"], repo).stdout.trim();
    git(["switch", "main"], repo);

    const out = await call(gitCherryPick, { refs: [pick] });
    expect(out.picked).toBe(true);
    expect((await call(gitLog, { maxCount: 1 })).commits[0].subject).toBe("topic commit");
  });

  test("a conflicting pick reports the conflicted paths and what to do next", async () => {
    git(["switch", "-c", "topic"], repo);
    writeFileSync(join(repo, "README.md"), "hello\ntopic side\n");
    commitAll(repo, "topic edit", D3);
    const pick = git(["rev-parse", "HEAD"], repo).stdout.trim();
    git(["switch", "main"], repo);
    writeFileSync(join(repo, "README.md"), "hello\nmain side\n");
    commitAll(repo, "main edit", D3);

    const out = await call(gitCherryPick, { refs: [pick] });
    expect(out.picked).toBe(false);
    expect(out.conflicted).toEqual(["README.md"]);
    expect(out.next).toContain("GitConflicts");
  });
});

describe("GitWorktreeAdd, GitWorktreeList and GitWorktreeRemove", () => {
  test("adds a worktree inside the workspace, lists it, and removes it", async () => {
    expect((await call(gitWorktreeList)).count).toBe(1);

    const added = await call(gitWorktreeAdd, { path: "wt", createBranch: "wt-branch" });
    expect(added.added).toBe(join(workspace, "wt"));
    expect(added.branch).toBe("wt-branch");

    const listed = await call(gitWorktreeList);
    expect(listed.count).toBe(2);
    expect(listed.worktrees.map((w: { path: string }) => w.path).sort()).toEqual(
      [repo, join(workspace, "wt")].sort(),
    );

    const removed = await call(gitWorktreeRemove, { path: "wt" });
    expect(removed.removed).toBe(join(workspace, "wt"));
    expect((await call(gitWorktreeList)).count).toBe(1);
  });

  test("removing a path that is not a worktree is a readable failure", async () => {
    const out = await gitWorktreeRemove.execute({ cwd: "repo", path: "plain" });
    expect(String(out)).toContain("GitWorktreeRemove failed");
  });
});

describe("boundedness", () => {
  test("every schema caps the timeout a caller may ask for", () => {
    for (const tool of GIT_TOOLS) {
      const tooLong = tool.inputSchema.safeParse({
        cwd: "repo",
        timeout: 10_000_000,
        paths: ["README.md"],
        path: "README.md",
        message: "m",
        name: "n",
        branch: "b",
        refs: ["HEAD"],
        a: "HEAD",
        patch: "x",
      });
      expect({ name: tool.name, accepted: tooLong.success }).toEqual({
        name: tool.name,
        accepted: false,
      });
    }
  });

  test("the deadline is enforced on a run that would otherwise never end", async () => {
    // `!cmd` is git's shell-alias form, so this is a git invocation that hangs
    // for 30 seconds on purpose — the only honest way to prove the deadline
    // fires rather than the command merely being quick.
    const started = Date.now();
    const run = await runGit(["-c", "alias.crewhausstall=!sleep 30", "crewhausstall"], {
      cwd: repo,
      timeoutMs: 300,
    });
    const elapsed = Date.now() - started;
    expect(run.timedOut).toBe(true);
    expect(run.code).not.toBe(0);
    // The deadline plus the drain grace, with room to spare — and far short of
    // the 30 seconds the command asked for.
    expect(elapsed).toBeLessThan(5_000);
  });

  test("a grandchild holding the pipe open cannot hang the read either", async () => {
    // `sleep` outlives the killed git and keeps the write end of stdout open;
    // the result must come back cut rather than never coming back at all.
    const started = Date.now();
    const run = await runGit(["-c", "alias.crewhausleak=!sleep 30 &", "crewhausleak"], {
      cwd: repo,
      timeoutMs: 300,
    });
    expect(run.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a deadline hit while opening the repository is reported as a timeout", async () => {
    // 1ms cannot survive git's process startup, so the very first probe dies on
    // the deadline — and must say so, not claim this is not a repository.
    const out = String(await gitLog.execute({ cwd: "repo", timeout: 1 }));
    expect(out).toContain("timed out");
    expect(out).not.toContain("not a git repository");
  });

  test("output is capped, and the cap is reported rather than silently applied", async () => {
    const huge = `${"x".repeat(80)}\n`.repeat(12_000);
    writeFileSync(join(repo, "huge.txt"), huge);
    git(["add", "huge.txt"], repo);
    const out = await call(gitDiff, { staged: true, mode: "patch" });
    expect(huge.length).toBeGreaterThan(MAX_OUTPUT_CHARS);
    expect(out.patch.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    expect(out.note).toContain("output capped");
  });
});

/**
 * Regression — the DANGLING-symlink variant of the containment check.
 *
 * `resolveInsideRoot` used to probe for the deepest existing ancestor with
 * `existsSync`, which FOLLOWS symlinks. A link whose target does not exist
 * answers false, so the walk stepped past it, treated it as a plain missing
 * leaf, and re-appended the name to the realpath'd root — where it passed
 * containment. `git worktree add` is handed that path, and "the leaf does not
 * exist yet" is the NORMAL case for it, which is what made this resolver the
 * one most likely to act on the mistake.
 *
 * This copy of the resolver lives in `git-run.ts` rather than the `paths.ts`
 * the other packages use, which is why the repo-wide drift guard in
 * `apps/cli/src/tool-registry.test.ts` skipped it and the unsafe probe
 * survived here after being fixed everywhere else.
 */
describe("containment of a dangling symlink", () => {
  test("a worktree path that is a dangling symlink out of the workspace is refused", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-git-outside-")));
    try {
      const stolen = join(outside, "stolen-worktree");
      symlinkSync(stolen, join(workspace, "wt"));
      const out = await gitWorktreeAdd.execute({ cwd: "repo", path: "wt", createBranch: "b1" });
      // Refused by CONTAINMENT, not by git tripping over the existing name.
      expect(String(out)).toContain("outside the workspace root");
      expect(existsSync(stolen)).toBe(false);
      expect(lstatSync(join(workspace, "wt")).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a dangling symlink that stays inside the workspace is still honoured", async () => {
    // The mirror: refusing every dangling link would also "pass" the test
    // above. This one names its target through the UNRESOLVED tmpdir spelling
    // (/var/... on macOS, behind the /private/var symlink), which is the case
    // that catches the tempting wrong fix — reading the link and using that
    // raw target instead of resolving it first.
    const unresolved = join(tmpdir(), workspace.slice(workspace.lastIndexOf("/") + 1));
    const aliased = existsSync(unresolved) ? unresolved : workspace;
    symlinkSync(join(aliased, "made-wt"), join(workspace, "inside-wt"));
    const out = await gitWorktreeAdd.execute({
      cwd: "repo",
      path: "inside-wt",
      createBranch: "b2",
    });
    expect(String(out)).not.toContain("outside the workspace root");
    // It landed at the link's real in-workspace target, not beside the link.
    expect(existsSync(join(workspace, "made-wt"))).toBe(true);
  });

  test("an outward directory link holding a relative dangling link is refused", async () => {
    // A RELATIVE target resolves against the directory that really CONTAINS
    // the link. Measured from the lexical parent instead, this one reads as
    // an in-workspace path that it does not actually lead to.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-git-outside-")));
    try {
      mkdirSync(join(outside, "realdir"));
      symlinkSync(join(outside, "realdir"), join(workspace, "pdir"));
      symlinkSync("../escape-wt", join(outside, "realdir", "l"));
      const out = await gitWorktreeAdd.execute({ cwd: "repo", path: "pdir/l" });
      expect(String(out)).toContain("outside the workspace root");
      expect(existsSync(join(outside, "escape-wt"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
