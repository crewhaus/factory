/**
 * The attention read model as a projection Home's projector keeps under its cache, one
 * file per harness. It is a plain object with the projection's shape, built by a factory
 * because its refresh needs the facts port (the env chain names the session root) and a
 * projection's refresh is handed neither an env nor Home's root. Home builds it once; the
 * CLI builds the same one.
 *
 * The saved state holds ids, kinds, counts, times, stamps and templates only. A harness's
 * overview row shows its open items by band, counted from the harness's own records
 * (Advisor findings are gathered by Home's sweep and listed in the inbox).
 */
import type { AttentionOverview } from "@crewhaus/control-contract";
import type { ResumeItem, ResumeSources } from "@crewhaus/control-records";
import { emptyModel, foldModelLine, modelSources, overviewOf, refreshModel } from "./fold";
import { type AttentionReader, DEFAULT_READER } from "./read";
import type { AttentionModel, HarnessFacts } from "./types";

/** The projection's name: its file under Home's cache, and its key under `areas.attention`. */
export const ATTENTION_PROJECTION_NAME = "attention";

export type AttentionProjection = {
  readonly name: typeof ATTENTION_PROJECTION_NAME;
  readonly overview: true;
  empty(): AttentionModel;
  fold(state: AttentionModel, item: ResumeItem): AttentionModel;
  sources(harnessDir: string): ResumeSources;
  refresh(state: AttentionModel, harnessDir: string, now: number): AttentionModel;
  /** What a harness's overview row shows of the model: open items by band. */
  served(state: AttentionModel, harnessDir: string, now: number): AttentionOverview;
};

export function attentionProjection(
  facts: HarnessFacts,
  options: { readonly reader?: AttentionReader } = {},
): AttentionProjection {
  const reader = options.reader ?? DEFAULT_READER;
  return {
    name: ATTENTION_PROJECTION_NAME,
    overview: true,
    empty: emptyModel,
    fold: foldModelLine,
    sources: modelSources,
    refresh: (state, harnessDir) => refreshModel(state, harnessDir, facts, reader),
    served: (state, harnessDir, now) => overviewOf(state, harnessDir, now, { facts, reader }),
  };
}
