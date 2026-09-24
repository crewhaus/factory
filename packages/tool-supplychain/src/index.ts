/**
 * @crewhaus/tool-supplychain — what you depend on, and what runs it.
 *
 * Two questions a harness should never answer by reading and squinting:
 *
 *   - `DependencyAudit` — does anything this project has locked appear in a
 *     published advisory? It reads the lockfile with the readers that already
 *     exist in `@crewhaus/tool-code` (there is exactly one lockfile parser in
 *     this repository, and it is not here) and asks the public OSV database.
 *   - `CiWorkflowAudit` — do the workflows that build this project hand an
 *     outsider more than they should? Offline, pure parsing.
 *
 * What is NOT here: a package-provenance check. Verifying an npm provenance
 * attestation means verifying a Sigstore bundle against the TUF trust root,
 * and a trust root that is hard-coded rather than fetched and refreshed
 * starts silently accepting — or silently failing — the day the root rotates.
 * A wrong answer about a signature is worse than no answer, so this package
 * gives no answer and says so here.
 *
 * The honesty that matters most in `DependencyAudit`: OSV answers whether a
 * version falls inside a range an advisory declares affected. It cannot tell
 * you whether the vulnerable code is reachable from this project, and neither
 * can this tool, so nothing it returns is named as though it could.
 */
import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { LOCKFILE_NAMES, type LockEcosystem, parseLockfileDetailed } from "@crewhaus/tool-code";
import { z } from "zod";
import { type CvssRating, severityRank } from "./lib/cvss";
import { type Coordinate, affectedFor } from "./lib/osv";
import {
  type Finding,
  RULE_IDS,
  type RepositoryVisibility,
  type RuleId,
  type Severity,
  auditWorkflow,
  classifyRunsOn,
  inventoryUses,
  readWorkflow,
  sortFindings,
} from "./lib/workflow";
import {
  MAX_HYDRATIONS,
  OSV_DEFAULT_ENDPOINT,
  OsvUnavailableError,
  hydrateAdvisories,
  queryBatches,
  resolveEndpoint,
} from "./net";
import { ToolPermissionError, resolveSafe, workspaceRoot } from "./paths";

export { _setFetch, OSV_DEFAULT_ENDPOINT, OsvUnavailableError } from "./net";

/** Compact JSON — the reader is a model, not a person. */
const json = (value: unknown): string => JSON.stringify(value);

const LIMITS = {
  /** Coordinates sent to OSV in one call. */
  packages: 5_000,
  /** Workflow files read in one call. */
  workflowFiles: 400,
  /** A workflow file larger than this is not a workflow file. */
  workflowBytes: 4 * 1024 * 1024,
  /** A lockfile larger than this is refused rather than parsed. */
  lockBytes: 64 * 1024 * 1024,
} as const;

const DEFAULTS = {
  packages: 1_000,
  advisories: 100,
  findings: 200,
  timeoutMs: 30_000,
} as const;

// ---------------------------------------------------------------------------
// shared helpers

type Resolved<T> = { ok: true; value: T } | { ok: false; message: string };

/** Resolve a caller path inside the workspace, or say why it was refused. */
function resolveInside(toolName: string, rel: string): Resolved<string> {
  try {
    return { ok: true, value: resolveSafe(toolName, rel).real };
  } catch (err) {
    if (err instanceof ToolPermissionError) {
      return {
        ok: false,
        message: `${toolName} refused the path "${rel}": it resolves outside the workspace root. Pass a path inside the working directory.`,
      };
    }
    throw err;
  }
}

/**
 * A path the tool DISCOVERED still has to clear the boundary.
 *
 * `resolveInside` only ever sees what the caller typed, so a
 * `.github/workflows/x.yml` or a `bun.lock` that is a symlink out of the
 * workspace was refused when named directly and read when reached through the
 * enclosing directory — the same file, two answers. Reading it is not
 * academic: the lockfile path parses the contents and posts the package names
 * to OSV, so an out-of-workspace file leaves the machine.
 */
function contained(toolName: string, abs: string): boolean {
  try {
    resolveSafe(toolName, path.relative(workspaceRoot(), abs));
    return true;
  } catch (err) {
    if (err instanceof ToolPermissionError) return false;
    throw err;
  }
}

function readTextFile(abs: string, maxBytes: number): string | undefined {
  try {
    if (statSync(abs).size > maxBytes) return undefined;
    return readFileSync(abs, "utf-8");
  } catch {
    return undefined;
  }
}

/** True when the NAME is there, dangling link included — see paths.ts. */
function nameExists(abs: string): boolean {
  try {
    lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

const capped = <T>(items: readonly T[], limit: number): { items: T[]; truncated: boolean } => ({
  items: items.slice(0, limit),
  truncated: items.length > limit,
});

const SEVERITY_BANDS = ["critical", "high", "medium", "low"] as const;
type Band = (typeof SEVERITY_BANDS)[number] | "unknown";

const BAND_ORDER: Record<Band, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  unknown: 4,
};

/**
 * Keep findings at or above a threshold — and keep every UNRANKED one.
 *
 * An advisory OSV recorded no severity for is not a low-severity advisory,
 * and dropping it because it cannot be graded would be the filter quietly
 * deciding something it does not know. The count of those is reported.
 */
function atLeast<T extends { band: Band }>(
  items: readonly T[],
  min: Band | undefined,
): { kept: T[]; unrankedKept: number } {
  if (min === undefined) return { kept: [...items], unrankedKept: 0 };
  const kept = items.filter((i) => i.band === "unknown" || BAND_ORDER[i.band] <= BAND_ORDER[min]);
  return { kept, unrankedKept: kept.filter((i) => i.band === "unknown").length };
}

const severityField = z
  .enum(SEVERITY_BANDS)
  .optional()
  .describe("drop findings below this severity; unrated ones are always kept");

// ---------------------------------------------------------------------------
// DependencyAudit

/**
 * The lockfiles that have a reader, taken from tool-code rather than listed
 * again here. A second list is a list that goes stale: the widened readers
 * added pnpm-lock.yaml, and a copy of the old names would still be reporting
 * pnpm as unaudited while it was being audited.
 */
const LOCKFILES = LOCKFILE_NAMES;

/** Files that ARE lockfiles but have no reader, each with why. */
const UNREAD_LOCKFILES: ReadonlyArray<{ name: string; why: string }> = [
  {
    name: "bun.lockb",
    why: "bun.lockb is bun's binary lockfile; run `bun install --save-text-lockfile` to get a bun.lock that can be read",
  },
  {
    name: "poetry.lock",
    why: "poetry.lock has no reader in @crewhaus/tool-code, so its packages were NOT audited",
  },
  {
    name: "go.sum",
    why: "go.sum has no reader in @crewhaus/tool-code, so its modules were NOT audited",
  },
  {
    name: "requirements.txt",
    why: "requirements.txt is a manifest rather than a lockfile and frequently pins nothing, so its packages were NOT audited",
  },
];

type LockRead = {
  readonly coordinates: Coordinate[];
  readonly lockfiles: string[];
  readonly notes: string[];
  readonly refused: string[];
};

/** Read every lockfile in a directory into (ecosystem, name, version) triples. */
function readCoordinates(dirAbs: string, dirLabel: string): LockRead {
  const coordinates: Coordinate[] = [];
  const lockfiles: string[] = [];
  const notes: string[] = [];
  const refused: string[] = [];
  for (const name of LOCKFILES) {
    const abs = path.join(dirAbs, name);
    if (nameExists(abs) && !contained("DependencyAudit", abs)) {
      refused.push(name);
      continue;
    }
    const text = readTextFile(abs, LIMITS.lockBytes);
    if (text === undefined) continue;
    // The filename-to-reader mapping lives in tool-code and only there, so a
    // format cannot end up half-added — read by one package and invisible to
    // the next.
    const locked = parseLockfileDetailed(name, text);
    if (locked === undefined) continue;
    lockfiles.push(name);
    for (const entry of locked) {
      coordinates.push({
        ecosystem: entry.ecosystem,
        name: entry.name,
        version: entry.version,
        source: dirLabel === "." ? name : `${dirLabel}/${name}`,
      });
    }
  }
  for (const unread of UNREAD_LOCKFILES) {
    try {
      statSync(path.join(dirAbs, unread.name));
      notes.push(unread.why);
    } catch {
      // Absent, which is the ordinary case and not worth a note.
    }
  }
  if (refused.length > 0) {
    notes.push(
      `${refused.join(", ")} resolves outside the workspace root (a symlink out of it), so it was NOT read — its packages were not audited`,
    );
  }
  return { coordinates, lockfiles, notes, refused };
}

/** The band a finding sorts and filters by, from whichever source has one. */
function bandOf(rating: CvssRating | undefined, label: string | undefined): Band {
  const source = (rating ?? label ?? "").toUpperCase();
  switch (source) {
    case "CRITICAL":
      return "critical";
    case "HIGH":
      return "high";
    case "MEDIUM":
    case "MODERATE":
      return "medium";
    case "LOW":
      return "low";
    default:
      return "unknown";
  }
}

export const dependencyAudit: RegisteredTool = buildTool({
  name: "DependencyAudit",
  operativeArgs: [
    { field: "cwd", kind: "path", default: "." },
    { field: "endpoint", kind: "url" },
  ],
  description:
    "Read a project's lockfile and ask the public OSV database whether any locked version falls inside a range a published advisory declares affected, returning the severity, the affected range and the fixed version where OSV records one. Use it before trusting a dependency tree you did not install yourself. Read the limit in the result and do not round it up: a match means this VERSION IS IN AN AFFECTED RANGE, not that the vulnerable code is reachable from this project — nothing here analyses call paths, and `reachabilityAnalyzed` is always false. It reads bun.lock, package-lock.json, npm-shrinkwrap.json, yarn.lock and Cargo.lock; a pnpm, Python or Go lockfile beside them is reported as NOT audited rather than passed over in silence. Queries are batched, and a database that cannot be reached is an error rather than an empty, reassuring answer.",
  inputSchema: z.object({
    cwd: z
      .string()
      .optional()
      .describe("directory holding the lockfile; defaults to the working directory"),
    ecosystems: z
      .array(z.enum(["npm", "cargo"]))
      .max(2)
      .optional()
      .describe("audit only these ecosystems"),
    minSeverity: severityField,
    maxPackages: z.number().int().positive().max(LIMITS.packages).optional(),
    maxAdvisories: z.number().int().positive().max(500).optional(),
    endpoint: z
      .string()
      .optional()
      .describe(
        "a self-hosted OSV mirror; its origin must already be in the operator's tool_config.fetch allow-list",
      ),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
  }),
  scope: "external",
  ioCapability: "network",
  readOnly: true,
  concurrencySafe: true,
  execute: async (input, ctx) => {
    const dirLabel = input.cwd ?? ".";
    const dir = resolveInside("DependencyAudit", dirLabel);
    if (!dir.ok) return dir.message;
    try {
      if (!statSync(dir.value).isDirectory()) {
        return `DependencyAudit refused "${dirLabel}": it is not a directory.`;
      }
    } catch {
      return `DependencyAudit refused "${dirLabel}": nothing exists at that path.`;
    }

    const read = readCoordinates(dir.value, dirLabel);
    if (read.lockfiles.length === 0) {
      return `DependencyAudit found no readable lockfile in "${dirLabel}". It reads ${LOCKFILES.join(", ")}.${read.notes.length > 0 ? ` ${read.notes.join(" ")}` : ""}`;
    }
    const wanted =
      input.ecosystems === undefined ? undefined : new Set<LockEcosystem>(input.ecosystems);
    const selected = read.coordinates.filter(
      (c) => wanted === undefined || wanted.has(c.ecosystem),
    );
    if (selected.length === 0) {
      // "Nothing to query" and "nothing matched" are different facts, and
      // neither of them is "clean" — so both are refusals rather than a
      // result whose zero counts a caller would read as a pass.
      return wanted === undefined
        ? `DependencyAudit read ${read.lockfiles.join(", ")} but found no locked package in ${read.lockfiles.length > 1 ? "them" : "it"}, so nothing was queried.`
        : `DependencyAudit read ${read.lockfiles.join(", ")} but no package matched the requested ecosystems (${[...wanted].join(", ")}), so nothing was queried.`;
    }

    const decision = await resolveEndpoint(input.endpoint);
    if (!decision.ok) return `DependencyAudit refused the endpoint: ${decision.reason}`;

    const limit = input.maxPackages ?? DEFAULTS.packages;
    const batch = capped(selected, limit);
    const budget = {
      base: decision.base,
      timeoutMs: input.timeoutMs ?? DEFAULTS.timeoutMs,
      ...(ctx?.signal === undefined ? {} : { signal: ctx.signal }),
    };

    const { hits, batches } = await queryBatches(budget, batch.items);
    const ids = [...new Set(hits.flatMap((h) => h.ids))].sort();
    const hydrated = await hydrateAdvisories(budget, ids);
    const notFetched = new Set(hydrated.notFetched);
    const mismatched = new Set(hydrated.mismatched);

    type Row = { band: Band; rank: number; payload: Record<string, unknown> };
    const rows: Row[] = [];
    for (const hit of hits) {
      for (const id of hit.ids) {
        const advisory = hydrated.advisories.get(id);
        const coordinate = hit.coordinate;
        if (advisory === undefined) {
          // The match is real — OSV returned the id — but nothing is known
          // about it here. Reporting the bare match beats dropping it, and
          // the two reasons it can happen are different facts: the record was
          // never asked for, or it was asked for and not served.
          rows.push({
            band: "unknown",
            rank: severityRank(undefined, undefined),
            payload: {
              id,
              package: {
                ecosystem: coordinate.ecosystem,
                name: coordinate.name,
                version: coordinate.version,
                lockfile: coordinate.source,
              },
              versionInAffectedRange: true,
              reachabilityAnalyzed: false,
              detailsUnavailable: notFetched.has(id)
                ? `more than ${MAX_HYDRATIONS} distinct advisories matched, so this one's record was never requested and no severity, range or fix could be reported`
                : mismatched.has(id)
                  ? "the record served for this id named a DIFFERENT advisory, so it was discarded rather than attributed here; no severity, range or fix could be reported"
                  : "OSV matched this advisory but did not serve its record, so no severity, range or fix could be reported",
            },
          });
          continue;
        }
        const affected = affectedFor(
          advisory,
          coordinate.ecosystem,
          coordinate.name,
          coordinate.version,
        );
        const band = bandOf(advisory.severity.rating, advisory.severity.label);
        rows.push({
          band,
          rank: severityRank(advisory.severity.baseScore, advisory.severity.label),
          payload: {
            id: advisory.id,
            ...(advisory.aliases.length > 0 ? { aliases: advisory.aliases } : {}),
            ...(advisory.summary === undefined ? {} : { summary: advisory.summary }),
            package: {
              ecosystem: coordinate.ecosystem,
              name: coordinate.name,
              version: coordinate.version,
              lockfile: coordinate.source,
            },
            severity: advisory.severity,
            versionInAffectedRange: true,
            ...(affected.matchedByVersionList ? { versionListedExplicitly: true } : {}),
            ...(affected.affectedRange === undefined
              ? {}
              : { affectedRange: affected.affectedRange }),
            ...(affected.fixedVersion === undefined ? {} : { fixedVersion: affected.fixedVersion }),
            ...(affected.fixedVersion === undefined && affected.fixedVersionsReported.length > 0
              ? {
                  fixedVersionsReported: affected.fixedVersionsReported,
                  rangeNote:
                    "the advisory declares more than one affected range and the one holding this version could not be identified, so every fixed version it records is listed instead of a single upgrade target",
                }
              : {}),
            ...(affected.unevaluatedRangeTypes.length > 0
              ? {
                  unevaluatedRangeTypes: affected.unevaluatedRangeTypes,
                }
              : {}),
            ...(advisory.withdrawn === undefined
              ? {}
              : {
                  withdrawn: advisory.withdrawn,
                  withdrawnNote:
                    "this advisory has been withdrawn upstream; the match still stands but the advisory itself may no longer be considered valid",
                }),
            reachabilityAnalyzed: false,
          },
        });
      }
    }

    const filtered = atLeast(rows, input.minSeverity);
    // Code-unit order, not `localeCompare`: the collator is the runtime's
    // default locale and ICU build, so `Inflector` before `inflector` on one
    // machine and after it on another. That is not only a cosmetic wobble —
    // `maxAdvisories` truncates this list, so the ORDER decides which matches
    // are reported at all. `sortFindings` in lib/workflow.ts compares the same
    // way for the same reason.
    const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    const sorted = [...filtered.kept].sort(
      (a, b) =>
        a.rank - b.rank ||
        byText(
          String((a.payload["package"] as { name: string }).name),
          String((b.payload["package"] as { name: string }).name),
        ) ||
        byText(String(a.payload["id"]), String(b.payload["id"])),
    );
    const shown = capped(sorted, input.maxAdvisories ?? DEFAULTS.advisories);

    const notes = [...read.notes];
    if (batch.truncated) {
      notes.push(
        `only the first ${limit} of ${selected.length} locked packages were queried; raise maxPackages or audit a narrower directory — the rest were NOT audited`,
      );
    }
    const paged = hits.filter((h) => h.morePages).map((h) => h.coordinate.name);
    if (paged.length > 0) {
      notes.push(
        `OSV paginated its answer for ${paged.join(", ")}; only the first page of advisory ids was read`,
      );
    }
    if (hydrated.notFetched.length > 0) {
      notes.push(
        `${ids.length} distinct advisories matched, over the ${MAX_HYDRATIONS} this tool fetches records for; ${hydrated.notFetched.length} are reported as matches with no detail. Narrow the audit with maxPackages or ecosystems.`,
      );
    }
    if (hydrated.unresolved.length > 0) {
      notes.push(
        `${hydrated.unresolved.length} advisory record(s) could not be fetched: ${hydrated.unresolved.slice(0, 10).join(", ")}`,
      );
    }
    if (hydrated.mismatched.length > 0) {
      notes.push(
        `${hydrated.mismatched.length} advisory record(s) came back naming a different id than the one requested and were discarded rather than attributed to it: ${hydrated.mismatched.slice(0, 10).join(", ")}`,
      );
    }

    return json({
      lockfiles: read.lockfiles,
      packagesQueried: batch.items.length,
      packagesFound: selected.length,
      batches,
      endpoint: decision.base,
      // A "match" is one (package, advisory) PAIR. One advisory covering four
      // locked packages is four matches, and one package matching three
      // advisories is three — collapsing either into a single number would
      // make the count mean something different depending on the lockfile.
      matchCount: rows.length,
      packagesWithMatches: hits.length,
      distinctAdvisories: ids.length,
      noAdvisoriesMatched: rows.length === 0,
      reportedMatches: shown.items.length,
      ...(shown.truncated ? { reportTruncated: true } : {}),
      ...(input.minSeverity === undefined
        ? {}
        : { minSeverity: input.minSeverity, unratedKeptByFilter: filtered.unrankedKept }),
      matches: shown.items.map((r) => r.payload),
      ...(notes.length > 0 ? { notes } : {}),
      method:
        "each locked (ecosystem, name, version) was matched against OSV's affected ranges. A match means the version falls inside a range a published advisory declares affected — NOT that the vulnerable code is reachable from this project, which nothing here analyses. `noAdvisoriesMatched` means no advisory matched the packages that were queried; packages listed in `notes` as not audited are not covered by it.",
    });
  },
});

// ---------------------------------------------------------------------------
// CiWorkflowAudit

const WORKFLOW_DIR = ".github/workflows";
const WORKFLOW_EXT = /\.ya?ml$/i;

/** The workflow files under a directory, sorted, capped, never recursive. */
function workflowFilesIn(
  dirAbs: string,
  dirLabel: string,
): { files: Array<{ rel: string; abs: string }>; refused: string[] } {
  // GitHub itself reads only the top level of .github/workflows — a file in a
  // subdirectory there is not a workflow — so recursing would audit files the
  // runner never executes and report findings nobody can act on.
  const out: Array<{ rel: string; abs: string }> = [];
  const refused: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dirAbs);
  } catch {
    return { files: out, refused };
  }
  for (const name of entries.sort()) {
    if (!WORKFLOW_EXT.test(name)) continue;
    const abs = path.join(dirAbs, name);
    const rel = dirLabel === "." ? name : `${dirLabel}/${name}`;
    // `statSync` follows the link, so a `x.yml -> /etc/anything` passes
    // `isFile()`. The same file is refused when the caller names it in
    // `path`; it has to be refused here too, or the boundary is only a
    // boundary for people who type the path out.
    if (!contained("CiWorkflowAudit", abs)) {
      refused.push(rel);
      continue;
    }
    try {
      if (!statSync(abs).isFile()) continue;
    } catch {
      continue;
    }
    out.push({ rel, abs });
    if (out.length >= LIMITS.workflowFiles) break;
  }
  return { files: out, refused };
}

const BAND_OF_SEVERITY: Record<Severity, Band> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
};

export const ciWorkflowAudit: RegisteredTool = buildTool({
  name: "CiWorkflowAudit",
  description:
    "Parse GitHub Actions workflow YAML and report supply-chain hygiene, with the file, job, step and LINE of each finding: an action referenced by a mutable tag or branch rather than a commit SHA, a privileged trigger (pull_request_target, workflow_run) combined with a checkout of the pull request's own head, permissions broader than the job needs, a self-hosted runner reachable from a fork's pull request, and `${{ github.event.* }}` interpolated into a run: script — the Actions runner substitutes that value before the shell parses the line, so an issue title becomes part of the script. Use it on any repository whose CI you did not write. Entirely offline: it never resolves a tag to a SHA, so a ref that is not a 40-character commit is reported as mutable rather than classified as a tag or a branch. Constructs its YAML reader does not cover come back as warnings rather than as silence.",
  inputSchema: z.object({
    path: z
      .string()
      .optional()
      .describe(`a workflow file or a directory of them; defaults to ${WORKFLOW_DIR}`),
    rules: z
      .array(z.enum(RULE_IDS))
      .max(RULE_IDS.length)
      .optional()
      .describe("run only these rules; defaults to all of them"),
    repositoryVisibility: z
      .enum(["public", "private", "unknown"])
      .optional()
      .describe(
        "whether outsiders can open pull requests here; the self-hosted runner rule cannot be settled without it",
      ),
    minSeverity: severityField,
    maxFindings: z.number().int().positive().max(1_000).optional(),
    includeInventory: z
      .boolean()
      .optional()
      .describe("also return every `uses:` reference with its pin state"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const given = input.path ?? WORKFLOW_DIR;
    const resolved = resolveInside("CiWorkflowAudit", given);
    if (!resolved.ok) return resolved.message;
    let isDirectory: boolean;
    try {
      isDirectory = statSync(resolved.value).isDirectory();
    } catch {
      return input.path === undefined
        ? `CiWorkflowAudit found no ${WORKFLOW_DIR} directory here. Pass \`path\` if the workflows live somewhere else.`
        : `CiWorkflowAudit refused "${given}": nothing exists at that path.`;
    }
    const scan = isDirectory
      ? workflowFilesIn(resolved.value, given)
      : { files: [{ rel: given, abs: resolved.value }], refused: [] as string[] };
    const files = scan.files;
    if (files.length === 0) {
      return `CiWorkflowAudit found no readable .yml or .yaml file in "${given}", so nothing was audited.${
        scan.refused.length > 0
          ? ` ${scan.refused.length} file(s) were refused for resolving outside the workspace root: ${scan.refused.join(", ")}.`
          : ""
      }`;
    }

    const visibility: RepositoryVisibility = input.repositoryVisibility ?? "unknown";
    const rules = input.rules as ReadonlyArray<RuleId> | undefined;
    const findings: Finding[] = [];
    const warnings: Array<Record<string, unknown>> = [];
    const inventory: Array<Record<string, unknown>> = [];
    const unreadable: string[] = [];
    let jobCount = 0;
    let stepCount = 0;
    let pinnedCount = 0;
    let referenceCount = 0;
    let runnersUndetermined = 0;

    for (const file of files) {
      const text = readTextFile(file.abs, LIMITS.workflowBytes);
      if (text === undefined) {
        unreadable.push(file.rel);
        continue;
      }
      const wf = readWorkflow(file.rel, text);
      jobCount += wf.jobs.length;
      for (const job of wf.jobs) stepCount += job.steps.length;
      for (const warning of wf.warnings) {
        warnings.push({
          file: file.rel,
          line: warning.line,
          code: warning.code,
          message: warning.message,
        });
      }
      for (const entry of inventoryUses(wf)) {
        referenceCount += 1;
        if (entry.ref.pinned) pinnedCount += 1;
        if (input.includeInventory === true) {
          inventory.push({
            file: file.rel,
            line: entry.line,
            job: entry.job,
            ...(entry.step === undefined ? {} : { step: entry.step }),
            uses: entry.ref.raw,
            kind: entry.ref.kind,
            refKind: entry.ref.refKind,
            pinned: entry.ref.pinned,
          });
        }
      }
      for (const job of wf.jobs) {
        // A runner this file cannot classify is counted, never reported as a
        // finding and never reported as clean: `runs-on: ${{ matrix.os }}` is
        // the common case and a finding on every one of them is noise.
        const runsOn =
          job.node.kind === "map" ? job.node.entries.find((e) => e.key === "runs-on") : undefined;
        if (runsOn !== undefined && classifyRunsOn(runsOn.value) === "undetermined") {
          runnersUndetermined += 1;
        }
      }
      findings.push(
        ...auditWorkflow(wf, {
          ...(rules === undefined ? {} : { rules }),
          repositoryVisibility: visibility,
        }),
      );
    }

    const banded = findings.map((f) => ({ band: BAND_OF_SEVERITY[f.severity], finding: f }));
    const filtered = atLeast(banded, input.minSeverity);
    const ordered = sortFindings(filtered.kept.map((b) => b.finding));
    const suppressed = findings.length - ordered.length;
    const shown = capped(ordered, input.maxFindings ?? DEFAULTS.findings);
    const bySeverity: Record<string, number> = {};
    for (const finding of ordered) {
      bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
    }
    const conditional = ordered.filter((f) => f.conditionalOn !== undefined).length;

    return json({
      files: files.map((f) => f.rel),
      workflows: files.length - unreadable.length,
      jobs: jobCount,
      steps: stepCount,
      actionReferences: referenceCount,
      actionsPinnedToCommit: pinnedCount,
      rulesRun: rules ?? RULE_IDS,
      repositoryVisibility: visibility,
      findingCount: ordered.length,
      bySeverity,
      ...(conditional > 0 ? { conditionalFindings: conditional } : {}),
      // Counted BEFORE `minSeverity`, so a threshold cannot manufacture a
      // clean answer. With the filtered count here, `minSeverity: "critical"`
      // over five medium findings returned `noFindings: true` and nothing
      // else in the object said a filter had run — a harness gating on this
      // field read a suppressed report as a passing one. `DependencyAudit`
      // already counted its matches before filtering; this is the same rule.
      noFindings: findings.length === 0,
      ...(input.minSeverity === undefined
        ? {}
        : { minSeverity: input.minSeverity, findingsBelowMinSeverity: suppressed }),
      findings: shown.items,
      ...(shown.truncated ? { findingsTruncated: true } : {}),
      ...(runnersUndetermined > 0 ? { runnersUndetermined } : {}),
      ...(unreadable.length > 0 ? { unreadableFiles: unreadable } : {}),
      ...(scan.refused.length > 0 ? { refusedFiles: scan.refused } : {}),
      ...(warnings.length > 0 ? { parseWarnings: warnings.slice(0, 100) } : {}),
      ...(input.includeInventory === true ? { inventory } : {}),
      method:
        'static parsing only; no tag was resolved to a commit, so `refKind: "mutable"` covers both a tag and a branch. A finding carrying `conditionalOn` depends on a fact outside these files and is not a claim on its own. `noFindings` means the enabled rules found nothing in the files listed BEFORE any `minSeverity` filter — `findingCount` and `findings` are what survived it, and `findingsBelowMinSeverity` says how many did not. Read `parseWarnings`, which names anything the YAML reader could not account for.',
    });
  },
});

/** Every tool this package registers, in the order a catalog should list them. */
export const SUPPLYCHAIN_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  ciWorkflowAudit,
  dependencyAudit,
]);
