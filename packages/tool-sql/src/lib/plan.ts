/**
 * Reading `EXPLAIN QUERY PLAN` output.
 *
 * SQLite's plan is a flat list of nodes with parent pointers and a `detail`
 * string. The string is machine-stable enough to key on — "SCAN t", "SEARCH t
 * USING INDEX ix (b=?)", "USE TEMP B-TREE FOR ORDER BY" — but it is prose,
 * not a contract, and SQLite has reworded it across releases. So the parsing
 * here is deliberately shallow: it renders the tree, and it answers the one
 * question a harness actually asks, which is "is anything scanning a whole
 * table". Anything more would be guessing about wording.
 *
 * Pure: takes the rows, returns the reading.
 */

/** One row of `EXPLAIN QUERY PLAN`. */
export type PlanNode = {
  readonly id: number;
  readonly parent: number;
  readonly detail: string;
};

export type PlanReading = {
  /** The plan as an indented tree, parents before children. */
  readonly tree: string;
  /**
   * Tables the plan reads end to end, sorted, without duplicates — under
   * the name the plan uses, which is the ALIAS when the query aliases the
   * table (`FROM posts p` scans "p"), because that is what SQLite prints.
   */
  readonly fullScans: readonly string[];
  /** Index names the plan uses, sorted, without duplicates. */
  readonly indexes: readonly string[];
  /** True when the plan sorts or groups through a temporary B-tree. */
  readonly usesTempBTree: boolean;
};

/** Render the parent-pointer list as an indented tree. */
export function renderPlanTree(nodes: readonly PlanNode[]): string {
  const childrenOf = new Map<number, PlanNode[]>();
  for (const node of nodes) {
    const siblings = childrenOf.get(node.parent) ?? [];
    siblings.push(node);
    childrenOf.set(node.parent, siblings);
  }
  const lines: string[] = [];
  const walk = (parent: number, depth: number, seen: Set<number>): void => {
    for (const node of childrenOf.get(parent) ?? []) {
      // A malformed plan (a cycle) would otherwise recurse forever.
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      lines.push(`${"  ".repeat(depth)}${node.detail}`);
      walk(node.id, depth + 1, seen);
    }
  };
  walk(0, 0, new Set());
  return lines.join("\n");
}

/**
 * The table a "SCAN …" node reads, or undefined.
 *
 * A node that also says USING INDEX or USING COVERING INDEX is not a full
 * table scan — it is an index scan, which is a different cost and a
 * different fix. Subquery and CTE nodes name a sub-plan rather than a table
 * and are left out.
 */
export function scannedTable(detail: string): string | undefined {
  const matched = detail.match(/^SCAN\s+(?:TABLE\s+)?("[^"]+"|`[^`]+`|\[[^\]]+\]|\S+)/);
  const raw = matched?.[1];
  if (raw === undefined) return undefined;
  if (/USING\s+(COVERING\s+)?INDEX/i.test(detail)) return undefined;
  if (/^(SUBQUERY|CONSTANT|UNION|LIST)$/i.test(raw)) return undefined;
  return unquote(raw);
}

/**
 * The index a node uses, or undefined.
 *
 * An AUTOMATIC index is one SQLite built for this statement alone and threw
 * away afterwards. Naming it as "an index this query uses" would tell the
 * reader the opposite of the truth, which is that a real index is missing,
 * so it is excluded — explicitly, rather than by relying on the wording not
 * to match.
 */
export function usedIndex(detail: string): string | undefined {
  if (/USING\s+AUTOMATIC\s/i.test(detail)) return undefined;
  const matched = detail.match(/USING\s+(?:COVERING\s+)?INDEX\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|\S+)/i);
  const raw = matched?.[1];
  if (raw === undefined) return undefined;
  return unquote(raw.replace(/\s*\(.*$/, ""));
}

function unquote(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === '"' && last === '"') || (first === "`" && last === "`")) {
      return raw.slice(1, -1);
    }
    if (first === "[" && last === "]") return raw.slice(1, -1);
  }
  return raw;
}

/** Read a whole plan. */
export function readPlan(nodes: readonly PlanNode[]): PlanReading {
  const fullScans = new Set<string>();
  const indexes = new Set<string>();
  let usesTempBTree = false;
  for (const node of nodes) {
    const scanned = scannedTable(node.detail);
    if (scanned !== undefined) fullScans.add(scanned);
    const index = usedIndex(node.detail);
    if (index !== undefined) indexes.add(index);
    if (/USE TEMP B-TREE/i.test(node.detail)) usesTempBTree = true;
  }
  return {
    tree: renderPlanTree(nodes),
    fullScans: [...fullScans].sort(),
    indexes: [...indexes].sort(),
    usesTempBTree,
  };
}
