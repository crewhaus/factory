/**
 * Reading `.crewhaus/settings.json` well enough to say what a proposed rule
 * would ADD — and well enough to refuse when it cannot say.
 *
 * `@crewhaus/harness-advice` owns the parse: `existingSettingsRules` extracts
 * the exact shape `buildRuleSet` consumes, and `diffPermissions` computes the
 * additive diff. This module is the I/O around them plus one check neither of
 * them makes, which matters because of how `--apply` works downstream.
 *
 * ---------------------------------------------------------------------------
 * WHY `merged` NEEDS A GUARD
 * ---------------------------------------------------------------------------
 * `existingSettingsRules` is deliberately TOLERANT: an entry that is not an
 * object, or whose `type` is not one of the three it knows, is skipped, and a
 * file that is not the expected shape at all yields `[]`. That is right for
 * reading. It is dangerous for writing, because `diffPermissions` then builds
 * `merged = [...existing, ...additions]` and `applyToSettingsRoot` writes
 * `merged` as the WHOLE `rules` array. Every entry the reader skipped is gone.
 *
 * So a settings file with a typo'd rule type, or a rule from a newer CrewHaus
 * than the one reading it, comes back from a round-trip one rule shorter — and
 * if the dropped one was an `alwaysDeny`, the round-trip quietly removed a
 * guard. Nothing in THIS package writes, so it cannot cause that; what it can
 * do is refuse to hand a caller a `merged` list that is not the file's rules
 * plus the additions. When the counts disagree, `merged` is withheld and the
 * reason is named, and the suggestions are still reported on their own.
 */
import { readFileSync, statSync } from "node:fs";
import { type SettingsPermissionRule, existingSettingsRules } from "@crewhaus/harness-advice";

/** A settings file is JSON a human wrote; anything past this is not one. */
export const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;

export type SettingsRead =
  /** No settings file. There are no existing rules — a real, empty answer. */
  | { readonly kind: "missing" }
  /** It is there and could not be read or parsed. The rules are UNKNOWN. */
  | { readonly kind: "unusable"; readonly reason: string }
  | {
      readonly kind: "read";
      /** The parsed root, for `diffPermissions`/`applyToSettingsRoot` callers. */
      readonly root: unknown;
      readonly rules: readonly SettingsPermissionRule[];
      /**
       * `null` when the file declares no `permissions.rules` array at all.
       * Otherwise the number of ENTRIES in it, which is what `rules.length` is
       * compared against.
       */
      readonly declaredEntries: number | null;
      /**
       * Set when a merge built from `rules` would not round-trip the file:
       * entries exist that this reader does not recognise and a write would
       * drop. A caller must not present `merged` as the resulting file.
       */
      readonly mergeUnsafeReason?: string;
    };

/** Read and classify the settings file at `pathReal`. */
export function readSettings(pathReal: string): SettingsRead {
  let size: number;
  try {
    const stat = statSync(pathReal);
    if (!stat.isFile()) return { kind: "unusable", reason: "the settings path is not a file" };
    size = stat.size;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    return {
      kind: "unusable",
      reason: `the settings file could not be examined (${code ?? "an unidentified error"})`,
    };
  }
  // The cap is applied to the SIZE ON DISK, before a byte is read, so the
  // refusal costs no memory. A cap applied after the read would not be one.
  if (size > MAX_SETTINGS_BYTES) {
    return {
      kind: "unusable",
      reason: `the settings file is ${size} bytes, over the ${MAX_SETTINGS_BYTES} limit for this tool`,
    };
  }
  let text: string;
  try {
    text = readFileSync(pathReal, "utf8");
  } catch (err) {
    return {
      kind: "unusable",
      reason: `the settings file could not be read (${(err as NodeJS.ErrnoException).code ?? "an unidentified error"})`,
    };
  }
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (err) {
    // A settings file that does not parse is NOT a settings file with no rules.
    // Treating it as one would propose additions against an empty baseline and
    // a merge that discards whatever is really in there.
    return {
      kind: "unusable",
      reason: `the settings file is not valid JSON (${err instanceof Error ? err.message : String(err)}), so the rules already in force cannot be read`,
    };
  }
  const rules = existingSettingsRules(root);
  const declaredEntries = countDeclaredRuleEntries(root);
  const mergeUnsafeReason = mergeSafety(rules.length, declaredEntries, root);
  return {
    kind: "read",
    root,
    rules,
    declaredEntries,
    ...(mergeUnsafeReason !== undefined ? { mergeUnsafeReason } : {}),
  };
}

/** How many entries the file's own `permissions.rules` array holds, or `null`
 *  when there is no such array. Counted on the RAW value, never on the parsed
 *  rules — the difference between the two is the whole point. */
export function countDeclaredRuleEntries(root: unknown): number | null {
  if (root === null || typeof root !== "object") return null;
  const perms = (root as { permissions?: unknown }).permissions;
  if (perms === null || typeof perms !== "object") return null;
  const rules = (perms as { rules?: unknown }).rules;
  return Array.isArray(rules) ? rules.length : null;
}

function mergeSafety(
  parsedCount: number,
  declaredEntries: number | null,
  root: unknown,
): string | undefined {
  if (declaredEntries === null) {
    const perms =
      root !== null && typeof root === "object"
        ? (root as { permissions?: unknown }).permissions
        : undefined;
    if (perms !== undefined && perms !== null && typeof perms === "object") {
      const rules = (perms as { rules?: unknown }).rules;
      if (rules !== undefined) {
        return "the file declares `permissions.rules` as something other than an array, so what is in force cannot be read and a merge cannot be described";
      }
    }
    return undefined; // genuinely no rules array — nothing to lose.
  }
  if (declaredEntries !== parsedCount) {
    return `the file declares ${declaredEntries} rule entr${declaredEntries === 1 ? "y" : "ies"} but only ${parsedCount} ${parsedCount === 1 ? "is" : "are"} in a shape this reader recognises; a merged list built from the recognised ones would silently drop the rest, so none is offered`;
  }
  return undefined;
}
