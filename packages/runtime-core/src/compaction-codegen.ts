/**
 * The compaction options a harness's loop runs with, from its `compaction:`
 * settings, in two forms that cannot drift apart: `compactionRunOptions`
 * builds the `runChatLoop` options object (what `crewhaus run` and
 * `crewhaus serve` spread), and `renderCompactionFields` renders exactly those
 * options as source text (what the cli, channel and managed emitters print
 * into a bundle). One rule, beside the loop that reads the options.
 *
 * Every option is present only when the spec declared its setting, so a spec
 * without `compaction:` gets nothing and the runtime's defaults apply.
 * `compaction.curate: true` turns on the curation pass before compaction,
 * with only the dials the spec declared. No embedder is passed, so the pass
 * drops exact repeats of a message, and its trace event says
 * `embedded: false`.
 *
 * This module imports nothing, not even types: an emitter loads it at compile
 * time, and a bundle never needs it. Its input is structural (the IR's
 * compaction block satisfies it; target-cli's `compaction-codegen.type-check.ts`
 * holds both ends to the IR and to the loop's own option types).
 */

/** The extended-thinking selector a compaction model's profile may pin. */
export type CompactionThinking =
  | { readonly budgetTokens: number }
  | { readonly effort: "low" | "medium" | "high" };

/** The request parameters a compaction model's profile pins. */
export type CompactionParams = {
  readonly thinking?: CompactionThinking;
  readonly maxTokens?: number;
  readonly temperature?: number;
};

/** A lowered `compaction:` block, as the loop reads it. */
export type CompactionSettings = {
  readonly model?: string;
  readonly params?: CompactionParams;
  readonly threshold?: number;
  readonly snipKeepHead?: number;
  readonly snipKeepTail?: number;
  readonly curate?: boolean;
  readonly dedupeThreshold?: number;
  readonly relevanceTopK?: number;
};

/** The curation pass's dials, as the loop takes them. */
export type CompactionCurateOptions = {
  readonly dedupeThreshold?: number;
  readonly relevanceTopK?: number;
};

/** The `runChatLoop` options a `compaction:` block sets. */
export type CompactionRunOptions = {
  readonly compactionModel?: string;
  readonly compactionParams?: CompactionParams;
  readonly compactionThreshold?: number;
  readonly snipKeepHead?: number;
  readonly snipKeepTail?: number;
  readonly curate?: CompactionCurateOptions;
};

/**
 * The loop options for `c`, in the order they are rendered: model, params,
 * threshold, the snip window, then `curate`. A key is present only when its
 * setting is; `curate` only when `c.curate === true`, holding only the dials
 * that are declared.
 */
export function compactionRunOptions(c: CompactionSettings): CompactionRunOptions {
  const curate: CompactionCurateOptions | undefined =
    c.curate === true
      ? {
          ...(c.dedupeThreshold !== undefined ? { dedupeThreshold: c.dedupeThreshold } : {}),
          ...(c.relevanceTopK !== undefined ? { relevanceTopK: c.relevanceTopK } : {}),
        }
      : undefined;
  return {
    ...(c.model !== undefined ? { compactionModel: c.model } : {}),
    ...(c.params !== undefined ? { compactionParams: c.params } : {}),
    ...(c.threshold !== undefined ? { compactionThreshold: c.threshold } : {}),
    ...(c.snipKeepHead !== undefined ? { snipKeepHead: c.snipKeepHead } : {}),
    ...(c.snipKeepTail !== undefined ? { snipKeepTail: c.snipKeepTail } : {}),
    ...(curate !== undefined ? { curate } : {}),
  };
}

/**
 * `compactionRunOptions(c)` as object-literal fields, one per line:
 * `\n<indent><name>: <value>,` for each option, values through
 * `JSON.stringify` (a model id is quoted and escaped, the params and the
 * curate dials are plain data). Empty when the block declares nothing.
 */
export function renderCompactionFields(c: CompactionSettings, indent: string): string {
  return Object.entries(compactionRunOptions(c))
    .map(([name, value]) => `\n${indent}${name}: ${JSON.stringify(value)},`)
    .join("");
}
