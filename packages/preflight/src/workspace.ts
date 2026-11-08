/**
 * The `workspace` area: where the harness directory sits. A harness's tools
 * work inside its directory, so a harness gets a directory of its own, and a
 * start in a directory that holds the home directory asks the operator to say
 * so. The finding is acknowledgeable, one start at a time.
 */

import { homeHeldBy } from "@crewhaus/tool-safety/fs";
import type { PreflightEnv, PreflightItem } from "./types";

export function workspaceItems(harnessDir: string, env: PreflightEnv): PreflightItem[] {
  if (homeHeldBy(harnessDir, env) === undefined) return [];
  return [
    {
      id: "workspace.holds-home",
      area: "workspace",
      level: "blocking",
      message: `this harness's directory (${harnessDir}) holds the home directory`,
      remediation: "move the harness into a directory of its own, such as ~/harnesses/<name>",
    },
  ];
}
