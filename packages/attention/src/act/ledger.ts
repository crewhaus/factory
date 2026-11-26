/**
 * Writing what people did about an item: one content-free line per act on the harness's
 * actions ledger, by compare-and-set on the item's id, so an act is recorded once and in
 * order. The line is also the event a stream sends. And the Advisor's own ledger, whose
 * lines an older reader keeps reading.
 */
import { join } from "node:path";
import type {
  AttentionActionEvent,
  AttentionItem,
  AttentionResolution,
  AttentionState,
  DeferReason,
  DismissReason,
  ReceiptVia,
} from "@crewhaus/control-contract";
import { attentionActionsLedger, casAppend, foldStates } from "@crewhaus/control-records";
import { appendContained, ensureDirContained } from "@crewhaus/tool-safety/fs";
import { idOfItem } from "../overlays";
import type { ActRefusal } from "./types";

/** One actions line. Ids, closed codes and times: no text, no note, no name. */
export type ActionLine = {
  readonly state: AttentionState;
  readonly event: AttentionActionEvent;
  readonly at: string;
  /** Who, as a stored actor. */
  readonly by: string;
  readonly via: ReceiptVia;
  readonly evidenceRev: string;
  readonly cmd?: string;
  readonly how?: AttentionResolution;
  readonly choice?: string;
  /** The member it was assigned to. */
  readonly to?: string;
  /** The member who hid it from themselves. */
  readonly member?: string;
  readonly until?: string;
  readonly reasonCode?: DeferReason | DismissReason;
};

const unavailable = (message: string): ActRefusal => ({
  ok: false,
  code: "unavailable",
  reason: "not_recorded",
  message: `This could not be recorded (${message}). Try it again.`,
});

/** How often a line that lost its place to another writer is put again. */
const ATTEMPTS = 4;

/** Append one line for an item; why it could not be. */
export async function appendAction(
  dir: string,
  item: Pick<AttentionItem, "ref">,
  line: ActionLine,
): Promise<ActRefusal | undefined> {
  const ledger = attentionActionsLedger(dir);
  const id = idOfItem(item);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const fold = foldStates(ledger);
    if (!fold.ok && fold.code !== "not-found") return unavailable(fold.reason);
    const current = fold.ok ? fold.objects.get(id) : undefined;
    let cas: Awaited<ReturnType<typeof casAppend>>;
    try {
      cas = await casAppend(ledger, id, current?.state ?? null, { v: 1, id, ...line });
    } catch (err) {
      return unavailable(err instanceof Error ? err.message : String(err));
    }
    if (!cas.ok) return unavailable(cas.reason);
    if (cas.applied) return undefined;
  }
  return unavailable("other acts on it kept landing first");
}

/** The Advisor's ledger, relative to the harness. */
export const ADVISOR_LEDGER_REL = join(".crewhaus", "advisor", "decisions.jsonl");

/** One line of the Advisor's ledger, version 2: the earlier actions, and `acknowledged`. */
export type AdvisorLedgerLine = {
  readonly itemId: string;
  readonly action: "acted" | "dismissed" | "reopened" | "acknowledged";
  readonly at: string;
  readonly by: string;
  readonly via: ReceiptVia;
  readonly evidenceRev?: string;
  readonly reasonCode?: DismissReason;
  /** A person's own words, kept here only. */
  readonly reason?: string;
  readonly comment?: string;
  readonly jobId?: string;
  readonly cmd?: string;
};

/** Append one version 2 line to the Advisor's ledger, contained in the harness. */
export function appendAdvisorDecision(
  dir: string,
  line: AdvisorLedgerLine,
): ActRefusal | undefined {
  const made = ensureDirContained(dir, join(".crewhaus", "advisor"), { mode: 0o700 });
  if (!made.ok) return unavailable(made.reason);
  const written = appendContained(
    dir,
    ADVISOR_LEDGER_REL,
    `${JSON.stringify({ v: 2, ...line })}\n`,
    {
      mode: 0o600,
      hardLinks: "refuse",
    },
  );
  return written.ok ? undefined : unavailable(written.reason);
}
