/** Each accessibility helper, against a page planted to trip it and a clean one. */
import type { Page } from "playwright";
import { ariaSnapshot } from "../a11y/aria";
import { AXE_TAGS, runAxe } from "../a11y/axe";
import type { A11yFinding } from "../a11y/finding";
import { focusObscuredFinding } from "../a11y/focus-obscured";
import { escapeFinding, focusVisibleFinding, keyboardTrapFinding } from "../a11y/keyboard";
import { reducedMotionFindings } from "../a11y/reduced-motion";
import { REFLOW_WIDTH, reflowFinding } from "../a11y/reflow";
import { textSpacingFindings } from "../a11y/text-spacing";
import { openSession } from "../session";
import type { Journey } from "./journey";
import { plantedHtml, servePlantedPages } from "./planted-pages";

const css = (body: string) => ({ type: "text/css", body });
const js = (body: string) => ({ type: "text/javascript", body });
const sheet = '<link rel="stylesheet" href="/assets/plant.css">';
const code = '<script type="module" src="/assets/plant.js"></script>';

/** Every page is served under the strict CSP, so nothing here may be inline. */
const PAGES = {
  clean: {
    html: plantedHtml(
      `<main><h1>Clean</h1><p class="spaced">Some text that can grow.</p>
       <button class="wide" id="open">Open</button> <a class="wide" href="#x">A link</a>
       <div id="overlay" hidden><button class="wide" id="inner">Close</button></div></main>`,
      `${sheet}${code}`,
    ),
  },
  axe: {
    html: `<!doctype html><html><head><meta charset="utf-8"><title>Plant</title></head><body><main><h1>Plant</h1><button></button><img src="/assets/pixel.svg"></main></body></html>`,
  },
  "target-size": {
    html: plantedHtml(
      `<main><h1>Plant</h1><button class="tiny" aria-label="one"></button><button class="tiny" aria-label="two"></button></main>`,
      sheet,
    ),
  },
  trap: {
    html: plantedHtml(
      `<main><h1>Plant</h1><button id="first">One</button> <button id="trap">Two</button> <button>Three</button></main>`,
      `${sheet}${code}`,
    ),
  },
  "trap-last": {
    html: plantedHtml(
      `<main><h1>Plant</h1><button>One</button> <button id="trap">Two</button></main>`,
      `${sheet}${code}`,
    ),
  },
  "trap-only": {
    html: plantedHtml(
      `<main><h1>Plant</h1><button id="trap">Only</button></main>`,
      `${sheet}${code}`,
    ),
  },
  "trap-cycle": {
    html: plantedHtml(
      `<main><h1>Plant</h1><button id="cycle-first">One</button> <button id="cycle-last">Two</button> <button>Three</button></main>`,
      `${sheet}${code}`,
    ),
  },
  "negative-tabindex": {
    html: plantedHtml(
      `<main><h1>Clean</h1><button>One</button> <button tabindex="-1">Skipped</button> <a tabindex="-1" href="#x">Skipped</a></main>`,
      sheet,
    ),
  },
  "radio-group": {
    html: plantedHtml(
      `<main><h1>Clean</h1><button>One</button> <input type="radio" name="r" aria-label="A"> <input type="radio" name="r" aria-label="B"> <input type="radio" name="r" aria-label="C"></main>`,
      sheet,
    ),
  },
  "no-focus-ring": {
    html: plantedHtml(`<main><h1>Plant</h1><button class="bare">One</button></main>`, sheet),
  },
  "faint-focus-ring": {
    html: plantedHtml(`<main><h1>Plant</h1><button class="faint">One</button></main>`, sheet),
  },
  "transparent-focus-ring": {
    html: plantedHtml(`<main><h1>Plant</h1><button class="clear">One</button></main>`, sheet),
  },
  "low-alpha-focus-ring": {
    html: plantedHtml(`<main><h1>Plant</h1><button class="low-alpha">One</button></main>`, sheet),
  },
  "decorative-shadow": {
    html: plantedHtml(`<main><h1>Plant</h1><button class="decorative">One</button></main>`, sheet),
  },
  "shadow-ring": {
    html: plantedHtml(`<main><h1>Clean</h1><button class="shadow-ring">One</button></main>`, sheet),
  },
  "wide-element": {
    html: plantedHtml(`<main><h1>Plant</h1><div class="too-wide">Wide</div></main>`, sheet),
  },
  "text-clip": {
    html: plantedHtml(`<main><h1>Plant</h1><div class="clip">Fits as set</div></main>`, sheet),
  },
  animation: {
    html: plantedHtml(`<main><h1>Plant</h1><div class="spin">Spin</div></main>`, sheet),
  },
  "gated-animation": {
    html: plantedHtml(`<main><h1>Plant</h1><div class="gated">Spin</div></main>`, sheet),
  },
  "covered-focus": {
    html: plantedHtml(
      `<header class="cover">Fixed</header><main><button id="under" class="under">Under</button></main>`,
      sheet,
    ),
  },
  "stuck-overlay": {
    html: plantedHtml(
      `<main><button id="open">Open</button><div id="overlay" hidden><button>Close</button></div></main>`,
      code,
    ),
  },
  "lost-focus": {
    html: plantedHtml(
      `<main><button id="open">Open</button><div id="overlay" hidden><button id="inner">Close</button></div></main>`,
      code,
    ),
  },
  "blocked-inline": {
    html: plantedHtml("<main><h1>Plant</h1></main><script>globalThis.__planted = 1</script>"),
  },
} as const;

const ASSETS = {
  "/assets/pixel.svg": {
    type: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
  },
  "/assets/plant.css": css(`
    :focus-visible { outline: 2px solid rgb(0, 0, 0); outline-offset: 2px; }
    body { background: rgb(255, 255, 255); color: rgb(0, 0, 0); margin: 0; padding: 8px; }
    .wide { min-width: 48px; min-height: 48px; display: inline-block; }
    .tiny { width: 8px; height: 8px; padding: 0; border: 0; margin: 0; display: inline-block; }
    .bare:focus, .bare:focus-visible { outline: none; box-shadow: none; }
    .faint:focus, .faint:focus-visible { outline: 2px solid rgb(250, 250, 250); box-shadow: none; }
    .clear:focus, .clear:focus-visible { outline: 2px solid transparent; box-shadow: none; }
    .low-alpha:focus, .low-alpha:focus-visible { outline: 2px solid rgba(0, 0, 0, 0.1); box-shadow: none; }
    .decorative { box-shadow: 0 1px 3px rgb(0, 0, 0); }
    .decorative:focus, .decorative:focus-visible { outline: none; }
    .shadow-ring:focus, .shadow-ring:focus-visible { outline: none; box-shadow: 0 0 0 3px rgb(0, 0, 0); }
    .too-wide { width: 400px; }
    .clip { width: 200px; height: 16px; line-height: 16px; overflow: hidden; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spin { animation: spin 4s linear infinite; }
    @media (prefers-reduced-motion: no-preference) {
      .gated { animation: spin 4s linear infinite; }
    }
    .cover { position: fixed; top: 0; left: 0; right: 0; height: 120px; background: rgb(200, 200, 200); }
    .under { margin-top: 20px; }
  `),
  "/assets/plant.js": js(`
    const trap = document.getElementById("trap");
    if (trap !== null) {
      trap.addEventListener("keydown", (event) => {
        if (event.key === "Tab") event.preventDefault();
      });
    }
    const cycleLast = document.getElementById("cycle-last");
    if (cycleLast !== null) {
      cycleLast.addEventListener("keydown", (event) => {
        if (event.key !== "Tab") return;
        event.preventDefault();
        document.getElementById("cycle-first")?.focus();
      });
    }
    const open = document.getElementById("open");
    const overlay = document.getElementById("overlay");
    if (open !== null && overlay !== null) {
      const page = location.pathname;
      open.addEventListener("click", () => {
        overlay.hidden = false;
        document.getElementById("inner")?.focus();
      });
      document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || page.endsWith("stuck-overlay")) return;
        overlay.hidden = true;
        if (!page.endsWith("lost-focus")) open.focus();
      });
    }
  `),
} as const;

const fail = (helper: string, what: string): never => {
  throw new Error(`${helper} ${what}`);
};

/** The helper must report its rule on the plant. */
function expectRule(
  helper: string,
  findings: readonly (A11yFinding | undefined)[],
  rule: string,
): void {
  if (!findings.some((finding) => finding?.rule === rule)) {
    fail(helper, `went quiet on its plant: wanted ${rule}, saw ${JSON.stringify(findings)}`);
  }
}

/** The helper must report nothing on the clean page. */
function expectNothing(helper: string, findings: readonly (A11yFinding | undefined)[]): void {
  const real = findings.filter((finding) => finding !== undefined);
  if (real.length > 0) fail(helper, `fired on the clean page: ${JSON.stringify(real)}`);
}

export const a11ySelfTest: Journey = {
  id: "a11y-self-test",
  shard: "axe",
  proves:
    "Every accessibility helper reports its plant and reports nothing on a clean page, under a strict CSP header, and injecting axe leaves that policy blocking what it blocked.",
  run: async (scope) => {
    const server = servePlantedPages(PAGES, ASSETS);
    scope.defer(() => server.stop());

    const onPage = async <T>(name: keyof typeof PAGES, check: (page: Page) => Promise<T>) => {
      const session = await openSession(server.home(name), { label: `a11y-${name}` });
      try {
        const result = await check(session.page);
        // Injecting axe and setting spacing through the CSSOM must not trip the
        // policy on any page that has nothing inline of its own.
        if (name !== "blocked-inline") session.assertClean();
        return { result, failures: session.failures() };
      } finally {
        await session.close({ trace: "discard" });
      }
    };
    const clean = <T>(check: (page: Page) => Promise<T>) => onPage("clean", check);

    // axe
    const planted = (await onPage("axe", runAxe)).result;
    for (const rule of ["button-name", "image-alt", "html-has-lang"]) {
      if ((planted.violations[rule] ?? 0) < 1) {
        fail("axe", `missed ${rule}: ${JSON.stringify(planted.violations)}`);
      }
    }
    const tiny = (await onPage("target-size", runAxe)).result;
    if ((tiny.violations["target-size"] ?? 0) < 1) {
      fail("axe", `missed target-size under ${AXE_TAGS}: ${JSON.stringify(tiny.violations)}`);
    }
    const quiet = (await clean(runAxe)).result;
    if (Object.keys(quiet.violations).length > 0) {
      fail("axe", `fired on the clean page: ${JSON.stringify(quiet.violations)}`);
    }
    if (quiet.passes === 0) fail("axe", "passed no rule on the clean page, so it did not run");

    // injection does not relax the policy
    const blocked = await onPage("blocked-inline", async (page) => {
      const axe = await runAxe(page);
      const planted = await page.evaluate(
        () => (globalThis as unknown as { __planted?: unknown }).__planted,
      );
      return { axe, planted };
    });
    if (blocked.result.axe.passes === 0) fail("axe", "did not run under the strict policy");
    if (blocked.result.planted !== undefined) fail("axe", "the blocked inline script ran");
    if (!blocked.failures.some((failure) => failure.kind === "csp-violation")) {
      fail("axe", "the blocked inline script raised no CSP violation");
    }

    // keyboard: a trap, wherever it sits and whatever shape it takes
    for (const name of ["trap", "trap-last", "trap-only", "trap-cycle"] as const) {
      expectRule(
        `keyboardTrapFinding on ${name}`,
        [(await onPage(name, keyboardTrapFinding)).result],
        "keyboard-trap",
      );
    }
    // A negative tabindex is no stop, and a radio group is one.
    for (const name of ["clean", "negative-tabindex", "radio-group"] as const) {
      expectNothing(`keyboardTrapFinding on ${name}`, [
        (await onPage(name, keyboardTrapFinding)).result,
      ]);
    }

    // keyboard: a visible focus
    for (const name of [
      "no-focus-ring",
      "faint-focus-ring",
      "transparent-focus-ring",
      "low-alpha-focus-ring",
      "decorative-shadow",
    ] as const) {
      expectRule(
        `focusVisibleFinding on ${name}`,
        [(await onPage(name, focusVisibleFinding)).result],
        "focus-not-visible",
      );
    }
    for (const name of ["clean", "shadow-ring"] as const) {
      expectNothing(`focusVisibleFinding on ${name}`, [
        (await onPage(name, focusVisibleFinding)).result,
      ]);
    }

    // keyboard: Escape
    const pressEscape = (page: Page) => escapeFinding(page, "#open", "#overlay");
    expectRule(
      "escapeFinding",
      [(await onPage("stuck-overlay", pressEscape)).result],
      "escape-does-not-close",
    );
    expectRule(
      "escapeFinding",
      [(await onPage("lost-focus", pressEscape)).result],
      "focus-not-returned",
    );
    expectNothing("escapeFinding", [(await clean(pressEscape)).result]);

    // reflow
    expectRule("reflowFinding", [(await onPage("wide-element", reflowFinding)).result], "reflow");
    const reflowed = await clean(async (page) => {
      const finding = await reflowFinding(page);
      return { finding, width: page.viewportSize()?.width };
    });
    expectNothing("reflowFinding", [reflowed.result.finding]);
    if (reflowed.result.width !== REFLOW_WIDTH) fail("reflowFinding", "left another width");

    // text spacing
    expectRule(
      "textSpacingFindings",
      (await onPage("text-clip", textSpacingFindings)).result,
      "text-spacing-clip",
    );
    expectNothing("textSpacingFindings", (await clean(textSpacingFindings)).result);

    // reduced motion
    expectRule(
      "reducedMotionFindings",
      (await onPage("animation", reducedMotionFindings)).result,
      "motion-not-reduced",
    );
    expectNothing(
      "reducedMotionFindings",
      (await onPage("gated-animation", reducedMotionFindings)).result,
    );

    // focus not obscured
    const focusFirst = (page: Page) =>
      page
        .locator("button")
        .first()
        .focus()
        .then(() => focusObscuredFinding(page));
    expectRule(
      "focusObscuredFinding",
      [(await onPage("covered-focus", focusFirst)).result],
      "focus-obscured",
    );
    expectNothing("focusObscuredFinding", [(await clean(focusFirst)).result]);

    // ARIA snapshots
    const aria = (page: Page) => ariaSnapshot(page);
    expectRule("ariaSnapshot", (await onPage("axe", aria)).result.findings, "unnamed-control");
    const ariaClean = (await clean(aria)).result;
    expectNothing("ariaSnapshot", ariaClean.findings);
    if (!ariaClean.snapshot.includes('button "Open"')) {
      fail("ariaSnapshot", `read no named button: ${ariaClean.snapshot}`);
    }
  },
};
