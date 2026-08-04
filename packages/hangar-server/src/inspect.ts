/**
 * M3 · INSPECT — the raw browsers that make "inspect ALL captured data"
 * literally true, plus the `settings.json` editor.
 *
 * STUBS. Owned by the Inspect+Runtime implementer together with
 * `runtime-ops.ts`.
 *
 * ---------------------------------------------------------------------------
 * THE READ ALLOWLIST — and the three things it must never reach
 * ---------------------------------------------------------------------------
 * `.crewhaus/` is browsable EXCEPT:
 *   - `secrets/`        — the secrets backend's material,
 *   - the raw audit files — served only as rendered records through the
 *     audit-log verify/read API (`security-ops.ts`),
 *   - `.env` (and any `.env.*`) — presence booleans only, via `creds-ops.ts`.
 * Those three exclusions are enforced HERE, in the store allowlist and in
 * the generic raw browser, not in the UI.
 *
 * The named stores this module browses ({@link INSPECT_STORE_NOTE}):
 *   scope-audit    `.crewhaus/scope-audit/baseline.json` (lint's output)
 *   prompt-cache   `prompt-cache/<spec>.json` — the cache-rotation record
 *   logs           `.crewhaus/logs/` — NOT `.crewhaus/run/logs/<runId>.log`,
 *                  which is raw by construction and is served only through
 *                  the supervisor's scrubbed paths (`runs.ts`)
 *   skills         `.crewhaus/skills/` incl. the auto-discovered FAQ skill
 *   commands       `.crewhaus/commands/`
 *   preferences    `.crewhaus/preferences/`
 *   settings       `.crewhaus/settings.json` — permission rules + hooks
 *   knowledge      `.crewhaus/knowledge.json` — share opt-in state
 *   identity       `.crewhaus/identity.json` — the Ed25519 fingerprint that
 *                  stamps every trace envelope (display the fingerprint; the
 *                  private key is not in this file and must never be sought)
 *   meta           `.crewhaus/meta.json` — schema versions, migration stamps
 *   environments   `.crewhaus/environments.json`
 *
 * Every read is per-file realpath-contained (a listed NAME can be a symlink
 * out of the tree), capped, torn-line tolerant, and masked. A missing store
 * is an empty state, never a 500 — absence is not an error.
 *
 * The generic raw browser is the fallback that makes the claim honest: it
 * takes a harness-relative `?path=`, resolves it with the same containment
 * check, refuses the three exclusions above, and serves text capped and
 * masked. It is READ-ONLY. There is no generic write.
 */
import type { M3Handler } from "./m3";
import { notImplemented } from "./m3";

/** The closed set of named stores the inspector browses. Anything outside it
 *  falls to the generic raw browser (which applies the same exclusions). */
export const INSPECT_STORES = [
  "scope-audit",
  "prompt-cache",
  "logs",
  "skills",
  "commands",
  "preferences",
  "settings",
  "knowledge",
  "identity",
  "meta",
  "environments",
] as const;

export type InspectStore = (typeof INSPECT_STORES)[number];

export function isInspectStore(value: string): value is InspectStore {
  return (INSPECT_STORES as readonly string[]).includes(value);
}

/** Referenced by the module docblock so the store list has one home. */
export const INSPECT_STORE_NOTE =
  "secrets/, raw audit files and .env are excluded from every inspect route";

/**
 * `GET /api/h/:id/inspect` — the store index.
 *
 * Which of {@link INSPECT_STORES} exist in this harness, their entry counts
 * and sizes, and an explicit note for the three excluded subtrees so their
 * absence reads as a POLICY, not as a gap.
 */
export const inspectIndex: M3Handler = () => notImplemented("inspect index");

/**
 * `GET /api/h/:id/inspect/:store` — one named store's entries.
 *
 * `:store` must be in {@link INSPECT_STORES} (404 otherwise). Directory
 * stores list entries; single-file stores (settings/knowledge/identity/meta/
 * environments) return the parsed document, masked.
 */
export const inspectStore: M3Handler = () => notImplemented("inspect store");

/** `GET /api/h/:id/inspect/:store/:name` — one entry inside a directory
 *  store, containment-checked per file and capped. */
export const inspectEntry: M3Handler = () => notImplemented("inspect entry");

/**
 * `GET /api/h/:id/inspect/raw` — the generic raw browser.
 *
 * `?path=` is harness-relative and resolved through the same containment
 * check as every other read. Refuse `secrets/`, the raw audit files and
 * `.env*`. Directory paths list; file paths return capped, masked text.
 * READ-ONLY — this route has no write twin, deliberately.
 */
export const inspectRaw: M3Handler = () => notImplemented("raw browser");

/**
 * `PUT /api/h/:id/inspect/settings` — edit `.crewhaus/settings.json`.
 *
 * Permission rules and hooks — the files `tools audit` / `permissions
 * suggest` write. This is HUMAN-OWNED configuration, so it carries the same
 * trust-tier gate the spec's human-owned paths do: a redacted diff
 * interstitial plus a typed confirmation. Write atomically (tmp + rename)
 * and re-validate before replacing; a malformed settings.json changes what
 * the agent is allowed to do.
 */
export const settingsWrite: M3Handler = () => notImplemented("settings.json write");
