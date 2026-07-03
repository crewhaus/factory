/**
 * Item 59 (half 2) — PR-based spec-change proposals. `crewhaus propose
 * <proposed-spec.yaml>` is the team-governance wrapper around the
 * write-back verbs (`optimize --write-back`, `advise`, `model-scan`): instead
 * of mutating the live spec in place, it packages the proposed change into a
 * REVIEW artifact — a `patch.json` field diff, a rendered changelog entry, the
 * eval score delta, and provenance — and opens a GitHub PR so the team reviews
 * a prompt/model change like code. It NEVER auto-merges: the PR is the human
 * gate (mirroring the flywheel workflow's "never add an auto-merge step").
 *
 * Factored out of the entry file `index.ts` (which runs a top-level argv
 * switch and so cannot be imported by a test without executing the CLI).
 * Assembly is pure; git/gh live behind an injected `GitPrDriver` seam, so the
 * artifact bundle + PR body are unit-tested without a network or a real repo.
 *
 * INPUTS the review bundle carries:
 *   - patch.json: the structural field diff (`diffSpecYaml`) between the
 *     CURRENT spec and the PROPOSED spec — the reviewable "what changed";
 *   - CHANGELOG entry: `renderChangelogEntry` over the same before/after (+
 *     any optimizer provenance the proposed dir carries), the human-readable
 *     summary;
 *   - eval delta: when a baseline + candidate eval score are supplied
 *     (`--score-before`/`--score-after`, or read from the optimize run), the
 *     measured improvement that justifies the change;
 *   - provenance: the source verb (`optimize`/`advise`/`manual`), the content
 *     hash of the proposed spec, and the run id when present.
 *
 * The PR is opened on a fresh branch carrying ONLY the spec change + the
 * review bundle under `.crewhaus/proposals/<id>/`. The proposal is itself
 * audit-logged (`governance_proposal`) so its provenance is evidenced before
 * any human acts on it.
 */
import { createHash } from "node:crypto";
import { type SpecDiffEntry, diffSpecYaml } from "@crewhaus/spec-patch";
import { renderChangelogEntry } from "./spec-changelog";

/** Thrown for operational failures (unreadable spec, no change, driver
 *  failure). The CLI routes the message through `die()`; tests assert on
 *  `.message`. */
export class ProposeError extends Error {
  override readonly name = "ProposeError";
}

/** Where a proposal's review bundle lands within the repo. */
export const PROPOSALS_RELDIR = ".crewhaus/proposals";

export type ProposeSource = "optimize" | "advise" | "model-scan" | "manual";

/** sha256 hex of a spec's bytes — the patch identity carried into provenance. */
export function specContentHash(yaml: string): string {
  return createHash("sha256").update(yaml).digest("hex");
}

// ---------------------------------------------------------------------------
// bundle assembly (pure)
// ---------------------------------------------------------------------------

export type EvalDelta = {
  readonly scoreBefore: number;
  readonly scoreAfter: number;
  readonly datasetName?: string;
};

export type ProposalProvenance = {
  readonly source: ProposeSource;
  readonly specName: string;
  /** sha256 of the proposed spec bytes. */
  readonly patchHash: string;
  /** The optimize/advise run id, when the proposal came from one. */
  readonly runId?: string;
  readonly generatedAt: string;
};

/** The machine-readable half of the review bundle (`patch.json`). */
export type ProposalPatch = {
  readonly specName: string;
  readonly diff: ReadonlyArray<SpecDiffEntry>;
  readonly provenance: ProposalProvenance;
  readonly evalDelta?: EvalDelta;
};

export type AssembleProposalOptions = {
  readonly specName: string;
  readonly currentYaml: string;
  readonly proposedYaml: string;
  readonly source: ProposeSource;
  readonly runId?: string;
  readonly evalDelta?: EvalDelta;
  /** Optimize run dir whose provenance the changelog entry folds in. */
  readonly optimizeRootDir?: string;
  readonly patchJsonPath?: string;
  readonly proposedVersion: string;
  readonly now?: () => Date;
};

export type AssembledProposal = {
  readonly patch: ProposalPatch;
  /** `patch.json` text. */
  readonly patchJson: string;
  /** The rendered CHANGELOG entry for the proposed version. */
  readonly changelogEntry: string;
  readonly prTitle: string;
  readonly prBody: string;
  /** Whether the proposed spec differs structurally from the current one. */
  readonly hasStructuralChange: boolean;
};

/**
 * Assemble the review bundle from current + proposed spec YAML. Pure — no
 * filesystem, no git. Throws when the proposed spec is byte-identical to the
 * current one (nothing to propose); a structurally-empty-but-reformatted
 * change is allowed through with a note (comments matter to reviewers).
 */
export function assembleProposal(opts: AssembleProposalOptions): AssembledProposal {
  if (opts.proposedYaml === opts.currentYaml) {
    throw new ProposeError(
      "proposed spec is byte-identical to the current spec — nothing to propose",
    );
  }
  let diff: ReadonlyArray<SpecDiffEntry>;
  try {
    diff = diffSpecYaml(opts.currentYaml, opts.proposedYaml);
  } catch (err) {
    throw new ProposeError(`could not diff the specs: ${(err as Error).message}`);
  }
  const generatedAt = (opts.now?.() ?? new Date()).toISOString();
  const provenance: ProposalProvenance = {
    source: opts.source,
    specName: opts.specName,
    patchHash: specContentHash(opts.proposedYaml),
    ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
    generatedAt,
  };
  const patch: ProposalPatch = {
    specName: opts.specName,
    diff,
    provenance,
    ...(opts.evalDelta !== undefined ? { evalDelta: opts.evalDelta } : {}),
  };
  const patchJson = `${JSON.stringify(patch, null, 2)}\n`;

  const changelogEntry = renderChangelogEntry({
    version: opts.proposedVersion,
    yaml: opts.proposedYaml,
    previousYaml: opts.currentYaml,
    ...(opts.optimizeRootDir !== undefined ? { optimizeRootDir: opts.optimizeRootDir } : {}),
    ...(opts.patchJsonPath !== undefined ? { patchJsonPath: opts.patchJsonPath } : {}),
    ...(opts.now !== undefined ? { now: opts.now() } : {}),
  });

  const prTitle = `propose: ${opts.specName} ${opts.proposedVersion} (${opts.source})`;
  const prBody = buildPrBody({
    specName: opts.specName,
    version: opts.proposedVersion,
    source: opts.source,
    diff,
    ...(opts.evalDelta !== undefined ? { evalDelta: opts.evalDelta } : {}),
    ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
    patchHash: provenance.patchHash,
  });

  return {
    patch,
    patchJson,
    changelogEntry,
    prTitle,
    prBody,
    hasStructuralChange: diff.length > 0,
  };
}

function buildPrBody(args: {
  specName: string;
  version: string;
  source: ProposeSource;
  diff: ReadonlyArray<SpecDiffEntry>;
  evalDelta?: EvalDelta;
  runId?: string;
  patchHash: string;
}): string {
  const lines: string[] = [];
  lines.push(
    `Proposed change to **${args.specName}** (${args.version}), source: \`${args.source}\`.`,
  );
  lines.push("");
  lines.push("This PR was opened by `crewhaus propose` — the spec was NOT modified in place.");
  lines.push("Review it like code; merging is the human gate (there is no auto-merge).");
  lines.push("");
  if (args.evalDelta !== undefined) {
    const d = args.evalDelta;
    const arrow = d.scoreAfter >= d.scoreBefore ? "↑" : "↓";
    lines.push(
      `**Eval delta**: ${d.scoreBefore.toFixed(3)} → ${d.scoreAfter.toFixed(3)} ${arrow}${
        d.datasetName !== undefined ? ` (${d.datasetName})` : ""
      }`,
    );
    lines.push("");
  }
  lines.push("**Structural diff**");
  if (args.diff.length === 0) {
    lines.push("- no structural changes (comments/formatting only)");
  } else {
    for (const d of args.diff) lines.push(diffLine(d));
  }
  lines.push("");
  if (args.runId !== undefined) lines.push(`Run: \`${args.runId}\``);
  lines.push(`Patch hash: \`${args.patchHash.slice(0, 16)}…\``);
  lines.push("");
  lines.push(
    `The full review bundle (\`patch.json\` + changelog entry) is in \`${PROPOSALS_RELDIR}/\`.`,
  );
  return `${lines.join("\n")}\n`;
}

function diffLine(d: SpecDiffEntry): string {
  switch (d.kind) {
    case "added":
      return `- added \`${d.path}\`: ${d.after ?? ""}`;
    case "removed":
      return `- removed \`${d.path}\`: ${d.before ?? ""}`;
    case "changed":
      return `- changed \`${d.path}\`: ${d.before ?? ""} → ${d.after ?? ""}`;
  }
}

// ---------------------------------------------------------------------------
// PR driving (injected git/gh seam)
// ---------------------------------------------------------------------------

/** The write-and-open plan the driver executes: which files to write, the
 *  branch, and the PR title/body. Assembled purely; the driver is the only
 *  side-effect surface. */
export type ProposalPrPlan = {
  readonly branch: string;
  readonly title: string;
  readonly body: string;
  /** repo-relative path → contents to write on the branch. */
  readonly files: Readonly<Record<string, string>>;
  /** Commit message for the single proposal commit. */
  readonly commitMessage: string;
};

/** Slug-safe proposal id: `<spec>-<version>-<shorthash>-<stamp>`. */
export function proposalId(
  specName: string,
  version: string,
  patchHash: string,
  now: Date,
): string {
  const slug = specName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${slug || "spec"}-${version}-${patchHash.slice(0, 8)}-${stamp}`;
}

export type BuildPrPlanOptions = {
  readonly assembled: AssembledProposal;
  /** The proposed spec YAML — written to the harness's spec file on the branch. */
  readonly proposedYaml: string;
  /** Repo-relative path of the harness spec file (e.g. "crewhaus.yaml"). */
  readonly specRelPath: string;
  readonly proposedVersion: string;
  readonly now?: () => Date;
};

/** Assemble the branch/commit/PR plan + the review-bundle files. Pure. */
export function buildProposalPrPlan(opts: BuildPrPlanOptions): {
  readonly plan: ProposalPrPlan;
  readonly proposalId: string;
} {
  const now = opts.now?.() ?? new Date();
  const id = proposalId(
    opts.assembled.patch.specName,
    opts.proposedVersion,
    opts.assembled.patch.provenance.patchHash,
    now,
  );
  const bundleDir = `${PROPOSALS_RELDIR}/${id}`;
  const files: Record<string, string> = {
    [opts.specRelPath]: opts.proposedYaml,
    [`${bundleDir}/patch.json`]: opts.assembled.patchJson,
    [`${bundleDir}/CHANGELOG-entry.md`]: opts.assembled.changelogEntry,
    [`${bundleDir}/PR-body.md`]: opts.assembled.prBody,
  };
  const plan: ProposalPrPlan = {
    branch: `propose/${id}`,
    title: opts.assembled.prTitle,
    body: opts.assembled.prBody,
    files,
    commitMessage: `propose(${opts.assembled.patch.specName}): ${opts.proposedVersion} for review`,
  };
  return { plan, proposalId: id };
}

/**
 * Driver seam: execute a `ProposalPrPlan` against a real repo (branch → write
 * files → commit → push → `gh pr create`) and resolve to the opened PR. The
 * CLI wires this to git + gh (through `GITHUB_TOKEN`); tests inject a stub
 * that records the plan and returns a fixed PR ref. The driver MUST NOT
 * auto-merge.
 */
export type GitPrDriver = (plan: ProposalPrPlan) => Promise<OpenedPr>;

export type OpenedPr = {
  readonly prNumber?: number;
  readonly url: string;
  readonly branch: string;
};

export type GovernanceProposalPayload = {
  readonly source: ProposeSource;
  readonly specName: string;
  readonly patchHash: string;
  readonly proposedVersion: string;
  readonly evalDelta?: EvalDelta;
  readonly prNumber?: number;
  readonly prUrl?: string;
  readonly branch: string;
  readonly ts: number;
};

export function buildProposalAuditPayload(
  assembled: AssembledProposal,
  opened: OpenedPr,
  proposedVersion: string,
  now: () => number,
): GovernanceProposalPayload {
  return {
    source: assembled.patch.provenance.source,
    specName: assembled.patch.specName,
    patchHash: assembled.patch.provenance.patchHash,
    proposedVersion,
    ...(assembled.patch.evalDelta !== undefined ? { evalDelta: assembled.patch.evalDelta } : {}),
    ...(opened.prNumber !== undefined ? { prNumber: opened.prNumber } : {}),
    prUrl: opened.url,
    branch: opened.branch,
    ts: now(),
  };
}
