/**
 * The sign-in screen: shown when this browser has no session and its own key could not
 * sign it in. It asks for nothing to remember and no puzzle (WCAG 2.2 SC 3.3.8): the
 * person runs one command on Home's computer and pastes the link it gives, or the link
 * opens here by itself.
 *
 * Home's own key is never sent or stored from here: a pasted 64-hex value is recognised
 * and refused in the field, before anything leaves the page.
 */

import { append, clear, copyBtn, el } from "../dom.js";
import {
  NOT_ENCRYPTED,
  OWN_KEY,
  canSignIn,
  exchangeCode,
  followBootLink,
  hasDevice,
  parseSignInLink,
  signInWithDevice,
} from "../sign-in.js";

const TWIN = "crewhaus hangar open";
const NOT_A_LINK =
  "That is not a sign-in link. Paste the link `crewhaus hangar open --print` shows.";

/**
 * Draw the screen into `root`. `onSignedIn` runs once a pasted link has signed this tab
 * in; `message` is a reason to show at once (a link that was already used, say).
 */
export function renderSignInScreen(root, { onSignedIn, message = "" } = {}) {
  clear(root);
  const heading = el("h1", { id: "sign-in-title", tabindex: "-1", text: "Sign in to Home" });
  const status = el("p", {
    class: "sign-in-message",
    role: "status",
    "aria-live": "polite",
  });
  const say = (kind, words) => {
    clear(status);
    if (words === "") return;
    status.dataset.kind = kind;
    status.appendChild(
      el("strong", { text: kind === "error" ? "Not signed in: " : "Signing in: " }),
    );
    append(status, words);
  };

  const card = el("section", { class: "card sign-in-card", "aria-labelledby": "sign-in-title" }, [
    heading,
  ]);

  if (!canSignIn()) {
    card.appendChild(el("p", { text: NOT_ENCRYPTED }));
    root.appendChild(el("div", { class: "sign-in-screen" }, [card]));
    heading.focus();
    return;
  }

  const input = el("input", {
    id: "sign-in-link",
    class: "input sign-in-input",
    type: "text",
    autocomplete: "off",
    spellcheck: "false",
    autocapitalize: "off",
    "aria-describedby": "sign-in-help",
  });
  const submit = el("button", { class: "btn btn-primary", type: "submit", text: "Sign in" });
  const form = el("form", { class: "sign-in-form" }, [
    el("label", { for: "sign-in-link", text: "Sign-in link" }),
    el("div", { class: "sign-in-row" }, [input, submit]),
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const pasted = parseSignInLink(input.value);
    if (pasted.kind === "key") {
      // Never sent, never kept: out of the field at once.
      input.value = "";
      say("error", OWN_KEY);
      input.focus();
      return;
    }
    if (pasted.kind === "invalid") {
      say("error", NOT_A_LINK);
      input.focus();
      return;
    }
    if (pasted.kind === "boot") {
      say("info", "opening the link…");
      followBootLink(pasted.path);
      return;
    }
    submit.disabled = true;
    say("info", "checking the link…");
    const answer = await exchangeCode(pasted.code);
    submit.disabled = false;
    if (answer.ok) {
      say("", "");
      onSignedIn?.();
      return;
    }
    say("error", answer.message);
    input.focus();
  });

  card.appendChild(
    el("p", { id: "sign-in-help", text: "Run this on the computer where Home is running:" }),
  );
  card.appendChild(
    el("div", { class: "sign-in-twin" }, [
      el("code", { class: "mono", text: TWIN }),
      copyBtn(TWIN, "Copy"),
    ]),
  );
  card.appendChild(form);
  card.appendChild(status);
  root.appendChild(el("div", { class: "sign-in-screen" }, [card]));
  if (message !== "") say("error", message);
  heading.focus();
  // A browser that signed out keeps its key: offer it, rather than a new link.
  void hasDevice().then((has) => {
    if (!has || !card.isConnected) return;
    const again = el("button", { class: "btn", type: "button", text: "Sign in with this browser" });
    again.addEventListener("click", async () => {
      again.disabled = true;
      say("info", "using this browser's key…");
      const answer = await signInWithDevice();
      again.disabled = false;
      if (answer.ok) {
        say("", "");
        onSignedIn?.();
        return;
      }
      say("error", answer.message);
    });
    card.insertBefore(el("div", { class: "editor-actions" }, [again]), form);
  });
}
