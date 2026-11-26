/**
 * Graph runs paused for a decision: each run that says in its own `_meta.json` where it
 * waits (`pendingHitl`) is one item, until it is resumed. The graphs folder is listed
 * newest first under a cap (truncation reported), and one small file is read per run,
 * whole and contained in the harness, because it holds one JSON object with no newline.
 *
 * A folder or a file that names another run, or a checkpoint no store mints, is no item.
 * The question the run asks is the spec author's text: a body, read at serve time for a
 * caller who may read the content, and never kept in the saved model.
 */
import { join } from "node:path";
import { ATTENTION_TWINS, type AttentionChoice, GRAPH_RUN_ID_RE } from "@crewhaus/control-contract";
import { digestPrefix } from "../ids";
import { draftItem, isoOf, msOf, timeOf, twinOf } from "../items";
import type { AttentionReader } from "../read";
import type { AttentionModel, CheckpointFact, Drafted, ItemContext } from "../types";

/** The graphs folder, relative to the harness. */
export const GRAPHS_REL = join(".crewhaus", "graphs");

/** A run's `_meta.json` larger than this is not read. */
export const GRAPH_META_MAX_BYTES = 16 * 1024;

const CHECKPOINT_ID_RE = /^ckpt_[0-9a-f]{16}$/;

/** A node's name as an item may show it. */
const NODE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

type CheckpointsSection = AttentionModel["checkpoints"];

const metaRel = (grun: string): string => join(GRAPHS_REL, grun, "_meta.json");

/** Where a run waits and what it asks, from its own file; `undefined` when it does not wait. */
function pendingOf(
  dir: string,
  reader: AttentionReader,
  grun: string,
):
  | {
      readonly ckpt: string;
      readonly node?: string;
      readonly at?: string;
      readonly prompt?: string;
    }
  | undefined {
  const meta = reader.object?.(dir, metaRel(grun), GRAPH_META_MAX_BYTES);
  if (meta === undefined || meta["graphRunId"] !== grun) return undefined;
  const pending = meta["pendingHitl"];
  if (typeof pending !== "object" || pending === null || Array.isArray(pending)) return undefined;
  const p = pending as Record<string, unknown>;
  const ckpt = p["checkpointId"];
  if (typeof ckpt !== "string" || !CHECKPOINT_ID_RE.test(ckpt)) return undefined;
  const at = timeOf(p["at"]);
  return {
    ckpt,
    ...(typeof p["nodeName"] === "string" && NODE_NAME_RE.test(p["nodeName"])
      ? { node: p["nodeName"] }
      : {}),
    ...(at !== undefined ? { at } : {}),
    ...(typeof p["prompt"] === "string" ? { prompt: p["prompt"] } : {}),
  };
}

/** The paused runs, re-read only when a run's folder changed; `prev` itself when none did. */
export function readCheckpointsSection(
  dir: string,
  reader: AttentionReader,
  prev: CheckpointsSection | undefined,
): CheckpointsSection {
  const listed = reader.list?.(dir, GRAPHS_REL, GRAPH_RUN_ID_RE) ?? { state: "absent" as const };
  if (listed.state !== "read") {
    if (prev !== undefined && prev.stamp === listed.state) return prev;
    return { stamp: listed.state, facts: [] };
  }
  const stamp = digestPrefix(
    `${listed.truncated}\n${listed.entries.map((e) => `${e.name}@${e.changedMs}`).join("\n")}`,
    32,
  );
  if (prev !== undefined && prev.stamp === stamp) return prev;
  const facts: CheckpointFact[] = [];
  for (const { name, changedMs } of listed.entries) {
    const pending = pendingOf(dir, reader, name);
    if (pending === undefined) continue;
    facts.push({
      grun: name,
      ckpt: pending.ckpt,
      ...(pending.node !== undefined ? { node: pending.node } : {}),
      at: pending.at ?? isoOf(changedMs),
    });
  }
  return { stamp, facts, ...(listed.truncated ? { truncated: true as const } : {}) };
}

/** What each waiting run asks, read now, for a caller who may read the content. */
export function checkpointBodies(
  dir: string,
  reader: AttentionReader,
  section: CheckpointsSection,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const fact of section.facts) {
    const pending = pendingOf(dir, reader, fact.grun);
    if (pending?.ckpt === fact.ckpt && pending.prompt !== undefined) {
      out.set(fact.grun, pending.prompt);
    }
  }
  return out;
}

/** The key of the item a pause is. */
export function checkpointKeyOf(fact: Pick<CheckpointFact, "grun" | "ckpt">): string {
  return `grun:${fact.grun}:${fact.ckpt}`;
}

/** The pause an item's source names: its graph run and its checkpoint. */
export function pauseOf(
  source: string,
): { readonly grun: string; readonly ckpt: string } | undefined {
  const [grun, ckpt, ...rest] = source.split("/");
  return grun !== undefined &&
    ckpt !== undefined &&
    rest.length === 0 &&
    GRAPH_RUN_ID_RE.test(grun) &&
    CHECKPOINT_ID_RE.test(ckpt)
    ? { grun, ckpt }
    : undefined;
}

function choicesOf(fact: CheckpointFact, harness: string): AttentionChoice[] {
  return (["approve", "reject"] as const).map((choice) => {
    const cliTwin = twinOf(ATTENTION_TWINS.graphResume, {
      grun: fact.grun,
      ckpt: fact.ckpt,
      graphDecision: choice,
      hrn: harness,
    });
    return cliTwin !== undefined
      ? { id: choice, needs: "operator", cliTwin }
      : { id: choice, needs: "operator", cliTwin: null, nullReason: "Decide it in Home." };
  });
}

/** One item per waiting run. Pure over the section, except the bodies a content reader is handed. */
export function checkpointItems(
  section: CheckpointsSection,
  ctx: ItemContext,
  bodies: ReadonlyMap<string, string> | undefined,
): Drafted[] {
  return section.facts.map((fact) => {
    const prompt = bodies?.get(fact.grun);
    return draftItem({
      scope: ctx.harness,
      kind: "checkpoint",
      key: checkpointKeyOf(fact),
      harness: ctx.harness,
      source: { kind: "checkpoint", id: `${fact.grun}/${fact.ckpt}` },
      title: {
        template: "checkpoint.waiting",
        params: fact.node !== undefined ? { node: fact.node } : {},
      },
      whyNow: { template: "why.graph-paused", params: {} },
      runs: [],
      count: 1,
      evidence: [{ kind: "run", ref: fact.grun, label: fact.node ?? fact.grun }],
      revision: [{ id: fact.grun, state: fact.ckpt }],
      choices: choicesOf(fact, ctx.harness),
      requiredClass: "operator",
      state: "open",
      ...(prompt !== undefined ? { body: { question: prompt } } : {}),
      ...(ctx.content ? {} : { bodyWithheld: true as const }),
      since: fact.at,
      latestAt: msOf(fact.at) ?? 0,
      freshness: ctx.freshness,
    });
  });
}
