/**
 * Dream phase 1 — the DETERMINISTIC consolidation pass (v0.3.0 design §6.2).
 *
 * No model call anywhere in this module. Every step is idempotent — running
 * the pass twice against unchanged stores produces zero new mutations — and
 * every step is individually fenced (a throwing step is folded into the
 * findings as a warning and never aborts the others; a scheduled
 * maintenance pass that dies on the first malformed file is worse than one
 * that reports it).
 *
 * Steps (§6.2 order):
 *   1. sessions-index fold-in — summarize any session `.jsonl` whose durable
 *      index entry is missing or stale (session-store's `summarizeSession`
 *      reducer via `summarizeSessionIntoIndex`).
 *   2. fact TTL sweep — `MemoryStore.sweep()` (expired → tombstoned, never
 *      silently deleted).
 *   3. fact dedupe/supersede — normalized-text near-duplicates collapse to
 *      the newest entry; the older ones get supersede tombstones
 *      (`forget(id)`), then `compact()` bounds file growth. Duplicate
 *      groups corroborated across ≥2 sessions surface as PROMOTION
 *      candidates in the findings (episodic → semantic, §6.2).
 *   4. fact staleness flags — live facts older than
 *      {@link STALE_FACT_AFTER_MS} are FLAGGED in the findings (fed to the
 *      model phase / operator), never deleted.
 *   5. wiki staleness scan — articles unverified for longer than
 *      {@link STALE_WIKI_UNVERIFIED_AFTER_MS} are flagged the same way.
 *   6. proof-excerpt re-validation + retention-pin refresh — every frozen
 *      proof on plans/goals is re-resolved against the session logs; every
 *      cited session is pinned in `.crewhaus/retention.json` (§2.4
 *      mechanism (a)) so evidence transcripts outlive the TTL sweep.
 *   7. focus/handoff refresh — `handoff.md` is deterministically re-rendered
 *      from the open plans so the next session starts pointed right.
 *   8. trash purge — snapshots older than the 7-day undo window are
 *      hard-deleted (continuity-store's `purgeTrash`, the one sanctioned
 *      hard delete in the clearing story).
 */
import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type ContinuityStore,
  type FrozenProof,
  appendRetentionPins,
  purgeTrash,
  resolveEvidence,
} from "@crewhaus/continuity-store";
import type { MemoryEntry, MemoryStore } from "@crewhaus/memory-store";
import { SESSIONS_INDEX_DIRNAME, summarizeSessionIntoIndex } from "@crewhaus/session-store";
import type { WikiStore } from "@crewhaus/wiki-store";

/** Facts older than this and still live are flagged stale (design §6.2's
 *  ">90d" decay window). Flags land in the findings — never a deletion. */
export const STALE_FACT_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

/** Wiki articles unverified for longer than this are flagged for the
 *  reflection/model pass (design §6.2's ">30d" staleness window). */
export const STALE_WIKI_UNVERIFIED_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const SESSION_LOG_REGEX = /^(sess_[0-9a-f]{16})\.jsonl$/;

/** What the deterministic pass counted — persisted verbatim into
 *  `state.json.phase1Counts` and rendered by `crewhaus dream`. */
export type DreamPhase1Counts = {
  readonly sessionsIndexed: number;
  /** Live facts before dedupe (after the TTL sweep). */
  readonly factsBefore: number;
  /** Live facts after dedupe. */
  readonly factsAfter: number;
  /** Facts tombstoned as expired by the TTL sweep. */
  readonly factsSwept: number;
  /** Near-duplicates superseded by the dedupe step. */
  readonly factsSuperseded: number;
  /** Live facts older than {@link STALE_FACT_AFTER_MS} (flagged, kept). */
  readonly factsStale: number;
  /** Wiki articles unverified past {@link STALE_WIKI_UNVERIFIED_AFTER_MS}. */
  readonly wikiStale: number;
  /** Frozen proofs re-validated against session logs. */
  readonly proofsChecked: number;
  /** Proofs whose transcript no longer resolves (frozen excerpt only). */
  readonly proofsUnverifiable: number;
  /** Sessions newly pinned in retention.json by this pass. */
  readonly sessionsPinned: number;
  /** Plans with at least one unproven step (handoff refresh input). */
  readonly openPlans: number;
  /** Trash snapshots hard-deleted past the 7-day undo window. */
  readonly trashPurged: number;
};

export type DreamPhase1Report = {
  readonly counts: DreamPhase1Counts;
  /** Human/model-readable flag lines — the seed material for phase 2. */
  readonly findings: readonly string[];
};

export type DreamPhase1Options = {
  readonly specName: string;
  /** The `.crewhaus` root (stores, retention.json, trash, dream state). */
  readonly crewhausDir: string;
  /** Where session `.jsonl` logs live. Default `<crewhausDir>/sessions`. */
  readonly sessionRootDir?: string;
  readonly memoryStore?: MemoryStore;
  readonly wikiStore?: WikiStore;
  readonly continuityStore?: ContinuityStore;
  readonly now?: () => Date;
};

/** Normalize a fact's text for near-duplicate detection: case, whitespace,
 *  and punctuation-insensitive. Deterministic by construction. */
export function normalizeFactText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Run the deterministic consolidation pass. Same inputs → same counts;
 *  a second run against the resulting stores is a no-op (zero mutations). */
export async function runDreamPhase1(opts: DreamPhase1Options): Promise<DreamPhase1Report> {
  const now = opts.now ?? (() => new Date());
  const nowMs = now().getTime();
  const sessionRootDir = opts.sessionRootDir ?? join(opts.crewhausDir, "sessions");
  const findings: string[] = [];

  let sessionsIndexed = 0;
  let factsBefore = 0;
  let factsAfter = 0;
  let factsSwept = 0;
  let factsSuperseded = 0;
  let factsStale = 0;
  let wikiStale = 0;
  let proofsChecked = 0;
  let proofsUnverifiable = 0;
  let sessionsPinned = 0;
  let openPlans = 0;
  let trashPurged = 0;

  async function fenced(step: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      findings.push(`(step "${step}" failed: ${message})`);
    }
  }

  // 1. sessions-index fold-in — index every session whose durable summary is
  // missing or older than its log (mtime comparison makes re-runs no-ops).
  await fenced("sessions-index", async () => {
    const indexDir = join(opts.crewhausDir, SESSIONS_INDEX_DIRNAME);
    let entries: string[];
    try {
      entries = await readdir(sessionRootDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries.sort()) {
      const match = entry.match(SESSION_LOG_REGEX);
      const id = match?.[1];
      if (id === undefined) continue;
      const logPath = join(sessionRootDir, entry);
      const indexPath = join(indexDir, `${id}.json`);
      if (existsSync(indexPath) && statSync(indexPath).mtimeMs >= statSync(logPath).mtimeMs) {
        continue; // already folded in and up to date
      }
      if (summarizeSessionIntoIndex(id, logPath, indexDir, now) !== undefined) {
        sessionsIndexed += 1;
      }
    }
  });

  // 2–4. facts: TTL sweep, near-duplicate supersede, staleness flags.
  const memoryStore = opts.memoryStore;
  if (memoryStore !== undefined) {
    await fenced("fact-sweep", async () => {
      const sweep = await memoryStore.sweep(nowMs);
      factsSwept = sweep.swept;
    });
    await fenced("fact-dedupe", async () => {
      const live = (await memoryStore.list())
        .filter((item) => item.status === "live")
        .map((item) => item.entry);
      factsBefore = live.length;

      const groups = new Map<string, MemoryEntry[]>();
      for (const entry of live) {
        const key = normalizeFactText(entry.text);
        if (key === "") continue;
        const group = groups.get(key);
        if (group === undefined) groups.set(key, [entry]);
        else group.push(entry);
      }

      const kept = new Set(live.map((e) => e.id));
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        // Keep the newest (createdAt; later file position wins ties).
        const keep = group.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a));
        const sessions = new Set(
          group.map((e) => e.provenance?.sessionId).filter((s): s is string => s !== undefined),
        );
        for (const entry of group) {
          if (entry.id === keep.id) continue;
          await memoryStore.forget(entry.id, {
            reason: `dream: near-duplicate of ${keep.id}`,
          });
          kept.delete(entry.id);
          factsSuperseded += 1;
        }
        if (sessions.size >= 2) {
          // Episodic → semantic promotion flag (§6.2): the same fact was
          // captured in independent sessions — a wiki-draft candidate.
          findings.push(
            `promotion candidate: "${clip(keep.text, 120)}" corroborated across ${sessions.size} sessions (${keep.id})`,
          );
        }
      }
      factsAfter = factsBefore - factsSuperseded;
      if (factsSuperseded > 0) {
        await memoryStore.compact();
      }

      const staleCutoff = nowMs - STALE_FACT_AFTER_MS;
      for (const entry of live) {
        if (!kept.has(entry.id)) continue;
        if (Date.parse(entry.createdAt) <= staleCutoff) {
          factsStale += 1;
          findings.push(
            `stale fact (>90d): ${entry.id} "${clip(entry.text, 120)}" (created ${entry.createdAt})`,
          );
        }
      }
    });
  }

  // 5. wiki staleness scan.
  const wikiStore = opts.wikiStore;
  if (wikiStore !== undefined) {
    await fenced("wiki-staleness", async () => {
      const cutoff = nowMs - STALE_WIKI_UNVERIFIED_AFTER_MS;
      const refs = await wikiStore.list({ staleFirst: true });
      for (const ref of refs) {
        if (ref.status === "archived" || ref.verified) continue;
        if (Date.parse(ref.updatedAt) <= cutoff) {
          wikiStale += 1;
          findings.push(
            `stale article (unverified >30d): [[${ref.slug}]] "${ref.title}" v${ref.version} (updated ${ref.updatedAt})`,
          );
        }
      }
    });
  }

  // 6–7. continuity: proof re-validation + retention pins, handoff refresh.
  const continuityStore = opts.continuityStore;
  if (continuityStore !== undefined) {
    await fenced("proof-freeze", async () => {
      const plans = await continuityStore.listPlans();
      const goals = await continuityStore.listGoals();
      const proofs: FrozenProof[] = [];
      for (const plan of plans) {
        for (const step of plan.steps) proofs.push(...step.proofs);
      }
      for (const goal of goals) proofs.push(...(goal.proofs ?? []));
      proofsChecked = proofs.length;

      if (proofs.length > 0) {
        // Mechanism (a): pin every cited session before the TTL can evict it.
        const { added } = await appendRetentionPins(
          proofs.map((p) => p.sessionId),
          join(opts.crewhausDir, "retention.json"),
        );
        sessionsPinned = added.length;

        // Re-validation: does the raw transcript still resolve, or does the
        // evidence now survive only as its frozen excerpt (mechanism (b))?
        for (const proof of proofs) {
          const [resolution] = await resolveEvidence(
            [{ toolUseId: proof.toolUseId, sessionId: proof.sessionId }],
            { sessionRootDir, now },
          );
          if (resolution === undefined || resolution.verdict !== "verified") {
            proofsUnverifiable += 1;
            findings.push(
              `proof ${proof.toolUseId} (${proof.sessionId}) no longer resolves against the transcript — it survives as its frozen excerpt (${proof.toolName}, ${proof.inputHash.slice(0, 18)}…)`,
            );
          }
        }
      }
    });
    await fenced("handoff-refresh", async () => {
      const plans = await continuityStore.listPlans();
      openPlans = plans.filter((p) => p.steps.some((s) => s.status !== "proven")).length;
      await continuityStore.writeHandoff();
    });
  }

  // 8. trash purge (>7 days — continuity-store owns the layout + boundary).
  await fenced("trash-purge", async () => {
    const purge = await purgeTrash(opts.crewhausDir, { now });
    trashPurged = purge.purged.length;
  });

  return {
    counts: {
      sessionsIndexed,
      factsBefore,
      factsAfter,
      factsSwept,
      factsSuperseded,
      factsStale,
      wikiStale,
      proofsChecked,
      proofsUnverifiable,
      sessionsPinned,
      openPlans,
      trashPurged,
    },
    findings,
  };
}
