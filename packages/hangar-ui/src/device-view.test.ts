/**
 * The device sign-in page: a labelled code field that takes a code in any case, plain
 * words for every refusal, status that is never colour alone, and no markup assignment.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { DEVICE_MESSAGES, codeFromHash } from "../assets/js/views/device.js";
import { homeAssets as CONSOLE_ASSETS } from "./embed/home";

const SOURCE = readFileSync(
  join(import.meta.dir, "..", "assets", "js", "views", "device.js"),
  "utf8",
);

describe("#/device", () => {
  test("the code field is labelled, takes a one-time code, and says what it takes", () => {
    expect(SOURCE).toContain('el("label", { for: "device-code"');
    expect(SOURCE).toContain('autocomplete: "one-time-code"');
    expect(SOURCE).toContain('"aria-describedby": "device-code-help"');
    for (const words of ["Look up", "Allow this sign-in", "Deny"])
      expect(SOURCE).toContain(`text: "${words}"`);
    // The result heading takes focus, so a screen reader hears what happened.
    expect(SOURCE).toContain('tabindex: "-1"');
    expect(SOURCE).toContain("heading.focus()");
  });

  test("every refusal is said in words, with the reason", () => {
    expect(Object.keys(DEVICE_MESSAGES).sort()).toEqual(
      [
        "access_not_set_up",
        "code_expired",
        "code_unknown",
        "code_used",
        "session_required",
        "too_many_tries",
      ].sort(),
    );
    expect(DEVICE_MESSAGES.code_expired).toContain("expired");
    expect(DEVICE_MESSAGES.code_used).toContain("already been used");
    expect(DEVICE_MESSAGES.too_many_tries).toContain("Wait ten minutes");
    // A tab-only page hears why it cannot allow one here.
    expect(DEVICE_MESSAGES.session_required).toContain("over HTTPS");
  });

  test("a code in the address fills the field; anything else does not", () => {
    expect(codeFromHash("#/device?code=bcdf-ghjk")).toBe("bcdf-ghjk");
    expect(codeFromHash("#/device")).toBe("");
    expect(codeFromHash("#/device?code=<script>")).toBe("");
  });

  test("status is a word and an icon; no markup is ever assigned", () => {
    expect(SOURCE).toContain('"aria-hidden": "true"');
    expect(SOURCE).toContain("Not done: ");
    for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
      expect(SOURCE).not.toContain(banned);
    }
  });

  test("the page and the client ship in the console", () => {
    expect(Object.keys(CONSOLE_ASSETS)).toContain("/assets/js/views/device.js");
    expect(Object.keys(CONSOLE_ASSETS)).toContain("/assets/js/v1.js");
  });
});
