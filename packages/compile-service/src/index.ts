/**
 * `@crewhaus/compile-service` — check and compile a draft spec without
 * registering or writing anything.
 *
 *   - `checkSpec`: every issue a draft has, in one result (module brief 334);
 *   - `compileDraft`: the files a build would hold, their digest and stamp;
 *   - `runCheckStages`: the one check pipeline `checkSpec` and `crewhaus lint`
 *     share;
 *   - the pure pieces of a build's identity (`bundle-stamp`), the warning
 *     codes `--strict` never fails on, the Cloudflare Worker build switch and
 *     the model-plan checks.
 *
 * `checkBuild` (`compile --check` over files in memory) is the
 * `./check-build` entry: this entry never reaches a process runner.
 *
 * Heavy by design (it carries the compiler and every emitter), so a compiled
 * harness never imports it.
 */
export {
  BUNDLE_MANIFEST_NAME,
  BUNDLE_STAMP_KEY,
  type BundleSpecStamp,
  buildBundlePackageJson,
  bundleDigest,
  bundleManifestText,
  collectCrewhausDeps,
  hashSpecSource,
  specRevision,
} from "./bundle-stamp";
export {
  CF_WORKER_EMIT_TARGETS,
  type CfWorkerEmitOptions,
  emitCfWorkerBundle,
} from "./cf-worker-emit";
export {
  type CheckSpecCredential,
  type CheckSpecError,
  type CheckSpecOptions,
  type CheckSpecResult,
  type CheckSpecWarning,
  type SchemaIdentity,
  checkResultOf,
  checkSpec,
  unknownKeysOf,
} from "./check-spec";
export { type CompileDraftOptions, type CompileDraftResult, compileDraft } from "./compile-draft";
export { INFORMATIONAL_COMPILE_WARNING_CODES, wrapCodes } from "./compile-warnings";
export { type ModelPlanFinding, auditModelPlan } from "./model-plan-lint";
export {
  type CheckStages,
  type CheckStagesOptions,
  type StageNote,
  runCheckStages,
} from "./stages";
