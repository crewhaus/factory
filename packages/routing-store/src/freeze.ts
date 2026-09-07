/**
 * 0.6.0 §6.3 / §10.1 — `crewhaus route freeze <policyVersion>`: the learned
 * policy's KILL SWITCH beside `route reset`.
 *
 * `route reset` wipes the scoreboard; `route freeze` keeps it and stops the
 * live loop from CHANGING it. The marker is one small JSON file beside the
 * arms — `<rootDir>/routing/freeze.json` — naming the `policyVersion`
 * (`model_route.policyVersion`, the pool fingerprint) the operator pinned.
 * While it exists:
 *
 *   - runtime-core wraps the scoreboard in {@link freezeScoreboard}: reads
 *     serve the frozen history, `record()` / `ungraded()` / `compact()` are
 *     no-ops, so no new observation moves an arm;
 *   - every `model_route` decision (and every arm line, were one written)
 *     reports the FROZEN `policyVersion` — the pin is what the operator
 *     asked to serve, and a roster edit made after the freeze does not
 *     silently become a new policy. A mismatch between the marker and the
 *     pool the runtime computed is reported once at boot.
 *
 * The marker is deliberately NOT scoped to a fingerprint match: a kill switch
 * that disarms itself on the next spec edit is not a kill switch. It is
 * cleared explicitly (`route freeze --clear`) or by `route reset`, which
 * removes the whole `routing/` state. Like the arms file it is local,
 * single-writer and tenant-fenced; Hangar never writes it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Scoreboard } from "./scoreboard.js";

/** The on-disk shape (version 1). */
export type RouteFreeze = {
  readonly version: 1;
  /** The pinned `policyVersion` (`model_route.policyVersion`). */
  readonly policyVersion: string;
  /** ISO-8601 timestamp of the freeze. */
  readonly frozenAt: string;
  /** Optional operator note. */
  readonly reason?: string;
};

export const ROUTE_FREEZE_FILE = "freeze.json";

/** `<rootDir>/routing/freeze.json`. */
export function routeFreezePath(rootDir: string): string {
  return join(rootDir, "routing", ROUTE_FREEZE_FILE);
}

/**
 * Read the freeze marker. `undefined` when absent; a marker that does not
 * parse or does not carry a string `policyVersion` is treated as absent AND
 * reported through `onMalformed` so a corrupt file never silently pins or
 * silently unpins routing.
 */
export function readRouteFreeze(
  rootDir: string,
  onMalformed?: (detail: string) => void,
): RouteFreeze | undefined {
  const path = routeFreezePath(rootDir);
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    onMalformed?.(
      `${path} is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
    return undefined;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    onMalformed?.(`${path} is not a JSON object`);
    return undefined;
  }
  const rec = raw as Record<string, unknown>;
  if (rec["version"] !== 1) {
    onMalformed?.(`${path} has unsupported version ${String(rec["version"])} (expected 1)`);
    return undefined;
  }
  if (typeof rec["policyVersion"] !== "string" || rec["policyVersion"].length === 0) {
    onMalformed?.(`${path} carries no policyVersion`);
    return undefined;
  }
  return {
    version: 1,
    policyVersion: rec["policyVersion"],
    frozenAt: typeof rec["frozenAt"] === "string" ? rec["frozenAt"] : "",
    ...(typeof rec["reason"] === "string" ? { reason: rec["reason"] } : {}),
  };
}

export type WriteRouteFreezeOptions = {
  readonly policyVersion: string;
  readonly reason?: string;
  /** Clock (tests). Defaults to `Date.now`. */
  readonly now?: () => number;
};

/** Write (or overwrite) the freeze marker. Returns the persisted record. */
export function writeRouteFreeze(rootDir: string, opts: WriteRouteFreezeOptions): RouteFreeze {
  const policyVersion = opts.policyVersion.trim();
  if (policyVersion.length === 0) {
    throw new Error("route freeze: a policyVersion is required");
  }
  const path = routeFreezePath(rootDir);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record: RouteFreeze = {
    version: 1,
    policyVersion,
    frozenAt: new Date((opts.now ?? Date.now)()).toISOString(),
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
  };
  // Write-then-rename: a concurrent boot reads the old marker or the new one.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return record;
}

/** Remove the freeze marker. Returns `true` when one was removed. */
export function clearRouteFreeze(rootDir: string): boolean {
  const path = routeFreezePath(rootDir);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/**
 * A READ-ONLY view of a scoreboard for a frozen policy: `score` / `snapshot`
 * / `path` pass through, every write (`record`, `ungraded`, `compact`) is a
 * no-op. The live loop keeps routing off the frozen history and records
 * nothing new until the marker is cleared.
 */
export function freezeScoreboard(inner: Scoreboard): Scoreboard {
  return {
    path: inner.path,
    score: (routeKey, model) => inner.score(routeKey, model),
    snapshot: () => inner.snapshot(),
    record: () => undefined,
    ungraded: () => undefined,
    compact: () => undefined,
  };
}
