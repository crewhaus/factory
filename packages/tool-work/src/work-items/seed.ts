/**
 * What a run started for a work item is first told, and where an adopted continuity goal's
 * words come from.
 *
 * The seed is a fixed template plus the item's latest title, goal and criteria, but only
 * the fields whose recorded origin is `api`: the run's input is classified at `api` when
 * it enters the run, which is then their true origin. A field written through another
 * origin (the harness's own words, an adopted task) is never copied into the seed: the
 * seed names the item and asks the run to read it with `WorkGet`, which classifies each
 * field at its own origin. A harness whose spec lists no Work tool cannot read it, so such
 * an item cannot be started that way (`work_tools_absent`).
 */
import { join } from "node:path";
import { createContinuityStore } from "@crewhaus/continuity-store";
import type { WorkRevision } from "./records";
import type { AdoptRead, WorkRefusal } from "./store";

export type WorkSeed =
  | { readonly ok: true; readonly input: string }
  | {
      readonly ok: false;
      readonly code: "unsupported";
      readonly reason: "work_tools_absent";
      readonly message: string;
    };

/** The run's first message for item `wi`, from its latest revision. */
export function workSeed(
  wi: string,
  revision: WorkRevision,
  options: { readonly tools: boolean },
): WorkSeed {
  const api = (field: "title" | "goal" | "acceptance"): boolean =>
    revision.fieldOrigins[field] === "api";
  const lines = [`You are working on the work item ${wi} for this harness.`];
  const withheld: string[] = [];
  if (api("title")) lines.push("", `Title: ${revision.title}`);
  else withheld.push("its title");
  if (revision.goal !== undefined) {
    if (api("goal")) lines.push("", "What's asked:", revision.goal);
    else withheld.push("what's asked");
  }
  if (revision.acceptance !== undefined && revision.acceptance.length > 0) {
    if (api("acceptance")) {
      lines.push("", "Done when:", ...revision.acceptance.map((c) => `- ${c}`));
    } else {
      withheld.push("when it is done");
    }
  }
  if (withheld.length > 0 && !options.tools) {
    return {
      ok: false,
      code: "unsupported",
      reason: "work_tools_absent",
      message:
        "This item has text the harness wrote or took in, which only the Work tools read safely. Turn on the Work tools in Setup to start it from here.",
    };
  }
  if (options.tools) {
    lines.push(
      "",
      withheld.length > 0
        ? `Read the item with WorkGet (work: "${wi}") before you start: it holds ${withheld.join(", ")}.`
        : `WorkGet (work: "${wi}") shows the item in full.`,
      `When you finish, close it with WorkUpdate (work: "${wi}", close with outcome done or failed and a reason code), and record what you delivered.`,
    );
  }
  return { ok: true, input: lines.join("\n") };
}

/**
 * The words of one continuity goal of the spec `specName`, as an adoption reads them: its
 * title, at origin `memory` (the harness wrote it). Reads take no lock and create nothing.
 */
export function continuityGoalSource(
  harnessDir: string,
  specName: string | undefined,
  goalId: string,
): AdoptRead {
  return async () => {
    const missing: WorkRefusal = {
      ok: false,
      code: "not_found",
      reason: "goal_unknown",
      message: "This harness has no continuity goal by that id.",
    };
    if (specName === undefined) return missing;
    try {
      const store = createContinuityStore({
        specName,
        rootDir: join(harnessDir, ".crewhaus", "state"),
      });
      const goal = (await store.listGoals()).find((g) => g.id === goalId);
      if (goal === undefined) return missing;
      return { title: goal.title, kind: "request", origin: "memory" };
    } catch {
      return {
        ok: false,
        code: "unavailable",
        reason: "goals_unreadable",
        message: "The harness's goals could not be read.",
      };
    }
  };
}
