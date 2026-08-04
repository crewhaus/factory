/**
 * Schedulers — the four-lane timeline (heartbeat, schedule, dream, janitor).
 *
 * THE ASYMMETRY IS THE SCREEN. A daemon's schedulers are in-process timers,
 * so the CADENCE is declared in the spec and knowable offline, while the
 * PHASE — last fired, next due — is knowable only inside the process that
 * armed the timer. That is why `crewhaus.control.v1` exists, and why a lane
 * with no reachable control plane says "cadence only" and names the reason
 * instead of leaving a blank that reads as a gap.
 *
 * Two lanes can be poked (control.v1 arms them); dream and janitor are
 * read-only rows that say why. Wake distinguishes `tick_in_flight` (a tick
 * is running — retry) from `draining` (this daemon is going away).
 */

import { api } from "../api.js";
import { clear, collapsible, dot, el, emptyState, jsonPre, skeleton } from "../dom.js";
import { laneModels } from "../supervision.js";
import { controlBtn } from "./control.js";
import { jobButton } from "./jobs.js";

export async function renderSchedulers(root, ctx) {
  clear(root).appendChild(skeleton(5));
  const view = await api.schedulers(ctx.id);
  clear(root);
  if (view === null) {
    root.appendChild(emptyState("Nothing scheduled here yet", "crewhaus daemon start"));
    return;
  }
  const reload = () => renderSchedulers(root, ctx);
  const nowMs = Date.now();
  const lanes = laneModels(view, nowMs);
  const dir = ctx.dir ?? "";

  root.appendChild(
    el("div", { class: "rollup" }, [
      view.controlReachable === true
        ? dot("ok", "control.v1 answered — phase columns are live")
        : dot("off", "no control plane — cadence only"),
      view.controlReachable !== true && typeof view.controlReason === "string"
        ? el("span", { class: "muted", text: view.controlReason })
        : null,
      view.draining === true ? el("span", { class: "chip chip-warn", text: "draining" }) : null,
    ]),
  );

  if (lanes.length === 0) {
    root.appendChild(emptyState("This spec declares no scheduler lanes", "crewhaus compile"));
    return;
  }

  const grid = el("div", { class: "lanes" });
  // The fleet-level reason is already on the line above; repeating it in all
  // four lanes buries the per-lane facts under one sentence said four times.
  const headerReason = typeof view.controlReason === "string" ? view.controlReason : null;
  for (const lane of lanes) grid.appendChild(laneCard(lane, headerReason, ctx, dir, reload));
  root.appendChild(grid);

  if (view.counters && typeof view.counters === "object") {
    root.appendChild(
      collapsible(
        [el("span", { class: "muted", text: "control.v1 counters" })],
        [jsonPre(view.counters)],
      ),
    );
  }
}

function laneCard(lane, headerReason, ctx, dir, reload) {
  const phase = el("div", { class: "lane-phase" }, [
    el("div", { class: "kv" }, [
      el("span", { class: "kv-k", text: "cadence" }),
      el("span", { class: "kv-v" }, [
        el("span", { text: lane.cadence ?? "—" }),
        el("span", { class: "chip", text: `from ${lane.cadenceSource}` }),
      ]),
    ]),
    el("div", { class: "kv" }, [
      el("span", { class: "kv-k", text: "last fired" }),
      el("span", { class: "kv-v" }, [
        el("span", { text: lane.lastFiredLabel }),
        lane.lastOutcome !== null ? el("span", { class: "chip", text: lane.lastOutcome }) : null,
      ]),
    ]),
    el("div", { class: "kv" }, [
      el("span", { class: "kv-k", text: "next due" }),
      el("span", { class: "kv-v" }, [
        el("span", { text: lane.nextDueLabel }),
        // Honest about WHY the phase is missing — never an implied gap. The
        // fleet-level reason is on the header line, so only a LANE-specific
        // one repeats here.
        lane.phaseNote !== null && lane.phaseNote !== headerReason
          ? el("div", { class: "muted reason", text: lane.phaseNote })
          : null,
      ]),
    ]),
  ]);

  const actions = el("div", { class: "lane-actions" });
  if (lane.lane === "heartbeat" || lane.lane === "schedule") {
    actions.appendChild(
      controlBtn(
        "Wake",
        { enabled: lane.pokeable, reason: lane.pokeReason },
        () => api.controlWake(ctx.id, lane.lane, "poked from the Hangar console"),
        { action: "wake", dir, lane: lane.lane },
      ),
    );
  } else if (lane.lane === "dream") {
    // Dream is a read-only timer row in control.v1 — the honest "run now" is
    // the job queue, not a poke.
    actions.appendChild(jobButton("Run now", ctx.id, "dream-run", undefined, reload));
    if (lane.pokeReason !== null) {
      actions.appendChild(el("div", { class: "muted gated-why", text: lane.pokeReason }));
    }
  } else if (lane.pokeReason !== null) {
    actions.appendChild(el("div", { class: "muted gated-why", text: lane.pokeReason }));
  }

  const detailNode =
    lane.detail !== null && typeof lane.detail === "object"
      ? collapsible([el("span", { class: "muted", text: "lane detail" })], [jsonPre(lane.detail)])
      : null;

  return el("section", { class: `card lane-card${lane.armed ? "" : " lane-off"}` }, [
    el("h3", { class: "card-title" }, [el("span", { text: lane.lane }), dot(lane.dot, lane.label)]),
    lane.armed
      ? phase
      : el("p", { class: "muted", text: "the spec declares no such block — absent, not broken" }),
    lane.armed ? actions : null,
    lane.armed ? detailNode : null,
  ]);
}
