import { describe, expect, test } from "bun:test";
import type { Driver } from "@crewhaus/computer-use-driver";
import { NavigateError, createNavigateTool } from "./index.js";

type GotoRecord = { calls: string[] };

function stubDriver(record: GotoRecord, opts: { gotoErr?: Error } = {}): Driver {
  return {
    backend: "chromium",
    async connect() {},
    async goto(url: string) {
      record.calls.push(url);
      if (opts.gotoErr) throw opts.gotoErr;
    },
    async screenshot() {
      return new Uint8Array(0);
    },
    async click() {},
    async type() {},
    async key() {},
    async scroll() {},
    async getViewport() {
      return { width: 800, height: 600, devicePixelRatio: 1 };
    },
    async disconnect() {},
  };
}

describe("createNavigateTool", () => {
  test("happy path: forwards url to driver.goto and returns a text confirmation", async () => {
    const record: GotoRecord = { calls: [] };
    const tool = createNavigateTool({ driver: stubDriver(record) });

    const result = await tool.execute({ url: "https://example.com/" }, {});
    expect(record.calls).toEqual(["https://example.com/"]);
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) throw new Error("expected ToolResultContent array");
    expect(result).toHaveLength(1);
    const block = result[0];
    if (block?.type !== "text") throw new Error("expected text block");
    expect(block.text).toBe("navigated to https://example.com/");
  });

  test("schema rejects non-URL strings (and missing url)", () => {
    const record: GotoRecord = { calls: [] };
    const tool = createNavigateTool({ driver: stubDriver(record) });
    expect(() => tool.inputSchema.parse({ url: "not-a-url" })).toThrow();
    expect(() => tool.inputSchema.parse({})).toThrow();
  });

  test("driver.goto failure surfaces as NavigateError with the URL in the message", async () => {
    const record: GotoRecord = { calls: [] };
    const tool = createNavigateTool({
      driver: stubDriver(record, { gotoErr: new Error("net::ERR_NAME_NOT_RESOLVED") }),
    });
    try {
      await tool.execute({ url: "https://does-not-exist.invalid/" }, {});
      throw new Error("expected NavigateError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NavigateError);
      expect((err as Error).message).toContain("https://does-not-exist.invalid/");
      expect((err as Error).message).toContain("net::ERR_NAME_NOT_RESOLVED");
    }
  });

  test("flag profile: default-allowed, external scope, classifier off", () => {
    const record: GotoRecord = { calls: [] };
    const tool = createNavigateTool({ driver: stubDriver(record) });
    // destructive: false → permission-engine allows in default mode.
    // Navigation is the agent's bootstrap; gating it behind alwaysAllow
    // would silently break every browser spec without explicit rules.
    expect(tool.destructive).toBe(false);
    expect(tool.readOnly).toBe(false);
    expect(tool.classifyOutput).toBe(false);
    expect(tool.scope).toBe("external");
    expect(tool.name).toBe("Navigate");
  });
});
