/**
 * Catalog R4 `tool-navigate` — Section 25 BROW.
 *
 * `Navigate(url)` tool. Drives `driver.goto(url)` so the browser agent
 * can bootstrap to a starting page. Returns a short text confirmation
 * the model can read back; surfaces playwright errors verbatim (e.g.
 * unreachable host, navigation timeout) so the model can recover or
 * report the failure.
 *
 * Flag profile: `destructive: false` (default-allowed). Navigation is
 * the agent's only bootstrap path — gating it behind an `alwaysAllow`
 * rule would silently break every spec that doesn't define one. The
 * §3 permission-engine still applies the user's explicit `alwaysDeny`
 * rules; Click/Type/Key/Scroll stay destructive-by-default in
 * `tool-mouse-keyboard`.
 *
 * Scope is `"external"` because the URL request crosses a network
 * boundary; the §3 egress-classifier can hook in here later. Output
 * classification is off — the response is a deterministic short string,
 * not model-generated content.
 */
import type { Driver } from "@crewhaus/computer-use-driver";
import { CrewhausError } from "@crewhaus/errors";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolResultContent } from "@crewhaus/tool-catalog";
import { z } from "zod";

export class NavigateError extends CrewhausError {
  override readonly name = "NavigateError";
  constructor(message: string, cause?: unknown) {
    super("tool", message, cause);
  }
}

const navigateSchema = z
  .object({
    /** Absolute URL to navigate to (http/https). */
    url: z.string().url(),
  })
  .strict();

export type CreateNavigateToolOptions = {
  readonly driver: Driver;
};

export function createNavigateTool(opts: CreateNavigateToolOptions): RegisteredTool {
  return buildTool({
    name: "Navigate",
    description:
      "Navigate the browser to a URL. Call this first to load a starting page (e.g. a search engine, documentation site, or known landing page) before using Screenshot/FindElement/Click/Type. Returns a short confirmation; pair with Screenshot to see what loaded.",
    inputSchema: navigateSchema,
    readOnly: false,
    destructive: false,
    concurrencySafe: false,
    classifyOutput: false,
    scope: "external",
    execute: async (input): Promise<ToolResultContent> => {
      try {
        await opts.driver.goto(input.url);
      } catch (err) {
        throw new NavigateError(
          `navigation to ${input.url} failed: ${(err as Error).message}`,
          err,
        );
      }
      return [{ type: "text", text: `navigated to ${input.url}` }];
    },
  });
}
