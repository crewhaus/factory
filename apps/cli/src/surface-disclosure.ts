/**
 * `crewhaus run` says at start which security settings changed since the
 * last start.
 *
 * The spec's security settings (every row of spec-patch's
 * `SECURITY_SURFACES`: permissions, tools, MCP servers, hooks, the security
 * block, …) are digested one row at a time, and the digests are kept in
 * `.crewhaus/run/spec/surfaces.json` beside the spec. At the next start a row
 * whose digest differs is named on stderr, once, with the file it is in, and
 * never with a value; then the record is refreshed. The run always continues:
 * this is a disclosure, not a gate.
 *
 * The record is on the runtime-state floor, so an agent's file-writing tools
 * are refused there (`Bash` and `RunCommand` stay outside what the floor
 * sees): as part of `.crewhaus/run` when a run starts in the spec's own
 * directory (as Home and the supervisor start one), and, for `crewhaus run`
 * and `crewhaus runs resume`, as the spec directory's `.crewhaus/run/spec`
 * when the spec lives elsewhere ({@link withRunSpecDir}), and for every agent
 * an in-process eval, a change check or `crewhaus serve --mcp` starts, through
 * the loop's `specDir` ({@link runSpecDirOf}).
 * Only this boot step writes it; the spec commit helper never does, so no
 * writer can clear a disclosure before it is shown. A record missing after the spec's commit log
 * has a line is said, and so is one that cannot be read: the changes since
 * the last start cannot be shown then, and the settings are to be reviewed.
 *
 * `crewhaus dev` reloads every spec change and is for development; it keeps
 * no record and shows none.
 */
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runSpecDirScope } from "@crewhaus/runtime-core";
import {
  changedSurfaces,
  parseYamlOnly,
  specRev,
  surfaceDigests,
} from "@crewhaus/spec-patch/commit";
import { writeFileSafe } from "@crewhaus/tool-safety/fs";

export type SurfaceRecord = {
  readonly v: 1;
  readonly at: string;
  readonly specRevision: string;
  readonly surfaces: Readonly<Record<string, string>>;
};

export type DiscloseOptions = {
  /** Writes the record; default: atomically, `0600`, beside the spec. */
  readonly write?: (dir: string, text: string) => void;
  readonly now?: () => Date;
  readonly stderr?: (line: string) => void;
};

export type DisclosureOutcome =
  | { readonly kind: "recorded" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "changed"; readonly rows: ReadonlyArray<string> }
  | { readonly kind: "warned"; readonly reason: string };

/** A record is small; one past this is not ours. */
const MAX_RECORD_BYTES = 1024 * 1024;

/**
 * The spec's real directory: the directory of the file a link to the spec
 * points at, or the spec's directory as given when its real path cannot be read.
 * The record's location, `crewhaus run` and every in-process eval derive it here.
 */
export function runSpecDirOf(absSpec: string): string {
  try {
    return dirname(realpathSync(absSpec));
  } catch {
    // The spec was read a moment ago; its directory as given will do.
    return dirname(absSpec);
  }
}

/** The directory the record lives in: `<the spec's real directory>/.crewhaus/run/spec`. */
export function surfaceRecordDir(absSpec: string): string {
  return join(runSpecDirOf(absSpec), ".crewhaus", "run", "spec");
}

function defaultWrite(dir: string, text: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const written = writeFileSafe(dir, "surfaces.json", text, { overwrite: true, mode: 0o600 });
  if (!written.ok) throw new Error(written.reason);
}

function readRecord(path: string): SurfaceRecord | undefined | "unreadable" {
  let size: number;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return "unreadable";
    size = stat.size;
  } catch (err) {
    // No file, or no directory for one: there is no record.
    const code = (err as { code?: unknown }).code;
    return code === "ENOENT" || code === "ENOTDIR" ? undefined : "unreadable";
  }
  if (size > MAX_RECORD_BYTES) return "unreadable";
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SurfaceRecord>;
    const surfaces = parsed.surfaces;
    if (parsed.v !== 1 || typeof surfaces !== "object" || surfaces === null) return "unreadable";
    for (const value of Object.values(surfaces)) if (typeof value !== "string") return "unreadable";
    return parsed as SurfaceRecord;
  } catch {
    return "unreadable";
  }
}

/** Whether the spec's commit log beside the record holds at least one complete line. */
function hasCommitLine(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return false;
    return /^[^\n]*\S[^\n]*\n/m.test(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Run `fn` with the spec's real directory as the run's spec directory, so the
 * spec's own record (`<spec dir>/.crewhaus/run/spec`) is on the runtime-state
 * floor for the whole run when the spec lives outside the working directory.
 */
export function withRunSpecDir<T>(absSpec: string, fn: () => T): T {
  return runSpecDirScope.run(runSpecDirOf(absSpec), fn);
}

/**
 * Compare the spec's security settings with the record kept at the last
 * start, print one line naming the rows that changed, and refresh the record.
 * Never throws and never stops the run.
 */
export function discloseSurfaceChange(
  absSpec: string,
  yamlText: string,
  opts: DiscloseOptions = {},
): DisclosureOutcome {
  const stderr = opts.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const write = opts.write ?? defaultWrite;
  const now = opts.now ?? (() => new Date());
  const dir = surfaceRecordDir(absSpec);
  const recordPath = join(dir, "surfaces.json");
  let surfaces: Record<string, string>;
  try {
    surfaces = surfaceDigests(parseYamlOnly(yamlText));
  } catch (err) {
    const reason = `could not read the security settings of ${basename(absSpec)}: ${(err as Error).message}`;
    stderr(`crewhaus: warning: ${reason}`);
    return { kind: "warned", reason };
  }
  const record: SurfaceRecord = {
    v: 1,
    at: now().toISOString(),
    specRevision: specRev(yamlText),
    surfaces,
  };
  const save = (): string | undefined => {
    try {
      write(dir, `${JSON.stringify(record, null, 2)}\n`);
      return undefined;
    } catch (err) {
      return (err as Error).message;
    }
  };

  const review = `Review the security settings in ${basename(absSpec)} before you rely on this run.`;
  const saveOrSay = (): void => {
    const failed = save();
    if (failed !== undefined) {
      stderr(
        `crewhaus: warning: the record of security settings could not be written to ${recordPath}: ${failed}`,
      );
    }
  };
  const previous = readRecord(recordPath);
  if (previous === "unreadable") {
    const reason = `the record of security settings at ${recordPath} could not be read, so the changes since the last start can't be shown`;
    stderr(`crewhaus: warning: ${reason}. ${review}`);
    saveOrSay();
    return { kind: "warned", reason };
  }
  if (previous === undefined) {
    if (hasCommitLine(join(dir, "commits.jsonl"))) {
      const reason = `the record of security settings at ${recordPath} is missing although ${basename(absSpec)} has been changed since it was first recorded, so the changes since the last start can't be shown`;
      stderr(`crewhaus: warning: ${reason}. ${review}`);
      saveOrSay();
      return { kind: "warned", reason };
    }
    const failed = save();
    if (failed === undefined) return { kind: "recorded" };
    const reason = `the record of security settings could not be written to ${recordPath}: ${failed}`;
    stderr(`crewhaus: warning: ${reason}`);
    return { kind: "warned", reason };
  }
  const rows = changedSurfaces(previous.surfaces, surfaces);
  if (rows.length === 0) return { kind: "unchanged" };
  stderr(
    `crewhaus: security settings in ${basename(absSpec)} changed since the last start: ${rows.join(", ")}. Review them before you rely on this run.`,
  );
  const failed = save();
  if (failed !== undefined) {
    stderr(
      `crewhaus: warning: the record of security settings could not be written to ${recordPath}: ${failed}`,
    );
  }
  return { kind: "changed", rows };
}
