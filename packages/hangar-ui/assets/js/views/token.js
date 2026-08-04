/**
 * Token screen — shown on any 401. Explains where the token lives and
 * accepts a paste; the value goes to sessionStorage only (see api.js).
 */

import { setToken } from "../api.js";
import { clear, el } from "../dom.js";

export function renderTokenScreen(root, onSaved) {
  clear(root);
  const input = el("input", {
    class: "input token-input",
    type: "password",
    placeholder: "paste your Hangar token",
    autocomplete: "off",
    spellcheck: "false",
    "aria-label": "Hangar token",
  });
  const save = el("button", { class: "btn btn-primary", type: "button", text: "Use token" });
  const form = el("form", { class: "token-form" }, [input, save]);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (value === "") return;
    setToken(value);
    onSaved();
  });
  root.appendChild(
    el("div", { class: "token-screen" }, [
      el("div", { class: "card token-card" }, [
        el("h2", { text: "Authentication required" }),
        el("p", {
          text:
            "This console is token-gated. crewhaus hangar prints a ready-to-open URL " +
            "carrying the token; if you landed here without one, read it from the token " +
            "file on the machine running Hangar:",
        }),
        el("pre", { class: "mdcode", text: "~/.crewhaus/hangar/token" }),
        el("p", {
          text:
            "Paste the token below. It is kept in this tab's sessionStorage only — " +
            "never in a cookie or a query string.",
        }),
        form,
      ]),
    ]),
  );
  input.focus();
}
