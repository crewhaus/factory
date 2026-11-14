/**
 * Pages of objects over a ledger, newest first, for the control API's lists: each object
 * once, at the line that made it (its machine's entry state), carrying its current fold.
 * Paging walks the ledger's lines with control-records' `readPage`, so `snapshotAt` is the
 * ledger's end taken before the read, a cursor never repeats or skips an object, and a
 * line that cannot be read is reported as a gap, never dropped silently.
 */
import type { CursorPosition } from "@crewhaus/control-contract";
import {
  type Ledger,
  type LedgerRecord,
  type PageGap,
  foldStates,
  readPage,
} from "@crewhaus/control-records";

export type ObjectPage<T> = {
  /** Newest first, at most `limit`. */
  readonly items: readonly T[];
  /** Where the next page starts; absent on the last page. */
  readonly next?: CursorPosition;
  /** The ledger's end before the read. */
  readonly snapshotAt: readonly CursorPosition[];
  readonly gaps: readonly PageGap[];
};

export type ObjectPageOptions<T> = {
  readonly limit: number;
  readonly before?: CursorPosition;
  /** The states an object is made in: its first line has one of them. */
  readonly entry: readonly string[];
  /** The object as served, from its current fold row. */
  readonly view: (current: LedgerRecord) => T;
};

/**
 * One page of objects. Lines are read a page at a time until `limit` objects are found or
 * the ledger has no older line.
 *
 * First consumers: `commands.list`, and the control API's deployment list.
 */
export function pageObjects<T>(ledger: Ledger, options: ObjectPageOptions<T>): ObjectPage<T> {
  const fold = foldStates(ledger);
  const current = (id: string, line: LedgerRecord): LedgerRecord =>
    fold.ok ? (fold.objects.get(id)?.record ?? line) : line;
  const items: T[] = [];
  const gaps: PageGap[] = [];
  const seen = new Set<string>();
  let snapshotAt: readonly CursorPosition[] | undefined;
  let before = options.before;
  for (;;) {
    const page = readPage(ledger, {
      limit: Math.max(options.limit, 64),
      ...(before !== undefined ? { before } : {}),
    });
    snapshotAt ??= page.snapshotAt;
    gaps.push(...page.gaps);
    for (const item of page.items) {
      const id = item.record["id"];
      if (typeof id !== "string" || seen.has(id)) continue;
      if (!options.entry.includes(String(item.record["state"]))) continue;
      seen.add(id);
      items.push(options.view(current(id, item.record)));
      if (items.length === options.limit) {
        return { items, next: item.at, snapshotAt, gaps };
      }
    }
    if (page.next === undefined) return { items, snapshotAt, gaps };
    before = page.next;
  }
}
