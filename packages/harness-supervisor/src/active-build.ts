/**
 * Whether the build on disk is the one a person activated. Every automatic start (a crash
 * restart, a start whose compile `manager.autoCompile` decided, reboot recovery) runs only
 * a build whose digest is the active deployment's; otherwise it stays stopped with the
 * reason.
 */
import { join, relative } from "node:path";
import { type LedgerRecord, readDeployments } from "@crewhaus/control-records";
import { bundleDigest } from "@crewhaus/ir/policy";
import { type BuildArtifact, collectBuildFiles, linkEntriesOf } from "./build-inputs";
import { resolveBundle } from "./spawn-contracts";

/** Shown when the build on disk is not the active deployment's. */
export const BUILD_NOT_ACTIVE_MESSAGE =
  "The build in dist/ isn't the active deployment. Activate it, or restore the active build.";

/** Shown when no deployment is active and the start was automatic. */
export const NO_ACTIVE_BUILD_MESSAGE =
  "No build is active here yet. Start it once, or run crewhaus deploy activate.";

/** Shown when no deployment is active and a person started it from Home or a group. */
export const NO_ACTIVE_BUILD_ACTIVATE_MESSAGE =
  "No build is active here yet. Activate this build, or run crewhaus deploy activate.";

/** Shown when an automatic start of a launch that runs the saved spec finds it is not the
 *  active deployment's. */
export const SPEC_NOT_ACTIVE_MESSAGE =
  "The saved spec isn't the active deployment's. Activate it, or restore the active spec.";

/** Shown when a build's files hold a link: a build runs from regular files only. */
export function buildLinkMessage(path: string): string {
  return `The build holds a link at ${path}. A build runs from regular files only: replace it with the file, then run crewhaus compile and crewhaus deploy activate.`;
}

/**
 * The refusal for a build whose files hold a link, naming the first; undefined when it holds
 * none, or when its files cannot be read (the digest says so).
 *
 * First consumers: `verifyActiveBuild`, the deployment a start records and compile's record.
 */
export function buildLinkRefusal(harnessDir: string, artifact: BuildArtifact): string | undefined {
  const files = collectBuildFiles(harnessDir, artifact);
  if (!Array.isArray(files)) return undefined;
  const [first] = linkEntriesOf(files);
  return first === undefined ? undefined : buildLinkMessage(first);
}

/** The entry a launch runs, posix, relative to the harness: what a record's `entry` names. */
export function launchedEntryOf(harnessDir: string, bundleDir: string, entry: string): string {
  return relative(harnessDir, join(bundleDir, entry)).split("\\").join("/");
}

/** The entry a target's launch resolves to, or undefined when no bundle is found. */
export function resolvedEntryOf(harnessDir: string, target: string): string | undefined {
  const bundle = resolveBundle(harnessDir, target);
  return bundle === undefined
    ? undefined
    : launchedEntryOf(harnessDir, bundle.bundleDir, bundle.entry);
}

export type ActiveDeployment = {
  readonly id: string;
  readonly specHash?: string;
  readonly digest: string;
  readonly record: LedgerRecord;
};

export type ActiveBuildCheck =
  | { readonly ok: true; readonly deployment: ActiveDeployment }
  | {
      readonly ok: false;
      readonly reason: "no-active" | "mismatch" | "unreadable" | "link";
      readonly message: string;
    };

/** The artifact of a deployment record, when it has the fields a check reads. */
export function artifactOf(
  record: LedgerRecord,
): (BuildArtifact & { readonly digest: string; readonly specHash?: string }) | undefined {
  const artifact = record["artifact"];
  if (typeof artifact !== "object" || artifact === null) return undefined;
  const a = artifact as Record<string, unknown>;
  if (typeof a["digest"] !== "string" || typeof a["entry"] !== "string") return undefined;
  const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
  const files = strings(a["files"]);
  const bootInputs = strings(a["bootInputs"]);
  return {
    digest: a["digest"],
    entry: a["entry"],
    ...(typeof a["specHash"] === "string" ? { specHash: a["specHash"] } : {}),
    ...(files !== undefined ? { files } : {}),
    ...(bootInputs !== undefined ? { bootInputs } : {}),
  };
}

/** The active deployment, read-only, without checking the build. */
export function activeDeployment(harnessDir: string): ActiveDeployment | undefined {
  const read = readDeployments(harnessDir);
  if (read.state !== "present" || read.active === undefined) return undefined;
  const artifact = artifactOf(read.active);
  if (artifact === undefined) return undefined;
  return {
    id: String(read.active["id"]),
    ...(artifact.specHash !== undefined ? { specHash: artifact.specHash } : {}),
    digest: artifact.digest,
    record: read.active,
  };
}

/**
 * Is the build on disk the active deployment's, and is it the build the launch runs? Reads
 * only. The launch's entry is `launchedEntry` when the caller holds its plan, else the one
 * the target's bundle resolves to; it must be the entry the record names. A build whose
 * files hold a link is refused with reason `link`, naming it.
 *
 * First consumers: the supervisor's automatic starts and `manager.autoCompile`; reboot
 * recovery next.
 */
export function verifyActiveBuild(
  harnessDir: string,
  target?: string,
  launchedEntry?: string,
): ActiveBuildCheck {
  const read = readDeployments(harnessDir);
  if (read.state === "unreadable") {
    return {
      ok: false,
      reason: "unreadable",
      message: `The deployment records can't be read (${read.reason}), so nothing starts automatically.`,
    };
  }
  if (read.state === "absent" || read.active === undefined) {
    return { ok: false, reason: "no-active", message: NO_ACTIVE_BUILD_MESSAGE };
  }
  const artifact = artifactOf(read.active);
  if (artifact === undefined) {
    return {
      ok: false,
      reason: "unreadable",
      message: "The active deployment record names no build, so nothing starts automatically.",
    };
  }
  const launched =
    launchedEntry ?? (target !== undefined ? resolvedEntryOf(harnessDir, target) : undefined);
  if (target !== undefined || launchedEntry !== undefined) {
    if (launched !== artifact.entry) {
      return { ok: false, reason: "mismatch", message: BUILD_NOT_ACTIVE_MESSAGE };
    }
  }
  const files = collectBuildFiles(harnessDir, artifact);
  if (!Array.isArray(files)) {
    return {
      ok: false,
      reason: "unreadable",
      message: `The build can't be read (${files.unreadable}), so nothing starts automatically.`,
    };
  }
  const [link] = linkEntriesOf(files);
  if (link !== undefined) return { ok: false, reason: "link", message: buildLinkMessage(link) };
  if (bundleDigest(files) !== artifact.digest) {
    return { ok: false, reason: "mismatch", message: BUILD_NOT_ACTIVE_MESSAGE };
  }
  return {
    ok: true,
    deployment: {
      id: String(read.active["id"]),
      ...(artifact.specHash !== undefined ? { specHash: artifact.specHash } : {}),
      digest: artifact.digest,
      record: read.active,
    },
  };
}
