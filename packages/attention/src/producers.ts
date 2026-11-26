/**
 * Producers: how another area adds items of its own kinds without this package knowing
 * it. A producer registers once per process for one kind of the closed vocabulary, with
 * the title templates it uses; the fold calls it after the built-in adapters, with the
 * same facts port. A registration is an object, so a later area may add fields to it (a
 * delivery urgency, say).
 *
 * A producer answers each item with its key; {@link producedItems} serves only what that
 * registration may add. An item is of the producer's own kind and band, about the harness
 * that was read, under a title the producer registered; its ref is derived from its kind
 * and key; a body reaches only a reader of the content; and every command on it is built
 * here from a closed template, so a producer's own words are never a command.
 */
import {
  ATTENTION_KINDS,
  type AttentionChoice,
  type AttentionItem,
  type AttentionKind,
  type CliTwin,
  type DecisionClass,
  TITLE_TEMPLATES,
  type TwinParams,
  attentionBandOf,
} from "@crewhaus/control-contract";
import { KEY_SHAPE_RE, attRefOf } from "./ids";
import { msOf, timeOf, twinOf } from "./items";
import type { Drafted, HarnessFacts, ItemContext } from "./types";

/** One way to settle a produced item: its command as a template and its values. */
export type ProducedChoice = {
  readonly id: string;
  readonly needs: DecisionClass;
  /** The command, as a closed template filled in when the item is served. */
  readonly twin?: { readonly template: CliTwin; readonly params: TwinParams };
  /** A ready command is never served: give `twin`. */
  readonly cliTwin?: string | null;
  readonly nullReason?: string;
};

export type ProducedItem = {
  /** What the item is about within its kind: ids, names and digests ({@link KEY_SHAPE_RE}). */
  readonly key: string;
  /** Its ref and band are derived; its choices carry templates, never commands. */
  readonly item: Omit<AttentionItem, "ref" | "band" | "choices"> & {
    readonly ref?: string;
    readonly band?: string;
    readonly choices: readonly ProducedChoice[];
  };
};

export type AttentionProducer = {
  readonly kind: AttentionKind;
  /** The title templates its items use. */
  readonly templates: readonly string[];
  /** Its items for one harness, read-only. */
  fold(harnessDir: string, facts: HarnessFacts, ctx: ItemContext): readonly ProducedItem[];
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

/** Said on a choice whose command could not be built from a closed template. */
const NO_COMMAND = "No command does this. Open the item in Home.";

function servedChoice(choice: ProducedChoice): AttentionChoice {
  const cliTwin =
    choice.twin === undefined ? undefined : twinOf(choice.twin.template, choice.twin.params);
  return cliTwin !== undefined
    ? { id: choice.id, needs: choice.needs, cliTwin }
    : { id: choice.id, needs: choice.needs, cliTwin: null, nullReason: NO_COMMAND };
}

const EVIDENCE_REV_RE = /^[0-9a-f]{16}$/;

/** One produced item as it may be served, or `undefined` when its registration may not add it. */
function producedItem(
  producer: AttentionProducer,
  produced: ProducedItem,
  ctx: ItemContext,
): AttentionItem | undefined {
  const { key, item } = produced;
  const band = attentionBandOf(producer.kind);
  if (
    band === undefined ||
    item.kind !== producer.kind ||
    item.harness !== ctx.harness ||
    item.harnesses !== undefined ||
    typeof key !== "string" ||
    !KEY_SHAPE_RE.test(key) ||
    !producer.templates.includes(item.title.template) ||
    !(TITLE_TEMPLATES as readonly string[]).includes(item.title.template) ||
    !(TITLE_TEMPLATES as readonly string[]).includes(item.whyNow.template) ||
    !EVIDENCE_REV_RE.test(item.evidenceRev) ||
    timeOf(item.since) === undefined
  ) {
    return undefined;
  }
  const { body, bodyWithheld, ...rest } = item;
  const withheld = !ctx.content && (body !== undefined || bodyWithheld === true);
  return {
    ...rest,
    ref: attRefOf(ctx.harness, producer.kind, key),
    band,
    // A producer's item is settled by the producer's own writer, never by another source's.
    source: { kind: "producer", id: item.source.id },
    choices: item.choices.map(servedChoice),
    ...(ctx.content && body !== undefined ? { body } : {}),
    ...(withheld || (ctx.content && bodyWithheld === true) ? { bodyWithheld: true as const } : {}),
  };
}

/** Every registered producer's items for one harness, each as its registration may add it. */
export function producedItems(facts: HarnessFacts, ctx: ItemContext): Drafted[] {
  const out: Drafted[] = [];
  for (const producer of producers()) {
    for (const produced of producer.fold(ctx.dir, facts, ctx)) {
      const item = producedItem(producer, produced, ctx);
      if (item !== undefined) out.push({ item, latestAt: msOf(item.since) ?? 0 });
    }
  }
  return out;
}

/** Forget every registration, for a test that registers its own. */
export function _resetProducersForTest(): void {
  PRODUCERS.clear();
}
