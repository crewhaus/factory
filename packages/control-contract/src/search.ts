/**
 * `@crewhaus/control-contract/search`: a search answer, as every surface shows it. A hit
 * carries content only for a reader who may read it, and a page is filtered before it is
 * ranked, counted or cut. Types and data only.
 *
 * The main entry does not import this one. It reaches only its own file and files the main
 * entry reaches.
 */
import { KNOWLEDGE_STORES, type KnowledgeBackend, type KnowledgeStore } from "./knowledge.js";
import { deepFreeze } from "./util.js";

/** What a search can find: the objects around a harness, and every knowledge store. */
export const SEARCH_KINDS = deepFreeze([
  "harness",
  "session",
  "run",
  "decision",
  "work",
  "criterion",
  "dataset",
  "grader",
  ...KNOWLEDGE_STORES,
] as const);

export type SearchKind = (typeof SEARCH_KINDS)[number];

export type SearchHit = {
  readonly kind: SearchKind;
  readonly ref: string;
  readonly title: string;
  /** For a reader who may read content. */
  readonly snippet?: {
    readonly text: string;
    readonly highlights: ReadonlyArray<readonly [number, number]>;
  };
  readonly source: {
    readonly harness: string;
    readonly harnessName: string;
    readonly store?: KnowledgeStore;
    readonly backend?: KnowledgeBackend;
  };
  readonly updatedAt?: string;
  readonly freshness: { readonly asOf: string; readonly stale: boolean };
  readonly owner?: {
    readonly kind: "member" | "agent" | "harness-owner";
    readonly name?: string;
  };
  readonly href: string;
};

export type SearchFacet = "kind" | "harness" | "status";

/** What an answer covers, said out loud. */
export type SearchCoverage = {
  /** The kinds that were searched. */
  readonly kinds: readonly string[];
  /** The harnesses whose names only were searched: their index is still being built. */
  readonly namesOnly: readonly string[];
  readonly thredz: "live" | "cached" | "off";
};

export type SearchPage = {
  readonly items: readonly SearchHit[];
  readonly next?: string;
  /** Every match the reader may see, before the page was cut. */
  readonly total: number;
  /** Counted after the filter, over every match. */
  readonly facets: Readonly<Record<SearchFacet, Readonly<Record<string, number>>>>;
  readonly coverage: SearchCoverage;
  readonly empty?: { readonly reason: string; readonly remedy?: string };
};
