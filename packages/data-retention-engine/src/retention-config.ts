import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * `.crewhaus/retention.json` — the shared on-disk retention policy for a
 * harness directory. Owned by this package (not the CLI) so EVERY enforcement
 * surface reads the same file with the same parser:
 *
 *   - `crewhaus retention sweep|export|purge` (apps/cli/src/retention.ts),
 *   - the boot-time self-heal janitor the daemon shapes run
 *     (`@crewhaus/runtime-core` createJanitor — managed gateway, channel
 *     bots, batch workers), which must honor the SAME pins and
 *     `sessions.maxAgeDays` or the two enforcement paths contradict each
 *     other (ops-review F2: a janitor on the 30-day default would delete
 *     sessions the operator pinned or configured to keep longer).
 *
 * Schema (all keys optional):
 *
 *   {
 *     "version": 1,
 *     "sessions": { "maxAgeDays": 30 },   // default: DEFAULT_SESSION_MAX_AGE_DAYS
 *     "pins": ["sess_0123456789abcdef"],  // session ids never deleted
 *     "auditWindows": [                   // active windows defer ALL deletion
 *       {                                 // (compliance-controls evidence
 *         "frameworkId": "soc2",          // collection in flight)
 *         "controlId": "CC6.1",
 *         "expiresAt": "2026-08-01T00:00:00Z"
 *       }
 *     ]
 *   }
 *
 * Safety stance: a malformed file throws `RetentionConfigError` — an enforcer
 * that half-understands its policy must not guess. Already-expired
 * auditWindows are dropped at load (a stale entry should stop deferring, not
 * brick the sweep).
 */

export const RETENTION_CONFIG_RELPATH = ".crewhaus/retention.json";

/**
 * Default `sessions.maxAgeDays` when `.crewhaus/retention.json` is absent or
 * silent. Mirrors `@crewhaus/session-store`'s `DEFAULT_TTL_DAYS` (30) — the
 * TTL `list()`-side eviction uses — kept as a local constant so this package
 * does not depend on session-store; apps/cli pins the two together in a test.
 */
export const DEFAULT_SESSION_MAX_AGE_DAYS = 30;

/** The `sess_<16 hex>` session-id shape shared with `@crewhaus/session-store`. */
export const SESSION_ID_REGEX = /^sess_[0-9a-f]{16}$/;

/** Thrown on a malformed `.crewhaus/retention.json` (and, in the CLI, on an
 *  export outDir that would write into a live store). The CLI entry file
 *  catches it and routes the message through `die()`; daemons catch it and
 *  fail safe (disable eviction); tests assert on `.message`. */
export class RetentionConfigError extends Error {
  override readonly name = "RetentionConfigError";
}

export type RetentionAuditWindowConfig = {
  readonly frameworkId: string;
  readonly controlId: string;
  /** Epoch ms (parsed from the file's ISO string or numeric value). */
  readonly expiresAt: number;
};

export type RetentionConfig = {
  /** Max session age in days before enforcement deletes it (mtime-keyed). */
  readonly sessionMaxAgeDays: number;
  /** Session ids (`sess_<16 hex>`) enforcement refuses to delete. */
  readonly pins: ReadonlyArray<string>;
  /** Declared audit windows; expired entries are dropped at load. */
  readonly auditWindows: ReadonlyArray<RetentionAuditWindowConfig>;
  /** Whether `.crewhaus/retention.json` existed (defaults were used if not). */
  readonly fromFile: boolean;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Load `.crewhaus/retention.json` from `rootDir`, falling back to defaults
 * (sessions at {@link DEFAULT_SESSION_MAX_AGE_DAYS}, no pins, no windows)
 * when the file is absent. A malformed file throws `RetentionConfigError` —
 * an enforcer that half-understands its policy must not guess.
 */
export async function loadRetentionConfig(
  rootDir: string,
  now: () => number = () => Date.now(),
): Promise<RetentionConfig> {
  const path = join(rootDir, RETENTION_CONFIG_RELPATH);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        sessionMaxAgeDays: DEFAULT_SESSION_MAX_AGE_DAYS,
        pins: [],
        auditWindows: [],
        fromFile: false,
      };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RetentionConfigError(`${path}: malformed JSON — ${(err as Error).message}`);
  }
  if (!isRecord(parsed)) {
    throw new RetentionConfigError(`${path}: expected a JSON object at the root`);
  }

  let sessionMaxAgeDays = DEFAULT_SESSION_MAX_AGE_DAYS;
  if (parsed["sessions"] !== undefined) {
    if (!isRecord(parsed["sessions"])) {
      throw new RetentionConfigError(`${path}: "sessions" must be an object`);
    }
    const maxAge = parsed["sessions"]["maxAgeDays"];
    if (maxAge !== undefined) {
      if (typeof maxAge !== "number" || !Number.isFinite(maxAge) || maxAge <= 0) {
        throw new RetentionConfigError(
          `${path}: "sessions.maxAgeDays" must be a finite number > 0 (got ${JSON.stringify(maxAge)})`,
        );
      }
      sessionMaxAgeDays = maxAge;
    }
  }

  const pins: string[] = [];
  if (parsed["pins"] !== undefined) {
    if (!Array.isArray(parsed["pins"])) {
      throw new RetentionConfigError(`${path}: "pins" must be an array of session ids`);
    }
    for (const pin of parsed["pins"]) {
      if (typeof pin !== "string" || !SESSION_ID_REGEX.test(pin)) {
        throw new RetentionConfigError(
          `${path}: pin ${JSON.stringify(pin)} is not a session id (expected sess_<16 hex>)`,
        );
      }
      pins.push(pin);
    }
  }

  const auditWindows: RetentionAuditWindowConfig[] = [];
  if (parsed["auditWindows"] !== undefined) {
    if (!Array.isArray(parsed["auditWindows"])) {
      throw new RetentionConfigError(`${path}: "auditWindows" must be an array`);
    }
    for (const w of parsed["auditWindows"]) {
      if (
        !isRecord(w) ||
        typeof w["frameworkId"] !== "string" ||
        typeof w["controlId"] !== "string"
      ) {
        throw new RetentionConfigError(
          `${path}: each auditWindow needs string "frameworkId" + "controlId" + "expiresAt"`,
        );
      }
      const rawExpires = w["expiresAt"];
      const expiresAt =
        typeof rawExpires === "number" ? rawExpires : Date.parse(String(rawExpires));
      if (!Number.isFinite(expiresAt)) {
        throw new RetentionConfigError(
          `${path}: auditWindow ${w["frameworkId"]}/${w["controlId"]} has an unparseable "expiresAt"`,
        );
      }
      // Already-expired windows are dropped here (the engine's addAuditWindow
      // throws on a past expiry — a stale config entry should stop deferring,
      // not brick the sweep).
      if (expiresAt > now()) {
        auditWindows.push({
          frameworkId: w["frameworkId"],
          controlId: w["controlId"],
          expiresAt,
        });
      }
    }
  }

  return { sessionMaxAgeDays, pins, auditWindows, fromFile: true };
}
