/**
 * Locating a claim's words inside a source — now `@crewhaus/claim-ledger`'s
 * locate kernel (design/0.8.0 §4.1, §6.2), so FactCrossCheck and the
 * provability gate's `grounded` rung locate a claim the same way.
 *
 * Re-exported under the names this package has always used. `contentTokens`
 * here is the kernel's `claimWords` (a claim's words, in order, negations
 * kept); in claim-ledger that name belongs to the graders' Set-valued
 * measure. `scanMeter` is the kernel's own object, not a copy, so the
 * linear-time tests that read it here count the kernel's passes.
 */
export {
  type BestSpan,
  type SourceIndex,
  type SourceToken,
  NEGATIONS,
  bestSpan,
  claimWords as contentTokens,
  findSequence,
  foldTypography,
  indexSource,
  lineOf,
  normalizeToken,
  quotedRuns,
  scanMeter,
  spanExcerpt,
  tokenize,
} from "@crewhaus/claim-ledger";
