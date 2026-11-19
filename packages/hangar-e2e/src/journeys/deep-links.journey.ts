/**
 * Object links: `#/i/<ref>` for each kind Home serves opens the object on its own
 * page with the inspector over it; Escape closes the inspector, focus returns and the
 * address drops `?inspect=`; a link that opens nothing says why.
 *
 * Inspect on a row opens the inspector over the page as it is: the page is not drawn
 * again, no control of the page lies under the panel, Escape from the page closes it
 * too, and focus goes back to the very Inspect control, where the reader was.
 */
import type { Page } from "playwright";
import { settle } from "../settle";
import { waitFor } from "./a11y-states";
import type { Journey } from "./journey";
import { plantEvalResults } from "./planted-evals";

const INSPECTOR = "aside.inspector h2, dialog.inspector[open] h2";

/** Follow a link and wait for the inspector it opens; the address it lands on. */
async function open(page: Page, hash: string): Promise<string> {
  await page.evaluate((h) => {
    globalThis.location.hash = h;
  }, hash);
  await waitFor(page, INSPECTOR, `the inspector for ${hash}`);
  const landed = await page.evaluate(() => globalThis.location.hash);
  await settle(page, landed);
  return landed;
}

export const deepLinks: Journey = {
  id: "deep-links",
  shard: "smoke",
  proves:
    "An object link for a harness, a run, a decision, a conversation and an evaluation run opens the object's own page with the inspector over it; a decision's parked run opens the same way; Escape closes the inspector and drops it from the address; a link to nothing says so in words.",
  run: async (scope) => {
    const fleet = await scope.fleet({ seed: "deep-links", shapes: ["cli"], rich: true });
    const [harness] = fleet.harnesses;
    if (harness === undefined) throw new Error("the fleet has no harness");
    const home = scope.home(fleet);
    const session = await scope.session(home);
    const { page } = session;
    const out: string[] = [];
    const evalRun = plantEvalResults(harness.dir);
    const decision = harness.approvalIds[0];
    const session0 = harness.sessionIds[0];
    const links: ReadonlyArray<readonly [string, string, RegExp]> = [
      ["harness", `#/i/home/harness/${harness.id}`, new RegExp(`^#/h/${harness.id}\\?inspect=`)],
      [
        "run",
        `#/i/${harness.id}/exec/${harness.runId}`,
        /\/work\/runs\/run_[0-9a-f]{16}\?inspect=/,
      ],
      ...(decision !== undefined
        ? [
            [
              "decision",
              `#/i/${harness.id}/decision/${decision}`,
              /\/overview\/needs-you\?inspect=/,
            ] as const,
          ]
        : []),
      ...(session0 !== undefined
        ? [
            [
              "session",
              `#/i/${harness.id}/session/${session0}`,
              new RegExp(`/work/sessions/${session0}\\?inspect=`),
            ] as const,
          ]
        : []),
      [
        "evalrun",
        `#/i/${harness.id}/evalrun/${evalRun}`,
        /\/quality\/results\/run_[0-9a-f]{16}\?inspect=/,
      ],
    ];
    if (links.length < 5) out.push(`only ${links.length} of the five kinds could be seeded`);
    for (const [kind, link, where] of links) {
      const landed = await open(page, link);
      if (!where.test(landed)) out.push(`${kind}: ${link} landed on ${landed}`);
    }

    // The decision's parked run: the decision says which run it parked, and that link opens.
    if (decision !== undefined) {
      const parked = await page.evaluate(async (ref) => {
        const session = sessionStorage.getItem("hangar.session");
        const res = await fetch(`/api/v1/decisions/${ref}`, {
          headers: {
            "CrewHaus-Protocol": "crewhaus.hangar.v1",
            ...(session ? { authorization: `Bearer ${session}` } : {}),
          },
        });
        const text = JSON.stringify(await res.json());
        return /"runId":"(run_[0-9a-f]{16})"/.exec(text)?.[1] ?? null;
      }, `${harness.id}/decision/${decision}`);
      if (parked === null) out.push("the decision names no parked run");
      else {
        const landed = await open(page, `#/i/${harness.id}/exec/${parked}`);
        if (!landed.includes(`/work/runs/${parked}`)) {
          out.push(`the decision's parked run landed on ${landed}`);
        }
      }
    }

    // Escape closes the inspector on a wide screen and drops it from the address.
    await open(page, `#/i/home/harness/${harness.id}`);
    await page.keyboard.press("Escape");
    const after = await page.evaluate(() => ({
      open: document.querySelector("aside.inspector") !== null,
      hash: globalThis.location.hash,
    }));
    if (after.open) out.push("Escape left the inspector open");
    if (after.hash.includes("inspect=")) out.push(`the address kept ?inspect=: ${after.hash}`);

    // Inspect from a row of the harness list, by keyboard.
    await session.visit("#/harnesses");
    await waitFor(page, ".action-bar a", "a row's Inspect");
    const start = await page.evaluate(() => {
      const opener = document.querySelector(".action-bar a") as HTMLElement;
      opener.scrollIntoView({ block: "center" });
      opener.focus();
      (globalThis as unknown as { opener0: HTMLElement }).opener0 = opener;
      return globalThis.scrollY;
    });
    await page.keyboard.press("Enter");
    await waitFor(page, "aside.inspector h2", "the inspector over the harness list");
    const covered = await page.evaluate(() => {
      const panel = document.querySelector("aside.inspector") as HTMLElement;
      const p = panel.getBoundingClientRect();
      const out: string[] = [];
      const focusable = [
        "a[href]",
        "button",
        "input",
        "select",
        "textarea",
        "summary",
        '[tabindex]:not([tabindex="-1"])',
      ];
      // The page and the slots above it: everything below the header.
      const within = ["#view", "#banners", "#first-run"];
      const selector = within.flatMap((w) => focusable.map((f) => `${w} ${f}`)).join(", ");
      for (const node of document.querySelectorAll<HTMLElement>(selector)) {
        if (panel.contains(node) || node.closest("[hidden]") !== null) continue;
        // What of it is on screen: its box, clipped by every ancestor that scrolls.
        let r = node.getBoundingClientRect();
        let box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        for (let at = node.parentElement; at !== null; at = at.parentElement) {
          const style = getComputedStyle(at);
          if (style.overflowX === "visible" && style.overflowY === "visible") continue;
          r = at.getBoundingClientRect();
          box = {
            left: Math.max(box.left, r.left),
            top: Math.max(box.top, r.top),
            right: Math.min(box.right, r.right),
            bottom: Math.min(box.bottom, r.bottom),
          };
        }
        if (box.right <= box.left || box.bottom <= box.top) continue;
        if (box.right > p.left && box.left < p.right && box.bottom > p.top && box.top < p.bottom) {
          out.push(
            `${node.tagName.toLowerCase()} "${(node.textContent ?? "").trim().slice(0, 30)}"`,
          );
        }
      }
      return out;
    });
    if (covered.length > 0) out.push(`page controls under the inspector: ${covered.join(", ")}`);
    await page.keyboard.press("Escape");
    const back = await page.evaluate(() => {
      const opener = (globalThis as unknown as { opener0: HTMLElement }).opener0;
      return {
        open: document.querySelector("aside.inspector") !== null,
        same: document.activeElement === opener,
        connected: opener.isConnected,
        scrollY: globalThis.scrollY,
      };
    });
    if (back.open) out.push("Escape left the row's inspector open");
    if (!back.connected) out.push("opening the inspector drew the page again");
    if (!back.same) out.push("focus did not return to the row's Inspect");
    if (back.scrollY !== start) out.push(`the page moved from ${start} to ${back.scrollY}`);

    // Escape from the page itself closes the inspector too.
    await page.evaluate(() => (document.querySelector(".action-bar a") as HTMLElement).focus());
    await page.keyboard.press("Enter");
    await waitFor(page, "aside.inspector h2", "the inspector, opened again");
    await page.evaluate(() => (document.querySelector(".action-bar a") as HTMLElement).focus());
    await page.keyboard.press("Escape");
    const fromPage = await page
      .waitForFunction(() => document.querySelector("aside.inspector") === null, null, {
        timeout: 5000,
      })
      .then(() => false)
      .catch(() => true);
    if (fromPage) out.push("Escape from the page left the inspector open");

    // A link to nothing says so.
    await page.evaluate((h) => {
      globalThis.location.hash = h;
    }, `#/i/${harness.id}/exec/run_ffffffffffffffff`);
    await waitFor(page, ".inspect-link h1", "the page that says the link opens nothing");
    const said = await page.locator(".inspect-link h1").innerText();
    if (!said.includes("Nothing here")) out.push(`a link to nothing said "${said}"`);

    if (out.length > 0) throw new Error(`object links:\n  ${out.join("\n  ")}`);
    session.assertClean();
  },
};
