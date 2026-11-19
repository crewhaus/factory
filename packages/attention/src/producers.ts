/**
 * Producers: how another area adds items of its own kinds without this package knowing
 * it. A producer registers once per process for one kind of the closed vocabulary, with
 * the title templates it uses; the fold calls it after the
 * built-in adapters, with the same facts port. A registration is an object, so a later
 * area may add fields to it (a delivery urgency, say).
 */
import {
  ATTENTION_KINDS,
  type AttentionItem,
  type AttentionKind,
} from "@crewhaus/control-contract";
import type { HarnessFacts, ItemContext } from "./types";

export type AttentionProducer = {
  readonly kind: AttentionKind;
  /** The title templates its items use. */
  readonly templates: readonly string[];
  /** Its items for one harness, read-only. */
  fold(harnessDir: string, facts: HarnessFacts, ctx: ItemContext): readonly AttentionItem[];
};

const PRODUCERS = new Map<string, AttentionProducer>();

/** Register a producer for `kind`. Throws for a kind outside the vocabulary or taken. */
export function registerProducer(kind: string, producer: Omit<AttentionProducer, "kind">): void {
  if (!(ATTENTION_KINDS as readonly string[]).includes(kind)) {
    throw new TypeError(`attention: "${kind}" is not an attention kind`);
  }
  if (PRODUCERS.has(kind)) {
    throw new TypeError(`attention: a producer for "${kind}" is already registered`);
  }
  PRODUCERS.set(kind, { ...producer, kind: kind as AttentionKind });
}

/** Every registered producer, in registration order. */
export function producers(): readonly AttentionProducer[] {
  return [...PRODUCERS.values()];
}

/** Forget every registration, for a test that registers its own. */
export function _resetProducersForTest(): void {
  PRODUCERS.clear();
}
