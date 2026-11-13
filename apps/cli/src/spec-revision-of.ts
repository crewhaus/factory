/**
 * The revision `crewhaus run` records for the spec it interprets: `specRevision`
 * of the spec file's text, so a run's `run_stamp` names the spec it ran even
 * when no supervisor stamped one into its environment. `undefined` when the file
 * cannot be read: a revision that is not known is not recorded.
 */
import { readFileSync } from "node:fs";
import { specRevision } from "@crewhaus/ir/policy";

export function specRevisionOf(specPath: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(specPath, "utf8");
  } catch {
    return undefined;
  }
  return specRevision(text);
}
