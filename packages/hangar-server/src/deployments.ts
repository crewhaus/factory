/**
 * Deployment records (F-6) — `<harness>/.crewhaus/deployments.json`.
 *
 * READ-ONLY, AND HONESTLY EMPTY. No writer for this file ships yet: the
 * upstream ask (F-6) is for the deploy path to record what it shipped where.
 * Inventing a writer here would make the manager the source of truth for a
 * fact it does not observe — a console that "knows" about a deploy it did
 * not perform, and misses every deploy performed from a terminal. So this
 * reads the file if it exists and reports `present: false` when it does not,
 * which is the correct answer today and stays correct the day F-6 lands.
 *
 * The shape is deliberately loose (records pass through tolerantly, masked):
 * pinning a schema the writer has not defined would guarantee drift.
 */
import { existsSync } from "node:fs";
import { MAX_TEXT_BYTES } from "./constants";
import { readTextCapped } from "./jsonl";
import { maskDeep } from "./mask";
import { resolveInside } from "./safety";

export const DEPLOYMENTS_FILENAME = "deployments.json";

export type DeploymentsView = {
  /** False when the file does not exist — the normal case today. */
  readonly present: boolean;
  /** Records as written, masked. Empty when absent or unreadable. */
  readonly deployments: readonly unknown[];
  /** Set when the file exists but could not be parsed. */
  readonly error: string | null;
  /** The path consulted, so an operator can see where to look. */
  readonly path: string;
  /** Why the list is empty, when it is. */
  readonly note: string | null;
};

const EMPTY_NOTE =
  "no .crewhaus/deployments.json — nothing records deploys here yet (the deploy path writes it once F-6 lands)";

/** Read a harness's deployment records. Absence is the expected state. */
export function deploymentsView(harnessDir: string): DeploymentsView {
  const path = resolveInside(harnessDir, [".crewhaus", DEPLOYMENTS_FILENAME]);
  const shown = `${harnessDir}/.crewhaus/${DEPLOYMENTS_FILENAME}`;
  if (path === undefined || !existsSync(path)) {
    return { present: false, deployments: [], error: null, path: shown, note: EMPTY_NOTE };
  }
  const { text } = readTextCapped(path, MAX_TEXT_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      present: true,
      deployments: [],
      error: `unparseable: ${err instanceof Error ? err.message : String(err)}`,
      path: shown,
      note: null,
    };
  }
  // Either a bare array of records or `{ deployments: [...] }` — accept both
  // rather than guess which shape the eventual writer picks.
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" &&
        parsed !== null &&
        Array.isArray((parsed as Record<string, unknown>)["deployments"])
      ? ((parsed as Record<string, unknown>)["deployments"] as unknown[])
      : [];
  return {
    present: true,
    deployments: list.map((d) => maskDeep(d)),
    error: null,
    path: shown,
    note: list.length === 0 ? "the file is present but records no deployments" : null,
  };
}
