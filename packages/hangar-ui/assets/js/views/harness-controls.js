/**
 * The operator controls on a harness's header: Pause new work or Resume new work,
 * Finish current work then stop, Disable or Enable, and Retire. Each is one action
 * through the versioned API (one `Idempotency-Key`, the same on a retry), shows the
 * server's own sentence as its receipt and the receipt's state ("Accepted" is never
 * "Done"), and its command-line twin. A control the caller may not use is shown
 * disabled, with the reason as text beside it, from `harnesses.get`'s `you`.
 *
 * Retire is a dry run first: its steps as a list, then "Type <name> to retire it" with
 * the nonce the dry run handed back.
 *
 * `controlsModel` and `receiptWords` are pure; `renderHarnessControls` builds DOM with
 * `el` only.
 */

import { el } from "../dom.js";
import { createAction } from "../v1.js";

/** Why a control is unavailable, by the permission behind it. */
const NEEDS = Object.freeze({
  control: "Needs Operator: ask an owner",
  deploy: "Needs Maintainer: ask an owner",
  retire: "Needs Owner: ask an owner",
});

/** A receipt's state, in words: accepted work is not done work. */
export const RECEIPT_WORDS = Object.freeze({
  accepted: "Accepted",
  running: "In progress",
  succeeded: "Done",
  failed: "Failed",
  rejected: "Refused",
  cancelled: "Cancelled",
});

/** The controls a header offers, from `harnesses.get`: `[{id, label, …}]`. Pure. */
export function controlsModel(overview, harness = "<harness>") {
  const you = overview?.you && typeof overview.you === "object" ? overview.you : {};
  const state = overview?.display?.state;
  const paused = state === "paused";
  const disabled = state === "disabled";
  // Each twin is spelled whole, so every command the console shows is one a terminal runs.
  const row = (id, label, operation, permission, twin, extra = {}) => ({
    id,
    label,
    operation,
    enabled: you[permission] === true,
    reason: you[permission] === true ? null : NEEDS[permission],
    twin,
    ...extra,
  });
  return [
    paused
      ? row(
          "resume",
          "Resume new work",
          "controls.resume",
          "control",
          `crewhaus daemon resume ${harness}`,
        )
      : row(
          "pause",
          "Pause new work",
          "controls.pause",
          "control",
          `crewhaus daemon pause ${harness}`,
          {
            confirm:
              "Nothing new starts. Work already running finishes. Messages that arrive get a short notice.",
            quietOption: "Don't reply to messages while paused",
          },
        ),
    row(
      "drain",
      "Finish current work, then stop",
      "controls.drain",
      "control",
      `crewhaus daemon drain ${harness}`,
      { confirm: "It finishes what it is doing, then stops." },
    ),
    disabled
      ? row("enable", "Enable", "controls.enable", "deploy", `crewhaus daemon enable ${harness}`)
      : row(
          "disable",
          "Disable",
          "controls.disable",
          "deploy",
          `crewhaus daemon disable ${harness}`,
          {
            confirm: "It won't start, restart or run on a schedule until you enable it.",
          },
        ),
    row("retire", "Retire…", "controls.retire", "retire", null),
  ];
}

/** A control's answer as a person reads it: the server's sentence, then the receipt's state. Pure. */
export function receiptWords(answer) {
  if (!answer?.ok) {
    return typeof answer?.error?.message === "string"
      ? answer.error.message
      : "That control was not applied.";
  }
  const state = RECEIPT_WORDS[answer.body?.receipt?.state] ?? null;
  const line = typeof answer.body?.line === "string" ? answer.body.line : null;
  return [line, state].filter((part) => part !== null).join(" · ") || "Sent.";
}

/** The header's controls. `opts.deps.createAction` is injected by a test. */
export function renderHarnessControls(overview, ctx, opts = {}) {
  const deps = opts.deps ?? { createAction };
  const status = el("p", { class: "controls-status", role: "status", "aria-live": "polite" });
  const name = String(overview?.slug ?? ctx.id);
  const send = async (control, body) => {
    const action = deps.createAction(control.operation, { params: { h: ctx.id }, body });
    status.textContent = "Sending…";
    const answer = await action.run();
    status.textContent = receiptWords(answer);
    return answer;
  };
  const panel = el("div", { class: "harness-controls" });
  for (const control of controlsModel(overview, ctx.id)) {
    const details = el("div", { class: "control-detail", hidden: true });
    const button = el("button", {
      class: "btn",
      type: "button",
      text: control.label,
      disabled: !control.enabled,
      "aria-expanded": control.confirm !== undefined || control.id === "retire" ? "false" : null,
      onClick: () => {
        if (control.id === "retire") return void retireFlow(control, details, button, name, send);
        if (control.confirm === undefined) return void send(control, {});
        details.hidden = !details.hidden;
        button.setAttribute("aria-expanded", details.hidden ? "false" : "true");
        if (!details.hidden) drawConfirm(control, details, send);
      },
    });
    panel.appendChild(
      el("div", { class: "control-row" }, [
        button,
        control.reason !== null ? el("span", { class: "muted", text: control.reason }) : null,
        control.twin !== null
          ? el("code", { class: "twin-cmd mono", tabindex: "0", text: control.twin })
          : null,
        details,
      ]),
    );
  }
  panel.appendChild(status);
  return panel;
}

function drawConfirm(control, details, send) {
  const quietId = `quiet-${control.id}`;
  const quiet =
    control.quietOption !== undefined ? el("input", { type: "checkbox", id: quietId }) : null;
  details.replaceChildren(
    el("p", { text: control.confirm }),
    ...(quiet !== null
      ? [el("p", null, [quiet, el("label", { for: quietId, text: ` ${control.quietOption}` })])]
      : []),
    el("button", {
      class: "btn btn-primary",
      type: "button",
      text: control.label,
      onClick: () => void send(control, quiet?.checked === true ? { quiet: true } : {}),
    }),
  );
}

async function retireFlow(control, details, button, name, send) {
  details.hidden = false;
  button.setAttribute("aria-expanded", "true");
  details.replaceChildren(el("p", { class: "muted", text: "Working out what retiring does…" }));
  const dry = await send(control, { dryRun: true });
  if (!dry?.ok) return;
  const steps = Array.isArray(dry.body?.steps) ? dry.body.steps : [];
  const nonce = typeof dry.body?.nonce === "string" ? dry.body.nonce : null;
  const inputId = `retire-name-${name}`;
  const input = el("input", { class: "input", type: "text", id: inputId, autocomplete: "off" });
  details.replaceChildren(
    el(
      "ol",
      { class: "retire-steps" },
      steps.map((step) => el("li", { text: String(step.note ?? step.kind ?? "") })),
    ),
    el("label", { for: inputId, text: `Type ${name} to retire it` }),
    input,
    el("button", {
      class: "btn btn-danger",
      type: "button",
      text: "Retire",
      onClick: () =>
        void send(control, {
          dryRun: false,
          confirmName: String(input.value ?? ""),
          ...(nonce !== null ? { nonce } : {}),
        }),
    }),
  );
}
