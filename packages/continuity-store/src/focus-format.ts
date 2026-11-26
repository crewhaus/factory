/**
 * How `focus.md` spells its requirements ledger: shared by the store and its erasure, so
 * both read the same lines. Internal to this package.
 */
import { SESSION_ID_PATTERN } from "@crewhaus/control-contract";

/** The line above the requirements ledger. */
export const REQUIREMENTS_MARKER = "<!-- crewhaus:requirements -->";
/** What an empty section says. */
export const NONE_LINE = "_none_";
/** One ledger line: id, status, the text as a JSON string, the session and the turn. */
export const REQ_LINE_REGEX = new RegExp(
  `^- (REQ-\\d{3,}) \\[(open|confirmed|dropped)\\] (".*") \\(user, (${SESSION_ID_PATTERN}), turn (\\d+)\\)$`,
);
