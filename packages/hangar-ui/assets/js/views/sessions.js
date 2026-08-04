/**
 * Sessions tab — the TTL-safe browser (the server reads via raw dir scans,
 * never an evicting store call) and the transcript view. The server's
 * transcript envelope is `{ turns, tools, gutter, otherKinds, truncated,
 * lineCount, tornCount }` — pre-sorted per kind with per-item `line`
 * anchors — and this view interleaves the three streams by line into chat
 * bubbles, collapsible tool cards (with the joined result + error flag),
 * and a metadata gutter, plus a Raw toggle. Unknown kinds are tallied
 * server-side in `otherKinds`; the count renders so nothing is silently
 * dropped — tolerant-reader contract.
 */

import { api } from "../api.js";
import { clear, collapsible, dot, el, emptyState, jsonPre, skeleton } from "../dom.js";
import { hrefHarness } from "../router.js";
import {
  clampText,
  fmtRelativeTime,
  fmtUsd,
  interleaveTranscript,
  ttlCountdown,
  usdFromMicros,
} from "../util.js";

export async function renderSessions(root, ctx) {
  if (ctx.route.sessionId !== undefined) {
    await renderTranscript(root, ctx, ctx.route.sessionId);
    return;
  }
  clear(root).appendChild(skeleton(6));
  const data = await api.sessions(ctx.id);
  clear(root);
  const list = Array.isArray(data) ? data : Array.isArray(data?.sessions) ? data.sessions : [];
  if (list.length === 0) {
    root.appendChild(emptyState("No sessions yet", "crewhaus run"));
    return;
  }
  const nowMs = Date.now();
  const tbody = el("tbody");
  for (const s of list) {
    const id = String(s.id ?? s.sessionId ?? "");
    const evicted = s.evicted === true;
    const ttl = evicted
      ? { label: "summary only" }
      : ttlCountdown(s.updatedAt ?? null, nowMs, s.ttlDays ?? undefined);
    tbody.appendChild(
      el("tr", { class: evicted ? "evicted" : null }, [
        el("td", null, [
          el("a", {
            class: "mono name-link",
            href: hrefHarness(ctx.id, "sessions", id),
            text: id,
          }),
          evicted ? el("span", { class: "chip chip-warn", text: "summary only" }) : null,
        ]),
        el("td", { text: s.name ? String(s.name) : "—" }),
        el("td", { class: "mono", text: s.model ? String(s.model) : "—" }),
        el("td", { class: "num", text: String(s.turns ?? s.lastTurnIndex ?? "—") }),
        el("td", { text: fmtRelativeTime(s.updatedAt ?? null, nowMs) }),
        el("td", null, [
          evicted ? dot("off", "evicted") : dot(ttl.expired ? "warn" : "ok", ttl.label),
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
            ["Session", "Name", "Model", "Turns", "Age", "Retention"].map((h) =>
              el("th", { text: h }),
            ),
          ),
        ),
        tbody,
      ]),
    ]),
  );
}

async function renderTranscript(root, ctx, sessionId) {
  clear(root).appendChild(skeleton(8));
  const data = await api.session(ctx.id, sessionId);
  clear(root);
  root.appendChild(
    el("div", { class: "crumb-line" }, [
      el("a", { href: hrefHarness(ctx.id, "sessions"), text: "← sessions" }),
      el("span", { class: "mono muted", text: sessionId }),
    ]),
  );
  if (data === null) {
    root.appendChild(emptyState("Nothing here yet — this session has no readable transcript"));
    return;
  }
  if (data.evicted === true) {
    root.appendChild(
      summaryCard(data.summary && typeof data.summary === "object" ? data.summary : {}),
    );
    return;
  }
  const entries = interleaveTranscript(data);
  if (entries.length === 0) {
    root.appendChild(emptyState("Transcript is empty"));
    return;
  }

  const rawPre = jsonPre(data);
  rawPre.hidden = true;
  const rawBtn = el("button", { class: "btn btn-ghost", type: "button", text: "Raw" });
  rawBtn.addEventListener("click", () => {
    rawPre.hidden = !rawPre.hidden;
    rawBtn.classList.toggle("active", !rawPre.hidden);
  });
  root.appendChild(el("div", { class: "transcript-tools" }, [rawBtn]));
  root.appendChild(rawPre);

  const otherCount = Object.values(
    data.otherKinds && typeof data.otherKinds === "object" ? data.otherKinds : {},
  ).reduce((a, b) => (typeof b === "number" ? a + b : a), 0);
  if (
    data.truncated === true ||
    (typeof data.tornCount === "number" && data.tornCount > 0) ||
    otherCount > 0
  ) {
    root.appendChild(
      el("div", { class: "transcript-meta" }, [
        data.truncated === true
          ? el("span", { class: "chip chip-warn", text: "truncated — long log capped" })
          : null,
        typeof data.tornCount === "number" && data.tornCount > 0
          ? el("span", {
              class: "chip",
              text: `${data.tornCount} torn line${data.tornCount === 1 ? "" : "s"} skipped`,
            })
          : null,
        otherCount > 0
          ? el("span", {
              class: "chip",
              text: `${otherCount} other event${otherCount === 1 ? "" : "s"} (Raw)`,
            })
          : null,
      ]),
    );
  }

  const feed = el("div", { class: "transcript" });
  for (const entry of entries) feed.appendChild(entryNode(entry));
  root.appendChild(feed);
}

function summaryCard(summary) {
  return el("div", { class: "card" }, [
    el("h3", { class: "card-title" }, [
      el("span", { text: "Summarized (transcript expired)" }),
      dot("off", "summary only"),
    ]),
    el("p", { text: summary.outcome ? String(summary.outcome) : "No outcome recorded." }),
    Array.isArray(summary.keyFacts) && summary.keyFacts.length > 0
      ? el(
          "ul",
          null,
          summary.keyFacts.map((f) => el("li", { text: String(f) })),
        )
      : null,
  ]);
}

/** One interleaved entry (see `interleaveTranscript`) → its DOM node. */
function entryNode(entry) {
  if (entry.type === "turn") {
    const role = entry.role === "user" ? "user" : "assistant";
    return el("div", { class: `bubble bubble-${role === "user" ? "user" : "agent"}` }, [
      el("div", { class: "bubble-role", text: role }),
      el("div", { class: "bubble-body", text: String(entry.text ?? "") }),
    ]);
  }
  if (entry.type === "tool") {
    const name = String(entry.name ?? "tool");
    const isError = entry.isError === true;
    return collapsible(
      [
        el("span", { class: "chip chip-tool", text: name }),
        isError ? dot("bad", "error") : dot("ok", "ok"),
        el("span", { class: "muted tool-summary", text: clampText(jsonText(entry.input), 100) }),
      ],
      [jsonPre({ input: entry.input, result: entry.result ?? null })],
    );
  }
  // gutter
  const kind = String(entry.kind ?? "event");
  return el("div", { class: "gutter" }, [
    el("span", { class: "chip", text: kind }),
    gutterDetail(kind, entry.payload),
  ]);
}

function jsonText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function gutterDetail(kind, payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  if (kind === "cost_accrual") {
    return el("span", { class: "muted", text: fmtUsd(usdFromMicros(p.costUsdMicros)) });
  }
  if (kind === "model_route") {
    return el("span", {
      class: "mono muted",
      text: String(p.modelId ?? p.model ?? p.route ?? p.band ?? ""),
    });
  }
  if (kind === "permission") {
    const outcome = String(p.outcome ?? p.decision ?? "?");
    return dot(outcome === "deny" ? "bad" : outcome === "ask" ? "warn" : "ok", outcome);
  }
  return el("span", { class: "muted", text: clampText(jsonText(payload) || "", 60) });
}
