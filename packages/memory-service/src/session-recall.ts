/**
 * Session-summary recall — the third recall ranker (Batch E item 8, G77).
 *
 * `memory.sessionRecall: true` folds the durable sessions-index
 * (`.crewhaus/sessions-index/<id>.json`, the compact `SessionSummary`
 * records the dream engine + `crewhaus sessions index` write past a
 * transcript's TTL) into the auto-recall bundle, BESIDE the fact-store and
 * wiki rankers wireMemory already fuses. It answers "what did we conclude
 * last time?" without the model spending a tool call.
 *
 * Like the fact store, ranking is deterministic BM25 over the summary's
 * semantic surface (`outcome` + `keyFacts` + `toolsUsed`) — zero deps, offline,
 * and the same formula `memory-store` uses so the three rankers agree on what
 * "relevant" means. The recall line mirrors the wiki bundle shape
 * (`[session:<id> · <date>] <outcome> — <keyFacts>`); the runtime classifies +
 * delimiter-escapes the assembled block, so recalled session bodies flow
 * through the boundary classifier before any model call, exactly like the
 * fact/wiki lines they sit beside.
 */

import { readdir } from "node:fs/promises";
import type { SessionSummary } from "@crewhaus/session-store";
import { openForRead } from "@crewhaus/tool-safety/fs";

/** The recall seam the composition root folds into the auto-recall bundle. */
export type SessionSummaryRecall = {
  /** Top-`k` session-summary recall lines for the query, most-relevant first.
   *  Empty when the index is absent/empty or nothing lexically matches. */
  recall(query: string, k: number): Promise<string[]>;
};

export type CreateSessionSummaryRecallOptions = {
  /** The sessions-index directory (`<crewhausDir>/sessions-index`). */
  readonly indexDir: string;
  /** Where a skipped record is reported, once per reason. */
  readonly log?: (line: string) => void;
};

/** A summary is a few hundred bytes; a record past this is not one. */
const SESSION_SUMMARY_MAX_BYTES = 1024 * 1024;

/** Cap on the fused summary body inside the recall bundle — recall is a
 *  pointer surface ("go re-read session X"), not a transcript dump. */
const SESSION_RECALL_EXCERPT_CHARS = 240;

/** Lowercase alphanumeric word tokens — the same shape memory-store's BM25
 *  tokenizer produces, so cross-ranker relevance stays comparable. */
function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 0);
}

/** The text a summary is ranked on: its outcome, key facts, and the tools it
 *  used (a tool-name query can surface the session that used it). */
function rankableText(s: SessionSummary): string {
  return [s.outcome, s.keyFacts.join(" "), s.toolsUsed.join(" ")].join(" ");
}

function clip(text: string, n: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

/** A stable, human-readable pointer line — mirrors the wiki bundle shape. */
function formatLine(s: SessionSummary): string {
  const date = /^\d{4}-\d{2}-\d{2}/.test(s.summarizedAt) ? s.summarizedAt.slice(0, 10) : "?";
  const facts = s.keyFacts.length > 0 ? ` — ${s.keyFacts.join("; ")}` : "";
  const body = clip(`${s.outcome}${facts}`, SESSION_RECALL_EXCERPT_CHARS);
  return `[session:${s.sessionId} · ${date}] ${body}`;
}

/**
 * BM25 rank the summaries against the query — the exact formula (k1=1.5,
 * b=0.75) memory-store's fact ranker uses. Returns only positive-scoring
 * summaries, most-relevant first (stable).
 */
function bm25Rank(summaries: readonly SessionSummary[], query: string): SessionSummary[] {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0 || summaries.length === 0) return [];
  const k1 = 1.5;
  const b = 0.75;
  const docs = summaries.map((summary) => ({ summary, terms: tokenize(rankableText(summary)) }));
  const N = docs.length;
  const avgdl = docs.reduce((sum, d) => sum + d.terms.length, 0) / Math.max(1, N);
  const df = new Map<string, number>();
  for (const t of new Set(queryTerms)) {
    df.set(t, docs.filter((d) => d.terms.includes(t)).length);
  }
  const scored: Array<{ summary: SessionSummary; score: number }> = [];
  for (const d of docs) {
    let score = 0;
    for (const t of queryTerms) {
      const tf = d.terms.filter((x) => x === t).length;
      if (tf === 0) continue;
      const dfi = df.get(t) ?? 0;
      const idf = Math.log((N - dfi + 0.5) / (dfi + 0.5) + 1);
      const dl = d.terms.length;
      const norm = tf * (k1 + 1);
      const denom = tf + k1 * (1 - b + (b * dl) / Math.max(1, avgdl));
      score += idf * (norm / denom);
    }
    if (score > 0) scored.push({ summary: d.summary, score });
  }
  scored.sort((a, c) => c.score - a.score);
  return scored.map((s) => s.summary);
}

function isSessionSummary(value: unknown): value is SessionSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["sessionId"] === "string" &&
    typeof v["outcome"] === "string" &&
    Array.isArray(v["keyFacts"]) &&
    Array.isArray(v["toolsUsed"]) &&
    typeof v["summarizedAt"] === "string"
  );
}

/**
 * Construct a session-summary recall over an existing sessions-index. The
 * store is read-only — it never writes the index (the dream engine + the
 * `sessions index` verb own that). A missing/empty index is not an error: a
 * fresh harness simply has no prior sessions to recall, so `recall()` returns
 * `[]` until sessions accrue.
 */
export function createSessionSummaryRecall(
  opts: CreateSessionSummaryRecallOptions,
): SessionSummaryRecall {
  const { indexDir } = opts;
  const reported = new Set<string>();
  const skip = (why: string): void => {
    if (reported.has(why)) return;
    reported.add(why);
    opts.log?.(`[memory] sessionRecall skipped a sessions-index record: ${why}\n`);
  };

  /**
   * Every readable summary in the index. The index sits in `.crewhaus/`,
   * which any agent with a write tool can reach, and this runs before every
   * turn: a record is read only when it is a regular file inside the index,
   * never through a link at its name, never from a FIFO (which used to hang
   * auto-recall, and so every turn, for ever) and never past
   * {@link SESSION_SUMMARY_MAX_BYTES}. Anything else is skipped, and each
   * reason is logged once.
   */
  async function loadSummaries(): Promise<SessionSummary[]> {
    let files: string[];
    try {
      files = (await readdir(indexDir, { withFileTypes: true }))
        .filter((e) => e.name.endsWith(".json"))
        .map((e) => e.name);
    } catch {
      return []; // index dir absent — nothing indexed yet.
    }
    const out: SessionSummary[] = [];
    for (const file of files) {
      const read = await openForRead(indexDir, file, {
        maxBytes: SESSION_SUMMARY_MAX_BYTES,
        followLeafSymlink: false,
      });
      if (!read.ok) {
        // A record removed since the listing is no news.
        if (read.code !== "not-found") skip(read.reason);
        continue; // a single unreadable record must not abort recall.
      }
      if (read.truncated) {
        skip(`${file} is larger than ${SESSION_SUMMARY_MAX_BYTES} bytes, so it was not read`);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(read.text);
      } catch {
        continue;
      }
      if (isSessionSummary(parsed)) out.push(parsed);
    }
    return out;
  }

  return {
    async recall(query: string, k: number): Promise<string[]> {
      if (typeof query !== "string" || query.trim() === "" || k <= 0) return [];
      const summaries = await loadSummaries();
      if (summaries.length === 0) return [];
      return bm25Rank(summaries, query)
        .slice(0, k)
        .map((s) => formatLine(s));
    },
  };
}
