/**
 * 0.8.0 (design/0.8.0-provability-release.md §6.1, §10; AGENTS.md Pillar 3)
 * — the sink-side screen for a HEAD a provability gate sends OUTSIDE a
 * running loop: the research shape's report gate, which grades the report
 * after every branch's loop has closed, so no loop's screen is there to ask.
 *
 * The URL is one the report names — a destination the model chose, so an
 * `external-dynamic` sink — and it is classified against the lineage of
 * every run context the caller lists (each branch's), folded to the
 * strictest verdict: content a boundary tagged from a non-user origin — a
 * secret a tool read — refuses the request, and the gate sends nothing.
 *
 * There is no "handed verbatim" exemption here: a URL that merely appears
 * in a tool result may be one the model wrote into a tool that echoed it.
 * The one URL let through unclassified is one the caller says was already
 * requested in this run (`sent`) — the research crawler's own GET, which
 * its origin allow-list admitted: a HEAD to it carries nothing new.
 */
import { type EgressMatcher, classifyEgress } from "@crewhaus/egress-classifier";
import type { RunContext } from "@crewhaus/run-context";
import type { GateEgressScreen } from "./index";

/** The sink id a gate HEAD is classified and recorded under (evaluation-service's `RESOLVE_SINK_ID`). */
export const GATE_RESOLVE_SINK_ID = "provability.resolve";

const RANK = { pass: 0, warn: 1, block: 2 } as const;

export type LineageScreenOptions = {
  /** The run contexts whose lineage a URL is screened against, read at each screen. */
  readonly contexts: () => Iterable<RunContext>;
  /** A URL already requested in this run (by a fetch the run's own guard admitted). */
  readonly sent?: (url: string) => boolean;
  /** The run's egress matcher (default: egress-classifier's substring matcher). */
  readonly matcher?: EgressMatcher;
};

/** The screen (see the module doc): `(url) => verdict`, never a throw for a clean URL. */
export function lineageEgressScreen(
  opts: LineageScreenOptions,
): (url: string) => Promise<GateEgressScreen> {
  return async (url) => {
    if (opts.sent?.(url) === true) {
      return { verdict: "pass", sinkScope: "external-dynamic", originsFound: [], matchCount: 0 };
    }
    let verdict: GateEgressScreen["verdict"] = "pass";
    const origins = new Set<string>();
    let matchCount = 0;
    for (const ctx of opts.contexts()) {
      const screened = await classifyEgress(url, ctx, {
        sinkId: GATE_RESOLVE_SINK_ID,
        sinkScope: "external-dynamic",
        ...(opts.matcher !== undefined ? { matcher: opts.matcher } : {}),
      });
      if (RANK[screened.verdict] > RANK[verdict]) verdict = screened.verdict;
      for (const origin of screened.originsFound) origins.add(origin);
      matchCount += screened.matchCount;
    }
    return { verdict, sinkScope: "external-dynamic", originsFound: [...origins], matchCount };
  };
}
