/**
 * A dataset sample's `metadata.provability` (design/0.8.0-provability-release.md
 * §9.1): the per-sample floor override and the origins that must ground the
 * answer.
 *
 *   metadata:
 *     provability: grounded                  # shorthand ≡ { level: grounded }
 *     provability:
 *       level: checked                       # grade THIS sample at checked
 *       expected_sources:                    # each must be an ok source origin
 *         - https://acme.example/policy
 *         - docs/pricing.md
 *
 * `eval-dataset` keeps `metadata` free-form (`z.record(z.unknown())`), so the
 * reading lives here, beside the only graders that use it. A malformed value
 * is reported, never ignored: the graders turn it into a failing result that
 * names the field, because a floor the author meant and the grader dropped
 * would grade the sample against the wrong bar in silence.
 */
import type { Sample } from "@crewhaus/eval-dataset";
import {
  PROVABILITY_LEVELS,
  type ProvabilityLevel,
  doiUrl,
  isProvabilityLevel,
  normalizePath,
  normalizeUrl,
} from "@crewhaus/provability";

/** The parsed `metadata.provability`; both fields optional. */
export type SampleProvability = {
  /** The floor this sample is graded at, overriding the run's. */
  readonly level?: ProvabilityLevel;
  /** Origins (URLs, `doi:` refs, workspace paths) that must ground the answer, as written. */
  readonly expectedSources?: ReadonlyArray<string>;
};

export type SampleProvabilityRead =
  | { readonly ok: true; readonly value: SampleProvability }
  | { readonly ok: false; readonly error: string };

const RUNGS = PROVABILITY_LEVELS.join(" | ");

/** Read `sample.metadata.provability`. Absent ⇒ `{ ok: true, value: {} }`. */
export function sampleProvabilityOf(sample: Pick<Sample, "metadata">): SampleProvabilityRead {
  const raw = sample.metadata?.["provability"];
  if (raw === undefined) return { ok: true, value: {} };
  if (typeof raw === "string") {
    return isProvabilityLevel(raw)
      ? { ok: true, value: { level: raw } }
      : {
          ok: false,
          error: `metadata.provability must be a rung (${RUNGS}) or { level?, expected_sources? }, got ${JSON.stringify(raw)}`,
        };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      error: `metadata.provability must be a rung (${RUNGS}) or { level?, expected_sources? }, got ${Array.isArray(raw) ? "a list" : JSON.stringify(raw)}`,
    };
  }
  const obj = raw as Record<string, unknown>;
  const unknown = Object.keys(obj).filter((k) => k !== "level" && k !== "expected_sources");
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `metadata.provability has unknown key(s) ${unknown.map((k) => JSON.stringify(k)).join(", ")} — accepted: level, expected_sources`,
    };
  }
  const level = obj["level"];
  if (level !== undefined && !isProvabilityLevel(level)) {
    return {
      ok: false,
      error: `metadata.provability.level must be one of ${RUNGS}, got ${JSON.stringify(level)}`,
    };
  }
  const sources = obj["expected_sources"];
  if (
    sources !== undefined &&
    (!Array.isArray(sources) || sources.some((s) => typeof s !== "string" || s.trim() === ""))
  ) {
    return {
      ok: false,
      error: "metadata.provability.expected_sources must be a list of non-empty origin strings",
    };
  }
  return {
    ok: true,
    value: {
      ...(level !== undefined ? { level: level as ProvabilityLevel } : {}),
      ...(sources !== undefined ? { expectedSources: sources as string[] } : {}),
    },
  };
}

/**
 * The key an expected source is compared under — the normalization the
 * bundle's binding origins went through (`@crewhaus/provability`'s origin
 * rules): an `http(s)` URL normalized, a `doi:` ref as its resolver URL, and
 * anything else as a workspace-relative path measured from `workspaceRoot`
 * (the eval's cwd, where the run's tools resolved paths). A path that lands
 * outside the workspace keeps its written form (minus a leading `./`), so it
 * can only match an origin spelled exactly that way.
 */
export function expectedSourceKey(source: string, workspaceRoot?: string): string {
  const trimmed = source.trim();
  if (/^doi:/i.test(trimmed)) return doiUrl(trimmed);
  const url = normalizeUrl(trimmed);
  if (url !== undefined) return url;
  const path = normalizePath(trimmed, workspaceRoot !== undefined ? { workspaceRoot } : {});
  return path ?? trimmed.replace(/^\.\//, "");
}
