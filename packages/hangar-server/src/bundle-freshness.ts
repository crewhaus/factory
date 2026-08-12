/**
 * Bundle freshness moved DOWN into `@crewhaus/harness-supervisor`, where the
 * spawn path can reach it: `daemon start --compile` has to answer "is this
 * bundle stale against crewhaus.yaml?" before it decides whether to
 * recompile, and the supervisor cannot import this package (the dependency
 * runs the other way).
 *
 * This module stays as a re-export so every existing import keeps resolving
 * and `@crewhaus/hangar-server`'s public surface is unchanged.
 */
export type { BundleFreshness } from "@crewhaus/harness-supervisor";
export {
  BUNDLE_MANIFEST_NAME,
  BUNDLE_STAMP_KEY,
  bundleFreshness,
  hashSpecSource,
} from "@crewhaus/harness-supervisor";
