/**
 * The daemon verbs: start, stop, restart and drain a harness's process.
 *
 * THE TWIN HAS TO RUN. It is displayed as "the exact command that does the
 * same thing in a terminal", which is the console's whole trust affordance;
 * a twin that fails when pasted is worse than none. `crewhaus daemon` takes
 * the harness POSITIONALLY (`daemon start [<dir|hrn_id>]`) and its flag
 * parser hard-rejects anything it does not know, so `--dir <path>` is not a
 * near-miss — every verb throws on it. And the path is SHELL-QUOTED, the way
 * M2's own twins are (`shutdownReportLines`, `spawn-contracts`): an unquoted
 * `/srv/my harnesses/poly` splits into two arguments and targets the wrong
 * directory. A directory holding a control character shows as `<dir>`.
 * `apps/cli/src/cli-twins.test.ts` checks every twin against the CLI's own
 * verb inventory.
 */
import { twinWord } from "../../twin-word";
import type { MenuActionProvider } from "./types";

export const DAEMON_ACTIONS: readonly MenuActionProvider[] = [
  {
    verb: "start",
    route: "procStart",
    cli: (dir) => `crewhaus daemon start ${twinWord(dir, "<dir>")}`,
    label: (name) => `Start ${name}`,
  },
  {
    verb: "stop",
    route: "procStop",
    cli: (dir) => `crewhaus daemon stop ${twinWord(dir, "<dir>")}`,
    label: (name) => `Stop ${name}`,
  },
  {
    verb: "restart",
    route: "procRestart",
    cli: (dir) => `crewhaus daemon restart ${twinWord(dir, "<dir>")}`,
    label: (name) => `Restart ${name}`,
  },
  {
    verb: "drain",
    route: "procDrain",
    cli: (dir) => `crewhaus daemon drain ${twinWord(dir, "<dir>")}`,
    label: (name) => `Drain ${name}`,
  },
];
