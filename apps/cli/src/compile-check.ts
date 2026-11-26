/**
 * `crewhaus compile --check` (item 33): the engine moved to
 * `@crewhaus/compile-service/check-build`, so a draft can be checked the same
 * way without the CLI. This module keeps every export it had, and its
 * `runCompileCheck` passes the CLI's own manifest rule: the compile path's
 * `ensureBundleManifest`, which never writes over a package.json it did not
 * write.
 */
import {
  type CompileCheckResult,
  type CompileCheckOptions as ServiceCompileCheckOptions,
  runCompileCheck as runServiceCompileCheck,
} from "@crewhaus/compile-service/check-build";
import { ensureBundleManifest } from "./bundle-manifest";

export {
  BOOT_GATE_PATTERNS,
  type CheckRunResult,
  type CheckStep,
  type CheckStepName,
  type CheckStepRunner,
  type CheckStepStatus,
  type CompileCheckResult,
  bootArgvFor,
  buildBundlePackageJson,
  buildVerdict,
  classifyBootOutcome,
  collectCrewhausDeps,
  defaultCheckRunner,
  describeBootFailure,
  emptyEnvFile,
  resolveBootEntry,
  scrubbedEnv,
} from "@crewhaus/compile-service/check-build";

export type CompileCheckOptions = Omit<ServiceCompileCheckOptions, "ensureManifest">;

/** The three-step check over a bundle the compile path just wrote to `outDir`. */
export function runCompileCheck(opts: CompileCheckOptions): Promise<CompileCheckResult> {
  return runServiceCompileCheck({
    ...opts,
    ensureManifest: (files, outDir) => ensureBundleManifest(files, outDir),
  });
}
