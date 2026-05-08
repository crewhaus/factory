import { describe, expect, test } from "bun:test";
import type { Driver } from "@crewhaus/computer-use-driver";
import { createScreenshotTool } from "./index.js";

function stubDriver(pngBytes: Uint8Array): Driver {
  return {
    backend: "chromium",
    async connect() {},
    async goto() {},
    async screenshot() {
      return pngBytes;
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

describe("createScreenshotTool", () => {
  test("returns an Anthropic image content block with base64 PNG data (T1)", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const driver = stubDriver(png);
    const tool = createScreenshotTool({ driver });

    const result = await tool.execute({ reason: "smoke" }, {});
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) throw new Error("expected ToolResultContent array");
    expect(result).toHaveLength(1);
    const block = result[0];
    if (block?.type !== "image") throw new Error("expected image block");
    expect(block.source.type).toBe("base64");
    expect(block.source.media_type).toBe("image/png");
    // Decode → matches input bytes.
    const decoded = Buffer.from(block.source.data, "base64");
    expect(Array.from(decoded)).toEqual(Array.from(png));
  });

  test("flag profile: read-only, not destructive, classifier off (controlled output)", () => {
    const driver = stubDriver(new Uint8Array(0));
    const tool = createScreenshotTool({ driver });
    expect(tool.readOnly).toBe(true);
    expect(tool.destructive).toBe(false);
    expect(tool.classifyOutput).toBe(false);
    expect(tool.name).toBe("Screenshot");
  });
});
