import { describe, expect, test } from "bun:test";
import {
  AdapterError,
  CompilerError,
  ConfigError,
  CrewhausError,
  EXIT_CODES,
  type FailureReport,
  McpConnectionError,
  McpError,
  McpProtocolError,
  ProviderAuthError,
  RunFailedError,
  RuntimeError,
  SpecParseError,
  formatRunFailure,
  isRunFailedError,
  toFailureReport,
} from "./index";

describe("CrewhausError", () => {
  test("extends Error and exposes a code", () => {
    const err = new CrewhausError("config", "boom");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CrewhausError);
    expect(err.code).toBe("config");
    expect(err.message).toBe("boom");
    expect(err.name).toBe("CrewhausError");
  });

  test("toJSON serializes message and code", () => {
    const err = new CrewhausError("runtime", "oops");
    expect(err.toJSON()).toEqual({
      name: "CrewhausError",
      code: "runtime",
      message: "oops",
      cause: undefined,
    });
  });

  test("preserves cause via Error.cause", () => {
    const root = new Error("root");
    const err = new CompilerError("could not lower", root);
    expect(err.cause).toBe(root);
  });

  test("toJSON serializes a plain Error cause", () => {
    const root = new Error("root");
    const err = new CompilerError("compile failed", root);
    expect(err.toJSON().cause).toEqual({ name: "Error", message: "root" });
  });

  test("toJSON recursively serializes a CrewhausError cause", () => {
    const inner = new SpecParseError("bad yaml");
    const outer = new CompilerError("compile failed", inner);
    expect(outer.toJSON().cause).toEqual({
      name: "SpecParseError",
      code: "spec_parse",
      message: "bad yaml",
      cause: undefined,
    });
  });

  test("toJSON stringifies non-Error causes", () => {
    const err = new RuntimeError("x", "string-cause");
    expect(err.toJSON().cause).toEqual({ message: "string-cause" });
  });
});

describe("subclasses", () => {
  test("each subclass tags itself with the right code", () => {
    expect(new SpecParseError("x").code).toBe("spec_parse");
    expect(new CompilerError("x").code).toBe("compiler");
    expect(new RuntimeError("x").code).toBe("runtime");
    expect(new ConfigError("x").code).toBe("config");
    expect(new McpError("x").code).toBe("mcp");
    expect(new McpConnectionError("x").code).toBe("mcp");
    expect(new McpProtocolError("x").code).toBe("mcp");
  });

  test("each subclass has a stable name (for instanceof / log filtering)", () => {
    expect(new SpecParseError("x").name).toBe("SpecParseError");
    expect(new CompilerError("x").name).toBe("CompilerError");
    expect(new RuntimeError("x").name).toBe("RuntimeError");
    expect(new ConfigError("x").name).toBe("ConfigError");
    expect(new McpError("x").name).toBe("McpError");
    expect(new McpConnectionError("x").name).toBe("McpConnectionError");
    expect(new McpProtocolError("x").name).toBe("McpProtocolError");
  });

  test("subclasses are instanceof their parent", () => {
    expect(new SpecParseError("x")).toBeInstanceOf(CrewhausError);
    expect(new CompilerError("x")).toBeInstanceOf(CrewhausError);
    expect(new RuntimeError("x")).toBeInstanceOf(CrewhausError);
    expect(new ConfigError("x")).toBeInstanceOf(CrewhausError);
    expect(new McpError("x")).toBeInstanceOf(CrewhausError);
    expect(new McpConnectionError("x")).toBeInstanceOf(McpError);
    expect(new McpProtocolError("x")).toBeInstanceOf(McpError);
  });

  test("McpConnectionError serializes via toJSON", () => {
    const err = new McpConnectionError("connection lost", new Error("ECONNREFUSED"));
    expect(err.toJSON()).toEqual({
      name: "McpConnectionError",
      code: "mcp",
      message: "connection lost",
      cause: { name: "Error", message: "ECONNREFUSED" },
    });
  });
});

describe("AdapterError", () => {
  test("tags itself with the adapter code and captures providerId", () => {
    const err = new AdapterError("openai", "request failed");
    expect(err).toBeInstanceOf(CrewhausError);
    expect(err.code).toBe("adapter");
    expect(err.providerId).toBe("openai");
    expect(err.message).toBe("request failed");
    expect(err.name).toBe("AdapterError");
  });

  test("preserves the underlying SDK error via cause", () => {
    const sdkErr = new Error("429 rate limited");
    const err = new AdapterError("anthropic", "upstream error", sdkErr);
    expect(err.cause).toBe(sdkErr);
  });

  test("toJSON serializes the cause chain (providerId is not part of the wire shape)", () => {
    const err = new AdapterError("anthropic", "stream parse failed", new Error("EOF"));
    expect(err.toJSON()).toEqual({
      name: "AdapterError",
      code: "adapter",
      message: "stream parse failed",
      cause: { name: "Error", message: "EOF" },
    });
  });
});

// ---------------------------------------------------------------------------
// v0.3.0 Goal 6 — failure-taxonomy core.
// ---------------------------------------------------------------------------

const BILLING_REPORT: FailureReport = {
  class: "billing",
  title: "provider account out of funding",
  detail: 'Anthropic said: "Your credit balance is too low to access the Anthropic API."',
  remediation: "add credits at https://console.anthropic.com/settings/billing, then rerun.",
  exitCode: EXIT_CODES.billing,
};

describe("EXIT_CODES", () => {
  test("pins the documented exit-code table", () => {
    expect(EXIT_CODES).toEqual({
      ok: 0,
      generic: 1,
      spec: 20,
      config: 21,
      auth: 30,
      billing: 31,
      rate_limit: 32,
      crewhaus_budget: 33,
      timeout: 34,
      evaluation: 35,
      approval_pending: 36,
      tool: 40,
    });
  });
});

describe("RunFailedError", () => {
  test("carries the report and composes a one-line message from it", () => {
    const err = new RunFailedError(BILLING_REPORT);
    expect(err.report).toBe(BILLING_REPORT);
    expect(err.message).toBe(
      'run stopped — provider account out of funding: Anthropic said: "Your credit balance is too low to access the Anthropic API."',
    );
    expect(err.name).toBe("RunFailedError");
  });

  test("subclasses RuntimeError so existing CrewhausError catch sites still fire", () => {
    const err = new RunFailedError(BILLING_REPORT);
    expect(err).toBeInstanceOf(RunFailedError);
    expect(err).toBeInstanceOf(RuntimeError);
    expect(err).toBeInstanceOf(CrewhausError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("runtime");
  });

  test("preserves the offending provider error via cause", () => {
    const sdkErr = new Error("400 credit balance too low");
    const err = new RunFailedError(BILLING_REPORT, sdkErr);
    expect(err.cause).toBe(sdkErr);
    expect(err.toJSON().cause).toEqual({
      name: "Error",
      message: "400 credit balance too low",
    });
  });
});

describe("formatRunFailure", () => {
  test("renders the canonical multi-line billing failure", () => {
    expect(formatRunFailure(BILLING_REPORT)).toBe(
      [
        "✗ run stopped — provider account out of funding",
        '  Anthropic said: "Your credit balance is too low to access the Anthropic API."',
        "  Fix: add credits at https://console.anthropic.com/settings/billing, then rerun.",
        "  (exit 31)",
      ].join("\n"),
    );
  });

  test("opts.prefix replaces the leading glyph (CLI die() style)", () => {
    const out = formatRunFailure(BILLING_REPORT, { prefix: "crewhaus:" });
    expect(out.startsWith("crewhaus: run stopped — provider account out of funding\n")).toBe(true);
  });

  test("omits Fix/Docs lines when absent and still prints the exit code", () => {
    const report: FailureReport = {
      class: "unknown",
      title: "recovery failed",
      detail: "something the taxonomy cannot classify",
      exitCode: EXIT_CODES.generic,
    };
    expect(formatRunFailure(report)).toBe(
      [
        "✗ run stopped — recovery failed",
        "  something the taxonomy cannot classify",
        "  (exit 1)",
      ].join("\n"),
    );
  });

  test("renders a Docs line and indents multi-line detail", () => {
    const report: FailureReport = {
      class: "auth",
      title: "provider rejected the credentials",
      detail: "line one\nline two",
      remediation: "check the key.",
      exitCode: EXIT_CODES.auth,
      docsUrl: "https://docs.crewhaus.ai/failures#auth",
    };
    expect(formatRunFailure(report)).toBe(
      [
        "✗ run stopped — provider rejected the credentials",
        "  line one",
        "  line two",
        "  Fix: check the key.",
        "  Docs: https://docs.crewhaus.ai/failures#auth",
        "  (exit 30)",
      ].join("\n"),
    );
  });

  test("opts.notes render after Fix/Docs and before the exit line (the run --continue hint)", () => {
    const out = formatRunFailure(BILLING_REPORT, {
      prefix: "crewhaus:",
      notes: [
        "Your session is saved — `crewhaus run --continue` resumes exactly where it stopped.",
      ],
    });
    expect(out).toBe(
      [
        "crewhaus: run stopped — provider account out of funding",
        '  Anthropic said: "Your credit balance is too low to access the Anthropic API."',
        "  Fix: add credits at https://console.anthropic.com/settings/billing, then rerun.",
        "  Your session is saved — `crewhaus run --continue` resumes exactly where it stopped.",
        "  (exit 31)",
      ].join("\n"),
    );
  });

  test("empty notes array changes nothing", () => {
    expect(formatRunFailure(BILLING_REPORT, { notes: [] })).toBe(formatRunFailure(BILLING_REPORT));
  });
});

describe("isRunFailedError", () => {
  test("true for a real RunFailedError instance", () => {
    expect(isRunFailedError(new RunFailedError(BILLING_REPORT))).toBe(true);
  });

  test("true for a cross-realm structural twin (duplicated package in a bundle)", () => {
    const twin = Object.assign(new Error("run stopped — twin"), {
      name: "RunFailedError",
      report: BILLING_REPORT,
    });
    expect(isRunFailedError(twin)).toBe(true);
  });

  test("false for other errors, report-less impostors, and non-errors", () => {
    expect(isRunFailedError(new RuntimeError("recovery failed: x"))).toBe(false);
    expect(isRunFailedError(Object.assign(new Error("x"), { name: "RunFailedError" }))).toBe(false);
    expect(isRunFailedError(undefined)).toBe(false);
    expect(isRunFailedError("run stopped")).toBe(false);
  });
});

describe("toFailureReport", () => {
  test("a RunFailedError yields its own classified report", () => {
    expect(toFailureReport(new RunFailedError(BILLING_REPORT))).toBe(BILLING_REPORT);
  });

  test("any other Error synthesizes the generic report (class unknown, exit 1)", () => {
    const report = toFailureReport(new Error("boom at line 3"));
    expect(report).toEqual({
      class: "unknown",
      title: "unexpected error",
      detail: "boom at line 3",
      exitCode: EXIT_CODES.generic,
    });
  });

  test("non-Error throwables are stringified into the detail", () => {
    const report = toFailureReport("string throw");
    expect(report.class).toBe("unknown");
    expect(report.detail).toBe("string throw");
    expect(report.exitCode).toBe(1);
  });
});

describe("ProviderAuthError", () => {
  test("is an AdapterError with the adapter code and a stable name", () => {
    const err = new ProviderAuthError("openai", "missing OPENAI_API_KEY");
    expect(err).toBeInstanceOf(AdapterError);
    expect(err).toBeInstanceOf(CrewhausError);
    expect(err.code).toBe("adapter");
    expect(err.providerId).toBe("openai");
    expect(err.name).toBe("ProviderAuthError");
  });

  test("toJSON reports the ProviderAuthError name", () => {
    const err = new ProviderAuthError("anthropic", "invalid credentials");
    expect(err.toJSON()).toEqual({
      name: "ProviderAuthError",
      code: "adapter",
      message: "invalid credentials",
      cause: undefined,
    });
  });
});
