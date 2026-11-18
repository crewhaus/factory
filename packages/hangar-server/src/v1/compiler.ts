/**
 * The compiler area in Home's versioned API: one capability per setting in the
 * support manifest (`@crewhaus/ir/support`), `features.<setting>`, answered for
 * a harness by its shape and the crewhaus version its bundle was compiled with.
 * A harness with no build, or one built before the manifest existed, answers
 * `unknown` with `crewhaus compile` as the way to find out. No handler, no
 * operation: the answers ride `harnesses.capabilities`.
 */
import { COMPILER_FEATURE_KEYS } from "@crewhaus/control-contract";
import type { HangarHarnessEntry } from "@crewhaus/harness-registry";
import { readBundleStamp, resolveBundle } from "@crewhaus/harness-supervisor";
import { supportDescriptor } from "@crewhaus/ir/support";
import type { HomeAreaRuntime } from "./areas";
import type { CapabilityProvider, V1Context } from "./context";

/** The crewhaus version a harness's bundle was compiled with, or undefined (no build, no stamp). */
export type CompiledWithReader = (entry: HangarHarnessEntry) => string | undefined;

/** Reads the compile stamp of the bundle `crewhaus compile` wrote for the harness's shape. */
export const readCompiledWith: CompiledWithReader = (entry) => {
  if (entry.missingSince !== null) return undefined;
  const location = resolveBundle(entry.dir, entry.target);
  if (location === undefined) return undefined;
  return readBundleStamp(location.bundleDir)?.compiledWith;
};

/** One provider per feature key, reading each harness's stamp once per request. */
export function compilerCapabilityProviders(
  read: CompiledWithReader = readCompiledWith,
): readonly CapabilityProvider[] {
  const perRequest = new WeakMap<V1Context, Map<string, string | undefined>>();
  const compiledWith = (entry: HangarHarnessEntry, ctx: V1Context): string | undefined => {
    let seen = perRequest.get(ctx);
    if (seen === undefined) {
      seen = new Map();
      perRequest.set(ctx, seen);
    }
    if (!seen.has(entry.id)) seen.set(entry.id, read(entry));
    return seen.get(entry.id);
  };
  return COMPILER_FEATURE_KEYS.map((key) => ({
    key,
    answer: async (entry, ctx) => {
      const version = compiledWith(entry, ctx);
      return supportDescriptor({
        feature: key.slice("features.".length),
        shape: entry.target,
        ...(version !== undefined ? { compiledWith: version } : {}),
      });
    },
  }));
}

export const HOME_COMPILER: HomeAreaRuntime = {
  area: "compiler",
  capabilityProviders: compilerCapabilityProviders(),
};
