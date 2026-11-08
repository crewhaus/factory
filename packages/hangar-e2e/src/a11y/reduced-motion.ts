/** Under `prefers-reduced-motion: reduce`, nothing is animating. */
import type { Page } from "playwright";
import type { A11yFinding } from "./finding";

/**
 * Ask for reduced motion, and report every animation still running. With
 * `{ emulate: false }` it leaves the media query as the caller set it, so a
 * page's own reduce switch (an attribute, not the media query) is what is
 * tested: called as it stands, the helper would turn the media query on
 * itself, and a page with no rule of its own would pass.
 */
export async function reducedMotionFindings(
  page: Page,
  opts: { readonly emulate?: boolean } = {},
): Promise<readonly A11yFinding[]> {
  if (opts.emulate !== false) await page.emulateMedia({ reducedMotion: "reduce" });
  const animations = await page.evaluate(() =>
    document.getAnimations().map((animation) => {
      const target =
        animation.effect instanceof KeyframeEffect ? animation.effect.target?.tagName : undefined;
      const name = (animation as Animation & { animationName?: string }).animationName;
      return `${name ?? animation.id ?? "animation"} on ${target ?? "unknown"}`;
    }),
  );
  return animations.map((detail) => ({ rule: "motion-not-reduced", detail }));
}
