/**
 * `@crewhaus/knowledge-index`: one view of what a harness knows, for Home and the CLI. A
 * harness keeps knowledge in several stores; this projects them into one item model, one
 * rebuildable search index and one usage fold. Each store's library stays the only writer of
 * its bytes; here only {@link buildShard} writes, and only under Home's cache. No model is
 * called. The one door that erases a person's data is `./erasure`.
 *
 * It never enters a compiled harness (a test holds it).
 */
export {
  ADAPTERS,
  type HarnessFold,
  type KnowledgeAdapter,
  type KnowledgeHistoryEntry,
  adapterOf,
  foldItems,
} from "./adapters";
export { NOT_PERSONAL } from "./adapters/facts";
export { type ParsedLesson, lessonIdOf, parseLessons } from "./adapters/sources";
export {
  type CoverageNote,
  HarnessRead,
  type HarnessReadOptions,
  type ThredzRow,
  type ThredzSource,
  UNREGISTERED_HRN,
} from "./context";
export { INDEX_PENDING, knowledgeIndexEffect } from "./effect";
export {
  ITEMS_LIMIT_DEFAULT,
  type ItemFilter,
  type ItemsRead,
  type LookedUp,
  type ReadItemsOptions,
  idOfRecordRef,
  lookup,
  readHistory,
  readItem,
  readItems,
} from "./items";
export type { FoldedItem, RecordRef } from "./model";
export {
  type SearchDoc,
  type SearchProvider,
  type SearchRow,
  _resetSearchProvidersForTest,
  registerSearchProvider,
  searchProviders,
} from "./providers";
export { type ParsedQuery, kindsOf, parseQuery } from "./query";
export {
  type SearchAnswer,
  type SearchHarness,
  type SearchOptions,
  STILL_BUILDING,
  search,
} from "./search";
export {
  type BuildAnswer,
  KNOWLEDGE_INDEX_REL,
  KNOWLEDGE_PROJECTION,
  REINDEX_VERB,
  SHARD_ITEM_CAP,
  Shard,
  type ShardMeta,
  _setShardTapForTest,
  buildShard,
  deleteShard,
} from "./shard";
export { PREVIEW_MAX, TITLE_MAX, maskedBody } from "./text";
export {
  type ItemUsage,
  type ItemUse,
  KNOWLEDGE_ITEM_LABEL,
  type RunDecision,
  UsageFold,
  foldUsage,
  itemDigest,
} from "./usage";
