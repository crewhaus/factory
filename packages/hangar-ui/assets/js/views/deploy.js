/**
 * Deployments — the records a harness has written to
 * `.crewhaus/deployments.json`, with their class (local / PaaS / cf-worker)
 * and health.
 *
 * HONESTLY EMPTY IS THE NORMAL ANSWER. Nothing writes that file yet, and the
 * manager deliberately does not invent a writer: a console that "knows"
 * about a deploy it did not perform — and misses every deploy performed from
 * a terminal — is worse than one that says the file is absent and points at
 * where it will appear. So the empty state names the path, not a failure.
 */

import { api } from "../api.js";
import { clear, copyBtn, dot, el, emptyState, jsonPre, skeleton } from "../dom.js";
import { deploymentRow } from "../supervision.js";

export async function renderDeploy(root, ctx) {
  clear(root).appendChild(skeleton(4));
  const view = await api.deployments(ctx.id);
  clear(root);
  if (view === null) {
    root.appendChild(emptyState("Nothing here yet — no deployment records"));
    return;
  }
  const nowMs = Date.now();
  const records = Array.isArray(view.deployments) ? view.deployments : [];
  const path = typeof view.path === "string" ? view.path : "";

  if (view.error !== null && view.error !== undefined) {
    root.appendChild(
      el("div", { class: "card error-card" }, [
        el("h3", { class: "card-title" }, [dot("bad", "deployments.json is unreadable")]),
        el("p", { class: "muted", text: String(view.error) }),
        el("div", { class: "mono muted", text: path }),
      ]),
    );
    return;
  }

  if (records.length === 0) {
    root.appendChild(
      el("div", { class: "card" }, [
        el("h3", { class: "card-title" }, [
          el("span", { text: "Deployments" }),
          dot("off", view.present === true ? "file present, no records" : "nothing recorded"),
        ]),
        emptyState(
          typeof view.note === "string" && view.note !== ""
            ? view.note
            : "No deployment records yet",
        ),
        el("div", { class: "h-dir" }, [
          el("span", { class: "mono muted", title: path, text: path }),
          path !== "" ? copyBtn(path, "copy path") : null,
        ]),
      ]),
    );
    return;
  }

  const tbody = el("tbody");
  for (const record of records) {
    const row = deploymentRow(record, nowMs);
    tbody.appendChild(
      el("tr", null, [
        el("td", { text: row.env }),
        el("td", null, [el("span", { class: "chip", text: row.klass })]),
        el("td", { class: "mono", text: row.provider ?? "—" }),
        el("td", { class: "mono", text: row.version ?? "—" }),
        el("td", { text: row.when }),
        el("td", null, [dot(row.dot, row.healthLabel)]),
        el("td", null, [
          row.url !== null
            ? el("a", { class: "mono", href: row.url, rel: "noreferrer", text: row.url })
            : el("span", { class: "muted", text: "—" }),
        ]),
      ]),
    );
  }
  root.appendChild(
    el("div", { class: "table-scroll" }, [
      el("table", { class: "fleet" }, [
        el(
          "thead",
          null,
          el(
            "tr",
            null,
            ["Env", "Class", "Provider", "Version", "When", "Health", "URL"].map((h) =>
              el("th", { text: h }),
            ),
          ),
        ),
        tbody,
      ]),
    ]),
  );
  root.appendChild(
    el("details", { class: "fold" }, [
      el("summary", { class: "fold-summary" }, [
        el("span", { class: "muted", text: `raw records — ${path}` }),
      ]),
      el("div", { class: "fold-body" }, [jsonPre(records)]),
    ]),
  );
}
