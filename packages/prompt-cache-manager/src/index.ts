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
 * stream starts and writes the timestamp back through the
 * {@link PromptCacheRotationStore} — the cross-run persistence, keyed by
 * spec name, that closes the §2.5 seam (Batch E item 9/G78). Tests cover the
 * rotation triggers, the no-op skip, the marker-stripping invariants, and the
 * store's read/write round-trip.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CanonicalCacheControl,
  CanonicalTextBlockParam,
  ProviderFeatures,
} from "@crewhaus/adapter-anthropic";
import { CrewhausError } from "@crewhaus/errors";

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

// ===========================================================================
// Cross-run rotation persistence (Batch E item 9, G78) — the promised seam
// ===========================================================================
//
// runtime-core threads `promptCacheLastRotatedAt` IN (so a valid recent
// timestamp makes `manage()` skip and REUSE the existing cached prefix rather
// than cold-starting on every boot) and calls `onPromptCacheRotated(rotatedAt)`
// OUT when it injected a fresh marker. Long-running daemons (channel/managed)
// need that timestamp to survive a restart, so it persists to disk keyed by
// spec name — one small JSON file per spec, exactly the state-store seam the
// v0.3.0 §2.5 comment promised would "land with memory-service/threading".
// The serving emitters read() at boot for the `promptCacheLastRotatedAt` field
// and pass `onPromptCacheRotated: (t) => store.write(t)`.

/** Default root for per-spec rotation state, a sibling of `.crewhaus/memories`
 *  and `.crewhaus/sessions`. */
export const DEFAULT_PROMPT_CACHE_ROOT_DIR = ".crewhaus/prompt-cache";

/** Schema marker stamped on every persisted record (forward-compat read). */
export const PROMPT_CACHE_ROTATION_SCHEMA_VERSION = 1 as const;

export class PromptCacheStoreError extends CrewhausError {
  override readonly name = "PromptCacheStoreError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/** The persisted on-disk shape. `lastRotatedAt` is the ms-epoch timestamp of
 *  the most recent marker rotation for this spec. */
export type PromptCacheRotationRecord = {
  readonly schemaVersion: typeof PROMPT_CACHE_ROTATION_SCHEMA_VERSION;
  readonly specName: string;
  readonly lastRotatedAt: number;
};

export type PromptCacheRotationStoreOptions = {
  /** Scopes the file path; one record per spec. Validated path-safe. */
  readonly specName: string;
  /** Root dir for the `<specName>.json` record. Default
   *  {@link DEFAULT_PROMPT_CACHE_ROOT_DIR}. A tenant re-roots by passing its
   *  own `.crewhaus` dir here. */
  readonly rootDir?: string;
};

export interface PromptCacheRotationStore {
  /**
   * The persisted `lastRotatedAt` for this spec, or `undefined` when no record
   * exists yet (first boot) or the record is unreadable/corrupt. A caller
   * threads the result straight into `runChatLoop`'s
   * `promptCacheLastRotatedAt` (an `undefined` there force-refreshes on the
   * first turn — the safe direction).
   */
  read(): Promise<number | undefined>;
  /**
   * Persist a fresh rotation timestamp (the `onPromptCacheRotated` payload).
   * Atomic (tmp + rename, mode 0600); creates the root dir on first write.
   */
  write(rotatedAt: number): Promise<void>;
  /** Diagnostic: the file this store reads/writes. */
  path(): string;
}

/** Same path-safe floor the fact store enforces — the spec name becomes a file
 *  name, so a traversal-shaped name must never reach the filesystem. */
const SAFE_SPEC_NAME_RE = /^[a-zA-Z0-9_\-.]+$/;

function isRotationRecord(value: unknown): value is PromptCacheRotationRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["lastRotatedAt"] === "number" && Number.isFinite(v["lastRotatedAt"]);
}

/**
 * Construct a per-spec rotation store. The file is lazy — no directory is
 * touched until the first `write()`; a `read()` before any write returns
 * `undefined`.
 */
export function createPromptCacheRotationStore(
  opts: PromptCacheRotationStoreOptions,
): PromptCacheRotationStore {
  if (!opts.specName) {
    throw new PromptCacheStoreError("specName is required");
  }
  if (!SAFE_SPEC_NAME_RE.test(opts.specName)) {
    throw new PromptCacheStoreError(
      `invalid specName "${opts.specName}" — must match [a-zA-Z0-9_\\-.]+`,
    );
  }
  const rootDir = opts.rootDir ?? DEFAULT_PROMPT_CACHE_ROOT_DIR;
  const filePath = join(rootDir, `${opts.specName}.json`);

  return {
    async read(): Promise<number | undefined> {
      let raw: string;
      try {
        raw = await readFile(filePath, "utf-8");
      } catch {
        // Missing file (first boot) or unreadable — treat as "no record".
        return undefined;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // A corrupt record must not brick boot — force a fresh rotation.
        return undefined;
      }
      return isRotationRecord(parsed) ? parsed.lastRotatedAt : undefined;
    },

    async write(rotatedAt: number): Promise<void> {
      if (typeof rotatedAt !== "number" || !Number.isFinite(rotatedAt) || rotatedAt < 0) {
        throw new PromptCacheStoreError(
          `write(): rotatedAt must be a non-negative finite number (got ${rotatedAt})`,
        );
      }
      const record: PromptCacheRotationRecord = {
        schemaVersion: PROMPT_CACHE_ROTATION_SCHEMA_VERSION,
        specName: opts.specName,
        lastRotatedAt: rotatedAt,
      };
      await mkdir(rootDir, { recursive: true });
      const tmpPath = `${filePath}.tmp`;
      await writeFile(tmpPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      await rename(tmpPath, filePath);
    },

    path(): string {
      return filePath;
    },
  };
}
