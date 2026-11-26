/**
 * `checkSpec`: every problem a draft spec has, in one result, without
 * writing, registering or calling anything.
 *
 * One call returns every schema issue (or, once the schema passes, every
 * cross-field issue: `parseSpec` throws only the first), the settings the
 * schema does not know, the lowering's refusal, the compiler's tool errors,
 * the warnings `crewhaus compile` prints (each marked informational or not),
 * the IR passes' findings, what this release's compiler does with each
 * setting the spec declares, the credentials each model slot needs (names and
 * presence only, never a value) and the schema that answered. A spec with a
 * setting this schema does not know, or newer than it, is read-only, with the
 * reason.
 *
 * The stages are the shared pipeline (`runCheckStages`), so `crewhaus lint`
 * and this answer from the same run of the same code. Nothing here reads a
 * file, the network, a registry or (with `today` set) the clock.
 */
import type { CompileWarning } from "@crewhaus/compiler";
import { enumerateModelSlots } from "@crewhaus/ir/slots";
import {
  type HarnessFeatureSupport,
  SUPPORT_MANIFEST,
  type SupportManifest,
  declaredFeatures,
  featureSupport,
} from "@crewhaus/ir/support";
import { createDefaultEngine } from "@crewhaus/migration-engine";
import { isEnvSet, modelCredentialGroups, selectedProvider } from "@crewhaus/preflight";
import type { SpecIssue } from "@crewhaus/spec";
import { type SchemaIdentity, specSchemaIdentity } from "@crewhaus/spec/identity";
import { emitCfWorkerBundle } from "./cf-worker-emit";
import { INFORMATIONAL_COMPILE_WARNING_CODES } from "./compile-warnings";
import { type CheckStages, runCheckStages } from "./stages";

export type { SchemaIdentity };

export type CheckSpecOptions = {
  /** Also build the spec as `crewhaus compile --emit-as cf-worker` builds it. */
  readonly emitAs?: "cf-worker";
  /** Pins the date the model-sunset checks read (`YYYY-MM-DD`). */
  readonly today?: string;
  /** Names to report presence for. Default: none read, and no `present`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The support manifest to read features against. Default: this release's. */
  readonly manifest?: SupportManifest;
};

export type CheckSpecError = {
  readonly path: string;
  readonly message: string;
  /** `lower`, `tool`, `cf-worker`, a model-plan rule, or `internal`. */
  readonly code: string;
};

export type CheckSpecWarning = CompileWarning & {
  /** True for a warning that never fails `crewhaus compile --strict`. */
  readonly informational: boolean;
};

export type CheckSpecCredential = {
  /** The slot's label in the model walk (`agent.model`, `compaction.model`, …). */
  readonly slot: string;
  /** The provider the slot's model runs on, or `unknown`. */
  readonly provider: string;
  /** Every environment name the provider reads its credential from. */
  readonly envNames: ReadonlyArray<string>;
  /**
   * With `env` given and names to check: whether each either-or group has a
   * name set. Absent otherwise. Never a value.
   */
  readonly present?: boolean;
};

export type CheckSpecResult = {
  /** No issue, no error and no IR-pass finding. */
  readonly ok: boolean;
  readonly schema: SchemaIdentity;
  /** The spec's shape: lowered, parsed, or as written when it does not parse. */
  readonly target?: string;
  /** Every schema issue, else every cross-field issue. */
  readonly issues: ReadonlyArray<SpecIssue>;
  /** Each setting the schema does not know, as a path (parent, then key). */
  readonly unknownKeys: ReadonlyArray<ReadonlyArray<string | number>>;
  readonly errors: ReadonlyArray<CheckSpecError>;
  readonly warnings: ReadonlyArray<CheckSpecWarning>;
  /** One finding per IR pass that refused the IR. */
  readonly passes: ReadonlyArray<{ readonly pass: string; readonly message: string }>;
  readonly features: HarnessFeatureSupport["features"];
  readonly credentials: ReadonlyArray<CheckSpecCredential>;
  /** Set when this schema cannot edit the spec safely: why, and which keys. */
  readonly readOnly?: { readonly reason: string; readonly keys: ReadonlyArray<string> };
};

/** The budget-period note is informational by nature: a valid choice. */
const INFORMATIONAL_STAGE_CODES: ReadonlySet<string> = new Set(["budget-period-below-run-cap"]);

/**
 * The settings an issue list says the schema does not know. Such an issue's
 * `path` is the PARENT object, and the key names are only in its message
 * (`Unrecognized key(s) in object: 'a', 'b'`), so each path is the parent
 * plus each quoted key, or the parent alone when the message names none.
 */
export function unknownKeysOf(
  issues: ReadonlyArray<{
    readonly path: ReadonlyArray<string | number>;
    readonly message: string;
    readonly code?: string | null;
  }>,
): Array<ReadonlyArray<string | number>> {
  const out: Array<ReadonlyArray<string | number>> = [];
  const seen = new Set<string>();
  const add = (path: ReadonlyArray<string | number>): void => {
    const key = JSON.stringify(path);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(path);
  };
  for (const issue of issues) {
    if (issue.code !== "unrecognized_keys") continue;
    const keys = [...issue.message.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
    if (keys.length === 0) add([...issue.path]);
    for (const key of keys) add([...issue.path, key]);
  }
  return out;
}

/** The YAML as written, or undefined when it does not parse. */
function rawOf(yamlText: string): unknown {
  try {
    return Bun.YAML.parse(yamlText);
  } catch {
    return undefined;
  }
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readOnlyOf(
  unknownKeys: ReadonlyArray<ReadonlyArray<string | number>>,
  version: unknown,
): CheckSpecResult["readOnly"] {
  const keys = unknownKeys.map((path) => path.map(String).join("."));
  const reasons: string[] = [];
  if (keys.length > 0) {
    reasons.push(
      `This spec has settings the schema in use does not know for this shape: ${keys.join(", ")}. A newer CrewHaus may know them; editing it here could drop them.`,
    );
  }
  const latest = createDefaultEngine().latestVersion();
  if (typeof version === "number" && Number.isInteger(version) && version > latest) {
    reasons.push(
      `This spec is version ${version}, newer than version ${latest}, the newest this CrewHaus knows.`,
    );
    keys.push("version");
  }
  return reasons.length === 0 ? undefined : { reason: reasons.join(" "), keys };
}

function warningsOf(stages: CheckStages): CheckSpecWarning[] {
  const informational = new Set<string>(INFORMATIONAL_COMPILE_WARNING_CODES);
  const out: CheckSpecWarning[] = [];
  const add = (w: CompileWarning): void => {
    out.push({
      ...w,
      informational: informational.has(w.code) || INFORMATIONAL_STAGE_CODES.has(w.code),
    });
  };
  // compile()'s order: the spec-key warnings (they carry the mcp_servers name
  // warnings), the lowering's, then the tool check's.
  for (const w of stages.compileWarnings) add(w);
  for (const w of stages.loweredWarnings) add(w);
  for (const w of stages.shapeTools.warnings) add(w);
  if (stages.thredzOverride !== undefined) add(stages.thredzOverride);
  for (const f of stages.modelPlan) {
    if (f.severity === "warning") add({ code: f.rule, path: f.path, message: f.message });
  }
  if (stages.budgetPeriod !== undefined) add(stages.budgetPeriod);
  return out;
}

function credentialsOf(stages: CheckStages, env: CheckSpecOptions["env"]): CheckSpecCredential[] {
  if (stages.ir === undefined) return [];
  const out: CheckSpecCredential[] = [];
  for (const slot of enumerateModelSlots(stages.ir)) {
    // A federation slot names a peer's URL, not a model with a credential.
    if (slot.kind === "federation") continue;
    const groups = modelCredentialGroups(slot.model);
    const envNames = groups.flat();
    const present =
      env !== undefined && groups.length > 0
        ? groups.every((group) => group.some((name) => isEnvSet(env, name)))
        : undefined;
    out.push({
      slot: slot.label,
      provider: selectedProvider(slot.model) ?? "unknown",
      envNames,
      ...(present !== undefined ? { present } : {}),
    });
  }
  return out;
}

/**
 * Check a draft spec. Synchronous, and never throws for anything a spec can
 * contain: an empty text, a YAML error, a root that is not a mapping and a
 * lowering refusal all come back in the result.
 */
export function checkSpec(yamlText: string, opts: CheckSpecOptions = {}): CheckSpecResult {
  return checkResultOf(
    yamlText,
    runCheckStages(yamlText, opts.today !== undefined ? { today: opts.today } : {}),
    opts,
  );
}

/**
 * The {@link checkSpec} result for stages already run over `yamlText`, so a
 * caller that runs the pipeline itself (`crewhaus lint`) builds the same
 * answer from the same run. `opts.today` is the stages' to read.
 */
export function checkResultOf(
  yamlText: string,
  stages: CheckStages,
  opts: Omit<CheckSpecOptions, "today"> = {},
): CheckSpecResult {
  const raw = rawOf(yamlText);
  const rawTarget = isMapping(raw) && typeof raw["target"] === "string" ? raw["target"] : undefined;
  const target = stages.ir?.target ?? stages.spec?.target ?? rawTarget;

  // Every issue. A failure no issue explains (none known today) still reads as one.
  const issues: SpecIssue[] = [];
  if (stages.parseFailure !== undefined) {
    issues.push(...stages.parseFailure.issues);
    if (issues.length === 0) {
      issues.push({ path: [], code: "parse", message: stages.parseFailure.message });
    }
  }
  const unknownKeys = unknownKeysOf(issues);

  const errors: CheckSpecError[] = [];
  if (stages.lowerFailure !== undefined) {
    errors.push({ path: "<lower>", message: stages.lowerFailure.message, code: "lower" });
  }
  for (const e of stages.shapeTools.errors) {
    errors.push({ path: e.path, message: e.message, code: "tool" });
  }
  for (const f of stages.modelPlan) {
    if (f.severity === "error") errors.push({ path: f.path, message: f.message, code: f.rule });
  }
  for (const { stage, error } of stages.failures) {
    errors.push({ path: `<${stage}>`, message: messageOf(error), code: "internal" });
  }

  const warnings = warningsOf(stages);
  if (opts.emitAs === "cf-worker" && stages.spec !== undefined && stages.ir !== undefined) {
    try {
      const emitted = emitCfWorkerBundle(stages.spec, stages.ir, { readme: false });
      const informational = new Set<string>(INFORMATIONAL_COMPILE_WARNING_CODES);
      for (const w of emitted.warnings) {
        warnings.push({ ...w, informational: informational.has(w.code) });
      }
    } catch (err) {
      errors.push({ path: "<cf-worker>", message: messageOf(err), code: "cf-worker" });
    }
  }

  const manifest = opts.manifest ?? SUPPORT_MANIFEST;
  const shape =
    target === undefined ? "" : opts.emitAs === "cf-worker" ? `${target}@cf-worker` : target;
  const features =
    target === undefined
      ? []
      : featureSupport({
          shape,
          declared: declaredFeatures(raw, manifest),
          compiledWith: manifest.generatedBy,
          manifest,
        }).features;

  const readOnly = readOnlyOf(unknownKeys, isMapping(raw) ? raw["version"] : undefined);
  const passes = stages.passFindings;
  return {
    ok: issues.length === 0 && errors.length === 0 && passes.length === 0,
    schema: specSchemaIdentity(),
    ...(target !== undefined ? { target } : {}),
    issues,
    unknownKeys,
    errors,
    warnings,
    passes,
    features,
    credentials: credentialsOf(stages, opts.env),
    ...(readOnly !== undefined ? { readOnly } : {}),
  };
}
