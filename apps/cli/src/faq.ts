/**
 * Item #55 — distill repeated user questions into an auto-discovered FAQ skill.
 *
 * `crewhaus faq distill` clusters recurring `user_message` questions across
 * sessions (deterministic token clustering — the same greedy-jaccard approach
 * `graders suggest` uses, no model call), pairs each cluster with its best-rated
 * answer (the up-rated turn's output), and emits a SKILL.md FAQ skill into
 * `.crewhaus/skills/faq/` so `@crewhaus/skills-registry` auto-discovers it —
 * its name + description go into the prompt and the body loads on demand when
 * the model invokes the `Skill` tool (the registry is lazy, not eager).
 *
 * Everything here is pure + deterministic so it is unit-testable; the FS access
 * and PII/secret redaction wiring live in `apps/cli/src/index.ts`. Both the
 * harvested ANSWER and the representative QUESTION are user/model text that may
 * carry pasted credentials, so the caller redacts BOTH (via
 * `SYNTHESIZE_PII_DETECTORS`) before they land in the skill body (#55 F4).
 *
 * The emitted SKILL.md is guaranteed valid per skills-registry's `parseSkillFile`
 * (leading `---` frontmatter with `name` + `description`, then the FAQ body).
 */

import { deriveTurns, mergeFeedback, normalizeRating } from "./feedback";
import type { FeedbackRecord, LoggedEvent, SessionTurn } from "./feedback";
import { normalizeEvidenceTokens } from "./graders-suggest";

/** One recurring-question cluster paired with its best answer. */
export type FaqEntry = {
  /** The representative (most-frequent-token, then shortest) question. */
  readonly question: string;
  /** The best-rated answer for the cluster (already redacted by the caller). */
  readonly answer: string;
  /** How many distinct sessions asked a question in this cluster. */
  readonly sessionCount: number;
  /** How many questions total fell into this cluster. */
  readonly occurrences: number;
};

export type ClusterOptions = {
  /** Jaccard overlap at/above which a question joins a cluster's seed. Default 0.5. */
  readonly threshold?: number;
  /** Minimum number of DISTINCT sessions that must ask a clustered question
   *  for it to become an FAQ entry. Default 2 (recurring across sessions — a
   *  one-off, or a single session that repeats itself, is not an FAQ). */
  readonly minOccurrences?: number;
  /** Normalized rating at/above which an answer is "good". Default 0.7. */
  readonly minScore?: number;
  /** Redactor for answers (async). Identity by default. */
  readonly redact?: (text: string) => Promise<string>;
};

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

type QuestionRecord = {
  readonly sessionId: string;
  readonly turnNumber: number;
  readonly question: string;
  readonly answer: string;
  /** [0,1] rating of the turn's answer, or undefined when unrated. */
  readonly score: number | undefined;
};

/**
 * Build the FAQ entries from per-session turns + feedback. Deterministic:
 * questions are clustered greedily by normalized-token Jaccard overlap in a
 * stable visit order; each cluster keeps its best-rated answer (highest score,
 * ties broken by session/turn order). Only clusters asked in ≥ `minOccurrences`
 * DISTINCT sessions (#55 F9) AND with a qualifying answer (score ≥ `minScore`)
 * become entries. Entries come back most-recurring-first.
 */
export async function distillFaq(
  turnsBySession: ReadonlyArray<SessionTurn>,
  feedback: ReadonlyArray<FeedbackRecord>,
  opts: ClusterOptions = {},
): Promise<FaqEntry[]> {
  const threshold = opts.threshold ?? 0.5;
  const minOccurrences = opts.minOccurrences ?? 2;
  const minScore = opts.minScore ?? 0.7;
  const redact = opts.redact ?? (async (t: string) => t);

  // Rating lookup keyed by session#turn.
  const scoreByKey = new Map<string, number>();
  for (const fb of mergeFeedback(feedback)) {
    const s = normalizeRating(fb);
    if (s !== undefined) scoreByKey.set(`${fb.sessionId}#${fb.turnNumber}`, s);
  }

  const records: QuestionRecord[] = turnsBySession
    .filter((t) => t.input.trim() !== "")
    .map((t) => ({
      sessionId: t.sessionId,
      turnNumber: t.turnNumber,
      question: t.input.trim(),
      answer: t.output,
      score: scoreByKey.get(`${t.sessionId}#${t.turnNumber}`),
    }))
    .sort(
      (a, b) =>
        a.sessionId.localeCompare(b.sessionId) ||
        a.turnNumber - b.turnNumber ||
        a.question.localeCompare(b.question),
    );

  type Cluster = { seed: Set<string>; items: QuestionRecord[]; tokenSets: Array<Set<string>> };
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
      c.tokenSets.push(tokens);
    } else {
      clusters.push({ seed: tokens, items: [rec], tokenSets: [tokens] });
    }
  }

  const entries: FaqEntry[] = [];
  for (const c of clusters) {
    // #55 F9 — "recurring" means asked across DISTINCT sessions, not the same
    // session twice. Gate on the distinct-session count so two questions from
    // one session don't manufacture an FAQ entry at minOccurrences:2.
    const sessionCount = new Set(c.items.map((i) => i.sessionId)).size;
    if (sessionCount < minOccurrences) continue;
    // Best answer: highest-scored qualifying turn (stable tie-break by order).
    const qualifying = c.items
      .filter((i) => i.score !== undefined && i.score >= minScore && i.answer.trim() !== "")
      .sort(
        (a, b) =>
          (b.score ?? 0) - (a.score ?? 0) ||
          a.sessionId.localeCompare(b.sessionId) ||
          a.turnNumber - b.turnNumber,
      );
    const best = qualifying[0];
    if (best === undefined) continue;
    // Representative question: the shortest question in the cluster (most
    // canonical phrasing), stable tie-break. #55 F4 — the representative
    // question is a raw user turn rendered as a Markdown heading in SKILL.md,
    // so it is redacted with the SAME redactor as the answer (a question can
    // paste a secret/email just as an answer can).
    const rawQuestion = [...c.items]
      .map((i) => i.question)
      .sort((a, b) => a.length - b.length || a.localeCompare(b))[0] as string;
    const question = (await redact(rawQuestion)).trim();
    const answer = (await redact(best.answer)).trim();
    if (question === "" || answer === "") continue;
    entries.push({
      question,
      answer,
      sessionCount,
      occurrences: c.items.length,
    });
  }
  return entries.sort(
    (a, b) => b.occurrences - a.occurrences || a.question.localeCompare(b.question),
  );
}

/** Derive `SessionTurn`s from many sessions' event logs. Convenience wrapper so
 *  the CLI and tests build the clustering input the same way. */
export function turnsFromSessions(
  perSession: ReadonlyArray<{ sessionId: string; events: ReadonlyArray<LoggedEvent> }>,
): SessionTurn[] {
  const turns: SessionTurn[] = [];
  for (const { sessionId, events } of perSession) {
    for (const t of deriveTurns(events)) turns.push({ ...t, sessionId });
  }
  return turns;
}

/** YAML-escape a scalar for the SKILL.md frontmatter (JSON is a YAML subset). */
function yamlScalar(s: string): string {
  return JSON.stringify(s);
}

/**
 * Render a valid SKILL.md for the FAQ. Frontmatter carries `name` +
 * `description` (the required pair skills-registry enforces) plus `triggers`;
 * the body is the Q→A list. Guaranteed to parse via `parseSkillFile`.
 */
export function buildFaqSkill(
  entries: ReadonlyArray<FaqEntry>,
  opts: { name?: string; harnessName?: string } = {},
): string {
  const name = opts.name ?? "faq";
  const label = opts.harnessName ?? "this harness";
  const description = `Frequently asked questions for ${label}, distilled from recurring user questions and their best-rated answers. Consult before answering common questions.`;
  const triggers = ["faq", "frequently asked", "common question", "how do i"];
  const bodyLines: string[] = [
    `# FAQ — ${label}`,
    "",
    "These are recurring user questions paired with the answers users rated best. Prefer these answers for matching questions.",
    "",
  ];
  entries.forEach((e, i) => {
    bodyLines.push(`## Q${i + 1}: ${e.question}`);
    bodyLines.push("");
    bodyLines.push(e.answer);
    bodyLines.push("");
  });
  const frontmatter = [
    "---",
    `name: ${yamlScalar(name)}`,
    `description: ${yamlScalar(description)}`,
    `triggers: ${JSON.stringify(triggers)}`,
    "---",
  ].join("\n");
  return `${frontmatter}\n${bodyLines.join("\n")}`;
}
