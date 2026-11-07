/** Under `prefers-reduced-motion: reduce`, nothing is animating. */
import type { Page } from "playwright";
import type { A11yFinding } from "./finding";

/** Ask for reduced motion, and report every animation still running. */
export async function reducedMotionFindings(page: Page): Promise<readonly A11yFinding[]> {
  await page.emulateMedia({ reducedMotion: "reduce" });
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
