/**
 * Every write the console sends shows its command-line equivalent, or says
 * there is none, beside the control that sends it.
 *
 * Home serves the route table's notes at `GET /api/twin-notes`, and the
 * console's `writeTwin("<key>", …)` renders one beside a control. This file
 * reads every console module as text (hangar-ui depends on nothing here, so
 * the scan lives on this side) and holds each module that calls a noted
 * write to showing that write's note, or the exact command the module builds
 * for that one call.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ROUTE_TABLE, twinNotesOf } from "./route-table";
import { ROUTE_TWIN_NOTES } from "./route-twin-notes";
import { bootTestServer } from "./testkit";

const UI_JS = new URL("../../hangar-ui/assets/js/", import.meta.url).pathname;

/** Every console module but the two that only name routes. */
function consoleModules(): { readonly rel: string; readonly text: string }[] {
  const out: { rel: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".js")) out.push({ rel: relative(UI_JS, path), text: "" });
    }
  };
  walk(UI_JS);
  return out
    .filter((m) => m.rel !== "api.js" && m.rel !== "routes.js")
    .map((m) => ({ rel: m.rel, text: readFileSync(join(UI_JS, m.rel), "utf8") }))
    .sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

/**
 * The names `api.js` gives a route other than its key: a hand-written
 * wrapper `<name>: (…) => …(ROUTES.<key>, …)` whose name differs.
 */
function wrapperAliases(apiSource: string): Map<string, string[]> {
  const aliases = new Map<string, string[]>();
  for (const m of apiSource.matchAll(
    /^\s*([A-Za-z][A-Za-z0-9]*):\s*(?:async\s*)?\([^)]*\)\s*=>[^\n]*?\n?[^\n]*?ROUTES\.([A-Za-z][A-Za-z0-9]*)/gm,
  )) {
    const [, name, key] = m as unknown as [string, string, string];
    if (name === key) continue;
    aliases.set(key, [...(aliases.get(key) ?? []), name]);
  }
  return aliases;
}

/**
 * Controls that already show the exact command for the one call they make,
 * built from its own values, where the general note would only repeat it.
 */
const EXACT: Readonly<Record<string, Readonly<Record<string, RegExp>>>> = {
  submitJob: {
    "shell.js": /cliTwinFor\("job"/,
    "views/jobs.js": /actionTwin\("job"/,
    "views/proc.js": /actionTwin\("job"/,
  },
  adjudicateReview: { "views/review.js": /actionTwin\(\s*"adjudicate"/ },
  pinBaseline: { "views/evals.js": /actionTwin\("baseline"/ },
  controlWake: { "views/schedulers.js": /\{ action: "wake"/ },
  pinSession: { "views/sessions.js": /NO_TWIN_NOTES\["pin-session"\]/ },
  mcpServerStart: { "views/runtime.js": /view\.cliTwin/ },
  devStart: { "views/runtime.js": /view\.cliTwin/ },
  // First-run onboarding shows the commands Home serves with it.
  addHarness: { "views/onboarding.js": /twins\.addHarness/ },
  scan: { "views/onboarding.js": /twins\.scan\b/ },
  addScanRoot: { "views/onboarding.js": /twins\.addScanRoot/ },
  demoInstall: { "views/onboarding.js": /twins\.demo\b/ },
};

/** Noted writes no console control sends, each with why. */
const UNSENT: Readonly<Record<string, string>> = {
  setGroupsAll: "an off-map route: the console's map does not name it",
  removeGroup: "an off-map route: the console's map does not name it",
  removeScanRoot: "an off-map route: the console's map does not name it",
  datasetBuilderStep: "the dataset builder answers that it is unavailable; no control sends it",
  annotateSample: "no console control annotates a sample yet",
  secretsRotate: "Home does not rotate secrets yet; no control sends it",
};

type Finding = { readonly key: string; readonly module: string; readonly shows: string };

/** Each (write, module) the console sends, with what shows beside it; and what is missing. */
function scan(
  notes: Readonly<Record<string, string>>,
  modules: readonly { readonly rel: string; readonly text: string }[],
  aliases: Map<string, string[]>,
): { readonly shown: Finding[]; readonly missing: string[]; readonly unsent: string[] } {
  const shown: Finding[] = [];
  const missing: string[] = [];
  const unsent: string[] = [];
  for (const key of Object.keys(notes)) {
    const names = [key, ...(aliases.get(key) ?? [])];
    let sent = false;
    for (const mod of modules) {
      const calls = names.some((n) => new RegExp(`\\bapi\\.${n}\\b`).test(mod.text));
      if (!calls) continue;
      sent = true;
      const exact = EXACT[key]?.[mod.rel];
      if (mod.text.includes(`writeTwin("${key}"`)) {
        shown.push({ key, module: mod.rel, shows: "note" });
      } else if (exact?.test(mod.text) === true) {
        shown.push({ key, module: mod.rel, shows: "exact" });
      } else {
        missing.push(`${mod.rel}: ${key}`);
      }
    }
    if (!sent) unsent.push(key);
  }
  return { shown, missing, unsent };
}

describe("the notes Home serves", () => {
  test("GET /api/twin-notes answers the route table's notes, every one", async () => {
    const t = bootTestServer();
    try {
      const res = await t.api("/api/twin-notes");
      expect(res.status).toBe(200);
      const notes = res.body["notes"] as Record<string, string>;
      expect(notes).toEqual({ ...twinNotesOf() });
      for (const [key, note] of Object.entries(ROUTE_TWIN_NOTES)) {
        expect(`${key}: ${notes[key]}`).toBe(`${key}: ${note}`);
      }
      // One more than the table of notes: a core kind without a command says why itself.
      expect(Object.keys(notes)).toHaveLength(Object.keys(ROUTE_TWIN_NOTES).length + 1);
    } finally {
      await t.stop();
    }
  });

  test("a note is served only for a write without a core command of its own", () => {
    const notes = twinNotesOf();
    for (const key of Object.keys(notes)) {
      const row = ROUTE_TABLE.find((r) => r.key === key);
      expect(`${key}: ${row?.receipt !== "none" && row?.cliTwin === null}`).toBe(`${key}: true`);
    }
    const table = [
      {
        ...(ROUTE_TABLE[0] as (typeof ROUTE_TABLE)[number]),
        key: "w",
        receipt: "harness" as const,
        note: "n",
      },
      { ...(ROUTE_TABLE[0] as (typeof ROUTE_TABLE)[number]), key: "r", note: "n" },
    ];
    expect(twinNotesOf(table)).toEqual({ w: "n" });
  });
});

describe("every console write shows its equivalent", () => {
  const modules = consoleModules();
  const aliases = wrapperAliases(readFileSync(join(UI_JS, "api.js"), "utf8"));

  test("the hand-written wrappers' other names are read from api.js", () => {
    expect(aliases.get("relocate")).toEqual(["relocateHarness"]);
  });

  test("each module that sends a noted write shows its note or its exact command", () => {
    const { shown, missing, unsent } = scan(ROUTE_TWIN_NOTES, modules, aliases);
    expect(missing).toEqual([]);
    expect(unsent.sort()).toEqual(Object.keys(UNSENT).sort());
    expect(shown.filter((f) => f.shows === "note")).toHaveLength(90);
    expect(shown.filter((f) => f.shows === "exact")).toHaveLength(13);
    // Every exception names a module that sends the write.
    for (const [key, byModule] of Object.entries(EXACT)) {
      for (const rel of Object.keys(byModule)) {
        expect(shown.some((f) => f.key === key && f.module === rel && f.shows === "exact")).toBe(
          true,
        );
      }
    }
  });

  test("a module that sends a write and shows nothing beside it is reported", () => {
    const planted = [
      { rel: "views/a.js", text: 'api.wikiArchive(x); writeTwin("wikiArchive", ctx);' },
      { rel: "views/b.js", text: "await api.wikiArchive(x);" },
      { rel: "views/c.js", text: "api.relocateHarness(id, dir);" },
      { rel: "views/d.js", text: "api.wikiArchives(x);" },
    ];
    const { shown, missing, unsent } = scan(
      { wikiArchive: "n", relocate: "n", memoryForget: "n" },
      planted,
      aliases,
    );
    expect(shown).toEqual([{ key: "wikiArchive", module: "views/a.js", shows: "note" }]);
    expect(missing).toEqual(["views/b.js: wikiArchive", "views/c.js: relocate"]);
    expect(unsent).toEqual(["memoryForget"]);
  });
});
