/**
 * Sessions tab — the TTL-safe browser (the server reads via raw dir scans,
 * never an evicting store call) and the transcript view. The transcript
 * renders per-kind envelopes: chat bubbles for turns, collapsible tool
 * cards, a metadata gutter (cost / model route / permission chips), and a
 * Raw toggle. Unknown kinds render as generic cards — tolerant-reader
 * contract, never abort on a future kind.
 */

import { api } from "../api.js";
import { clear, collapsible, dot, el, emptyState, jsonPre, skeleton } from "../dom.js";
import { hrefHarness } from "../router.js";
import { clampText, fmtRelativeTime, fmtUsd, ttlCountdown } from "../util.js";

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
        el("td", { class: "num", text: fmtUsd(typeof s.costUsd === "number" ? s.costUsd : null) }),
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
            ["Session", "Name", "Model", "Turns", "Age", "Retention", "Cost"].map((h) =>
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
  if (data.evicted === true || (data.summary && !hasEntries(data))) {
    root.appendChild(summaryCard(data.summary ?? {}));
    return;
  }
  const entries = entriesOf(data);
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

  const feed = el("div", { class: "transcript" });
  for (const entry of entries) feed.appendChild(entryNode(entry));
  root.appendChild(feed);
}

function hasEntries(data) {
  return entriesOf(data).length > 0;
}

function entriesOf(data) {
  if (Array.isArray(data.entries)) return data.entries;
  if (Array.isArray(data.timeline)) return data.timeline;
  if (Array.isArray(data.events)) return data.events;
  return [];
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

const GUTTER_KINDS = new Set([
  "cost_accrual",
  "model_route",
  "model_meta",
  "permission",
  "permission_decision",
  "tool_stats",
  "mcp_stats",
  "user_feedback",
  "recovery",
]);

function entryNode(entry) {
  const kind = String(entry.kind ?? entry.type ?? "event");
  if (kind === "turn" || kind === "message" || kind === "chat") {
    const role = String(entry.role ?? "assistant");
    return el("div", { class: `bubble bubble-${role === "user" ? "user" : "agent"}` }, [
      el("div", { class: "bubble-role", text: role }),
      el("div", { class: "bubble-body", text: contentText(entry) }),
    ]);
  }
  if (kind === "tool_use" || kind === "tool" || kind === "tool_result") {
    const name = String(entry.name ?? entry.tool ?? "tool");
    const isError = entry.isError === true || entry.error !== undefined;
    return collapsible(
      [
        el("span", { class: "chip chip-tool", text: name }),
        isError ? dot("bad", "error") : dot("ok", "ok"),
        el("span", { class: "muted tool-summary", text: clampText(inputSummary(entry), 100) }),
      ],
      [jsonPre(entry)],
    );
  }
  if (GUTTER_KINDS.has(kind)) {
    return el("div", { class: "gutter" }, [
      el("span", { class: "chip", text: kind }),
      gutterDetail(kind, entry),
    ]);
  }
  // Unknown/future kind: label it, keep the payload inspectable, move on.
  return collapsible([el("span", { class: "chip", text: kind })], [jsonPre(entry)]);
}

function contentText(entry) {
  if (typeof entry.text === "string") return entry.text;
  if (typeof entry.content === "string") return entry.content;
  if (Array.isArray(entry.content)) {
    return entry.content
      .map((b) =>
        typeof b === "string"
          ? b
          : typeof b?.text === "string"
            ? b.text
            : `[${String(b?.type ?? "block")}]`,
      )
      .join("\n");
  }
  return "";
}

function inputSummary(entry) {
  const input = entry.input ?? entry.args ?? null;
  if (input === null) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function gutterDetail(kind, entry) {
  if (kind === "cost_accrual") {
    const usd = typeof entry.usd === "number" ? entry.usd : entry.costUsd;
    return el("span", { class: "muted", text: fmtUsd(typeof usd === "number" ? usd : null) });
  }
  if (kind === "model_route" || kind === "model_meta") {
    return el("span", {
      class: "mono muted",
      text: String(entry.model ?? entry.route ?? entry.band ?? ""),
    });
  }
  if (kind === "permission" || kind === "permission_decision") {
    const outcome = String(entry.outcome ?? entry.decision ?? "?");
    return dot(outcome === "deny" ? "bad" : outcome === "ask" ? "warn" : "ok", outcome);
  }
  return el("span", { class: "muted", text: clampText(inputSummary(entry) || "", 60) });
}
