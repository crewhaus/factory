import { describe, expect, test } from "bun:test";
import { createLogger } from "@crewhaus/logging";
import { createRunContext } from "./index";

describe("createRunContext defaults", () => {
  test("generates run/session ids with expected prefixes", () => {
    const ctx = createRunContext();
    expect(ctx.runId).toMatch(/^run_[0-9a-f]{8}$/);
    // session-store path-traversal guard requires sess_<16 hex>; the
    // default factory matches that format so runtime-core can hand the
    // id straight to sessionStore.create({ id }).
    expect(ctx.sessionId).toMatch(/^sess_[0-9a-f]{16}$/);
  });

  test("starts turnNumber at 0", () => {
    const ctx = createRunContext();
    expect(ctx.turnNumber).toBe(0);
  });

  test("turnNumber is mutable in place", () => {
    const ctx = createRunContext();
    ctx.turnNumber += 1;
    expect(ctx.turnNumber).toBe(1);
  });

  test("default abortSignal is not aborted", () => {
    const ctx = createRunContext();
    expect(ctx.abortSignal.aborted).toBe(false);
  });

  test("two contexts get different run/session ids", () => {
    const a = createRunContext();
    const b = createRunContext();
    expect(a.runId).not.toBe(b.runId);
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  test("logger child binds runId/sessionId on every log line", () => {
    const lines: string[] = [];
    const logger = createLogger({
      format: "json",
      sink: (line) => {
        lines.push(line);
      },
    });
    const ctx = createRunContext({ logger });
    ctx.logger.info("hello");
    expect(lines.length).toBe(1);
    const line = lines[0];
    if (line === undefined) throw new Error("expected a log line");
    const parsed = JSON.parse(line);
    expect(parsed.runId).toBe(ctx.runId);
    expect(parsed.sessionId).toBe(ctx.sessionId);
    expect(parsed.msg).toBe("hello");
  });
});

describe("createRunContext overrides", () => {
  test("custom runId/sessionId pass through verbatim", () => {
    const ctx = createRunContext({ runId: "run_custom", sessionId: "sess_custom" });
    expect(ctx.runId).toBe("run_custom");
    expect(ctx.sessionId).toBe("sess_custom");
  });

  test("custom abortSignal is exposed", () => {
    const ac = new AbortController();
    const ctx = createRunContext({ abortSignal: ac.signal });
    expect(ctx.abortSignal.aborted).toBe(false);
    ac.abort();
    expect(ctx.abortSignal.aborted).toBe(true);
  });
});
