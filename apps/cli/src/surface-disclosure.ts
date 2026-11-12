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
 * `.crewhaus/run` is a runtime-state floor root, relative to the run's
 * working directory: when a run starts in the spec's own directory (as Home
 * and the supervisor start one), no agent write tool can change the record.
 * Only this boot step writes it; the spec commit helper never does, so no
 * writer can clear a disclosure before it is shown.
 *
 * `crewhaus dev` reloads every spec change and is for development; it keeps
 * no record and shows none.
 */
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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

/** The directory the record lives in: `<the spec's real directory>/.crewhaus/run/spec`. */
export function surfaceRecordDir(absSpec: string): string {
  let dir = dirname(absSpec);
  try {
    dir = dirname(realpathSync(absSpec));
  } catch {
    // The spec was read a moment ago; its directory as given will do.
  }
  return join(dir, ".crewhaus", "run", "spec");
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
    return (err as { code?: unknown }).code === "ENOENT" ? undefined : "unreadable";
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

  const previous = readRecord(recordPath);
  if (previous === "unreadable") {
    const reason = `the record of security settings at ${recordPath} could not be read; it is written again from this start`;
    stderr(`crewhaus: warning: ${reason}`);
    save();
    return { kind: "warned", reason };
  }
  if (previous === undefined) {
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
