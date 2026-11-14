/**
 * The PR witness for `--check-pr` (`spec pin`, `deploy promote`, `deploy rollback`):
 * the CI rollup of the open, approved proposal PR for the exact spec and version.
 *
 * `crewhaus propose` opens its PR from a `propose/…` branch of the repository with the
 * title `propose: <specName> <version> (<source>)`. A PR witnesses a (spec, version)
 * only when all of these hold: its head is a `propose/` branch of this repository
 * (`isCrossRepository` is `false`), its title begins with exactly
 * `propose: <specName> <version> (`, and its review decision is `APPROVED`. The title
 * binds spec and version, whatever the body or branch names. When more than one open
 * PR is titled for the same spec and version, every one of them is weighed and the
 * least favourable answer stands, so no PR can turn another's red or pending check
 * green.
 */
import { spawnSync } from "node:child_process";
import { type PrCheckReader, type PrCheckState, rollupConclusion } from "./approval-gate";

/** The most open proposal PRs read. */
export const PR_WITNESS_LIMIT = 100;

/** The `spawnSync` shape this reader uses; tests inject one. */
export type GhSpawn = (
  command: string,
  args: readonly string[],
  options: { readonly encoding: "utf-8" },
) => { readonly status: number | null; readonly stdout: unknown };

type ListedPr = {
  readonly number: number;
  readonly url: string;
  readonly headRefName?: string;
  readonly title?: string;
  readonly isCrossRepository?: boolean;
  readonly reviewDecision?: string | null;
  readonly statusCheckRollup?: Array<{ conclusion?: string; state?: string }>;
};

/** Whether `pr` is a proposal PR for exactly this spec and version, from a branch of
 *  this repository. An absent `isCrossRepository` is not taken as `false`. */
export function isProposalPrFor(
  pr: {
    readonly headRefName?: unknown;
    readonly title?: unknown;
    readonly isCrossRepository?: unknown;
  },
  specName: string,
  version: string,
): boolean {
  return (
    pr.isCrossRepository === false &&
    typeof pr.headRefName === "string" &&
    pr.headRefName.startsWith("propose/") &&
    typeof pr.title === "string" &&
    pr.title.startsWith(`propose: ${specName} ${version} (`)
  );
}

type Conclusion = PrCheckState["conclusion"];

/** Least favourable first: the order in which several matching PRs are weighed. */
const RANK: Readonly<Record<Conclusion, number>> = {
  failure: 0,
  pending: 1,
  none: 2,
  success: 3,
};

/** One matching PR's answer: its rollup when it is approved, otherwise no witness. */
function conclusionOf(pr: ListedPr): Conclusion {
  if (pr.reviewDecision !== "APPROVED") return "none";
  // Fail-closed rollup: only an all-SUCCESS (>=1 check) rollup is a witness.
  return rollupConclusion(Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : []);
}

/**
 * Read a proposal PR's rollup check state via `gh` (argv array, no shell). Any gh
 * failure or absence resolves to `conclusion: "none"` (no witness), never a throw:
 * a missing gh withholds the PR witness without failing the command.
 * `GITHUB_TOKEN`/`GH_TOKEN` in the environment authenticates gh.
 */
export function readPrCheckViaGh(
  query: { readonly specName: string; readonly env: string; readonly version: string },
  spawn: GhSpawn = spawnSync,
): Awaited<ReturnType<PrCheckReader>> {
  try {
    const list = spawn(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "open",
        "--search",
        "head:propose/",
        "--json",
        "number,url,headRefName,title,isCrossRepository,reviewDecision,statusCheckRollup",
        "--limit",
        String(PR_WITNESS_LIMIT),
      ],
      { encoding: "utf-8" },
    );
    if (list.status !== 0 || typeof list.stdout !== "string") return { conclusion: "none" };
    const parsed = JSON.parse(list.stdout) as unknown;
    if (!Array.isArray(parsed)) return { conclusion: "none" };
    // The title binds the witness to the exact spec and version; every match is weighed.
    const matches = (parsed as ListedPr[]).filter(
      (p) =>
        p !== null && typeof p === "object" && isProposalPrFor(p, query.specName, query.version),
    );
    let worst: { pr: ListedPr; conclusion: Conclusion } | undefined;
    for (const pr of matches) {
      const conclusion = conclusionOf(pr);
      if (worst === undefined || RANK[conclusion] < RANK[worst.conclusion]) {
        worst = { pr, conclusion };
      }
    }
    if (worst === undefined) return { conclusion: "none" };
    return { conclusion: worst.conclusion, prNumber: worst.pr.number, url: worst.pr.url };
  } catch {
    return { conclusion: "none" };
  }
}
