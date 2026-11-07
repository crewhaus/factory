/** Each accessibility helper, against a page planted to trip it and a clean one. */
import type { Page } from "playwright";
import { ariaSnapshot } from "../a11y/aria";
import { AXE_TAGS, runAxe } from "../a11y/axe";
import { type AxeReport, rowKey } from "../a11y/baseline";
import type { A11yFinding } from "../a11y/finding";
import { focusObscuredFinding } from "../a11y/focus-obscured";
import { GATE_THEMES, GATE_WIDTHS, gateVerdict } from "../a11y/gate";
import {
  dialogContainmentFinding,
  escapeFinding,
  focusTour,
  focusVisibleFinding,
  keyboardTrapFinding,
} from "../a11y/keyboard";
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
  "tour-no-ring": {
    html: plantedHtml(
      `<main><h1>Plant</h1><button class="wide">One</button> <button class="wide bare">Two</button></main>`,
      sheet,
    ),
  },
  "translucent-ring": {
    html: plantedHtml(
      `<main class="dark"><h1>Clean</h1><button class="wash">On a dark page</button></main>`,
      sheet,
    ),
  },
  "dialog-modal": {
    html: plantedHtml(
      `<main><h1>Clean</h1><button class="wide">Behind</button>
       <dialog id="modal" aria-label="Plant"><button class="wide">One</button> <button class="wide">Two</button></dialog></main>`,
      `${sheet}${code}`,
    ),
  },
  "dialog-leaky": {
    html: plantedHtml(
      `<main><h1>Plant</h1><button class="wide">Behind</button>
       <dialog id="leaky" aria-label="Plant"><button class="wide">One</button> <button class="wide">Two</button></dialog></main>`,
      `${sheet}${code}`,
    ),
  },
  "dialog-stuck": {
    html: plantedHtml(
      `<main><h1>Plant</h1><button class="wide">Behind</button>
       <dialog id="stuck" aria-label="Plant"><div id="stuck-row" tabindex="-1">Armed</div><button class="wide">One</button> <button class="wide">Two</button></dialog></main>`,
      `${sheet}${code}`,
    ),
  },
  "motion-attr": {
    html: plantedHtml(
      `<main><h1>Clean</h1><div class="attr-gated">Spin</div></main>`,
      sheet,
    ).replace('<html lang="en">', '<html lang="en" data-motion="reduce">'),
  },
  "motion-attr-missing": {
    html: plantedHtml(`<main><h1>Plant</h1><div class="attr-gated">Spin</div></main>`, sheet),
  },
  "spacing-exempt": {
    html: plantedHtml(
      `<main><h1>Clean</h1><span class="sr-only">Words for a screen reader only, longer than one pixel</span>
       <label>Value <input class="narrow-input" value="a value much longer than the field shows"></label></main>`,
      sheet,
    ),
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
    .dark { background: rgb(10, 13, 15); color: rgb(232, 239, 233); padding: 8px; }
    .wash { background: rgba(46, 204, 139, 0.12); color: rgb(46, 204, 139); border: 1px solid rgb(46, 204, 139); min-height: 24px; }
    .wash:focus-visible { outline: 2px solid rgb(46, 204, 139); outline-offset: 2px; }
    .attr-gated { animation: spin 4s linear infinite; }
    :root[data-motion="reduce"] .attr-gated { animation: none; }
    .sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
    .narrow-input { width: 60px; }
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
    document.getElementById("modal")?.showModal();
    // A modal whose page swallows every Tab: focus can never move off the row.
    const stuck = document.getElementById("stuck");
    if (stuck !== null) {
      stuck.showModal();
      document.getElementById("stuck-row")?.focus();
      document.addEventListener("keydown", (event) => {
        if (event.key === "Tab") event.preventDefault();
      });
    }
    // Opened without showModal: nothing holds focus inside it.
    document.getElementById("leaky")?.show();
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

    // focus tour: every stop judged, and a trap at the end
    expectRule(
      "focusTour",
      (await onPage("tour-no-ring", focusTour)).result.findings,
      "focus-not-visible",
    );
    expectRule(
      "focusTour",
      (await onPage("covered-focus", focusTour)).result.findings,
      "focus-obscured",
    );
    expectRule("focusTour", (await onPage("trap", focusTour)).result.findings, "keyboard-trap");
    const toured = (await clean(focusTour)).result;
    expectNothing("focusTour", toured.findings);
    if (toured.reached < 2)
      fail("focusTour", `reached ${toured.reached} controls on the clean page`);
    // A wash is read over what is behind it, not over white.
    expectNothing("focusVisibleFinding on translucent-ring", [
      (await onPage("translucent-ring", focusVisibleFinding)).result,
    ]);
    expectNothing(
      "focusTour on translucent-ring",
      (await onPage("translucent-ring", focusTour)).result.findings,
    );

    // dialog containment
    expectRule(
      "dialogContainmentFinding",
      [(await onPage("dialog-leaky", (page) => dialogContainmentFinding(page, "#leaky"))).result],
      "focus-escapes-dialog",
    );
    expectRule(
      "dialogContainmentFinding",
      [(await onPage("dialog-stuck", (page) => dialogContainmentFinding(page, "#stuck"))).result],
      "focus-stuck-in-dialog",
    );
    expectNothing("dialogContainmentFinding", [
      (await onPage("dialog-modal", (page) => dialogContainmentFinding(page, "#modal"))).result,
    ]);

    // reduced motion from a page's own switch, with the media query left alone
    const ownSwitch = async (page: Page) => {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      return reducedMotionFindings(page, { emulate: false });
    };
    expectRule(
      "reducedMotionFindings({ emulate: false })",
      (await onPage("motion-attr-missing", ownSwitch)).result,
      "motion-not-reduced",
    );
    // A rule only the media query would apply does not pass here.
    expectRule(
      "reducedMotionFindings({ emulate: false })",
      (await onPage("gated-animation", ownSwitch)).result,
      "motion-not-reduced",
    );
    expectNothing(
      "reducedMotionFindings({ emulate: false })",
      (await onPage("motion-attr", ownSwitch)).result,
    );

    // text spacing exempts a screen-reader-only box and a field's own scroll
    expectNothing(
      "textSpacingFindings",
      (await onPage("spacing-exempt", textSpacingFindings)).result,
    );

    // the gate fails on axe's findings, and passes a clean page
    const asReport = (violations: Readonly<Record<string, number>>): AxeReport => {
      const rows: Record<string, Readonly<Record<string, number>>> = {};
      for (const theme of GATE_THEMES) {
        for (const width of GATE_WIDTHS) rows[rowKey("#/plant", theme, width)] = violations;
      }
      return { schema: 1, axe: "planted", tags: [...AXE_TAGS], rows };
    };
    const failing = gateVerdict(asReport(planted.violations), ["#/plant"]);
    if (failing.failures.length === 0)
      fail("gateVerdict", "passed axe's findings on the planted page");
    const passing = gateVerdict(asReport(quiet.violations), ["#/plant"]);
    if (passing.failures.length > 0 || passing.missing.length > 0) {
      fail("gateVerdict", `failed the clean page: ${JSON.stringify(passing)}`);
    }

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
