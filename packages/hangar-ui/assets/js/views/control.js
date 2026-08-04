/**
 * The shared M2 action affordances: the CLI twin display, buttons that are
 * disabled WITH THEIR REASON, the control.v1 wake/drain control, and the
 * preflight-refusal modal.
 *
 * Two invariants live here rather than in each screen:
 *
 *   - **Every action shows the command it runs.** The CLI and the console
 *     drive the same harness-local state tree, so a twin is not decoration:
 *     it is how an operator verifies what a click will do, and how they take
 *     the same action from a terminal when the console is not running.
 *   - **A refusal is rendered, never toasted away.** A control.v1 envelope
 *     with `expected: true` (no control port, lane not armed, draining) is a
 *     FACT about this bundle: the control renders disabled with the server's
 *     sentence. Only `tick_in_flight` retries.
 */

import { copyBtn, dot, el, toast } from "../dom.js";
import { NO_TWIN_NOTES, cliTwinFor, controlOutcome } from "../supervision.js";

/**
 * The CLI twin line: the exact command, monospaced, with a copy button.
 * `note` renders instead when there is no CLI verb yet — an honest absence
 * beats an invented command.
 */
export function cliTwin(command, note = null) {
  if (typeof command !== "string" || command === "") {
    return note === null
      ? null
      : el("div", { class: "twin twin-none" }, [
          el("span", { class: "twin-label", text: "CLI twin" }),
          el("span", { class: "muted", text: note }),
        ]);
  }
  return el("div", { class: "twin" }, [
    el("span", { class: "twin-label", text: "CLI twin" }),
    el("code", { class: "twin-cmd", text: command }),
    copyBtn(command, "copy"),
  ]);
}

/** The twin for a named action (see `cliTwinFor`), or its honest absence. */
export function actionTwin(action, args) {
  return cliTwin(cliTwinFor(action, args), NO_TWIN_NOTES[action] ?? null);
}

/**
 * A button that either works or says why it does not. `gate` is
 * `{ enabled, reason }` — the shape `procActions` and `pokeReason` both
 * produce — and a disabled button keeps its reason in the title AND in a
 * sibling line, because a tooltip is invisible to a keyboard user.
 */
export function gatedBtn(label, gate, onClick, cls = "btn") {
  const g = gate && typeof gate === "object" ? gate : { enabled: true, reason: null };
  const btn = el("button", {
    class: cls,
    type: "button",
    text: label,
    title: g.enabled ? label : (g.reason ?? "unavailable"),
  });
  if (!g.enabled) btn.disabled = true;
  else btn.addEventListener("click", onClick);
  return btn;
}

/** A gated button plus the sentence explaining a disabled state. */
export function gatedAction(label, gate, onClick, cls = "btn") {
  const g = gate && typeof gate === "object" ? gate : { enabled: true, reason: null };
  return el("div", { class: "gated" }, [
    gatedBtn(label, g, onClick, cls),
    g.enabled || !g.reason ? null : el("span", { class: "muted gated-why", text: g.reason }),
  ]);
}

/**
 * Run one write with a busy button; failures surface (never silently), and
 * the caller's `onOk` reloads. Returns the promise so callers can await.
 */
export async function runAction(btn, label, fn, onOk) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = `${label}…`;
  try {
    const result = await fn();
    btn.textContent = original;
    btn.disabled = false;
    if (onOk) onOk(result);
    return result;
  } catch (err) {
    btn.textContent = original;
    btn.disabled = false;
    toast(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * A control.v1 control (Wake / Drain). `gate` decides whether it is offered
 * at all (a lane the spec never declared has nothing to poke); the ENVELOPE
 * decides what happens after a click:
 *
 *   - `expected` refusal ⇒ the button disables itself and shows the reason;
 *   - `tick_in_flight`   ⇒ retryable: a spinner, then the same button back;
 *   - anything else      ⇒ a real fault, surfaced as an error.
 */
export function controlBtn(label, gate, call, twinArgs, onSettled) {
  const state = el("div", { class: "control-state" });
  const btn = gatedBtn(label, gate, async () => {
    btn.disabled = true;
    const spinner = el("span", { class: "muted", text: "…" });
    state.replaceChildren(spinner);
    let envelope;
    try {
      envelope = await call();
    } catch (err) {
      state.replaceChildren(
        el("span", { class: "muted", text: err instanceof Error ? err.message : String(err) }),
      );
      btn.disabled = false;
      return;
    }
    const outcome = controlOutcome(envelope);
    if (outcome.ok) {
      state.replaceChildren(dot("ok", "accepted"));
      btn.disabled = false;
    } else if (outcome.retryable) {
      // A tick is already running — the same call succeeds shortly.
      state.replaceChildren(dot("warn", `${outcome.reason} — retry in a moment`));
      btn.disabled = false;
    } else {
      // `expected` ⇒ this control is disabled-with-reason from here on.
      state.replaceChildren(dot(outcome.dot, outcome.reason));
      btn.disabled = outcome.disabled;
      if (!outcome.expected) toast(`${label} failed: ${outcome.reason}`);
    }
    if (onSettled) onSettled(outcome);
  });
  const wrap = el("div", { class: "control-action" }, [
    el("div", { class: "control-row" }, [btn, state]),
    gate && gate.enabled === false && gate.reason
      ? el("span", { class: "muted gated-why", text: gate.reason })
      : null,
    twinArgs ? actionTwin(twinArgs.action, twinArgs) : null,
  ]);
  return wrap;
}

/**
 * The preflight-refusal modal. Every refused item lists its remediation, and
 * "Start anyway" appears ONLY when every item is acknowledgeable — a missing
 * channel secret is unforceable because the compiled daemon's own boot gate
 * exits 2 on exactly that set, so forcing it would spawn a process
 * guaranteed to die.
 */
export function refusalModal(model, handlers = {}) {
  const backdrop = el("div", { class: "modal-backdrop", role: "presentation" });
  const close = () => backdrop.remove();
  const body = el("div", { class: "modal-body" });

  if (model.items.length > 0) {
    body.appendChild(
      el(
        "ul",
        { class: "refusal-list" },
        model.items.map((item) =>
          el("li", { class: "refusal-item" }, [
            el("div", { class: "refusal-head" }, [
              dot(item.acknowledgeable ? "warn" : "bad", item.level),
              el("span", { class: "mono muted", text: item.area }),
              el("span", { text: item.message }),
            ]),
            item.remediation
              ? el("div", { class: "reason muted" }, [
                  el("strong", { text: "Fix: " }),
                  item.remediation,
                ])
              : null,
            item.acknowledgeable
              ? null
              : el("div", { class: "reason" }, [
                  el("span", {
                    class: "chip chip-warn",
                    text: "unforceable — the daemon's own boot gate exits 2 on this",
                  }),
                ]),
          ]),
        ),
      ),
    );
  } else {
    body.appendChild(el("p", { text: model.message }));
  }
  if (model.forceHint) body.appendChild(el("p", { class: "muted", text: model.forceHint }));

  const actions = el("div", { class: "modal-actions" });
  if (model.canForce && handlers.onForce) {
    const forceBtn = el("button", {
      class: "btn btn-danger",
      type: "button",
      text: "Start anyway",
    });
    forceBtn.addEventListener("click", () => {
      close();
      handlers.onForce(model.acknowledge);
    });
    actions.appendChild(forceBtn);
  }
  if (model.action && model.action.jobKind !== null && handlers.onRemedy) {
    // A remedy is a BUTTON, never a toast: "no compiled bundle" has an
    // obvious next step and the console can run it.
    const remedyBtn = el("button", {
      class: "btn btn-primary",
      type: "button",
      text: model.action.label,
    });
    remedyBtn.addEventListener("click", () => {
      close();
      handlers.onRemedy(model.action.jobKind);
    });
    actions.appendChild(remedyBtn);
  } else if (model.action) {
    actions.appendChild(el("span", { class: "muted", text: model.action.hint }));
  }
  actions.appendChild(
    el("button", { class: "btn btn-ghost", type: "button", text: "Close", onClick: close }),
  );

  backdrop.appendChild(
    el("div", { class: "modal card", role: "dialog", "aria-modal": "true" }, [
      el("h3", { class: "card-title" }, [
        el("span", { text: model.title }),
        model.canForce ? null : el("span", { class: "chip chip-warn", text: "not forceable" }),
      ]),
      model.items.length > 0 ? el("p", { class: "muted", text: model.message }) : null,
      body,
      model.canForce && handlers.onForce
        ? cliTwin(
            cliTwinFor("start", {
              dir: handlers.dir,
              force: true,
              acknowledge: model.acknowledge,
            }),
          )
        : null,
      actions,
    ]),
  );
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  document.body.appendChild(backdrop);
  return backdrop;
}
