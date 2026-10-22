/**
 * @crewhaus/claim-ledger — the one text layer every claim checker reads
 * (design/0.8.0-provability-release.md §4.1).
 *
 * Sentences and claims, content tokens and coverage, the citation grammar
 * and the evidence references a definition can name, locating a claim's
 * words in a source, and the values a claim states. The provability gate,
 * tool-verify's CitationLint and FactCrossCheck, and the continuity and
 * faithfulness graders all import these from here, so no two of them can
 * disagree about what a document claims or cites. Dependency-free and
 * model-free: every answer is a function of the characters.
 */
export { STOPWORDS, contentTokens, coverage } from "./tokens";
export {
  ABBREVIATIONS,
  MIN_CLAIM_TOKENS,
  claimSentences,
  isQuestion,
  sentences,
  splitSentences,
} from "./sentences";
export {
  type Citation,
  type CitationReport,
  type CitedClaim,
  citationDefinitions,
  citedClaims,
  lintCitations,
  plainClaim,
} from "./citations";
export {
  type InlineLink,
  type SpanIndex,
  codeSpanTest,
  codeSpans,
  fencedSpans,
  hasUriScheme,
  inSpan,
  indexSpans,
  inlineLinks,
  lineIndex,
  splitLinkTarget,
  withoutLinkTitle,
} from "./markdown";
export { type ExtractClaimsOptions, type ExtractedClaim, extractClaims } from "./claims";
export {
  type EvidenceRef,
  type EvidenceRefKind,
  classifyDefinition,
  definitionGloss,
  isAssumptionMarker,
} from "./refs";
export {
  type BestSpan,
  type ClaimQuery,
  type LocateCause,
  type LocateOptions,
  type LocateStatus,
  type LocateWordsOptions,
  type Location,
  type QuoteHit,
  type SourceIndex,
  type SourceToken,
  DEFAULT_WINDOW_TOKENS,
  MAX_EXCERPT_CHARS,
  MISQUOTE_COVERAGE,
  MISQUOTE_MIN_MATCHED,
  NEGATIONS,
  QUOTE_MIN_TOKENS,
  bestSpan,
  breaksClause,
  claimFigures,
  claimQuery,
  claimWords,
  clauseNumbers,
  figureKey,
  findSequence,
  foldTypography,
  governingNegation,
  indexSource,
  isWaivableMiss,
  lineOf,
  locateClaim,
  locateQuote,
  locateQuotes,
  locateWords,
  normalizeToken,
  quotedRuns,
  scanMeter,
  spanExcerpt,
  tightestWindows,
  tokenize,
} from "./locate";
export {
  type FigureWord,
  containsValue,
  extractNumbers,
  figureWord,
  normalizeNumber,
} from "./numbers";
export { type QuotedSpan, containsQuote, quotedSpans } from "./quotes";
export { messageText } from "./messages";
