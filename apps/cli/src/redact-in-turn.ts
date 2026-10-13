/**
 * Synchronous PII redaction for the watchme report/synthesize seams.
 */
import { type PiiDetector, piiMatches } from "@crewhaus/grader-safety-classifiers";

/**
 * `text` with every match of each detector, one detector after another,
 * replaced by `[REDACTED:<kind>]`: what `text.replace(<its global pattern>,
 * marker)` did in turn, but reading each detector's matches with its linear
 * scan where it has one (the email pattern is quadratic in a run like
 * `a-a-…`).
 */
export function redactInTurn(text: string, detectors: ReadonlyArray<PiiDetector>): string {
  let out = text;
  for (const d of detectors) {
    const found = piiMatches(out, d);
    if (found.length === 0) continue;
    const marker = `[REDACTED:${d.kind}]`;
    let next = "";
    let kept = 0;
    for (const m of found) {
      next += `${out.slice(kept, m.index)}${marker}`;
      kept = m.index + m.value.length;
    }
    out = next + out.slice(kept);
  }
  return out;
}
