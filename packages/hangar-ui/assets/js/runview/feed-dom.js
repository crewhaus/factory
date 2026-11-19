/**
 * The run view's feed, drawn: the only module of the run view that touches the
 * DOM. It draws what `feed.js`'s `view()` says and tells the reducer what the
 * reader did; it decides nothing itself.
 *
 * - The filter is two buttons that say which is on (`aria-pressed`), never by
 *   colour alone.
 * - The list scrolls inside its own container. It moves to the latest only while
 *   the reader is at the bottom; scrolled up, it stays, and a button says how many
 *   events arrived and jumps to the latest. With reduced motion it jumps without
 *   a smooth scroll.
 * - Each card is a list item: its title, a word for its severity, and what it
 *   holds; details fold away.
 * - A paused stream offers Continue.
 * - A list that shows no events says why: nothing yet, or the filter hides them,
 *   with a button that shows everything.
 * - A button that hides itself while it holds focus hands focus to the list first,
 *   so a keyboard user keeps their place.
 *
 * Built with `el` only.
 */

import { el } from "../dom.js";
import { emptyWords, unreadWords } from "./feed.js";

/** A severity in words, so status never rests on colour. */
const SEVERITY_WORDS = Object.freeze({
  quiet: "",
  info: "",
  notice: "",
  warn: "Warning",
  error: "Problem",
});

/** Whether motion should be kept to a minimum. */
function reducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/** One item → its list entry. */
export function cardNode(item, { onContinue } = {}) {
  const card = item.card ?? {};
  const word = SEVERITY_WORDS[card.severity] ?? "";
  const head = el("div", { class: "rv-head" }, [
    word !== "" ? el("span", { class: `rv-sev rv-sev-${card.severity}`, text: word }) : null,
    el("span", { class: "rv-title", text: String(card.title ?? "") }),
    card.badge !== undefined ? el("span", { class: "chip", text: String(card.badge) }) : null,
    card.meta !== undefined
      ? el("span", { class: "rv-meta muted", text: String(card.meta) })
      : null,
  ]);
  const children = Array.isArray(card.children)
    ? el("details", { class: "rv-more" }, [
        el("summary", { text: "Details" }),
        ...card.children.map((child) =>
          el("div", null, [
            el("strong", { text: `${String(child.label ?? "")}: ` }),
            el("pre", { class: "mono rv-pre", text: String(child.text ?? "") }),
          ]),
        ),
      ])
    : null;
  const resume =
    item.marker === "pause" && typeof onContinue === "function"
      ? el("button", {
          type: "button",
          class: "btn",
          text: "Continue",
          onClick: () => onContinue(item.resumeFrom ?? item.id ?? null),
        })
      : null;
  return el(
    "li",
    {
      class: `rv-card rv-${card.severity ?? "info"}${item.marker !== undefined ? " rv-marker" : ""}`,
      dataset: {
        kind: String(card.kind ?? ""),
        ...(typeof item.id === "string" ? { cursor: item.id } : {}),
      },
    },
    [
      head,
      card.sub !== undefined ? el("div", { class: "rv-sub", text: String(card.sub) }) : null,
      children,
      resume,
    ],
  );
}

/**
 * Mount the feed's frame in `root`. Answers `{draw(view), scrollToEnd()}`. The
 * handlers say what the reader did: `onFilter(id)`, `onScrolled(atBottom)`,
 * `onEarlier()`, `onJump()`, `onContinue(cursor)`.
 */
export function mountFeed(root, handlers) {
  const pressed = (id) => (button) => {
    button.setAttribute("aria-pressed", String(button.dataset.filter === id));
  };
  const filterButtons = ["important", "everything"].map((id) =>
    el("button", {
      type: "button",
      class: "btn btn-ghost",
      dataset: { filter: id },
      "aria-pressed": "false",
      text: id === "important" ? "Important" : "Everything",
      onClick: () => handlers.onFilter(id),
    }),
  );
  const earlier = el("button", {
    type: "button",
    class: "btn btn-ghost rv-earlier",
    text: "Show earlier events",
    onClick: () => handlers.onEarlier(),
  });
  const list = el("ol", { class: "rv-list", "aria-label": "Run events" });
  const emptyText = el("span");
  const showAll = el("button", {
    type: "button",
    class: "btn btn-ghost",
    text: "Show everything",
    onClick: () => handlers.onFilter("everything"),
  });
  const empty = el("p", { class: "muted rv-empty", hidden: true }, [emptyText, " ", showAll]);
  const scroller = el(
    "div",
    { class: "rv-scroll", tabindex: "0", role: "region", "aria-label": "Run events" },
    [earlier, list, empty],
  );
  const jump = el("button", {
    type: "button",
    class: "btn btn-primary rv-jump",
    hidden: true,
    onClick: () => handlers.onJump(),
  });
  const dropped = el("p", { class: "muted rv-dropped", hidden: true });
  root.append(
    el("div", { class: "rv-tools", role: "group", "aria-label": "Show" }, filterButtons),
    dropped,
    scroller,
    jump,
  );
  // Drawn nodes by item key, so the same event, replayed, keeps its node.
  const nodes = new Map();
  let drawing = false;
  /** Hide `node`; when it holds focus, the list takes focus first. */
  const hideKeepingFocus = (node, hide) => {
    if (
      hide &&
      !node.hidden &&
      typeof document !== "undefined" &&
      node.contains(document.activeElement)
    ) {
      scroller.focus({ preventScroll: true });
    }
    node.hidden = hide;
  };
  scroller.addEventListener("scroll", () => {
    if (drawing) return;
    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8;
    handlers.onScrolled(atBottom);
  });
  const scrollToEnd = (smooth = false) => {
    scroller.scrollTo({
      top: scroller.scrollHeight,
      behavior: smooth && !reducedMotion() ? "smooth" : "auto",
    });
  };
  return {
    draw(view) {
      drawing = true;
      filterButtons.forEach(pressed(view.filter));
      hideKeepingFocus(earlier, view.earlier === 0);
      // Each item keeps its node, so an open fold and focus survive a redraw.
      const drawn = new Set();
      const want = view.items.map((item) => {
        const key = typeof item.key === "string" ? item.key : null;
        let node = key === null ? undefined : nodes.get(key);
        if (node === undefined) {
          node = cardNode(item, { onContinue: handlers.onContinue });
          if (key !== null) nodes.set(key, node);
        }
        if (key !== null) drawn.add(key);
        return node;
      });
      for (const key of [...nodes.keys()]) if (!drawn.has(key)) nodes.delete(key);
      const keep = new Set(want);
      for (const child of [...list.children]) if (!keep.has(child)) child.remove();
      want.forEach((node, i) => {
        if (list.children[i] !== node) list.insertBefore(node, list.children[i] ?? null);
      });
      dropped.hidden = view.dropped === 0;
      dropped.textContent =
        view.dropped === 0
          ? ""
          : "Older events are not kept on this page. Reload to see them again.";
      const why = emptyWords(view);
      hideKeepingFocus(empty, why === null);
      emptyText.textContent = why?.text ?? "";
      showAll.hidden = why?.showAll !== true;
      hideKeepingFocus(jump, view.following || view.unread === 0);
      jump.textContent = view.unread === 0 ? "" : unreadWords(view.unread);
      if (view.following) scrollToEnd(false);
      drawing = false;
    },
    scrollToEnd,
  };
}
