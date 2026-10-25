/**
 * Per-run observers of the proof gate (design/0.8.0-provability-release.md
 * §5.4): how a surface that serves many runs from one wiring sees the bundle
 * of ONE of them.
 *
 * `wireEvaluation`'s `onBundle` dep observes every bundle the wiring ever
 * grades, which is the right seam for a bundle that wires its gates per
 * process and serves one run at a time. The managed daemon does not: it
 * wires once at module load and serves concurrent runs for many tenants, and
 * the gateway must answer each `runs.create` with the bundle of THAT run's
 * final turn. So the daemon passes an observer per run, and this composes it
 * onto the shared gate's own `onBundle` for that run's `runChatLoop` only.
 *
 * The runtime calls `onBundle` once per graded pass (the original answer and
 * each gate-triggered retry), in order, so the LAST call a run sees is the
 * standing verdict — the one the footer renders and the one to return.
 */
import type { ProofBundle } from "@crewhaus/provability";
import type { RunProvability } from "@crewhaus/runtime-core";

export type { ProofBundle } from "@crewhaus/provability";

/** Sees a graded bundle and, when it was persisted, where. */
export type ProofBundleObserver = (bundle: ProofBundle, bundlePath?: string) => void;

/**
 * `provability` with `observer` added beside its own `onBundle`, for one run.
 * Identity when either is absent, so a call site can thread an optional
 * observer unconditionally and a run without one (or a spec without the
 * block) is handed exactly the shared gate. The gate's own observer runs
 * first; one that throws does not keep the run's from seeing the bundle (the
 * runtime already isolates a throwing `onBundle` from the verdict, and this
 * isolates the two observers from each other the same way).
 */
export function observeProofBundles(
  provability: RunProvability | undefined,
  observer: ProofBundleObserver | undefined,
): RunProvability | undefined {
  if (provability === undefined || observer === undefined) return provability;
  const own = provability.onBundle;
  return {
    ...provability,
    onBundle: (bundle, bundlePath) => {
      let failure: { readonly error: unknown } | undefined;
      if (own !== undefined) {
        try {
          own(bundle, bundlePath);
        } catch (error) {
          failure = { error };
        }
      }
      observer(bundle, bundlePath);
      if (failure !== undefined) throw failure.error;
    },
  };
}
