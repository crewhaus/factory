/**
 * v0.3.0 Goal 6 — die()'s coded-exit rendering, unit-tested through the
 * side-effect-free `renderCliFailure` (index.ts's die() is a thin
 * write+exit wrapper around it).
 */
import { describe, expect, test } from "bun:test";
import {
  ConfigError,
  EXIT_CODES,
  type FailureReport,
  RunFailedError,
  RuntimeError,
} from "@crewhaus/errors";
import { CONTINUE_NOTE, renderCliFailure } from "./run-failure";

const BILLING_REPORT: FailureReport = {
  class: "billing",
  title: "provider account out of funding",
  detail: 'Anthropic said: "Your credit balance is too low to access the Anthropic API."',
  remediation: "add credits at https://console.anthropic.com/settings/billing, then rerun.",
  exitCode: EXIT_CODES.billing,
};

describe("renderCliFailure", () => {
  test("a RunFailedError renders the full report with the crewhaus: prefix and its coded exit", () => {
    const rendered = renderCliFailure(new RunFailedError(BILLING_REPORT));
    expect(rendered.exitCode).toBe(31);
    expect(rendered.text).toBe(
      [
        "crewhaus: run stopped — provider account out of funding",
        '  Anthropic said: "Your credit balance is too low to access the Anthropic API."',
        "  Fix: add credits at https://console.anthropic.com/settings/billing, then rerun.",
        "  (exit 31)",
      ].join("\n"),
    );
  });

  test("the resume note lands between Fix and the exit line — the design §8.2 example", () => {
    const rendered = renderCliFailure(new RunFailedError(BILLING_REPORT), {
      notes: [CONTINUE_NOTE],
    });
    expect(rendered.text).toBe(
      [
        "crewhaus: run stopped — provider account out of funding",
        '  Anthropic said: "Your credit balance is too low to access the Anthropic API."',
        "  Fix: add credits at https://console.anthropic.com/settings/billing, then rerun.",
        "  Your session is saved — `crewhaus run --continue` resumes exactly where it stopped.",
        "  (exit 31)",
      ].join("\n"),
    );
    expect(rendered.exitCode).toBe(31);
  });

  test("an auth report exits with the auth code", () => {
    const rendered = renderCliFailure(
      new RunFailedError({
        class: "auth",
        title: "provider rejected the credentials",
        detail: 'Anthropic said: "invalid x-api-key"',
        remediation: "check ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY (see .env.example).",
        exitCode: EXIT_CODES.auth,
      }),
    );
    expect(rendered.exitCode).toBe(30);
    expect(
      rendered.text.startsWith("crewhaus: run stopped — provider rejected the credentials"),
    ).toBe(true);
  });

  test("other CrewhausErrors keep the pre-0.3.0 one-liner + exit 1, byte-for-byte", () => {
    const rendered = renderCliFailure(new RuntimeError("recovery failed: boom"));
    expect(rendered).toEqual({ text: "crewhaus: recovery failed: boom", exitCode: 1 });
    const config = renderCliFailure(new ConfigError("missing OPENAI_API_KEY"));
    expect(config).toEqual({ text: "crewhaus: missing OPENAI_API_KEY", exitCode: 1 });
  });

  test("plain strings (the classic die() call sites) keep the one-liner + exit 1", () => {
    expect(renderCliFailure("missing <spec.yaml>")).toEqual({
      text: "crewhaus: missing <spec.yaml>",
      exitCode: 1,
    });
  });

  test("notes are ignored on the one-liner shape", () => {
    const rendered = renderCliFailure(new RuntimeError("x"), { notes: [CONTINUE_NOTE] });
    expect(rendered.text).toBe("crewhaus: x");
  });
});
