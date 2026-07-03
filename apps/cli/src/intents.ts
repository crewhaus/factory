/**
 * Item 67 — `crewhaus intents`: end-user intent analytics. What are people
 * actually asking the harness, and how well is it serving them?
 *
 * Clusters `user_message` inputs across sessions with the SAME deterministic
 * greedy-Jaccard token clustering the `faq` / `graders suggest` / coverage
 * features use (no model call), then ranks each intent cluster by:
 *
 *   - FREQUENCY:     total occurrences + distinct sessions.
 *   - SATISFACTION:  mean normalized rating of the cluster's rated turns.
 *   - FAILURE RATE:  share of the cluster's turns that hit a struggle signal
 *                    (error / tool-error / loop / retry — mined by the same
 *                    `dataset mine` signals), i.e. an UNMET intent.
 *   - RECENCY:       first vs second half of the session window → a "rising"
 *                    intent asked much more in the recent half.
 *
 * From those it surfaces four views: top intents, rising intents, low-
 * satisfaction intents (down-rated / high-error), and unmet intents (the agent
 * couldn't answer — errors/loops/retries). This is the product-analytics feed
 * for `dataset mine` / `faq distill` / few-shot harvest.
 *
 * Everything here is pure + deterministic (the CLI entry file reads sessions +
 * feedback and PII/secret-redacts the rendered examples via a passed-in
 * callback). No credential/secret text enters a rendered example un-redacted.
 */

import type { FeedbackRecord, LoggedEvent, SessionTurn } from "./feedback";
import { mergeFeedback, normalizeRating } from "./feedback";
import { normalizeEvidenceTokens } from "./graders-suggest";

/** Thrown on malformed inputs / bad flags. The CLI routes it through `die()`. */
export class IntentsError extends Error {
  override readonly name = "IntentsError";
}

/** A per-turn struggle signal, keyed by session#turn — the same set `dataset
 *  mine` recognizes. Supplied by the CLI (from `mineSession`). */
export type TurnSignal = {
  readonly sessionId: string;
  readonly turnNumber: number;
};

/** One user turn tagged with recency (for the rising view) — a SessionTurn plus
 *  a monotonically increasing global ordinal across the scanned window. */
export type OrderedTurn = SessionTurn & {
  /** 0-based position in the chronological scan order (older = smaller). */
  readonly order: number;
};

/** One ranked intent cluster. */
export type Intent = {
  /** The representative question (most-frequent-token, then shortest). */
  readonly representative: string;
  /** Total user turns in this cluster. */
  readonly occurrences: number;
  /** Distinct sessions that asked a question in this cluster. */
  readonly sessionCount: number;
  /** Mean normalized rating [0,1] over rated turns; undefined when none rated. */
  readonly meanRating: number | undefined;
  /** Number of the cluster's turns that hit a struggle signal. */
  readonly failedTurns: number;
  /** failedTurns / occurrences. */
  readonly failureRate: number;
  /** Occurrences in the OLDER half of the window. */
  readonly earlyCount: number;
  /** Occurrences in the RECENT half of the window. */
  readonly recentCount: number;
  /** A few representative example questions (caller redacts before render). */
  readonly examples: readonly string[];
};

export type IntentDigest = {
  readonly totalTurns: number;
  readonly totalSessions: number;
  readonly intents: readonly Intent[];
  readonly topIntents: readonly Intent[];
  readonly risingIntents: readonly Intent[];
  readonly lowSatisfactionIntents: readonly Intent[];
  readonly unmetIntents: readonly Intent[];
};

export type ClusterIntentsOptions = {
  /** Jaccard overlap at/above which a question joins a cluster seed. Default 0.5. */
  readonly threshold?: number;
  /** Rating below which an intent counts as "low satisfaction". Default 0.5. */
  readonly lowSatisfactionBelow?: number;
  /** Failure rate at/above which an intent counts as "unmet". Default 0.34. */
  readonly unmetFailureAtLeast?: number;
  /** How many top/rising/etc. to surface in each view. Default 5. */
  readonly topN?: number;
  /** Max example questions kept per intent. Default 3. */
  readonly examplesPerIntent?: number;
};

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** session#turn composite key — `#` never collides (session ids are hex,
 *  turnNumber an int), so no control/NUL byte enters a map key. */
function turnKey(sessionId: string, turnNumber: number): string {
  return `${sessionId}#${turnNumber}`;
}

type Rec = {
  readonly sessionId: string;
  readonly turnNumber: number;
  readonly question: string;
  readonly order: number;
  readonly rating: number | undefined;
  readonly failed: boolean;
};

/**
 * Cluster ordered user turns into ranked intents. Deterministic: turns are
 * clustered greedily by normalized-token Jaccard overlap in `order` sequence;
 * each cluster's representative is the highest-token-frequency question (ties →
 * shortest, then lexicographic). The recency split is the median `order`.
 */
export function clusterIntents(
  turns: ReadonlyArray<OrderedTurn>,
  feedback: ReadonlyArray<FeedbackRecord>,
  failedTurnKeys: ReadonlyArray<TurnSignal>,
  opts: ClusterIntentsOptions = {},
): IntentDigest {
  const threshold = opts.threshold ?? 0.5;
  const lowBelow = opts.lowSatisfactionBelow ?? 0.5;
  const unmetAtLeast = opts.unmetFailureAtLeast ?? 0.34;
  const topN = opts.topN ?? 5;
  const examplesPer = opts.examplesPerIntent ?? 3;

  const ratingByKey = new Map<string, number>();
  for (const fb of mergeFeedback(feedback)) {
    const r = normalizeRating(fb);
    if (r !== undefined) ratingByKey.set(turnKey(fb.sessionId, fb.turnNumber), r);
  }
  const failedKeys = new Set<string>(failedTurnKeys.map((s) => turnKey(s.sessionId, s.turnNumber)));

  const records: Rec[] = turns
    .filter((t) => t.input.trim() !== "")
    .map((t) => ({
      sessionId: t.sessionId,
      turnNumber: t.turnNumber,
      question: t.input.trim(),
      order: t.order,
      rating: ratingByKey.get(turnKey(t.sessionId, t.turnNumber)),
      failed: failedKeys.has(turnKey(t.sessionId, t.turnNumber)),
    }))
    // Stable clustering order: chronological, tie-broken deterministically.
    .sort(
      (a, b) =>
        a.order - b.order || a.sessionId.localeCompare(b.sessionId) || a.turnNumber - b.turnNumber,
    );

  const totalSessions = new Set(records.map((r) => r.sessionId)).size;
  // Median order for the rising split (older half < median ≤ recent half).
  const orders = records.map((r) => r.order).sort((a, b) => a - b);
  const medianOrder = orders.length === 0 ? 0 : (orders[Math.floor(orders.length / 2)] as number);

  type Cluster = {
    seed: Set<string>;
    items: Rec[];
    // token → count, for representative selection
    tokenFreq: Map<string, number>;
  };
  const clusters: Cluster[] = [];
  for (const rec of records) {
    const tokens = new Set(normalizeEvidenceTokens(rec.question));
    if (tokens.size === 0) continue;
    let bestIdx = -1;
    let bestOverlap = 0;
    for (let i = 0; i < clusters.length; i += 1) {
      const overlap = jaccard(tokens, (clusters[i] as Cluster).seed);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestOverlap >= threshold) {
      const c = clusters[bestIdx] as Cluster;
      c.items.push(rec);
      for (const t of tokens) c.tokenFreq.set(t, (c.tokenFreq.get(t) ?? 0) + 1);
    } else {
      const tokenFreq = new Map<string, number>();
      for (const t of tokens) tokenFreq.set(t, 1);
      clusters.push({ seed: tokens, items: [rec], tokenFreq });
    }
  }

  const intents: Intent[] = clusters.map((c) => {
    const occurrences = c.items.length;
    const sessionCount = new Set(c.items.map((r) => r.sessionId)).size;
    const rated = c.items.filter((r) => r.rating !== undefined);
    const meanRating =
      rated.length === 0
        ? undefined
        : rated.reduce((acc, r) => acc + (r.rating as number), 0) / rated.length;
    const failedTurns = c.items.filter((r) => r.failed).length;
    const earlyCount = c.items.filter((r) => r.order < medianOrder).length;
    const recentCount = occurrences - earlyCount;

    // Representative: score each question by summed token frequency; higher is
    // more central. Ties → shorter question, then lexicographic (deterministic).
    const scored = c.items
      .map((r) => {
        const toks = normalizeEvidenceTokens(r.question);
        const freq = toks.reduce((acc, t) => acc + (c.tokenFreq.get(t) ?? 0), 0);
        return { question: r.question, freq };
      })
      .sort(
        (a, b) =>
          b.freq - a.freq ||
          a.question.length - b.question.length ||
          a.question.localeCompare(b.question),
      );
    const representative = scored[0]?.question ?? "";
    // Distinct example questions, most-central first.
    const examples: string[] = [];
    for (const s of scored) {
      if (!examples.includes(s.question)) examples.push(s.question);
      if (examples.length >= examplesPer) break;
    }

    return {
      representative,
      occurrences,
      sessionCount,
      meanRating,
      failedTurns,
      failureRate: occurrences === 0 ? 0 : failedTurns / occurrences,
      earlyCount,
      recentCount,
      examples,
    };
  });

  // Rank: frequency-first for the master list.
  const byFrequency = [...intents].sort(
    (a, b) =>
      b.occurrences - a.occurrences ||
      b.sessionCount - a.sessionCount ||
      a.representative.localeCompare(b.representative),
  );

  const topIntents = byFrequency.slice(0, topN);

  // Rising: recentCount > earlyCount, ranked by the delta (then frequency).
  const risingIntents = [...intents]
    .filter((i) => i.recentCount > i.earlyCount)
    .sort(
      (a, b) =>
        b.recentCount - b.earlyCount - (a.recentCount - a.earlyCount) ||
        b.occurrences - a.occurrences ||
        a.representative.localeCompare(b.representative),
    )
    .slice(0, topN);

  // Low satisfaction: rated AND below the threshold, worst first (then frequency).
  const lowSatisfactionIntents = [...intents]
    .filter((i) => i.meanRating !== undefined && (i.meanRating as number) < lowBelow)
    .sort(
      (a, b) =>
        (a.meanRating as number) - (b.meanRating as number) ||
        b.occurrences - a.occurrences ||
        a.representative.localeCompare(b.representative),
    )
    .slice(0, topN);

  // Unmet: failure rate at/above the threshold, highest first (then frequency).
  const unmetIntents = [...intents]
    .filter((i) => i.failureRate >= unmetAtLeast && i.failedTurns > 0)
    .sort(
      (a, b) =>
        b.failureRate - a.failureRate ||
        b.occurrences - a.occurrences ||
        a.representative.localeCompare(b.representative),
    )
    .slice(0, topN);

  return {
    totalTurns: records.length,
    totalSessions,
    intents: byFrequency,
    topIntents,
    risingIntents,
    lowSatisfactionIntents,
    unmetIntents,
  };
}

/** Build ordered turns from per-session events, oldest session first. The
 *  caller passes sessions already in chronological order (oldest→newest). */
export function orderedTurnsFromSessions(
  perSession: ReadonlyArray<{ sessionId: string; events: ReadonlyArray<LoggedEvent> }>,
  deriveTurns: (events: ReadonlyArray<LoggedEvent>) => Array<Omit<SessionTurn, "sessionId">>,
): OrderedTurn[] {
  const out: OrderedTurn[] = [];
  let order = 0;
  for (const { sessionId, events } of perSession) {
    for (const t of deriveTurns(events)) {
      out.push({ ...t, sessionId, order });
      order += 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering — text / json / html. `redact` is applied to every example string.
// ---------------------------------------------------------------------------

function redactExamples(intent: Intent, redact: (s: string) => string): Intent {
  return {
    ...intent,
    representative: redact(intent.representative),
    examples: intent.examples.map(redact),
  };
}

/** Apply the redactor to every rendered string in the digest. */
export function redactDigest(digest: IntentDigest, redact: (s: string) => string): IntentDigest {
  const map = (list: readonly Intent[]) => list.map((i) => redactExamples(i, redact));
  return {
    ...digest,
    intents: map(digest.intents),
    topIntents: map(digest.topIntents),
    risingIntents: map(digest.risingIntents),
    lowSatisfactionIntents: map(digest.lowSatisfactionIntents),
    unmetIntents: map(digest.unmetIntents),
  };
}

function fmtRating(r: number | undefined): string {
  return r === undefined ? "n/a" : `${(r * 100).toFixed(0)}%`;
}

/** Render the digest as plain text. */
export function renderIntentsText(digest: IntentDigest): string {
  const lines: string[] = [];
  lines.push(
    `intent analytics: ${digest.totalTurns} user turns across ${digest.totalSessions} sessions, ${digest.intents.length} intent(s)`,
  );
  const section = (title: string, list: readonly Intent[], detail: (i: Intent) => string): void => {
    lines.push("");
    lines.push(title);
    if (list.length === 0) {
      lines.push("  (none)");
      return;
    }
    for (const i of list) lines.push(`  - ${i.representative} — ${detail(i)}`);
  };
  section(
    "TOP INTENTS",
    digest.topIntents,
    (i) => `${i.occurrences}× in ${i.sessionCount} session(s), rating ${fmtRating(i.meanRating)}`,
  );
  section(
    "RISING INTENTS",
    digest.risingIntents,
    (i) => `${i.earlyCount} → ${i.recentCount} (older → recent)`,
  );
  section(
    "LOW SATISFACTION",
    digest.lowSatisfactionIntents,
    (i) => `rating ${fmtRating(i.meanRating)} over ${i.occurrences} turn(s)`,
  );
  section(
    "UNMET (errors/loops/retries)",
    digest.unmetIntents,
    (i) => `${(i.failureRate * 100).toFixed(0)}% failed (${i.failedTurns}/${i.occurrences})`,
  );
  return `${lines.join("\n")}\n`;
}

/** Render the digest as pretty JSON. */
export function renderIntentsJson(digest: IntentDigest): string {
  return `${JSON.stringify(digest, null, 2)}\n`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render the digest as a self-contained HTML report. */
export function renderIntentsHtml(digest: IntentDigest): string {
  const rows = (list: readonly Intent[], cols: (i: Intent) => string[]): string =>
    list.length === 0
      ? '<tr><td class="empty">(none)</td></tr>'
      : list
          .map(
            (i) =>
              `<tr><td>${esc(i.representative)}</td>${cols(i)
                .map((c) => `<td>${esc(c)}</td>`)
                .join("")}</tr>`,
          )
          .join("");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Intent analytics</title>
<style>
 body{font:14px system-ui,sans-serif;margin:2rem;color:#111}
 h1{font-size:1.4rem} h2{font-size:1.05rem;margin-top:1.5rem}
 table{border-collapse:collapse;width:100%;margin-top:.5rem}
 th,td{border:1px solid #ddd;padding:.4rem .6rem;text-align:left;vertical-align:top}
 th{background:#f5f5f5} td.empty{color:#999;font-style:italic}
</style></head><body>
<h1>Intent analytics</h1>
<p>${digest.totalTurns} user turns across ${digest.totalSessions} sessions, ${digest.intents.length} intent(s).</p>
<h2>Top intents</h2>
<table><tr><th>Intent</th><th>Occurrences</th><th>Sessions</th><th>Rating</th></tr>
${rows(digest.topIntents, (i) => [String(i.occurrences), String(i.sessionCount), fmtRating(i.meanRating)])}
</table>
<h2>Rising intents</h2>
<table><tr><th>Intent</th><th>Older</th><th>Recent</th></tr>
${rows(digest.risingIntents, (i) => [String(i.earlyCount), String(i.recentCount)])}
</table>
<h2>Low satisfaction</h2>
<table><tr><th>Intent</th><th>Rating</th><th>Turns</th></tr>
${rows(digest.lowSatisfactionIntents, (i) => [fmtRating(i.meanRating), String(i.occurrences)])}
</table>
<h2>Unmet (errors / loops / retries)</h2>
<table><tr><th>Intent</th><th>Failure rate</th><th>Failed / total</th></tr>
${rows(digest.unmetIntents, (i) => [`${(i.failureRate * 100).toFixed(0)}%`, `${i.failedTurns}/${i.occurrences}`])}
</table>
</body></html>
`;
}
