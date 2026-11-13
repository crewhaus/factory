/**
 * Deployments — the builds this harness has prepared and activated, newest first, then any
 * rows of `.crewhaus/deployments.json`, which crewhaus reads but did not record and marks
 * "Not verified".
 *
 * A compile prepares a build; the newest prepared one carries "Activate this build", with
 * its exact CLI twin beside it. Automatic starts run only the active build.
 */

import { api } from "../api.js";
import {
  clear,
  copyBtn,
  dot,
  el,
  emptyState,
  jsonPre,
  scrollRegion,
  skeleton,
  toast,
} from "../dom.js";
import { deploymentRow } from "../supervision.js";

/** The command that activates `dep` in harness `id`: the button's CLI twin. */
export function activateTwin(dep, id) {
  return `crewhaus deploy activate ${dep} --harness ${id}`;
}

/** A kept record as a table row's cells. */
function keptRow(record) {
  const r = record && typeof record === "object" ? record : {};
  const artifact = r.artifact && typeof r.artifact === "object" ? r.artifact : {};
  const state = typeof r.state === "string" ? r.state : "unknown";
  const tone = state === "active" ? "ok" : state === "prepared" ? "info" : "off";
  return {
    id: typeof r.id === "string" ? r.id : "",
    state,
    tone,
    env: typeof r.environment === "string" ? r.environment : "—",
    when:
      typeof r.activatedAt === "string"
        ? r.activatedAt
        : typeof r.preparedAt === "string"
          ? r.preparedAt
          : "—",
    digest: typeof artifact.digest === "string" ? artifact.digest : "—",
  };
}

function stateWord(state) {
  switch (state) {
    case "active":
      return "Active";
    case "prepared":
      return "Prepared";
    case "superseded":
      return "Superseded";
    case "disabled":
      return "Disabled";
    case "retired":
      return "Retired";
    default:
      return "Unknown";
  }
}

export async function renderDeploy(root, ctx) {
  clear(root).appendChild(skeleton(4));
  const view = await api.deployments(ctx.id);
  clear(root);
  if (view === null) {
    root.appendChild(emptyState("Nothing here yet — no deployment records"));
    return;
  }
  const nowMs = Date.now();
  const rows = Array.isArray(view.deployments) ? view.deployments : [];
  const path = typeof view.path === "string" ? view.path : "";

  if (view.error !== null && view.error !== undefined) {
    root.appendChild(
      el("div", { class: "card error-card" }, [
        el("h3", { class: "card-title" }, [dot("bad", "Deployments can't be read")]),
        el("p", { class: "muted", text: String(view.error) }),
      ]),
    );
  }

  if (rows.length === 0) {
    root.appendChild(
      el("div", { class: "card" }, [
        el("h3", { class: "card-title" }, [
          el("span", { text: "Deployments" }),
          dot("off", "nothing recorded"),
        ]),
        emptyState(
          typeof view.note === "string" && view.note !== "" ? view.note : "No deployments yet",
          "crewhaus compile crewhaus.yaml -o dist",
        ),
      ]),
    );
    return;
  }

  const kept = rows.filter((row) => row && row.verified === true);
  const legacy = rows.filter((row) => row && row.verified !== true);
  const newestPrepared = kept.find((row) => keptRow(row.record).state === "prepared");

  if (kept.length > 0) {
    const tbody = el("tbody");
    for (const row of kept) {
      const cells = keptRow(row.record);
      const action =
        row === newestPrepared && cells.id !== ""
          ? activateControl(root, ctx, cells.id)
          : el("span", { class: "muted", text: "—" });
      tbody.appendChild(
        el("tr", null, [
          el("td", { class: "mono", text: cells.id }),
          el("td", null, [dot(cells.tone, stateWord(cells.state))]),
          el("td", { text: cells.env }),
          el("td", { class: "mono", text: cells.when }),
          el("td", { class: "mono", text: cells.digest }),
          el("td", null, [action]),
        ]),
      );
    }
    root.appendChild(
      scrollRegion("Deployments", [
        el("table", { class: "fleet" }, [
          el(
            "thead",
            null,
            el(
              "tr",
              null,
              ["Deployment", "State", "Environment", "When", "Build", "Action"].map((h) =>
                el("th", { text: h }),
              ),
            ),
          ),
          tbody,
        ]),
      ]),
    );
  }

  if (legacy.length > 0) {
    const tbody = el("tbody");
    for (const row of legacy) {
      const cells = deploymentRow(row.record, nowMs);
      tbody.appendChild(
        el("tr", null, [
          el("td", { text: cells.env }),
          el("td", null, [el("span", { class: "chip", text: cells.klass })]),
          el("td", { class: "mono", text: cells.provider ?? "—" }),
          el("td", { class: "mono", text: cells.version ?? "—" }),
          el("td", { text: cells.when }),
          el("td", null, [
            dot(cells.dot, cells.healthLabel),
            el("span", { text: " Not verified" }),
          ]),
        ]),
      );
    }
    root.appendChild(
      el("div", { class: "card" }, [
        el("p", { class: "muted", text: typeof view.note === "string" ? view.note : "" }),
        scrollRegion("Unverified deployments", [
          el("table", { class: "fleet" }, [
            el(
              "thead",
              null,
              el(
                "tr",
                null,
                ["Env", "Class", "Provider", "Version", "When", "Health"].map((h) =>
                  el("th", { text: h }),
                ),
              ),
            ),
            tbody,
          ]),
        ]),
      ]),
    );
  }

  root.appendChild(
    el("details", { class: "fold" }, [
      el("summary", { class: "fold-summary" }, [
        el("span", { class: "muted", text: `raw records — ${path}` }),
      ]),
      el("div", { class: "fold-body" }, [jsonPre(rows)]),
    ]),
  );
}

/** "Activate this build", with its CLI twin. */
function activateControl(root, ctx, dep) {
  const command = activateTwin(dep, ctx.id);
  const button = el("button", {
    class: "btn btn-primary",
    type: "button",
    text: "Activate this build",
    "aria-label": `Activate build ${dep}`,
    onclick: async () => {
      button.disabled = true;
      try {
        const res = await api.deploymentActivate(ctx.id, dep, {});
        if (res && res.ok === true) {
          toast(`Activated ${dep}`, "info");
          await renderDeploy(root, ctx);
          return;
        }
        const body = res && typeof res.body === "object" && res.body !== null ? res.body : {};
        toast(typeof body.message === "string" ? body.message : "The build was not activated");
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err));
      } finally {
        button.disabled = false;
      }
    },
  });
  return el("div", { class: "twin" }, [
    button,
    el("code", { class: "mono", text: command }),
    copyBtn(command),
  ]);
}
