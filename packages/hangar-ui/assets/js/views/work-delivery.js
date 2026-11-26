/**
 * Work › an item's delivery (#516, #514): the pull request its change became, where the
 * last publish stands, and the workspace the change is made in. The item page and the feed
 * read it from `workspaces.list` and `workspaces.get`; publishing again is `work.publish`.
 *
 * - A pull request is a card: "PR #12 opened: <title>", its state in words beside a mark
 *   (In review, Changes requested, Merged, Merged with changes by a maintainer, Closed
 *   without merging, Reverted), and the checks and the acceptance check as words.
 * - A publish the code host did not confirm says "Checking with GitHub…": Home looks it up.
 * - A publish that did not finish says why, from its code and, where the code alone does
 *   not say what to do, its recorded cause: "Retry publishing" only where trying again can
 *   help (GitHub was slow or out of reach), the fix where something here must change, and
 *   otherwise to start the item again, so a run makes and checks the change. A change past
 *   the size limits says where a person decides, and its button says it publishes after that.
 * - The workspace: its branch, the commit it started from, and each declared check's result in
 *   words, "Not run yet" for one with none. A check's log and the acceptance check's reasons
 *   are shown to a reader with content access, folded, wrapping at any width.
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
  noResults: "No check has run on this commit yet.",
  notRunYet: "Not run yet",
  noSandbox: "The checks could not run: this computer has no sandbox for them.",
  sandboxFailed: "The checks could not start in the sandbox.",
  technical: "Technical details",
  afterApproval: "Publish after approval",
  needsYou: "Open Needs you",
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
  unsupported_host: { text: "Home could not publish to this repository.", retry: false },
  gate_failed: {
    text: "The change did not pass its checks or its acceptance check.",
    retry: false,
  },
  over_limits: {
    text: "The change is larger than this repository allows. A person decides whether a change this size goes out: review the request in Needs you, then publish.",
    retry: true,
  },
});

/** Where a change past the size limits is decided. */
export const NEEDS_YOU_ROUTE = "#/home/needs-you?type=approvals";

/** The sandbox remedy, as the engine words it; shown in technical details. */
const NO_SANDBOX_FIX =
  "The checks run your project's code, so they need a sandbox and none is available. Start Docker or Podman and set CREWHAUS_SANDBOX=docker (or podman), or have the owner confirm the agreement line \"Runs your project's checks on this computer\".";

/**
 * A refusal's recorded cause in words: what happened, whether trying again can help, and
 * what to do instead. Only a slow or unreachable code host is worth another try.
 */
export const PUBLISH_WHYS = Object.freeze({
  "git-too-old": {
    text: "This computer's git is too old for workspaces.",
    retry: false,
    fix: "Update git to 2.38 or newer, then publish again.",
  },
  "repository-gone": {
    text: "This item's repository is no longer in the harness's spec.",
    retry: false,
    fix: "Add the repository back to the spec and rebuild the harness, then publish again.",
  },
  "repository-elsewhere": {
    text: "This item's workspace is in another of the harness's repositories.",
    retry: false,
    fix: "Publish it to the repository its workspace is in.",
  },
  "repository-unknown": {
    text: "The repository named is not one this harness delivers to.",
    retry: false,
    fix: "Name one of the repositories in the harness's spec.",
  },
  "repository-ambiguous": {
    text: "This harness delivers to several repositories, and none was named.",
    retry: false,
    fix: "Start the item again and name the repository its change goes to.",
  },
  "host-not-allowed": {
    text: "The code host address in the harness's spec is not one Home may reach.",
    retry: false,
    fix: "Correct the repository's server address in the spec and rebuild the harness.",
  },
  "host-timeout": { text: "GitHub did not answer in time.", retry: true, fix: null },
  "host-unreachable": { text: "GitHub could not be reached.", retry: true, fix: null },
  "host-refused": {
    text: "GitHub refused the request.",
    retry: false,
    fix: "Check the repository and the credential's access on GitHub, then publish again.",
  },
  "clone-settings": {
    text: "This harness's copy of the repository has git settings Home did not make, so nothing was sent.",
    retry: false,
    fix: "A person removes those settings from the copy's config file; the workspace's CLI line shows where it is.",
  },
  "base-missing": {
    text: "The repository has no branch by the name the spec gives as its base.",
    retry: false,
    fix: "Correct the base branch in the spec and rebuild the harness.",
  },
  "base-moved": {
    text: "Newer work landed in the repository since this change was checked.",
    retry: false,
    fix: null,
  },
  "not-judged": { text: "No run has checked this exact change yet.", retry: false, fix: null },
  "no-sandbox": {
    text: "The checks could not run: this computer has no sandbox for them.",
    retry: false,
    fix: null,
    technical: NO_SANDBOX_FIX,
    noRunAgain: true,
  },
  "sandbox-failed": {
    text: "The checks could not start in the sandbox.",
    retry: false,
    fix: "Check that Docker or Podman is running, then start the item again.",
    noRunAgain: true,
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
  // Checks that gave no answer for want of a sandbox: an attempt recorded before causes were.
  const why =
    newest.why ??
    (newest.code === "gate_failed" && newest.verdict?.checks === "not-run" ? "no-sandbox" : null);
  const reason =
    newest.state === "not-done"
      ? { text: "It did not reach GitHub.", retry: true }
      : (PUBLISH_WHYS[why] ??
        PUBLISH_REASONS[newest.code] ?? { text: "Something went wrong.", retry: false });
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const size =
    newest.code !== "over_limits" || !Number.isSafeInteger(newest.files)
      ? ""
      : Number.isSafeInteger(newest.lines)
        ? ` It changes ${count(newest.files, "file", "files")} and ${count(newest.lines, "line", "lines")}.`
        : ` It changes ${count(newest.files, "file", "files")}.`;
  const open = item?.state === "open";
  const may = can?.["h.run.submit"] === true;
  const sizeDecision = newest.state === "failed" && newest.code === "over_limits";
  return {
    kind: "unfinished",
    word: DELIVERY_COPY.unfinished,
    tone: "warn",
    detail: `${reason.text}${size}`,
    retry:
      reason.retry && open && may
        ? {
            label: sizeDecision ? DELIVERY_COPY.afterApproval : DELIVERY_COPY.retry,
            op: "work.publish",
            twin: publishTwin(wi, hrn),
          }
        : null,
    link: sizeDecision ? { href: NEEDS_YOU_ROUTE, text: DELIVERY_COPY.needsYou } : null,
    next:
      typeof reason.fix === "string"
        ? reason.fix
        : !reason.retry && open && reason.noRunAgain !== true
          ? DELIVERY_COPY.runAgain
          : null,
    technical: typeof reason.technical === "string" ? reason.technical : null,
    verdict: verdictWords(newest.verdict),
    twin: workspaceTwin(wi, hrn),
  };
}

/**
 * The workspace block: branch, where it started, and each check in words. A declared check
 * with no result on this commit is "Not run yet"; "declares no checks" only when it declares
 * none.
 */
export function workspaceModel(workspace, hrn) {
  if (workspace === null || typeof workspace !== "object") return null;
  const results = Array.isArray(workspace.checks) ? workspace.checks : [];
  const declared = Array.isArray(workspace.declared) ? workspace.declared.map(String) : null;
  const word = (c) => ({
    name: String(c?.name ?? ""),
    word: c?.passed === true ? "Passed" : `Failed (exit ${Number(c?.exit ?? 1)})`,
    tone: c?.passed === true ? "ok" : "bad",
  });
  const checks =
    declared === null
      ? results.map(word)
      : [
          ...declared.map((name) => {
            const result = results.find((r) => r?.name === name);
            return result !== undefined
              ? word(result)
              : { name, word: DELIVERY_COPY.notRunYet, tone: "off" };
          }),
          ...results.filter((r) => !declared.includes(String(r?.name ?? ""))).map(word),
        ];
  const attempts = Array.isArray(workspace.attempts) ? workspace.attempts : [];
  const newest = attempts.at(-1);
  const unran =
    newest?.why === "sandbox-failed"
      ? DELIVERY_COPY.sandboxFailed
      : newest?.why === "no-sandbox" ||
          (newest?.verdict?.checks === "not-run" && (declared?.length ?? 1) > 0)
        ? DELIVERY_COPY.noSandbox
        : null;
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
    checks,
    empty:
      checks.length > 0
        ? null
        : declared !== null
          ? DELIVERY_COPY.noChecks
          : DELIVERY_COPY.noResults,
    unran,
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

/** A check's log, folded: it wraps at any width, and a long one scrolls in its own region. */
function foldedLog(summary, text) {
  return el("details", { class: "work-fold" }, [
    el("summary", { text: summary }),
    el("pre", { class: "mono", tabindex: "0", role: "region", "aria-label": summary, text }),
  ]);
}

/** Prose, folded: the judge's reasons, a paragraph per blank-line-separated part. */
function foldedProse(summary, text) {
  const parts = String(text)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  return el("details", { class: "work-fold" }, [
    el("summary", { text: summary }),
    ...parts.map((p) => el("p", { text: p })),
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
        publish.link !== undefined && publish.link !== null
          ? el("p", {}, [el("a", { href: publish.link.href, text: publish.link.text })])
          : null,
        publish.technical !== undefined && publish.technical !== null
          ? foldedProse(DELIVERY_COPY.technical, publish.technical)
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
          ? el("p", { class: "muted", text: workspace.empty })
          : el(
              "ul",
              {},
              workspace.checks.map((c) =>
                el("li", {}, [statusBadge(c.tone, c.word), " ", el("code", { text: c.name })]),
              ),
            ),
        workspace.unran !== null ? el("p", { class: "muted", text: workspace.unran }) : null,
        workspace.hidden ? el("p", { class: "muted", text: DELIVERY_COPY.hiddenLogs }) : null,
        workspace.reasons !== null ? foldedProse(DELIVERY_COPY.why, workspace.reasons) : null,
        ...workspace.logs.map((l) => foldedLog(`Output of ${l.name}`, l.text)),
        twinLine(workspace.twin),
      ]),
    );
  }
  return out;
}
