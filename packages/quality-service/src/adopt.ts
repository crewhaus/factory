/**
 * The writers of a change's lifecycle: proposing one, adopting a granted one, rolling
 * one back, declining or withdrawing one, and observing what the other records say
 * (an active build that carries an adopted change, a denied decision, a watch that
 * ended or an SLO rollback that fired).
 *
 * Adoption re-checks everything at the moment it consumes the grant, each a named
 * refusal: the decision is granted and still bound to this change; the change's content
 * (its patch, base and proposed file) and its evidence are the bytes the row's digests
 * record, and what that content touches needs no higher class than the decision's; the
 * saved file is still the revision the check read (otherwise the decision and the
 * change are superseded: "Out of date: re-check"); the measuring instrument (graders,
 * judge model, judge calibration and plugin graders) is the one the check measured
 * with; the person adopting still holds the class the decision needs; and a change
 * whose dataset had no holdout is adopted only with `withoutHoldout`. A refusal leaves
 * the grant unspent. It then applies exactly the verified content through the
 * sanctioned writer (`commitSpec` for a spec, the graders write and its history line
 * for graders, the registry's `put` for cases). It never activates: activation is
 * `crewhaus deploy activate`.
 */
import { join } from "node:path";
import type { ChangeKind, ChangeReason, ChangeSource } from "@crewhaus/control-contract";
import { readDeployments } from "@crewhaus/control-records";
import { nextVersion, parseRegistryRef } from "@crewhaus/dataset-ops/datasets";
import { createFileBackedRegistry, latestVersion } from "@crewhaus/dataset-registry";
import { criteriaChanged, gradersConfigHash, parseGradersConfig } from "@crewhaus/eval-grader";
import { type Instrument, instrumentChanges } from "@crewhaus/eval-report";
import { specRevision } from "@crewhaus/ir/policy";
import { diffSpecYaml } from "@crewhaus/spec-patch";
import { type ActorRef, commitSpec } from "@crewhaus/spec-patch/commit";
import { writeFileSafe } from "@crewhaus/tool-safety/fs";
import { checkInFlight, parseCases } from "./check";
import {
  type ChangePatch,
  candidateNameOf,
  fileRevision,
  patchDigestPayload,
  readHarnessText,
  targetsContained,
  verifiedEvidence,
  verifyContent,
} from "./content";
import { appendCriteriaHistory } from "./criteria-history";
import { bindingDigestOf, moveDecision, readAdoptionDecision, subjectOf } from "./decision";
import { PATCH_DIGEST_LABEL, digestKeyOf, keyedJsonDigest } from "./digests";
import { type AuditView, type WatchRun, deploymentViewOf, watchOf } from "./lifecycle";
import {
  type ChangeRow,
  type ChangeTouches,
  contentRefOf,
  mintChangeId,
  moveChange,
  readChange,
  readChanges,
  writeChangeContent,
} from "./store";
import { requiredClassFor, touchesOf, touchesOfCases, touchesOfGraders } from "./touches";

/** The watch after activation, when the adoption does not say. */
export const DEFAULT_WATCH_HOURS = 24;

/** The command a history line records for an adopted graders change. */
export const CHANGES_ADOPT_CMD = "crewhaus changes adopt";

const iso = (ms: number): string => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// proposing
// ---------------------------------------------------------------------------

export type CreateChangeOptions = {
  readonly harnessDir: string;
  readonly kind: Exclude<ChangeKind, "mixed">;
  readonly source: ChangeSource;
  /** The spec file, relative to the harness. */
  readonly spec: string;
  /** The graders file, relative to the harness. */
  readonly graders: string;
  /** The dataset the check runs on: `registry:<name>[@version]` or a file. */
  readonly dataset: string;
  /** The text of the file the change edits, as it is now (for a dataset change, the
   *  base version's ref). */
  readonly baseText: string;
  /** The proposed text: the spec, the graders file, or the added cases (JSONL). */
  readonly candidateText: string;
  /** Who proposes, as a stored actor. */
  readonly actor: string;
  readonly cmd?: string;
  readonly via?: string;
  readonly now: () => number;
  /** A change id minted beforehand (a dry run prints it). */
  readonly chg?: string;
  readonly changelogEntry?: string;
  readonly prBody?: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  /** Evidence the producer already computed (a write-back's before and after runs). */
  readonly evidence?: Readonly<Record<string, unknown>>;
  /** A command-line write-back that already wrote the change: it enters `adopted`. */
  readonly adopted?: { readonly specVersion?: string; readonly watchHours?: number };
  /** Fields a proposal bundle's patch.json carries beside the change's own (a PR's
   *  `specName`, `diff`, `provenance`, `evalDelta`). The change's own fields win. */
  readonly patchExtra?: Readonly<Record<string, unknown>>;
};

export type CreateChangeAnswer =
  | { readonly ok: true; readonly row: ChangeRow }
  | { readonly ok: false; readonly reason: string };

/**
 * File a change: its content under `.crewhaus/proposals/<chg>/` and its first row,
 * `proposed`, or `adopted` for a write-back that already wrote it.
 */
export async function createChange(opts: CreateChangeOptions): Promise<CreateChangeAnswer> {
  const chg = opts.chg ?? mintChangeId(opts.now());
  if (!targetsContained(opts.harnessDir, opts)) {
    return {
      ok: false,
      reason:
        "a change names its spec, graders and dataset files relative to the harness, inside it",
    };
  }
  let touches: ChangeTouches;
  try {
    touches =
      opts.kind === "spec"
        ? touchesOf(opts.baseText, opts.candidateText)
        : opts.kind === "graders"
          ? touchesOfGraders(opts.baseText, opts.candidateText)
          : touchesOfCases();
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  if (opts.kind === "dataset") {
    try {
      parseCases(opts.candidateText);
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }
  const baseRevision = fileRevision(opts.kind, opts.baseText);
  const diff =
    opts.kind === "spec"
      ? (() => {
          try {
            return diffSpecYaml(opts.baseText, opts.candidateText);
          } catch {
            return undefined;
          }
        })()
      : undefined;
  const patch: ChangePatch = {
    ...(opts.patchExtra ?? {}),
    v: 1,
    kind: opts.kind,
    spec: opts.spec,
    graders: opts.graders,
    dataset: opts.dataset,
    baseRevision,
    ...(diff !== undefined ? { diff } : {}),
    ...(opts.provenance !== undefined ? { provenance: opts.provenance } : {}),
  };
  const candidateName = candidateNameOf(opts.kind);
  const written = writeChangeContent(opts.harnessDir, chg, {
    "base.yaml": opts.baseText,
    [candidateName]: opts.candidateText,
    "patch.json": `${JSON.stringify(patch, null, 2)}\n`,
    ...(opts.changelogEntry !== undefined ? { "CHANGELOG-entry.md": opts.changelogEntry } : {}),
    ...(opts.prBody !== undefined ? { "PR-body.md": opts.prBody } : {}),
    ...(opts.evidence !== undefined
      ? { "evidence.json": `${JSON.stringify(opts.evidence, null, 2)}\n` }
      : {}),
  });
  if (!written.ok) return { ok: false, reason: written.reason };
  const key = await digestKeyOf(opts.harnessDir);
  const patchDigest = await keyedJsonDigest(
    key,
    PATCH_DIGEST_LABEL,
    patchDigestPayload({
      kind: opts.kind,
      base: opts.baseText,
      candidate: opts.candidateText,
      spec: opts.spec,
      graders: opts.graders,
      dataset: opts.dataset,
    }),
  );
  const specText =
    opts.kind === "spec" ? opts.baseText : readHarnessText(opts.harnessDir, opts.spec);
  const gradersText =
    opts.kind === "graders" ? opts.baseText : readHarnessText(opts.harnessDir, opts.graders);
  let gradersHash: string | undefined;
  try {
    gradersHash =
      gradersText !== undefined
        ? gradersConfigHash(parseGradersConfig(gradersText).config)
        : undefined;
  } catch {
    gradersHash = undefined;
  }
  const at = iso(opts.now());
  const row: ChangeRow = {
    v: 1,
    id: chg,
    state: opts.adopted !== undefined ? "adopted" : "proposed",
    at,
    kind: opts.kind,
    source: opts.source,
    base: {
      revision: baseRevision,
      ...(specText !== undefined ? { specHash: specRevision(specText) } : {}),
      ...(gradersHash !== undefined ? { gradersHash } : {}),
    },
    patchDigest,
    contentRef: contentRefOf(chg),
    touches,
    actor: opts.actor,
    ...(opts.cmd !== undefined ? { cmd: opts.cmd } : {}),
    ...(opts.via !== undefined ? { via: opts.via } : {}),
    ...(opts.evidence !== undefined
      ? { evidenceRef: join(contentRefOf(chg), "evidence.json") }
      : {}),
    ...(opts.adopted !== undefined
      ? {
          adoption: {
            specHash: specRevision(opts.kind === "spec" ? opts.candidateText : (specText ?? "")),
            revision: fileRevision(opts.kind, opts.candidateText),
            ...(opts.adopted.specVersion !== undefined
              ? { specVersion: opts.adopted.specVersion }
              : {}),
          },
          watchHours: opts.adopted.watchHours ?? DEFAULT_WATCH_HOURS,
        }
      : {}),
  };
  const moved = await moveChange(opts.harnessDir, null, row);
  if (!moved.ok) return { ok: false, reason: moved.reason };
  return { ok: true, row: moved.row };
}

// ---------------------------------------------------------------------------
// adopting
// ---------------------------------------------------------------------------

export type AdoptOptions = {
  readonly harnessDir: string;
  readonly chg: string;
  /** The revision of the file the person saw and expects to change. */
  readonly expect: string;
  /** Adopt a change whose dataset has no holdout. */
  readonly withoutHoldout?: boolean;
  /** Hours the watch lasts once the change is activated. */
  readonly watchHours?: number;
  /** Who adopts, as a stored actor. */
  readonly actor: string;
  /** The spec writer's actor (`by` is a principal id, or nothing). */
  readonly writerActor?: ActorRef;
  /** Whether the person adopting still holds the decision's class, now. */
  readonly mayDecide: (requiredClass: "maintainer" | "owner") => boolean;
  /**
   * The measuring instrument a check would measure with now, computed the way the
   * check's runner computes it: the graders' config hash, the judge model, the judge
   * calibration it would apply and the plugin graders' digest. `undefined` (or a
   * throw) when it cannot be determined, which refuses the adoption.
   */
  readonly instrumentNow: (
    now: InstrumentInputs,
  ) => Instrument | undefined | Promise<Instrument | undefined>;
  /** Register a spec-registry version of the written spec, when the harness uses one. */
  readonly register?: (yamlText: string) => Promise<{ version: string } | undefined>;
  readonly cmd?: string;
  readonly via?: string;
  readonly now: () => number;
  /** The dataset registry root; default `<harness>/.crewhaus/datasets`. */
  readonly datasetsRoot?: string;
};

/** What the instrument is computed from: the spec and graders the check measured with. */
export type InstrumentInputs = {
  readonly kind: ChangePatch["kind"];
  /** The spec the check's measuring run ran (for a spec change, the proposed one). */
  readonly specYaml: string;
  /** The graders file as it is now. */
  readonly gradersYaml: string;
};

export type AdoptRefusal =
  | "not-found"
  | "stale"
  | "not-granted"
  | "binding-changed"
  | "out-of-date"
  | "expect-mismatch"
  | "instrument-changed"
  | "not-authorized"
  | "without-holdout"
  | "write-failed";

export type AdoptAnswer =
  | { readonly ok: true; readonly row: ChangeRow; readonly lines: readonly string[] }
  | {
      readonly ok: false;
      readonly code: AdoptRefusal;
      readonly reason: string;
      readonly row?: ChangeRow;
    };

const CLASS_RANK = { maintainer: 0, owner: 1 } as const;

/** The instrument the check's evidence records for what it measured. */
function recordedInstrument(
  kind: ChangePatch["kind"],
  evidence: Readonly<Record<string, unknown>>,
): Instrument | undefined {
  const raw = evidence["instrument"] as Record<string, unknown> | undefined;
  // A graders change measured both ways; the graders on disk now are its base.
  const instrument =
    kind === "graders" ? (raw?.["base"] as Record<string, unknown> | undefined) : raw;
  if (
    instrument === undefined ||
    typeof instrument !== "object" ||
    (instrument["source"] !== "summary" && instrument["source"] !== "row")
  ) {
    return undefined;
  }
  return instrument as unknown as Instrument;
}

function touchesOfContent(kind: ChangePatch["kind"], base: string, candidate: string) {
  return kind === "spec"
    ? touchesOf(base, candidate)
    : kind === "graders"
      ? touchesOfGraders(base, candidate)
      : touchesOfCases();
}

/** Adopt a change whose decision was granted. */
export async function adoptChange(opts: AdoptOptions): Promise<AdoptAnswer> {
  const { harnessDir } = opts;
  const row = readChange(harnessDir, opts.chg);
  if (row === undefined) return { ok: false, code: "not-found", reason: `no change ${opts.chg}` };
  if (row.state !== "awaiting-decision" || row.decision === undefined) {
    return {
      ok: false,
      code: "stale",
      reason: `${row.id} is ${row.state}; only a change waiting on its decision is adopted`,
      row,
    };
  }
  const decision = readAdoptionDecision(harnessDir, row.decision);
  if (decision === undefined || decision.state !== "granted") {
    return {
      ok: false,
      code: "not-granted",
      reason: `${row.decision} is ${decision?.state ?? "missing"}; it must be granted first: crewhaus approvals grant ${row.decision}`,
      row,
    };
  }
  if (Date.parse(decision.expiresAt) < opts.now()) {
    return { ok: false, code: "not-granted", reason: `${row.decision} has expired`, row };
  }
  const subject = subjectOf(row);
  if (
    subject === undefined ||
    decision.subject.chg !== row.id ||
    decision.bindingDigest !== (await bindingDigestOf(harnessDir, subject))
  ) {
    return {
      ok: false,
      code: "binding-changed",
      reason: `${row.decision} was granted for something other than this change as it now stands; check it again`,
      row,
    };
  }
  // The content adopted is the content the decision binds: patch, base and proposed
  // file against the row's patch digest, the evidence against its evidence digest.
  const verified = await verifyContent(harnessDir, row);
  if (!verified.ok) {
    return {
      ok: false,
      code: verified.code === "missing" ? "write-failed" : "binding-changed",
      reason: verified.reason,
      row,
    };
  }
  const { patch, baseText, candidateText: candidate } = verified.content;
  const evidence = await verifiedEvidence(harnessDir, row);
  if (!evidence.ok) {
    return {
      ok: false,
      code: "binding-changed",
      reason: `${evidence.reason}, so nothing was adopted; check the change again`,
      row,
    };
  }
  // What the content touches is computed again; it never needs more than the grant.
  let needed: "maintainer" | "owner";
  try {
    needed = requiredClassFor(touchesOfContent(patch.kind, baseText, candidate));
  } catch (err) {
    return {
      ok: false,
      code: "binding-changed",
      reason: `the change's content cannot be read as a ${patch.kind} change (${(err as Error).message})`,
      row,
    };
  }
  if (CLASS_RANK[needed] > CLASS_RANK[decision.requiredClass]) {
    return {
      ok: false,
      code: "binding-changed",
      reason: `this change needs the harness's owner, and ${row.decision} was opened for a maintainer; check it again`,
      row,
    };
  }
  const target = patch.kind === "spec" ? patch.spec : patch.graders;
  const nowText = patch.kind === "dataset" ? undefined : readHarnessText(harnessDir, target);
  const nowRevision =
    patch.kind === "dataset"
      ? await datasetBaseRevision(opts, patch)
      : nowText === undefined
        ? undefined
        : fileRevision(patch.kind, nowText);
  if (nowRevision !== row.base.revision) {
    // The base moved: the grant no longer describes what adopting would do.
    await moveDecision(harnessDir, "granted", {
      ...decision,
      state: "superseded",
      supersededAt: iso(opts.now()),
      supersededReason: "revision-changed",
    });
    const superseded = await moveChange(harnessDir, "awaiting-decision", {
      ...row,
      state: "superseded",
      at: iso(opts.now()),
      reason: "base-moved",
      actor: opts.actor,
      ...(opts.cmd !== undefined ? { cmd: opts.cmd } : {}),
    });
    return {
      ok: false,
      code: "out-of-date",
      reason: `Out of date: re-check. ${patch.kind === "dataset" ? `the dataset ${patch.dataset}` : target} changed since the check`,
      ...(superseded.ok ? { row: superseded.row } : { row }),
    };
  }
  if (opts.expect !== row.base.revision) {
    return {
      ok: false,
      code: "expect-mismatch",
      reason: `the file is at ${row.base.revision}, not the revision you expect (${opts.expect}); look at the change again: crewhaus changes show ${row.id}`,
      row,
    };
  }
  // The instrument the check measured with, and the one a check would measure with now.
  const recorded = recordedInstrument(patch.kind, evidence.evidence);
  const gradersNow = readHarnessText(harnessDir, patch.graders);
  const specMeasured = patch.kind === "spec" ? candidate : readHarnessText(harnessDir, patch.spec);
  let current: Instrument | undefined;
  try {
    current =
      gradersNow === undefined || specMeasured === undefined
        ? undefined
        : await opts.instrumentNow({
            kind: patch.kind,
            specYaml: specMeasured,
            gradersYaml: gradersNow,
          });
  } catch {
    current = undefined;
  }
  if (
    recorded === undefined ||
    current === undefined ||
    recorded.gradersHash === undefined ||
    current.gradersHash === undefined
  ) {
    return {
      ok: false,
      code: "instrument-changed",
      reason:
        "the measuring instrument cannot be determined now (the graders file or what it uses cannot be read), so the check's result cannot be held to it; check it again",
      row,
    };
  }
  const moved = instrumentChanges(recorded, current).filter((c) => c.unverified !== true);
  if (moved.length > 0) {
    return {
      ok: false,
      code: "instrument-changed",
      reason: `the measuring instrument changed since the check (${moved.map((c) => c.field).join(", ")}), so its result no longer says what this change does; check it again`,
      row,
    };
  }
  if (!opts.mayDecide(decision.requiredClass)) {
    return {
      ok: false,
      code: "not-authorized",
      reason: `adopting this change needs ${decision.requiredClass === "owner" ? "the harness's owner" : "a maintainer or the owner"}`,
      row,
    };
  }
  if (row.verdict?.holdout === "absent" && opts.withoutHoldout !== true) {
    return {
      ok: false,
      code: "without-holdout",
      reason:
        "this change had no held-out check (its dataset has no holdout). Adopt without a held-out check: pass --without-holdout, or cut one first: crewhaus datasets holdout <dataset> --fraction 0.2",
      row,
    };
  }
  const consumed = await moveDecision(harnessDir, "granted", {
    ...decision,
    state: "consumed",
    consumedAt: iso(opts.now()),
  });
  if (!consumed) {
    return {
      ok: false,
      code: "not-granted",
      reason: `${row.decision} was used or changed just now`,
      row,
    };
  }

  // The grant is spent from here: a write that fails closes the change, so it can be
  // proposed again.
  const spent = async (reason: string): Promise<AdoptAnswer> => {
    const closed = await moveChange(harnessDir, "awaiting-decision", {
      ...row,
      state: "superseded",
      at: iso(opts.now()),
      reason: "other",
      actor: opts.actor,
      ...(opts.cmd !== undefined ? { cmd: opts.cmd } : {}),
      ...(opts.via !== undefined ? { via: opts.via } : {}),
    });
    return {
      ok: false,
      code: "write-failed",
      reason: `${reason}. The decision was used, so ${row.id} is closed; propose it again: crewhaus changes propose`,
      ...(closed.ok ? { row: closed.row } : { row }),
    };
  };

  let adoption: NonNullable<ChangeRow["adoption"]>;
  const lines: string[] = [];
  if (patch.kind === "spec") {
    const committed = await commitSpec(
      { specPath: join(harnessDir, patch.spec) },
      { kind: "text", text: candidate },
      {
        expectedRev: row.base.revision,
        writer: "quality.adopt",
        actor: opts.writerActor ?? { kind: "person" },
        ...(opts.register !== undefined ? { register: opts.register } : {}),
        now: () => new Date(opts.now()),
      },
    );
    if (!committed.ok) return spent(`the spec was not written: ${committed.reason}`);
    adoption = {
      specHash: specRevision(candidate),
      revision: specRevision(candidate),
      ...(committed.registered !== undefined ? { specVersion: committed.registered } : {}),
    };
  } else if (patch.kind === "graders") {
    const written = writeFileSafe(harnessDir, patch.graders, candidate, { overwrite: true });
    if (!written.ok) return spent(`the graders were not written: ${written.reason}`);
    const before = parseGradersConfig(nowText ?? "").config;
    const after = parseGradersConfig(candidate).config;
    const history = appendCriteriaHistory(harnessDir, criteriaChanged(before, after), {
      at: iso(opts.now()),
      cmd: CHANGES_ADOPT_CMD,
      ...(opts.actor.startsWith("prn_") ? { by: opts.actor } : {}),
    });
    if (!history.ok)
      lines.push(`note: the criteria history could not be written (${history.reason})`);
    const specText = readHarnessText(harnessDir, patch.spec) ?? "";
    adoption = {
      specHash: specRevision(specText),
      gradersHash: gradersConfigHash(after),
      revision: fileRevision("graders", candidate),
    };
  } else {
    let put: Awaited<ReturnType<typeof putCases>>;
    try {
      put = await putCases(opts, patch, candidate);
    } catch (err) {
      put = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (!put.ok) return spent(`the cases were not written: ${put.reason}`);
    const specText = readHarnessText(harnessDir, patch.spec) ?? "";
    adoption = { specHash: specRevision(specText), revision: put.revision };
    lines.push(`wrote ${put.name}@${put.version}`);
  }
  const adopted = await moveChange(harnessDir, "awaiting-decision", {
    ...row,
    state: "adopted",
    at: iso(opts.now()),
    actor: opts.actor,
    adoption,
    watchHours: opts.watchHours ?? DEFAULT_WATCH_HOURS,
    ...(opts.cmd !== undefined ? { cmd: opts.cmd } : {}),
    ...(opts.via !== undefined ? { via: opts.via } : {}),
  });
  if (!adopted.ok) return { ok: false, code: "write-failed", reason: adopted.reason, row };
  lines.push(
    patch.kind === "spec"
      ? "Adopted, not active yet — activate with `crewhaus deploy activate`"
      : "Adopted",
  );
  return { ok: true, row: adopted.row, lines };
}

async function datasetBaseRevision(
  opts: { readonly harnessDir: string; readonly datasetsRoot?: string },
  patch: ChangePatch,
): Promise<string | undefined> {
  const ref = parseRegistryRef(patch.dataset);
  if (ref === undefined) return undefined;
  const registry = createFileBackedRegistry({
    rootDir: opts.datasetsRoot ?? join(opts.harnessDir, ".crewhaus", "datasets"),
  });
  const version = await latestVersion(registry, ref.name);
  return version === undefined ? undefined : datasetRevision(ref.name, version);
}

/** The revision of a dataset change's base: the dataset version it adds cases to. */
export function datasetRevision(name: string, version: string): string {
  return fileRevision("dataset", JSON.stringify({ dataset: `${name}@${version}` }));
}

async function putCases(
  opts: { readonly harnessDir: string; readonly datasetsRoot?: string },
  patch: ChangePatch,
  casesText: string,
): Promise<
  { ok: true; name: string; version: string; revision: string } | { ok: false; reason: string }
> {
  const ref = parseRegistryRef(patch.dataset);
  if (ref === undefined)
    return { ok: false, reason: "a dataset change adds cases to a registry dataset" };
  const registry = createFileBackedRegistry({
    rootDir: opts.datasetsRoot ?? join(opts.harnessDir, ".crewhaus", "datasets"),
  });
  const base = await latestVersion(registry, ref.name);
  if (base === undefined) return { ok: false, reason: `dataset ${ref.name} has no versions` };
  const record = await registry.getRecord(ref.name, base);
  const added = parseCases(casesText);
  const ids = new Set(
    [
      ...record.splits.train,
      ...record.splits.dev,
      ...(record.splits.test ?? []),
      ...(record.splits.holdout ?? []),
    ].map((s) => s.id),
  );
  const fresh = added.filter((s) => !ids.has(s.id));
  const version = nextVersion(await registry.list(ref.name));
  await registry.put({
    name: ref.name,
    version,
    splits: {
      train: [...record.splits.train, ...fresh],
      dev: [...record.splits.dev],
      ...(record.splits.test !== undefined ? { test: [...record.splits.test] } : {}),
      ...(record.splits.holdout !== undefined ? { holdout: [...record.splits.holdout] } : {}),
    },
  });
  return { ok: true, name: ref.name, version, revision: datasetRevision(ref.name, version) };
}

// ---------------------------------------------------------------------------
// rolling back, declining, withdrawing
// ---------------------------------------------------------------------------

export type RollbackOptions = {
  readonly harnessDir: string;
  readonly chg: string;
  /** The revision the person expects on disk: the adopted one. */
  readonly expect: string;
  readonly actor: string;
  readonly writerActor?: ActorRef;
  readonly register?: (yamlText: string) => Promise<{ version: string } | undefined>;
  readonly cmd?: string;
  readonly via?: string;
  readonly now: () => number;
};

export type RollbackAnswer =
  | { readonly ok: true; readonly row: ChangeRow; readonly lines: readonly string[] }
  | {
      readonly ok: false;
      readonly code:
        | "not-found"
        | "stale"
        | "moved"
        | "expect-mismatch"
        | "binding-changed"
        | "unsupported"
        | "write-failed";
      readonly reason: string;
      /** How the file moved since adoption, for a refusal. */
      readonly diff?: ReadonlyArray<{ kind: string; path: string }>;
      readonly row?: ChangeRow;
    };

/**
 * Apply a change's inverse. The file must still be the revision adoption wrote:
 * otherwise the refusal carries how it moved since. Deployments are untouched: an
 * activated change's restored spec is activated with `crewhaus deploy activate`.
 */
export async function rollbackChange(opts: RollbackOptions): Promise<RollbackAnswer> {
  const { harnessDir } = opts;
  const row = readChange(harnessDir, opts.chg);
  if (row === undefined) return { ok: false, code: "not-found", reason: `no change ${opts.chg}` };
  if ((row.state !== "adopted" && row.state !== "monitoring") || row.adoption === undefined) {
    return {
      ok: false,
      code: "stale",
      reason: `${row.id} is ${row.state}; only an adopted or watched change is rolled back`,
      row,
    };
  }
  if (row.kind === "dataset") {
    return {
      ok: false,
      code: "unsupported",
      reason:
        "a dataset change is undone by putting the earlier cases again (`crewhaus datasets put`); the registry never removes a version",
      row,
    };
  }
  // What is restored is the base the change recorded, read back against its digest.
  const verified = await verifyContent(harnessDir, row);
  if (!verified.ok) {
    return {
      ok: false,
      code: verified.code === "missing" ? "write-failed" : "binding-changed",
      reason: verified.reason,
      row,
    };
  }
  const { patch, baseText: base, candidateText: adoptedText } = verified.content;
  if (patch.kind === "dataset") {
    return { ok: false, code: "unsupported", reason: "a dataset change is not rolled back", row };
  }
  const target = patch.kind === "spec" ? patch.spec : patch.graders;
  const nowText = readHarnessText(harnessDir, target);
  if (nowText === undefined) {
    return { ok: false, code: "write-failed", reason: `${target} cannot be read`, row };
  }
  const nowRevision = fileRevision(patch.kind, nowText);
  if (nowRevision !== row.adoption.revision) {
    let diff: ReadonlyArray<{ kind: string; path: string }> = [];
    try {
      diff = diffSpecYaml(adoptedText, nowText).map((d) => ({ kind: d.kind, path: d.path }));
    } catch {
      diff = [];
    }
    return {
      ok: false,
      code: "moved",
      reason: `${target} changed since ${row.id} was adopted; nothing was rolled back`,
      diff,
      row,
    };
  }
  if (opts.expect !== row.adoption.revision) {
    return {
      ok: false,
      code: "expect-mismatch",
      reason: `the file is at ${row.adoption.revision}, not the revision you expect (${opts.expect})`,
      row,
    };
  }
  let restored: string | undefined;
  if (patch.kind === "spec") {
    const committed = await commitSpec(
      { specPath: join(harnessDir, patch.spec) },
      { kind: "text", text: base },
      {
        expectedRev: row.adoption.revision,
        writer: "quality.rollback",
        actor: opts.writerActor ?? { kind: "person" },
        ...(opts.register !== undefined ? { register: opts.register } : {}),
        now: () => new Date(opts.now()),
      },
    );
    if (!committed.ok) {
      return {
        ok: false,
        code: "write-failed",
        reason: `the spec was not written: ${committed.reason}`,
        row,
      };
    }
    restored = committed.registered;
  } else {
    const written = writeFileSafe(harnessDir, patch.graders, base, { overwrite: true });
    if (!written.ok) {
      return {
        ok: false,
        code: "write-failed",
        reason: `the graders were not written: ${written.reason}`,
        row,
      };
    }
  }
  const moved = await moveChange(harnessDir, row.state, {
    ...row,
    state: "rolled-back",
    at: iso(opts.now()),
    actor: opts.actor,
    rollbackTarget: {
      specHash: patch.kind === "spec" ? specRevision(base) : row.adoption.specHash,
      revision: fileRevision(patch.kind, base),
      ...(restored !== undefined ? { specVersion: restored } : {}),
    },
    ...(opts.cmd !== undefined ? { cmd: opts.cmd } : {}),
    ...(opts.via !== undefined ? { via: opts.via } : {}),
  });
  if (!moved.ok) return { ok: false, code: "write-failed", reason: moved.reason, row };
  const lines =
    row.activation !== undefined && patch.kind === "spec"
      ? ["Saved spec restored; activate it with `crewhaus deploy activate`"]
      : [`${target} restored`];
  return { ok: true, row: moved.row, lines };
}

export type EndOptions = {
  readonly harnessDir: string;
  readonly chg: string;
  readonly reason: ChangeReason;
  readonly actor: string;
  readonly cmd?: string;
  readonly via?: string;
  readonly now: () => number;
};

export type EndAnswer =
  | { readonly ok: true; readonly row: ChangeRow }
  | {
      readonly ok: false;
      readonly code: "not-found" | "stale" | "unavailable";
      readonly reason: string;
      readonly row?: ChangeRow;
    };

async function endChange(
  opts: EndOptions,
  to: "declined" | "withdrawn",
  from: ReadonlyArray<ChangeRow["state"]>,
): Promise<EndAnswer> {
  const row = readChange(opts.harnessDir, opts.chg);
  if (row === undefined) return { ok: false, code: "not-found", reason: `no change ${opts.chg}` };
  if (!from.includes(row.state)) {
    return {
      ok: false,
      code: "stale",
      reason: `${row.id} is ${row.state}; a change is ${to} only from ${from.join(", ")}`,
      row,
    };
  }
  if (row.decision !== undefined) {
    // An open decision about a change nobody will adopt is superseded with it.
    const decision = readAdoptionDecision(opts.harnessDir, row.decision);
    if (decision !== undefined && (decision.state === "pending" || decision.state === "granted")) {
      await moveDecision(opts.harnessDir, decision.state, {
        ...decision,
        state: "superseded",
        supersededAt: iso(opts.now()),
        supersededReason: "other",
      });
    }
  }
  const moved = await moveChange(opts.harnessDir, row.state, {
    ...row,
    state: to,
    at: iso(opts.now()),
    reason: opts.reason,
    actor: opts.actor,
    ...(opts.cmd !== undefined ? { cmd: opts.cmd } : {}),
    ...(opts.via !== undefined ? { via: opts.via } : {}),
  });
  if (!moved.ok) {
    return {
      ok: false,
      code: moved.code === "unavailable" ? "unavailable" : "stale",
      reason: moved.reason,
      row,
    };
  }
  return { ok: true, row: moved.row };
}

/** Decline a checked change, or one waiting on its decision. */
export function declineChange(opts: EndOptions): Promise<EndAnswer> {
  return endChange(opts, "declined", ["checked", "awaiting-decision"]);
}

/** Withdraw a change nobody has decided on. */
export function withdrawChange(opts: EndOptions): Promise<EndAnswer> {
  return endChange(opts, "withdrawn", ["proposed", "failed", "checked"]);
}

// ---------------------------------------------------------------------------
// observing
// ---------------------------------------------------------------------------

export type ObserveOptions = {
  readonly harnessDir: string;
  readonly now: () => number;
  /** Runs of the default lineage, for the watch; absent: no regression signal. */
  readonly runs?: ReadonlyArray<WatchRun>;
  /** The audit tail, for the SLO rollback rung. `"unreadable"`: the audit could not be
   *  read, so no watch is decided (nothing is recorded kept or rolled back). */
  readonly audit?: ReadonlyArray<AuditView> | "unreadable";
  /**
   * Whether a `checking` change's check was interrupted: nothing is running it any more
   * (the caller holds the harness's mutating lease, which a check holds for as long as
   * it runs). Absent: a `checking` change is left as it is. A check this process is
   * running is never taken for interrupted.
   */
  readonly interruptedCheck?: (row: ChangeRow) => boolean;
};

export type Observed = {
  readonly activated: readonly string[];
  /** Checks that were interrupted, now `failed` (they can be checked again). */
  readonly failed: readonly string[];
  readonly kept: readonly string[];
  readonly rolledBack: readonly string[];
  readonly declined: readonly string[];
};

/**
 * What a writer records on its way past: a check that was interrupted becomes `failed`
 * (it can be checked again); an adopted change whose build is now active
 * becomes `activated` and then `monitoring` until its watch ends; a change whose
 * decision was denied becomes `declined`; a watched change whose spec's SLO rollback
 * fired becomes `rolled-back` by `sys:slo`; one past its watch with no signal becomes
 * `kept`. Only a writer calls this; a read computes the same through
 * `effectiveChangeState` and writes nothing.
 */
export async function observeChanges(opts: ObserveOptions): Promise<Observed> {
  const { harnessDir } = opts;
  const read = readChanges(harnessDir);
  const out = {
    activated: [] as string[],
    failed: [] as string[],
    kept: [] as string[],
    rolledBack: [] as string[],
    declined: [] as string[],
  };
  if (read.state !== "present") return out;
  const deployments = readDeployments(harnessDir);
  const views =
    deployments.state === "present"
      ? deployments.records.flatMap((r) => {
          const view = deploymentViewOf(r);
          return view === undefined ? [] : [view];
        })
      : [];
  for (const row of read.rows) {
    const nowMs = opts.now();
    if (row.state === "checking") {
      if (checkInFlight(harnessDir, row.id) || opts.interruptedCheck?.(row) !== true) continue;
      const moved = await moveChange(harnessDir, "checking", {
        ...row,
        state: "failed",
        at: iso(nowMs),
        actor: "sys:reconcile",
      });
      if (moved.ok) out.failed.push(row.id);
      continue;
    }
    if (row.state === "awaiting-decision" && row.decision !== undefined) {
      const decision = readAdoptionDecision(harnessDir, row.decision);
      if (decision?.state === "denied") {
        const moved = await moveChange(harnessDir, "awaiting-decision", {
          ...row,
          state: "declined",
          at: iso(nowMs),
          reason: "other",
          ...(decision.decidedByPrincipal !== undefined
            ? { actor: decision.decidedByPrincipal }
            : {}),
        });
        if (moved.ok) out.declined.push(row.id);
      }
      continue;
    }
    if (row.state === "adopted" && row.adoption !== undefined) {
      const active = views.find(
        (d) => d.state === "active" && d.specHash === row.adoption?.specHash,
      );
      if (active === undefined) continue;
      const activated = await moveChange(harnessDir, "adopted", {
        ...row,
        state: "activated",
        at: iso(nowMs),
        activation: active.id,
        actor: "sys:reconcile",
      });
      if (!activated.ok) continue;
      const hours = row.watchHours ?? DEFAULT_WATCH_HOURS;
      await moveChange(harnessDir, "activated", {
        ...activated.row,
        state: "monitoring",
        at: iso(nowMs),
        until: iso(nowMs + hours * 3_600_000),
      });
      out.activated.push(row.id);
      continue;
    }
    if (row.state === "monitoring") {
      if (opts.audit === "unreadable") continue;
      const signal = watchOf(row, {
        runs: opts.runs ?? [],
        audit: opts.audit ?? [],
        activatedAt: row.at,
        now: nowMs,
      });
      if (signal.signal === "slo") {
        const moved = await moveChange(harnessDir, "monitoring", {
          ...row,
          state: "rolled-back",
          at: iso(nowMs),
          actor: "sys:slo",
          reason: "slo-rollback",
        });
        if (moved.ok) out.rolledBack.push(row.id);
      } else if (signal.signal === "ended") {
        const moved = await moveChange(harnessDir, "monitoring", {
          ...row,
          state: "kept",
          at: iso(nowMs),
          actor: "sys:reconcile",
        });
        if (moved.ok) out.kept.push(row.id);
      }
    }
  }
  return out;
}
