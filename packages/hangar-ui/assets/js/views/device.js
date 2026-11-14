/**
 * `#/device`: allow a sign-in from another computer. Someone runs `crewhaus login` there,
 * which shows a short code; a member signed in here types it, sees what it asks for, and
 * allows or denies it. The token belongs to the member who allows it, and is made only
 * when the other computer collects it.
 *
 * The code is typed in any case, with or without its hyphen; a `?code=` in the page's
 * address fills it in. Every answer is said in words with its reason, status is a word
 * and an icon (never colour alone), the result heading takes focus and says how it
 * ended, a refused choice gives focus back to the button pressed, and the live region is
 * polite. DOM by `createElement` and `textContent` only.
 */

import { append, clear, el } from "../dom.js";
import { announce } from "../ui/live.js";
import { call, createAction } from "../v1.js";

/** What each refusal says, in plain words. */
export const DEVICE_MESSAGES = Object.freeze({
  code_unknown: "That code does not match a sign-in waiting here. Check it and try again.",
  code_expired:
    "That code has expired. Run `crewhaus login` again on the other computer for a new one.",
  code_used: "That code has already been used.",
  too_many_tries: "Too many codes did not match. Wait ten minutes, then try again.",
  session_required:
    "This page cannot allow a sign-in. Open Home on its own computer or over HTTPS, signed in as a member.",
  access_not_set_up: "Nobody can allow a sign-in on this Home yet.",
  no_credential: "Your sign-in to this Home ended. Sign in again, then look up the code.",
});

function messageOf(error) {
  return DEVICE_MESSAGES[error?.reason] ?? error?.message ?? "Something went wrong.";
}

/** A code from the page's address: `#/device?code=BCDF-GHJK`. */
export function codeFromHash(hash) {
  const at = typeof hash === "string" ? hash.indexOf("?") : -1;
  if (at < 0) return "";
  const value = new URLSearchParams(hash.slice(at + 1)).get("code") ?? "";
  return /^[A-Za-z -]{1,16}$/.test(value) ? value : "";
}

/** The status line: an icon and a word, so it never rests on colour. */
function statusLine(kind, words) {
  const icon = kind === "ok" ? "✓" : kind === "error" ? "✗" : "…";
  const label = kind === "ok" ? "Done: " : kind === "error" ? "Not done: " : "Working: ";
  return el("p", { class: "device-status", dataset: { kind } }, [
    el("span", { "aria-hidden": "true", text: `${icon} ` }),
    el("strong", { text: label }),
    words,
  ]);
}

export function renderDevice(root, _ctx) {
  clear(root);
  const status = el("div", { class: "device-status-host" });
  const result = el("section", {
    class: "card device-result",
    "aria-labelledby": "device-result-title",
  });
  result.hidden = true;
  const say = (kind, words) => {
    clear(status);
    status.appendChild(statusLine(kind, words));
    announce(`${kind === "error" ? "Not done: " : kind === "ok" ? "Done: " : ""}${words}`);
  };

  const input = el("input", {
    id: "device-code",
    class: "input mono",
    type: "text",
    autocomplete: "one-time-code",
    autocapitalize: "characters",
    spellcheck: "false",
    inputmode: "text",
    maxlength: "16",
    "aria-describedby": "device-code-help",
  });
  input.value = codeFromHash(typeof location !== "undefined" ? location.hash : "");
  const lookUp = el("button", { class: "btn btn-primary", type: "submit", text: "Look up" });
  const form = el("form", { class: "add-form device-form" }, [
    el("label", { for: "device-code", text: "Code shown on the other computer" }),
    el("p", {
      id: "device-code-help",
      class: "muted",
      text: "Eight letters, like BCDF-GHJK. Case and the hyphen do not matter.",
    }),
    el("div", { class: "field-inline" }, [input, lookUp]),
  ]);

  // While a choice is sent its buttons say so with `aria-disabled`, never `disabled`: a
  // disabled button drops focus, and the person pressing it would lose their place.
  const busy = (buttons, on) => {
    for (const b of buttons) {
      if (on) b.setAttribute("aria-disabled", "true");
      else b.removeAttribute("aria-disabled");
    }
  };
  const decide = async (code, choice, heading, pressed, buttons) => {
    if (pressed.getAttribute("aria-disabled") === "true") return;
    busy(buttons, true);
    say("info", choice === "allow" ? "allowing the sign-in…" : "denying the sign-in…");
    let answer;
    try {
      const action = createAction("auth.device.decide", { body: { code, choice } });
      answer = await action.run();
    } finally {
      busy(buttons, false);
    }
    if (!answer.ok) {
      say("error", messageOf(answer.error));
      pressed.focus();
      return;
    }
    heading.textContent = choice === "allow" ? "Sign-in allowed" : "Sign-in denied";
    heading.focus();
    for (const b of buttons) b.hidden = true;
    say(
      "ok",
      choice === "allow"
        ? "Allowed. The other computer finishes signing in by itself."
        : "Denied. The other computer will say so.",
    );
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = input.value.trim();
    if (code === "") {
      say("error", "Type the code the other computer shows.");
      input.focus();
      return;
    }
    lookUp.disabled = true;
    say("info", "looking up the code…");
    let answer;
    try {
      answer = await call("auth.device.lookup", { body: { code } });
    } finally {
      lookUp.disabled = false;
    }
    clear(result);
    if (!answer.ok) {
      result.hidden = true;
      say("error", messageOf(answer.error));
      input.focus();
      return;
    }
    const request = answer.body;
    const heading = el("h2", {
      id: "device-result-title",
      class: "card-title",
      tabindex: "-1",
      text: "A sign-in is waiting",
    });
    const allow = el("button", {
      class: "btn btn-primary",
      type: "button",
      text: "Allow this sign-in",
    });
    const deny = el("button", { class: "btn", type: "button", text: "Deny" });
    allow.addEventListener("click", () => decide(code, "allow", heading, allow, [allow, deny]));
    deny.addEventListener("click", () => decide(code, "deny", heading, deny, [allow, deny]));
    append(result, [
      heading,
      el("ul", { class: "check-list" }, [
        el("li", {
          text: request.clientName ? `From: ${request.clientName}` : "From: another computer",
        }),
        el("li", {
          text: request.readOnly
            ? "It will only be able to read."
            : "It will be able to do what you can do here.",
        }),
        el("li", { text: `Its access lasts ${request.tokenDays} days, until you revoke it.` }),
      ]),
      el("div", { class: "editor-actions" }, [allow, deny]),
    ]);
    result.hidden = false;
    say("info", "check what it asks for, then allow or deny it.");
    heading.focus();
  });

  // The shell titles the page; this is what it is for.
  append(root, [
    el("p", {
      text: "Allow a computer you are using to sign in to this Home. Run `crewhaus login --server <url>` there with this page's address, then type the code it shows.",
    }),
    el("section", { class: "card" }, [form]),
    status,
    result,
  ]);
  if (input.value === "") input.focus();
}
