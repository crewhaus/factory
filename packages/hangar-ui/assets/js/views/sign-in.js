/**
 * The sign-in screen: shown when this browser has no session and its own key could not
 * sign it in. It asks for nothing to remember and no puzzle (WCAG 2.2 SC 3.3.8): the
 * person runs one command on Home's computer and pastes the link it gives, or the link
 * opens here by itself.
 *
 * It comes in two forms with the same contents: the whole page, when a tab opens with
 * nothing to sign in with, and a dialog over the shell, when a session ends while the
 * person is working, so whatever they were typing stays where it was and focus goes back
 * to it once they are signed in again.
 *
 * What it says is spoken through the console's own live regions (`ui/live.js`), which
 * clear before every message, so the same refusal twice is still heard. The reason the
 * screen appeared is plain text that describes its heading, so focusing the heading
 * reads it.
 *
 * Home's own key is never sent or stored from here: a pasted 64-hex value is recognised
 * and refused in the field, before anything leaves the page.
 */

import { append, clear, copyBtn, el } from "../dom.js";
import {
  CONNECTION_NOT_ENCRYPTED,
  NOT_ENCRYPTED,
  OWN_KEY,
  acceptInvite,
  canSignIn,
  exchangeCode,
  followBootLink,
  hasDevice,
  parseSignInLink,
  signInWithDevice,
} from "../sign-in.js";
import { openDialog } from "../ui/dialog.js";
import { announce } from "../ui/live.js";

const TWIN = "crewhaus hangar open";
const TITLE = "Sign in to Home";
const REASON_ID = "sign-in-reason";
const NOT_A_LINK =
  "That is not a sign-in link. Paste the link `crewhaus hangar open --print` shows.";

/** Why the dialog appears over a shell the person was using. */
export const SESSION_ENDED =
  "Your sign-in ended. Sign in again to carry on; what you were doing is kept.";

const prefixOf = (kind) => (kind === "error" ? "Not signed in: " : "Signing in: ");

/**
 * The screen's contents, for either form. Answers the nodes and whether a reason is shown
 * (its paragraph has the id {@link REASON_ID}).
 */
function signInContents({ onSignedIn, message }) {
  const nodes = [];
  const hasReason = message !== "";
  if (hasReason) {
    nodes.push(
      el("p", { id: REASON_ID, class: "sign-in-reason" }, [
        el("strong", { text: prefixOf("error") }),
        message,
      ]),
    );
  }
  if (!canSignIn()) {
    nodes.push(el("p", { text: NOT_ENCRYPTED }));
    return { nodes, hasReason };
  }

  // Visible words only; the live regions speak them.
  const status = el("p", { class: "sign-in-message" });
  const say = (kind, words) => {
    clear(status);
    if (words === "") {
      announce("");
      return;
    }
    status.dataset.kind = kind;
    status.appendChild(el("strong", { text: prefixOf(kind) }));
    append(status, words);
    announce(`${prefixOf(kind)}${words}`);
  };

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

  nodes.push(
    el("p", { id: "sign-in-help", text: "Run this on the computer where Home is running:" }),
    el("div", { class: "sign-in-twin" }, [
      el("code", { class: "mono", text: TWIN }),
      copyBtn(TWIN, "Copy"),
    ]),
    form,
    status,
  );

  // A browser that signed out keeps its key: offer it, rather than a new link.
  void hasDevice().then((has) => {
    if (!has || !form.isConnected) return;
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
    form.parentNode?.insertBefore(el("div", { class: "editor-actions" }, [again]), form);
  });
  return { nodes, hasReason };
}

/**
 * The join screen an invite link opens: one field, the person's name (nothing to
 * remember, no puzzle: WCAG 2.2 SC 3.3.8), and one button. On a page that is not
 * encrypted it says so, and this tab keeps its own sign-in.
 */
export function renderJoinScreen(root, { code, onSignedIn }) {
  clear(root);
  const heading = el("h1", { id: "join-title", tabindex: "-1", text: "Join Home" });
  const status = el("p", { class: "sign-in-message" });
  const say = (kind, words) => {
    clear(status);
    if (words === "") {
      announce("");
      return;
    }
    status.dataset.kind = kind;
    status.appendChild(el("strong", { text: prefixOf(kind) }));
    append(status, words);
    announce(`${prefixOf(kind)}${words}`);
  };
  const input = el("input", {
    id: "join-name",
    class: "input sign-in-input",
    type: "text",
    autocomplete: "name",
    required: "required",
    maxlength: "80",
    "aria-describedby": "join-help",
  });
  const submit = el("button", { class: "btn btn-primary", type: "submit", text: "Join Home" });
  const form = el("form", { class: "sign-in-form" }, [
    el("label", { for: "join-name", text: "Your name" }),
    el("div", { class: "sign-in-row" }, [input, submit]),
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (input.value.trim() === "") {
      say("error", "Type your name.");
      input.focus();
      return;
    }
    submit.disabled = true;
    say("info", "joining…");
    const answer = await acceptInvite(code, input.value);
    submit.disabled = false;
    if (answer.ok) {
      say("", "");
      onSignedIn?.();
      return;
    }
    say("error", answer.message);
    input.focus();
  });
  const nodes = [
    heading,
    el("p", {
      id: "join-help",
      text: "You were invited to this Home. Others here will see this name.",
    }),
  ];
  if (!canSignIn()) {
    nodes.push(
      el("p", { class: "sign-in-reason" }, [
        el("strong", { text: CONNECTION_NOT_ENCRYPTED }),
        " This tab keeps its own sign-in, which ends when you close it.",
      ]),
    );
  }
  nodes.push(form, status);
  const card = el(
    "section",
    { class: "card sign-in-card", "aria-labelledby": "join-title" },
    nodes,
  );
  root.appendChild(el("div", { class: "sign-in-screen" }, [card]));
  input.focus();
}

/**
 * Draw the screen into `root`. `onSignedIn` runs once a pasted link has signed this tab
 * in; `message` is a reason to show at once (a link that was already used, say).
 */
export function renderSignInScreen(root, { onSignedIn, message = "" } = {}) {
  clear(root);
  const { nodes, hasReason } = signInContents({ onSignedIn, message });
  const describedBy = hasReason ? { "aria-describedby": REASON_ID } : {};
  const heading = el("h1", { id: "sign-in-title", tabindex: "-1", text: TITLE, ...describedBy });
  const card = el(
    "section",
    { class: "card sign-in-card", "aria-labelledby": "sign-in-title", ...describedBy },
    [heading, ...nodes],
  );
  root.appendChild(el("div", { class: "sign-in-screen" }, [card]));
  heading.focus();
}

/**
 * The same screen as a dialog over the shell. Focus starts on its title (which the reason
 * describes) and goes back to whatever had it when the tab is signed in again. `onClose`
 * runs when it goes, signed in or dismissed with Escape.
 */
export function openSignInDialog({ onSignedIn, onClose, message = "" } = {}) {
  let dialog = null;
  const { nodes, hasReason } = signInContents({
    message,
    onSignedIn: () => {
      dialog?.close();
      onSignedIn?.();
    },
  });
  dialog = openDialog({
    title: TITLE,
    body: el("div", { class: "sign-in-dialog" }, nodes),
    initialFocus: "heading",
    dataset: { signIn: "1" },
    onClose: () => onClose?.(),
  });
  if (hasReason) {
    dialog.node.setAttribute("aria-describedby", REASON_ID);
    dialog.node.querySelector(".modal-title")?.setAttribute("aria-describedby", REASON_ID);
  }
  return dialog;
}
