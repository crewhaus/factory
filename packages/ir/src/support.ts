/**
 * `@crewhaus/ir/support` — what each harness shape does with each setting a
 * spec can declare, and readers that answer it for one harness.
 *
 * The data (`SUPPORT_MANIFEST`, from `./support.generated`) is not written by
 * hand: `scripts/gen-support-manifest.ts` compiles a minimal spec for every
 * shape with and without each setting and records what changed. A cell is
 *   - `wired`: the setting changes what the harness does (its compiled
 *     bundle, the `crewhaus run` interpreter, or a CLI verb that reads it);
 *   - `degraded`: it takes effect, with a note the compiler prints;
 *   - `unwired`: the shape accepts it and does not use it (the compiler says so);
 *   - `rejected`: the shape does not accept it (the spec fails to parse or compile);
 *   - `authoring`: it records a decision and changes no compiled byte, by design.
 * A key a shape's schema requires is part of that shape: its cell is `wired`
 * `via: ["structure"]`. A safety setting a Cloudflare Worker build meets by
 * how the worker runs (one tool call at a time, every ask refused) changes no
 * byte there: its `<shape>@cf-worker` cell is `wired` `via: ["construction"]`.
 * A bundle compiled before the manifest existed, a shape
 * the manifest does not list and a cell it does not hold all read `unknown`,
 * never "supported" or "unsupported": the manifest describes what this
 * release's compiler emits, and nothing else.
 *
 * This module is pure and imports nothing but its data. The package's main
 * entry never imports it, so a bundle that imports `@crewhaus/ir` loads no table.
 */
import { SUPPORT_MANIFEST } from "./support.generated";

export { SUPPORT_MANIFEST };

export const SUPPORT_MANIFEST_SCHEMA = 1;

export type SupportStatus = "wired" | "degraded" | "unwired" | "rejected" | "authoring";

export type SupportCell = {
  readonly status: SupportStatus;
  /** The release whose compiler first gave the cell this status. */
  readonly since: string;
  /** The warning code behind a `degraded` or `unwired` cell. */
  readonly code?: string;
  /** One line on why, for a cell that is not `wired`. */
  readonly reason?: string;
  /**
   * Where a `wired` cell takes effect; `structure` for a key the shape requires;
   * `construction` for a setting a Cloudflare Worker meets by how it runs.
   */
  readonly via?: ReadonlyArray<
    "bundle" | "interpreter" | "toolchain" | "structure" | "construction"
  >;
};

export type SupportFeature = {
  readonly kind: "runtime" | "authoring" | "toolchain";
  /** The spec paths that declare the feature; `*` matches any key or index. */
  readonly at: ReadonlyArray<string>;
  /** One cell per shape, and per `<shape>@cf-worker` build. */
  readonly cells: Readonly<Record<string, SupportCell>>;
};

export type SupportControl = {
  readonly supported: true | false | "unknown";
  readonly reason?: string;
  readonly verb?: string | null;
};

export type SupportManifest = {
  readonly schema: 1;
  /** The release line whose compiler generated the data. */
  readonly generatedBy: string;
  readonly shapes: ReadonlyArray<string>;
  /** The shapes each emit-as variant builds. */
  readonly variants: { readonly "cf-worker": ReadonlyArray<string> };
  readonly features: Readonly<Record<string, SupportFeature>>;
  /** The run controls each shape offers, by control key. */
  readonly controls: Readonly<Record<string, Readonly<Record<string, SupportControl>>>>;
};

export type DeclaredFeature = { readonly feature: string; readonly path: string };

export type FeatureSupportStatus = SupportStatus | "unknown" | "recompile";

export type HarnessFeatureSupport = {
  readonly schema: 1;
  readonly shape: string;
  /** `unknown` when the build predates the manifest, is newer than it, or is
   *  missing, or when the manifest does not know the shape. */
  readonly basis: "manifest" | "unknown";
  readonly compiledWith?: string;
  readonly note?: string;
  /** The command that answers `note`, when one does (none for a newer build). */
  readonly verb?: string;
  readonly features: ReadonlyArray<{
    readonly feature: string;
    readonly path: string;
    readonly status: FeatureSupportStatus;
    readonly reason?: string;
    readonly verb?: string;
  }>;
};

export type SupportDescriptor =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: string; readonly verb: string | null }
  | { readonly supported: "unknown"; readonly reason: string };

/** The release the manifest's knowledge starts at: an older build reads `unknown`. */
const FIRST_RELEASE = "0.9.0";

const RECOMPILE_VERB = "crewhaus compile";

/**
 * `major.minor.patch` as numbers; a pre-release or build suffix of X counts as
 * X. Undefined for anything that is not a version.
 */
export function parseRelease(version: string): readonly [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative, zero or positive as `a` is older than, the same release as, or newer than `b`. */
export function compareReleases(a: string, b: string): number {
  const left = parseRelease(a);
  const right = parseRelease(b);
  if (left === undefined || right === undefined) return Number.NaN;
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] as number) - (right[i] as number);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// declaredFeatures
// ---------------------------------------------------------------------------

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `provability`'s level, from its short form or its object form. */
function provabilityOff(value: unknown): boolean {
  if (typeof value === "string") return value === "off";
  if (isMapping(value)) return value["level"] === "off";
  return false;
}

/** Whether a leaf value declares something, by the compiler's opt-out rules. */
function leafDeclares(value: unknown, isProvability: boolean): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (isProvability) return !provabilityOff(value);
  if (Array.isArray(value)) return value.length > 0;
  if (isMapping(value)) {
    if (value["enabled"] === false) return false;
    return Object.keys(value).length > 0;
  }
  return true;
}

/**
 * The concrete paths under `holder` that `segments` names and the spec
 * declares. An ancestor that is absent, `null`, `false`, not a mapping, or
 * switched off (`enabled: false`), and a `provability` block at level off,
 * declare nothing beneath them; `*` walks every key of a mapping or every
 * item of a list.
 */
function walk(
  holder: unknown,
  segments: readonly string[],
  depth: number,
  prefix: string,
  out: string[],
): void {
  const segment = segments[depth] as string;
  const last = depth === segments.length - 1;
  const children: Array<readonly [string, unknown]> = [];
  if (segment === "*") {
    if (Array.isArray(holder)) {
      holder.forEach((item, i) => children.push([`${prefix}[${i}]`, item]));
    } else if (isMapping(holder)) {
      for (const [key, value] of Object.entries(holder)) {
        children.push([prefix === "" ? key : `${prefix}.${key}`, value]);
      }
    }
  } else if (isMapping(holder)) {
    children.push([prefix === "" ? segment : `${prefix}.${segment}`, holder[segment]]);
  }
  const isProvability = depth === 0 && segment === "provability";
  for (const [path, value] of children) {
    if (last) {
      if (leafDeclares(value, isProvability)) out.push(path);
      continue;
    }
    if (!isMapping(value) && !Array.isArray(value)) continue;
    if (isMapping(value) && value["enabled"] === false) continue;
    if (isProvability && provabilityOff(value)) continue;
    if (Array.isArray(value) && segments[depth + 1] !== "*") continue;
    walk(value, segments, depth + 1, path, out);
  }
}

/**
 * The features a parsed spec (the YAML as an object) declares, each with the
 * concrete path that declares it, in the manifest's feature order. A feature
 * declared at several paths (a strategy in two workflow steps) is listed once
 * per path.
 */
export function declaredFeatures(
  spec: unknown,
  manifest: SupportManifest = SUPPORT_MANIFEST,
): ReadonlyArray<DeclaredFeature> {
  if (!isMapping(spec)) return [];
  const out: DeclaredFeature[] = [];
  for (const [feature, record] of Object.entries(manifest.features)) {
    for (const at of record.at) {
      const paths: string[] = [];
      walk(spec, at.split("."), 0, "", paths);
      for (const path of paths) out.push({ feature, path });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// featureSupport / supportDescriptor
// ---------------------------------------------------------------------------

/** Why a harness cannot be read against this manifest, and the command that answers it. */
type UnknownBasis = { readonly note: string; readonly verb?: string };

/** Whether the manifest has cells for `shape` (a shape, or `<shape>@cf-worker`). */
function knownShape(shape: string, manifest: SupportManifest): boolean {
  if (manifest.shapes.includes(shape)) return true;
  const [base, variant, extra] = shape.split("@");
  return (
    extra === undefined &&
    variant === "cf-worker" &&
    base !== undefined &&
    manifest.variants["cf-worker"].includes(base)
  );
}

/** Why a harness's build cannot be read against this manifest, or undefined when it can. */
function unknownBasis(
  shape: string,
  compiledWith: string | undefined,
  manifest: SupportManifest,
): UnknownBasis | undefined {
  if (!knownShape(shape, manifest)) {
    return {
      note: `This version of CrewHaus does not know the "${shape}" shape, so it cannot check which settings take effect.`,
    };
  }
  if (compiledWith === undefined) {
    return { note: "This harness has no build yet.", verb: RECOMPILE_VERB };
  }
  const parsed = parseRelease(compiledWith);
  if (parsed === undefined || compareReleases(compiledWith, FIRST_RELEASE) < 0) {
    return {
      note: `Built with CrewHaus ${compiledWith}. Recompile to check which settings take effect.`,
      verb: RECOMPILE_VERB,
    };
  }
  if (compareReleases(compiledWith, manifest.generatedBy) > 0) {
    return {
      note: `Built with a newer CrewHaus (${compiledWith}) than this one (${manifest.generatedBy}). Update this CrewHaus to check which settings take effect.`,
    };
  }
  return undefined;
}

type FeatureAnswer = HarnessFeatureSupport["features"][number];

/** One declared feature's answer against a readable build of a known shape. */
function answerFor(
  feature: string,
  path: string,
  shape: string,
  compiledWith: string,
  manifest: SupportManifest,
): FeatureAnswer {
  const record = manifest.features[feature];
  if (record === undefined) {
    return {
      feature,
      path,
      status: "unknown",
      reason: "This version of CrewHaus does not know this setting.",
    };
  }
  const cell = record.cells[shape];
  if (cell === undefined) {
    return {
      feature,
      path,
      status: "unknown",
      reason: `This version of CrewHaus has no record of what this setting does on ${shape} harnesses.`,
    };
  }
  if (
    (cell.status === "wired" || cell.status === "degraded") &&
    compareReleases(cell.since, compiledWith) > 0
  ) {
    return {
      feature,
      path,
      status: "recompile",
      reason: "Recompile to turn this on.",
      verb: RECOMPILE_VERB,
    };
  }
  return {
    feature,
    path,
    status: cell.status,
    ...(cell.reason !== undefined ? { reason: cell.reason } : {}),
  };
}

/**
 * What a harness's declared features do on its shape, as its build was
 * compiled. `compiledWith` is the crewhaus version stamped into the bundle.
 * The answer's basis is `unknown`, every feature `unknown` with a note, when
 * the manifest does not know the shape, or the build is absent, older than the
 * manifest, newer than it, or not a version. `verb` names the command that
 * answers the note (`crewhaus compile` for a missing or older build) and is
 * absent when no command here does. A feature this manifest does not know, and
 * a shape it holds no cell for, read `unknown`; a cell that took effect in a
 * later release than the build reads `recompile`.
 */
export function featureSupport(input: {
  readonly shape: string;
  readonly declared: ReadonlyArray<DeclaredFeature>;
  readonly compiledWith?: string;
  readonly manifest?: SupportManifest;
}): HarnessFeatureSupport {
  const manifest = input.manifest ?? SUPPORT_MANIFEST;
  const base = {
    schema: 1 as const,
    shape: input.shape,
    ...(input.compiledWith !== undefined ? { compiledWith: input.compiledWith } : {}),
  };
  const unknown = unknownBasis(input.shape, input.compiledWith, manifest);
  if (unknown !== undefined) {
    const verb = unknown.verb !== undefined ? { verb: unknown.verb } : {};
    return {
      ...base,
      basis: "unknown",
      note: unknown.note,
      ...verb,
      features: input.declared.map(({ feature, path }) => ({
        feature,
        path,
        status: "unknown" as const,
        reason: unknown.note,
        ...verb,
      })),
    };
  }
  return {
    ...base,
    basis: "manifest",
    features: input.declared.map(({ feature, path }) =>
      answerFor(feature, path, input.shape, input.compiledWith as string, manifest),
    ),
  };
}

/**
 * One feature's capability descriptor for a harness, as Home's versioned API
 * answers it: `wired`, `degraded` and `authoring` → supported (a degraded
 * cell's note stays in {@link featureSupport}); `unwired` and `rejected` →
 * not supported, with no command that fills it; `recompile` → not supported,
 * with `crewhaus compile`; `unknown` (an unknown shape, setting or build, or
 * a cell the manifest does not hold) → unknown.
 */
export function supportDescriptor(input: {
  readonly feature: string;
  readonly shape: string;
  readonly compiledWith?: string;
  readonly manifest?: SupportManifest;
}): SupportDescriptor {
  const manifest = input.manifest ?? SUPPORT_MANIFEST;
  const support = featureSupport({
    shape: input.shape,
    declared: [{ feature: input.feature, path: input.feature }],
    ...(input.compiledWith !== undefined ? { compiledWith: input.compiledWith } : {}),
    manifest,
  });
  const answer = support.features[0];
  if (answer === undefined) {
    return { supported: "unknown", reason: support.note ?? "Unknown." };
  }
  switch (answer.status) {
    case "wired":
    case "degraded":
    case "authoring":
      return { supported: true };
    case "unwired":
    case "rejected":
      return {
        supported: false,
        reason: answer.reason ?? `Not used on ${input.shape} harnesses.`,
        verb: null,
      };
    case "recompile":
      return {
        supported: false,
        reason: answer.reason ?? "Recompile to turn this on.",
        verb: RECOMPILE_VERB,
      };
    case "unknown":
      return { supported: "unknown", reason: answer.reason ?? support.note ?? "Unknown." };
  }
}

/** One shape's cell for every feature, in manifest order (for `--shape`). */
export function shapeCells(
  shape: string,
  manifest: SupportManifest = SUPPORT_MANIFEST,
): ReadonlyArray<{ readonly feature: string; readonly cell: SupportCell }> {
  return Object.entries(manifest.features).flatMap(([feature, record]) => {
    const cell = record.cells[shape];
    return cell === undefined ? [] : [{ feature, cell }];
  });
}
