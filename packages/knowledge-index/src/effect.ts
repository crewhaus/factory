/**
 * What a receipt says about search: whether the index reflects a change already, or will when
 * Home next runs. No item id and no text.
 */
import type { ReceiptEffect } from "@crewhaus/control-contract";
import { HarnessRead } from "./context";
import { Shard } from "./shard";

/** What an effect that is still pending says. */
export const INDEX_PENDING = "applies when Home next runs";

/**
 * The `index` effect of a change to one harness's knowledge: `done`, with when the index was
 * built, when the index was built from the stores as they are now; `unknown` until then.
 */
export function knowledgeIndexEffect(at: {
  readonly hangarRoot: string;
  readonly hrn: string;
  readonly harnessDir: string;
}): ReceiptEffect {
  // An index under this id that was built from another folder says nothing about this one.
  const shard = Shard.open(at.hangarRoot, at.hrn, at.harnessDir);
  const current =
    shard !== undefined &&
    shard.changed(new HarnessRead({ harnessDir: at.harnessDir, hrn: at.hrn })).size === 0;
  return current
    ? { kind: "index", status: "done", observed: shard.meta.asOf }
    : { kind: "index", status: "unknown", note: INDEX_PENDING };
}
