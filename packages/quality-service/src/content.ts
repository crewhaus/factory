/**
 * A change's content, read back only as it was recorded.
 *
 * A change row keeps a keyed digest of its patch (`patchDigest`) over the change's kind,
 * the file it was proposed against, the proposed file and the three paths `patch.json`
 * names (spec, graders, dataset). Every use of the content re-reads the files under
 * `.crewhaus/proposals/<chg>/`, recomputes that digest and refuses on any difference, so
 * what a check measures, what a decision binds and what adoption or rollback writes are
 * the same bytes. The evidence a check wrote is read back the same way, against the
 * row's `evidenceDigest`.
 *
 * Every read here is contained to the harness (realpath, `relative()`), and the paths in
 * `patch.json` must be relative and stay inside the harness.
 */
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { specRevision } from "@crewhaus/ir/policy";
import { openForReadSync } from "@crewhaus/tool-safety/fs";
import { EVIDENCE_DIGEST_LABEL, PATCH_DIGEST_LABEL, digestKeyOf, keyedJsonDigest } from "./digests";
import { type ChangeRow, MAX_CONTENT_BYTES, readChangeContent } from "./store";

/** The machine-readable patch a change keeps (`patch.json`). */
export type ChangePatch = {
  readonly v: 1;
  readonly kind: "spec" | "graders" | "dataset";
  /** The spec file, relative to the harness. */
  readonly spec: string;
  /** The graders file, relative to the harness. */
  readonly graders: string;
  /** The dataset the check runs on: `registry:<name>[@version]` or a file. */
  readonly dataset: string;
  /** The revision of the file the change edits, when it was proposed. */
  readonly baseRevision: string;
  readonly diff?: ReadonlyArray<unknown>;
  readonly provenance?: Readonly<Record<string, unknown>>;
};

/** The revision of a file's text as a change records it. */
export function fileRevision(kind: ChangePatch["kind"], text: string): string {
  return kind === "spec" ? specRevision(text) : textRevision(text);
}

/** sha256 of raw text as a revision (`crewhaus criteria apply --expect`). */
export function textRevision(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** The content file that holds a change's proposed text. */
export function candidateNameOf(
  kind: ChangePatch["kind"],
): "proposed.yaml" | "graders.yaml" | "cases.jsonl" {
  return kind === "spec" ? "proposed.yaml" : kind === "graders" ? "graders.yaml" : "cases.jsonl";
}

/** What the patch digest covers. */
export function patchDigestPayload(args: {
  readonly kind: ChangePatch["kind"];
  readonly base: string;
  readonly candidate: string;
  readonly spec: string;
  readonly graders: string;
  readonly dataset: string;
}): Record<string, string> {
  return {
    kind: args.kind,
    base: args.base,
    candidate: args.candidate,
    spec: args.spec,
    graders: args.graders,
    dataset: args.dataset,
  };
}

/** A path relative to the harness that stays inside it, by `relative()`. */
export function containedRel(harnessDir: string, rel: string): boolean {
  if (rel === "" || isAbsolute(rel)) return false;
  const back = relative(resolve(harnessDir), resolve(harnessDir, rel));
  return back !== "" && !back.startsWith("..") && !isAbsolute(back);
}

/** Whether a patch's spec, graders and (file) dataset all name paths inside the harness. */
export function targetsContained(
  harnessDir: string,
  targets: { readonly spec: string; readonly graders: string; readonly dataset: string },
): boolean {
  return (
    containedRel(harnessDir, targets.spec) &&
    containedRel(harnessDir, targets.graders) &&
    (targets.dataset.startsWith("registry:") || containedRel(harnessDir, targets.dataset))
  );
}

/** Read a harness file whole, contained to the harness; `undefined` when it cannot be. */
export function readHarnessText(harnessDir: string, rel: string): string | undefined {
  if (!containedRel(harnessDir, rel)) return undefined;
  const read = openForReadSync(harnessDir, rel, { maxBytes: MAX_CONTENT_BYTES });
  if (!read.ok || read.truncated) return undefined;
  return read.text;
}

/** `patch.json`'s text as a patch, or `undefined` when it is not one. */
export function parsePatch(text: string | undefined): ChangePatch | undefined {
  if (text === undefined) return undefined;
  try {
    const v = JSON.parse(text) as ChangePatch;
    if (
      v?.v === 1 &&
      (v.kind === "spec" || v.kind === "graders" || v.kind === "dataset") &&
      typeof v.spec === "string" &&
      typeof v.graders === "string" &&
      typeof v.dataset === "string" &&
      typeof v.baseRevision === "string"
    ) {
      return v;
    }
  } catch {
    // not a patch
  }
  return undefined;
}

/** A change's content, as its row recorded it. */
export type VerifiedContent = {
  readonly patch: ChangePatch;
  readonly baseText: string;
  readonly candidateText: string;
};

export type VerifyContentAnswer =
  | { readonly ok: true; readonly content: VerifiedContent }
  | { readonly ok: false; readonly code: "missing" | "binding-changed"; readonly reason: string };

const changed = (what: string): VerifyContentAnswer => ({
  ok: false,
  code: "binding-changed",
  reason: `${what} is not what this change recorded, so nothing was done; propose the change again`,
});

/**
 * Read a change's patch, base and proposed file and check them against its row: the
 * patch is the row's kind and names paths inside the harness, the base is the revision
 * the row records, and the keyed digest over all of it is the row's `patchDigest`.
 */
export async function verifyContent(
  harnessDir: string,
  row: ChangeRow,
): Promise<VerifyContentAnswer> {
  const patch = parsePatch(readChangeContent(harnessDir, row.id, "patch.json"));
  if (patch === undefined) {
    return {
      ok: false,
      code: "missing",
      reason: "the change's patch.json is missing or unreadable",
    };
  }
  if (patch.kind !== row.kind || patch.baseRevision !== row.base.revision) {
    return changed("the change's patch.json");
  }
  if (!targetsContained(harnessDir, patch)) return changed("the change's patch.json");
  const baseText = readChangeContent(harnessDir, row.id, "base.yaml");
  const candidateName = candidateNameOf(patch.kind);
  const candidateText = readChangeContent(harnessDir, row.id, candidateName);
  if (baseText === undefined || candidateText === undefined) {
    return {
      ok: false,
      code: "missing",
      reason: `the change's content (${baseText === undefined ? "base.yaml" : candidateName}) is missing`,
    };
  }
  if (fileRevision(patch.kind, baseText) !== row.base.revision) {
    return changed("the change's base.yaml");
  }
  const digest = await keyedJsonDigest(
    await digestKeyOf(harnessDir),
    PATCH_DIGEST_LABEL,
    patchDigestPayload({
      kind: patch.kind,
      base: baseText,
      candidate: candidateText,
      spec: patch.spec,
      graders: patch.graders,
      dataset: patch.dataset,
    }),
  );
  if (digest !== row.patchDigest) return changed(`the change's ${candidateName} or patch.json`);
  return { ok: true, content: { patch, baseText, candidateText } };
}

/** The digest a check's evidence is recorded under: over its JSON form, as written. */
export async function evidenceDigestOf(
  harnessDir: string,
  evidence: Readonly<Record<string, unknown>>,
): Promise<string> {
  return keyedJsonDigest(
    await digestKeyOf(harnessDir),
    EVIDENCE_DIGEST_LABEL,
    JSON.parse(JSON.stringify(evidence)),
  );
}

export type VerifiedEvidence =
  | { readonly ok: true; readonly evidence: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

/**
 * A checked change's evidence, read from under its own `runs/` directory and checked
 * against the row's `evidenceDigest`.
 */
export async function verifiedEvidence(
  harnessDir: string,
  row: ChangeRow,
): Promise<VerifiedEvidence> {
  if (row.evidenceRef === undefined || row.evidenceDigest === undefined) {
    return { ok: false, reason: "the change has no recorded evidence" };
  }
  if (!underRuns(harnessDir, row, row.evidenceRef)) {
    return { ok: false, reason: "the change's evidence is not under its own runs directory" };
  }
  const read = openForReadSync(harnessDir, row.evidenceRef, {
    maxBytes: MAX_CONTENT_BYTES,
    followLeafSymlink: false,
  });
  if (!read.ok || read.truncated)
    return { ok: false, reason: "the change's evidence is unreadable" };
  let evidence: Record<string, unknown>;
  try {
    evidence = JSON.parse(read.text) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "the change's evidence is not JSON" };
  }
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) {
    return { ok: false, reason: "the change's evidence is not an object" };
  }
  if ((await evidenceDigestOf(harnessDir, evidence)) !== row.evidenceDigest) {
    return { ok: false, reason: "the change's evidence is not what its check recorded" };
  }
  return { ok: true, evidence };
}

/** Whether `rel` lies under the change's own `runs/` directory, by `relative()`. */
export function underRuns(harnessDir: string, row: ChangeRow, rel: string): boolean {
  if (!containedRel(harnessDir, rel)) return false;
  const runs = resolve(harnessDir, join(row.contentRef, "runs"));
  const back = relative(runs, resolve(harnessDir, rel));
  return back !== "" && !back.startsWith("..") && !isAbsolute(back);
}
