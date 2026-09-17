/**
 * Migration bookkeeping — which files exist, which have run, what is left.
 *
 * The ordering rule is the whole contract, so it is stated once here and
 * nowhere else: files are ordered by plain codepoint comparison of their
 * FILENAME. No `localeCompare` (its answer depends on the operator's locale),
 * no numeric-aware comparison (it would put `10` before `9` on one machine
 * and after it on another). That means `2.sql` sorts after `10.sql`, which is
 * exactly why the convention is zero-padded or timestamped prefixes, and why
 * `hasAmbiguousOrdering` flags a directory that mixes widths before anything
 * runs.
 *
 * Pure: takes the filenames and the applied rows, returns the plan.
 */

/** A migration file, as the directory listing found it. */
export type MigrationFile = {
  readonly name: string;
  readonly checksum: string;
};

/** A row of the migrations table. */
export type AppliedMigration = {
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
};

export type MigrationPlan = {
  /** Files not yet recorded, in the order they will run. */
  readonly pending: readonly MigrationFile[];
  /** Files already recorded, in file order. */
  readonly applied: readonly MigrationFile[];
  /**
   * Recorded names with no file on disk. Usually a deleted migration or the
   * wrong directory; either way, applying more on top is a bad idea.
   */
  readonly missingFiles: readonly string[];
  /**
   * Files whose contents changed after they were applied. An applied
   * migration is history: editing one means the database and the directory
   * no longer describe the same schema.
   */
  readonly modified: readonly string[];
  /**
   * Pending files that sort BEFORE an already-applied one. Running them now
   * would apply history out of order, which is how two environments end up
   * with the same migration list and different schemas.
   */
  readonly outOfOrder: readonly string[];
};

/** Keep only `.sql` files, ordered by codepoint. The rest are reported. */
export function selectMigrationFiles(names: readonly string[]): {
  ordered: string[];
  ignored: string[];
} {
  const ordered: string[] = [];
  const ignored: string[] = [];
  for (const name of names) {
    if (name.toLowerCase().endsWith(".sql")) ordered.push(name);
    else ignored.push(name);
  }
  ordered.sort(compareNames);
  ignored.sort(compareNames);
  return { ordered, ignored };
}

/** Plain codepoint order — see the note at the top of this file. */
export function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * True when the directory mixes numeric prefix widths, so codepoint order
 * and the order a human intends will disagree (`2_x.sql` after `10_x.sql`).
 */
export function hasAmbiguousOrdering(names: readonly string[]): boolean {
  const widths = new Set<number>();
  for (const name of names) {
    const matched = name.match(/^(\d+)/);
    const digits = matched?.[1];
    if (digits !== undefined) widths.add(digits.length);
  }
  return widths.size > 1;
}

/** Work out what to run against what has already run. */
export function planMigrations(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): MigrationPlan {
  const appliedByName = new Map(applied.map((a) => [a.name, a]));
  const fileNames = new Set(files.map((f) => f.name));
  const pending: MigrationFile[] = [];
  const done: MigrationFile[] = [];
  const modified: string[] = [];
  for (const file of files) {
    const record = appliedByName.get(file.name);
    if (record === undefined) {
      pending.push(file);
      continue;
    }
    done.push(file);
    // An empty recorded checksum means the row predates checksum recording;
    // claiming it was modified would be a false alarm.
    if (record.checksum !== "" && record.checksum !== file.checksum) modified.push(file.name);
  }
  const missingFiles = applied.map((a) => a.name).filter((name) => !fileNames.has(name));
  const lastApplied = done.length === 0 ? undefined : (done[done.length - 1] as MigrationFile).name;
  const outOfOrder =
    lastApplied === undefined
      ? []
      : pending.filter((f) => compareNames(f.name, lastApplied) < 0).map((f) => f.name);
  missingFiles.sort(compareNames);
  modified.sort(compareNames);
  outOfOrder.sort(compareNames);
  return { pending, applied: done, missingFiles, modified, outOfOrder };
}
