/**
 * G63 — `crewhaus failures report`. Aggregates terminal-failure signals across
 * a harness's sessions and incidents, clusters them by `FailureClass` + message
 * similarity, and (optionally) drafts `failure_taxonomy` entries a human can
 * paste into their spec.
 *
 * Two durable signals feed it (both read by the CLI handler; this module is a
 * pure, side-effect-free transform over the parsed records so it is unit-
 * testable):
 *   - `run_failed` events in `.crewhaus/sessions/<id>.jsonl` — the ONE failure
 *     each run died with (payload `{ class, message, remediation?, exitCode }`).
 *   - incident bundle manifests in `.crewhaus/incidents/<ts>-<kind>/bundle.json`
 *     (`{ kind, sessionId, reason, ... }`) — auto-assembled on a failure trigger.
 *
 * Message similarity uses normalized-token Jaccard (dependency-free, offline,
 * deterministic) rather than an embedder: a report command must never spend
 * tokens or need credentials, and failure messages are short and templated, so
 * token overlap clusters them well. The drafting reuses `advise-rules`'
 * `FailureTaxonomyEntry` shape + specificity floor so a drafted pattern is
 * exactly what `optimize --from-advice` / the recovery engine already accept.
 */
import { type FailureTaxonomyEntry, taxonomyPatternTooBroad } from "./advise-rules";

/** The `run_failed` class values are the errors package's `FailureClass`; an
 *  incident contributes its trigger `kind`. Kept as a bare string so this
 *  module never imports the errors/enum surface. */
export type FailureRecord = {
  readonly source: "run_failed" | "incident";
  /** `FailureClass` for a run_failed; the incident trigger kind otherwise. */
  readonly class: string;
  readonly message: string;
  readonly sessionId: string;
  readonly ts?: number;
  readonly exitCode?: number;
};

/** One (class, message-similarity) group. `messages` are the distinct member
 *  messages, used to extract a distinctive pattern for `--propose-taxonomy`. */
export type FailureCluster = {
  readonly class: string;
  readonly count: number;
  /** Distinct session ids the cluster's failures came from. */
  readonly sessions: ReadonlyArray<string>;
  /** The most representative member message (modal, ties → shortest). */
  readonly example: string;
  readonly messages: ReadonlyArray<string>;
  readonly sources: { readonly run_failed: number; readonly incident: number };
  /** Most frequent `exitCode` across the cluster's run_failed members. */
  readonly exitCode?: number;
};

/** `approval_pending` is a resumable PAUSE, not a terminal failure — it is
 *  surfaced by `crewhaus approvals list`, never clustered here. */
export const NON_FAILURE_CLASSES: ReadonlySet<string> = new Set(["approval_pending"]);

const STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "is",
  "was",
  "for",
  "with",
  "and",
  "or",
  "at",
  "on",
  "in",
  "by",
  "it",
  "this",
  "that",
  "from",
  "has",
  "had",
]);

/**
 * Normalize a message into a semantic token set: lowercase, split on
 * non-alphanumerics, and drop volatile/low-signal tokens (pure numbers,
 * long hex/uuid fragments, stopwords, and 1–2 char noise) so two runs that
 * differ only in an id/number/latency cluster together.
 */
export function normalizeTokens(message: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of message.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    if (/^[0-9]+$/.test(raw)) continue; // pure number
    if (raw.length >= 6 && /^[0-9a-f]+$/.test(raw)) continue; // hex / uuid fragment
    tokens.add(raw);
  }
  return tokens;
}

/** Jaccard overlap of two token sets, in [0,1]. Two empty sets → 1 (identical
 *  "no signal" messages cluster together). */
export function tokenSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export const DEFAULT_SIMILARITY_THRESHOLD = 0.5;

type MutableCluster = {
  class: string;
  repTokens: Set<string>;
  members: FailureRecord[];
  messageCounts: Map<string, number>;
  exitCounts: Map<number, number>;
};

/** Pick the modal key (ties broken by the provided comparator → deterministic). */
function modal<K>(counts: Map<K, number>, tieBreak: (a: K, b: K) => number): K | undefined {
  let best: K | undefined;
  let bestCount = -1;
  for (const [key, count] of [...counts.entries()].sort((x, y) => tieBreak(x[0], y[0]))) {
    if (count > bestCount) {
      bestCount = count;
      best = key;
    }
  }
  return best;
}

/**
 * Cluster failure records by exact `class`, then greedily by message
 * similarity within each class (Jaccard ≥ `threshold` against the first
 * member's tokens). Records are sorted deterministically first, so the greedy
 * assignment — and therefore the cluster set — is stable across runs.
 */
export function clusterFailures(
  records: ReadonlyArray<FailureRecord>,
  threshold: number = DEFAULT_SIMILARITY_THRESHOLD,
): FailureCluster[] {
  const kept = records.filter((r) => !NON_FAILURE_CLASSES.has(r.class));
  // Deterministic input order: class, then message, then session, then ts.
  const sorted = [...kept].sort((a, b) => {
    if (a.class !== b.class) return a.class.localeCompare(b.class);
    if (a.message !== b.message) return a.message.localeCompare(b.message);
    if (a.sessionId !== b.sessionId) return a.sessionId.localeCompare(b.sessionId);
    return (a.ts ?? 0) - (b.ts ?? 0);
  });

  const byClass = new Map<string, MutableCluster[]>();
  for (const record of sorted) {
    const tokens = normalizeTokens(record.message);
    const clusters = byClass.get(record.class) ?? [];
    let target = clusters.find((c) => tokenSimilarity(tokens, c.repTokens) >= threshold);
    if (target === undefined) {
      target = {
        class: record.class,
        repTokens: tokens,
        members: [],
        messageCounts: new Map(),
        exitCounts: new Map(),
      };
      clusters.push(target);
      byClass.set(record.class, clusters);
    }
    target.members.push(record);
    target.messageCounts.set(record.message, (target.messageCounts.get(record.message) ?? 0) + 1);
    if (record.exitCode !== undefined) {
      target.exitCounts.set(record.exitCode, (target.exitCounts.get(record.exitCode) ?? 0) + 1);
    }
  }

  const out: FailureCluster[] = [];
  for (const clusters of byClass.values()) {
    for (const c of clusters) {
      const sessions = [...new Set(c.members.map((m) => m.sessionId))].sort();
      // Modal message; ties → shortest, then lexicographic.
      const example =
        modal(c.messageCounts, (a, b) =>
          a.length !== b.length ? a.length - b.length : a.localeCompare(b),
        ) ??
        c.members[0]?.message ??
        "";
      const messages = [...c.messageCounts.keys()].sort();
      const exitCode = modal(c.exitCounts, (a, b) => a - b);
      out.push({
        class: c.class,
        count: c.members.length,
        sessions,
        example,
        messages,
        sources: {
          run_failed: c.members.filter((m) => m.source === "run_failed").length,
          incident: c.members.filter((m) => m.source === "incident").length,
        },
        ...(exitCode !== undefined ? { exitCode } : {}),
      });
    }
  }
  // Rank most-frequent first; ties → class, then example.
  out.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (a.class !== b.class) return a.class.localeCompare(b.class);
    return a.example.localeCompare(b.example);
  });
  return out;
}

/** Truncate for the table's example column without splitting mid-escape. */
function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function padCell(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/** Render the clusters as an aligned table. Empty → a friendly line. */
export function renderFailuresTable(clusters: ReadonlyArray<FailureCluster>): string {
  if (clusters.length === 0) {
    return "no run failures or incidents recorded.\n";
  }
  const header = ["CLASS", "COUNT", "SESSIONS", "EXIT", "EXAMPLE"] as const;
  const rows = clusters.map((c) => [
    c.class,
    String(c.count),
    String(c.sessions.length),
    c.exitCode !== undefined ? String(c.exitCode) : "-",
    truncate(c.example, 64),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: ReadonlyArray<string>): string =>
    cells
      .map((c, i) => padCell(c, widths[i] ?? c.length))
      .join("  ")
      .trimEnd();
  const totalFailures = clusters.reduce((n, c) => n + c.count, 0);
  return `${[
    line(header),
    ...rows.map(line),
    "",
    `${clusters.length} cluster(s), ${totalFailures} failure(s) total.`,
  ].join("\n")}\n`;
}

/**
 * Longest common contiguous substring of two strings (simple DP over short
 * failure messages). The result is guaranteed to be a literal substring of
 * BOTH inputs — exactly what the recovery engine's case-insensitive substring
 * match needs a drafted `pattern` to be.
 */
export function longestCommonSubstring(a: string, b: string): string {
  if (a === "" || b === "") return "";
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  let prev = new Array<number>(bl.length + 1).fill(0);
  let bestLen = 0;
  let bestEndA = 0;
  for (let i = 1; i <= al.length; i++) {
    const curr = new Array<number>(bl.length + 1).fill(0);
    for (let j = 1; j <= bl.length; j++) {
      if (al[i - 1] === bl[j - 1]) {
        curr[j] = (prev[j - 1] ?? 0) + 1;
        if ((curr[j] ?? 0) > bestLen) {
          bestLen = curr[j] ?? 0;
          bestEndA = i;
        }
      }
    }
    prev = curr;
  }
  // Slice from the ORIGINAL `a` to preserve its casing.
  return a.slice(bestEndA - bestLen, bestEndA).trim();
}

/** The stable leading clause of a single message — everything up to the first
 *  volatile boundary (a `:`/`—`/`(` or a run of ≥2 digits), bounded to 60
 *  chars. Used when a cluster has only one distinct message (no LCS to
 *  generalize over). */
export function leadingStableClause(message: string): string {
  const trimmed = message.replace(/\s+/g, " ").trim();
  const boundary = trimmed.search(/[:—(]|\d{2,}/);
  const clause = (boundary > 0 ? trimmed.slice(0, boundary) : trimmed).trim();
  return clause.length > 60 ? clause.slice(0, 60).trim() : clause;
}

/**
 * Extract a distinctive, contiguous pattern for a cluster: the longest common
 * substring across its distinct messages (which generalizes over volatile
 * ids/numbers while staying a literal substring of every member), or — for a
 * single-message cluster — its leading stable clause. Returns `undefined` when
 * nothing distinctive survives.
 */
export function distinctivePattern(messages: ReadonlyArray<string>): string | undefined {
  const distinct = [...new Set(messages.map((m) => m.replace(/\s+/g, " ").trim()))].filter(
    (m) => m !== "",
  );
  if (distinct.length === 0) return undefined;
  if (distinct.length === 1) {
    const clause = leadingStableClause(distinct[0] ?? "");
    return clause === "" ? undefined : clause;
  }
  let common = distinct[0] ?? "";
  for (let i = 1; i < distinct.length && common !== ""; i++) {
    common = longestCommonSubstring(common, distinct[i] ?? "");
  }
  const pattern = common.trim();
  return pattern === "" ? undefined : pattern;
}

/** A cluster whose pattern was too generic to auto-draft (surfaced, not drafted
 *  — mirroring `advise-rules`' F4 behaviour). */
export type TooBroadCluster = {
  readonly class: string;
  readonly count: number;
  readonly example: string;
};

export type TaxonomyProposal = {
  readonly drafts: ReadonlyArray<FailureTaxonomyEntry>;
  readonly tooBroad: ReadonlyArray<TooBroadCluster>;
};

/** Default recovery action per `FailureClass` — CrewHaus's own ceilings and
 *  hard provider failures `fail`; transient/tool failures `retry`; a context
 *  overflow `compact`. A human refines before adopting. */
export function defaultRecoveryFor(cls: string): string {
  switch (cls) {
    case "timeout":
    case "rate_limit":
    case "tool":
      return "retry";
    case "context_overflow":
      return "compact";
    case "billing":
    case "auth":
    case "crewhaus_budget":
    case "evaluation":
    case "spec":
    case "config":
    case "mcp_boot":
      return "fail";
    default:
      return "retry";
  }
}

/**
 * Draft one `failure_taxonomy` entry per cluster whose message yields a
 * distinctive-enough pattern (passes `taxonomyPatternTooBroad`). The `class`
 * is slugged from the observed `FailureClass` (deduped so two clusters of the
 * same class don't collide), the `pattern` is the extracted substring, the
 * `recovery` is the per-class default, and the `hint` carries the evidence +
 * the "matches error.message as a substring — refine before adopting" caveat.
 */
export function proposeTaxonomy(clusters: ReadonlyArray<FailureCluster>): TaxonomyProposal {
  const drafts: FailureTaxonomyEntry[] = [];
  const tooBroad: TooBroadCluster[] = [];
  const usedClasses = new Set<string>();
  for (const cluster of clusters) {
    const pattern = distinctivePattern(cluster.messages);
    if (pattern === undefined || taxonomyPatternTooBroad(pattern)) {
      tooBroad.push({ class: cluster.class, count: cluster.count, example: cluster.example });
      continue;
    }
    // Deterministic, collision-free class name: the observed class, suffixed
    // when a second cluster shares it.
    let name = cluster.class;
    let n = 2;
    while (usedClasses.has(name)) name = `${cluster.class}_${n++}`;
    usedClasses.add(name);
    drafts.push({
      class: name,
      pattern,
      recovery: defaultRecoveryFor(cluster.class),
      hint: `seen ${cluster.count}× across ${cluster.sessions.length} session(s) (crewhaus failures report); matched as a case-insensitive substring of error.message — refine before adopting`,
    });
  }
  return { drafts, tooBroad };
}

/** Render drafted entries as a paste-ready `failure_taxonomy:` YAML block. */
export function renderTaxonomyYaml(proposal: TaxonomyProposal): string {
  const lines: string[] = [];
  if (proposal.drafts.length === 0) {
    lines.push("# no failure_taxonomy entries could be auto-drafted");
  } else {
    lines.push(
      "# suggested failure_taxonomy entries — review each pattern/recovery before adding to your spec",
    );
    lines.push("failure_taxonomy:");
    for (const d of proposal.drafts) {
      lines.push(`  - class: ${yamlScalar(d.class)}`);
      lines.push(`    pattern: ${yamlScalar(d.pattern)}`);
      lines.push(`    recovery: ${yamlScalar(d.recovery)}`);
      if (d.hint !== undefined) lines.push(`    hint: ${yamlScalar(d.hint)}`);
    }
  }
  if (proposal.tooBroad.length > 0) {
    lines.push("");
    lines.push("# too generic to auto-draft — hand-write a distinctive pattern for these:");
    for (const t of proposal.tooBroad) {
      lines.push(`#   ${t.class} (${t.count}×): ${truncate(t.example, 70)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Minimal YAML scalar quoting — always double-quote so colons/`#`/leading
 *  specials in a pattern never break the block. */
function yamlScalar(value: string): string {
  return JSON.stringify(value);
}
