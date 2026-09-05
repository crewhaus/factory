import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Item 49 — scope-audit drift watch: the persistence + baseline-diff +
 * boundary-drift core behind `crewhaus doctor --philosophy-alignment
 * --json/--baseline/--accept-baseline`, factored out of the entry file
 * `index.ts` (which runs a top-level argv switch and so cannot be imported
 * by a test without executing the CLI). Side-effect-free on import and
 * directly unit-testable, mirroring `scope-audit.ts` / `security-digest.ts`.
 *
 * The problem this closes: `doctor --philosophy-alignment` audited boundary
 * call sites and tool scopes but was run-and-forget print-only — a
 * regression (or a NEW un-classified ingress) looked identical to
 * known-accepted findings, so nobody could gate CI on it. Three pieces:
 *
 *   1. Stable finding identity. Every audit finding now carries a
 *      (class, file, symbol) triple; `findingId` hashes it so a finding
 *      keeps its id across runs even when the human-facing label or reason
 *      wording changes. Labels/reasons are deliberately NOT hashed. Renaming
 *      or moving a file (or renaming a symbol) mints a NEW id by design —
 *      the gate fails closed on the "new" finding and the baseline must be
 *      re-accepted with --accept-baseline.
 *
 *   2. Baselined diffs, following `@crewhaus/regression-runner`'s `gate()`
 *      shape (verdict + reason + report). `diffScopeAuditSnapshots` splits
 *      current findings into new / accepted / resolved against
 *      `.crewhaus/scope-audit/baseline.json`; the verdict fails ONLY on new
 *      findings — legacy accepted findings never block, so the gate can be
 *      adopted on a repo with known warts.
 *
 *   3. Boundary-site drift detection. The audit's canonical boundary list
 *      is hardcoded (six sites in index.ts) and checks only that KNOWN
 *      sites still call `classifyBoundary`; nothing caught a NEW
 *      cross-trust ingress that skipped classification. `detectBoundaryDrift`
 *      extends the same mechanism (read package sources, substring-match)
 *      with a small set of conservative ingress signals derived from the
 *      boundary-classifier TrustOrigin taxonomy, and flags packages that
 *      match a signal but never reference the classification fabric.
 *      Findings are REPORT-ONLY (warn, pass: true) in plain mode; only the
 *      --baseline gate fails on them, and only when they are NEW.
 */

/** Finding classes the philosophy audit emits. `boundary-drift` is the new
 *  detector; the rest map 1:1 onto the pre-existing printed checks. */
export type PhilosophyFindingClass =
  | "pillar-doc"
  | "package-presence"
  | "boundary-site"
  | "tool-scope"
  | "contributor-doc"
  | "boundary-drift";

export type PhilosophyFinding = {
  readonly class: PhilosophyFindingClass;
  /** Repo-relative path the finding is about ("" for repo-level checks). */
  readonly file: string;
  /** Stable symbol within (class, file) — a site/tool/signal name. */
  readonly symbol: string;
  readonly label: string;
  readonly pass: boolean;
  /** warn+pass renders as "~" — informational, never fails plain doctor. */
  readonly warn?: boolean;
  readonly reason?: string;
};

/**
 * Stable finding id: sha256 over the (class, file, symbol) identity triple,
 * truncated to 12 hex chars (48 bits — collision-safe at this cardinality
 * and short enough to read in a diff). Labels and reasons are excluded on
 * purpose: rewording a message must not orphan a baselined finding.
 *
 * The NUL separator makes the triple unambiguous (no field can contain it).
 * It MUST stay the `\u0000` ESCAPE SEQUENCE in this source: a literal NUL
 * byte makes git treat the whole module as a binary blob (unreviewable
 * diffs) and invites silent id-invalidation by NUL-stripping tools. The
 * escape and the literal produce identical runtime bytes, so every existing
 * findingId and accepted baseline stays valid — scope-audit-drift.test.ts
 * pins both the source byte-hygiene and a known id value.
 */
export function findingId(f: Pick<PhilosophyFinding, "class" | "file" | "symbol">): string {
  return createHash("sha256")
    .update(`${f.class}\u0000${f.file}\u0000${f.symbol}`)
    .digest("hex")
    .slice(0, 12);
}

/** A finding as persisted in a snapshot/baseline file. */
export type PersistedFinding = PhilosophyFinding & { readonly id: string };

export type ScopeAuditSnapshot = {
  readonly version: 1;
  readonly generatedAt: string;
  /** Actionable findings only — see `isActionableFinding`. */
  readonly findings: ReadonlyArray<PersistedFinding>;
};

export const SCOPE_AUDIT_RELPATH = ".crewhaus/scope-audit";
export const SCOPE_AUDIT_BASELINE_FILENAME = "baseline.json";

export function scopeAuditDir(rootDir: string): string {
  return join(rootDir, SCOPE_AUDIT_RELPATH);
}

export function scopeAuditBaselinePath(rootDir: string): string {
  return join(scopeAuditDir(rootDir), SCOPE_AUDIT_BASELINE_FILENAME);
}

/** Dated snapshot path: `.crewhaus/scope-audit/<YYYY-MM-DD>.json` (UTC).
 *  Re-running on the same day overwrites — the snapshot is a deterministic
 *  function of the tree, so the latest run of the day is the record. */
export function scopeAuditSnapshotPath(rootDir: string, now: () => number): string {
  return join(scopeAuditDir(rootDir), `${new Date(now()).toISOString().slice(0, 10)}.json`);
}

/**
 * What gets persisted (and therefore baselined/gated): hard failures, plus
 * boundary-drift reports (which are warn-tier in plain mode but exactly the
 * findings the drift watch exists to gate). Green checks and benign
 * environment warns (e.g. "sibling ../docs not cloned") are excluded — they
 * are not findings, and baselining them would make an absent docs checkout
 * flip the gate.
 */
export function isActionableFinding(f: PhilosophyFinding): boolean {
  return !f.pass || f.class === "boundary-drift";
}

export function buildScopeAuditSnapshot(
  findings: ReadonlyArray<PhilosophyFinding>,
  now: () => number = () => Date.now(),
): ScopeAuditSnapshot {
  const actionable = findings
    .filter(isActionableFinding)
    .map((f) => ({ ...f, id: findingId(f) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { version: 1, generatedAt: new Date(now()).toISOString(), findings: actionable };
}

/** Thrown on a malformed baseline/snapshot file. The CLI routes it through
 *  `die()` — a gate whose accepted-set is unreadable must fail loudly, not
 *  silently treat everything (or nothing) as new. */
export class ScopeAuditBaselineError extends Error {
  override readonly name = "ScopeAuditBaselineError";
}

/** Read + validate a snapshot file; undefined when it does not exist. */
export function loadScopeAuditSnapshot(path: string): ScopeAuditSnapshot | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ScopeAuditBaselineError(
      `${path} is not valid JSON (${(err as Error).message}) — re-accept with --accept-baseline`,
    );
  }
  const snap = parsed as { version?: unknown; findings?: unknown };
  if (snap.version !== 1 || !Array.isArray(snap.findings)) {
    throw new ScopeAuditBaselineError(
      `${path} is not a v1 scope-audit snapshot — re-accept with --accept-baseline`,
    );
  }
  return parsed as ScopeAuditSnapshot;
}

/** Gate verdict, following regression-runner's `gate()` shape
 *  (verdict / reason / report arrays). */
export type ScopeAuditGateVerdict = {
  readonly verdict: "pass" | "fail";
  readonly reason?: string;
  /** In current but not the baseline — the ONLY thing that fails the gate. */
  readonly newFindings: ReadonlyArray<PersistedFinding>;
  /** In both — legacy accepted findings; never block. */
  readonly acceptedFindings: ReadonlyArray<PersistedFinding>;
  /** In the baseline but no longer current — fixed since acceptance. */
  readonly resolvedFindings: ReadonlyArray<PersistedFinding>;
};

/**
 * Diff the current snapshot against the last accepted baseline. Identity is
 * the stable finding id, so wording changes don't churn the diff. A missing
 * baseline (`undefined`) fails IF there is anything to accept — a gate that
 * silently passed forever because nobody ever ran --accept-baseline would
 * fabricate assurance — and passes on a genuinely clean tree.
 */
export function diffScopeAuditSnapshots(
  baseline: ScopeAuditSnapshot | undefined,
  current: ScopeAuditSnapshot,
): ScopeAuditGateVerdict {
  if (baseline === undefined) {
    if (current.findings.length === 0) {
      return { verdict: "pass", newFindings: [], acceptedFindings: [], resolvedFindings: [] };
    }
    return {
      verdict: "fail",
      reason: `no accepted baseline and ${current.findings.length} finding(s) present — review them and run \`crewhaus doctor --philosophy-alignment --accept-baseline\``,
      newFindings: [...current.findings],
      acceptedFindings: [],
      resolvedFindings: [],
    };
  }
  const baselineById = new Map(baseline.findings.map((f) => [f.id, f]));
  const currentIds = new Set(current.findings.map((f) => f.id));
  const newFindings = current.findings.filter((f) => !baselineById.has(f.id));
  const acceptedFindings = current.findings.filter((f) => baselineById.has(f.id));
  const resolvedFindings = baseline.findings.filter((f) => !currentIds.has(f.id));
  if (newFindings.length > 0) {
    return {
      verdict: "fail",
      reason: `${newFindings.length} NEW finding(s) not in the accepted baseline (${newFindings
        .map((f) => f.id)
        .join(", ")})`,
      newFindings,
      acceptedFindings,
      resolvedFindings,
    };
  }
  return { verdict: "pass", newFindings, acceptedFindings, resolvedFindings };
}

// ---------------------------------------------------------------------------
// Boundary-site drift detection
// ---------------------------------------------------------------------------

/**
 * Markers that a package participates in the classification fabric. Any of
 * these appearing in a package's sources exempts it from drift findings:
 *   - classifyBoundary / boundary-classifier — the chokepoint itself;
 *   - classifyInbound — channel-adapter-base's wrapper around it;
 *   - chain-adapter-base — whose shared ingress helper classifies centrally,
 *     so concrete chain adapters routing through it are covered.
 * Same substring mechanism as the existing six-site check in index.ts.
 */
const CLASSIFICATION_MARKERS = [
  "classifyBoundary",
  "boundary-classifier",
  "classifyInbound",
  "chain-adapter-base",
] as const;

type DriftSignal = {
  /** Stable symbol for the finding id. */
  readonly symbol: string;
  /** TrustOrigin the ingress maps to (documentation only). */
  readonly origin: string;
  readonly description: string;
  /** Substring the package's concatenated sources must contain… */
  readonly contentNeedle?: string;
  /** …or a package-directory-name pattern. Exactly one of the two is set. */
  readonly packagePattern?: RegExp;
};

/**
 * Conservative cross-trust ingress signals, derived from the
 * boundary-classifier TrustOrigin taxonomy. Deliberately small: each signal
 * is a strong indicator that server/peer/user-controlled content enters the
 * process. (Weak signals — e.g. the literal "SKILL.md", which appears in
 * emitters and doc comments across the tree — are excluded; the baseline
 * mechanism handles honest false positives, but the detector should not
 * manufacture them.)
 */
const DRIFT_SIGNALS: ReadonlyArray<DriftSignal> = [
  {
    symbol: "mcp-sdk-ingress",
    origin: "mcp",
    description: "imports the raw MCP SDK (server-controlled payloads enter here)",
    contentNeedle: "@modelcontextprotocol/",
  },
  {
    symbol: "federation-peer-ingress",
    origin: "federation",
    description: "consumes federation peer payloads (mTLS authenticates WHO, not WHAT)",
    contentNeedle: "@crewhaus/federation-protocol",
  },
  {
    symbol: "channel-inbound-ingress",
    origin: "channel",
    description: "normalizes inbound channel webhooks/messages",
    packagePattern: /^channel-adapter-(?!base$).+/,
  },
  {
    symbol: "chain-content-ingress",
    origin: "chain",
    description: "decodes chain RPC/event content",
    packagePattern: /^chain-adapter-(?!base$).+/,
  },
  // 0.6.0 §10.1 — a nested model side call in the "consult" role (Consult,
  // guide, verifier): its reply is a roster sibling's output shaped by
  // whatever the question carried, and re-enters the parent's context. The
  // needle is the option literal the nested `runChatLoop` is given.
  {
    symbol: "consult-reply-ingress",
    origin: "consult",
    description:
      'runs a nested model side call in the "consult" role whose reply re-enters the parent context',
    contentNeedle: 'modelRole: "consult"',
  },
];

/** Concatenate a package's non-test .ts sources (recursively under src/). */
function readPackageSources(srcDir: string): string {
  const chunks: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue; // raced away / unreadable — skip, never crash the audit
      }
      if (isDir) {
        walk(full);
      } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
        try {
          chunks.push(readFileSync(full, "utf8"));
        } catch {
          // Unreadable source — skip; the audit reports on what it can see.
        }
      }
    }
  };
  walk(srcDir);
  return chunks.join("\n");
}

/**
 * Scan `<repoRoot>/packages/<name>/src` for cross-trust ingress signals and
 * flag packages that match one but never reference the classification
 * fabric ({@link CLASSIFICATION_MARKERS}). Report-only by design: findings
 * come back `pass: true, warn: true` so plain `doctor --philosophy-alignment`
 * keeps exiting 0 on them; the --baseline gate is what fails, and only on
 * findings that are NEW relative to the accepted baseline.
 *
 * Returns [] when `<repoRoot>/packages` does not exist (the audit is
 * factory-repo-shaped, like the six-site check it extends).
 */
export function detectBoundaryDrift(repoRoot: string): PhilosophyFinding[] {
  const packagesDir = join(repoRoot, "packages");
  if (!existsSync(packagesDir)) return [];
  const findings: PhilosophyFinding[] = [];
  for (const pkgName of readdirSync(packagesDir).sort()) {
    const srcDir = join(packagesDir, pkgName, "src");
    if (!existsSync(srcDir)) continue;
    const source = readPackageSources(srcDir);
    if (source === "") continue;
    const classified = CLASSIFICATION_MARKERS.some((m) => source.includes(m));
    if (classified) continue;
    for (const signal of DRIFT_SIGNALS) {
      const matches =
        signal.contentNeedle !== undefined
          ? source.includes(signal.contentNeedle)
          : (signal.packagePattern as RegExp).test(pkgName);
      if (!matches) continue;
      const file = `packages/${pkgName}/src`;
      findings.push({
        class: "boundary-drift",
        file,
        symbol: signal.symbol,
        label: `Pillar 3 drift — ${pkgName} ${signal.description} without classifyBoundary`,
        pass: true,
        warn: true,
        reason: `${file} matches the "${signal.symbol}" cross-trust ingress signal (origin: ${signal.origin}) but never references the boundary-classification fabric — a new ingress that skips classifyBoundary is a security regression (AGENTS.md Pillar 3). If this ingress is classified downstream by design, accept it into the baseline with --accept-baseline.`,
      });
    }
  }
  return findings;
}

/** Render the gate verdict as the CLI's summary lines (baseline mode). */
export function renderGateReport(diff: ScopeAuditGateVerdict): ReadonlyArray<string> {
  const lines: string[] = [];
  for (const f of diff.newFindings) {
    lines.push(`✗ NEW [${f.id}] ${f.label}${f.reason !== undefined ? ` — ${f.reason}` : ""}`);
  }
  for (const f of diff.acceptedFindings) {
    lines.push(`• accepted [${f.id}] ${f.label}`);
  }
  for (const f of diff.resolvedFindings) {
    lines.push(
      `✓ resolved [${f.id}] ${f.label} — no longer present; re-accept to shrink the baseline`,
    );
  }
  lines.push(
    `baseline gate: ${diff.verdict}${diff.reason !== undefined ? ` — ${diff.reason}` : ""} ` +
      `(${diff.newFindings.length} new, ${diff.acceptedFindings.length} accepted, ${diff.resolvedFindings.length} resolved)`,
  );
  return lines;
}
