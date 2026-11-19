/**
 * Both of a run's streams as one stream of items the run view draws. Pure: no DOM.
 *
 *   fromLegacy(event, data) → items   Home's own run stream: `replay`, `state`,
 *                                     `output`, `exit`, `done`
 *   fromEnvelope(type, envelope) → items   the versioned API's run stream: run
 *                                     states, `run.trace`, and the stream's own
 *                                     `stream.gap`, `stream.reset`, `stream.pause`
 *
 * An item is `{id, at, card, marker?, resumeFrom?, costMicros?}`. `id` is the stream's cursor
 * just past the item (`null` on the legacy stream, which has none): the view
 * resumes from the last one it drew and drops an item whose `id` it already has.
 * `marker` names what a stream says about itself: `gap`, `reset`, `pause`,
 * `closed`, `replayed`.
 */

import { exitBanner, ledgerExit } from "../supervision.js";
import { cardFor } from "./cards.js";

/** What a stream's own frames say, in words. */
export const MARKER_WORDS = Object.freeze({
  evicted: "Events are missing here: removed by retention",
  unreadable: "Events are missing here: unreadable",
  withheld: "Events are missing here: not shown to you",
  reset: "This history was replaced (copied or restored). Showing it from the start.",
  pause: "Paused after a long stretch of events.",
  execution: "This run went on in a new process. Continue to follow it.",
  closed: "The stream ended.",
  signedOut: "You were signed out. Sign in again to keep watching.",
});

/** A run state, in words. */
const STATE_WORDS = Object.freeze({
  "run.queued": ["Waiting to start", "info"],
  "run.preparing": ["Getting ready", "info"],
  "run.started": ["Running", "notice"],
  "run.waiting": ["Waiting for someone", "notice"],
  "run.paused": ["Paused", "notice"],
  "run.interrupted": ["Interrupted", "warn"],
  "run.succeeded": ["Finished", "notice"],
  "run.failed": ["Failed", "error"],
  "run.cancelled": ["Cancelled", "warn"],
});

function marker(kind, title, extra = {}) {
  return {
    id: extra.id ?? null,
    at: extra.at ?? null,
    marker: kind,
    card: { kind: `stream.${kind}`, title, severity: kind === "gap" ? "warn" : "notice" },
    ...(extra.resumeFrom !== undefined ? { resumeFrom: extra.resumeFrom } : {}),
  };
}

function eventItem(event, id = null) {
  const at = typeof event?.timestamp === "string" ? event.timestamp : null;
  const micros =
    event?.kind === "cost_accrual" && typeof event.costUsdMicros === "number"
      ? { costMicros: event.costUsdMicros }
      : {};
  return { id, at, card: cardFor(event), ...micros };
}

/** A banner's dot as a card severity: a clean end is a notice, never a problem. */
const EXIT_SEVERITY = Object.freeze({ off: "notice", warn: "warn", bad: "error" });

const capitalized = (text) => (text === "" ? text : text[0].toUpperCase() + text.slice(1));

/**
 * How a process ended (`exitBanner`'s model) as one card: its title, what kind of
 * failure it was, its exit code, whether it restarts on its own, and the fix.
 */
export function exitItem(banner) {
  const parts = [
    banner.classLabel !== null ? capitalized(String(banner.classLabel)) : null,
    banner.exitCode !== null ? `Exit code ${banner.exitCode}` : null,
    banner.signal !== null ? `Signal ${banner.signal}` : null,
    banner.restartable ? "Restarts on its own" : "Will not auto-restart",
  ].filter((part) => part !== null && part !== "");
  return {
    id: null,
    at: null,
    card: {
      kind: "exit",
      title: capitalized(String(banner.title)),
      severity: EXIT_SEVERITY[banner.dot] ?? "error",
      sub: parts.join(" · "),
      ...(banner.remediation !== null
        ? { children: [{ label: "Fix", text: capitalized(String(banner.remediation)) }] }
        : {}),
    },
  };
}

/** Printed output as one item: its non-empty lines. */
function outputItem(prose) {
  const lines = String(prose ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "");
  if (lines.length === 0) return null;
  return {
    id: null,
    at: null,
    card: {
      kind: "output",
      title: "What it printed",
      severity: "notice",
      children: [{ label: "Output", text: lines.join("\n") }],
    },
  };
}

/** One frame of Home's own run stream → items. */
export function fromLegacy(event, data) {
  const d = data !== null && typeof data === "object" ? data : {};
  switch (event) {
    case "replay": {
      const events = Array.isArray(d.events) ? d.events : [];
      const items = [
        marker(
          "replayed",
          `Showing ${events.length} recorded event${events.length === 1 ? "" : "s"}${
            d.eventsTruncated === true ? "; older ones were not kept here" : ""
          }`,
        ),
        ...events.map((e) => eventItem(e)),
      ];
      const tail = outputItem(Array.isArray(d.proseTail) ? d.proseTail.join("\n") : "");
      if (tail !== null) items.push(tail);
      // The `exit` frame only arrives live: a run that already ended says how from its
      // ledger row; one still running says so.
      const ended =
        d.entry !== null && typeof d.entry === "object" ? exitBanner(ledgerExit([d.entry])) : null;
      if (ended !== null) items.push(exitItem(ended));
      else if (d.live === true) {
        items.push({
          id: null,
          at: null,
          card: { kind: "state", title: "Running", severity: "notice" },
        });
      }
      return items;
    }
    case "output": {
      const items = [];
      const prose = outputItem(d.prose);
      if (prose !== null) items.push(prose);
      for (const e of Array.isArray(d.events) ? d.events : []) items.push(eventItem(e));
      return items;
    }
    case "state": {
      const state = typeof d.snapshot?.state === "string" ? d.snapshot.state : "unknown";
      return [
        { id: null, at: null, card: { kind: "state", title: `Now ${state}`, severity: "notice" } },
      ];
    }
    case "exit": {
      const banner = exitBanner(d.classification);
      return banner !== null
        ? [exitItem(banner)]
        : [
            {
              id: null,
              at: null,
              card: { kind: "exit", title: "The process exited", severity: "notice" },
            },
          ];
    }
    case "done":
      return [marker("closed", MARKER_WORDS.closed)];
    default:
      return [];
  }
}

/** One frame of the versioned API's run stream → items. */
export function fromEnvelope(type, envelope) {
  const env = envelope !== null && typeof envelope === "object" ? envelope : {};
  const id = typeof env.id === "string" ? env.id : null;
  const at = typeof env.at === "string" ? env.at : null;
  const payload = env.payload !== null && typeof env.payload === "object" ? env.payload : {};
  if (type === "stream.gap") {
    const words = MARKER_WORDS[payload.reason] ?? MARKER_WORDS.unreadable;
    return [marker("gap", words, { id, at })];
  }
  if (type === "stream.reset") return [marker("reset", MARKER_WORDS.reset, { id, at })];
  if (type === "stream.pause") {
    const words = payload.reason === "execution" ? MARKER_WORDS.execution : MARKER_WORDS.pause;
    return [
      marker("pause", words, {
        id,
        at,
        resumeFrom: typeof payload.resumeFrom === "string" ? payload.resumeFrom : id,
      }),
    ];
  }
  if (type === "auth.expired" || type === "auth.revoked") {
    return [marker("closed", MARKER_WORDS.signedOut, { id, at })];
  }
  if (type === "run.trace") {
    const kind = typeof payload.traceKind === "string" ? payload.traceKind : "unknown";
    return [{ id, at, card: cardFor({ kind }) }];
  }
  if (Object.hasOwn(STATE_WORDS, type)) {
    const [title, severity] = STATE_WORDS[type];
    const failure =
      typeof payload.failureClass === "string" ? { sub: `Why: ${payload.failureClass}` } : {};
    return [{ id, at, card: { kind: "state", title, severity, ...failure } }];
  }
  return [
    {
      id,
      at,
      card: { kind: String(type), title: `Other event (${String(type)})`, severity: "info" },
    },
  ];
}
