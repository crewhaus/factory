/**
 * The run view: one run's events, live, in the console and in the inspector's
 * Timeline (`@crewhaus/hangar-ui/runview`).
 *
 *   mountRunView(root, {harness, run, signal?, header?, now?})
 *
 * A canonical run (`run_` and 26 characters) is read from the versioned API's
 * stream, which resumes after the last event drawn (`Last-Event-ID`) and says
 * when events are missing, replaced or paused. A supervisor execution
 * (`run_` and 16 hex) is read from Home's own run stream, which carries each
 * event's details; a reconnect replays it from the start.
 *
 * A dropped connection is tried again after a doubling wait. Nothing here scrolls
 * while the reader reads older events. The header says the run's state in words,
 * its harness, the spec revision it runs, and its cost so far, or "cost unknown".
 *
 * The modules beside this one are pure (`cards.js`, `adapter.js`, `feed.js`,
 * `stream.js`'s parser) except `feed-dom.js`, which draws.
 */

import { streamRunEvents } from "../api.js";
import { el } from "../dom.js";
import { hrefHarness } from "../router.js";
import { announce as say } from "../ui/live.js";
import { call } from "../v1.js";
import { fromEnvelope, fromLegacy } from "./adapter.js";
import { fmtMicros } from "./cards.js";
import { mountFeed } from "./feed-dom.js";
import {
  announce,
  append,
  connected,
  createFeed,
  disconnected,
  jumpToLatest,
  replayed,
  resumeFrom,
  scrolled,
  setFilter,
  showEarlier,
  view,
} from "./feed.js";
import { openRunStream } from "./stream.js";

export { cardFor, CARD_KINDS, isImportant } from "./cards.js";
export { fromEnvelope, fromLegacy, MARKER_WORDS } from "./adapter.js";
export * as feed from "./feed.js";
export { parseFrames, streamPath } from "./stream.js";

const CANONICAL_RE = /^run_[0-9a-hjkmnp-tv-z]{26}$/;

/** Which stream a run is read from. */
export function sourceFor(run) {
  return CANONICAL_RE.test(String(run)) ? "v1" : "legacy";
}

/** The cost a feed's items add up to, in micro-dollars, or null when none was priced. */
export function costOf(items) {
  let total = null;
  for (const item of items) {
    if (typeof item.costMicros === "number") total = (total ?? 0) + item.costMicros;
  }
  return total;
}

/**
 * The latest state word an item stream gives: its last state or exit card, else
 * "Ended" once the stream has closed, else null (nothing has said yet).
 */
export function stateOf(items) {
  let closed = false;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    const card = item?.card;
    if (card?.kind === "state" || card?.kind === "exit") return String(card.title);
    if (item?.marker === "closed") closed = true;
  }
  return closed ? "Ended" : null;
}

/** A harness as a link names it: its spec name with its id, or its id alone. */
export function harnessLabel(name, id) {
  return typeof name === "string" && name !== "" && name !== id ? `${name} (${id})` : String(id);
}

/** The states after which a run sends nothing more. */
const FINAL_STATES = new Set(["Finished", "Failed", "Cancelled"]);

/** Whether the items say the run has ended. */
export function finished(items) {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const card = items[i]?.card;
    if (card?.kind === "state") return FINAL_STATES.has(String(card.title));
  }
  return false;
}

/** The header: state, harness, spec revision, cost so far. */
function headerNode(opts) {
  const state = el("span", { class: "rv-state", text: "Connecting…" });
  const cost = el("span", { class: "rv-cost", text: "cost unknown" });
  const spec = el("span", { class: "chip mono", hidden: true });
  const node = el("div", { class: "rv-header" }, [
    el("span", { class: "muted", text: "State: " }),
    state,
    " · ",
    el("a", {
      href: hrefHarness(opts.harness),
      text: harnessLabel(opts.harnessName, opts.harness),
    }),
    opts.trigger ? el("span", { class: "muted", text: ` · started by ${opts.trigger}` }) : null,
    " · ",
    spec,
    " · ",
    el("span", { class: "muted", text: "Cost so far: " }),
    cost,
  ]);
  void call("refs.resolve", { params: { ref: `home/harness/${opts.harness}` } }).then((res) => {
    const rev = res.ok ? res.body?.revisions?.spec : undefined;
    if (typeof rev === "string" && rev !== "") {
      spec.hidden = false;
      spec.textContent = `spec ${rev.replace(/^sha256:/, "").slice(0, 12)}`;
      spec.title = rev;
    }
  });
  return {
    node,
    update(items) {
      state.textContent = stateOf(items) ?? "Waiting for events";
      const micros = costOf(items);
      cost.textContent = micros === null ? "cost unknown" : fmtMicros(micros);
    },
  };
}

/** Mount one run's view in `root`. Answers `{close}`; `signal` closes it too. */
export function mountRunView(root, opts) {
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const source = opts.source ?? sourceFor(opts.run);
  let state = createFeed();
  let stream = null;
  let retryTimer = null;
  let announceTimer = null;
  let closed = false;
  const header = headerNode(opts);
  root.append(header.node);
  const dom = mountFeed(root, {
    onFilter: (id) => update((s) => setFilter(s, id)),
    onScrolled: (atBottom) => update((s) => scrolled(s, atBottom)),
    onEarlier: () => update(showEarlier),
    onJump: () => {
      update(jumpToLatest);
      dom.scrollToEnd(true);
    },
    onContinue: () => {
      if (stream === null) connect();
    },
  });
  function update(step) {
    state = step(state);
    dom.draw(view(state));
    header.update(state.items);
  }
  function speak() {
    const out = announce(state, now());
    state = out.state;
    if (out.text !== null) say(out.text);
  }
  function received(items) {
    if (items.length === 0) return;
    update((s) => append(s, items));
    speak();
  }
  function scheduleRetry() {
    if (closed) return;
    state = disconnected(state, now());
    const wait = Math.max(0, (state.retryAt ?? now()) - now());
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, wait);
  }
  function connect() {
    if (closed) return;
    if (source === "v1") {
      let paused = false;
      stream = openRunStream({
        run: opts.run,
        harness: opts.harness,
        lastEventId: resumeFrom(state),
        onFrame: (frame) => {
          state = connected(state);
          const items = fromEnvelope(frame.event, frame.data);
          if (items.some((item) => item.marker === "pause")) paused = true;
          received(items);
        },
        onEnd: (reason) => {
          stream = null;
          // A pause waits for Continue; a refusal is said once; a drop is tried again.
          if (closed || paused || reason === "closed") return;
          if (reason.startsWith("refused:")) {
            received([
              {
                id: null,
                at: null,
                marker: "closed",
                card: {
                  kind: "stream.closed",
                  title:
                    reason === "refused:404"
                      ? "Nothing to show for this run, or you cannot see it."
                      : "This run's events could not be read.",
                  severity: "warn",
                },
              },
            ]);
            return;
          }
          // A run that has ended has nothing more to send; any other end is a drop.
          if (reason === "ended" && finished(state.items)) return;
          scheduleRetry();
        },
      });
      return;
    }
    // Home's own stream replays from the start on every connection.
    stream = streamRunEvents(opts.harness, opts.run, (frame) => {
      if (closed) return;
      if (frame.event === "closed") {
        stream = null;
        if (!(state.items.at(-1)?.marker === "closed")) scheduleRetry();
        return;
      }
      if (frame.event === "error") {
        received([
          {
            id: null,
            at: null,
            marker: "closed",
            card: {
              kind: "stream.closed",
              title: String(frame.data?.message ?? "The stream failed."),
              severity: "warn",
            },
          },
        ]);
        return;
      }
      state = connected(state);
      const items = fromLegacy(frame.event, frame.data);
      // A replay starts the feed over from the first event; the reader stays put.
      if (frame.event === "replay") {
        update((s) => replayed(s, items));
        speak();
        return;
      }
      received(items);
    });
  }
  announceTimer = setInterval(speak, state.options.announceEveryMs);
  const close = () => {
    closed = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    if (announceTimer !== null) clearInterval(announceTimer);
    stream?.close();
    stream = null;
  };
  opts.signal?.addEventListener("abort", close, { once: true });
  dom.draw(view(state));
  connect();
  return { close };
}
