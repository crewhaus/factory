/**
 * `blame.ignoreRevsFile`, honoured without letting a repository name the file
 * a read opens.
 *
 * The convention: a committed `.git-blame-ignore-revs` lists formatting
 * commits, and `blame.ignoreRevsFile` (the repository's config, or the
 * operator's global config, often as a bare relative name) tells blame to see
 * through them. git itself opens whatever path the config names, anywhere on
 * the disk — a FIFO hangs the read, and a line it cannot parse is echoed back
 * in its error — so every read passes `--no-ignore-revs-file` (see
 * `./hardening`). That also threw the convention away: a reformatted line was
 * attributed to the formatting commit.
 *
 * So this module reads the files itself and hands git a private copy:
 *
 *   - A name that resolves inside the workspace (relative names resolve
 *     against the repository's top level, as git resolves them) is read
 *     through tool-safety's contained reader, whoever's config named it: the
 *     file is the repository's content, so a link out of the workspace, a
 *     FIFO or a device is refused.
 *   - A name outside the workspace is read only when the operator's own
 *     config (global, system, or command-line/environment) named it. The
 *     repository's own config (local, worktree) does not get to choose a file
 *     outside the workspace for a read to open.
 *   - Each file is bounded, and must be what git accepts: full object names,
 *     `#` comments, blank lines. A file that is not is skipped whole (git would
 *     have stopped the blame), and its content is never echoed.
 *   - The object names are written to a fresh private temp file, passed as
 *     `--ignore-revs-file` after `--no-ignore-revs-file`, and removed after
 *     the run. An empty value is skipped, as git does in effect (it keeps the
 *     list sorted, so an empty entry resets nothing).
 *
 * A file that is not honoured is named in the result, never dropped in
 * silence.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { openForRead } from "@crewhaus/tool-safety/fs";
import { readFileBounded } from "@crewhaus/tool-safety/streams";
import { type Repo, firstLine } from "./git-run";
import { isInside, realOrUndefined } from "./repo-bounds";

/** Largest ignore-revs file read; the convention's files are a few kilobytes. */
export const MAX_IGNORE_REVS_BYTES = 1024 * 1024;

/** Config scopes that are the operator's rather than the repository's. */
const OPERATOR_SCOPES: ReadonlySet<string> = new Set(["global", "system", "command"]);

const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export type IgnoreRevs = {
  /** `--ignore-revs-file <private copy>`, or nothing. */
  readonly args: readonly string[];
  /** The config values whose revisions are ignored, as written. */
  readonly honoured: readonly string[];
  /** One sentence per value that was not honoured. */
  readonly notHonoured: readonly string[];
  /** Removes the private copy. Safe to call more than once. */
  readonly cleanup: () => void;
};

const NONE: IgnoreRevs = { args: [], honoured: [], notHonoured: [], cleanup: () => undefined };

/** The `# comment`-stripped object names of one file, or why it is not one. */
export function parseIgnoreRevs(
  text: string,
): { ok: true; names: string[] } | { ok: false; line: number } {
  const names: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    const hash = raw.indexOf("#");
    const entry = (hash === -1 ? raw : raw.slice(0, hash)).trim();
    if (entry === "") continue;
    if (!OBJECT_NAME.test(entry)) return { ok: false, line: i + 1 };
    names.push(entry.toLowerCase());
  }
  return { ok: true, names };
}

type Listed = { readonly scope: string; readonly value: string };

async function listIgnoreRevsFiles(
  repo: Repo,
): Promise<{ ok: true; values: Listed[] } | { ok: false; why: string }> {
  const key = "blame.ignoreRevsFile";
  let withScope = true;
  let probe = await repo.run(["config", "--show-scope", "--null", "--path", "--get-all", key], {
    readOnly: true,
  });
  // 129 is git's usage error: a git older than 2.26 has no --show-scope, and
  // every value is then treated as the repository's own.
  if (probe.code === 129 && /show-scope/.test(probe.stderr)) {
    withScope = false;
    probe = await repo.run(["config", "--null", "--path", "--get-all", key], { readOnly: true });
  }
  if (probe.code === 1 && probe.stdout === "") return { ok: true, values: [] };
  if (probe.code !== 0 || probe.timedOut || probe.truncated) {
    return {
      ok: false,
      why: `${key} could not be listed (${probe.timedOut ? "timed out" : `git exit ${probe.code}: ${firstLine(probe.stderr)}`}), so no revisions are ignored`,
    };
  }
  // NUL-terminated values, each preceded by its NUL-terminated scope.
  const parts = probe.stdout.split("\0");
  if (parts[parts.length - 1] === "") parts.pop();
  const values: Listed[] = [];
  const step = withScope ? 2 : 1;
  for (let i = 0; i + step - 1 < parts.length; i += step) {
    values.push({
      scope: withScope ? (parts[i] as string) : "local",
      value: parts[i + step - 1] as string,
    });
  }
  return { ok: true, values };
}

/**
 * Read every `blame.ignoreRevsFile` the config names, under the rules above,
 * and return the argv that makes git ignore their revisions.
 */
export async function blameIgnoreRevs(repo: Repo): Promise<IgnoreRevs> {
  const listed = await listIgnoreRevsFiles(repo);
  if (!listed.ok) return { ...NONE, notHonoured: [listed.why] };
  if (listed.values.length === 0) return NONE;
  const workspace = realOrUndefined(process.cwd()) ?? path.resolve(process.cwd());

  const honoured: string[] = [];
  const notHonoured: string[] = [];
  const names = new Set<string>();
  for (const { scope, value } of listed.values) {
    if (value === "") continue;
    const shown = JSON.stringify(value);
    const abs = path.isAbsolute(value) ? path.normalize(value) : path.resolve(repo.root, value);
    let text: string;
    if (isInside(workspace, abs)) {
      const read = await openForRead(workspace, abs, { maxBytes: MAX_IGNORE_REVS_BYTES });
      if (!read.ok) {
        notHonoured.push(`blame.ignoreRevsFile ${shown} was not read: ${read.reason}`);
        continue;
      }
      if (read.truncated) {
        notHonoured.push(
          `blame.ignoreRevsFile ${shown} is larger than ${MAX_IGNORE_REVS_BYTES} bytes and was not read`,
        );
        continue;
      }
      text = read.text;
    } else if (OPERATOR_SCOPES.has(scope)) {
      const read = await readFileBounded(abs, { maxBytes: MAX_IGNORE_REVS_BYTES });
      if (!read.ok) {
        notHonoured.push(`blame.ignoreRevsFile ${shown} was not read: ${read.reason}`);
        continue;
      }
      if (read.truncated) {
        notHonoured.push(
          `blame.ignoreRevsFile ${shown} is larger than ${MAX_IGNORE_REVS_BYTES} bytes and was not read`,
        );
        continue;
      }
      text = read.text;
    } else {
      notHonoured.push(
        `blame.ignoreRevsFile ${shown}, set by the repository's own config, names a file outside the workspace; a read does not open a file the repository chooses there`,
      );
      continue;
    }
    const parsed = parseIgnoreRevs(text);
    if (!parsed.ok) {
      notHonoured.push(
        `blame.ignoreRevsFile ${shown} was not used: line ${parsed.line} is not a full object name (git would have stopped the blame there)`,
      );
      continue;
    }
    for (const name of parsed.names) names.add(name);
    honoured.push(value);
  }
  if (names.size === 0) return { ...NONE, honoured, notHonoured };

  const dir = mkdtempSync(path.join(tmpdir(), "crewhaus-blame-"));
  const file = path.join(dir, "ignore-revs");
  try {
    writeFileSync(file, `${[...names].sort().join("\n")}\n`, { flag: "wx", mode: 0o600 });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    return {
      ...NONE,
      notHonoured: [
        ...notHonoured,
        `the ignored revisions could not be handed to git (${(err as Error).message}), so none are ignored`,
      ],
    };
  }
  return {
    args: ["--ignore-revs-file", file],
    honoured,
    notHonoured,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
