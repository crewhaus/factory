/**
 * The one place this package crosses a boundary: asking `git` for a diff.
 *
 * `DiffLint` can be handed diff text directly, and a caller that already has
 * the patch should do exactly that. But the common case is "lint what I am
 * about to commit", and making the caller shell out, capture, and pass a
 * megabyte of patch back through a context window to get an answer about it
 * is the waste the deterministic tools exist to remove. So this module
 * spawns git, under the same two invariants `@crewhaus/tool-git` uses:
 *
 *  1. Containment. The directory git runs in is resolved against the
 *     workspace root and refused if it escapes, symlinks included (see
 *     `./paths`). Pathspecs are checked separately, because git resolves
 *     those itself and would happily walk out of the workspace.
 *  2. Boundedness. Every spawn has a deadline and forwards the caller's abort
 *     signal, and stdout is read under a cap while the pipe keeps draining —
 *     a git whose output nobody reads blocks forever, deadline or no.
 *
 * The spawn itself is tool-git's runner (`@crewhaus/tool-git/run`), not a
 * copy of it. This package used to keep a second copy, and the copy is where
 * a hardening lands last: 0.7.0's lacked even what tool-git had, so a
 * repository's own config (an fsmonitor hook, a textconv, a clean filter) or
 * an embedded bare repository made DiffLint — a read — run a program the
 * repository named (C007). The shared runner switches all of that off for a
 * read and spawns git without the harness's credentials. What is also not
 * copied twice is the diff parser — that one comes from `@crewhaus/tool-text`,
 * because two parsers mean two line numberings and one of them is wrong.
 */
import { statSync } from "node:fs";
import * as path from "node:path";
import {
  bareRefusal,
  locateRepository,
  neutralisedNote,
  probeRepositoryFilters,
  runGit,
} from "@crewhaus/tool-git/run";
import { ToolPermissionError, resolveSafe } from "./paths";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 120_000;
/** Largest patch this package will read, from a spawn or from the caller. */
export const MAX_DIFF_CHARS = 8_000_000;

export type Refusal = { readonly ok: false; readonly message: string };
export type Resolved<T> = { readonly ok: true; readonly value: T } | Refusal;

export const refuse = (message: string): Refusal => ({ ok: false, message });

/** How much of an offending value an error message repeats back. */
const ECHO_CHARS = 80;
const echo = (value: string): string =>
  value.length > ECHO_CHARS ? `${value.slice(0, ECHO_CHARS)}…` : value;

/**
 * Refuse a caller value that git would read as an option rather than as data
 * (CWE-88, argument injection).
 *
 * An argv array keeps a caller away from the shell; it does not keep them
 * away from git's own option parser. `git diff --output=<file>` writes
 * anywhere on the disk, which defeats containment entirely, and no legal
 * revision expression begins with `-`, so refusing the shape costs nothing.
 */
export function checkRefArgs(
  toolName: string,
  values: ReadonlyArray<string | undefined>,
): Refusal | undefined {
  for (const value of values) {
    if (value === undefined) continue;
    if (value.startsWith("-")) {
      return refuse(
        `${toolName} refused "${echo(value)}": a ref or range may not begin with "-", because git would read it as an option rather than as a name.`,
      );
    }
    if (/[\0\n\r]/.test(value)) {
      return refuse(
        `${toolName} refused "${echo(value.replace(/[\0\n\r]/g, "?"))}": a ref may not contain a newline or a NUL — git forbids both in a refname.`,
      );
    }
  }
  return undefined;
}

/**
 * Validate the pathspecs a caller wants to limit the diff to.
 *
 * git resolves a pathspec relative to the directory it runs in, so an
 * absolute one, or one with `..`, reaches outside the workspace without ever
 * passing through `resolveSafe`. A leading `:` is refused too: that is git's
 * pathspec magic, and `:/` means "from the top of the repository".
 */
export function checkPathspecs(
  toolName: string,
  paths: ReadonlyArray<string>,
  cwdAbs: string,
): Refusal | undefined {
  for (const spec of paths) {
    if (spec === "") return refuse(`${toolName} refused an empty path filter.`);
    if (path.isAbsolute(spec) || spec.split(/[\\/]/).includes("..") || spec.startsWith(":")) {
      return refuse(
        `${toolName} refused the path filter "${echo(spec)}": pathspecs must be relative to the working directory, without ".." or git pathspec magic.`,
      );
    }
    try {
      // An absolute path is fine here: `resolveSafe` resolves it as written
      // and then decides containment, which is exactly the question.
      resolveSafe(toolName, path.join(cwdAbs, spec));
    } catch {
      return refuse(
        `${toolName} refused the path filter "${echo(spec)}": it resolves outside the workspace root.`,
      );
    }
  }
  return undefined;
}

export type DiffRequest = {
  readonly cwd?: string;
  readonly ref?: string;
  readonly range?: string;
  readonly staged?: boolean;
  readonly paths?: ReadonlyArray<string>;
  readonly timeout?: number;
};

export type CollectedDiff = {
  readonly diff: string;
  readonly truncated: boolean;
  readonly command: string;
  /**
   * Set when the repository's own config names filter programs, which this
   * read did not run: a filtered file's diff is of its unfiltered bytes.
   */
  readonly repoConfigNote?: string;
};

/**
 * Ask git for the change set, as `-U0` unified diff text.
 *
 * `-U0` because this tool reads added lines and nothing else: context lines
 * are bytes nobody here looks at, and on a large change set they are most of
 * the patch. `--no-ext-diff` (and, from the shared runner, `--no-textconv`
 * and the repository's own filter drivers switched off) because a
 * repository-configured driver is a program the repository names, and a
 * read runs none.
 *
 * Every failure comes back as a sentence, never a throw: a caller mistake —
 * a ref that does not exist, a directory that is not a repository — is normal
 * traffic for this tool, and a model recovers from a sentence.
 */
export async function collectDiff(
  toolName: string,
  request: DiffRequest,
  signal?: AbortSignal,
): Promise<Resolved<CollectedDiff>> {
  if (request.ref !== undefined && request.range !== undefined) {
    return refuse(
      `${toolName} takes either \`ref\` or \`range\`, not both — a range already names both endpoints.`,
    );
  }
  const badRef = checkRefArgs(toolName, [request.ref, request.range]);
  if (badRef !== undefined) return badRef;

  let cwd: string;
  try {
    cwd = resolveSafe(toolName, request.cwd ?? ".").real;
  } catch (err) {
    if (err instanceof ToolPermissionError) {
      return refuse(
        `${toolName} refused the directory "${request.cwd ?? "."}": it resolves outside the workspace root. Pass a path inside the working directory.`,
      );
    }
    throw err;
  }
  let isDir = false;
  try {
    isDir = statSync(cwd).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return refuse(`${toolName} refused "${request.cwd ?? "."}": it is not an existing directory.`);
  }

  const paths = request.paths ?? [];
  const badPath = checkPathspecs(toolName, paths, cwd);
  if (badPath !== undefined) return badPath;

  const args = [
    "diff",
    "--no-ext-diff",
    "-U0",
    ...(request.staged === true ? ["--cached"] : []),
    ...(request.range !== undefined ? [request.range] : []),
    ...(request.ref !== undefined ? [request.ref] : []),
    ...(paths.length > 0 ? ["--", ...paths] : []),
  ];
  const timeoutMs = Math.min(request.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  // git works on the repository it discovers from `cwd`, which can enclose
  // the workspace or be named by a planted .git file: tool-git's check
  // refuses any repository that is not the workspace's (C071).
  const located = await locateRepository(toolName, request.cwd ?? ".", cwd, {
    timeoutMs,
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!located.ok) {
    // DiffLint's own wording for "not a repository" says what to do instead.
    if (/it is not a git repository/.test(located.message)) {
      return refuse(
        `${toolName} refused "${request.cwd ?? "."}": it is not a git repository. Pass \`diff\` text instead, or run from inside a checkout.`,
      );
    }
    return refuse(located.message);
  }
  // The repository's own filter drivers are switched off for this read; a
  // driver git cannot be told to skip refuses the call instead.
  const filters = await probeRepositoryFilters(toolName, cwd, {
    timeoutMs,
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!filters.ok) return refuse(filters.message);
  const run = await runGit(args, {
    cwd,
    timeoutMs,
    readOnly: true,
    maxOutputChars: MAX_DIFF_CHARS,
    ...(filters.value.configArgs.length > 0 ? { configArgs: filters.value.configArgs } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });

  if (run.timedOut) {
    return refuse(
      `${toolName} timed out: \`git ${args.join(" ")}\` did not finish in ${timeoutMs}ms and was killed. Narrow the change set with \`paths\`, or raise \`timeout\`.`,
    );
  }
  if (run.code === 127) return refuse(`${toolName} could not run git. ${run.stderr.trim()}`);
  if (run.code !== 0) {
    const detail = (run.stderr.trim() === "" ? run.stdout : run.stderr).trim();
    // The failures a caller can actually act on are worth naming, because
    // "exit 128" sends them looking for the wrong problem.
    if (/cannot use bare repository/i.test(detail)) {
      return refuse(bareRefusal(toolName, request.cwd ?? "."));
    }
    if (/not a git repository/i.test(detail)) {
      // `git diff` in a repository directory that safe.bareRepository refused
      // falls back to --no-index mode and says only "Not a git repository";
      // ask git which of the two it was, so the refusal names the real reason.
      const probe = await runGit(["rev-parse", "--git-dir"], {
        cwd,
        timeoutMs,
        readOnly: true,
        ...(signal !== undefined ? { signal } : {}),
      });
      if (/cannot use bare repository/i.test(probe.stderr)) {
        return refuse(bareRefusal(toolName, request.cwd ?? "."));
      }
      return refuse(
        `${toolName} refused "${request.cwd ?? "."}": it is not a git repository. Pass \`diff\` text instead, or run from inside a checkout.`,
      );
    }
    if (/unknown revision|bad revision|ambiguous argument/i.test(detail)) {
      return refuse(
        `${toolName} could not resolve ${request.range ?? request.ref ?? "the requested revision"}: ${detail.split("\n")[0] ?? detail}`,
      );
    }
    return refuse(
      `${toolName} failed (git exit ${run.code}): ${detail === "" ? "no output" : detail}`,
    );
  }

  const note = neutralisedNote(filters.value.neutralised);
  return {
    ok: true,
    value: {
      diff: run.stdout,
      truncated: run.truncated,
      command: `git ${args.join(" ")}`,
      ...(note !== undefined ? { repoConfigNote: note } : {}),
    },
  };
}
