/**
 * A harness's deployments, for Home's Deploy view: the deployment records crewhaus keeps
 * (`.crewhaus/run/control/deployments.jsonl`, written by compile and activation), newest
 * first, then every row of `.crewhaus/deployments.json`, which crewhaus reads but did not
 * record, labelled unverified. Read-only, masked.
 */
import { existsSync } from "node:fs";
import { readDeployments } from "@crewhaus/control-records";
import { MAX_TEXT_BYTES } from "./constants";
import { readTextCapped } from "./jsonl";
import { maskDeep } from "./mask";
import { resolveInside } from "./safety";

export const DEPLOYMENTS_FILENAME = "deployments.json";

/** One row of the view: a record crewhaus kept, or one it only read. */
export type DeploymentRow = {
  /** True for a record crewhaus wrote; false for a row of `.crewhaus/deployments.json`. */
  readonly verified: boolean;
  /** Where the row was read, relative to the harness. */
  readonly source: string;
  readonly record: unknown;
};

export type DeploymentsView = {
  /** False when neither source holds anything. */
  readonly present: boolean;
  /** The kept records (newest first), then the unverified rows; masked. */
  readonly deployments: readonly DeploymentRow[];
  /** Set when a source exists but could not be read. */
  readonly error: string | null;
  /** The legacy file consulted, so an operator can see where to look. */
  readonly path: string;
  /** Why the list is empty, or what the unverified rows are. */
  readonly note: string | null;
  /** The verb that activates a prepared build. */
  readonly verb: string;
};

const RECORDS_SOURCE = ".crewhaus/run/control/deployments.jsonl";
const LEGACY_SOURCE = `.crewhaus/${DEPLOYMENTS_FILENAME}`;
const ACTIVATE_VERB = "crewhaus deploy activate";

const EMPTY_NOTE =
  "No deployments yet. Compile the harness to prepare one, then activate it (crewhaus deploy activate).";
const LEGACY_NOTE =
  "Rows from .crewhaus/deployments.json were not recorded by crewhaus and are shown unverified.";

/** The legacy file's rows, or why they could not be read. */
function legacyRows(harnessDir: string): {
  readonly rows: unknown[];
  readonly error: string | null;
  readonly present: boolean;
} {
  const path = resolveInside(harnessDir, [".crewhaus", DEPLOYMENTS_FILENAME]);
  if (path === undefined || !existsSync(path)) return { rows: [], error: null, present: false };
  const { text } = readTextCapped(path, MAX_TEXT_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      rows: [],
      error: `unparseable: ${err instanceof Error ? err.message : String(err)}`,
      present: true,
    };
  }
  // Either a bare array of records or `{ deployments: [...] }`.
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" &&
        parsed !== null &&
        Array.isArray((parsed as Record<string, unknown>)["deployments"])
      ? ((parsed as Record<string, unknown>)["deployments"] as unknown[])
      : [];
  return { rows: list, error: null, present: true };
}

/** Read a harness's deployments. Absence is an ordinary state. */
export function deploymentsView(harnessDir: string): DeploymentsView {
  const shown = `${harnessDir}/${LEGACY_SOURCE}`;
  const kept = readDeployments(harnessDir);
  const legacy = legacyRows(harnessDir);
  const rows: DeploymentRow[] = [];
  if (kept.state === "present") {
    for (const record of [...kept.records].reverse()) {
      rows.push({ verified: true, source: RECORDS_SOURCE, record: maskDeep(record) });
    }
  }
  for (const record of legacy.rows) {
    rows.push({ verified: false, source: LEGACY_SOURCE, record: maskDeep(record) });
  }
  const error =
    kept.state === "unreadable"
      ? `the deployment records can't be read: ${kept.reason}`
      : legacy.error;
  return {
    present: kept.state === "present" || legacy.present,
    deployments: rows,
    error,
    path: shown,
    note: rows.length === 0 ? EMPTY_NOTE : legacy.rows.length > 0 ? LEGACY_NOTE : null,
    verb: ACTIVATE_VERB,
  };
}
