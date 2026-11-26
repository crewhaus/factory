/**
 * Generates the support manifest (`@crewhaus/ir/support`) from the compiler:
 * what each shape does with each setting a spec can declare.
 *
 * For every shape it takes the minimal spec (`ABSENT_CORPUS`) and, for every
 * probe in `FEATURE_PROBES` (`packages/compiler/src/support-probes.ts`),
 * compiles the spec with and without the probe's snippet (`readme: false`, the
 * date pinned) and reads the difference:
 *   1. the spec does not parse, or the compiler refuses it → `rejected`;
 *   2. a new warning at the setting's path (either path a prefix of the other,
 *      at a segment boundary) → `unwired` for `accepted-but-unwired` or any
 *      code `compile --strict` fails on, `degraded` for an informational code;
 *   3. a changed emitted file (other than `README.md` and `package.json`,
 *      and not counting lines that hold only a comment) → `wired` (`via: bundle`, plus `interpreter` on cli when the options
 *      `crewhaus run` builds change, or `interpreter` alone when only they do);
 *   4. otherwise, on a cf-worker build, `wired` via `construction` for a
 *      safety setting the edge allow-list (`CF_WORKER_ENFORCED_KEYS`) says the
 *      worker meets by how it runs (one tool call at a time, every ask
 *      refused), so its build is the same with or without it;
 *   5. otherwise `authoring` for an authoring probe, `wired` via `toolchain`
 *      for a toolchain probe, and for any other probe the generator FAILS: the
 *      setting changes nothing and says nothing.
 * An authoring probe that changes a byte or warns fails too. The cli, workflow
 * and graph shapes are also built the way `crewhaus compile --emit-as
 * cf-worker` builds them, as `<shape>@cf-worker`: that build refuses every
 * safety setting the worker does not enforce, so such a cell reads `rejected`
 * with the refusal. A probe that compares one value against another carries
 * an `edge` pair the Worker admits, so its Worker cell says what that build
 * does with the setting (`placementFor`). A shape whose schema
 * requires the probe's key (its own structure) gets a `wired` cell `via:
 * ["structure"]`, without a compile.
 *
 * `since` carries forward from the checked-in data while a cell's status is
 * unchanged; a new or changed cell gets `SUPPORT_RELEASE`. `controls` is
 * copied from control-contract's `SHAPE_RUN_CONTROLS`.
 *
 * Writes `packages/ir/src/support.generated.ts`, `packages/ir/support-manifest.json`
 * and `packages/control-contract/src/areas/compiler-features.generated.ts`.
 *
 *   bun scripts/gen-support-manifest.ts           # regenerate
 *   bun scripts/gen-support-manifest.ts --check   # exit 1 when any file is stale
 *
 * A script, so it may import from apps/cli (the cf-worker emit path and the
 * interpreter's loop options); the layering rule that forbids it is for packages.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { emitCfWorkerBundle } from "../apps/cli/src/cf-worker-emit";
import { INFORMATIONAL_COMPILE_WARNING_CODES } from "../apps/cli/src/compile-warnings";
import { loopContractRunOptions } from "../apps/cli/src/loop-contract";
import { CORPUS_TODAY } from "../packages/compiler/src/__fixtures__/delta-090/regenerate";
import { ABSENT_CORPUS } from "../packages/compiler/src/absent-corpus";
import {
  CF_WORKER_ENFORCED_KEYS,
  CF_WORKER_GATED_ROOTS,
  type CompileWarning,
  collectCompileWarnings,
  compile,
  lower,
  lowerWithWarnings,
} from "../packages/compiler/src/index";
import {
  FEATURE_PROBES,
  type FeatureProbe,
  type ProbePlacement,
  SUPPORT_RELEASE,
  type SpecFragment,
  type StructuralKey,
} from "../packages/compiler/src/support-probes";
import { SHAPE_RUN_CONTROLS } from "../packages/control-contract/src/run-controls";
import {
  type SupportCell,
  type SupportFeature,
  type SupportManifest,
  compareReleases,
} from "../packages/ir/src/support";
import { Spec, parseSpec, parseSpecIssues } from "../packages/spec/src/index";

const ROOT = dirname(import.meta.dir);
export const GENERATED_TS = join(ROOT, "packages", "ir", "src", "support.generated.ts");
export const GENERATED_JSON = join(ROOT, "packages", "ir", "support-manifest.json");
export const GENERATED_KEYS = join(
  ROOT,
  "packages",
  "control-contract",
  "src",
  "areas",
  "compiler-features.generated.ts",
);

/** Every shape, in the compiler's union order. */
export const SHAPES: readonly Spec["target"][] = Spec.options.map(
  (schema) => schemaShape(schema).target._def.value as Spec["target"],
);

/** The shapes `--emit-as cf-worker` builds. */
export const CF_WORKER_SHAPES: readonly Spec["target"][] = ["cli", "workflow", "graph"];

// ---------------------------------------------------------------------------
// Schema keys
// ---------------------------------------------------------------------------

type ZodLike = {
  readonly _def: {
    readonly typeName?: string;
    readonly schema?: ZodLike;
    readonly shape?: () => Record<string, ZodLike>;
    readonly value?: unknown;
  };
  readonly shape?: Record<string, ZodLike>;
  isOptional(): boolean;
};

function schemaShape(schema: unknown): Record<string, ZodLike> & { target: ZodLike } {
  let s = schema as ZodLike;
  while (s._def.schema !== undefined) s = s._def.schema;
  return (s.shape ?? s._def.shape?.()) as Record<string, ZodLike> & { target: ZodLike };
}

export type SchemaKeys = ReadonlyMap<
  string,
  {
    readonly optional: readonly string[];
    readonly required: readonly string[];
    /** The shapes whose schema fills the key in when a spec leaves it out. */
    readonly defaulted: readonly string[];
  }
>;

/** Every top-level key of every shape's schema, with the shapes that take it optionally or require it. */
export function schemaKeys(): SchemaKeys {
  const out = new Map<string, { optional: string[]; required: string[]; defaulted: string[] }>();
  for (const schema of Spec.options) {
    const shape = schemaShape(schema);
    const target = shape.target._def.value as string;
    for (const [key, field] of Object.entries(shape)) {
      const entry = out.get(key) ?? { optional: [], required: [], defaulted: [] };
      (field.isOptional() ? entry.optional : entry.required).push(target);
      if ((field._def as { typeName?: string }).typeName === "ZodDefault") {
        entry.defaulted.push(target);
      }
      out.set(key, entry);
    }
  }
  return out;
}

/** The safety blocks whose every sub-key needs its own probe. */
export const SAFETY_BLOCKS = ["permissions", "hooks", "limits", "budget", "security"] as const;

/** The object schema under optional/default/effects wrappers, or undefined. */
function objectShape(field: ZodLike): Record<string, ZodLike> | undefined {
  let s: ZodLike | undefined = field;
  for (let i = 0; i < 16 && s !== undefined; i += 1) {
    const def = s._def as {
      typeName?: string;
      innerType?: ZodLike;
      schema?: ZodLike;
      shape?: () => Record<string, ZodLike>;
    };
    if (def.typeName === "ZodObject") return s.shape ?? def.shape?.();
    s = def.innerType ?? def.schema;
  }
  return undefined;
}

/**
 * Every nested key of the safety blocks on any shape's schema, as a dotted
 * path (`limits.loop_detection.escalation`): each needs a probe of its own, so
 * a sub-key a shape does not read cannot hide behind a sibling the block's
 * probe declares. A list block (`hooks`) has no keys of its own: its items are
 * what the block probe declares.
 */
export function safetySubKeys(): string[] {
  const out = new Set<string>();
  const visit = (path: string, field: ZodLike): void => {
    const shape = objectShape(field);
    if (shape === undefined) return;
    for (const [key, child] of Object.entries(shape)) {
      const sub = `${path}.${key}`;
      out.add(sub);
      visit(sub, child);
    }
  };
  for (const schema of Spec.options) {
    const shape = schemaShape(schema);
    for (const block of SAFETY_BLOCKS) {
      const field = shape[block];
      if (field !== undefined) visit(block, field);
    }
  }
  return [...out].sort();
}

/**
 * Why the probe list does not cover the schemas, one message each: a key no
 * probe covers and no structural entry exempts; a structural entry for a key
 * that is optional on every schema that has it (a setting, not structure) or
 * that no schema has; a `DELTA_090_KEYS` pattern with no probe; a feature probed
 * twice.
 */
export function coverageProblems(
  probes: ReadonlyArray<FeatureProbe>,
  structural: ReadonlyArray<StructuralKey>,
  keys: SchemaKeys,
  deltaPatterns: ReadonlyArray<ReadonlyArray<string>>,
  safety: ReadonlyArray<string> = [],
): string[] {
  const problems: string[] = [];
  const features = probes.map((p) => p.feature);
  for (const path of safety) {
    if (!features.some((f) => f === path || f.startsWith(`${path}.`))) {
      problems.push(`safety setting ${path} has no probe of its own`);
    }
  }
  const covers = (key: string): boolean =>
    features.some((f) => f === key || f.startsWith(`${key}.`));
  const exempt = new Set(structural.map((s) => s.key));
  for (const key of [...keys.keys()].sort()) {
    if (!covers(key) && !exempt.has(key)) problems.push(`${key} has no probe`);
  }
  for (const { key } of structural) {
    const entry = keys.get(key);
    if (entry === undefined) problems.push(`structural key ${key} is on no schema`);
    else if (entry.required.length === 0 && entry.defaulted.length === 0) {
      problems.push(`structural key ${key} is optional on every schema: it needs a probe`);
    }
  }
  for (const pattern of deltaPatterns) {
    const id = pattern.join(".");
    if (!features.some((f) => f === id || f.startsWith(`${id}.`))) {
      problems.push(`0.9.0 key ${id} has no probe`);
    }
  }
  const seen = new Set<string>();
  for (const f of features) {
    if (seen.has(f)) problems.push(`${f} is probed twice`);
    seen.add(f);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// One compile
// ---------------------------------------------------------------------------

const isMapping = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `over` laid over `under`: mappings merge key by key, lists item by item. */
export function mergeFragment(under: unknown, over: unknown): unknown {
  if (isMapping(under) && isMapping(over)) {
    const out: Record<string, unknown> = { ...under };
    for (const [k, v] of Object.entries(over)) out[k] = mergeFragment(under[k], v);
    return out;
  }
  if (Array.isArray(under) && Array.isArray(over)) {
    const out = [...under];
    over.forEach((v, i) => {
      out[i] = mergeFragment(under[i], v);
    });
    return out;
  }
  return over;
}

/** What one compile came to. */
export type Outcome =
  | { readonly kind: "rejected"; readonly reason: string; readonly parse: boolean }
  | {
      readonly kind: "compiled";
      readonly files: ReadonlyMap<string, string>;
      readonly warnings: ReadonlyArray<CompileWarning>;
      /** The interpreter's loop options, on cli. */
      readonly interpreter?: string;
    };

const IGNORED_FILES = new Set(["README.md", "package.json"]);

/** A line that holds only a comment, by the file's syntax. */
function commentOnly(path: string, line: string): boolean {
  const trimmed = line.trim();
  if (/\.(?:[cm]?[jt]sx?)$/.test(path)) {
    return (
      trimmed.startsWith("//") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*/") ||
      trimmed === "*" ||
      trimmed.startsWith("* ")
    );
  }
  if (/\.(?:toml|ya?ml|sh|env)$/.test(path) || path.endsWith("Dockerfile")) {
    return trimmed.startsWith("#");
  }
  return false;
}

/**
 * A file's code with its comment-only lines removed, so a setting whose only
 * effect is a note in the bundle ("configured but … ignored") counts as
 * changing nothing. A file that holds no code at all counts as absent.
 */
export function codeOf(path: string, content: string | undefined): string | undefined {
  if (content === undefined) return undefined;
  const code = content
    .split("\n")
    .filter((line) => !commentOnly(path, line))
    .join("\n");
  return code.trim() === "" ? undefined : code;
}

const UNRECOGNIZED = /unrecognized key/i;

/** A newcomer-first reason for a spec the shape's schema refuses. */
function parseReason(shape: string, yamlText: string): string {
  const issues = parseSpecIssues(yamlText);
  if (issues.length === 0 || issues.every((i) => UNRECOGNIZED.test(i.message))) {
    return `${shape} harnesses do not accept this setting`;
  }
  return issues.map((i) => i.message).join("; ");
}

/** Compile one spec object for `variant` (a shape, or `<shape>@cf-worker`). */
export function compileOutcome(spec: SpecFragment, variant: string): Outcome {
  const shape = variant.split("@")[0] as string;
  const yamlText = JSON.stringify(spec);
  let parsed: Spec;
  try {
    parsed = parseSpec(yamlText);
  } catch {
    return { kind: "rejected", reason: parseReason(shape, yamlText), parse: true };
  }
  try {
    if (variant.endsWith("@cf-worker")) {
      const lowered = lowerWithWarnings(parsed, { today: CORPUS_TODAY });
      const emitted = emitCfWorkerBundle(parsed, lowered.ir, { readme: false });
      return {
        kind: "compiled",
        files: new Map(emitted.files.map((f) => [f.path, f.content])),
        warnings: [...collectCompileWarnings(parsed), ...lowered.warnings, ...emitted.warnings],
      };
    }
    const result = compile(yamlText, { readme: false, today: CORPUS_TODAY });
    const ir = shape === "cli" ? lower(parsed, { today: CORPUS_TODAY }) : undefined;
    return {
      kind: "compiled",
      files: new Map(result.files.map((f) => [f.path, f.content])),
      warnings: result.warnings,
      ...(ir !== undefined
        ? { interpreter: JSON.stringify(loopContractRunOptions(ir as never)) }
        : {}),
    };
  } catch (err) {
    return {
      kind: "rejected",
      reason: err instanceof Error ? err.message : String(err),
      parse: false,
    };
  }
}

const warningKey = (w: CompileWarning): string => `${w.code}\u0000${w.path}\u0000${w.message}`;

/** Whether two spec paths are prefixes of each other at a segment boundary. */
export function pathsOverlap(a: string, b: string): boolean {
  const at = (long: string, short: string): boolean =>
    long === short || long.startsWith(`${short}.`) || long.startsWith(`${short}[`);
  return at(a, b) || at(b, a);
}

/** The status a new warning gives a cell (§ "Status from warning codes"). */
export function statusForCode(code: string): "unwired" | "degraded" {
  return INFORMATIONAL_COMPILE_WARNING_CODES.includes(code) && code !== "accepted-but-unwired"
    ? "degraded"
    : "unwired";
}

/** A cell without `since`, from a baseline and a probe compile. */
export type DerivedCell = Omit<SupportCell, "since">;

/**
 * The cell one probe gets on one variant, from the baseline (the shape's spec
 * plus the probe's base) and the probe (plus its snippet). Throws for a
 * setting that changes nothing and says nothing, and for an authoring probe
 * that changes something.
 */
export function deriveCell(
  probe: FeatureProbe,
  variant: string,
  path: string,
  baseline: Outcome,
  probed: Outcome,
  opts: {
    /** A cf-worker build meets the setting by how the worker runs (`edgeAdmission`). */
    readonly constructed?: boolean;
  } = {},
): DerivedCell {
  if (baseline.kind === "rejected") {
    // The shape cannot carry the probe's base (a pool on a shape with no pool).
    return { status: "rejected", reason: baseline.reason };
  }
  if (probed.kind === "rejected") return { status: "rejected", reason: probed.reason };
  // Every warning at the setting's path counts, including one its base already
  // raised: a block the shape does not use leaves each setting inside it unused.
  const fresh = probed.warnings.filter((w) => pathsOverlap(w.path, path));
  // An authoring probe answers for what it adds: a warning its base raised is the base's.
  const before = new Set(baseline.warnings.map(warningKey));
  const added = fresh.filter((w) => !before.has(warningKey(w)));
  const changed = [...new Set([...baseline.files.keys(), ...probed.files.keys()])].some(
    (file) =>
      !IGNORED_FILES.has(file) &&
      codeOf(file, baseline.files.get(file)) !== codeOf(file, probed.files.get(file)),
  );
  const interpreter =
    baseline.interpreter !== undefined && baseline.interpreter !== probed.interpreter;
  if (probe.kind === "authoring") {
    if (changed || interpreter || added.length > 0) {
      throw new Error(
        `${probe.feature} on ${variant} is an authoring probe but changes the build${
          added.length > 0 ? ` (warns ${added.map((w) => w.code).join(", ")})` : ""
        }`,
      );
    }
    return { status: "authoring" };
  }
  const warned = fresh.find((w) => statusForCode(w.code) === "unwired") ?? fresh[0];
  if (warned !== undefined) {
    return { status: statusForCode(warned.code), code: warned.code, reason: warned.message };
  }
  if (changed || interpreter) {
    const via: Array<"bundle" | "interpreter"> = [];
    if (changed) via.push("bundle");
    if (interpreter) via.push("interpreter");
    return { status: "wired", via };
  }
  if (opts.constructed === true) return { status: "wired", via: ["construction"] };
  if (
    probe.kind === "toolchain" &&
    (probe.toolchainShapes === undefined || probe.toolchainShapes.includes(variant))
  ) {
    return { status: "wired", via: ["toolchain"] };
  }
  throw new Error(`${probe.feature} on ${variant} changes nothing and says nothing`);
}

// ---------------------------------------------------------------------------
// The cf-worker edge allow-list
// ---------------------------------------------------------------------------

/** A declared leaf of a spec fragment, as path segments (array indexes as numbers). */
export type FragmentLeaf = {
  readonly path: ReadonlyArray<string | number>;
  readonly value: unknown;
};

/** Every value at `pattern` in `value` (`*`: each array index or record key). */
function valuesAt(
  value: unknown,
  pattern: ReadonlyArray<string>,
  at: ReadonlyArray<string | number> = [],
): FragmentLeaf[] {
  if (value === undefined) return [];
  const [head, ...rest] = pattern;
  if (head === undefined) return [{ path: at, value }];
  if (head === "*") {
    if (Array.isArray(value)) return value.flatMap((v, i) => valuesAt(v, rest, [...at, i]));
    if (isMapping(value)) {
      return Object.entries(value).flatMap(([k, v]) => valuesAt(v, rest, [...at, k]));
    }
    return [];
  }
  return isMapping(value) ? valuesAt(value[head], rest, [...at, head]) : [];
}

/** The leaves a block declares: mappings are descended; a non-empty list or a scalar is one leaf. */
function leavesOf(value: unknown, path: ReadonlyArray<string | number>, out: FragmentLeaf[]): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    if (value.length > 0) out.push({ path, value });
    return;
  }
  if (isMapping(value)) {
    for (const [key, child] of Object.entries(value)) leavesOf(child, [...path, key], out);
    return;
  }
  out.push({ path, value });
}

/**
 * The leaves of `fragment` under the roots the cf-worker edge gate walks
 * (`CF_WORKER_GATED_ROOTS`), read the way the gate reads a spec.
 */
export function edgeGatedLeaves(fragment: SpecFragment): FragmentLeaf[] {
  const out: FragmentLeaf[] = [];
  for (const root of CF_WORKER_GATED_ROOTS) {
    for (const block of valuesAt(fragment, root.split("."))) leavesOf(block.value, block.path, out);
  }
  return out;
}

/** The allow-list row that admits `leaf` (`*` in a row: any one segment), if any. */
export function enforcedRowFor(
  leaf: FragmentLeaf,
): (typeof CF_WORKER_ENFORCED_KEYS)[number] | undefined {
  return CF_WORKER_ENFORCED_KEYS.find((row) => {
    const segs = row.path.split(".");
    return (
      segs.length === leaf.path.length &&
      segs.every((seg, i) => seg === "*" || seg === String(leaf.path[i]))
    );
  });
}

/**
 * What the edge allow-list (`CF_WORKER_ENFORCED_KEYS`) says of a fragment's
 * safety settings on a cf-worker build: `refused` when a leaf has no row or
 * holds a value its row refuses, `construction` when every leaf's row says the
 * worker meets it by how it runs, `config` when the worker reads some leaf;
 * undefined when the fragment declares no leaf under a gated root.
 */
export function edgeAdmission(
  fragment: SpecFragment,
): "refused" | "construction" | "config" | undefined {
  const leaves = edgeGatedLeaves(fragment);
  if (leaves.length === 0) return undefined;
  let config = false;
  for (const leaf of leaves) {
    const row = enforcedRowFor(leaf);
    if (row === undefined || row.refuse?.values.includes(String(leaf.value)) === true) {
      return "refused";
    }
    if (row.enforcedBy === "config") config = true;
  }
  return config ? "config" : "construction";
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** The shape's minimal spec, as the object the probes merge into. */
function corpusObject(shape: Spec["target"]): SpecFragment {
  return Bun.YAML.parse(ABSENT_CORPUS[shape]) as SpecFragment;
}

/**
 * Where the probe sits on a shape, and what each compile carries, for one
 * variant: a `<shape>@cf-worker` build uses the probe's `edge` snippet and
 * base in place of the default placement, when the probe has one.
 */
export function placementFor(
  probe: FeatureProbe,
  shape: string,
  variant: string = shape,
): ProbePlacement {
  const placed = probe.place?.(shape);
  if (placed !== undefined) return placed;
  const edge = variant.endsWith("@cf-worker") ? probe.edge : undefined;
  const snippet = edge?.snippet ?? probe.snippet;
  const base = edge !== undefined ? edge.base : probe.base;
  return { path: probe.feature, snippet, ...(base !== undefined ? { base } : {}) };
}

export type GenerateOptions = {
  readonly probes?: ReadonlyArray<FeatureProbe>;
  /** The checked-in manifest `since` carries forward from. */
  readonly previous?: SupportManifest;
  /** When given, a cell that fails is reported here and left out, instead of throwing. */
  readonly failures?: string[];
};

/** Every variant a shape is built as: itself, and its cf-worker build when it has one. */
export function variantsOf(shape: Spec["target"]): string[] {
  return CF_WORKER_SHAPES.includes(shape) ? [shape, `${shape}@cf-worker`] : [shape];
}

/**
 * One shape's cells, for itself and its cf-worker build: `{feature: {variant:
 * cell}}`. A probe whose top-level key the shape's schema requires reads
 * `wired` `via: ["structure"]` there.
 */
export function shapeCells(
  shape: Spec["target"],
  opts: GenerateOptions = {},
): Record<string, Record<string, SupportCell>> {
  const probes = opts.probes ?? FEATURE_PROBES;
  const keys = schemaKeys();
  const corpus = corpusObject(shape);
  const cache = new Map<string, Outcome>();
  const outcome = (spec: SpecFragment, variant: string): Outcome => {
    const id = `${variant}\u0000${JSON.stringify(spec)}`;
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    const fresh = compileOutcome(spec, variant);
    cache.set(id, fresh);
    return fresh;
  };
  const out: Record<string, Record<string, SupportCell>> = {};
  const record = (feature: string, variant: string, derived: DerivedCell): void => {
    const previous = opts.previous?.features[feature]?.cells[variant];
    const since =
      previous !== undefined &&
      previous.status === derived.status &&
      JSON.stringify(previous.via ?? []) === JSON.stringify(derived.via ?? [])
        ? previous.since
        : SUPPORT_RELEASE;
    out[feature] ??= {};
    (out[feature] as Record<string, SupportCell>)[variant] = { ...derived, since };
  };
  for (const probe of probes) {
    const top = probe.feature.split(".")[0] as string;
    if (keys.get(top)?.required.includes(shape) === true) {
      // The shape's schema requires the key: it is part of the shape, always in effect.
      for (const variant of variantsOf(shape)) {
        record(probe.feature, variant, { status: "wired", via: ["structure"] });
      }
      continue;
    }
    for (const variant of variantsOf(shape)) {
      // Each variant compiles its own pair: a Worker build may probe another value.
      const placement = placementFor(probe, shape, variant);
      const baseSpec = (
        placement.base !== undefined ? mergeFragment(corpus, placement.base) : corpus
      ) as SpecFragment;
      const probeSpec = mergeFragment(baseSpec, placement.snippet) as SpecFragment;
      let derived: DerivedCell;
      try {
        derived = deriveCell(
          probe,
          variant,
          placement.path,
          outcome(baseSpec, variant),
          outcome(probeSpec, variant),
          {
            constructed:
              variant.endsWith("@cf-worker") && edgeAdmission(placement.snippet) === "construction",
          },
        );
      } catch (err) {
        if (opts.failures === undefined) throw err;
        opts.failures.push(err instanceof Error ? err.message : String(err));
        continue;
      }
      record(probe.feature, variant, derived);
    }
  }
  return out;
}

/** The whole manifest, from every shape's cells. */
export function generateSupportManifest(opts: GenerateOptions = {}): SupportManifest {
  const probes = opts.probes ?? FEATURE_PROBES;
  const cells = new Map<string, Record<string, SupportCell>>();
  for (const shape of SHAPES) {
    for (const [feature, byVariant] of Object.entries(shapeCells(shape, opts))) {
      cells.set(feature, { ...(cells.get(feature) ?? {}), ...byVariant });
    }
  }
  const features: Record<string, SupportFeature> = {};
  for (const probe of probes) {
    features[probe.feature] = {
      kind: probe.kind,
      at: probe.at ?? [probe.feature],
      cells: cells.get(probe.feature) ?? {},
    };
  }
  return {
    schema: 1,
    generatedBy: SUPPORT_RELEASE,
    shapes: [...SHAPES],
    variants: { "cf-worker": [...CF_WORKER_SHAPES] },
    features,
    controls: JSON.parse(JSON.stringify(SHAPE_RUN_CONTROLS)),
  };
}

/**
 * The released versions in a CHANGELOG (`## [X] - date` headings) newer than
 * `release`. `SUPPORT_RELEASE` names the release line this compiler's cells
 * belong to: once a release newer than it ships, the next change that moves a
 * cell must bump it first, so a cell's `since` never names a shipped release
 * it was not in.
 */
export function releasedNewerThan(changelog: string, release: string): string[] {
  const out: string[] = [];
  for (const match of changelog.matchAll(/^## \[(\d+\.\d+\.\d+[^\]]*)\]/gm)) {
    const version = match[1] as string;
    if (compareReleases(version, release) > 0) out.push(version);
  }
  return out;
}

/** The `features.<id>` capability keys Home answers, in feature order. */
export function compilerFeatureKeys(manifest: SupportManifest): string[] {
  return Object.keys(manifest.features).map((feature) => `features.${feature}`);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const HEADER = "// generated by scripts/gen-support-manifest.ts; do not edit";

export function renderManifestTs(manifest: SupportManifest): string {
  return `${HEADER}
/**
 * What each harness shape does with each setting, generated from the compiler.
 * Read it through \`@crewhaus/ir/support\`.
 */
import type { SupportManifest } from "./support";

export const SUPPORT_MANIFEST: SupportManifest = ${JSON.stringify(manifest, null, 2)};
`;
}

export function renderKeysTs(manifest: SupportManifest): string {
  return `${HEADER}
/**
 * One Home capability key per setting in the support manifest
 * (\`@crewhaus/ir/support\`): \`features.<setting>\`, answered per harness.
 */
export const COMPILER_FEATURE_KEYS = ${JSON.stringify(compilerFeatureKeys(manifest), null, 2)} as const;
`;
}

/** The checked-in manifest, read from its JSON copy, or undefined before the first generation. */
export function readCheckedIn(): SupportManifest | undefined {
  if (!existsSync(GENERATED_JSON)) return undefined;
  return JSON.parse(readFileSync(GENERATED_JSON, "utf8")) as SupportManifest;
}

function format(paths: readonly string[]): void {
  const biome = join(ROOT, "node_modules", ".bin", "biome");
  const run = Bun.spawnSync([biome, "format", "--write", ...paths], { cwd: ROOT });
  if (run.exitCode !== 0) {
    throw new Error(`biome format failed: ${new TextDecoder().decode(run.stderr)}`);
  }
}

/** Whether each checked-in file holds `manifest`'s data (compared as data, not bytes). */
export async function checkedInMatches(manifest: SupportManifest): Promise<{
  readonly ts: boolean;
  readonly json: boolean;
  readonly keys: boolean;
}> {
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  const ts = existsSync(GENERATED_TS)
    ? same((await import(GENERATED_TS)).SUPPORT_MANIFEST, manifest)
    : false;
  const keys = existsSync(GENERATED_KEYS)
    ? same((await import(GENERATED_KEYS)).COMPILER_FEATURE_KEYS, compilerFeatureKeys(manifest))
    : false;
  return { ts, json: same(readCheckedIn(), manifest), keys };
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const previous = readCheckedIn();
  const failures: string[] = [];
  const manifest = generateSupportManifest({
    ...(previous !== undefined ? { previous } : {}),
    failures,
  });
  if (failures.length > 0) {
    process.stderr.write(`${failures.join("\n")}\n`);
    process.exit(1);
  }
  if (check) {
    const matches = await checkedInMatches(manifest);
    const stale = !matches.ts || !matches.json || !matches.keys;
    if (stale) {
      process.stderr.write(
        "the support manifest is stale: run `bun scripts/gen-support-manifest.ts`\n",
      );
      process.exit(1);
    }
    process.exit(0);
  }
  writeFileSync(GENERATED_TS, renderManifestTs(manifest));
  writeFileSync(GENERATED_JSON, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(GENERATED_KEYS, renderKeysTs(manifest));
  format([GENERATED_TS, GENERATED_JSON, GENERATED_KEYS]);
  process.stdout.write(
    `wrote ${Object.keys(manifest.features).length} features across ${manifest.shapes.length} shapes\n`,
  );
}
