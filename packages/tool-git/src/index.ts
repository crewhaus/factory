/**
 * @crewhaus/tool-git — deterministic git tools over a real repository.
 *
 * Every tool here shells out to the `git` binary; none of them reimplements
 * git. Determinism means the same inputs against the same repository state
 * produce the same bytes: no unseeded randomness, no wall-clock in the output
 * unless the caller asked for it (`GitCommit`'s `date`), no unordered listings,
 * and no locale-dependent comparison — paths and refs are ordered with plain
 * `<`, and git itself runs under `LC_ALL=C`.
 *
 * Three rules run through the whole file:
 *
 *   - Containment. Every caller-supplied path — the `cwd`, a pathspec, a new
 *     worktree's location — is resolved against the workspace root and refused
 *     if it escapes, symlinks included. See `./git-run`.
 *   - Boundedness. Every invocation carries a deadline and forwards the
 *     caller's abort signal; every result is capped with an explicit note.
 *   - Machine-stable formats. Where a tool parses git's output it asks for the
 *     format git documents for scripts (`--porcelain=v2`, `for-each-ref`,
 *     `--line-porcelain`, NUL-delimited custom formats) rather than scraping
 *     the human-facing text. `./lib/parse` says why for each one.
 *
 * Nothing here talks to a remote: there is no push, pull or fetch, because
 * those need network credentials and belong in their own package.
 */
import * as nodePath from "node:path";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  checkPathspecs,
  checkRefArgs,
  failure,
  json,
  openRepo,
  resolveInsideRoot,
  truncationNote,
} from "./git-run";
import {
  COMMIT_FORMAT,
  REF_FORMAT,
  STASH_FORMAT,
  TAG_FORMAT,
  locateConflicts,
  parseBatchCheck,
  parseBlamePorcelain,
  parseCommits,
  parseNumstat,
  parseRefs,
  parseRemotes,
  parseStashes,
  parseStatusV2,
  parseTags,
  parseWorktrees,
  splitNul,
} from "./lib/parse";

// ---------------------------------------------------------------------------
// shared schema fragments and flag sets

const cwdField = z
  .string()
  .optional()
  .describe("directory inside the workspace to run git in; defaults to the working directory");

const timeoutField = z
  .number()
  .int()
  .positive()
  .max(MAX_TIMEOUT_MS)
  .optional()
  .describe(`milliseconds before git is killed; default ${DEFAULT_TIMEOUT_MS}`);

const pathsField = z
  .array(z.string().min(1))
  .max(256)
  .optional()
  .describe("limit to these paths, relative to `cwd`");

/**
 * Safety flags for a tool that only interrogates the repository. Reading still
 * spawns a process, so `scope`/`ioCapability` say so; `concurrencySafe` is
 * honest because these runs also set GIT_OPTIONAL_LOCKS=0 and so never contend
 * for the index lock with a sibling.
 */
const READ_FLAGS = {
  readOnly: true,
  concurrencySafe: true,
  scope: "external",
  ioCapability: "process",
} as const;

/**
 * Safety flags for a tool that changes the repository. Never concurrency-safe:
 * two of these racing on one index or worktree is exactly the failure mode the
 * flag exists to prevent.
 */
const WRITE_FLAGS = {
  destructive: true,
  concurrencySafe: false,
  scope: "external",
  ioCapability: "process",
} as const;

/** Largest patch `GitApplyPatch` will accept, so one call cannot be unbounded. */
const MAX_PATCH_CHARS = 4_000_000;
/** Largest conflicted file `GitConflicts` will read looking for markers. */
const MAX_CONFLICT_FILE_BYTES = 2_000_000;

// ---------------------------------------------------------------------------
// read tools

export const gitStatus: RegisteredTool = buildTool({
  name: "GitStatus",
  operativeArgs: [{ field: "cwd", kind: "path", default: "." }],
  description:
    "Report the working tree's state as structured JSON: branch, upstream, ahead/behind counts, and the staged, unstaged, untracked and conflicted paths. Use it instead of reading `git status` prose, and instead of guessing whether there is anything to commit.",
  inputSchema: z.object({
    cwd: cwdField,
    timeout: timeoutField,
    untracked: z
      .enum(["all", "normal", "no"])
      .optional()
      .describe("how much untracked detail to include; default 'all'"),
    includeIgnored: z.boolean().optional(),
  }),
  ...READ_FLAGS,
  execute: async (input, ctx) => {
    const opened = await openRepo("GitStatus", input, ctx?.signal);
    if (!opened.ok) return opened.message;
    const run = await opened.value.run(
      [
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        `--untracked-files=${input.untracked ?? "all"}`,
        ...(input.includeIgnored === true ? ["--ignored=matching"] : []),
      ],
      { readOnly: true },
    );
    if (run.code !== 0) return failure("GitStatus", run);
    return json(parseStatusV2(run.stdout));
  },
});

export const gitDiff: RegisteredTool = buildTool({
  name: "GitDiff",
  operativeArgs: [{ field: "paths", kind: "path", within: "cwd", default: "." }],
  description:
    "Diff the working tree, the index, a ref or a commit range, as a summary, per-file line counts, a name list or a full patch. Use it to see exactly what a change touched before staging, committing or reviewing it.",
  inputSchema: z.object({
    cwd: cwdField,
    timeout: timeoutField,
    mode: z
      .enum(["stat", "numstat", "nameOnly", "patch"])
      .optional()
      .describe("default 'stat'; ask for 'patch' only when the hunks matter"),
    ref: z.string().min(1).optional().describe("compare against this single ref"),
    range: z.string().min(1).optional().describe("a commit range such as 'main..HEAD' or 'a...b'"),
    staged: z.boolean().optional().describe("diff the index against HEAD instead of the worktree"),
    paths: pathsField,
    context: z.number().int().min(0).max(20).optional().describe("patch context lines"),
  }),
  ...READ_FLAGS,
  execute: async (input, ctx) => {
    if (input.ref !== undefined && input.range !== undefined) {
      return "GitDiff takes either `ref` or `range`, not both — a range already names both endpoints.";
    }
    const opened = await openRepo("GitDiff", input, ctx?.signal);
    if (!opened.ok) return opened.message;
    const repo = opened.value;
    const paths = input.paths ?? [];
    const checked = checkPathspecs("GitDiff", paths, repo.cwd);
    if (!checked.ok) return checked.message;
    const bad = checkRefArgs("GitDiff", [input.ref, input.range]);
    if (bad !== undefined) return bad.message;

    const mode = input.mode ?? "stat";
    const modeArgs: Record<typeof mode, string[]> = {
      stat: ["--stat"],
      // -z on these two turns off git's path quoting, so a path with a space
      // or a non-ASCII byte survives intact; see lib/parse.
      numstat: ["--numstat", "-z"],
      nameOnly: ["--name-only", "-z"],
      patch: ["--patch"],
    };
    const args = [
      "diff",
      // An external diff driver configured in the repo could print anything at
      // all, which would make this tool's output depend on local config.
      "--no-ext-diff",
      ...modeArgs[mode],
      ...(input.context !== undefined ? [`-U${input.context}`] : []),
      ...(input.staged === true ? ["--cached"] : []),
      ...(input.range !== undefined ? [input.range] : []),
      ...(input.ref !== undefined ? [input.ref] : []),
      ...(paths.length > 0 ? ["--", ...paths] : []),
    ];
    const run = await repo.run(args, { readOnly: true });
    if (run.code !== 0) return failure("GitDiff", run);
    const note = truncationNote(run);

    if (mode === "numstat") {
      const files = parseNumstat(run.stdout);
      const added = files.reduce((sum, f) => sum + (f.added ?? 0), 0);
      const removed = files.reduce((sum, f) => sum + (f.removed ?? 0), 0);
      return json({ mode, files: files.length, added, removed, changes: files, note });
    }
    if (mode === "nameOnly") {
      const files = splitNul(run.stdout).sort();
      return json({ mode, files: files.length, paths: files, note });
    }
    const body = run.stdout.replace(/\n+$/, "");
    return json({ mode, empty: body === "", [mode === "patch" ? "patch" : "stat"]: body, note });
  },
});

export const gitLog: RegisteredTool = buildTool({
  name: "GitLog",
  operativeArgs: [{ field: "paths", kind: "path", within: "cwd", default: "." }],
  description:
    "List commits as structured records — sha, author, ISO dates, subject and body — filtered by range, path, author or count. Use it to answer what changed and when without parsing `git log`'s free-form text.",
  inputSchema: z.object({
    cwd: cwdField,
    timeout: timeoutField,
    range: z
      .string()
      .min(1)
      .optional()
      .describe("a revision or range, e.g. 'HEAD', 'main..HEAD', 'v1.0..v1.1'"),
    paths: pathsField,
    author: z.string().min(1).optional().describe("substring match on author name or email"),
    maxCount: z.number().int().positive().max(1000).optional().describe("default 20"),
    merges: z.enum(["include", "only", "exclude"]).optional(),
  }),
  ...READ_FLAGS,
  execute: async (input, ctx) => {
    const opened = await openRepo("GitLog", input, ctx?.signal);
    if (!opened.ok) return opened.message;
    const repo = opened.value;
    const paths = input.paths ?? [];
    const checked = checkPathspecs("GitLog", paths, repo.cwd);
    if (!checked.ok) return checked.message;
    const bad = checkRefArgs("GitLog", [input.range]);
    if (bad !== undefined) return bad.message;

    const merges = input.merges ?? "include";
    const run = await repo.run(
      [
        "log",
        `--format=${COMMIT_FORMAT}`,
        `--max-count=${input.maxCount ?? 20}`,
        ...(merges === "only" ? ["--merges"] : merges === "exclude" ? ["--no-merges"] : []),
        ...(input.author !== undefined ? [`--author=${input.author}`] : []),
        ...(input.range !== undefined ? [input.range] : []),
        ...(paths.length > 0 ? ["--", ...paths] : []),
      ],
      { readOnly: true },
    );
    if (run.code !== 0) return failure("GitLog", run);
    const commits = parseCommits(run.stdout);
    return json({ count: commits.length, commits, note: truncationNote(run) });
  },
});

export const gitShow: RegisteredTool = buildTool({
  name: "GitShow",
  operativeArgs: [{ field: "path", kind: "path", within: "cwd", default: "." }],
  description:
    "Return one file's contents at a ref, or one commit's metadata and patch. Use it to read a file as it was on another branch without checking that branch out.",
  inputSchema: z.object({
    cwd: cwdField,
    timeout: timeoutField,
    ref: z.string().min(1).optional().describe("default 'HEAD'"),
    path: z
      .string()
      .min(1)
      .optional()
      .describe("when set, return this file's contents at `ref` instead of the commit"),
    patch: z.boolean().optional().describe("include the commit's patch; default true"),
  }),
  ...READ_FLAGS,
  execute: async (input, ctx) => {
    const opened = await openRepo("GitShow", input, ctx?.signal);
    if (!opened.ok) return opened.message;
    const repo = opened.value;
    const ref = input.ref ?? "HEAD";
    const bad = checkRefArgs("GitShow", [input.ref]);
    if (bad !== undefined) return bad.message;

    if (input.path !== undefined) {
      const checked = checkPathspecs("GitShow", [input.path], repo.cwd);
      if (!checked.ok) return checked.message;
      // "<rev>:./<path>" is git's spelling for "relative to the current
      // directory"; the bare "<rev>:<path>" form is relative to the repo root
      // and would quietly read a different file when cwd is a subdirectory.
      const run = await repo.run(["show", `${ref}:./${input.path}`], { readOnly: true });
      if (run.code !== 0) return failure("GitShow", run);
      return json({
        ref,
        path: input.path,
        content: run.stdout,
        note: truncationNote(run),
      });
    }

    const meta = await repo.run(["show", "--no-patch", `--format=${COMMIT_FORMAT}`, ref], {
      readOnly: true,
    });
    if (meta.code !== 0) return failure("GitShow", meta);
    const commit = parseCommits(meta.stdout)[0];
    if (commit === undefined) return `GitShow could not read a commit from "${ref}".`;
    if (input.patch === false) return json({ commit });

    const patch = await repo.run(["show", "--no-ext-diff", "--patch", "--format=", ref], {
      readOnly: true,
    });
    if (patch.code !== 0) return failure("GitShow", patch);
    return json({
      commit,
      patch: patch.stdout.replace(/^\n+/, "").replace(/\n+$/, ""),
      note: truncationNote(patch),
    });
  },
});

export const gitBlame: RegisteredTool = buildTool({
  name: "GitBlame",
  operativeArgs: [{ field: "path", kind: "path", within: "cwd" }],
  description:
    "Attribute each line of a file to the commit that last touched it, as structured records rather than blame's column-aligned text. Use it to find who and what introduced a specific line before changing or reverting it.",
  inputSchema: z.object({
    cwd: cwdField,
    timeout: timeoutField,
    path: z.string().min(1),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    ref: z.string().min(1).optional().describe("blame the file as of this ref"),
    maxLines: z.number().int().positive().max(5000).optional().describe("default 500"),
  }),
  ...READ_FLAGS,
  execute: async (input, ctx) => {
    const opened = await openRepo("GitBlame", input, ctx?.signal);
    if (!opened.ok) return opened.message;
    const repo = opened.value;
    const checked = checkPathspecs("GitBlame", [input.path], repo.cwd);
    if (!checked.ok) return checked.message;
    const bad = checkRefArgs("GitBlame", [input.ref]);
    if (bad !== undefined) return bad.message;
    if (
      input.startLine !== undefined &&
      input.endLine !== undefined &&
      input.endLine < input.startLine
    ) {
      return `GitBlame was given endLine ${input.endLine} before startLine ${input.startLine} — pass a range that runs forwards.`;
    }
    const range =
      input.startLine === undefined
        ? []
        : ["-L", `${input.startLine},${input.endLine ?? input.startLine}`];
    const run = await repo.run(
      [
        "blame",
        "--line-porcelain",
        ...range,
        ...(input.ref !== undefined ? [input.ref] : []),
        "--",
        input.path,
      ],
      { readOnly: true },
    );
    if (run.code !== 0) return failure("GitBlame", run);
    const all = parseBlamePorcelain(run.stdout);
    const max = input.maxLines ?? 500;
    const lines = all.slice(0, max);
    return json({
      path: input.path,
      count: lines.length,
      truncated: all.length > max || run.truncated,
      lines,
    });
  },
});

export const gitBranchList: RegisteredTool = buildTool({
  name: "GitBranchList",
  operativeArgs: [{ field: "cwd", kind: "path", default: "." }],
  description:
    "List branches with their tip sha, upstream, last-commit date and subject, sorted by refname. Use it to find the right branch name before switching, diffing or deleting.",
  inputSchema: z.object({
    cwd: cwdField,
    timeout: timeoutField,
    remote: z.boolean().optional().describe("also list remote-tracking branches"),
    contains: z.string().min(1).optional().describe("only branches containing this commit"),
    maxCount: z.number().int().positive().max(2000).optional().describe("default 200"),
  }),
  ...READ_FLAGS,
  execute: async (input, ctx) => {
    const opened = await openRepo("GitBranchList", input, ctx?.signal);
    if (!opened.ok) return opened.message;
    const repo = opened.value;
    const bad = checkRefArgs("GitBranchList", [input.contains]);
    if (bad !== undefined) return bad.message;
    const run = await repo.run(
      [
        "for-each-ref",
        `--format=${REF_FORMAT}`,
        ...(input.contains !== undefined ? ["--contains", input.contains] : []),
        "refs/heads",
        ...(input.remote === true ? ["refs/remotes"] : []),
      ],
      { readOnly: true },
    );
    if (run.code !== 0) return failure("GitBranchList", run);
    const head = await repo.run(["rev-parse", "--abbrev-ref", "HEAD"], { readOnly: true });
    const all = parseRefs(run.stdout).sort((a, b) =>
      a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0,
    );
    const max = input.maxCount ?? 200;
    const currentName = head.code === 0 ? head.stdout.trim() : "";
    return json({
      current: currentName === "HEAD" || currentName === "" ? null : currentName,
      count: all.length,
      truncated: all.length > max,
      branches: all.slice(0, max),
    });
  },
});

export const gitTagList: RegisteredTool = buildTool({
  name: "GitTagList",
  operativeArgs: [{ field: "cwd", kind: "path", default: "." }],
  description:
    "List tags with the commit each points at, whether it is annotated, its date and its message subject. Use it to find the previous release tag before generating notes or diffing two versions.",
  inputSchema: z.object({
    cwd: cwdField,
    timeout: timeoutField,
    pattern: z.string().min(1).optional().describe("a ref glob such as 'v1.*'"),
    sort: z
      .enum(["refname", "version"])
      .optional()
      .describe("'version' orders v2 after v10 correctly; default 'refname'"),
    maxCount: z.number().int().positive().max(2000).optional().describe("default 200"),
  }),
  ...READ_FLAGS,
  execute: async (input, ctx) => {
    const opened = await openRepo("GitTagList", input, ctx?.signal);
    if (!opened.ok) return opened.message;
    const run = await opened.value.run(
      [
        "for-each-ref",
        `--format=${TAG_FORMAT}`,
        // Sorting is asked of git explicitly rather than left to the default,
        // so the order never depends on the repo's versionsort config.
        input.sort === "version" ? "--sort=v:refname" : "--sort=refname",
        input.pattern === undefined ? "refs/tags" : `refs/tags/${input.pattern}`,
      ],
      { readOnly: true },
    );
    if (run.code !== 0) return failure("GitTagList", run);
    const all = parseTags(run.stdout);
    const max = input.maxCount ?? 200;
    return json({ count: all.length, truncated: all.length > max, tags: all.slice(0, max) });
  },
});

export const gitRemoteList: RegisteredTool = buildTool({
  name: "GitRemoteList",
  operativeArgs: [{ field: "cwd", kind: "path", default: "." }],
  description:
    "List the repository's configured remotes with their fetch and push URLs, sorted by name. Use it to learn where a checkout came from; it reads local config only and never contacts a remote.",
  inputSchema: z.object({ cwd: cwdField, timeout: timeoutField }),
  ...READ_FLAGS,
  execute: async (input, ctx) => {
    const opened = await openRepo("GitRemoteList", input, ctx?.signal);
    if (!opened.ok) return opened.message;
    const run = await opened.value.run(["remote", "-v"], { readOnly: true });
    if (run.code !== 0) return failure("GitRemoteList", run);
    const remotes = parseRemotes(run.stdout);
    return json({ count: remotes.length, remotes });
  },
});

export const gitMergeBase: RegisteredTool = buildTool({
  name: "GitMergeBase",
  operativeArgs: [{ field: "cwd", kind: "path", default: "." }],
  description:
    "Find the best common ancestor of two refs, or the fork point of a branch from its upstream. Use it to scope a review or a diff to only the commits a branch actually added.",
  inputSchema: z.object({
    cwd: cwdField,
    timeout: timeoutField,
    a: z.string().min(1).describe("the first ref, or the branch when using forkPoint"),
    b: z.string().min(1).optional().describe("the second ref; omit only with forkPoint"),
    forkPoint: z
      .boolean()
      .optional()
      .describe("use the reflog to find where `a` diverged, surviving upstream rebases"),
  }),
  ...READ_FLAGS,
  execute: async (input, ctx) => {
    if (input.forkPoint !== true && input.b === undefined) {
      return "GitMergeBase needs two refs: pass `b`, or set `forkPoint: true` to find where `a` diverged from its upstream.";
    }
    const opened = await openRepo("GitMergeBase", input, ctx?.signal);
    if (!opened.ok) return opened.message;
    const bad = checkRefArgs("GitMergeBase", [input.a, input.b]);
    if (bad !== undefined) return bad.message;
    const args =
      input.forkPoint === true
        ? ["merge-base", "--fork-point", input.a, ...(input.b !== undefined ? [input.b] : [])]
        : ["merge-base", input.a, input.b as string];
    const run = await opened.value.run(args, { readOnly: true });
    // Exit 1 is git's documented "these refs share no ancestor", which is an
    // answer rather than an error, so it gets a structured result of its own.
    if (run.code === 1) {
      return json({ found: false, a: input.a, b: input.b ?? null, mergeBase: null });
    }
    if (run.code !== 0) return failure("GitMergeBase", run);
    return json({
      found: true,
      a: input.a,
      b: input.b ?? null,
      forkPoint: input.forkPoint === true,
      mergeBase: run.stdout.trim(),
    });
  },
});

export const gitRevParse: RegisteredTool = buildTool({
  name: "GitRevParse",
  operativeArgs: [{ field: "cwd", kind: "path", default: "." }],
  description:
    "Resolve refs to object shas and types, and report the repository's root, git directory and current HEAD. Use it to turn a name like 'HEAD~3' or 'v1.2' into a stable sha before passing it to another tool.",
  inputSchema: z.object({
    cwd: cwdField,
    timeout: timeoutField,
    refs: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe("revisions to resolve; omit for repository info only"),
  }),
  ...READ_FLAGS,
  execute: async (input, ctx) => {
    const opened = await openRepo("GitRevParse", input, ctx?.signal);
    if (!opened.ok) return opened.message;
    const repo = opened.value;
    const gitDir = await repo.run(["rev-parse", "--absolute-git-dir"], { readOnly: true });
    const head = await repo.run(["rev-parse", "--abbrev-ref", "HEAD"], { readOnly: true });
    const branch = head.code === 0 ? head.stdout.trim() : "";
    const info = {
      root: repo.root,
      gitDir: gitDir.code === 0 ? gitDir.stdout.trim() : null,
      branch: branch === "HEAD" || branch === "" ? null : branch,
      detached: branch === "HEAD",
    };
    const refs = input.refs ?? [];
    if (refs.length === 0) return json({ ...info, objects: [] });
    // These go to `cat-file` on stdin, one per line, and the answers are
    // matched back to them by position — so a ref carrying a newline would
    // shift every later answer onto the wrong ref.
    const bad = checkRefArgs("GitRevParse", refs);
    if (bad !== undefined) return bad.message;

    // One `cat-file --batch-check` resolves every ref in a single spawn, and an
    // unknown ref comes back as its own "missing" line instead of failing the
    // whole batch the way `git rev-parse` would.
    const run = await repo.run(["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
      readOnly: true,
      stdin: `${refs.join("\n")}\n`,
    });
    if (run.code !== 0 && run.stdout === "") return failure("GitRevParse", run);
    return json({ ...info, objects: parseBatchCheck(run.stdout, refs) });
  },
});

export const gitFileHistory: RegisteredTool = buildTool({
  name: "GitFileHistory",
  operativeArgs: [{ field: "path", kind: "path", within: "cwd" }],
  description:
    "List the commits that touched one path, following it across renames, with the per-commit change status. Use it to trace how a single file reached its current shape, including what it used to be called.",
  inputSchema: z.object({
    cwd: cwdField,
    timeout: timeoutField,
    path: z.string().min(1).describe("exactly one path; --follow cannot track more"),
    maxCount: z.number().int().positive().max(1000).optional().describe("default 20"),
  }),
  ...READ_FLAGS,
  execute: async (input, ctx) => {
    const opened = await openRepo("GitFileHistory", input, ctx?.signal);
    if (!opened.ok) return opened.message;
    const repo = opened.value;
    const checked = checkPathspecs("GitFileHistory", [input.path], repo.cwd);
    if (!checked.ok) return checked.message;
    const run = await repo.run(
      [
        "log",
        "--follow",
        "--name-status",
        `--format=${COMMIT_FORMAT}`,
        `--max-count=${input.maxCount ?? 20}`,
        "--",
        input.path,
      ],
      { readOnly: true },
    );
    if (run.code !== 0) return failure("GitFileHistory", run);
    const commits = parseCommits(run.stdout, true);
    const names = new Set<string>([input.path]);
    for (const commit of commits) {
      for (const change of commit.changes ?? []) {
        names.add(change.path);
        if (change.from !== undefined) names.add(change.from);
      }
    }
    return json({
      path: input.path,
      count: commits.length,
      knownPaths: [...names].sort(),
      commits,
      note: truncationNote(run),
    });
  },
});

export const gitStashList: RegisteredTool = buildTool({
  name: "GitStashList",
  operativeArgs: [{ field: "cwd", kind: "path", default: "." }],
  description:
    "List the stash entries with their ref, sha, message and date. Use it to see what is parked before popping anything, since a stash stack is shared across every worktree of a repository.",
  inputSchema: z.object({
    cwd: cwdField,
    timeout: timeoutField,
    maxCount: z.number().int().positive().max(500).optional().describe("default 50"),
  }),
  ...READ_FLAGS,
  execute: async (input, ctx) => {
    const opened = await openRepo("GitStashList", input, ctx?.signal);
    if (!opened.ok) return opened.message;
    const run = await opened.value.run(
      ["stash", "list", `--format=${STASH_FORMAT}`, `--max-count=${input.maxCount ?? 50}`],
      { readOnly: true },
    );
    if (run.code !== 0) return failure("GitStashList", run);
    const stashes = parseStashes(run.stdout);
    return json({ count: stashes.length, stashes });
  },
});

export const gitConflicts: RegisteredTool = buildTool({
  name: "GitConflicts",
  operativeArgs: [{ field: "cwd", kind: "path", default: "." }],
  description:
    "List the currently conflicted paths and locate the conflict markers inside each one, by line number. Use it after a merge, rebase or cherry-pick stops, to go straight to the regions that need a decision.",
  inputSchema: z.object({
    cwd: cwdField,
    timeout: timeoutField,
    maxFiles: z.number().int().positive().max(500).optional().describe("default 50"),
  }),
  ...READ_FLAGS,
  execute: async (input, ctx) => {
    const opened = await openRepo("GitConflicts", input, ctx?.signal);
    if (!opened.ok) return opened.message;
    const repo = opened.value;
    // --diff-filter=U is the unmerged-entry filter; -z keeps paths unquoted.
    const run = await repo.run(["diff", "--name-only", "--diff-filter=U", "-z"], {
      readOnly: true,
    });
    if (run.code !== 0) return failure("GitConflicts", run);
    const paths = splitNul(run.stdout).sort();
    const max = input.maxFiles ?? 50;
    const files: Array<Record<string, unknown>> = [];
    for (const rel of paths.slice(0, max)) {
      // git prints these relative to the repository root, not to cwd.
      const inside = resolveInsideRoot("GitConflicts", nodePath.join(repo.root, rel));
      if (!inside.ok) return inside.message;
      // Size is checked before the read, not after: reading a multi-gigabyte
      // file into memory only to decide it was too large is the same defect as
      // having no limit at all.
      const file = Bun.file(inside.value);
      const bytes = file.size;
      if (bytes > MAX_CONFLICT_FILE_BYTES) {
        files.push({ path: rel, tooLarge: true, bytes, regions: [] });
        continue;
      }
      let text: string;
      try {
        text = await file.text();
      } catch {
        files.push({ path: rel, unreadable: true, regions: [] });
        continue;
      }
      files.push({ path: rel, regions: locateConflicts(text) });
    }
    return json({
      conflicted: paths.length,
      truncated: paths.length > max,
      clean: paths.length === 0,
      files,
    });
  },
});

export const gitWorktreeList: RegisteredTool = buildTool({
  name: "GitWorktreeList",
  operativeArgs: [{ field: "cwd", kind: "path", default: "." }],
  description:
    "List the repository's worktrees with their path, HEAD, branch and locked or prunable state, sorted by path. Use it before adding or removing one, since git refuses to check the same branch out twice.",
  inputSchema: z.object({ cwd: cwdField, timeout: timeoutField }),
  ...READ_FLAGS,
  execute: async (input, ctx) => {
    const opened = await openRepo("GitWorktreeList", input, ctx?.signal);
    if (!opened.ok) return opened.message;
    const run = await opened.value.run(["worktree", "list", "--porcelain"], { readOnly: true });
    if (run.code !== 0) return failure("GitWorktreeList", run);
    const worktrees = parseWorktrees(run.stdout);
    return json({ count: worktrees.length, worktrees });
  },
});

// ---------------------------------------------------------------------------
// write tools

export const gitAdd: RegisteredTool = buildTool({
  name: "GitAdd",
  operativeArgs: [{ field: "paths", kind: "path", within: "cwd", default: "." }],
  description:
    "Stage the named paths. Use it to build a commit deliberately, one path at a time; there is no way to stage the whole tree blindly, which is the point.",
  inputSchema: z.object({
    cwd: cwdField,
    timeout: timeoutField,
    paths: z
      .array(z.string().min(1))
      .min(1)
      .max(256)
      .describe("paths relative to `cwd`; directories are staged recursively"),
    update: z.boolean().optional().describe("stage only paths git already tracks, never new files"),
  }),
  ...WRITE_FLAGS,
  execute: async (input, ctx) => {
    const opened = await openRepo("GitAdd", input, ctx?.signal);
    if (!opened.ok) return opened.message;
    const repo = opened.value;
    const checked = checkPathspecs("GitAdd", input.paths, repo.cwd);
    if (!checked.ok) return checked.message;
    const run = await repo.run([
      "add",
      ...(input.update === true ? ["--update"] : []),
      "--",
      ...input.paths,
    ]);
    if (run.code !== 0) return failure("GitAdd", run);
    const staged = await repo.run(["diff", "--cached", "--numstat", "-z"], { readOnly: true });
    return json({
      staged: input.paths,
      stagedFiles: staged.code === 0 ? parseNumstat(staged.stdout).length : null,
    });
  },
});

export const gitCommit: RegisteredTool = buildTool({
  name: "GitCommit",
  operativeArgs: [{ field: "paths", kind: "path", within: "cwd", default: "." }],
  description:
    "Commit what is staged, or only the named paths, with a message and an optional author and date. Use it to record a change; it never amends unless `amend` is set explicitly, so an existing commit is never rewritten by accident.",
  inputSchema: z.object({
    cwd: cwdField,
    timeout: timeoutField,
    message: z.string().min(1),
    author: z
      .string()
      .min(1)
      .optional()
      .describe("'Name <email>' overriding the configured author"),
    date: z
      .string()
      .min(1)
      .optional()
      .describe(
        "author and committer date, e.g. '2026-01-01T00:00:00Z' — set it to make the resulting sha reproducible",
      ),
    paths: pathsField,
    allowEmpty: z.boolean().optional(),
    amend: z
      .boolean()
      .optional()
      .describe("REWRITES the previous commit; off unless you explicitly ask for it"),
  }),
  ...WRITE_FLAGS,
  execute: async (input, ctx) => {
    const opened = await openRepo("GitCommit", input, ctx?.signal);
    if (!opened.ok) return opened.message;
    const repo = opened.value;
    const paths = input.paths ?? [];
    const checked = checkPathspecs("GitCommit", paths, repo.cwd);
    if (!checked.ok) return checked.message;
    // The only wall-clock in this package's output, and only when asked for:
    // pinning both dates is what makes a commit's sha reproducible.
    const env: Record<string, string> = {};
    if (input.date !== undefined) {
      env["GIT_AUTHOR_DATE"] = input.date;
      env["GIT_COMMITTER_DATE"] = input.date;
    }
    const run = await repo.run(
      [
        "commit",
        "-m",
        input.message,
        ...(input.amend === true ? ["--amend", "--no-edit"] : []),
        ...(input.allowEmpty === true ? ["--allow-empty"] : []),
        ...(input.author !== undefined ? [`--author=${input.author}`] : []),
        ...(paths.length > 0 ? ["--", ...paths] : []),
      ],
      { env },
    );
    if (run.code !== 0) return failure("GitCommit", run);
    const meta = await repo.run(["log", "-1", `--format=${COMMIT_FORMAT}`], { readOnly: true });
    const commit = meta.code === 0 ? (parseCommits(meta.stdout)[0] ?? null) : null;
    return json({ committed: true, amended: input.amend === true, commit });
  },
});

export const gitSwitch: RegisteredTool = buildTool({
  name: "GitSwitch",
  operativeArgs: [
    { field: "cwd", kind: "path" },
    { field: "branch", kind: "id" },
  ],
  description:
    "Switch the worktree to another branch, optionally creating it or detaching HEAD at a ref. Use it to move between branches; git refuses and changes nothing when the switch would discard uncommitted work.",
  inputSchema: z.object({
    cwd: cwdField,
    timeout: timeoutField,
    branch: z.string().min(1).describe("the branch to switch to, or the ref when detaching"),
    create: z.boolean().optional().describe("create the branch first"),
    startPoint: z.string().min(1).optional().describe("where a newly created branch starts"),
    detach: z.boolean().optional().describe("check the ref out with a detached HEAD"),
  }),
  ...WRITE_FLAGS,
  execute: async (input, ctx) => {
    if (input.create === true && input.detach === true) {
      return "GitSwitch cannot both create a branch and detach HEAD — pick one.";
    }
    const opened = await openRepo("GitSwitch", input, ctx?.signal);
    if (!opened.ok) return opened.message;
    const bad = checkRefArgs("GitSwitch", [input.branch, input.startPoint]);
    if (bad !== undefined) return bad.message;
    const repo = opened.value;
    const run = await repo.run([
      "switch",
      ...(input.create === true ? ["-c"] : []),
      ...(input.detach === true ? ["--detach"] : []),
      input.branch,
      ...(input.startPoint !== undefined ? [input.startPoint] : []),
    ]);
    if (run.code !== 0) return failure("GitSwitch", run);
    const head = await repo.run(["rev-parse", "HEAD"], { readOnly: true });
    const name = await repo.run(["rev-parse", "--abbrev-ref", "HEAD"], { readOnly: true });
    const current = name.code === 0 ? name.stdout.trim() : "";
    return json({
      switched: true,
      branch: current === "HEAD" ? null : current,
      detached: current === "HEAD",
      head: head.code === 0 ? head.stdout.trim() : null,
    });
  },
});

export const gitBranchCreate: RegisteredTool = buildTool({
  name: "GitBranchCreate",
  operativeArgs: [
    { field: "cwd", kind: "path" },
    { field: "name", kind: "id" },
  ],
  description:
    "Create a branch at HEAD or at a given start point, without switching to it. Use it to mark a base or open a line of work while staying where you are.",
  inputSchema: z.object({
    cwd: cwdField,
    timeout: timeoutField,
    name: z.string().min(1),
    startPoint: z.string().min(1).optional().describe("default HEAD"),
    force: z.boolean().optional().describe("move the branch if it already exists"),
  }),
  ...WRITE_FLAGS,
  execute: async (input, ctx) => {
    const opened = await openRepo("GitBranchCreate", input, ctx?.signal);
    if (!opened.ok) return opened.message;
    const bad = checkRefArgs("GitBranchCreate", [input.name, input.startPoint]);
    if (bad !== undefined) return bad.message;
    const repo = opened.value;
    const run = await repo.run([
      "branch",
      ...(input.force === true ? ["--force"] : []),
      input.name,
      ...(input.startPoint !== undefined ? [input.startPoint] : []),
    ]);
    if (run.code !== 0) return failure("GitBranchCreate", run);
    const tip = await repo.run(["rev-parse", input.name], { readOnly: true });
    return json({
      created: input.name,
      sha: tip.code === 0 ? tip.stdout.trim() : null,
      startPoint: input.startPoint ?? "HEAD",
    });
  },
});

export const gitBranchDelete: RegisteredTool = buildTool({
  name: "GitBranchDelete",
  operativeArgs: [
    { field: "cwd", kind: "path" },
    { field: "name", kind: "id" },
  ],
  description:
    "Delete a local branch, refusing by default if it holds commits that are not merged anywhere. Use `force` only when you mean to discard those commits, since nothing but the reflog will remember them.",
  inputSchema: z.object({
    cwd: cwdField,
    timeout: timeoutField,
    name: z.string().min(1),
    force: z.boolean().optional().describe("delete even when the branch is not merged"),
  }),
  ...WRITE_FLAGS,
  execute: async (input, ctx) => {
    const opened = await openRepo("GitBranchDelete", input, ctx?.signal);
    if (!opened.ok) return opened.message;
    const bad = checkRefArgs("GitBranchDelete", [input.name]);
    if (bad !== undefined) return bad.message;
    const repo = opened.value;
    // Capture the tip first: after the delete, the sha is the only way back.
    const tip = await repo.run(["rev-parse", input.name], { readOnly: true });
    const run = await repo.run([
      "branch",
      "--delete",
      ...(input.force === true ? ["--force"] : []),
      input.name,
    ]);
    if (run.code !== 0) return failure("GitBranchDelete", run);
    return json({
      deleted: input.name,
      wasAt: tip.code === 0 ? tip.stdout.trim() : null,
      forced: input.force === true,
      note: "recover with GitBranchCreate at `wasAt` while the object is still reachable",
    });
  },
});

export const gitStashPush: RegisteredTool = buildTool({
  name: "GitStashPush",
  operativeArgs: [{ field: "paths", kind: "path", within: "cwd", default: "." }],
  description:
    "Park the current changes on the stash stack with a message. Use a message always: the stack is shared by every worktree of the repository, so an unlabelled entry is hard to claim later.",
  inputSchema: z.object({
    cwd: cwdField,
    timeout: timeoutField,
    message: z.string().min(1).optional(),
    includeUntracked: z.boolean().optional(),
    keepIndex: z.boolean().optional().describe("leave the staged changes staged"),
    paths: pathsField,
  }),
  ...WRITE_FLAGS,
  execute: async (input, ctx) => {
    const opened = await openRepo("GitStashPush", input, ctx?.signal);
    if (!opened.ok) return opened.message;
    const repo = opened.value;
    const paths = input.paths ?? [];
    const checked = checkPathspecs("GitStashPush", paths, repo.cwd);
    if (!checked.ok) return checked.message;
    const run = await repo.run([
      "stash",
      "push",
      ...(input.includeUntracked === true ? ["--include-untracked"] : []),
      ...(input.keepIndex === true ? ["--keep-index"] : []),
      ...(input.message !== undefined ? ["-m", input.message] : []),
      ...(paths.length > 0 ? ["--", ...paths] : []),
    ]);
    if (run.code !== 0) return failure("GitStashPush", run);
    const list = await repo.run(["stash", "list", `--format=${STASH_FORMAT}`, "--max-count=1"], {
      readOnly: true,
    });
    return json({
      pushed: !run.stdout.includes("No local changes to save"),
      message: run.stdout.trim(),
      top: list.code === 0 ? (parseStashes(list.stdout)[0] ?? null) : null,
    });
  },
});

export const gitStashPop: RegisteredTool = buildTool({
  name: "GitStashPop",
  operativeArgs: [{ field: "cwd", kind: "path", default: "." }],
  description:
    "Restore a stash entry onto the working tree, dropping it unless `apply` is set. Use an explicit `stash` ref whenever other worktrees share this repository, so you never take an entry that is not yours.",
  inputSchema: z.object({
    cwd: cwdField,
    timeout: timeoutField,
    stash: z
      .string()
      .min(1)
      .optional()
      .describe("an entry such as 'stash@{2}'; defaults to the top of the stack"),
    apply: z.boolean().optional().describe("keep the entry on the stack instead of dropping it"),
  }),
  ...WRITE_FLAGS,
  execute: async (input, ctx) => {
    // Only the stash@{n} spelling is accepted: a free-form revision here would
    // let a caller reach objects that have nothing to do with the stash stack.
    if (input.stash !== undefined && input.stash.match(/^stash@\{\d+\}$/) === null) {
      return `GitStashPop refused the ref "${input.stash}": pass an entry in the form stash@{0}, as listed by GitStashList.`;
    }
    const opened = await openRepo("GitStashPop", input, ctx?.signal);
    if (!opened.ok) return opened.message;
    const repo = opened.value;
    const run = await repo.run([
      "stash",
      input.apply === true ? "apply" : "pop",
      ...(input.stash !== undefined ? [input.stash] : []),
    ]);
    if (run.code !== 0) return failure("GitStashPop", run);
    return json({
      restored: input.stash ?? "stash@{0}",
      dropped: input.apply !== true,
      output: run.stdout.trim(),
    });
  },
});

export const gitTagCreate: RegisteredTool = buildTool({
  name: "GitTagCreate",
  operativeArgs: [
    { field: "cwd", kind: "path" },
    { field: "name", kind: "id" },
  ],
  description:
    "Create a lightweight or annotated tag at HEAD or a given ref. Use an annotated tag (pass `message`) for anything a release refers to, since only those carry a date and an author.",
  inputSchema: z.object({
    cwd: cwdField,
    timeout: timeoutField,
    name: z.string().min(1),
    ref: z.string().min(1).optional().describe("default HEAD"),
    message: z.string().min(1).optional().describe("makes the tag annotated"),
    force: z.boolean().optional().describe("move the tag if it already exists"),
  }),
  ...WRITE_FLAGS,
  execute: async (input, ctx) => {
    const opened = await openRepo("GitTagCreate", input, ctx?.signal);
    if (!opened.ok) return opened.message;
    const bad = checkRefArgs("GitTagCreate", [input.name, input.ref]);
    if (bad !== undefined) return bad.message;
    const repo = opened.value;
    const run = await repo.run([
      "tag",
      ...(input.force === true ? ["--force"] : []),
      ...(input.message !== undefined ? ["--annotate", "-m", input.message] : []),
      input.name,
      ...(input.ref !== undefined ? [input.ref] : []),
    ]);
    if (run.code !== 0) return failure("GitTagCreate", run);
    const at = await repo.run(["rev-parse", `${input.name}^{commit}`], { readOnly: true });
    return json({
      created: input.name,
      annotated: input.message !== undefined,
      commit: at.code === 0 ? at.stdout.trim() : null,
    });
  },
});

export const gitApplyPatch: RegisteredTool = buildTool({
  name: "GitApplyPatch",
  operativeArgs: [{ field: "cwd", kind: "path", default: "." }],
  description:
    "Apply a unified diff to the working tree, optionally to the index as well. Use `check: true` first to find out whether a patch applies cleanly without changing anything.",
  inputSchema: z.object({
    cwd: cwdField,
    timeout: timeoutField,
    patch: z.string().min(1).max(MAX_PATCH_CHARS).describe("the unified diff text"),
    check: z.boolean().optional().describe("report whether it would apply, and change nothing"),
    index: z.boolean().optional().describe("apply to the index as well as the worktree"),
    threeWay: z.boolean().optional().describe("fall back to a three-way merge on conflict"),
    strip: z.number().int().min(0).max(10).optional().describe("leading path components to drop"),
  }),
  ...WRITE_FLAGS,
  execute: async (input, ctx) => {
    const opened = await openRepo("GitApplyPatch", input, ctx?.signal);
    if (!opened.ok) return opened.message;
    const repo = opened.value;
    // `--unsafe-paths` is deliberately never passed: without it git refuses a
    // patch whose paths leave the working tree, which is the containment rule
    // of this package enforced by git itself.
    // A unified diff must end in a newline; a patch that reached us through a
    // model or a JSON field very often has had it stripped, and git answers
    // that with "corrupt patch at line N" rather than anything actionable.
    const patchText = input.patch.endsWith("\n") ? input.patch : `${input.patch}\n`;
    const run = await repo.run(
      [
        "apply",
        ...(input.check === true ? ["--check"] : []),
        ...(input.index === true ? ["--index"] : []),
        ...(input.threeWay === true ? ["--3way"] : []),
        ...(input.strip !== undefined ? [`-p${input.strip}`] : []),
        "-",
      ],
      { stdin: patchText },
    );
    if (run.code !== 0) {
      return json({
        applied: false,
        checkedOnly: input.check === true,
        reason: failure("GitApplyPatch", run),
      });
    }
    return json({
      applied: input.check !== true,
      checkedOnly: input.check === true,
      wouldApply: true,
    });
  },
});

export const gitCherryPick: RegisteredTool = buildTool({
  name: "GitCherryPick",
  operativeArgs: [{ field: "cwd", kind: "path", default: "." }],
  description:
    "Replay one or more commits onto the current branch. Use `noCommit` to stage the change without committing, and GitConflicts when the pick stops partway.",
  inputSchema: z.object({
    cwd: cwdField,
    timeout: timeoutField,
    refs: z.array(z.string().min(1)).min(1).max(50).describe("commits, applied in the order given"),
    noCommit: z.boolean().optional().describe("apply and stage, but do not commit"),
    mainline: z
      .number()
      .int()
      .min(1)
      .max(16)
      .optional()
      .describe("which parent to treat as mainline when picking a merge commit"),
  }),
  ...WRITE_FLAGS,
  execute: async (input, ctx) => {
    const opened = await openRepo("GitCherryPick", input, ctx?.signal);
    if (!opened.ok) return opened.message;
    const bad = checkRefArgs("GitCherryPick", input.refs);
    if (bad !== undefined) return bad.message;
    const repo = opened.value;
    const run = await repo.run([
      "cherry-pick",
      ...(input.noCommit === true ? ["--no-commit"] : []),
      ...(input.mainline !== undefined ? ["--mainline", String(input.mainline)] : []),
      ...input.refs,
    ]);
    if (run.code !== 0) {
      const conflicted = await repo.run(["diff", "--name-only", "--diff-filter=U", "-z"], {
        readOnly: true,
      });
      return json({
        picked: false,
        reason: failure("GitCherryPick", run),
        conflicted: conflicted.code === 0 ? splitNul(conflicted.stdout).sort() : [],
        next: "resolve with GitConflicts, then `git cherry-pick --continue`, or abort it",
      });
    }
    const head = await repo.run(["rev-parse", "HEAD"], { readOnly: true });
    return json({
      picked: true,
      refs: input.refs,
      head: head.code === 0 ? head.stdout.trim() : null,
    });
  },
});

export const gitResetPaths: RegisteredTool = buildTool({
  name: "GitResetPaths",
  operativeArgs: [{ field: "paths", kind: "path", within: "cwd" }],
  description:
    "Unstage the named paths, restoring their index entries from a ref without touching the files on disk. Use it to undo a GitAdd; this package has no whole-tree reset, so no call here can discard your edits.",
  inputSchema: z.object({
    cwd: cwdField,
    timeout: timeoutField,
    paths: z.array(z.string().min(1)).min(1).max(256).describe("paths to unstage"),
    ref: z
      .string()
      .min(1)
      .optional()
      .describe("the ref to restore index entries from; default HEAD"),
  }),
  ...WRITE_FLAGS,
  execute: async (input, ctx) => {
    const opened = await openRepo("GitResetPaths", input, ctx?.signal);
    if (!opened.ok) return opened.message;
    const repo = opened.value;
    const checked = checkPathspecs("GitResetPaths", input.paths, repo.cwd);
    if (!checked.ok) return checked.message;
    const bad = checkRefArgs("GitResetPaths", [input.ref]);
    if (bad !== undefined) return bad.message;
    // A pathspec is always present, and `git reset <ref> -- <paths>` only ever
    // rewrites index entries. `--hard` is not reachable from this schema at
    // all: there is no flag for it and no branch that could add it, which is
    // why unstaging here can never cost a caller their working-tree changes.
    const run = await repo.run(["reset", "--quiet", input.ref ?? "HEAD", "--", ...input.paths]);
    if (run.code !== 0) return failure("GitResetPaths", run);
    return json({ unstaged: input.paths, from: input.ref ?? "HEAD", worktreeUntouched: true });
  },
});

export const gitWorktreeAdd: RegisteredTool = buildTool({
  name: "GitWorktreeAdd",
  operativeArgs: [{ field: "path", kind: "path" }],
  description:
    "Create an additional worktree inside the workspace, checked out at a ref or on a new branch. Use it to work on two branches at once without stashing; the path must be inside the working directory.",
  inputSchema: z.object({
    cwd: cwdField,
    timeout: timeoutField,
    path: z.string().min(1).describe("where to create it, relative to the working directory"),
    ref: z.string().min(1).optional().describe("what to check out; default HEAD"),
    createBranch: z.string().min(1).optional().describe("create this branch for the worktree"),
    detach: z.boolean().optional().describe("check `ref` out with a detached HEAD"),
  }),
  ...WRITE_FLAGS,
  execute: async (input, ctx) => {
    if (input.createBranch !== undefined && input.detach === true) {
      return "GitWorktreeAdd cannot both create a branch and detach HEAD — pick one.";
    }
    const opened = await openRepo("GitWorktreeAdd", input, ctx?.signal);
    if (!opened.ok) return opened.message;
    const bad = checkRefArgs("GitWorktreeAdd", [input.ref, input.createBranch]);
    if (bad !== undefined) return bad.message;
    const repo = opened.value;
    const target = resolveInsideRoot("GitWorktreeAdd", input.path);
    if (!target.ok) return target.message;
    const run = await repo.run([
      "worktree",
      "add",
      ...(input.createBranch !== undefined ? ["-b", input.createBranch] : []),
      ...(input.detach === true ? ["--detach"] : []),
      target.value,
      ...(input.ref !== undefined ? [input.ref] : []),
    ]);
    if (run.code !== 0) return failure("GitWorktreeAdd", run);
    return json({
      added: target.value,
      branch: input.createBranch ?? null,
      ref: input.ref ?? "HEAD",
    });
  },
});

export const gitWorktreeRemove: RegisteredTool = buildTool({
  name: "GitWorktreeRemove",
  operativeArgs: [{ field: "path", kind: "path" }],
  description:
    "Remove a worktree and its administrative entry. Use `force` only when you accept losing whatever is uncommitted there, because git otherwise refuses a dirty worktree for exactly that reason.",
  inputSchema: z.object({
    cwd: cwdField,
    timeout: timeoutField,
    path: z.string().min(1).describe("the worktree to remove, relative to the working directory"),
    force: z.boolean().optional().describe("remove even when it has uncommitted changes"),
  }),
  ...WRITE_FLAGS,
  execute: async (input, ctx) => {
    const opened = await openRepo("GitWorktreeRemove", input, ctx?.signal);
    if (!opened.ok) return opened.message;
    const repo = opened.value;
    const target = resolveInsideRoot("GitWorktreeRemove", input.path);
    if (!target.ok) return target.message;
    const run = await repo.run([
      "worktree",
      "remove",
      ...(input.force === true ? ["--force"] : []),
      target.value,
    ]);
    if (run.code !== 0) return failure("GitWorktreeRemove", run);
    return json({ removed: target.value, forced: input.force === true });
  },
});

// ---------------------------------------------------------------------------

/** Every tool this package registers, in the order a catalog should list them. */
export const GIT_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
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
]);
