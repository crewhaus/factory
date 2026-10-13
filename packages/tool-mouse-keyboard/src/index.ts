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
 *
 * Pillar 3 (0.7.1): `Type`, `Key` and `Click` act on a page that is
 * connected to the network (the one `Navigate` loaded, or with the `host`
 * backend whatever app has focus), and that page's script can read and send
 * what is typed into it. So they are `scope: "external"` with
 * `ioCapability: "network"`: `Type`'s text and `Key`'s combo go through the
 * egress classifier, on the warn tier (`external-configured`), and the
 * strict audit counts them. `Click`'s payload is only coordinates, so the
 * classifier finds nothing in it; it is external because a click submits
 * what was typed. `Scroll` carries no data and moves nothing off the page,
 * so it stays internal.
 *
 * Failures (0.7.1): a driver failure throws a `MouseKeyboardError`, as
 * `Navigate` and `Screenshot` do, so the run records the call as failed
 * (`is_error`, `tool_stats` error counts, eval graders). The message keeps
 * the `[Click error] …` text the model saw before. These tools used to
 * return that text as an ordinary result, so a click or keystroke that
 * never happened was recorded as a success.
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

/**
 * The error a tool throws when the driver fails. Keeps the `[<Tool> error]`
 * prefix, and reads any thrown value (a string, `null`, an object without a
 * usable `toString`) without throwing again.
 */
function driverFailed(tool: "Click" | "Type" | "Key" | "Scroll", err: unknown): MouseKeyboardError {
  let detail: string;
  if (err instanceof Error) {
    detail = err.message !== "" ? err.message : err.name;
  } else {
    try {
      detail = String(err);
    } catch {
      detail = "the driver threw a value that has no text";
    }
  }
  return new MouseKeyboardError(`[${tool} error] ${detail}`, err);
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
    scope: "external",
    ioCapability: "network",
    execute: async (input) => {
      const button: MouseButton = input.button ?? "left";
      try {
        await opts.driver.click(input.x, input.y, button);
      } catch (err) {
        throw driverFailed("Click", err);
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
    scope: "external",
    ioCapability: "network",
    execute: async (input) => {
      try {
        await opts.driver.type(input.text);
      } catch (err) {
        throw driverFailed("Type", err);
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
    scope: "external",
    ioCapability: "network",
    execute: async (input) => {
      try {
        await opts.driver.key(input.combo);
      } catch (err) {
        throw driverFailed("Key", err);
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
        throw driverFailed("Scroll", err);
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
