/**
 * C007 — DiffLint, a read, runs no program a repository's own config names.
 *
 * It spawns `git diff` when no diff text is given, through tool-git's shared
 * runner. The fixture plants an fsmonitor hook, a textconv, an external diff
 * driver and a clean/smudge filter in `.git/config`, each appending to one
 * marker file, and proves them live with plain git before asserting DiffLint
 * fires none. A second case is the clone-only vector: a directory laid out
 * as a git dir, committed into another repository.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffLint } from "./index";

let workspace: string;
let repo: string;
let marker: string;
const originalCwd = process.cwd();
const saved: Record<string, string | undefined> = {};

function git(args: string[], cwd: string): number {
  return Bun.spawnSync(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  }).exitCode;
}

function hook(name: string, body: string): string {
  const file = join(workspace, `${name}.sh`);
  writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(marker)}\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

function ran(): string[] {
  return existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n") : [];
}

beforeAll(() => {
  for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"]) {
    saved[key] = process.env[key];
    process.env[key] = "/dev/null";
  }
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-changeset-cfg-")));
  marker = join(workspace, "RAN");
  repo = join(workspace, "repo");
  mkdirSync(repo);
  process.chdir(workspace);
  const who = ["-c", "user.name=A", "-c", "user.email=a@example.com", "-c", "commit.gpgsign=false"];
  git(["init", "-q", "-b", "main"], repo);
  writeFileSync(join(repo, ".gitattributes"), "*.txt diff=pwn filter=pwn\n");
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, "b.txt"), "steady\n");
  git([...who, "add", "-A"], repo);
  git([...who, "commit", "-q", "-m", "one"], repo);
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  git([...who, "commit", "-q", "-am", "two"], repo);

  git(["config", "core.fsmonitor", hook("fsmonitor", "exit 1")], repo);
  git(["config", "diff.pwn.textconv", hook("textconv", 'cat "$1"')], repo);
  git(["config", "diff.pwn.command", hook("extdiff", "exit 0")], repo);
  git(["config", "filter.pwn.clean", hook("filter", "cat")], repo);
  git(["config", "filter.pwn.smudge", hook("filter", "cat")], repo);

  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  const later = new Date(Date.now() + 120_000);
  utimesSync(join(repo, "b.txt"), later, later);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

describe("DiffLint runs no program the repository's config names", () => {
  test("the fixture is live: plain git diff fires the planted programs", () => {
    git(["diff"], repo);
    // The external driver takes precedence over textconv, so ask for textconv alone.
    git(["diff", "--no-ext-diff", "HEAD~1", "HEAD"], repo);
    const labels = new Set(ran().map((line) => line.split(" ")[0]));
    expect([...labels].sort()).toEqual(["extdiff", "filter", "fsmonitor", "textconv"]);
  }, 20_000);

  test("worktree, staged and range diffs lint, and fire nothing", async () => {
    const inputs: ReadonlyArray<Record<string, unknown>> = [
      { cwd: "repo" },
      { cwd: "repo", staged: true },
      { cwd: "repo", range: "HEAD~1..HEAD" },
      { cwd: "repo", ref: "HEAD~1" },
    ];
    let checked = 0;
    for (const input of inputs) {
      rmSync(marker, { force: true });
      const text = String(await diffLint.execute(input));
      const label = JSON.stringify(input);
      expect({ label, ran: ran() }).toEqual({ label, ran: [] });
      const out = JSON.parse(text) as Record<string, unknown>;
      expect({ label, source: String(out["source"]).startsWith("git diff") }).toEqual({
        label,
        source: true,
      });
      checked += 1;
    }
    expect(checked).toBe(4);
    // The worktree diff still sees the change, and says a filter was skipped.
    const worktree = JSON.parse(String(await diffLint.execute({ cwd: "repo" })));
    expect(worktree.addedLinesScanned).toBeGreaterThan(0);
    expect(String(worktree.repoConfigNote)).toContain("filter.pwn");
  }, 30_000);
});

describe("DiffLint runs no program a submodule's config names", () => {
  test("diff.submodule=diff over a submodule with its own diff.external", async () => {
    // The superproject's config asks for inline submodule diffs; git renders
    // one by running a child `git diff` inside the submodule under the
    // submodule's own config, without --no-ext-diff or --no-textconv.
    const who = ["-c", "user.name=A", "-c", "user.email=a@example.com"];
    const src = join(workspace, "subsrc");
    const sup = join(workspace, "sup");
    mkdirSync(src);
    mkdirSync(sup);
    git(["init", "-q", "-b", "main"], src);
    writeFileSync(join(src, "f.txt"), "one\n");
    git([...who, "add", "f.txt"], src);
    git([...who, "commit", "-q", "-m", "one"], src);
    git(["init", "-q", "-b", "main"], sup);
    writeFileSync(join(sup, "top.txt"), "top\n");
    git([...who, "add", "top.txt"], sup);
    git([...who, "commit", "-q", "-m", "top"], sup);
    git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", src, "sub"], sup);
    git([...who, "commit", "-q", "-m", "add sub"], sup);
    writeFileSync(join(sup, "sub", "f.txt"), "two\n");
    git([...who, "commit", "-q", "-am", "two"], join(sup, "sub"));
    git([...who, "commit", "-q", "-am", "bump sub"], sup);
    git(["config", "diff.submodule", "diff"], sup);
    const subConfig = join(sup, ".git", "modules", "sub", "config");
    git(["config", "-f", subConfig, "diff.external", hook("subext", "exit 0")], sup);

    // Live: plain git runs the submodule's program.
    git(["diff", "HEAD~1..HEAD"], sup);
    expect(ran().some((line) => line.startsWith("subext"))).toBe(true);

    let checked = 0;
    for (const input of [
      { cwd: "sup", range: "HEAD~1..HEAD" },
      { cwd: "sup", ref: "HEAD~1" },
    ]) {
      rmSync(marker, { force: true });
      const out = JSON.parse(String(await diffLint.execute(input))) as Record<string, unknown>;
      const label = JSON.stringify(input);
      expect({ label, ran: ran() }).toEqual({ label, ran: [] });
      expect({ label, files: out["filesScanned"] }).toEqual({ label, files: 1 });
      checked += 1;
    }
    expect(checked).toBe(2);
  }, 30_000);
});

describe("DiffLint staged reads the index a commit hook is handed", () => {
  test("GIT_INDEX_FILE inside this repository's git dir is read; one elsewhere is not", async () => {
    // During `git commit -a` a pre-commit hook gets GIT_INDEX_FILE naming a
    // lock file in the git dir: the index being committed. Simulated here
    // with a second index in the same git dir holding a staged line.
    const who = ["-c", "user.name=A", "-c", "user.email=a@example.com"];
    const clean = join(workspace, "clean");
    mkdirSync(clean);
    git(["init", "-q", "-b", "main"], clean);
    writeFileSync(join(clean, "c.js"), "const a = 1;\n");
    git([...who, "add", "c.js"], clean);
    git([...who, "commit", "-q", "-m", "one"], clean);
    writeFileSync(join(clean, "c.js"), "const a = 1;\nconsole.log(a);\n");
    const lockIndex = join(clean, ".git", "next-index-42.lock");
    const staged = Bun.spawnSync(["git", "add", "c.js"], {
      cwd: clean,
      env: { ...process.env, GIT_INDEX_FILE: lockIndex },
    });
    expect(staged.exitCode).toBe(0);
    const prior = process.env["GIT_INDEX_FILE"];
    try {
      process.env["GIT_INDEX_FILE"] = lockIndex;
      const hooked = JSON.parse(String(await diffLint.execute({ cwd: "clean", staged: true })));
      expect(hooked.addedLinesScanned).toBe(1);
      // A GIT_INDEX_FILE outside this repository's git dir is dropped: the
      // repository's own index has nothing staged.
      const elsewhere = join(workspace, "planted-index");
      writeFileSync(elsewhere, readFileSync(lockIndex));
      process.env["GIT_INDEX_FILE"] = elsewhere;
      const planted = JSON.parse(String(await diffLint.execute({ cwd: "clean", staged: true })));
      expect(planted.addedLinesScanned).toBe(0);
    } finally {
      if (prior === undefined) Reflect.deleteProperty(process.env, "GIT_INDEX_FILE");
      else process.env["GIT_INDEX_FILE"] = prior;
    }
  }, 20_000);
});

describe("an embedded repository directory is refused", () => {
  test("a bare repository committed as plain files, then cloned, runs nothing", async () => {
    // The clone-only vector: a real bare repository with two commits, whose
    // config names a textconv and whose info/attributes applies it, is
    // committed into another repository as ordinary files. `git clone`
    // brings it along; running git INSIDE it uses its config.
    const who = [
      "-c",
      "user.name=A",
      "-c",
      "user.email=a@example.com",
      "-c",
      "commit.gpgsign=false",
    ];
    const bare = join(workspace, "bare.git");
    const scratch = join(workspace, "scratch");
    git(["init", "-q", "--bare", "-b", "main", bare], workspace);
    git(["clone", "-q", bare, scratch], workspace);
    for (const n of ["1", "2"]) {
      writeFileSync(join(scratch, "f.txt"), `v${n}\n`);
      git([...who, "add", "-A"], scratch);
      git([...who, "commit", "-q", "-m", `c${n}`], scratch);
    }
    git(["push", "-q", "origin", "main"], scratch);
    mkdirSync(join(bare, "info"), { recursive: true });
    writeFileSync(join(bare, "info", "attributes"), "* diff=pwn\n");
    git(["config", "diff.pwn.textconv", hook("innertc", 'cat "$1"')], bare);

    const outer = join(workspace, "outer");
    mkdirSync(outer);
    git(["init", "-q", "-b", "main"], outer);
    Bun.spawnSync(["cp", "-R", bare, join(outer, "inner.git")]);
    git([...who, "add", "-A"], outer);
    git([...who, "commit", "-q", "-m", "outer"], outer);
    const clone = join(workspace, "clone");
    expect(git(["clone", "-q", "--no-local", outer, clone], workspace)).toBe(0);

    // Live: plain git inside the cloned directory runs the committed textconv.
    rmSync(marker, { force: true });
    git(["diff", "HEAD~1..HEAD"], join(clone, "inner.git"));
    expect(ran().length).toBeGreaterThan(0);

    rmSync(marker, { force: true });
    const text = String(await diffLint.execute({ cwd: "clone/inner.git", range: "HEAD~1..HEAD" }));
    expect(ran()).toEqual([]);
    expect(text).toContain("is a repository directory itself");
  }, 30_000);
});

/**
 * C071 — git diffs the repository it discovers, which a contained `cwd` does
 * not contain: a planted `.git` file names another repository, and a
 * workspace nested in a checkout climbs to it. DiffLint goes through
 * tool-git's check, so both are refused and nothing outside is diffed.
 */
describe("DiffLint diffs only the workspace's own repository", () => {
  test("a planted .git file and an enclosing repository are refused", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-changeset-outside-")));
    const who = [
      "-c",
      "user.name=A",
      "-c",
      "user.email=a@example.com",
      "-c",
      "commit.gpgsign=false",
    ];
    try {
      const victim = join(outside, "victim");
      mkdirSync(victim);
      git(["init", "-q", "-b", "main"], victim);
      writeFileSync(join(victim, "secret.txt"), "one\n");
      git([...who, "add", "-A"], victim);
      git([...who, "commit", "-q", "-m", "one"], victim);
      writeFileSync(join(victim, "secret.txt"), "one\nVICTIM-LINE\n");

      mkdirSync(join(workspace, "planted"));
      writeFileSync(join(workspace, "planted", ".git"), `gitdir: ${victim}/.git\n`);
      const planted = String(await diffLint.execute({ cwd: "planted", ref: "HEAD" }));
      expect(planted).toContain("outside the workspace");
      expect(planted).not.toContain("VICTIM-LINE");

      // The workspace itself nested inside the victim's checkout.
      mkdirSync(join(victim, "harness"));
      process.chdir(join(victim, "harness"));
      const nested = String(await diffLint.execute({ cwd: "." }));
      expect(nested).toContain("outside the workspace");
      expect(nested).not.toContain("VICTIM-LINE");
    } finally {
      process.chdir(originalCwd);
      rmSync(outside, { recursive: true, force: true });
    }
  }, 30_000);
});
