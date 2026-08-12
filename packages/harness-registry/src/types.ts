/**
 * Record schemas for the machine-wide harness registry file
 * (`<registryRoot>/harnesses.json`, format `v: 2`).
 *
 * Format discipline is ADDITIVE: every shape carries an index signature so
 * fields written by a newer CLI are tolerated on read and preserved verbatim
 * on rewrite — an older CLI must never strip what a newer one recorded.
 * Documents with `v < 2` (or no `v` at all — the legacy watchme-format
 * registry) are lifted best-effort on read; the lift persists on the next
 * write.
 *
 * This package is a pure registry-file layer: it never parses specs and
 * never scans the filesystem for harnesses. Callers supply `specName` and
 * `target`; discovery lives elsewhere.
 */

/** How an entry first got into the registry. Stable across refreshes. */
export type HarnessOrigin = "scan" | "manual" | "run-hook" | "import";

/** Local checkout vs a remote deployment-pointer row. */
export type HarnessKind = "local" | "remote";

/** One registered harness. Identity is the absolute `dir` (the upsert key); */
/** `id` is minted once on first registration and stays stable thereafter. */
export type HangarHarnessEntry = {
  /** `hrn_` + 16 lowercase hex, crypto-random; stable across renames. */
  readonly id: string;
  /** Absolute harness directory — THE upsert identity key. */
  readonly dir: string;
  /** Spec `name:` as supplied by the caller; refreshed on touch. */
  readonly specName: string;
  /** Target shape as supplied by the caller; refreshed on touch. */
  readonly target: string;
  readonly origin: HarnessOrigin;
  /** e.g. `run|compile|eval|dev` for `run-hook`, `watchme` for `import`. */
  readonly originDetail: string;
  /** ISO 8601; set once at first registration. */
  readonly registeredAt: string;
  /** ISO 8601; refreshed on every upsert. */
  readonly lastSeen: string;
  /** User-managed; never clobbered by an upsert refresh. */
  readonly groups: readonly string[];
  /**
   * Per-group boot order for this member, keyed by group name (1-based,
   * lower boots first). Absent for a member with no declared order, which
   * sorts after every ordered one.
   *
   * This is a MEMBER's order INSIDE a group, distinct from `GroupDef.order`
   * (the groups' order relative to each other). A fleet has dependency
   * order — a secretary whose A2A door every other spec mounts has to be up
   * before them, and the chief that supervises the rest comes last — and
   * that order lives per member, not per group.
   *
   * Keyed by name rather than held as a list on the group so that renaming
   * a group (which rewrites `groups` on every entry) and removing a member
   * cannot leave a dangling ordering behind.
   */
  readonly groupOrder?: Readonly<Record<string, number>>;
  /** User-managed; never clobbered by an upsert refresh. */
  readonly tags: readonly string[];
  /** User-managed; pinned entries survive prune prompts. */
  readonly pinned: boolean;
  /** User-managed free text; never clobbered by an upsert refresh. */
  readonly notes: string;
  readonly kind: HarnessKind;
  /** Carried through for watchme registry compatibility. */
  readonly watchme: { readonly share: boolean; readonly [extra: string]: unknown };
  /** Opaque deployment-pointer objects; passed through untouched. */
  readonly remotes: ReadonlyArray<Readonly<Record<string, unknown>>>;
  /** ISO 8601 stamped when the dir vanishes; cleared when it is back.
   *  Vanished entries are NEVER silently pruned from the file. */
  readonly missingSince: string | null;
  /** Unknown fields from newer writers, preserved on rewrite. */
  readonly [extra: string]: unknown;
};

/** One user-configured scan root (walked by the inventory layer, not here). */
export type ScanRoot = {
  /** Absolute directory to walk. */
  readonly dir: string;
  readonly depth: number;
  readonly auto: boolean;
  readonly rescanIntervalMin: number;
  /** ISO 8601 of the last completed walk, or null if never walked. */
  readonly lastScanAt: string | null;
  readonly [extra: string]: unknown;
};

/** One flat, ordered, colored group definition. */
export type GroupDef = {
  readonly name: string;
  /** 1-based display order. */
  readonly order: number;
  /** CSS color string; empty when unset. */
  readonly color: string;
  readonly [extra: string]: unknown;
};

/** The whole `harnesses.json` document. */
export type HangarRegistryDoc = {
  readonly v: 2;
  readonly harnesses: readonly HangarHarnessEntry[];
  readonly scanRoots: readonly ScanRoot[];
  readonly groups: readonly GroupDef[];
  readonly [extra: string]: unknown;
};
