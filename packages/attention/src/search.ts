/**
 * What a search index may hold of an item: its ref, kind, harness, state and its title as
 * a closed template with ids and names. No body, no message. Pure.
 */
import type { AttentionItem, AttentionText } from "@crewhaus/control-contract";

export type AttentionSearchDocument = {
  readonly ref: string;
  readonly kind: string;
  readonly harness: string | null;
  readonly state: string;
  readonly title: AttentionText;
};

export function searchDocumentsOf(items: readonly AttentionItem[]): AttentionSearchDocument[] {
  return items.map((item) => ({
    ref: item.ref,
    kind: item.kind,
    harness: item.harness ?? null,
    state: item.state,
    title: { template: item.title.template, params: { ...item.title.params } },
  }));
}
