/**
 * The operator controls the command menu can propose: pause and resume new work on a
 * harness. Each runs the versioned API's own control (`controls.pause`,
 * `controls.resume`), with its receipt, and is offered only to a caller who holds
 * `h.control` on that harness. Finishing current work is the daemon provider's `drain`:
 * one verb, one action.
 *
 * The twin is `crewhaus daemon pause|resume <dir>`, the harness given positionally and
 * shell-quoted, as `daemon.ts` builds its twins.
 */
import { twinWord } from "../../twin-word";
import type { MenuActionProvider } from "./types";

export const CONTROL_ACTIONS: readonly MenuActionProvider[] = [
  {
    verb: "pause",
    route: "controls.pause",
    operation: "controls.pause",
    permission: "h.control",
    cli: (dir) => `crewhaus daemon pause ${twinWord(dir, "<dir>")}`,
    label: (name) => `Pause new work on ${name}`,
  },
  {
    verb: "resume",
    route: "controls.resume",
    operation: "controls.resume",
    permission: "h.control",
    cli: (dir) => `crewhaus daemon resume ${twinWord(dir, "<dir>")}`,
    label: (name) => `Resume new work on ${name}`,
  },
];
