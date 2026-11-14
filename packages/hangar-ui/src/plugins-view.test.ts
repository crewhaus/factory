/**
 * Settings › Plugins (#522): the state words, the ticks a review starts with (unticked
 * unless the plugin predates asking, or already has a grant), the request a set of
 * ticks makes, the embed row a compiled binary needs, and no markup assignment.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import * as destinations from "../assets/js/destinations.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { STATE_WORDS, grantBody, initialTicks } from "../assets/js/views/plugins.js";
import { integrationsAssets } from "./embed/integrations";

const SOURCE = readFileSync(
  join(import.meta.dir, "..", "assets", "js", "views", "plugins.js"),
  "utf8",
);

const ASKS = {
  harnesses: ["hrn_00000000000000a1"],
  panes: ["board"],
  events: ["run"],
  reads: ["costs"],
  net: ["https://api.notes.test"],
  tools: ["Read"],
};

type Ticks = Record<string, Set<string> | boolean>;

describe("Settings › Plugins", () => {
  test("every state has a word", () => {
    expect(STATE_WORDS).toEqual({
      waiting: "Waiting for your OK",
      allowed: "Allowed",
      "asks-for-more": "Asks for more",
      revoked: "Revoked",
    });
  });

  test("a review starts unticked; legacy starts with what it could see; a grant with the grant", () => {
    const fresh = initialTicks({ legacy: false, asks: ASKS, granted: null }) as Ticks;
    expect([...(fresh["panes"] as Set<string>)]).toEqual([]);
    expect([...(fresh["harnesses"] as Set<string>)]).toEqual([]);
    const legacy = initialTicks({ legacy: true, asks: ASKS, granted: null }) as Ticks;
    expect([...(legacy["panes"] as Set<string>)]).toEqual(["board"]);
    expect([...(legacy["harnesses"] as Set<string>)]).toEqual(["hrn_00000000000000a1"]);
    const granted = initialTicks({
      legacy: false,
      asks: ASKS,
      granted: { ...ASKS, harnesses: "all", net: [] },
    }) as Ticks;
    expect(granted["all"]).toBe(true);
    expect([...(granted["net"] as Set<string>)]).toEqual([]);
  });

  test("the request carries the ticks and the generation the review read", () => {
    const ticks = initialTicks({ legacy: true, asks: ASKS, granted: null });
    expect(grantBody(ticks, { gen: 3 })).toEqual({ ...ASKS, expect: 3 });
    expect(grantBody(ticks, { gen: null })).toEqual(ASKS);
    expect(grantBody({ ...ticks, all: true }, { gen: null }).harnesses).toBe("all");
  });

  test("the page is a Settings row, and its module is embedded", () => {
    const row = (destinations.SETTINGS_PAGES as Array<{ id: string; title: string }>).find(
      (p) => p.id === "plugins",
    );
    expect(row?.title).toBe("Plugins");
    expect(integrationsAssets["/assets/js/views/plugins.js"]?.body).toBe(SOURCE);
  });

  test("it builds DOM with createElement only, and says what the choices limit", () => {
    for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
      expect(SOURCE.includes(banned)).toBe(false);
    }
    expect(SOURCE).toContain("They do not limit what its own code can do");
    for (const label of ["Allow selected", "Not now", "Remove access", "Use in this harness"]) {
      expect(SOURCE).toContain(`text: "${label}"`);
    }
  });
});
