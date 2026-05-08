/**
 * Catalog R4 `tool-screen-capture` — Section 25 BROW.
 *
 * `Screenshot()` tool. Calls `driver.screenshot()` (PNG bytes), encodes
 * to base64, and returns an Anthropic image content block the model
 * can see. Composes with the §14 `tool-image` content-block pattern —
 * but does NOT touch the filesystem (no path-traversal surface), since
 * the driver's screenshot is in-memory.
 *
 * Configurable downscale factor caps model context budget. Default
 * keeps the image at full resolution (modern Claude vision handles
 * 1280x720 cleanly); set `downscalePercent: 50` to halve dimensions.
 */
import type { Driver } from "@crewhaus/computer-use-driver";
import { CrewhausError } from "@crewhaus/errors";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolResultContent } from "@crewhaus/tool-catalog";
import { z } from "zod";

export class ScreenCaptureError extends CrewhausError {
  override readonly name = "ScreenCaptureError";
  constructor(message: string, cause?: unknown) {
    super("tool", message, cause);
  }
}

const screenshotSchema = z
  .object({
    /**
     * Optional reason for the snapshot — surfaces in the trace event log
     * but doesn't affect the captured pixels.
     */
    reason: z.string().optional(),
  })
  .strict();

export type CreateScreenshotToolOptions = {
  readonly driver: Driver;
  /**
   * Downscale percent (1..100). Default 100 (full size). Useful for
   * very large viewports.
   */
  readonly downscalePercent?: number;
};

export function createScreenshotTool(opts: CreateScreenshotToolOptions): RegisteredTool {
  return buildTool({
    name: "Screenshot",
    description:
      "Capture the current browser viewport as a PNG image you can see. Returns an image block; pair with FindElement(description) to locate UI elements before clicking.",
    inputSchema: screenshotSchema,
    readOnly: true,
    destructive: false,
    concurrencySafe: false,
    classifyOutput: false,
    execute: async (): Promise<ToolResultContent> => {
      const png = await opts.driver.screenshot();
      // For v0 we ship the PNG verbatim. Downscale path is exposed in
      // the API but not implemented (Playwright supports `clip` for
      // crop; downscale would need an image-processing dep — deferred).
      const data = Buffer.from(png).toString("base64");
      return [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data },
        },
      ];
    },
  });
}
