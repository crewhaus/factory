/**
 * An item's discussion: one file per item under the harness, a line per message, kept for
 * people. Its text is never relayed to a model, and nothing but this module reads it. The
 * act ledger records that a message was added, never what it says.
 */
import { join } from "node:path";
import {
  ATTENTION_ID_RE,
  ATTENTION_MESSAGE_MAX_BYTES,
  type AttentionMessage,
  RECEIPT_VIA,
  type ReceiptVia,
  isStoredActor,
} from "@crewhaus/control-contract";
import { readTail } from "@crewhaus/control-records";
import { appendContained, ensureDirContained } from "@crewhaus/tool-safety/fs";
import { timeOf } from "../items";
import { idOfItem } from "../overlays";
import { expectProblem, refuse } from "./checks";
import { appendAction } from "./ledger";
import { overlayStateOf } from "./overlay-acts";
import type { ActDeps, ActPlan, ActRequest } from "./types";

/** Where discussions are, relative to the harness. */
export const THREADS_REL = join(".crewhaus", "run", "attention", "threads");

/** At most this many messages of one discussion are read, newest kept. */
export const THREAD_CAPS = { maxLines: 500, maxBytes: 4 * 1024 * 1024 } as const;

const threadRel = (att: string): string => join(THREADS_REL, `${att}.jsonl`);

/** A message's text as it is kept, or why it is not one. */
function textProblem(text: unknown): string | undefined {
  if (typeof text !== "string" || text.trim() === "") return "A message has some text.";
  if (Buffer.byteLength(text, "utf8") > ATTENTION_MESSAGE_MAX_BYTES) {
    return "A message holds at most 8 KiB.";
  }
  return undefined;
}

export function planMessage(
  request: ActRequest & { readonly text: string },
  deps: ActDeps,
): ActPlan {
  const problem = textProblem(request.text);
  if (problem !== undefined) return refuse("invalid", "text", problem);
  const stale = expectProblem(request);
  if (stale !== undefined) return stale;
  const att = idOfItem(request.item);
  if (!ATTENTION_ID_RE.test(att)) return refuse("not_found", "attention_unknown", "No such item.");
  return {
    ok: true,
    async run(cmd) {
      const by = await deps.decisions.storedActorOf(request.dir, request.actor);
      const at = new Date(deps.now()).toISOString();
      const made = ensureDirContained(request.dir, THREADS_REL, { mode: 0o700 });
      const written = made.ok
        ? appendContained(
            request.dir,
            threadRel(att),
            `${JSON.stringify({ v: 1, at, by, via: request.via, text: request.text })}\n`,
            { mode: 0o600, hardLinks: "refuse" },
          )
        : made;
      if (!written.ok) {
        return refuse("unavailable", "not_recorded", `It could not be kept (${written.reason}).`);
      }
      const state = overlayStateOf(request.item);
      const failed = await appendAction(request.dir, request.item, {
        state,
        event: "message",
        at,
        by,
        via: request.via,
        evidenceRev: request.item.evidenceRev,
        ...(cmd !== undefined ? { cmd } : {}),
      });
      return failed ?? { ok: true, event: "message", state: request.item.state };
    },
  };
}

export async function addMessage(
  request: ActRequest & { readonly text: string },
  deps: ActDeps,
  cmd?: string,
) {
  const plan = planMessage(request, deps);
  return plan.ok ? plan.run(cmd) : plan;
}

export type Thread = {
  readonly messages: readonly AttentionMessage[];
  /** Older messages were left out. */
  readonly truncated: boolean;
};

/** An item's messages, oldest first, newest kept. Reads only: creates nothing. */
export function listMessages(dir: string, att: string): Thread {
  if (!ATTENTION_ID_RE.test(att)) return { messages: [], truncated: false };
  const read = readTail(dir, threadRel(att), THREAD_CAPS);
  if (read.state !== "read") return { messages: [], truncated: false };
  const messages: AttentionMessage[] = [];
  for (const record of read.records) {
    const at = timeOf(record["at"]);
    const { by, via, text } = record;
    if (at === undefined || !isStoredActor(by) || typeof text !== "string") continue;
    if (!(RECEIPT_VIA as readonly unknown[]).includes(via)) continue;
    messages.push({ at, by: by as string, via: via as ReceiptVia, text });
  }
  return { messages, truncated: read.truncated };
}
