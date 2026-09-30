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
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  MAX_OUTPUT_CHARS,
  failure,
  runGit,
  skippedPatchPaths,
  symlinksCreatedByPatch,
  unquoteGitPath,
} from "./git-run";
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

/**
 * The identity every fixture commit is made under. The suite points git's
 * global and system config at /dev/null, so a repository made with a bare
 * `git init` has no user.name/user.email, and git then guesses one from the
 * host. macOS hostnames (`name.local`) pass its check; a CI runner's does not
 * ("unable to auto-detect email address"), so the commit failed there and
 * the test went on against a repository with no commits.
 */
const FIXTURE_IDENTITY = {
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "A U Thor",
  GIT_COMMITTER_EMAIL: "author@example.com",
};

function commitAll(dir: string, message: string, date: string): void {
  git(["add", "-A"], dir);
  const committed = git(["commit", "-m", message], dir, {
    ...FIXTURE_IDENTITY,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  // A fixture that silently failed to commit is not the repository the test
  // describes: say so here, not as a confusing failure further down.
  if (committed.code !== 0) {
    throw new Error(`fixture commit in ${dir} failed: ${committed.stderr.trim()}`);
  }
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
 * C071: containing the `cwd` is not containing the repository. git works on
 * the repository it DISCOVERS from the cwd — an enclosing checkout, the one a
 * planted `.git` file names, or one whose history a `.git` directory borrows
 * from outside — so each test builds that layout, proves the tool is refused,
 * and asserts the outside repository was neither read nor changed. The
 * controls prove the layouts git builds itself (a linked worktree, a
 * submodule) still open when the workspace is one.
 */
describe("containment of the repository git discovers", () => {
  const extra: string[] = [];
  /** A fresh real temp dir outside the fixture workspace, removed after the test. */
  const outsideDir = (tag: string): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), `crewhaus-tool-git-${tag}-`)));
    extra.push(dir);
    return dir;
  };
  afterEach(() => {
    process.chdir(originalCwd);
    for (const dir of extra.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A repository with a committed file outside the workspace. */
  function victimRepo(tag: string): string {
    const victim = outsideDir(tag);
    initRepo(victim);
    writeFileSync(join(victim, "creds.txt"), "victim-secret\n");
    commitAll(victim, "victim commit", D3);
    return victim;
  }

  const REFUSED = "outside the workspace";

  test("a workspace nested in a larger repository: reads and writes are refused, the enclosing checkout untouched", async () => {
    const parent = outsideDir("parent");
    initRepo(parent);
    writeFileSync(join(parent, "outside.txt"), "main\n");
    commitAll(parent, "outside file", D3);
    git(["branch", "other"], parent);
    git(["switch", "-q", "other"], parent);
    writeFileSync(join(parent, "outside.txt"), "other\n");
    commitAll(parent, "other side", D3);
    git(["switch", "-q", "main"], parent);
    mkdirSync(join(parent, "harness"));
    writeFileSync(join(parent, "outside.txt"), "user edit\n");
    process.chdir(join(parent, "harness"));

    const cases: Array<[RegisteredTool, Record<string, unknown>]> = [
      [gitStatus, {}],
      [gitDiff, { mode: "patch" }],
      [gitLog, {}],
      [gitShow, { ref: "HEAD", path: "outside.txt" }],
      [gitStashPush, { message: "x" }],
      [gitSwitch, { branch: "other" }],
    ];
    for (const [tool, input] of cases) {
      const out = String(await tool.execute({ cwd: ".", ...input }));
      expect({
        name: tool.name,
        refused: out.includes(REFUSED),
        leaked: out.includes("user edit"),
      }).toEqual({
        name: tool.name,
        refused: true,
        leaked: false,
      });
    }
    // The remedy is one a harness that runs from its own directory can follow.
    const said = String(await gitStatus.execute({ cwd: "." }));
    expect(said).toContain("the directory the harness runs from");
    expect(said).not.toContain("run the harness from the repository's top level");
    expect(readFileSync(join(parent, "outside.txt"), "utf8")).toBe("user edit\n");
    expect(git(["stash", "list"], parent).stdout).toBe("");
    expect(git(["branch", "--show-current"], parent).stdout.trim()).toBe("main");
  });

  test("a planted .git file naming another repository is refused for reads and writes", async () => {
    const victim = victimRepo("victim");
    mkdirSync(join(workspace, "sub"));
    writeFileSync(join(workspace, "sub", ".git"), `gitdir: ${victim}/.git\n`);
    // Plain git follows the file: that is the door.
    expect(git(["show", "HEAD:creds.txt"], join(workspace, "sub")).stdout).toContain(
      "victim-secret",
    );

    const shown = String(await gitShow.execute({ cwd: "sub", ref: "HEAD", path: "creds.txt" }));
    expect(shown).toContain(REFUSED);
    expect(shown).not.toContain("victim-secret");
    // The refusal names the caller's cwd, never where the file led.
    expect(shown).not.toContain(victim);
    const created = String(await gitBranchCreate.execute({ cwd: "sub", name: "planted-ref" }));
    expect(created).toContain(REFUSED);
    expect(existsSync(join(victim, ".git", "refs", "heads", "planted-ref"))).toBe(false);
  });

  test("a planted .git directory whose core.worktree points outside is refused", async () => {
    const target = outsideDir("wt-target");
    writeFileSync(join(target, "notes.txt"), "keep me\n");
    mkdirSync(join(workspace, "sub2"));
    git(["init", "-q", "-b", "main"], join(workspace, "sub2"));
    git(["config", "core.worktree", target], join(workspace, "sub2"));
    expect(git(["status", "--porcelain"], join(workspace, "sub2")).stdout).toContain("notes.txt");

    const status = String(await gitStatus.execute({ cwd: "sub2" }));
    expect(status).toContain(REFUSED);
    expect(status).not.toContain("notes.txt");
    const added = String(await gitAdd.execute({ cwd: "sub2", paths: ["notes.txt"] }));
    expect(added).toContain(REFUSED);
    const stashed = String(await gitStashPush.execute({ cwd: "sub2", includeUntracked: true }));
    expect(stashed).toContain(REFUSED);
    expect(readFileSync(join(target, "notes.txt"), "utf8")).toBe("keep me\n");
  });

  test("a .git directory that takes its history from outside is refused: commondir, a linked objects dir, alternates", async () => {
    const victim = victimRepo("history");
    const victimHead = git(["rev-parse", "HEAD"], victim).stdout.trim();

    // (a) a hand-made worktree git dir whose `commondir` names the victim's.
    const a = join(workspace, "redirect", ".git");
    mkdirSync(a, { recursive: true });
    writeFileSync(join(a, "commondir"), `${victim}/.git\n`);
    writeFileSync(join(a, "gitdir"), `${a}\n`);
    writeFileSync(join(a, "HEAD"), "ref: refs/heads/main\n");
    // (b) the workspace's own .git with the victim's objects and refs linked in.
    const b = join(workspace, "linked");
    mkdirSync(b);
    git(["init", "-q", "-b", "main"], b);
    rmSync(join(b, ".git", "objects"), { recursive: true, force: true });
    rmSync(join(b, ".git", "refs"), { recursive: true, force: true });
    symlinkSync(join(victim, ".git", "objects"), join(b, ".git", "objects"));
    symlinkSync(join(victim, ".git", "refs"), join(b, ".git", "refs"));
    // (c) a clone that borrows the victim's object store.
    git(["clone", "-q", "--shared", victim, join(workspace, "shared")], workspace);

    for (const dir of ["redirect", "linked", "shared"]) {
      // Plain git reads the victim's history in every one of them.
      expect({
        dir,
        plain: git(["log", "-1", "--format=%H"], join(workspace, dir)).stdout.trim(),
      }).toEqual({
        dir,
        plain: victimHead,
      });
      const out = String(await gitLog.execute({ cwd: dir }));
      expect({ dir, refused: out.includes(REFUSED), leaked: out.includes(victimHead) }).toEqual({
        dir,
        refused: true,
        leaked: false,
      });
    }
  });

  test("chained alternates are followed: an in-workspace alternate whose own alternates name the victim is refused", async () => {
    // C071 bypass: the first `info/alternates` names an in-workspace object
    // dir (which passes a first-level check), and THAT dir's own alternates
    // name the victim's store. git follows the chain; the check must too.
    const victim = victimRepo("chain");
    const victimHead = git(["rev-parse", "HEAD"], victim).stdout.trim();
    const mid = join(workspace, "mid");
    mkdirSync(join(mid, "info"), { recursive: true });
    writeFileSync(join(mid, "info", "alternates"), `${join(victim, ".git", "objects")}\n`);
    const c = join(workspace, "c");
    mkdirSync(c);
    git(["init", "-q", "-b", "main"], c);
    writeFileSync(join(c, ".git", "objects", "info", "alternates"), `${mid}\n`);
    // Plain git reads the victim's committed file through the chain.
    expect(git(["show", `${victimHead}:creds.txt`], c).stdout).toContain("victim-secret");

    const shown = String(await gitShow.execute({ cwd: "c", ref: victimHead, path: "creds.txt" }));
    expect(shown).toContain("borrows from a repository outside the workspace");
    // The refusal names the file that actually holds the outward entry —
    // mid/info/alternates — not the repository's own objects/info/alternates,
    // which in this layout names only the in-workspace `mid`.
    expect(shown).toContain("mid/info/alternates");
    expect(shown).not.toContain("(objects/info/alternates)");
    expect(shown).not.toContain("victim-secret");
    expect(shown).not.toContain(victim);
  });

  test("a chain of in-workspace alternates that never leaves the workspace still opens", async () => {
    // The recursion refuses only a store that leads OUT: a legitimate chain
    // of in-workspace alternates (a shared object cache linked twice) opens.
    const cache = join(workspace, "cache");
    mkdirSync(cache);
    git(["init", "-q", "-b", "main", "--bare"], cache);
    const mid = join(workspace, "mid2");
    mkdirSync(join(mid, "info"), { recursive: true });
    writeFileSync(join(mid, "info", "alternates"), `${join(cache, "objects")}\n`);
    const c = join(workspace, "c2");
    mkdirSync(c);
    git(["init", "-q", "-b", "main"], c);
    writeFileSync(join(c, ".git", "objects", "info", "alternates"), `${mid}\n`);
    writeFileSync(join(c, "f.txt"), "in-workspace\n");
    commitAll(c, "c commit", D3);
    const out = JSON.parse(String(await gitLog.execute({ cwd: "c2" })));
    expect(out.commits[0].subject).toBe("c commit");
  });

  test("a link deep under refs/ or objects/pack/ is refused, not only one at depth one", async () => {
    // C071 bypass: linkLeadingOut scanned <gitdir>/<sub>/<name> only, so a
    // link at refs/remotes/v (depth 3) or objects/pack/<file> (depth 3) went
    // unseen while git read the victim's refs and packs through it.
    const victim = victimRepo("deep");
    git(["gc", "-q"], victim);
    const victimHead = git(["rev-parse", "HEAD"], victim).stdout.trim();

    // (a) a directory link deep under refs/: refs/remotes/v -> victim heads.
    const refsRepo = join(workspace, "refs-repo");
    mkdirSync(refsRepo);
    git(["init", "-q", "-b", "main"], refsRepo);
    mkdirSync(join(refsRepo, ".git", "refs", "remotes"), { recursive: true });
    symlinkSync(
      join(victim, ".git", "refs", "heads"),
      join(refsRepo, ".git", "refs", "remotes", "v"),
    );
    const bySha = String(await gitShow.execute({ cwd: "refs-repo", ref: victimHead }));
    expect(bySha).toContain("holds a link (refs/remotes/v)");
    expect(bySha).not.toContain("victim-secret");
    const byRef = String(
      await gitShow.execute({ cwd: "refs-repo", ref: "refs/remotes/v/main", path: "creds.txt" }),
    );
    expect(byRef).toContain("holds a link (refs/remotes/v)");
    expect(byRef).not.toContain("victim-secret");

    // (b) a file link deep under objects/pack/: the victim's pack files.
    const packRepo = join(workspace, "pack-repo");
    mkdirSync(packRepo);
    git(["init", "-q", "-b", "main"], packRepo);
    const victimPack = join(victim, ".git", "objects", "pack");
    for (const f of readdirSync(victimPack)) {
      symlinkSync(join(victimPack, f), join(packRepo, ".git", "objects", "pack", f));
    }
    const packShown = String(await gitShow.execute({ cwd: "pack-repo", ref: victimHead }));
    expect(packShown).toContain("objects/pack/");
    expect(packShown).not.toContain("victim-secret");
  });

  test("a loose-object leaf link is refused: objects/<fanout>/<rest> leading out (C071)", async () => {
    // C071 residual: the deep scan walked objects/pack and objects/info but
    // left the loose fan-out at depth one, so a symlink planted at a real
    // fan-out dir's leaf — objects/ab/cdef… -> the victim's loose object —
    // was never seen, and git read the borrowed object by hash. A fresh,
    // un-gc'd repository keeps every object loose, so this is the common case.
    const victim = victimRepo("loose");
    const victimHead = git(["rev-parse", "HEAD"], victim).stdout.trim();
    const fanout = victimHead.slice(0, 2);
    const rest = victimHead.slice(2);
    // The victim's commit object is loose (no gc): confirm the fixture.
    expect(existsSync(join(victim, ".git", "objects", fanout, rest))).toBe(true);

    const looseRepo = join(workspace, "loose-repo");
    mkdirSync(looseRepo);
    git(["init", "-q", "-b", "main"], looseRepo);
    const dir = join(looseRepo, ".git", "objects", fanout);
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(victim, ".git", "objects", fanout, rest), join(dir, rest));

    const shown = String(await gitShow.execute({ cwd: "loose-repo", ref: victimHead }));
    expect(shown).toContain(`holds a link (objects/${fanout}/${rest})`);
    expect(shown).toContain("outside the workspace");
    expect(shown).not.toContain("victim-secret");
  });

  test("a link at objects/info/<file> leading out is refused (objects/info stays covered)", async () => {
    // Kills a mutant that drops objects/info from the deep scan: git reads
    // objects/info/{packs,commit-graph,…} by name, so a link there leaks the
    // file it names just as objects/pack does.
    const out = outsideDir("info-target");
    writeFileSync(join(out, "borrowed"), "x\n");
    const infoRepo = join(workspace, "info-repo");
    mkdirSync(infoRepo);
    git(["init", "-q", "-b", "main"], infoRepo);
    mkdirSync(join(infoRepo, ".git", "objects", "info"), { recursive: true });
    symlinkSync(join(out, "borrowed"), join(infoRepo, ".git", "objects", "info", "commit-graph"));

    const shown = String(await gitLog.execute({ cwd: "info-repo" }));
    expect(shown).toContain("holds a link (objects/info/commit-graph)");
    expect(shown).toContain("outside the workspace");
  });

  test("an inside-staying refs/ directory link whose child leads out is refused (C071)", async () => {
    // C071 residual: deepLinkLeadingOut `continue`d on any link staying inside
    // the workspace, so it never looked beneath an in-workspace directory
    // link. refs/remotes -> ws/stage (inside) with ws/stage/v -> the victim's
    // heads (outside) let git resolve refs/remotes/v/main to the victim's ref
    // file, and bootstrapped the victim tip SHA from GitBranchList's error.
    const victim = victimRepo("refs-double");
    const victimHead = git(["rev-parse", "HEAD"], victim).stdout.trim();
    const stage = join(workspace, "stage");
    mkdirSync(stage);
    const double = join(workspace, "double");
    mkdirSync(double);
    git(["init", "-q", "-b", "main"], double);
    symlinkSync(stage, join(double, ".git", "refs", "remotes"));
    symlinkSync(join(victim, ".git", "refs", "heads"), join(stage, "v"));
    // Plain git resolves the victim's ref through the two links.
    expect(git(["rev-parse", "refs/remotes/v/main"], double).stdout.trim()).toBe(victimHead);

    const byRef = String(
      await gitShow.execute({ cwd: "double", ref: "refs/remotes/v/main", path: "creds.txt" }),
    );
    expect(byRef).toContain("holds a link (refs/remotes/v)");
    expect(byRef).toContain("outside the workspace");
    expect(byRef).not.toContain("victim-secret");
    // The branch listing must not disclose the victim tip SHA in its error.
    const branches = String(await gitBranchList.execute({ cwd: "double", remote: true }));
    expect(branches).toContain("outside the workspace");
    expect(branches).not.toContain(victimHead);
  });

  test("an inside-staying refs/ link that points at an ancestor does not loop the scan", async () => {
    // The descent into inside-staying directory links is realpath-guarded, so
    // a link pointing back up (refs/loop -> the git dir) terminates instead of
    // recursing forever; a normal repository still opens.
    const loopRepo = join(workspace, "loop-repo");
    mkdirSync(loopRepo);
    git(["init", "-q", "-b", "main"], loopRepo);
    writeFileSync(join(loopRepo, "f.txt"), "in-workspace\n");
    commitAll(loopRepo, "loop commit", D3);
    symlinkSync(join(loopRepo, ".git"), join(loopRepo, ".git", "refs", "loop"));
    const out = JSON.parse(String(await gitLog.execute({ cwd: "loop-repo" })));
    expect(out.commits[0].subject).toBe("loop commit");
  });

  test("a .git/hooks, .git/lfs or info/exclude linked outside is not history: the repository still works", async () => {
    // Sharing hooks by symlinking .git/hooks predates core.hooksPath, and
    // relocating .git/lfs to another disk is common. Neither moves the
    // working tree, refs or objects.
    const shared = outsideDir("shared-hooks");
    const lfs = outsideDir("shared-lfs");
    const exclude = join(outsideDir("shared-info"), "exclude");
    writeFileSync(exclude, "*.log\n");
    rmSync(join(repo, ".git", "hooks"), { recursive: true, force: true });
    symlinkSync(shared, join(repo, ".git", "hooks"));
    symlinkSync(lfs, join(repo, ".git", "lfs"));
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    rmSync(join(repo, ".git", "info", "exclude"), { force: true });
    symlinkSync(exclude, join(repo, ".git", "info", "exclude"));
    writeFileSync(join(repo, "noise.log"), "x\n");
    const status = await call(gitStatus);
    expect(status.branch).toBe("main");
    // The linked exclude file is honoured.
    expect(JSON.stringify(status)).not.toContain("noise.log");
    const branch = await call(gitBranchCreate, { name: "with-shared-hooks" });
    expect(branch.created).toBe("with-shared-hooks");

    // A link that does carry history (reflogs a write appends to) still
    // refuses the repository.
    rmSync(join(repo, ".git", "logs"), { recursive: true, force: true });
    symlinkSync(outsideDir("logs-out"), join(repo, ".git", "logs"));
    const refused = String(await gitStatus.execute({ cwd: "repo" }));
    expect(refused).toContain("holds a link (logs) leading outside");
  });

  test("an inherited GIT_DIR or GIT_WORK_TREE never redirects a tool", async () => {
    const victim = victimRepo("env");
    const victimHead = git(["rev-parse", "HEAD"], victim).stdout.trim();
    const saved = { dir: process.env["GIT_DIR"], tree: process.env["GIT_WORK_TREE"] };
    process.env["GIT_DIR"] = join(victim, ".git");
    process.env["GIT_WORK_TREE"] = victim;
    try {
      const out = await call(gitLog);
      expect(JSON.stringify(out)).not.toContain(victimHead);
      expect(out.commits[0].subject).toBe("second commit");
    } finally {
      if (saved.dir === undefined) Reflect.deleteProperty(process.env, "GIT_DIR");
      else process.env["GIT_DIR"] = saved.dir;
      if (saved.tree === undefined) Reflect.deleteProperty(process.env, "GIT_WORK_TREE");
      else process.env["GIT_WORK_TREE"] = saved.tree;
    }
  });

  test("every run carries a discovery ceiling at the workspace root", async () => {
    const parent = outsideDir("ceiling");
    initRepo(parent);
    mkdirSync(join(parent, "harness"));
    process.chdir(join(parent, "harness"));
    // Without the ceiling this finds the enclosing repository.
    expect(git(["rev-parse", "--show-toplevel"], join(parent, "harness")).code).toBe(0);
    const run = await runGit(["rev-parse", "--show-toplevel"], {
      cwd: join(parent, "harness"),
      timeoutMs: 10_000,
      readOnly: true,
    });
    expect({ code: run.code, notRepo: /not a git repository/i.test(run.stderr) }).toEqual({
      code: 128,
      notRepo: true,
    });
  });

  test("control: a workspace that is a linked worktree of an outside repository still opens", async () => {
    const main = victimRepo("wt-main");
    const base = outsideDir("wt-base");
    const wt = join(base, "wt");
    expect(git(["worktree", "add", "-q", "-b", "wtb", wt], main).code).toBe(0);
    process.chdir(wt);
    const out = JSON.parse(String(await gitStatus.execute({ cwd: "." })));
    expect(out.branch).toBe("wtb");
  });

  test("control: a workspace that is a submodule checkout still opens", async () => {
    const sub = victimRepo("sm-sub");
    const sup = outsideDir("sm-super");
    initRepo(sup);
    expect(
      git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "mod"], sup).code,
    ).toBe(0);
    process.chdir(join(sup, "mod"));
    const out = JSON.parse(String(await gitStatus.execute({ cwd: "." })));
    expect(out.clean).toBe(true);
  });

  test("control: a worktree GitWorktreeAdd made inside the workspace opens", async () => {
    const added = await call(gitWorktreeAdd, { path: "inner-wt", createBranch: "inner" });
    expect(String(JSON.stringify(added))).not.toContain(REFUSED);
    const out = JSON.parse(String(await gitStatus.execute({ cwd: "inner-wt" })));
    expect(out.branch).toBe("inner");
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

  test("a token in a remote's URL, or in an insteadOf rewrite, is masked (C051)", async () => {
    const tok = ["gh", "p_", "FAKE", "0123456789abcdefABCDEF0123456789ab"].join("");
    git(["remote", "add", "origin", `https://x-access-token:${tok}@example.invalid/x.git`], repo);
    // The CI pattern: a clean remote, and a repo-local rewrite that adds a token.
    git(["remote", "add", "deps", "https://deps.invalid/y.git"], repo);
    git(["config", `url.https://${tok}@deps.invalid/.insteadOf`, "https://deps.invalid/"], repo);
    const text = await gitRemoteList.execute({ cwd: "repo" });
    expect(String(text)).not.toContain(tok);
    const out = JSON.parse(String(text)) as { remotes: Array<Record<string, unknown>> };
    expect(out.remotes).toEqual([
      {
        name: "deps",
        fetch: "https://***@deps.invalid/y.git",
        push: "https://***@deps.invalid/y.git",
        credentialsRedacted: true,
      },
      {
        name: "origin",
        fetch: "https://***@example.invalid/x.git",
        push: "https://***@example.invalid/x.git",
        credentialsRedacted: true,
      },
    ]);
  });

  test("an error that quotes a remote's URL does not quote its credential", () => {
    const tok = ["gh", "p_", "FAKE", "0123456789abcdefABCDEF0123456789ab"].join("");
    const message = failure("GitRemoteList", {
      code: 128,
      stdout: "",
      stderr: `fatal: repository 'https://x-access-token:${tok}@example.invalid/x.git/' not found`,
      timedOut: false,
      truncated: false,
      args: ["remote", "-v"],
    });
    expect(message).not.toContain(tok);
    expect(message).toContain("example.invalid/x.git");
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
  const linkOutsideDirs: string[] = [];
  const outsideForLinks = (): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-tool-git-link-")));
    linkOutsideDirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of linkOutsideDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

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

  describe("a patch creating a symbolic link out of the workspace is refused (C070 enabler)", () => {
    const linkPatch = (path: string, target: string): string =>
      [
        `diff --git a/${path} b/${path}`,
        "new file mode 120000",
        "index 0000000..1111111",
        "--- /dev/null",
        `+++ b/${path}`,
        "@@ -0,0 +1 @@",
        `+${target}`,
        "\\ No newline at end of file",
        "",
      ].join("\n");

    test("an absolute target outside the workspace is refused, nothing planted", async () => {
      const outside = join(outsideForLinks(), "planted.rc");
      const out = await call(gitApplyPatch, { cwd: "repo", patch: linkPatch("evil", outside) });
      expect(out).toMatchObject({ applied: false, wouldApply: false });
      expect(out.reason).toContain("symbolic link (evil)");
      expect(out.reason).toContain("outside the workspace");
      expect(existsSync(join(repo, "evil"))).toBe(false);
      expect(existsSync(outside)).toBe(false);
    });

    test("a ../ target that climbs out of the workspace is refused", async () => {
      // repo is one level under the workspace root, so `../../x` leaves it.
      const out = await call(gitApplyPatch, {
        cwd: "repo",
        patch: linkPatch("up", "../../outside.rc"),
      });
      expect(out).toMatchObject({ applied: false, wouldApply: false });
      expect(out.reason).toContain("symbolic link (up)");
      expect(existsSync(join(repo, "up"))).toBe(false);
    });

    test("check mode refuses too, so it never reports 'would apply' for an escaping link", async () => {
      const out = await call(gitApplyPatch, {
        cwd: "repo",
        patch: linkPatch("evil2", "/etc/passwd"),
        check: true,
      });
      expect(out).toMatchObject({ applied: false, checkedOnly: true, wouldApply: false });
      expect(existsSync(join(repo, "evil2"))).toBe(false);
    });

    test("a link that stays inside the workspace still applies", async () => {
      const out = await call(gitApplyPatch, { cwd: "repo", patch: linkPatch("good", "README.md") });
      expect(out.applied).toBe(true);
      expect(lstatSync(join(repo, "good")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(repo, "good"))).toBe("README.md");
    });

    test("a link into a sibling directory of the repo applies: target inside the workspace, outside the repo", async () => {
      // The workspace holds sibling directories (here `repo` and `plain`); a
      // link from one into another points INSIDE the workspace and is
      // legitimate — a vendored dependency, a shared asset. It was wrongly
      // refused, and mislabelled "outside the workspace", when the bound was
      // the repository's top level instead of the workspace root.
      expect(existsSync(join(workspace, "plain"))).toBe(true);
      const out = await call(gitApplyPatch, { cwd: "repo", patch: linkPatch("sib", "../plain") });
      expect(out.applied).toBe(true);
      expect(lstatSync(join(repo, "sib")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(repo, "sib"))).toBe("../plain");
    });

    test("the escaping-link check honours strip, not a fixed -p1", async () => {
      // Kills a mutant that always passes strip 1: the patch header carries an
      // extra component, so only strip 2 gives the real link path `deep/link`
      // and resolves `../../../outside` out of the workspace. Read with strip
      // 1 the path and its `..` climb land back inside, and the escape is
      // missed while git (run with -p2) still creates it.
      const out = await call(gitApplyPatch, {
        cwd: "repo",
        patch: linkPatch("x/deep/link", "../../../outside"),
        strip: 2,
      });
      expect(out).toMatchObject({ applied: false, wouldApply: false });
      expect(out.reason).toContain("symbolic link (deep/link)");
      expect(existsSync(join(repo, "deep", "link"))).toBe(false);
    });
  });

  test("symlinksCreatedByPatch reads targets and honours -p; a deletion contributes none", () => {
    const patch = [
      "diff --git a/dir/link b/dir/link",
      "new file mode 120000",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/dir/link",
      "@@ -0,0 +1 @@",
      "+/etc/passwd",
      "\\ No newline at end of file",
      "diff --git a/gone b/gone",
      "deleted file mode 120000",
      "index 1111111..0000000",
      "--- a/gone",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-/was/here",
      "diff --git a/plain.txt b/plain.txt",
      "new file mode 100644",
      "index 0000000..2222222",
      "--- /dev/null",
      "+++ b/plain.txt",
      "@@ -0,0 +1 @@",
      "+not a link",
      "",
    ].join("\n");
    // -p1 (git's default) drops the a/ or b/ prefix.
    expect(symlinksCreatedByPatch(patch, 1)).toEqual([{ path: "dir/link", target: "/etc/passwd" }]);
    // -p2 drops one more component.
    expect(symlinksCreatedByPatch(patch, 2)).toEqual([{ path: "link", target: "/etc/passwd" }]);
  });

  test("git's quoted path names are read back to the file they name", () => {
    expect(unquoteGitPath("plain.txt")).toBe("plain.txt");
    expect(unquoteGitPath('"tab\\tname.txt"')).toBe("tab\tname.txt");
    expect(unquoteGitPath('"say \\"hi\\".txt"')).toBe('say "hi".txt');
    expect(unquoteGitPath('"back\\\\slash"')).toBe("back\\slash");
    // An octal escape is a UTF-8 byte, whatever core.quotepath says.
    expect(unquoteGitPath('"caf\\303\\251.txt"')).toBe("café.txt");
    // Something git would never write is left as written, not guessed at.
    expect(unquoteGitPath('"odd\\q"')).toBe('"odd\\q"');
    expect(
      skippedPatchPaths("Skipped patch 'a.txt'.\nChecking patch b...\nSkipped patch 'it'.'.\n"),
    ).toEqual(["a.txt", "it'."]);
  });

  describe("a patch path outside cwd (C219)", () => {
    // git applies only what lies under the directory it runs in, skips the
    // rest in silence and exits 0. 0.7.0 read exit 0 as "applied".
    const change = (file: string, from: string, to: string): string =>
      [
        `diff --git a/${file} b/${file}`,
        `--- a/${file}`,
        `+++ b/${file}`,
        "@@ -1 +1 @@",
        `-${from}`,
        `+${to}`,
        "",
      ].join("\n");
    const outside = change("outside.txt", "one", "two");
    const inside = change("pkg/inside.txt", "alpha", "beta");
    const read = (rel: string): string => readFileSync(join(repo, rel), "utf8");

    beforeEach(() => {
      mkdirSync(join(repo, "pkg"));
      writeFileSync(join(repo, "pkg/inside.txt"), "alpha\n");
      writeFileSync(join(repo, "outside.txt"), "one\n");
      commitAll(repo, "pkg and outside", D3);
    });

    test("check: a skipped path is not 'would apply'", async () => {
      const out = await call(gitApplyPatch, { cwd: "repo/pkg", patch: outside, check: true });
      expect(out).toMatchObject({ applied: false, checkedOnly: true, wouldApply: false });
      expect(out.skipped).toEqual(["outside.txt"]);
      expect(out.reason).toContain('outside "pkg"');
    });

    test("apply: a skipped path is not 'applied', and nothing changes", async () => {
      const out = await call(gitApplyPatch, { cwd: "repo/pkg", patch: outside });
      expect(out).toMatchObject({ applied: false, wouldApply: false, skipped: ["outside.txt"] });
      expect(out.reason).toContain("Nothing was applied");
      expect(read("outside.txt")).toBe("one\n");
    });

    test("a patch half in scope is refused whole, never half-applied", async () => {
      const out = await call(gitApplyPatch, { cwd: "repo/pkg", patch: `${outside}${inside}` });
      expect(out).toMatchObject({ applied: false, skipped: ["outside.txt"] });
      expect(read("outside.txt")).toBe("one\n");
      expect(read("pkg/inside.txt")).toBe("alpha\n");
    });

    test("a git-header patch written relative to cwd is refused, not a silent no-op", async () => {
      // `diff --git` paths are relative to the repository root, so from
      // cwd "pkg" this names repo/inside.txt — which git skips.
      const out = await call(gitApplyPatch, {
        cwd: "repo/pkg",
        patch: change("inside.txt", "alpha", "beta"),
      });
      expect(out).toMatchObject({ applied: false, skipped: ["inside.txt"] });
      expect(read("pkg/inside.txt")).toBe("alpha\n");
    });

    test("a quoted path is reported as the file it names", async () => {
      writeFileSync(join(repo, "tab\tname.txt"), "one\n");
      commitAll(repo, "an awkward name", D3);
      const patch = [
        'diff --git "a/tab\\tname.txt" "b/tab\\tname.txt"',
        '--- "a/tab\\tname.txt"',
        '+++ "b/tab\\tname.txt"',
        "@@ -1 +1 @@",
        "-one",
        "+two",
        "",
      ].join("\n");
      const out = await call(gitApplyPatch, { cwd: "repo/pkg", patch, check: true });
      expect(out.skipped).toEqual(["tab\tname.txt"]);
    });

    test("a rename or copy whose SOURCE lies outside cwd is refused, and moves nothing", async () => {
      // git checks only a renamed file's new name against cwd, so this patch
      // was applied from "pkg" and deleted outside.txt.
      const rename = [
        "diff --git a/outside.txt b/pkg/outside.txt",
        "similarity index 100%",
        "rename from outside.txt",
        "rename to pkg/outside.txt",
        "",
      ].join("\n");
      for (const check of [true, false]) {
        const out = await call(gitApplyPatch, { cwd: "repo/pkg", patch: rename, check });
        expect(out).toMatchObject({ applied: false, wouldApply: false });
        expect(out.skipped).toEqual(["outside.txt => pkg/outside.txt"]);
        expect(out.reason).toContain('outside "pkg"');
      }
      expect(read("outside.txt")).toBe("one\n");
      expect(existsSync(join(repo, "pkg", "outside.txt"))).toBe(false);

      const copy = rename.replace("rename from", "copy from").replace("rename to", "copy to");
      const copied = await call(gitApplyPatch, { cwd: "repo/pkg", patch: copy });
      expect(copied).toMatchObject({ applied: false, skipped: ["outside.txt => pkg/outside.txt"] });
      expect(existsSync(join(repo, "pkg", "outside.txt"))).toBe(false);
    });

    test("a rename whose TARGET lies outside cwd is refused before anything runs", async () => {
      // The mirror of the case above: reversed, this patch's new name is
      // pkg/inside.txt, inside cwd, so only the forward preflight names it.
      // Without that preflight the real apply skipped it and came back as a
      // "partial" apply of a patch that changed nothing.
      const rename = [
        "diff --git a/pkg/inside.txt b/moved-out.txt",
        "similarity index 100%",
        "rename from pkg/inside.txt",
        "rename to moved-out.txt",
        "",
      ].join("\n");
      for (const check of [true, false]) {
        const out = await call(gitApplyPatch, { cwd: "repo/pkg", patch: rename, check });
        expect(out).toMatchObject({ applied: false, wouldApply: false });
        expect(out.partial).toBeUndefined();
        expect(out.skipped).toEqual(["pkg/inside.txt => moved-out.txt"]);
        expect(out.reason).toContain("Nothing was applied");
      }
      expect(read("pkg/inside.txt")).toBe("alpha\n");
      expect(existsSync(join(repo, "moved-out.txt"))).toBe(false);
    });

    test("a rename wholly inside cwd still applies from there", async () => {
      const rename = [
        "diff --git a/pkg/inside.txt b/pkg/moved.txt",
        "similarity index 100%",
        "rename from pkg/inside.txt",
        "rename to pkg/moved.txt",
        "",
      ].join("\n");
      const out = await call(gitApplyPatch, { cwd: "repo/pkg", patch: rename });
      expect(out).toMatchObject({ applied: true });
      expect(read("pkg/moved.txt")).toBe("alpha\n");
      expect(existsSync(join(repo, "pkg", "inside.txt"))).toBe(false);
    });

    test("from the repository root the same patch applies whole", async () => {
      const checked = await call(gitApplyPatch, { patch: `${outside}${inside}`, check: true });
      expect(checked).toMatchObject({ checkedOnly: true, wouldApply: true });
      expect(checked.skipped).toBeUndefined();
      const out = await call(gitApplyPatch, { patch: `${outside}${inside}` });
      expect(out).toMatchObject({ applied: true, wouldApply: true });
      expect(read("outside.txt")).toBe("two\n");
      expect(read("pkg/inside.txt")).toBe("beta\n");
    });

    test("a header-less patch from a subdirectory still applies there", async () => {
      // Without `diff --git`, git reads the paths relative to cwd.
      const plain = ["--- a/inside.txt", "+++ b/inside.txt", "@@ -1 +1 @@", "-alpha", "+beta", ""];
      const out = await call(gitApplyPatch, { cwd: "repo/pkg", patch: plain.join("\n") });
      expect(out).toMatchObject({ applied: true });
      expect(read("pkg/inside.txt")).toBe("beta\n");
    });

    test("a failure still leads with git's own error, not -v's progress lines", async () => {
      const out = await call(gitApplyPatch, { patch: change("pkg/inside.txt", "WRONG", "beta") });
      expect(out.applied).toBe(false);
      expect(out.reason).toMatch(/^GitApplyPatch failed \(git exit 1\): error: /);
      expect(out.reason).not.toContain("Checking patch");
    });
  });

  test("check with threeWay says a conflicting merge would not apply cleanly", async () => {
    // `git apply --check --3way` exits 0 here while the real apply leaves
    // conflict markers and exits 1; the check has to agree with the apply.
    writeFileSync(join(repo, "README.md"), "hello\nworld\npatched\n");
    const diff = await call(gitDiff, { mode: "patch" });
    git(["checkout", "--", "README.md"], repo);
    writeFileSync(join(repo, "README.md"), "hello\nworld\nsomething else\n");
    commitAll(repo, "diverge", D3);
    const out = await call(gitApplyPatch, { patch: diff.patch, check: true, threeWay: true });
    expect(out).toMatchObject({ applied: false, checkedOnly: true, wouldApply: false });
    expect(out.conflicts).toEqual(["README.md"]);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("hello\nworld\nsomething else\n");
  });

  test("a real threeWay apply that leaves conflicts says it applied, and names them", async () => {
    // git writes the merge — conflict markers in the file, unmerged stages in
    // the index — and exits 1. `applied: false` would say nothing changed.
    writeFileSync(join(repo, "README.md"), "hello\nworld\npatched\n");
    const diff = await call(gitDiff, { mode: "patch" });
    git(["checkout", "--", "README.md"], repo);
    writeFileSync(join(repo, "README.md"), "hello\nworld\nsomething else\n");
    commitAll(repo, "diverge", D3);
    const real = await call(gitApplyPatch, { patch: diff.patch, threeWay: true, index: true });
    const content = readFileSync(join(repo, "README.md"), "utf8");
    const unmergedStages = git(["ls-files", "-u", "--", "README.md"], repo)
      .stdout.trim()
      .split("\n");
    expect({
      applied: real.applied,
      conflicted: real.conflicted,
      conflicts: real.conflicts,
      markers: content.includes("<<<<<<<") && content.includes(">>>>>>>"),
      unmergedStages: unmergedStages.length,
    }).toEqual({
      applied: true,
      conflicted: true,
      conflicts: ["README.md"],
      markers: true,
      unmergedStages: 3,
    });
    expect(String(real.reason)).toContain("WITH CONFLICTS");
  });

  test("a threeWay apply that fails outright still says nothing was applied", async () => {
    // A patch whose preimage blob this repository lacks cannot fall back to a
    // merge: git writes nothing, prints no `U` line, and the answer is false.
    const patch = [
      "diff --git a/README.md b/README.md",
      "index 0123456..89abcde 100644",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
      "-not what the file says",
      "+changed",
      "",
    ].join("\n");
    const before = readFileSync(join(repo, "README.md"), "utf8");
    const out = await call(gitApplyPatch, { patch, threeWay: true });
    expect({ applied: out.applied, conflicted: out.conflicted }).toEqual({
      applied: false,
      conflicted: undefined,
    });
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe(before);
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
    // The probe `openRepo` runs is a plain `git rev-parse --show-toplevel`, so
    // there is no alias to stall it the way the two tests above stall theirs —
    // and a tiny deadline on the real binary is a race rather than a test: a
    // quick machine finishes the probe first and the tool returns a perfectly
    // good log. CI did exactly that. Put a git that CANNOT return early ahead
    // of the real one, so the deadline is guaranteed to be what ends the probe.
    const shimDir = join(workspace, "slow-git");
    mkdirSync(shimDir);
    writeFileSync(join(shimDir, "git"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    const savedPath = process.env["PATH"];
    process.env["PATH"] = `${shimDir}:${savedPath ?? ""}`;
    try {
      const out = String(await gitLog.execute({ cwd: "repo", timeout: 50 }));
      expect(out).toContain("timed out");
      expect(out).not.toContain("not a git repository");
    } finally {
      if (savedPath === undefined) Reflect.deleteProperty(process.env, "PATH");
      else process.env["PATH"] = savedPath;
    }
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
/**
 * Final review (0.7.1): a pathspec is a glob to git, where `*` crosses `/`,
 * while a permission rule reads the same value as the literal path it
 * spells. `secret*` met no `alwaysDeny GitDiff(secrets/**)` and diffed,
 * staged or committed everything under secrets/. Every tool that hands a
 * caller's path to git as a pathspec now hands it over literal.
 */
describe("a caller's pathspec is literal, never a glob", () => {
  const SECRET = "sk-live-NOT-FOR-THE-MODEL";
  /** The spellings a glob pathspec would widen to secrets/. */
  const GLOBS = ["secret*", "secret?/*", "[s]ecrets", "*"];
  const on = (args: string[]) => git(args, repo).stdout;
  const staged = () => on(["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
  beforeEach(() => {
    mkdirSync(join(repo, "secrets"));
    mkdirSync(join(repo, "app", "[id]"), { recursive: true });
    writeFileSync(join(repo, "secrets", "key.txt"), "old\n");
    writeFileSync(join(repo, "app", "[id]", "page.tsx"), "page\n");
    commitAll(repo, "add secrets and a route", D3);
    writeFileSync(join(repo, "secrets", "key.txt"), `${SECRET}\n`);
    writeFileSync(join(repo, "secrets", "new.txt"), "untracked\n");
    writeFileSync(join(repo, "app", "[id]", "page.tsx"), "page two\n");
  });

  /**
   * Each tool that passes caller paths to git as pathspecs, with a call that
   * would act on secrets/ were the path a glob, and what it must show
   * instead. `hits` counts the tools the sweep ran, and the static count
   * below ties it to the tools that check pathspecs at all.
   */
  const PATHSPEC_TOOLS = [
    "GitDiff",
    "GitLog",
    "GitFileHistory",
    "GitAdd",
    "GitCommit",
    "GitStashPush",
    "GitResetPaths",
  ];

  test("no glob spelling reaches secrets/ through any tool that takes pathspecs", async () => {
    const hits = new Set<string>();
    for (const glob of GLOBS) {
      // Reads: nothing under secrets/ comes back.
      const diff = String(await gitDiff.execute({ cwd: "repo", mode: "patch", paths: [glob] }));
      expect({ glob, diff: diff.includes(SECRET) }).toEqual({ glob, diff: false });
      hits.add("GitDiff");
      const log = await call(gitLog, { paths: [glob] });
      expect({ glob, log: log.count ?? log }).toEqual({ glob, log: 0 });
      hits.add("GitLog");
      const history = await call(gitFileHistory, { path: glob });
      expect({ glob, history: history.count ?? history }).toEqual({ glob, history: 0 });
      hits.add("GitFileHistory");
      // Writes: nothing under secrets/ is staged, committed or stashed.
      await gitAdd.execute({ cwd: "repo", paths: [glob] });
      expect({ glob, staged: staged() }).toEqual({ glob, staged: [] });
      hits.add("GitAdd");
      const head = on(["rev-parse", "HEAD"]);
      await gitCommit.execute({ cwd: "repo", message: "sneak", paths: [glob] });
      expect({ glob, head: on(["rev-parse", "HEAD"]) }).toEqual({ glob, head });
      hits.add("GitCommit");
      await gitStashPush.execute({ cwd: "repo", paths: [glob] });
      expect({ glob, stashes: on(["stash", "list"]) }).toEqual({ glob, stashes: "" });
      expect(readFileSync(join(repo, "secrets", "key.txt"), "utf8")).toContain(SECRET);
      hits.add("GitStashPush");
      git(["add", "--", "secrets/key.txt"], repo);
      await gitResetPaths.execute({ cwd: "repo", paths: [glob] });
      expect({ glob, staged: staged() }).toEqual({ glob, staged: ["secrets/key.txt"] });
      git(["reset", "--quiet", "--", "secrets/key.txt"], repo);
      hits.add("GitResetPaths");
    }
    expect([...hits].sort()).toEqual([...PATHSPEC_TOOLS].sort());
  }, 60_000);

  test("a literal path still works: a directory with everything under it, and a name with [ ]", async () => {
    const diff = await call(gitDiff, { mode: "nameOnly", paths: ["secrets"] });
    expect(diff.paths).toEqual(["secrets/key.txt"]);
    const route = await call(gitDiff, { mode: "nameOnly", paths: ["app/[id]/page.tsx"] });
    expect(route.paths).toEqual(["app/[id]/page.tsx"]);
    expect((await call(gitLog, { paths: ["secrets"] })).count).toBe(1);
    expect((await call(gitFileHistory, { path: "app/[id]/page.tsx" })).count).toBe(1);
    const added = await call(gitAdd, { paths: ["app/[id]/page.tsx"] });
    expect(added.staged).toEqual(["app/[id]/page.tsx"]);
    expect(staged()).toEqual(["app/[id]/page.tsx"]);
    await call(gitResetPaths, { paths: ["app/[id]/page.tsx"] });
    expect(staged()).toEqual([]);
    const pushed = await call(gitStashPush, { paths: ["app/[id]/page.tsx"] });
    expect(pushed.pushed).toBe(true);
    expect(readFileSync(join(repo, "app", "[id]", "page.tsx"), "utf8")).toBe("page\n");
    const committed = await call(gitCommit, { message: "route", paths: ["secrets/key.txt"] });
    expect(committed.committed).toBe(true);
    expect(on(["show", "--name-only", "--format=", "HEAD"]).trim()).toBe("secrets/key.txt");
  }, 30_000);

  test("a pathspec that matches nothing reads as the caller wrote it", async () => {
    const out = String(await gitAdd.execute({ cwd: "repo", paths: ["secret*"] }));
    expect(out).toContain("GitAdd failed");
    expect(out).toContain("'secret*' did not match any files");
    expect(out).not.toContain(":(literal)");
  });

  test("an inherited GIT_ICASE_PATHSPECS or GIT_LITERAL_PATHSPECS changes nothing", async () => {
    for (const [name, value] of [
      ["GIT_ICASE_PATHSPECS", "1"],
      ["GIT_GLOB_PATHSPECS", "1"],
      ["GIT_LITERAL_PATHSPECS", "1"],
    ] as const) {
      const saved = process.env[name];
      process.env[name] = value;
      try {
        // Folded case would reach secrets/ where a rule on `SECRETS` reads
        // another directory (Linux); literal-mode magic would make every
        // checked pathspec match nothing at all.
        const upper = String(
          await gitDiff.execute({ cwd: "repo", mode: "patch", paths: ["SECRETS"] }),
        );
        expect({ name, leaked: upper.includes(SECRET) }).toEqual({ name, leaked: false });
        const glob = String(
          await gitDiff.execute({ cwd: "repo", mode: "patch", paths: ["secret*"] }),
        );
        expect({ name, leaked: glob.includes(SECRET) }).toEqual({ name, leaked: false });
        const exact = await call(gitDiff, { mode: "nameOnly", paths: ["secrets"] });
        expect({ name, paths: exact.paths }).toEqual({ name, paths: ["secrets/key.txt"] });
      } finally {
        if (saved === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = saved;
      }
    }
  }, 30_000);

  test("every call site that checks a pathspec is a pathspec tool above or reads one named file", () => {
    // GitShow reads `<ref>:./<path>` and GitBlame one file: neither is a
    // pathspec, and git reads both literally already. Every other caller of
    // checkPathspecs is in PATHSPEC_TOOLS, so a new one fails here until it
    // is added to the sweep above.
    const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    const callers = [...source.matchAll(/checkPathspecs\("(\w+)"/g)].map((m) => m[1]).sort();
    expect(callers).toEqual([...PATHSPEC_TOOLS, "GitShow", "GitBlame"].sort());
    // And each pathspec tool hands git the checked value, not its input.
    expect(source.match(/\.\.\.checked\.value/g)?.length).toBe(PATHSPEC_TOOLS.length);
  });
});

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
