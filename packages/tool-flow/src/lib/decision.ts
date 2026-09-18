/**
 * Decision tables: an operator's policy written once, answered the same way
 * every time, with the matched row ids as the audit trail.
 *
 * The difference from {@link ./branch} is the hit policy. A branch is always
 * "first one wins". A table can also require exactly one row to match, rank
 * by priority, or collect every match — and each of those catches a class of
 * policy bug that "first wins" hides.
 */
import { createHash } from "node:crypto";
import { type Check, runChecks } from "@crewhaus/tool-schema";
import type { MatchMode } from "./branch";
import { canonicalize } from "./canonical";

export const HIT_POLICIES = ["first", "unique", "priority", "collect"] as const;
export type HitPolicy = (typeof HIT_POLICIES)[number];

export type DecisionRow = {
  readonly id: string;
  readonly when: ReadonlyArray<Check>;
  readonly match?: MatchMode;
  /** Used by the `priority` policy; higher wins. Defaults to 0. */
  readonly priority?: number;
  readonly outputs: Readonly<Record<string, unknown>>;
};

export type DecisionTable = {
  /** Echoed into every answer, so a decision is attributable to a revision. */
  readonly version?: string;
  readonly policy: HitPolicy;
  readonly rows: ReadonlyArray<DecisionRow>;
  /** Used when no row matches. Without it, a miss is `matched: false`. */
  readonly otherwise?: Readonly<Record<string, unknown>>;
};

export type DecisionResult = {
  readonly ok: boolean;
  readonly matched: boolean;
  readonly policy: HitPolicy;
  readonly version: string | null;
  /** Ids of every row that matched, in declared order. */
  readonly matchedIds: ReadonlyArray<string>;
  /** One row's outputs; for `collect`, one entry per matched row. */
  readonly outputs:
    | Readonly<Record<string, unknown>>
    | ReadonlyArray<Record<string, unknown>>
    | null;
  readonly fallback: boolean;
  /** Set when the table could not answer: ambiguity under `unique`/`priority`. */
  readonly conflict: string | null;
  /** Stable digest of the table, so a changed policy is visible in a log. */
  readonly tableHash: string;
};

/** Digest of the rows and policy — not the version string, which is a label. */
export function hashTable(table: DecisionTable): string {
  const material = canonicalize({ policy: table.policy, rows: table.rows });
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

export function evaluateTable(value: unknown, table: DecisionTable): DecisionResult {
  if (table.rows.length === 0) throw new Error("the decision table has no rows");

  const seen = new Set<string>();
  for (const row of table.rows) {
    if (row.when.length === 0) {
      throw new Error(
        `row "${row.id}" has no checks — a row with no checks matches everything; use "otherwise" for a default`,
      );
    }
    if (seen.has(row.id)) throw new Error(`two rows share the id "${row.id}"`);
    seen.add(row.id);
  }

  const tableHash = hashTable(table);
  const version = table.version ?? null;
  const base = { policy: table.policy, version, tableHash } as const;

  const matches: DecisionRow[] = [];
  for (const row of table.rows) {
    const report = runChecks(value, row.when as Check[]);
    const ok = (row.match ?? "all") === "all" ? report.ok : report.passed > 0;
    if (ok) {
      matches.push(row);
      // `first` needs no further rows; the others need to see them all.
      if (table.policy === "first") break;
    }
  }

  const matchedIds = matches.map((r) => r.id);

  if (matches.length === 0) {
    if (table.otherwise) {
      return {
        ...base,
        ok: true,
        matched: true,
        matchedIds: [],
        outputs: table.otherwise,
        fallback: true,
        conflict: null,
      };
    }
    return {
      ...base,
      ok: true,
      matched: false,
      matchedIds: [],
      outputs: null,
      fallback: false,
      conflict: null,
    };
  }

  const answer = (outputs: DecisionResult["outputs"], conflict: string | null): DecisionResult => ({
    ...base,
    ok: conflict === null,
    matched: conflict === null,
    matchedIds,
    outputs: conflict === null ? outputs : null,
    fallback: false,
    conflict,
  });

  switch (table.policy) {
    case "first":
      return answer(matches[0]?.outputs ?? null, null);

    case "collect":
      return answer(
        matches.map((r) => r.outputs as Record<string, unknown>),
        null,
      );

    case "unique":
      // Two rows matching under `unique` is the bug the policy exists to
      // find: the table's conditions were meant to be disjoint and are not.
      return matches.length === 1
        ? answer(matches[0]?.outputs ?? null, null)
        : answer(null, `rows ${matchedIds.map((id) => `"${id}"`).join(", ")} all matched`);

    case "priority": {
      let best = matches[0] as DecisionRow;
      let tied: DecisionRow[] = [best];
      for (const row of matches.slice(1)) {
        const a = row.priority ?? 0;
        const b = best.priority ?? 0;
        if (a > b) {
          best = row;
          tied = [row];
        } else if (a === b) {
          tied.push(row);
        }
      }
      return tied.length === 1
        ? answer(best.outputs, null)
        : answer(
            null,
            `rows ${tied.map((r) => `"${r.id}"`).join(", ")} share the top priority ${best.priority ?? 0}`,
          );
    }
  }
}
