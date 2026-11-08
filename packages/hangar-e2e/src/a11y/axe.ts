/**
 * axe, injected as a source string with `page.evaluate`. Never `bypassCSP`: a
 * browser context with that set would test a page no user ever gets.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";

/** `target-size` lives under `wcag22aa`. */
export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] as const;

/** How many node selectors a failure message names per rule. */
export const SAMPLES_PER_RULE = 5;

export type AxeResult = {
  /** Rule id to number of nodes. Selectors churn, so only counts are kept. */
  readonly violations: Readonly<Record<string, number>>;
  /**
   * Rule id to up to {@link SAMPLES_PER_RULE} node targets, for a failure
   * message only. Never written to the baseline or the report: selectors
   * churn, and a report that changed with every class name would be noise.
   */
  readonly samples: Readonly<Record<string, readonly string[]>>;
  /** How many rules passed. Zero means axe did not really run. */
  readonly passes: number;
  /** The version of axe that ran. */
  readonly version: string;
};

let source: string | undefined;

function axeSource(): string {
  source ??= readFileSync(fileURLToPath(import.meta.resolve("axe-core/axe.min.js")), "utf8");
  return source;
}

/** Run axe over the document, injecting it first if this document lacks it. */
export async function runAxe(page: Page): Promise<AxeResult> {
  const present = await page.evaluate(() => "axe" in globalThis);
  if (!present) await page.evaluate(axeSource());
  return await page.evaluate(
    async ({ tags, perRule }) => {
      const axe = (
        globalThis as unknown as {
          axe: {
            version: string;
            run(
              context: unknown,
              options: unknown,
            ): Promise<{
              violations: Array<{ id: string; nodes: Array<{ target?: unknown }> }>;
              passes: unknown[];
            }>;
          };
        }
      ).axe;
      const results = await axe.run(document, { runOnly: { type: "tag", values: tags } });
      const violations: Record<string, number> = {};
      const samples: Record<string, string[]> = {};
      for (const violation of results.violations) {
        violations[violation.id] = violation.nodes.length;
        samples[violation.id] = violation.nodes
          .slice(0, perRule)
          .map((node) =>
            Array.isArray(node.target) ? node.target.join(" ") : String(node.target),
          );
      }
      return { violations, samples, passes: results.passes.length, version: axe.version };
    },
    { tags: AXE_TAGS as unknown as string[], perRule: SAMPLES_PER_RULE },
  );
}
