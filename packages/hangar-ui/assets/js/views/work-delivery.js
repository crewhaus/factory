/**
 * Work › an item's delivery (#516, #514): the pull request its change became, where the
 * last publish stands, and the workspace the change is made in. The item page and the feed
 * read it from `workspaces.list` and `workspaces.get`; publishing again is `work.publish`.
 *
 * - A pull request is a card: "PR #12 opened: <title>", its state in words beside a mark
 *   (In review, Changes requested, Merged, Merged with changes by a maintainer, Closed
 *   without merging, Reverted), and the checks and the acceptance check as words.
 * - A publish the code host did not confirm says "Checking with GitHub…": Home looks it up.
 * - A publish that did not finish says why, and offers "Retry publishing" only where trying
 *   again can help; otherwise it says to start the item again, so a run makes and checks
 *   the change.
 * - The workspace: its branch, the commit it started from, and each check's result in words.
 *   A check's log and the acceptance check's reasons are shown to a reader with content
 *   access, folded.
 *
 * The models are pure, so the tests read them without a DOM. DOM by `createElement` and
 * `textContent` only.
 */

import { el, statusBadge } from "../dom.js";
import { announce } from "../ui/live.js";
import { createAction } from "../v1.js";

/** The words this part of the page says. */
export const DELIVERY_COPY = Object.freeze({
  delivered: "Delivered",
  workspace: "Workspace",
  checking: "Checking with GitHub…",
  checkingDetail:
    "The last publish was not confirmed by GitHub. Home looks it up before anything is tried again.",
  unfinished: "Publish didn't finish",
  retry: "Retry publishing",
  runAgain:
    "Start the item again: a run makes the change fit, checks it and publishes it. Its pull request is updated, never made twice.",
  published: "Published.",
  notPublished: (message) => `Not published: ${message ?? "something went wrong."}`,
  unconfirmed: "GitHub did not confirm it yet. Home checks again.",
  why: "Why it passed or not",
  noChecks: "This repository declares no checks.",
  hiddenLogs: "Check output is hidden: you can't read this harness's content.",
});

/** Why a publish did not finish, in words, and whether publishing again can help. */
export const PUBLISH_REASONS = Object.freeze({
  nothing_to_publish: { text: "There was no change to publish.", retry: false },
  checks_failed: { text: "A check failed.", retry: false },
  conflicts_with_base: {
    text: "The change conflicts with newer work in the repository.",
    retry: false,
  },
  egress_blocked: {
    text: "The change held something that must not leave this computer.",
    retry: false,
  },
  credential_unavailable: {
    text: "GitHub refused the credential, or none is set for this harness.",
    retry: true,
  },
  not_accepted: { text: "The item is not open.", retry: false },
  already_publishing: { text: "Another publish was running.", retry: true },
  unsupported_host: { text: "GitHub could not be reached.", retry: true },
  gate_failed: {
    text: "The change did not pass its checks or its acceptance check.",
    retry: false,
  },
  over_limits: {
    text: "The change is larger than this repository allows without a person's decision.",
    retry: true,
  },
});

const PR_REF_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}#(\d{1,9})$/;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** A pull request's state in words, with the mark beside it. */
export function pullWord(outcome) {
  switch (outcome?.state) {
    case "merged":
      return outcome.changed === true
        ? { word: "Merged with changes by a maintainer", tone: "ok" }
        : { word: "Merged", tone: "ok" };
    case "closed":
      return { word: "Closed without merging", tone: "off" };
    case "reverted":
      return { word: "Reverted", tone: "warn" };
    case "open":
      return outcome.review === "changes-requested"
        ? { word: "Changes requested", tone: "warn" }
        : { word: "In review", tone: "info" };
    default:
      return { word: "Opened", tone: "info" };
  }
}

const CHECK_WORDS = Object.freeze({
  pass: "Checks passed",
  fail: "A check failed",
  skipped: "No checks required",
  "not-run": "Checks did not run",
});
const ACCEPTANCE_WORDS = Object.freeze({
  pass: "Acceptance check passed",
  fail: "Acceptance check did not pass",
  "not-required": "No acceptance check required",
  "not-run": "Acceptance check did not run",
});

/** A verdict as words: the checks, then the acceptance check. */
export function verdictWords(verdict) {
  if (verdict === null || typeof verdict !== "object") return [];
  return [CHECK_WORDS[verdict.checks], ACCEPTANCE_WORDS[verdict.acceptance]].filter(
    (w) => typeof w === "string",
  );
}

/** A link's address, when it is one a page may open: http or https, nothing else. */
function safeUrl(url) {
  return typeof url === "string" && /^https?:\/\/[^\s]+$/.test(url) ? url : null;
}

const shortSha = (sha) => (typeof sha === "string" && SHA_RE.test(sha) ? sha.slice(0, 12) : null);

/** `crewhaus work publish`, for one item. */
export function publishTwin(wi, hrn) {
  return `crewhaus work publish ${wi} --harness ${hrn}`;
}

/** `crewhaus workspace show`, for one item. */
export function workspaceTwin(wi, hrn) {
  return `crewhaus workspace show ${wi} --harness ${hrn}`;
}

/**
 * What the item delivered, as cards: a pull request with its state and verdict, anything
 * else as its kind and reference. `workspace` is the item's `workspaces.get` answer, or
 * `null` when it has none.
 */
export function deliveredModel(delivered, title, workspace) {
  const attempts = Array.isArray(workspace?.attempts) ? workspace.attempts : [];
  return (Array.isArray(delivered) ? delivered : []).map((d) => {
    const ref = String(d?.ref ?? "");
    const pr = d?.kind === "pr" ? PR_REF_RE.exec(ref) : null;
    if (pr === null) return { kind: "other", text: `${String(d?.kind ?? "")}: ${ref}` };
    const number = Number(pr[1]);
    const outcome = workspace?.outcome?.pr === number ? workspace.outcome : null;
    const made = [...attempts].reverse().find((a) => a?.pr === number && a?.state === "done");
    return {
      kind: "pr",
      title: `PR #${number} opened: ${String(title ?? "")}`,
      ref,
      url: safeUrl(outcome?.url),
      ...pullWord(outcome ?? { state: "open" }),
      verdict: verdictWords(made?.verdict),
    };
  });
}

/**
 * Where the last publish stands, when it is not a pull request in review: `checking`
 * while GitHub has not confirmed it, `unfinished` with why and what to do. `null` otherwise.
 */
export function publishModel(workspace, item, can, hrn) {
  const attempts = Array.isArray(workspace?.attempts) ? workspace.attempts : [];
  const newest = attempts.at(-1);
  if (newest === undefined) return null;
  const wi = String(item?.id ?? workspace?.work ?? "");
  if (newest.state === "unknown" || newest.state === "started" || newest.state === "pushed") {
    return {
      kind: "checking",
      word: DELIVERY_COPY.checking,
      tone: "info",
      detail: DELIVERY_COPY.checkingDetail,
      retry: null,
      twin: workspaceTwin(wi, hrn),
    };
  }
  if (newest.state !== "failed" && newest.state !== "not-done") return null;
  const reason =
    newest.state === "not-done"
      ? { text: "It did not reach GitHub.", retry: true }
      : (PUBLISH_REASONS[newest.code] ?? { text: "Something went wrong.", retry: false });
  const size =
    newest.code === "over_limits" && Number.isSafeInteger(newest.files)
      ? ` It changes ${newest.files} ${newest.files === 1 ? "file" : "files"} and ${newest.lines ?? 0} ${newest.lines === 1 ? "line" : "lines"}.`
      : "";
  const open = item?.state === "open";
  const may = can?.["h.run.submit"] === true;
  return {
    kind: "unfinished",
    word: DELIVERY_COPY.unfinished,
    tone: "warn",
    detail: `${reason.text}${size}`,
    retry:
      reason.retry && open && may
        ? { label: DELIVERY_COPY.retry, op: "work.publish", twin: publishTwin(wi, hrn) }
        : null,
    next: !reason.retry && open ? DELIVERY_COPY.runAgain : null,
    verdict: verdictWords(newest.verdict),
    twin: workspaceTwin(wi, hrn),
  };
}

/** The workspace block: branch, where it started, and each check in words. */
export function workspaceModel(workspace, hrn) {
  if (workspace === null || typeof workspace !== "object") return null;
  const checks = Array.isArray(workspace.checks) ? workspace.checks : [];
  return {
    branch: String(workspace.branch ?? ""),
    state:
      workspace.state === "closed"
        ? workspace.wip === true
          ? "Closed. Unfinished work was kept as a commit on its branch."
          : "Closed. Its branch is kept."
        : "Open",
    base: shortSha(workspace.baseSha),
    head: shortSha(workspace.headSha),
    checks: checks.map((c) => ({
      name: String(c?.name ?? ""),
      word: c?.passed === true ? "Passed" : `Failed (exit ${Number(c?.exit ?? 1)})`,
      tone: c?.passed === true ? "ok" : "bad",
    })),
    hidden: Array.isArray(workspace.hidden) && workspace.hidden.includes("content"),
    reasons: typeof workspace.reasons === "string" ? workspace.reasons : null,
    logs: Array.isArray(workspace.logs)
      ? workspace.logs.map((l) => ({ name: String(l?.name ?? ""), text: String(l?.text ?? "") }))
      : [],
    twin: workspaceTwin(String(workspace.work ?? ""), hrn),
  };
}

/** A feed row's delivery words: its pull request's number, or that GitHub is being asked. */
export function rowDelivery(summary) {
  if (summary === null || typeof summary !== "object") return null;
  const outcome = summary.outcome;
  if (outcome !== undefined && Number.isSafeInteger(outcome?.pr)) {
    return outcome.state === "merged" && outcome.changed === true
      ? `PR #${outcome.pr}, merged with changes by a maintainer`
      : `PR #${outcome.pr}`;
  }
  if (summary.publish === "unknown") return DELIVERY_COPY.checking;
  return null;
}

function twinLine(command) {
  if (typeof command !== "string" || command === "") return null;
  return el("div", { class: "twin" }, [
    el("span", { class: "twin-label", text: "CLI" }),
    el("code", { class: "twin-cmd", tabindex: "0", text: command }),
  ]);
}

function folded(summary, text) {
  return el("details", { class: "work-fold" }, [
    el("summary", { text: summary }),
    el("pre", { class: "prewrap mono", text }),
  ]);
}

/**
 * The item page's Delivered and Workspace sections. `after(answer, words)` is the page's
 * own redraw after an action; `ref` is the item's `<harness>/work/<wi>`.
 */
export function deliverySections({ delivered, publish, workspace, ref, after }) {
  const out = [];
  if (delivered.length > 0 || publish !== null) {
    const status = el("p", { class: "muted", role: "status", "aria-live": "polite" });
    const cards = el(
      "ul",
      { class: "work-cards" },
      delivered.map((card) =>
        card.kind === "pr"
          ? el("li", { class: "work-card" }, [
              el("p", {}, [
                card.url !== null
                  ? el("a", { href: card.url, rel: "noopener noreferrer", text: card.title })
                  : el("span", { text: card.title }),
                " ",
                statusBadge(card.tone, card.word),
              ]),
              card.verdict.length > 0
                ? el("p", { class: "muted", text: card.verdict.join(" · ") })
                : null,
            ])
          : el("li", { class: "work-card", text: card.text }),
      ),
    );
    const section = el("section", { class: "work-text", "aria-label": DELIVERY_COPY.delivered }, [
      el("h3", { text: DELIVERY_COPY.delivered }),
      delivered.length > 0 ? cards : null,
    ]);
    if (publish !== null) {
      const row = el("div", { class: "work-action" }, [
        el("p", {}, [statusBadge(publish.tone, publish.word)]),
        el("p", { text: publish.detail }),
        publish.verdict !== undefined && publish.verdict.length > 0
          ? el("p", { class: "muted", text: publish.verdict.join(" · ") })
          : null,
        publish.next !== undefined && publish.next !== null
          ? el("p", { text: publish.next })
          : null,
      ]);
      if (publish.retry !== null) {
        const button = el("button", {
          class: "btn btn-primary",
          type: "button",
          text: publish.retry.label,
        });
        button.addEventListener("click", async () => {
          button.disabled = true;
          const done = await createAction(publish.retry.op, { params: { ref } }).run({ body: {} });
          button.disabled = false;
          const receipt = done.ok ? done.body?.receipt : undefined;
          if (receipt?.state === "succeeded") {
            await after(done, DELIVERY_COPY.published);
            return;
          }
          status.textContent =
            receipt?.state === "unknown"
              ? DELIVERY_COPY.unconfirmed
              : DELIVERY_COPY.notPublished(done.ok ? done.body?.problem : done.error?.message);
          announce(status.textContent);
        });
        row.append(button, " ", twinLine(publish.retry.twin));
      }
      section.append(row, status);
    }
    out.push(section);
  }
  if (workspace !== null) {
    out.push(
      el("section", { class: "work-text", "aria-label": DELIVERY_COPY.workspace }, [
        el("h3", { text: DELIVERY_COPY.workspace }),
        el("dl", { class: "kv" }, [
          el("dt", { text: "Branch" }),
          el("dd", {}, [el("code", { text: workspace.branch })]),
          el("dt", { text: "State" }),
          el("dd", { text: workspace.state }),
          workspace.base !== null
            ? [
                el("dt", { text: "Started from" }),
                el("dd", {}, [el("code", { text: workspace.base })]),
              ]
            : null,
          workspace.head !== null
            ? [
                el("dt", { text: "Last commit" }),
                el("dd", {}, [el("code", { text: workspace.head })]),
              ]
            : null,
        ]),
        el("h4", { text: "Checks" }),
        workspace.checks.length === 0
          ? el("p", { class: "muted", text: DELIVERY_COPY.noChecks })
          : el(
              "ul",
              {},
              workspace.checks.map((c) =>
                el("li", {}, [statusBadge(c.tone, c.word), " ", el("code", { text: c.name })]),
              ),
            ),
        workspace.hidden ? el("p", { class: "muted", text: DELIVERY_COPY.hiddenLogs }) : null,
        workspace.reasons !== null ? folded(DELIVERY_COPY.why, workspace.reasons) : null,
        ...workspace.logs.map((l) => folded(`Output of ${l.name}`, l.text)),
        twinLine(workspace.twin),
      ]),
    );
  }
  return out;
}
