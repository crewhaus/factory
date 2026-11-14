/**
 * What a v1 request names, found in Home's records: the harness `{h}` names, the ledger
 * that holds a `{cmd}`, and the live directory of a harness. Reads only.
 */
import { existsSync } from "node:fs";
import type { CommandReceipt } from "@crewhaus/control-contract";
import type { LedgerChoice } from "@crewhaus/control-service";
import { HARNESS_ID_RE, type HangarHarnessEntry, slugOf } from "@crewhaus/harness-registry";
import { visibleToRequest } from "../access";
import type { V1Context, V1Deps } from "./context";
import { V1Error } from "./errors";

/** The registered harness `{h}` names: its id, or its slug. */
export function entryOf(deps: V1Deps, h: string | undefined): HangarHarnessEntry | undefined {
  if (h === undefined) return undefined;
  if (HARNESS_ID_RE.test(h)) return deps.registry.get(h);
  return deps.registry
    .list()
    .find((entry) => (entry.slug ?? slugOf(entry.specName)) === h && entry.archived === undefined);
}

/** The harness the request's `{h}` names, or 404 for one this Home does not have. */
export function harnessOf(ctx: V1Context): HangarHarnessEntry {
  const entry = entryOf(ctx.deps, ctx.params["h"]);
  if (entry === undefined) {
    throw new V1Error({
      status: 404,
      code: "not_found",
      reason: "harness_unknown",
      message: "This Home has no harness by that name.",
      remedy: "Run `crewhaus harness list` to see the harnesses this Home has.",
    });
  }
  return entry;
}

/** A registered harness's directory, when it is still there. */
export function liveDirOf(entry: HangarHarnessEntry): string | undefined {
  return entry.missingSince === null && existsSync(entry.dir) ? entry.dir : undefined;
}

/** The live directory, or 409 naming why the harness cannot be acted on. */
export function liveDirOr409(entry: HangarHarnessEntry): string {
  const dir = liveDirOf(entry);
  if (dir === undefined) {
    throw new V1Error({
      status: 409,
      code: "conflict",
      reason: "harness_missing",
      message: "This harness's folder is missing.",
      remedy: "Run `crewhaus harness list` to see where Home last saw it.",
    });
  }
  return dir;
}

export type FoundCommand = {
  readonly receipt: CommandReceipt;
  readonly ledger: LedgerChoice;
  /** The harness whose ledger holds it; absent for Home's own. */
  readonly harness?: string;
};

/**
 * The ledger that holds a receipt: a harness's own, the hinted one first, then Home's.
 * Only harnesses the current request may read are looked in.
 */
export function commandLedgerOf(
  deps: V1Deps,
  cmd: string,
  hint?: string,
): FoundCommand | undefined {
  const entries = deps.registry.list();
  const hinted = hint === undefined ? undefined : entryOf(deps, hint);
  const order = hinted === undefined ? entries : [hinted, ...entries.filter((e) => e !== hinted)];
  for (const entry of order) {
    const dir = liveDirOf(entry);
    if (dir === undefined || !visibleToRequest(entry.id)) continue;
    const receipt = deps.control.commands.get({ harness: dir }, cmd);
    if (receipt !== undefined) return { receipt, ledger: { harness: dir }, harness: entry.id };
  }
  const receipt = deps.control.commands.get("workspace", cmd);
  return receipt === undefined ? undefined : { receipt, ledger: "workspace" };
}

/** Every registered harness the current request may read, with its live directory. */
export function visibleHarnesses(deps: V1Deps): readonly HangarHarnessEntry[] {
  return deps.registry
    .list()
    .filter((entry) => entry.archived === undefined && visibleToRequest(entry.id));
}
