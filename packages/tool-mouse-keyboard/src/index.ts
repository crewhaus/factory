/**
 * Catalog R4 `tool-mouse-keyboard` — Section 25 BROW.
 *
 * Wraps `computer-use-driver` mouse + keyboard methods 1:1 as
 * registered tools. ALL FOUR are `destructive: true` so the §3
 * permission-engine refuses to grant `allow` in default mode without
 * an explicit `alwaysAllow` rule. The smoke's permission-floor probe
 * exercises this path: same spec WITHOUT alwaysAllow rules → denial
 * cites the destructive flag + missing rule.
 *
 * Tools:
 *   - `Click(x, y, button?)` — `left | right | middle` click.
 *   - `Type(text)`           — typed input.
 *   - `Key(combo)`           — special-key combos ("Enter", "Tab", "Control+a").
 *   - `Scroll(dx, dy)`       — wheel scroll in pixels.
 */
import type { Driver, MouseButton } from "@crewhaus/computer-use-driver";
import { CrewhausError } from "@crewhaus/errors";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";

export class MouseKeyboardError extends CrewhausError {
  override readonly name = "MouseKeyboardError";
  constructor(message: string, cause?: unknown) {
    super("tool", message, cause);
  }
}

export type CreateMouseKeyboardToolsOptions = {
  readonly driver: Driver;
};

const clickSchema = z
  .object({
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    button: z.enum(["left", "right", "middle"]).optional(),
  })
  .strict();

const typeSchema = z.object({ text: z.string() }).strict();

const keySchema = z
  .object({
    combo: z
      .string()
      .min(1)
      .describe(
        "Single key or combo, e.g. 'Enter', 'Tab', 'Control+a'. Uses Playwright's key naming.",
      ),
  })
  .strict();

const scrollSchema = z
  .object({
    dx: z.number().int(),
    dy: z.number().int(),
  })
  .strict();

export function createClickTool(opts: CreateMouseKeyboardToolsOptions): RegisteredTool {
  return buildTool({
    name: "Click",
    description:
      "Click at viewport pixel coordinates (x, y). Defaults to left button. Use FindElement(description) to get coordinates from a natural-language target. DESTRUCTIVE: requires explicit alwaysAllow rule.",
    inputSchema: clickSchema,
    readOnly: false,
    destructive: true,
    concurrencySafe: false,
    classifyOutput: false,
    execute: async (input) => {
      const button: MouseButton = input.button ?? "left";
      try {
        await opts.driver.click(input.x, input.y, button);
      } catch (err) {
        return `[Click error] ${(err as Error).message ?? String(err)}`;
      }
      return `Clicked ${button} at (${input.x}, ${input.y}).`;
    },
  });
}

export function createTypeTool(opts: CreateMouseKeyboardToolsOptions): RegisteredTool {
  return buildTool({
    name: "Type",
    description:
      "Type text at the focused input. Click an input first to focus it. DESTRUCTIVE: requires explicit alwaysAllow rule.",
    inputSchema: typeSchema,
    readOnly: false,
    destructive: true,
    concurrencySafe: false,
    classifyOutput: false,
    execute: async (input) => {
      try {
        await opts.driver.type(input.text);
      } catch (err) {
        return `[Type error] ${(err as Error).message ?? String(err)}`;
      }
      return `Typed ${input.text.length} chars.`;
    },
  });
}

export function createKeyTool(opts: CreateMouseKeyboardToolsOptions): RegisteredTool {
  return buildTool({
    name: "Key",
    description:
      "Press a single key or combo (e.g. 'Enter', 'Tab', 'Control+a'). Uses Playwright's key naming. DESTRUCTIVE: requires explicit alwaysAllow rule.",
    inputSchema: keySchema,
    readOnly: false,
    destructive: true,
    concurrencySafe: false,
    classifyOutput: false,
    execute: async (input) => {
      try {
        await opts.driver.key(input.combo);
      } catch (err) {
        return `[Key error] ${(err as Error).message ?? String(err)}`;
      }
      return `Pressed ${input.combo}.`;
    },
  });
}

export function createScrollTool(opts: CreateMouseKeyboardToolsOptions): RegisteredTool {
  return buildTool({
    name: "Scroll",
    description:
      "Scroll by pixel deltas. Positive dy scrolls down. DESTRUCTIVE: requires explicit alwaysAllow rule.",
    inputSchema: scrollSchema,
    readOnly: false,
    destructive: true,
    concurrencySafe: false,
    classifyOutput: false,
    execute: async (input) => {
      try {
        await opts.driver.scroll(input.dx, input.dy);
      } catch (err) {
        return `[Scroll error] ${(err as Error).message ?? String(err)}`;
      }
      return `Scrolled (${input.dx}, ${input.dy}).`;
    },
  });
}

export function createAllMouseKeyboardTools(opts: CreateMouseKeyboardToolsOptions): {
  click: RegisteredTool;
  type: RegisteredTool;
  key: RegisteredTool;
  scroll: RegisteredTool;
} {
  return {
    click: createClickTool(opts),
    type: createTypeTool(opts),
    key: createKeyTool(opts),
    scroll: createScrollTool(opts),
  };
}
