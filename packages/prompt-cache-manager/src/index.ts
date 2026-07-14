/**
 * Section 27 — `prompt-cache-manager`. Long-running CHN/MGD/RES daemons
 * keep the same system prompt for weeks. Anthropic's prompt cache TTL is
 * 30 days; once the marker ages past TTL it silently stops being a cache
 * hit. This module rotates the marker proactively so we never go cold.
 *
 * Strategy:
 *  - Track the **age** of the most recent `cache_control` marker on the
 *    system block array. Caller threads a `lastRotatedAt` timestamp via
 *    state-store; we read it pre-stream and refresh when older than
 *    `rotateAfterMs` (default 7 days for safety margin against the 30-day
 *    Anthropic limit).
 *  - On rotation, the freshest block keeps `cache_control: { type: "ephemeral" }`;
 *    older blocks have their cache markers stripped (the Anthropic SDK's
 *    `null` is also accepted — we use the absence form for compactness).
 *
 * Adapters whose `features.caching` is `"automatic"` (OpenAI server-managed)
 * or `false` (Bedrock Llama/Mistral) skip rotation entirely — `manage()`
 * returns the input unchanged.
 *
 * The runtime-core integration calls `manage()` once before the model
 * stream starts and writes the timestamp back to state-store. Tests cover
 * the rotation triggers, the no-op skip, and the marker-stripping
 * invariants.
 */
import type {
  CanonicalCacheControl,
  CanonicalTextBlockParam,
  ProviderFeatures,
} from "@crewhaus/adapter-anthropic";

/** Default rotation period: 7 days. Anthropic's hard TTL is 30 days. */
export const DEFAULT_ROTATE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * v0.3.0 Goal 1 (§2.5) — a system block that may carry the `volatile` flag.
 * Volatile blocks are the mutable tail region runtime-core rebuilds per
 * model call (`<current_plan>` / `<requirements_ledger>`): they sit AFTER
 * the cache-marked frozen prefix and must NEVER receive a cache marker —
 * marking a block that changes every call would re-create (and re-bill) a
 * cache entry per turn, and marking anything after it would silently bust
 * the prefix cache. `manage()` therefore skips volatile blocks when picking
 * the marker target and strips any stray marker off them on rotation.
 * Plain `CanonicalTextBlockParam` arrays (every pre-0.3.0 caller) are
 * assignable as-is — `volatile` absent means the block is frozen-prefix
 * content, and behavior is byte-identical to before this flag existed.
 */
export type CacheManagedBlock = CanonicalTextBlockParam & {
  readonly volatile?: boolean;
};

export type ManageOptions = {
  /** Adapter features so we skip when caching is automatic / unsupported. */
  readonly features: ProviderFeatures;
  /**
   * Last time the cache marker was refreshed (ms epoch). Pass `0` or
   * `undefined` to force-refresh on the first turn.
   */
  readonly lastRotatedAt?: number;
  /** Override the rotation interval (default: `DEFAULT_ROTATE_AFTER_MS`). */
  readonly rotateAfterMs?: number;
  /** Override "now" for tests. Default: `Date.now()`. */
  readonly now?: () => number;
};

export type ManageResult = {
  /** The (possibly mutated) system blocks. */
  readonly blocks: ReadonlyArray<CacheManagedBlock>;
  /**
   * `true` if we wrote a fresh marker; the caller must persist
   * `result.rotatedAt` to state-store. `false` when we skipped (either
   * caching is automatic/unsupported, or the existing marker is still
   * fresh).
   */
  readonly rotated: boolean;
  /** New `lastRotatedAt` to persist; equals `now` when rotated, or the input when not. */
  readonly rotatedAt: number;
};

/**
 * Inject or refresh `cache_control` markers on the supplied system blocks.
 * Returns the (possibly mutated) blocks plus a `rotated` flag the caller
 * persists to state-store.
 *
 * Contract:
 *  - When `features.caching !== "explicit"`, returns input unchanged with
 *    `rotated: false`.
 *  - When `lastRotatedAt` is undefined or stale relative to `rotateAfterMs`,
 *    strips existing markers off all blocks, marks the LAST NON-VOLATILE
 *    block with a fresh `{ type: "ephemeral" }`, and returns `rotated: true`
 *    plus the current timestamp. Blocks flagged `volatile: true` (the
 *    mutable tail region, §2.5) are NEVER marked — the marker must stay on
 *    the frozen prefix so per-call tail edits re-tokenize only the tail —
 *    and any stray marker on them is stripped.
 *  - When the marker is fresh, returns input unchanged with `rotated: false`.
 *  - When `blocks` is empty (or every block is volatile — there is no frozen
 *    prefix to cache), returns input unchanged with `rotated: false`.
 */
export function manage(
  blocks: ReadonlyArray<CacheManagedBlock>,
  opts: ManageOptions,
): ManageResult {
  const now = (opts.now ?? Date.now)();

  if (opts.features.caching !== "explicit" || blocks.length === 0) {
    return {
      blocks,
      rotated: false,
      rotatedAt: opts.lastRotatedAt ?? 0,
    };
  }

  const rotateAfterMs = opts.rotateAfterMs ?? DEFAULT_ROTATE_AFTER_MS;
  const lastRotatedAt = opts.lastRotatedAt ?? 0;
  const isStale = lastRotatedAt === 0 || now - lastRotatedAt >= rotateAfterMs;

  if (!isStale) {
    return { blocks, rotated: false, rotatedAt: lastRotatedAt };
  }

  // The marker target is the LAST NON-VOLATILE block: everything after it
  // (the volatile tail) is rebuilt per model call and must sit outside the
  // cached prefix. All-volatile input has nothing stable to cache — no-op.
  let lastStable = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]?.volatile !== true) {
      lastStable = i;
      break;
    }
  }
  if (lastStable === -1) {
    return { blocks, rotated: false, rotatedAt: lastRotatedAt };
  }

  // Strip existing markers; refresh the last non-volatile block. Volatile
  // blocks keep their flag (so a re-manage stays stable) and never a marker.
  const next: CacheManagedBlock[] = blocks.map((b, i) => {
    if (i === lastStable) {
      const cache_control: CanonicalCacheControl = { type: "ephemeral" };
      return { type: "text", text: b.text, cache_control };
    }
    return b.volatile === true
      ? { type: "text", text: b.text, volatile: true }
      : { type: "text", text: b.text };
  });
  return { blocks: next, rotated: true, rotatedAt: now };
}

/**
 * Diagnostic helper. Counts how many blocks currently carry a non-null
 * `cache_control` marker. Used by tests + the OTel exporter's `cache.markers`
 * span attribute.
 */
export function countCacheMarkers(blocks: ReadonlyArray<CanonicalTextBlockParam>): number {
  let n = 0;
  for (const b of blocks) {
    if (b.cache_control && b.cache_control.type === "ephemeral") n++;
  }
  return n;
}
