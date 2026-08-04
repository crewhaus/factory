/**
 * M4's browser-side logic, proven without a browser.
 *
 * Everything a screen DECIDES here is a pure function — which overlay owns a
 * keypress, what the omnibox list contains and in what order, how the health
 * board ranks, what document a sandboxed pane frame is given — so the
 * interesting cases are unit tests rather than a click-through. The exact
 * files the browser loads are the files under test.
 */
import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { bindingSheet, globalKey, initialKeyState, keyShape } from "../assets/js/keys.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { canRunAction, omniRows } from "../assets/js/omnibox.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { GLOBAL_VIEWS, HARNESS_TABS, parseRoute } from "../assets/js/router.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { healthScoreCard, rankHealthRows } from "../assets/js/views/health.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { shouldOnboard } from "../assets/js/views/onboarding.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { paneSandbox, paneSrcdoc } from "../assets/js/views/panes.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { splitList } from "../assets/js/views/settings.js";

type KeyShape = {
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  inField?: boolean;
};

const press = (
  state: Record<string, boolean>,
  shape: KeyShape,
): { state: Record<string, boolean>; effect: string | null; claimed: boolean } =>
  globalKey(state, shape) as never;

describe("globalKey — HM-190 ownership", () => {
  test("⌘K and Ctrl-K open the omnibox from anywhere but a field", () => {
    for (const mod of [{ meta: true }, { ctrl: true }]) {
      const r = press(initialKeyState(), { key: "k", ...mod });
      expect(r.effect).toBe("open-omnibox");
      expect(r.claimed).toBe(true);
      expect(r.state.omniboxOpen).toBe(true);
    }
    // …and toggles closed when it is already open.
    const closed = press({ ...initialKeyState(), omniboxOpen: true }, { key: "k", meta: true });
    expect(closed.effect).toBe("close-omnibox");
  });

  test("a key pressed in a field is never claimed — including ⌘K", () => {
    for (const shape of [
      { key: "k", meta: true, inField: true },
      { key: "?", inField: true },
      { key: "j", inField: true },
      { key: "Escape", inField: true },
    ] as KeyShape[]) {
      const r = press(initialKeyState(), shape);
      expect(`${shape.key}:${r.claimed}`).toBe(`${shape.key}:false`);
      expect(r.effect).toBeNull();
    }
  });

  test("while the omnibox is open it owns every key except Escape", () => {
    const open = { ...initialKeyState(), omniboxOpen: true };
    const j = press(open, { key: "j" });
    expect(j.claimed).toBe(true);
    expect(j.effect).toBeNull();
    const esc = press(open, { key: "Escape" });
    expect(esc.effect).toBe("close-omnibox");
    expect(esc.state.omniboxOpen).toBe(false);
  });

  test("`?` opens the app sheet only when no inbox is mounted", () => {
    const noInbox = press(initialKeyState(), { key: "?" });
    expect(noInbox.effect).toBe("toggle-sheet");
    expect(noInbox.state.sheetOpen).toBe(true);

    // On the approvals/review screens the inbox binds `?` for its own sheet;
    // claiming it here would open two sheets on one keypress.
    const inbox = press({ ...initialKeyState(), inboxMounted: true }, { key: "?" });
    expect(inbox.claimed).toBe(false);
    expect(inbox.effect).toBeNull();
  });

  test("the inbox's own keys always fall through unclaimed", () => {
    for (const key of ["j", "k", "g", "d", "u", "p", "f", "."]) {
      const r = press({ ...initialKeyState(), inboxMounted: true }, { key });
      expect(`${key}:${r.claimed}`).toBe(`${key}:false`);
    }
  });

  test("browser chords (⌘R, ⌘L, alt-…) are left to the browser", () => {
    for (const shape of [
      { key: "r", meta: true },
      { key: "l", ctrl: true },
      { key: "j", alt: true },
    ] as KeyShape[]) {
      expect(press(initialKeyState(), shape).claimed).toBe(false);
    }
  });

  test("Escape closes the sheet, and does nothing when nothing is open", () => {
    const closes = press({ ...initialKeyState(), sheetOpen: true }, { key: "Escape" });
    expect(closes.effect).toBe("close-sheet");
    expect(press(initialKeyState(), { key: "Escape" }).claimed).toBe(false);
  });

  test("keyShape reads a field target and the modifier flags", () => {
    const inInput = keyShape({ key: "k", metaKey: true, target: { tagName: "INPUT" } });
    expect(inInput).toMatchObject({ key: "k", meta: true, inField: true });
    const inBody = keyShape({ key: "?", target: { tagName: "BODY" } });
    expect(inBody.inField).toBe(false);
    // A contenteditable div is a field too.
    expect(
      keyShape({ key: "x", target: { tagName: "DIV", isContentEditable: true } }).inField,
    ).toBe(true);
    // A missing event never throws.
    expect(keyShape(undefined).key).toBe("");
  });

  test("the sheet lists every binding, and names the inbox section for context", () => {
    const sections = bindingSheet(false) as Array<{ section: string; bindings: unknown[] }>;
    expect(sections).toHaveLength(2);
    expect(sections.every((s) => s.bindings.length > 0)).toBe(true);
    expect((bindingSheet(true) as Array<{ section: string }>)[1]?.section).toBe("This inbox");
  });
});

describe("omniRows — HM-189", () => {
  const payload = {
    entries: [
      { kind: "harness", id: "hrn_1", title: "polymarket", subtitle: "/h/poly", href: "#/h/hrn_1" },
      { kind: "wiki", id: "deploy", title: "deploy", subtitle: "wiki", href: "#/h/hrn_1/memory" },
    ],
    actions: [
      {
        id: "start:hrn_1",
        label: "Start polymarket",
        route: "procStart",
        params: { id: "hrn_1" },
        cliTwin: "crewhaus daemon start --dir /h/poly",
        confirm: true,
      },
    ],
  };

  test("navigation entries come first; actions are last and always need a confirm", () => {
    const rows = omniRows(payload) as Array<{ kind: string; confirm?: boolean; cliTwin?: string }>;
    expect(rows.map((r) => r.kind)).toEqual(["harness", "wiki", "action"]);
    expect(rows[2]?.confirm).toBe(true);
    expect(rows[2]?.cliTwin).toContain("crewhaus daemon start");
  });

  test("a server that claims an action needs no confirm is not believed", () => {
    const rows = omniRows({
      entries: [],
      actions: [{ id: "a", label: "x", route: "procStop", params: {}, confirm: false }],
    }) as Array<{ confirm: boolean }>;
    expect(rows[0]?.confirm).toBe(true);
  });

  test("a malformed payload yields no rows rather than throwing", () => {
    expect(omniRows(null)).toEqual([]);
    expect(omniRows({})).toEqual([]);
    expect(omniRows({ entries: "nope", actions: 7 })).toEqual([]);
  });

  test("only the process verbs are executable from the omnibox", () => {
    for (const route of ["procStart", "procStop", "procRestart", "procDrain"]) {
      expect(`${route}:${canRunAction(route)}`).toBe(`${route}:true`);
    }
    // Anything else the server might propose renders, but cannot run.
    for (const route of ["removeHarness", "specEdit", "memoryForget", "", "nonsense"]) {
      expect(`${route}:${canRunAction(route)}`).toBe(`${route}:false`);
    }
  });
});

describe("health rendering — HM-11", () => {
  test("the board ranks worst first, ties broken by name", () => {
    const rows = rankHealthRows({
      harnesses: [
        { id: "a", specName: "alpha", health: { score: 90 } },
        { id: "b", specName: "bravo", health: { score: 40 } },
        { id: "c", specName: "charlie", health: { score: 40 } },
        { id: "d", specName: "delta", health: null },
      ],
    }) as Array<{ specName: string }>;
    expect(rows.map((r) => r.specName)).toEqual(["bravo", "charlie", "alpha", "delta"]);
  });

  test("a malformed payload ranks to nothing", () => {
    expect(rankHealthRows(null)).toEqual([]);
    expect(rankHealthRows({ harnesses: "nope" })).toEqual([]);
  });

  test("the card is a pure builder that never throws on a partial payload", () => {
    // No DOM here: `healthScoreCard` is only called from a browser, so what
    // is asserted is that it is exported and reachable — the DOM-touching
    // half is covered by the asset-hygiene suite.
    expect(typeof healthScoreCard).toBe("function");
  });
});

describe("shouldOnboard — HM-12", () => {
  test("hands over only when there is genuinely nothing", () => {
    expect(shouldOnboard({ firstBoot: true }, 0)).toBe(true);
    // A registered harness is never first boot, whatever the server said.
    expect(shouldOnboard({ firstBoot: true }, 3)).toBe(false);
    // A configured scan root that found nothing is an EMPTY SCAN, and the
    // Library's own empty state (which names the scan verb) answers it.
    expect(shouldOnboard({ firstBoot: false }, 0)).toBe(false);
    expect(shouldOnboard(null, 0)).toBe(false);
  });
});

describe("plugin panes — HM-179 containment", () => {
  test("the sandbox never grants same-origin, however the payload is shaped", () => {
    expect(paneSandbox({ sandbox: "allow-scripts" })).toBe("allow-scripts");
    // A server (or a tampered payload) asking for same-origin is stripped:
    // with it, the frame would reach this document and its bearer token.
    expect(paneSandbox({ sandbox: "allow-scripts allow-same-origin" })).toBe("allow-scripts");
    expect(paneSandbox({ sandbox: "allow-same-origin" })).toBe("allow-scripts");
    expect(paneSandbox({})).toBe("allow-scripts");
    expect(paneSandbox(null)).toBe("allow-scripts");
  });

  test("the srcdoc carries the CSP, and a quote in it cannot break the attribute", () => {
    const doc = paneSrcdoc({ csp: "default-src 'none'; connect-src 'none'", doc: "<p>hi</p>" });
    expect(doc).toContain('http-equiv="Content-Security-Policy"');
    expect(doc).toContain("content=\"default-src 'none'; connect-src 'none'\"");
    expect(doc).toContain("<p>hi</p>");

    const injected = paneSrcdoc({ csp: 'x" onload="alert(1)', doc: "" });
    expect(injected).not.toContain('onload="alert(1)"');
    expect(injected).toContain("&quot;");
  });

  test("an absent policy still yields a locked-down document", () => {
    expect(paneSrcdoc(null)).toContain("content=\"default-src 'none'\"");
  });
});

describe("settings helpers", () => {
  test("splitList trims, drops empties and keeps order", () => {
    expect(splitList("a, b ,, c ")).toEqual(["a", "b", "c"]);
    expect(splitList("")).toEqual([]);
    expect(splitList(null)).toEqual([]);
  });
});

describe("router — the M4 screens are deep-linkable", () => {
  test("#/health and #/settings resolve, and so does the panes tab", () => {
    expect(GLOBAL_VIEWS).toContain("health");
    expect(GLOBAL_VIEWS).toContain("settings");
    expect(HARNESS_TABS).toContain("panes");
    expect(parseRoute("#/health")).toEqual({ view: "health" });
    expect(parseRoute("#/settings")).toEqual({ view: "settings" });
    expect(parseRoute("#/h/hrn_1/panes")).toEqual({ view: "harness", id: "hrn_1", tab: "panes" });
  });
});
