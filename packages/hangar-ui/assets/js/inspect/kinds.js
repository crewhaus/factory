/**
 * What the inspector knows about each kind of object a link can name: where the
 * object lives in the console (its home route, which the inspector opens over),
 * a plain name for it, and the tabs it shows. Pure data and pure functions: no
 * DOM, no request, so a test reads every row.
 *
 * The kinds are the ones Home resolves today. A kind Home does not resolve yet
 * answers 501, and the inspector says so in words ({@link answerWords}); an area
 * that starts serving a kind adds its row here.
 */

import { hrefFleet, hrefHarness } from "../router.js";

/** The three tabs every object has; an area adds its own later. */
const SUMMARY = Object.freeze({ id: "summary", label: "Summary" });
const TECHNICAL = Object.freeze({ id: "technical", label: "Technical" });
const TIMELINE = Object.freeze({ id: "timeline", label: "Timeline" });

const BASE_TABS = Object.freeze([SUMMARY, TECHNICAL]);
const RUN_TABS = Object.freeze([SUMMARY, TECHNICAL, TIMELINE]);

/** The harness a ref is about: its id for a harness ref, else its scope. */
export function harnessOfRef(ref) {
  if (ref === null || typeof ref !== "object") return null;
  if (ref.kind === "harness") return ref.id;
  return ref.scope === "home" ? null : ref.scope;
}

/**
 * Each kind: its plain name, where it opens (`homeRoute(ref)`, a hash), and its
 * tabs. `run` and `exec` open on Work › Runs and carry the Timeline (the run
 * view); a decision opens on Overview › Needs you.
 */
export const INSPECT_KINDS = Object.freeze({
  harness: {
    noun: "Harness",
    homeRoute: (ref) => hrefHarness(ref.id),
    tabs: BASE_TABS,
  },
  deployment: {
    noun: "Build",
    homeRoute: (ref) => hrefHarness(ref.scope, "setup", "deployment"),
    tabs: BASE_TABS,
  },
  run: {
    noun: "Run",
    homeRoute: (ref) => hrefHarness(ref.scope, "work", "runs", ref.id),
    tabs: RUN_TABS,
  },
  exec: {
    noun: "Run",
    homeRoute: (ref) => hrefHarness(ref.scope, "work", "runs", ref.id),
    tabs: RUN_TABS,
  },
  decision: {
    noun: "Decision",
    homeRoute: (ref) => hrefHarness(ref.scope, "overview", "needs-you"),
    tabs: BASE_TABS,
  },
  rule: {
    noun: "Standing rule",
    homeRoute: (ref) => hrefHarness(ref.scope, "setup", "security"),
    tabs: BASE_TABS,
  },
  cmd: {
    noun: "Command",
    homeRoute: (ref) =>
      ref.scope === "home" ? hrefFleet("home", "changes") : hrefHarness(ref.scope),
    tabs: BASE_TABS,
  },
  principal: {
    noun: "Person",
    homeRoute: () => hrefFleet("people"),
    tabs: BASE_TABS,
  },
  evalrun: {
    noun: "Evaluation run",
    homeRoute: (ref) => hrefHarness(ref.scope, "quality", "results", ref.id),
    tabs: BASE_TABS,
  },
  session: {
    noun: "Conversation",
    homeRoute: (ref) => hrefHarness(ref.scope, "work", "sessions", ref.id),
    tabs: BASE_TABS,
  },
});

/** The row for a kind, or null for one the console does not open yet. */
export function inspectKind(kind) {
  return typeof kind === "string" && Object.hasOwn(INSPECT_KINDS, kind)
    ? INSPECT_KINDS[kind]
    : null;
}

/** A run id from before the canonical form: 8 hex, or base 36 up to 8 characters. */
const OLDER_RUN_RE = /^run_(?:[0-9a-f]{8}|[0-9a-z]{1,8})$/;

/** Whether `id` is an older run's id, one no record may have been kept for. */
export function isOlderRunId(id) {
  return typeof id === "string" && id !== "run_channel" && OLDER_RUN_RE.test(id);
}

/**
 * What the inspector says when a link does not open an object, from the answer
 * `refs.resolve` gave: `{title, detail, candidates?}`.
 */
export function answerWords(ref, answer) {
  const status = typeof answer?.status === "number" ? answer.status : 0;
  const reason = answer?.error?.reason;
  if (status === 404 && ref?.kind === "run" && isOlderRunId(ref?.id)) {
    return {
      title: "Older run: no record of it was kept",
      detail: "Runs from before Home kept a record of each one cannot be opened.",
    };
  }
  if (status === 404 && reason === "unreachable") {
    return {
      title: "This harness's sessions folder is unreachable",
      detail: "Home reads conversations only from a sessions folder inside the harness.",
    };
  }
  if (status === 404 || status === 403) {
    return {
      title: "Nothing here, or you cannot see it",
      detail: "The object may have been removed, or your access does not include it.",
    };
  }
  if (status === 501) {
    return {
      title: "Home does not open these links yet",
      detail: "This kind of object has no page in Home yet.",
    };
  }
  if (status === 422) {
    const found = Array.isArray(answer?.error?.details?.candidates)
      ? answer.error.details.candidates
      : [];
    return {
      title:
        reason === "harness_needed"
          ? "This link does not say which harness it is in"
          : "That id names nothing in this harness",
      detail: found.length > 0 ? "It may be one of these." : "Check the link and try again.",
      candidates: found,
    };
  }
  if (status === 400) {
    return { title: "This is not a link Home reads", detail: "Check the link and try again." };
  }
  return {
    title: "This link could not be opened",
    detail:
      typeof answer?.error?.message === "string" ? answer.error.message : "Home could not answer.",
  };
}

/** The links a `candidates` answer lists: `{label, href}`, one per place the id may be. */
export function candidateLinks(candidates) {
  if (!Array.isArray(candidates)) return [];
  return candidates
    .filter((c) => c !== null && typeof c === "object" && typeof c.ref === "string")
    .map((c) => {
      const kind = inspectKind(c.kind);
      return {
        label: kind !== null ? kind.noun : String(c.kind ?? "Object"),
        ref: c.ref,
        href: `#/i/${c.ref}`,
      };
    });
}

/**
 * What View spec can truthfully say about the spec an object used, from the two
 * answers `refs.resolve` gave: the object's own (`own`) and its harness's
 * (`current`). Only a harness's own answer carries a spec revision today, so for
 * any other object Home does not know which spec it used, and says that rather
 * than guessing it differs.
 *
 * Answers `{words, current: true|false|null}`: `true` when it uses the current
 * spec, `false` when both revisions are known and differ, `null` when Home cannot
 * tell.
 */
export function specAnswer(own, current, { isHarness = false } = {}) {
  if (isHarness) return { words: "This is the harness's current spec.", current: true };
  const rev = (answer) => {
    const value = answer?.ok === true ? answer.body?.revisions?.spec : undefined;
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const used = rev(own);
  const now = rev(current);
  if (used === undefined || now === undefined) {
    return {
      words: "Home does not record which spec this used. You can open the current spec.",
      current: null,
    };
  }
  if (used === now) return { words: "This uses the current spec.", current: true };
  return {
    words: "The spec this used isn't stored. The current spec is different.",
    current: false,
  };
}
