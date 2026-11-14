/**
 * Setup › Delegations: what this harness may do on its own under an owner's rules, and
 * until when (#517). Three states: the agreement allows nothing ("Its agreement doesn't
 * allow it."); it allows something and no rule is on; and the rules, each with its state
 * as a word and a mark, its end, its uses and the buttons the caller may press (Pause
 * for a maintainer; Resume, Change and Turn off for an owner).
 *
 * Turning a rule on, changing and resuming one happen on a full page built by the server
 * from closed templates (`delegations.preview`): its sections are shown as text, never
 * markup; the harness's name is typed to confirm, and Turn on stays disabled until it
 * matches; the exact CLI line is shown. A maintainer sees Ask the owner instead; anyone
 * else reads it. A page that changed while it was open is drawn again from the server's
 * answer, keeping the typed name and the focus.
 *
 * Every call goes through `v1.js` by operation id. DOM by `createElement` and
 * `textContent` only. The models below are pure, so the tests read them without a DOM.
 */

import { clear, el, statusBadge } from "../dom.js";
import { hrefHarness } from "../router.js";
import { announce } from "../ui/live.js";
import { call, createAction } from "../v1.js";

/** The words the screen says, in one place. */
export const DELEGATIONS_COPY = Object.freeze({
  notAllowed: "Nothing can be delegated on this harness yet. Its agreement doesn't allow it.",
  allowAgreement: "Allow in the agreement",
  noActions:
    "Merging, rollouts and routine improvements ask a person. Nothing here can be delegated yet.",
  canDelegate:
    "Merging, rollouts and routine improvements ask a person. You can let this harness do some of them on its own, under rules that expire.",
  applied:
    "Rules are applied while Home is running and whenever `crewhaus delegations apply` runs. Otherwise these decisions wait for a person.",
  readOnly: "Only an owner can turn this on. You can read what it would do.",
  typeToConfirm: (name) => `Type ${name} to confirm`,
  changed: "What this means has changed. Read the page again before you confirm.",
});

/** A rule's state as a word, and the mark beside it. Never colour alone. */
export const STATE_WORDS = Object.freeze({
  active: { word: "Active", tone: "ok" },
  suspended: { word: "Paused", tone: "warn" },
  revoked: { word: "Turned off", tone: "off" },
  expired: { word: "Ended", tone: "off" },
  exhausted: { word: "Used up", tone: "off" },
});

/** Why a paused rule is paused, in words. */
export const SUSPEND_WORDS = Object.freeze({
  "paused-by-member": "paused by a maintainer",
  "rolled-back": "a change it made was rolled back",
  "rollback-failed": "a rollback could not finish",
  "owner-authority-changed": "its owner is no longer an owner",
  "policy-changed": "this harness's permissions changed",
  "ceiling-changed": "the agreement's limits changed",
  "host-protection-changed": "the code host's rules changed",
  "capability-lost": "the active build can no longer do this",
});

const ACTIONS = Object.freeze(["merge", "rollout", "adopt", "assistant"]);
const RULE_RE = /^rule_[0-9a-hjkmnp-tv-z]{26}$/;

/**
 * Which page the address names, from the rest of `#/h/<id>/setup/delegations/…`: the
 * list, a new rule for an action, or a rule's resume or change page.
 */
export function routeOf(rest) {
  const parts = Array.isArray(rest) ? rest.map(String) : [];
  if (parts.length === 0) return { page: "list" };
  if (parts.length === 2 && parts[0] === "new" && ACTIONS.includes(parts[1])) {
    return { page: "new", action: parts[1] };
  }
  if (
    parts.length === 2 &&
    RULE_RE.test(parts[0]) &&
    (parts[1] === "resume" || parts[1] === "change")
  ) {
    return { page: "rule", rule: parts[0], mode: parts[1] };
  }
  return { page: "unknown" };
}

/** What the caller may do, as the server said; nothing when it did not say. */
function youOf(list) {
  const you = list && typeof list.you === "object" && list.you !== null ? list.you : {};
  return {
    manage: you.manage === true,
    propose: you.propose === true,
    suspend: you.suspend === true,
  };
}

/**
 * The list as the screen draws it: which of the three states, the sentence that says
 * why, the actions offered, and each rule's row with the buttons the caller may press.
 */
export function listModel(list) {
  const items = Array.isArray(list?.items) ? list.items : [];
  const offers = Array.isArray(list?.offers) ? list.offers : [];
  const you = youOf(list);
  const allowed = list?.ceiling?.present === true;
  const rows = items.map((rule) => {
    const known = STATE_WORDS[rule.state] ?? { word: String(rule.state), tone: "off" };
    const why = rule.state === "suspended" ? SUSPEND_WORDS[rule.suspendedReason] : undefined;
    const buttons = [];
    if (rule.state === "active" && you.suspend) buttons.push("pause");
    if (rule.state === "suspended" && you.manage) buttons.push("resume");
    if (rule.state === "active" && you.manage) buttons.push("change");
    if ((rule.state === "active" || rule.state === "suspended") && you.manage)
      buttons.push("revoke");
    return {
      id: String(rule.id),
      action: String(rule.action),
      label: String(rule.label ?? ""),
      word: why === undefined ? known.word : `${known.word}: ${why}`,
      tone: known.tone,
      ends: String(rule.endsAt ?? ""),
      uses: `${Number(rule.uses ?? 0)}${rule.maxUses !== undefined ? ` of ${Number(rule.maxUses)}` : ""}`,
      buttons,
    };
  });
  const state =
    !allowed && rows.length === 0 ? "not-allowed" : rows.length === 0 ? "empty" : "rules";
  return {
    state,
    sentence:
      state === "not-allowed"
        ? DELEGATIONS_COPY.notAllowed
        : state === "empty"
          ? offers.length === 0
            ? DELEGATIONS_COPY.noActions
            : DELEGATIONS_COPY.canDelegate
          : null,
    // A kind is offered only when the agreement allows it and Home can do it.
    offers: offers.map((offer) => ({
      action: String(offer.action),
      label: String(offer.label),
      verb: String(offer.verb),
    })),
    rows,
    note: DELEGATIONS_COPY.applied,
    you,
  };
}

/** Whether the typed name confirms: exactly the harness's name. */
export function confirms(typed, name) {
  return typeof typed === "string" && typeof name === "string" && name !== "" && typed === name;
}

/**
 * The consequences page as the screen draws it, from the server's own sections: the
 * owner may turn it on once the typed name matches and the page has its digest; a
 * maintainer may ask the owner; anyone else reads it.
 */
export function pageModel(page, you, typed) {
  const sections = Array.isArray(page?.sections) ? page.sections : [];
  const manage = you?.manage === true;
  const name = String(page?.confirmName ?? "");
  return {
    title: String(page?.title ?? ""),
    sections: sections.map((s) => ({
      id: String(s.id),
      heading: String(s.heading ?? ""),
      lines: Array.isArray(s.lines) ? s.lines.map(String) : [],
    })),
    confirmLabel: DELEGATIONS_COPY.typeToConfirm(name),
    confirmName: name,
    canConfirm: manage,
    canTurnOn: manage && confirms(typed, name),
    canAsk: !manage && you?.propose === true,
    readOnly: !manage && you?.propose !== true,
    note: typeof page?.note === "string" ? page.note : null,
    cli: String(page?.verb ?? ""),
  };
}

/** A CLI line, shown and selectable. */
function twin(command) {
  return el("div", { class: "twin" }, [
    el("span", { class: "twin-label", text: "CLI" }),
    el("code", { class: "twin-cmd", tabindex: "0", text: command }),
  ]);
}

function errorLine(error) {
  announce(`Not done: ${String(error?.message ?? "Something went wrong.")}`);
  return el("p", { class: "muted" }, [
    el("span", { "aria-hidden": "true", text: "✗ " }),
    el("strong", { text: "Not done: " }),
    String(error?.message ?? "Something went wrong."),
  ]);
}

async function drawList(root, ctx) {
  const answer = await call("delegations.list", { params: { h: ctx.id } });
  clear(root);
  root.appendChild(el("h2", { text: "Delegations" }));
  if (!answer.ok) {
    root.appendChild(errorLine(answer.error));
    root.appendChild(twin(`crewhaus delegations list --harness ${ctx.id}`));
    return;
  }
  const model = listModel(answer.body);
  root.appendChild(el("p", { class: "muted", text: model.note }));
  if (model.sentence !== null) root.appendChild(el("p", { text: model.sentence }));
  if (model.state === "not-allowed") {
    root.appendChild(
      el("a", {
        class: "btn",
        href: hrefHarness(ctx.id, "setup", "spec"),
        text: DELEGATIONS_COPY.allowAgreement,
      }),
    );
  }
  for (const offer of model.offers) {
    root.appendChild(
      el("p", {}, [
        el("a", {
          class: "btn",
          href: hrefHarness(ctx.id, "setup", "delegations", "new", offer.action),
          text: `Delegate: ${offer.label}`,
        }),
      ]),
    );
  }
  if (model.rows.length > 0) {
    const list = el("ul", { class: "delegation-rules" });
    for (const row of model.rows) list.appendChild(ruleRow(row, ctx, () => drawList(root, ctx)));
    root.appendChild(list);
  }
  root.appendChild(twin(`crewhaus delegations list --harness ${ctx.id}`));
}

const BUTTON_WORDS = Object.freeze({
  pause: "Pause",
  resume: "Resume",
  change: "Change",
  revoke: "Turn off",
});

function ruleRow(row, ctx, redraw) {
  const status = el("p", { class: "muted", role: "status", "aria-live": "polite" });
  const buttons = row.buttons.map((name) => {
    if (name === "resume" || name === "change") {
      return el("a", {
        class: "btn",
        href: hrefHarness(ctx.id, "setup", "delegations", row.id, name),
        text: BUTTON_WORDS[name],
      });
    }
    const button = el("button", { class: "btn", type: "button", text: BUTTON_WORDS[name] });
    const action = createAction(name === "pause" ? "delegations.pause" : "delegations.revoke", {
      params: { h: ctx.id, rule: row.id },
      body: name === "pause" ? { reason: "paused-by-member" } : {},
    });
    button.addEventListener("click", async () => {
      button.disabled = true;
      const answer = await action.run();
      button.disabled = false;
      if (answer.ok) {
        announce(name === "pause" ? "Paused." : "Turned off.");
        await redraw();
        return;
      }
      status.textContent = `Not done: ${answer.error?.message ?? "Something went wrong."}`;
      button.focus();
    });
    return button;
  });
  return el("li", { class: "delegation-rule" }, [
    el("p", {}, [el("strong", { text: row.label })]),
    el("p", {}, [statusBadge(row.tone, row.word)]),
    el("p", { class: "muted", text: `Ends ${row.ends}. Used ${row.uses}.` }),
    buttons.length > 0 ? el("div", { class: "row-actions" }, buttons) : null,
    status,
    twin(
      row.buttons.includes("pause")
        ? `crewhaus delegations pause ${row.id} --harness ${ctx.id}`
        : `crewhaus delegations show ${row.id} --harness ${ctx.id}`,
    ),
  ]);
}

/**
 * The consequences page: drawn from the server's answer, with the typed name and the
 * focus kept when a changed page is drawn again.
 */
async function drawPage(root, ctx, route) {
  const list = await call("delegations.list", { params: { h: ctx.id } });
  const you = list.ok ? youOf(list.body) : {};
  const rule =
    route.page === "rule" && list.ok && Array.isArray(list.body?.items)
      ? list.body.items.find((item) => item.id === route.rule)
      : undefined;
  const action = route.page === "new" ? route.action : rule?.action;
  const ask = (body) => call("delegations.preview", { params: { h: ctx.id }, body });
  let days;
  const previewBody = () => ({
    ...(route.page === "rule" ? { action, rule: route.rule, mode: route.mode } : { action }),
    ...(days !== undefined && route.mode !== "resume" ? { terms: { days } } : {}),
  });
  let answer =
    action === undefined
      ? { ok: false, error: { message: "This rule is not here." } }
      : await ask(previewBody());
  let typed = "";
  let digest = answer.ok ? answer.body.consequencesDigest : undefined;
  const write =
    route.page === "new"
      ? createAction("delegations.enable", { params: { h: ctx.id } })
      : route.mode === "resume"
        ? createAction("delegations.resume", { params: { h: ctx.id, rule: route.rule } })
        : createAction("delegations.update", { params: { h: ctx.id, rule: route.rule } });
  const proposeAction = createAction("delegations.propose", { params: { h: ctx.id } });

  const draw = (notice, keepFocus) => {
    clear(root);
    if (!answer.ok) {
      root.appendChild(el("h2", { text: "Delegations" }));
      root.appendChild(errorLine(answer.error));
      root.appendChild(
        el("a", { href: hrefHarness(ctx.id, "setup", "delegations"), text: "Back to Delegations" }),
      );
      return;
    }
    const model = pageModel(answer.body, you, typed);
    const heading = el("h2", { tabindex: "-1", text: model.title });
    root.appendChild(heading);
    if (notice) {
      root.appendChild(el("p", { class: "notice", text: notice }));
      announce(notice);
    }
    for (const section of model.sections) {
      const block = el("section", { class: "consequence", "aria-label": section.heading }, [
        el("h3", { text: section.heading }),
        el(
          "ul",
          {},
          section.lines.map((line) => el("li", { text: line })),
        ),
      ]);
      root.appendChild(block);
    }
    if (model.note !== null) root.appendChild(el("p", { class: "muted", text: model.note }));
    const status = el("p", { class: "muted", role: "status", "aria-live": "polite" });
    if (route.mode !== "resume" && (model.canConfirm || model.canAsk)) {
      const length = el("input", {
        id: "delegation-days",
        class: "input",
        type: "number",
        min: "1",
        step: "1",
        inputmode: "numeric",
      });
      length.value = days === undefined ? "" : String(days);
      length.addEventListener("change", async () => {
        const n = Number(length.value);
        days = Number.isInteger(n) && n >= 1 ? n : undefined;
        const fresh = await ask(previewBody());
        if (fresh.ok) {
          answer = fresh;
          digest = fresh.body.consequencesDigest;
          draw(null, true);
          document.getElementById("delegation-days")?.focus();
          return;
        }
        status.textContent = `Not done: ${fresh.error?.message ?? "Something went wrong."}`;
      });
      root.appendChild(
        el("p", {}, [el("label", { for: "delegation-days", text: "Length in days" }), " ", length]),
      );
    }
    if (model.canConfirm) {
      const field = el("input", {
        id: "delegation-confirm",
        class: "input",
        type: "text",
        autocomplete: "off",
        spellcheck: "false",
        value: typed,
      });
      field.value = typed;
      const turnOn = el("button", {
        class: "btn btn-primary",
        type: "button",
        text: route.page === "new" ? "Turn on" : route.mode === "resume" ? "Resume" : "Save change",
      });
      turnOn.disabled = !model.canTurnOn;
      field.addEventListener("input", () => {
        typed = field.value;
        turnOn.disabled = !pageModel(answer.body, you, typed).canTurnOn;
      });
      turnOn.addEventListener("click", async () => {
        turnOn.disabled = true;
        const terms = days !== undefined && route.mode !== "resume" ? { terms: { days } } : {};
        const bodyFor = (bound) =>
          route.page === "new"
            ? { action, ...terms, consequencesDigest: bound, confirm: typed }
            : route.mode === "resume"
              ? { expect: Number(rule?.revision), consequencesDigest: bound, confirm: typed }
              : {
                  expect: Number(rule?.revision),
                  ...terms,
                  consequencesDigest: bound,
                  confirm: typed,
                };
        const shown = answer.body.text;
        let done = await write.run({ body: bodyFor(digest ?? "0".repeat(64)) });
        if (!done.ok && (done.status === 412 || done.error?.code === "precondition_failed")) {
          const fresh = await ask(previewBody());
          if (fresh.ok) {
            answer = fresh;
            digest = fresh.body.consequencesDigest;
          }
          // A harness with no key makes one as the rule is turned on: the same words, now
          // with their digest, are confirmed once more. Different words are shown first.
          if (fresh.ok && fresh.body.text === shown && digest !== undefined) {
            done = await write.run({ body: bodyFor(digest) });
          } else {
            draw(DELEGATIONS_COPY.changed, true);
            return;
          }
        }
        if (done.ok) {
          announce(
            route.page === "new" ? "Turned on." : route.mode === "resume" ? "Resumed." : "Changed.",
          );
          location.hash = hrefHarness(ctx.id, "setup", "delegations");
          return;
        }
        status.textContent = `Not done: ${done.error?.message ?? "Something went wrong."}`;
        turnOn.disabled = !pageModel(answer.body, you, typed).canTurnOn;
        turnOn.focus();
      });
      root.appendChild(
        el("p", {}, [
          el("label", { for: "delegation-confirm", text: model.confirmLabel }),
          " ",
          field,
          " ",
          turnOn,
        ]),
      );
      if (keepFocus) field.focus();
    } else if (model.canAsk) {
      const askButton = el("button", {
        class: "btn btn-primary",
        type: "button",
        text: "Ask the owner",
      });
      askButton.addEventListener("click", async () => {
        askButton.disabled = true;
        const done = await proposeAction.run({
          body: { action, ...(days !== undefined ? { terms: { days } } : {}) },
        });
        askButton.disabled = false;
        status.textContent = done.ok
          ? "Asked the owner. They decide from this page."
          : `Not done: ${done.error?.message ?? "Something went wrong."}`;
        askButton.focus();
      });
      root.appendChild(el("p", {}, [askButton]));
    } else {
      root.appendChild(el("p", { class: "muted", text: DELEGATIONS_COPY.readOnly }));
    }
    root.appendChild(status);
    root.appendChild(twin(model.cli));
    if (!keepFocus) heading.focus();
  };
  draw(null, false);
}

export async function renderDelegations(root, ctx) {
  const route = routeOf(ctx?.route?.rest);
  if (route.page === "list") return drawList(root, ctx);
  if (route.page === "unknown") {
    clear(root);
    root.appendChild(el("p", { text: "There is no such page under Delegations." }));
    root.appendChild(
      el("a", { href: hrefHarness(ctx.id, "setup", "delegations"), text: "Back to Delegations" }),
    );
    return undefined;
  }
  return drawPage(root, ctx, route);
}
