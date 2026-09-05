/**
 * Profile references — the `$<profile>` sigil and its resolution (§4.1, §4.3).
 *
 * `$` is free in the model-string grammar (no branch begins with it) and the
 * repo's `yaml` parses `model: $fast` to the plain string `"$fast"`.
 * `PROFILE_NAME_RE` is deliberately first-character-disjoint from the
 * documented `$UPPER_SNAKE` env-ref convention, so a profile ref can never
 * read as a secret ref and vice versa.
 */
import type { ModelProfile, ProfileRegistry } from "./types.js";

/** `/^[a-z][a-z0-9_-]{0,63}$/` — narrower than `safeName`, lowercase-first. */
export const PROFILE_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export class ModelPlanError extends Error {
  override readonly name = "ModelPlanError";
}

/** TRUE when `value` is spelled as a profile reference (`$` + name). */
export function isProfileRef(value: string): boolean {
  return value.startsWith("$");
}

/** The profile name a `$ref` names, or `undefined` for a non-ref. */
export function profileRefName(value: string): string | undefined {
  return isProfileRef(value) ? value.slice(1) : undefined;
}

export type ResolvedProfileRef = {
  /** The concrete spec model string the slot resolves to. */
  readonly model: string;
  /** The profile name when `value` was a `$ref`. */
  readonly profile?: string;
  /** The profile's settings when `value` was a `$ref`. */
  readonly settings?: ModelProfile;
};

/**
 * Resolve one model slot value against the `models:` registry. A grammar
 * string (or a sentinel) passes through as `{ model }`; a `$ref` yields the
 * profile's `model` plus the profile itself for the caller to merge
 * (`applyProfileDefaults`). Throws `ModelPlanError` with a did-you-mean
 * naming the nearest declared profile when the ref does not resolve, or when
 * the name violates `PROFILE_NAME_RE`.
 */
export function resolveProfileRef(
  value: string,
  registry: ProfileRegistry | undefined,
  slotLabel = "model",
): ResolvedProfileRef {
  const name = profileRefName(value);
  if (name === undefined) return { model: value };
  if (!PROFILE_NAME_RE.test(name)) {
    throw new ModelPlanError(
      `${slotLabel}: "${value}" is not a valid profile reference — profile names match /^[a-z][a-z0-9_-]{0,63}$/`,
    );
  }
  const profile = registry?.[name];
  if (profile === undefined) {
    const declared = Object.keys(registry ?? {});
    const nearest = nearestName(name, declared);
    const hint =
      declared.length === 0
        ? "this spec declares no models: block"
        : nearest !== undefined
          ? `did you mean "$${nearest}"? declared: ${declared.map((d) => `$${d}`).join(", ")}`
          : `declared: ${declared.map((d) => `$${d}`).join(", ")}`;
    throw new ModelPlanError(`${slotLabel}: unknown profile "${value}" — ${hint}`);
  }
  return {
    model: profile.model,
    profile: name,
    settings: { ...profile, profile: name },
  };
}

/**
 * Precedence (§4.1): a profile supplies defaults; slot-local fields override
 * field-by-field. `tags` REPLACE the profile's tags when the slot declares
 * any (they are the routing identity, not an accumulation). The profile name
 * survives as provenance. Returns a new object; neither input is mutated.
 */
export function applyProfileDefaults(
  local: Partial<ModelProfile>,
  profile: ModelProfile,
): ModelProfile {
  const merged: Record<string, unknown> = { ...profile };
  for (const [key, value] of Object.entries(local)) {
    if (value !== undefined) merged[key] = value;
  }
  if (local.tags !== undefined) merged["tags"] = local.tags;
  if (profile.profile !== undefined && local.profile === undefined) {
    merged["profile"] = profile.profile;
  }
  return merged as ModelProfile;
}

/**
 * Validate every profile name in a registry. Returns the offending names
 * (empty when the registry is well-formed) so a caller can report all of
 * them in one cross-field issue.
 */
export function invalidProfileNames(registry: ProfileRegistry): string[] {
  return Object.keys(registry).filter((name) => !PROFILE_NAME_RE.test(name));
}

/** Nearest declared name by Damerau-free Levenshtein distance, within 3 edits. */
function nearestName(target: string, declared: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 4;
  for (const candidate of declared) {
    const d = levenshtein(target, candidate);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    prev = cur;
  }
  return prev[b.length] as number;
}
