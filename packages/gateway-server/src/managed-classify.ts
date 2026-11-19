/**
 * The classifier a managed run's input meets, a request's and a queued run's alike, at
 * TrustOrigin "api". One slot, so a test can count or script it; this module is not a
 * published entry point of the package, and `./managed-runs` reads it through
 * {@link classifyManagedInput}.
 */
import { type BoundaryResult, classifyBoundary } from "@crewhaus/boundary-classifier";

type Classify = typeof classifyBoundary;

let classify: Classify = classifyBoundary;

/** Classify a managed run's input through the slot. */
export function classifyManagedInput(
  text: string,
  opts: Parameters<Classify>[1],
): Promise<BoundaryResult> {
  return classify(text, opts);
}

/**
 * Test seam: count or script the classifier a run's input meets. `undefined` restores it.
 * Reached by relative path from tests, never through the package's exports.
 */
export function _setManagedClassifierForTest(next: Classify | undefined): void {
  classify = next ?? classifyBoundary;
}
