import { describe, expect, test } from "bun:test";
import type { Driver } from "@crewhaus/computer-use-driver";
import { auditToolScopes } from "@crewhaus/tool-builder";
import { executeTool } from "@crewhaus/tool-executor";
import {
  MouseKeyboardError,
  createAllMouseKeyboardTools,
  createClickTool,
  createKeyTool,
  createScrollTool,
  createTypeTool,
} from "./index.js";

function recordingDriver(): { driver: Driver; calls: string[] } {
  const calls: string[] = [];
  const driver: Driver = {
    backend: "chromium",
    async connect() {},
    async goto() {},
    async screenshot() {
      return new Uint8Array();
    },
    async click(x, y, button = "left") {
      calls.push(`click ${button} ${x} ${y}`);
    },
    async type(text) {
      calls.push(`type ${text}`);
    },
    async key(combo) {
      calls.push(`key ${combo}`);
    },
    async scroll(dx, dy) {
      calls.push(`scroll ${dx} ${dy}`);
    },
    async getViewport() {
      return { width: 800, height: 600, devicePixelRatio: 1 };
    },
    async disconnect() {},
  };
  return { driver, calls };
}

// A driver whose single named method rejects with `thrown` (any value, not
// only an Error); all others are inert no-ops. Lets each tool's failure path
// be exercised in isolation.
function throwingDriver(method: "click" | "type" | "key" | "scroll", thrown: unknown): Driver {
  const base: Driver = {
    backend: "chromium",
    async connect() {},
    async goto() {},
    async screenshot() {
      return new Uint8Array();
    },
    async click() {},
    async type() {},
    async key() {},
    async scroll() {},
    async getViewport() {
      return { width: 0, height: 0, devicePixelRatio: 1 };
    },
    async disconnect() {},
  };
  return {
    ...base,
    [method]: async () => {
      throw thrown;
    },
  };
}

describe("Mouse + keyboard tools (T1 wrapping)", () => {
  test("Click forwards (x, y, button) to driver.click", async () => {
    const { driver, calls } = recordingDriver();
    const tool = createClickTool({ driver });
    const r = await tool.execute({ x: 100, y: 200, button: "left" }, {});
    expect(calls).toEqual(["click left 100 200"]);
    expect(typeof r === "string" && r.includes("Clicked left at (100, 200)")).toBe(true);
  });

  test("Click default button is left", async () => {
    const { driver, calls } = recordingDriver();
    const tool = createClickTool({ driver });
    await tool.execute({ x: 1, y: 2 }, {});
    expect(calls).toEqual(["click left 1 2"]);
  });

  test("Type forwards text", async () => {
    const { driver, calls } = recordingDriver();
    const tool = createTypeTool({ driver });
    await tool.execute({ text: "hello" }, {});
    expect(calls).toEqual(["type hello"]);
  });

  test("Key forwards combo", async () => {
    const { driver, calls } = recordingDriver();
    const tool = createKeyTool({ driver });
    await tool.execute({ combo: "Enter" }, {});
    expect(calls).toEqual(["key Enter"]);
  });

  test("Scroll forwards dx/dy", async () => {
    const { driver, calls } = recordingDriver();
    const tool = createScrollTool({ driver });
    await tool.execute({ dx: 0, dy: 100 }, {});
    expect(calls).toEqual(["scroll 0 100"]);
  });

  test("All four tools are destructive: true (T8 — permission floor)", () => {
    const { driver } = recordingDriver();
    const tools = createAllMouseKeyboardTools({ driver });
    expect(tools.click.destructive).toBe(true);
    expect(tools.type.destructive).toBe(true);
    expect(tools.key.destructive).toBe(true);
    expect(tools.scroll.destructive).toBe(true);
  });

  // 0.7.1 (C046): what is typed into a page, the page's script can send.
  // Type, Key and Click are egress sinks; Scroll carries no data.
  test("Type, Key and Click are external with ioCapability network; Scroll stays internal", () => {
    const { driver } = recordingDriver();
    const tools = createAllMouseKeyboardTools({ driver });
    const flags = Object.values(tools).map((t) => `${t.name}:${t.scope}:${t.ioCapability ?? "-"}`);
    expect(flags).toEqual([
      "Click:external:network",
      "Type:external:network",
      "Key:external:network",
      "Scroll:internal:-",
    ]);
    expect(auditToolScopes(Object.values(tools))).toEqual([]);
    // Unchanged: every one still asks (destructive), none opts into the classifier.
    expect(Object.values(tools).every((t) => t.destructive && t.classifyOutput === false)).toBe(
      true,
    );
  });

  test("createAllMouseKeyboardTools returns the four named tools", () => {
    const { driver } = recordingDriver();
    const tools = createAllMouseKeyboardTools({ driver });
    expect(tools.click.name).toBe("Click");
    expect(tools.type.name).toBe("Type");
    expect(tools.key.name).toBe("Key");
    expect(tools.scroll.name).toBe("Scroll");
  });
});

/**
 * 0.7.1 (C206) — a driver failure is a failed call. These tools used to catch
 * it and return "[Click error] …" as an ordinary result, so the run recorded a
 * click or keystroke that never happened as a success (is_error false, no
 * tool_stats error, nothing for a grader to see), while Navigate and
 * Screenshot, on the same driver, reported theirs as errors.
 */
describe("a driver failure is reported as a failed call", () => {
  const cases = [
    { tool: "Click", method: "click", make: createClickTool, input: { x: 1, y: 1 } },
    { tool: "Type", method: "type", make: createTypeTool, input: { text: "hi" } },
    { tool: "Key", method: "key", make: createKeyTool, input: { combo: "Enter" } },
    { tool: "Scroll", method: "scroll", make: createScrollTool, input: { dx: 0, dy: 5 } },
  ] as const;

  test("each tool throws MouseKeyboardError carrying the driver's error", async () => {
    let checked = 0;
    for (const c of cases) {
      const root = new Error("page crashed: Target closed");
      const tool = c.make({ driver: throwingDriver(c.method, root) });
      const err = await tool.execute(c.input, {}).then(
        (r) => r,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(MouseKeyboardError);
      // The text the model sees is the one it saw before, prefix included.
      expect((err as MouseKeyboardError).message).toBe(
        `[${c.tool} error] page crashed: Target closed`,
      );
      expect((err as MouseKeyboardError).cause).toBe(root);
      checked += 1;
    }
    expect(checked).toBe(4);
  });

  test("through the executor the call is an error, with the driver's text", async () => {
    const seen: string[] = [];
    for (const c of cases) {
      const tool = c.make({
        driver: throwingDriver(c.method, new Error("page crashed: Target closed")),
      });
      const r = await executeTool(tool, c.input, { toolUseId: `t-${c.tool}` });
      seen.push(`${c.tool}:${r.isError}:${String(r.content)}`);
    }
    expect(seen).toEqual([
      "Click:true:[Click error] page crashed: Target closed",
      "Type:true:[Type error] page crashed: Target closed",
      "Key:true:[Key error] page crashed: Target closed",
      "Scroll:true:[Scroll error] page crashed: Target closed",
    ]);
  });

  test("a call the driver completes is still a success", async () => {
    const seen: string[] = [];
    for (const c of cases) {
      const { driver } = recordingDriver();
      const r = await executeTool(c.make({ driver }), c.input, { toolUseId: `ok-${c.tool}` });
      seen.push(`${c.tool}:${r.isError}`);
    }
    expect(seen).toEqual(["Click:false", "Type:false", "Key:false", "Scroll:false"]);
  });

  // `(err as Error).message ?? String(err)` read `.message` off whatever was
  // thrown, so a driver that threw null or undefined crashed the catch with a
  // TypeError that named neither the tool nor the failure.
  test("a value that is not an Error is read without a second throw", async () => {
    const unprintable = Object.create(null) as object;
    const thrownValues: ReadonlyArray<readonly [unknown, string]> = [
      ["raw string failure", "[Click error] raw string failure"],
      [null, "[Click error] null"],
      [undefined, "[Click error] undefined"],
      [42, "[Click error] 42"],
      [unprintable, "[Click error] the driver threw a value that has no text"],
      [new Error(""), "[Click error] Error"],
    ];
    const messages: string[] = [];
    for (const [thrown, expected] of thrownValues) {
      const tool = createClickTool({ driver: throwingDriver("click", thrown) });
      const err = await tool.execute({ x: 1, y: 1 }, {}).then(
        (r) => r,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(MouseKeyboardError);
      expect((err as MouseKeyboardError).cause).toBe(thrown);
      messages.push((err as MouseKeyboardError).message);
      expect((err as MouseKeyboardError).message).toBe(expected);
    }
    expect(messages).toHaveLength(thrownValues.length);
  });
});

describe("MouseKeyboardError", () => {
  test("constructs with the 'tool' error code and a stable name", () => {
    const err = new MouseKeyboardError("input device unavailable");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("MouseKeyboardError");
    expect(err.message).toBe("input device unavailable");
    expect(err.code).toBe("tool");
    expect(err.cause).toBeUndefined();
  });

  test("threads an underlying cause through to the base error", () => {
    const root = new Error("driver socket closed");
    const err = new MouseKeyboardError("scroll failed", root);
    expect(err.cause).toBe(root);
    expect(err.code).toBe("tool");
  });
});
