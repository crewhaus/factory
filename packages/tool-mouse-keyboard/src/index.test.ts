import { describe, expect, test } from "bun:test";
import type { Driver } from "@crewhaus/computer-use-driver";
import {
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

  test("createAllMouseKeyboardTools returns the four named tools", () => {
    const { driver } = recordingDriver();
    const tools = createAllMouseKeyboardTools({ driver });
    expect(tools.click.name).toBe("Click");
    expect(tools.type.name).toBe("Type");
    expect(tools.key.name).toBe("Key");
    expect(tools.scroll.name).toBe("Scroll");
  });

  test("driver errors are surfaced as tool result strings (not thrown)", async () => {
    const driver: Driver = {
      backend: "chromium",
      async connect() {},
      async goto() {},
      async screenshot() {
        return new Uint8Array();
      },
      async click() {
        throw new Error("driver explosion");
      },
      async type() {},
      async key() {},
      async scroll() {},
      async getViewport() {
        return { width: 0, height: 0, devicePixelRatio: 1 };
      },
      async disconnect() {},
    };
    const tool = createClickTool({ driver });
    const r = await tool.execute({ x: 1, y: 1 }, {});
    expect(typeof r === "string" && r.includes("[Click error]")).toBe(true);
  });
});
