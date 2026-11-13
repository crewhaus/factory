/**
 * Every address the console answered before its destinations and sections
 * still lands on its screen. Each old address is written out here: the
 * address it lands on, the page's heading and its title. A redirect replaces
 * the address in place, so it adds no history entry of its own.
 */
import type { Page } from "playwright";
import { HOME_ROUTE, NOT_FOUND_TEXT } from "../console-routes";
import type { SeededHarness } from "../seed/fleet";
import { type Session, signInPath } from "../session";
import { settle } from "../settle";
import type { Journey } from "./journey";

type Case = { readonly from: string; readonly to: string; readonly page: string };

/** The fleet screens: the old address, where it lands, and the page's name. */
const FLEET: readonly Case[] = [
  { from: "#/runs", to: "#/home/working", page: "Working now" },
  { from: "#/approvals", to: "#/home/needs-you?type=approvals", page: "Needs you" },
  { from: "#/review", to: "#/home/needs-you?type=review", page: "Needs you" },
  { from: "#/advisor", to: "#/home/needs-you?type=advice", page: "Needs you" },
  { from: "#/activity", to: "#/home/changes", page: "What changed" },
  { from: "#/health", to: "#/harnesses/health", page: "Health" },
  { from: "#/feedback", to: "#/harnesses/feedback", page: "Feedback" },
  { from: "#/credentials", to: "#/connections/credentials", page: "Credentials" },
  { from: "#/thredz", to: "#/connections/thredz", page: "Thredz" },
  { from: "#/settings", to: "#/settings", page: "Settings" },
];

/** A harness's tabs, and the deep forms, as `<old tail> → <new tail>, sub-view`. */
function harnessCases(h: SeededHarness): readonly Case[] {
  const session = h.sessionIds[0] ?? "";
  const rows: ReadonlyArray<readonly [string, string, string]> = [
    ["overview", "", "Overview"],
    ["advisor", "/overview/needs-you", "Needs you"],
    ["spec", "/setup/spec", "Spec"],
    ["runs", "/work/runs", "Runs"],
    [`runs/${h.runId}`, `/work/runs/${h.runId}`, "Runs"],
    ["schedulers", "/work/schedule", "Schedule"],
    ["sessions", "/work/sessions", "Sessions"],
    [`sessions/${session}`, `/work/sessions/${session}`, "Sessions"],
    ["evals", "/quality/results", "Results"],
    ["memory", "/knowledge/memory", "Memory"],
    [`memory/wiki/${h.wikiSlug}`, `/knowledge/wiki/${h.wikiSlug}`, "Wiki article"],
    ["data", "/quality/datasets", "Datasets"],
    ["feedback", "/quality/feedback", "Feedback"],
    ["costs", "/setup/budget", "Budget"],
    ["models", "/setup/models", "Models"],
    [`models/routes/${session}`, `/setup/models/routes/${session}`, "Models"],
    ["creds", "/setup/credentials", "Credentials"],
    ["channels", "/setup/channels", "Channels"],
    ["security", "/setup/security", "Security"],
    ["thredz", "/knowledge/thredz", "Thredz"],
    ["deploy", "/setup/deployment", "Deployment"],
    ["inspect", "/setup/files", "Files"],
    ["dev", "/setup/tools", "Tools"],
    ["panes", "/setup/plugins", "Plugins"],
  ];
  const base = `#/h/${encodeURIComponent(h.id)}`;
  return rows.map(([from, to, page]) => ({
    from: `${base}/${from}`,
    to: `${base}${to}`,
    page: `${page} — ${h.specName}`,
  }));
}

/** What the page shows now. */
async function shown(page: Page) {
  return await page.evaluate(() => ({
    hash: globalThis.location.hash,
    history: globalThis.history.length,
    headings: [...document.querySelectorAll("h1")].map((h) => (h.textContent ?? "").trim()),
    title: document.title,
    body: document.body.innerText,
  }));
}

/** Go to an address the way a person does (a new history entry) and check where it lands. */
async function check(session: Session, c: Case, heading: string, out: string[]): Promise<void> {
  const before = await shown(session.page);
  await session.visit(c.from);
  const after = await shown(session.page);
  if (after.hash !== c.to) out.push(`${c.from} landed on ${after.hash}, not ${c.to}`);
  if (after.history !== before.history + 1) {
    out.push(`${c.from} added ${after.history - before.history} history entries, not 1`);
  }
  if (after.headings.length !== 1 || after.headings[0] !== heading) {
    out.push(
      `${c.from}: the page's headings are ${JSON.stringify(after.headings)}, not "${heading}"`,
    );
  }
  if (after.title !== `${c.page} — Hangar`) {
    out.push(`${c.from}: the title is "${after.title}", not "${c.page} — Hangar"`);
  }
  if (after.body.includes(NOT_FOUND_TEXT)) out.push(`${c.from}: ${NOT_FOUND_TEXT}`);
}

export const legacyRedirects: Journey = {
  id: "legacy-redirects",
  shard: "smoke",
  proves:
    "Every address the console answered before its destinations and sections — each fleet screen, each harness tab and the deep forms — lands on its screen with that page's heading and title, never on not found, and adds exactly one history entry, as a new address does; an old address remembered across a sign-in lands on its new page too.",
  run: async (scope) => {
    const fleet = await scope.fleet({ seed: "legacy", shapes: ["cli"], rich: true });
    const [harness] = fleet.harnesses;
    if (harness === undefined) throw new Error("the fleet has no harness");
    const home = scope.home(fleet);
    const session = await scope.session(home);
    const out: string[] = [];

    for (const c of FLEET) await check(session, c, c.page, out);
    for (const c of harnessCases(harness)) await check(session, c, harness.specName, out);

    // A new address adds one entry too: the redirect costs nothing extra.
    const before = await shown(session.page);
    await session.visit("#/harnesses");
    if ((await shown(session.page)).history !== before.history + 1) {
      out.push("a new address did not add exactly one history entry");
    }

    // An old address the tab remembered across a sign-in lands on its new page.
    await session.page.evaluate(() => {
      sessionStorage.removeItem("hangar.session");
      sessionStorage.setItem("hangar.return", "#/approvals");
    });
    await session.page.goto(`${home.url}${await signInPath(home)}`);
    await settle(session.page, "#/home/needs-you?type=approvals");
    const landed = await shown(session.page);
    if (landed.hash !== "#/home/needs-you?type=approvals") {
      out.push(`a remembered #/approvals landed on ${landed.hash} after signing in`);
    }
    if (landed.headings[0] !== "Needs you") {
      out.push(`after signing in the page's heading is ${JSON.stringify(landed.headings)}`);
    }

    // A first load of an old address (a new document, not a hash change) lands
    // too, and adds no entry of its own beyond the load.
    await session.page.goto(`${home.url}/${HOME_ROUTE}`);
    await settle(session.page, HOME_ROUTE);
    const fresh = await shown(session.page);
    await session.page.goto(`${home.url}/?load=2#/activity`);
    await settle(session.page, "#/home/changes");
    const loaded = await shown(session.page);
    if (loaded.hash !== "#/home/changes")
      out.push(`a first load of #/activity landed on ${loaded.hash}`);
    if (loaded.history !== fresh.history + 1) {
      out.push(
        `a first load of an old address added ${loaded.history - fresh.history} entries, not 1`,
      );
    }

    session.assertClean();
    if (out.length > 0) throw new Error(`old addresses did not land:\n  ${out.join("\n  ")}`);
  },
};
