/**
 * Catalog R18 — chromium (Playwright-backed) driver contract tests.
 *
 * Playwright is an optional peer dep that may be present in the tree. To stay
 * deterministic (no real browser launch, no real clock/network), we intercept
 * the lazy `import("playwright")` with `mock.module` and drive a fully stubbed
 * browser → context → page chain. Each test (re)establishes the mock before
 * use because `mock.module` is process-global and one test deliberately makes
 * the import fail.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { createDriver } from "./index.js";

/** Records every call routed through the fake Playwright surface. */
type Rec = string[];

/** Build a fake `playwright` module whose page records into `rec`. */
function fakePlaywright(rec: Rec, overrides?: { viewportSize?: () => unknown }) {
  const page = {
    async goto(url: string, optsArg?: unknown) {
      rec.push(`goto ${url} ${JSON.stringify(optsArg)}`);
    },
    async screenshot(optsArg?: { type?: string }) {
      rec.push(`screenshot ${optsArg?.type}`);
      // PNG magic header so the returned Uint8Array is recognizable.
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    },
    mouse: {
      async click(x: number, y: number, optsArg?: { button?: string }) {
        rec.push(`click ${x},${y} ${optsArg?.button}`);
      },
      async wheel(dx: number, dy: number) {
        rec.push(`wheel ${dx},${dy}`);
      },
    },
    keyboard: {
      async type(t: string) {
        rec.push(`type ${t}`);
      },
      async press(k: string) {
        rec.push(`press ${k}`);
      },
    },
    viewportSize: overrides?.viewportSize ?? (() => ({ width: 1280, height: 720 })),
    async textContent(sel: string) {
      rec.push(`textContent ${sel}`);
      return "hello body";
    },
  };
  const context = {
    async newPage() {
      rec.push("newPage");
      return page;
    },
  };
  const browser = {
    async newContext(ctxOpts: unknown) {
      rec.push(`newContext ${JSON.stringify(ctxOpts)}`);
      return context;
    },
    async close() {
      rec.push("close");
    },
  };
  return {
    chromium: {
      async launch(launchOpts: unknown) {
        rec.push(`launch ${JSON.stringify(launchOpts)}`);
        return browser;
      },
    },
    __page: page,
    __browser: browser,
  };
}

function installPlaywright(rec: Rec, overrides?: { viewportSize?: () => unknown }) {
  const fake = fakePlaywright(rec, overrides);
  mock.module("playwright", () => fake);
  return fake;
}

afterEach(() => {
  // Leave a benign working module registered so per-test fakes cannot bleed
  // into unrelated tests / files run later in the process. We deliberately do
  // NOT restore the real playwright: it is an optional peer dep that may be
  // absent, nothing else in this package's test process imports it, and a
  // working fake guarantees no test can ever launch a real browser.
  mock.module("playwright", () => fakePlaywright([]));
});

describe("chromium driver — connect / lifecycle", () => {
  test("connect launches with defaults, creates context + page", async () => {
    const rec: Rec = [];
    installPlaywright(rec);
    const d = createDriver({ backend: "chromium" });
    await d.connect();
    expect(rec).toEqual([
      `launch ${JSON.stringify({ headless: true })}`,
      `newContext ${JSON.stringify({ viewport: { width: 1280, height: 720 } })}`,
      "newPage",
    ]);
  });

  test("connect honours playwrightOptions + viewport overrides", async () => {
    const rec: Rec = [];
    installPlaywright(rec);
    const d = createDriver({
      backend: "chromium",
      playwrightOptions: { headless: false, slowMo: 5 },
      viewport: { width: 800, height: 600 },
    });
    await d.connect();
    expect(rec[0]).toBe(`launch ${JSON.stringify({ headless: false, slowMo: 5 })}`);
    expect(rec[1]).toBe(`newContext ${JSON.stringify({ viewport: { width: 800, height: 600 } })}`);
  });

  test("connect is idempotent — second call is a no-op", async () => {
    const rec: Rec = [];
    installPlaywright(rec);
    const d = createDriver({ backend: "chromium" });
    await d.connect();
    const afterFirst = rec.length;
    await d.connect();
    expect(rec.length).toBe(afterFirst);
  });

  // The playwright-import-failure path (loadPlaywright catch) is covered in
  // chromium-import-fail.test.ts via the `_importPlaywright` injection seam.
  // It cannot be tested with mock.module here: bun evaluates a throwing
  // factory eagerly once the module has been imported (even as a fake, as
  // these tests do), so registration itself would blow up.
});

describe("chromium driver — operations after connect", () => {
  async function connected(rec: Rec, overrides?: { viewportSize?: () => unknown }) {
    installPlaywright(rec, overrides);
    const d = createDriver({ backend: "chromium" });
    await d.connect();
    rec.length = 0; // drop connect noise; focus on the operation under test
    return d;
  }

  test("goto navigates with domcontentloaded wait", async () => {
    const rec: Rec = [];
    const d = await connected(rec);
    await d.goto("https://example.com");
    expect(rec).toEqual([
      `goto https://example.com ${JSON.stringify({ waitUntil: "domcontentloaded" })}`,
    ]);
  });

  test("screenshot returns the page PNG bytes", async () => {
    const rec: Rec = [];
    const d = await connected(rec);
    const png = await d.screenshot();
    expect(png).toBeInstanceOf(Uint8Array);
    expect(Array.from(png)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(rec).toEqual(["screenshot png"]);
  });

  test("click defaults to the left button", async () => {
    const rec: Rec = [];
    const d = await connected(rec);
    await d.click(10, 20);
    expect(rec).toEqual(["click 10,20 left"]);
  });

  test("click forwards an explicit button", async () => {
    const rec: Rec = [];
    const d = await connected(rec);
    await d.click(30, 40, "right");
    expect(rec).toEqual(["click 30,40 right"]);
  });

  test("type forwards to keyboard.type", async () => {
    const rec: Rec = [];
    const d = await connected(rec);
    await d.type("hello world");
    expect(rec).toEqual(["type hello world"]);
  });

  test("key forwards to keyboard.press", async () => {
    const rec: Rec = [];
    const d = await connected(rec);
    await d.key("Control+a");
    expect(rec).toEqual(["press Control+a"]);
  });

  test("scroll forwards to mouse.wheel", async () => {
    const rec: Rec = [];
    const d = await connected(rec);
    await d.scroll(0, 240);
    expect(rec).toEqual(["wheel 0,240"]);
  });

  test("getViewport uses the live page viewportSize when available", async () => {
    const rec: Rec = [];
    const d = await connected(rec);
    const vp = await d.getViewport();
    expect(vp).toEqual({ width: 1280, height: 720, devicePixelRatio: 1 });
  });

  test("getViewport falls back to opts.viewport when page reports null", async () => {
    const rec: Rec = [];
    installPlaywright(rec, { viewportSize: () => null });
    const d = createDriver({ backend: "chromium", viewport: { width: 640, height: 480 } });
    await d.connect();
    const vp = await d.getViewport();
    expect(vp).toEqual({ width: 640, height: 480, devicePixelRatio: 1 });
  });

  test("getViewport falls back to 1280x720 when page is null and no opts viewport", async () => {
    const rec: Rec = [];
    installPlaywright(rec, { viewportSize: () => null });
    const d = createDriver({ backend: "chromium" });
    await d.connect();
    const vp = await d.getViewport();
    expect(vp).toEqual({ width: 1280, height: 720, devicePixelRatio: 1 });
  });

  test("domText returns the body text content", async () => {
    const rec: Rec = [];
    const d = await connected(rec);
    const text = await d.domText?.();
    expect(text).toBe("hello body");
    expect(rec).toEqual(["textContent body"]);
  });

  test("domText coalesces null body text to empty string", async () => {
    const rec: Rec = [];
    const fake = installPlaywright(rec);
    // Page reports no body text content → driver must coalesce null → "".
    (fake.__page as { textContent: (s: string) => Promise<string | null> }).textContent =
      async () => null;
    const d = createDriver({ backend: "chromium" });
    await d.connect();
    const text = await d.domText?.();
    expect(text).toBe("");
  });
});

describe("chromium driver — pre-connect guards", () => {
  test("every operation throws 'not connected' before connect()", async () => {
    const d = createDriver({ backend: "chromium" });
    await expect(d.goto("https://x.com")).rejects.toThrow(/not connected/);
    await expect(d.screenshot()).rejects.toThrow(/not connected/);
    await expect(d.click(0, 0)).rejects.toThrow(/not connected/);
    await expect(d.type("x")).rejects.toThrow(/not connected/);
    await expect(d.key("Enter")).rejects.toThrow(/not connected/);
    await expect(d.scroll(0, 0)).rejects.toThrow(/not connected/);
    await expect(d.getViewport()).rejects.toThrow(/not connected/);
    await expect(d.domText?.()).rejects.toThrow(/not connected/);
  });
});

describe("chromium driver — disconnect", () => {
  test("disconnect closes the browser and resets state", async () => {
    const rec: Rec = [];
    installPlaywright(rec);
    const d = createDriver({ backend: "chromium" });
    await d.connect();
    rec.length = 0;
    await d.disconnect();
    expect(rec).toEqual(["close"]);
    // After disconnect, operations once again report "not connected".
    await expect(d.screenshot()).rejects.toThrow(/not connected/);
  });

  test("disconnect before connect is a no-op", async () => {
    const rec: Rec = [];
    installPlaywright(rec);
    const d = createDriver({ backend: "chromium" });
    await d.disconnect();
    expect(rec).toEqual([]);
  });

  test("disconnect swallows browser.close() failures (best-effort)", async () => {
    const rec: Rec = [];
    const fake = installPlaywright(rec);
    (fake.__browser as { close: () => Promise<void> }).close = async () => {
      rec.push("close-throw");
      throw new Error("close failed");
    };
    const d = createDriver({ backend: "chromium" });
    await d.connect();
    rec.length = 0;
    await d.disconnect(); // must not reject
    expect(rec).toEqual(["close-throw"]);
    // State is still reset despite the close failure.
    await expect(d.click(0, 0)).rejects.toThrow(/not connected/);
  });
});
