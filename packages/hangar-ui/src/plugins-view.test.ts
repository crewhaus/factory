/**
 * Settings › Plugins (#522): the state words, the ticks a review starts with (unticked
 * unless the plugin predates asking, or already has a grant), the request a set of
 * ticks makes, what the review says about a signature, which harnesses offer "Use in
 * this harness", the embed row a compiled binary needs, and no markup assignment.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import * as destinations from "../assets/js/destinations.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { waitingNotice } from "../assets/js/views/panes.js";
import {
  LIMIT_SENTENCE,
  STATE_WORDS,
  grantBody,
  harnessChoiceLabel,
  initialTicks,
  servesThisHarness,
  signatureWords,
  stillLoadedLines,
  // @ts-expect-error — hand-written browser JS, typed as text for the embed map
} from "../assets/js/views/plugins.js";
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

  test("a signature is reported as present, never as verified", () => {
    // Home sees only that a manifest carries a signature; the loader checks it.
    const signed = signatureWords({ signed: true });
    expect(signed).toBe("Has a signature (checked when a harness loads it)");
    expect(signatureWords({ signed: false })).toBe("No signature");
    expect(signatureWords({})).toBe("No signature");
    for (const words of [signed, signatureWords({ signed: false })]) {
      expect(/\bsigned\b|verified/i.test(words)).toBe(false);
    }
    expect(SOURCE.includes('" · Signed"')).toBe(false);
  });

  test("Use in this harness is offered only where the served view covers the harness", () => {
    const a = "hrn_00000000000000a1";
    const b = "hrn_00000000000000b2";
    expect(servesThisHarness({ served: { harnesses: [a] } }, a)).toBe(true);
    expect(servesThisHarness({ served: { harnesses: [a] } }, b)).toBe(false);
    expect(servesThisHarness({ served: { harnesses: "all" } }, b)).toBe(true);
    expect(servesThisHarness({ served: { harnesses: [] } }, a)).toBe(false);
    expect(servesThisHarness(null, a)).toBe(false);
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
    expect(LIMIT_SENTENCE).toBe(
      "These choices decide what Home gives this plugin: tabs, run activity, reads and websites. Host tools are set in a harness's crewhaus.yaml when you choose Use in this harness, and Remove access does not change a harness that already loads it. A harness that loads it runs its code with that harness's own access.",
    );
    expect(SOURCE).toContain('legend: "Host tools it may be given in a harness"');
    for (const label of ["Allow selected", "Not now", "Remove access", "Use in this harness"]) {
      expect(SOURCE).toContain(`text: "${label}"`);
    }
  });

  test("two harnesses that share a spec name are told apart by their ids", () => {
    const harnesses = [
      { id: "hrn_00000000000000a1", specName: "concierge" },
      { id: "hrn_00000000000000a2", specName: "concierge" },
    ];
    const lines = stillLoadedLines(
      [
        { id: "hrn_00000000000000a1", tools: ["Bash"] },
        { id: "hrn_00000000000000a2", tools: ["Bash"] },
      ],
      harnesses,
    );
    expect(lines[0]).not.toBe(lines[1]);
    expect(lines[0]).toContain("hrn_00000000000000a1");
    expect(lines[1]).toContain("hrn_00000000000000a2");
    expect(lines[0]?.startsWith("concierge (")).toBe(true);
  });

  test("in the grant form, two harnesses that share a spec name are told apart by their ids", () => {
    const a = harnessChoiceLabel({ id: "hrn_00000000000000a1", specName: "concierge" }, true);
    const b = harnessChoiceLabel({ id: "hrn_00000000000000a2", specName: "concierge" });
    expect(a).toBe("concierge (hrn_00000000000000a1) (asked for)");
    expect(b).toBe("concierge (hrn_00000000000000a2)");
    expect(harnessChoiceLabel({ id: "hrn_00000000000000b2" })).toBe("hrn_00000000000000b2");
    // The form labels each harness with it.
    expect(SOURCE).toContain("const label = harnessChoiceLabel(row, asked.has(row.id));");
  });

  test("the harnesses that still load a plugin are named by spec name and id, else by id", () => {
    const harnesses = [{ id: "hrn_00000000000000a1", specName: "concierge" }];
    expect(
      stillLoadedLines(
        [
          { id: "hrn_00000000000000a1", tools: ["Bash"] },
          { id: "hrn_00000000000000b2", tools: [] },
          { id: "hrn_00000000000000c3", tools: null },
        ],
        harnesses,
      ),
    ).toEqual([
      "concierge (hrn_00000000000000a1): host tools Bash",
      "hrn_00000000000000b2: no host tools",
      "hrn_00000000000000c3: its crewhaus.yaml could not be read",
    ]);
    expect(stillLoadedLines(undefined, harnesses)).toEqual([]);
    // Each line links to the harness it names.
    expect(SOURCE).toContain("href: hrefHarness(line.id)");
    expect(SOURCE).toContain(
      "These harnesses still load it, because their crewhaus.yaml lists it:",
    );
    expect(SOURCE).toContain(
      "Remove it from plugins: in each crewhaus.yaml, then rebuild and restart that harness.",
    );
  });

  test("the panes notice names waiting plugins only when the answer carries their names", () => {
    expect(waitingNotice({ waiting: ["notes-pane"], waitingCount: 1 })).toEqual({
      title: "Waiting for your OK",
      text: "notes-pane asks to add panels here.",
      review: true,
    });
    const counted = waitingNotice({ waiting: [], waitingCount: 1 });
    expect(counted).toEqual({
      title: "Waiting for the owner's OK",
      text: "A plugin asks to add panels here. The owner can allow it in Settings › Plugins.",
      review: false,
    });
    expect(JSON.stringify(counted).includes("notes-pane")).toBe(false);
    expect(waitingNotice({ waiting: [], waitingCount: 0 })).toBeNull();
    // An answer without a count falls back to the names it carries.
    expect(waitingNotice({ waiting: ["notes-pane"] })?.review).toBe(true);
  });
});
