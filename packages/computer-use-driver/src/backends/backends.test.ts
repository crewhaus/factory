/**
 * Section 30 — host + remote driver contract tests.
 */
import { describe, expect, test } from "bun:test";
import { ComputerUseDriverError, type Viewport } from "../index";
import { type HostExecutor, createHostDriver } from "./host";
import { type PuppeteerCoreLike, createRemoteDriver } from "./remote";

describe("host driver — Section 30", () => {
  test("disabled flag → throws on construction", () => {
    expect(() => createHostDriver({ enabled: false, executor: {} as never })).toThrow(
      ComputerUseDriverError,
    );
  });

  test("connect + every operation delegates to the executor", async () => {
    const calls: string[] = [];
    const viewport: Viewport = { width: 1920, height: 1080, devicePixelRatio: 1 };
    let closed = false;
    const executor: HostExecutor = {
      async click(x, y, button) {
        calls.push(`click ${x},${y} ${button}`);
      },
      async type(text) {
        calls.push(`type ${text}`);
      },
      async key(combo) {
        calls.push(`key ${combo}`);
      },
      async scroll(x, y, dx, dy) {
        calls.push(`scroll ${x},${y} ${dx},${dy}`);
      },
      async screenshot() {
        calls.push("screenshot");
        // "iVBORw0KGgo=" decodes to the PNG magic bytes (0x89 0x50 0x4E 0x47 ...).
        return { pngBase64: "iVBORw0KGgo=", viewport };
      },
      async close() {
        closed = true;
      },
    };
    const driver = createHostDriver({ enabled: true, executor });
    await driver.connect();
    await driver.click(100, 200, "left");
    const shot = await driver.screenshot();
    expect(shot).toBeInstanceOf(Uint8Array);
    expect(shot[0]).toBe(0x89);
    expect(shot[1]).toBe(0x50);
    await driver.type("hello");
    await driver.key("cmd+space");
    await driver.scroll(5, 6);
    const vp = await driver.getViewport();
    expect(vp).toEqual(viewport);
    await driver.disconnect();
    expect(closed).toBe(true);
    expect(calls).toEqual([
      "click 100,200 left",
      "screenshot",
      "type hello",
      "key cmd+space",
      "scroll 0,0 5,6",
      "screenshot", // getViewport screenshots to read the viewport
    ]);
  });

  test("click defaults to the left button when none is given", async () => {
    const calls: string[] = [];
    const executor: HostExecutor = {
      async click(x, y, button) {
        calls.push(`click ${x},${y} ${button}`);
      },
      async type() {},
      async key() {},
      async scroll() {},
      async screenshot() {
        return { pngBase64: "", viewport: { width: 0, height: 0, devicePixelRatio: 1 } };
      },
    };
    const driver = createHostDriver({ enabled: true, executor });
    await driver.connect();
    await driver.click(7, 8);
    expect(calls).toEqual(["click 7,8 left"]);
  });

  test("disconnect tolerates an executor without a close() method", async () => {
    const executor: HostExecutor = {
      async click() {},
      async type() {},
      async key() {},
      async scroll() {},
      async screenshot() {
        return { pngBase64: "", viewport: { width: 0, height: 0, devicePixelRatio: 1 } };
      },
      // no close — optional-chaining must not throw
    };
    const driver = createHostDriver({ enabled: true, executor });
    await driver.connect();
    await expect(driver.disconnect()).resolves.toBeUndefined();
    // After disconnect, guarded operations throw again.
    await expect(driver.screenshot()).rejects.toBeInstanceOf(ComputerUseDriverError);
  });

  test("type / key / getViewport reject before connect", async () => {
    const executor: HostExecutor = {
      async click() {},
      async type() {},
      async key() {},
      async scroll() {},
      async screenshot() {
        return { pngBase64: "", viewport: { width: 0, height: 0, devicePixelRatio: 1 } };
      },
    };
    const driver = createHostDriver({ enabled: true, executor });
    await expect(driver.type("x")).rejects.toBeInstanceOf(ComputerUseDriverError);
    await expect(driver.key("Enter")).rejects.toBeInstanceOf(ComputerUseDriverError);
    await expect(driver.scroll(0, 0)).rejects.toBeInstanceOf(ComputerUseDriverError);
    await expect(driver.getViewport()).rejects.toBeInstanceOf(ComputerUseDriverError);
    await expect(driver.screenshot()).rejects.toBeInstanceOf(ComputerUseDriverError);
  });

  test("scroll delegates to executor with zero anchor", async () => {
    const calls: string[] = [];
    const executor: HostExecutor = {
      async click() {},
      async type() {},
      async key() {},
      async scroll(x, y, dx, dy) {
        calls.push(`scroll ${x},${y} ${dx},${dy}`);
      },
      async screenshot() {
        return {
          pngBase64: "",
          viewport: { width: 0, height: 0, devicePixelRatio: 1 },
        };
      },
    };
    const driver = createHostDriver({ enabled: true, executor });
    await driver.connect();
    await driver.scroll(10, 20);
    expect(calls).toEqual(["scroll 0,0 10,20"]);
  });

  test("operations before connect throw", async () => {
    const executor = {
      async click() {},
      async type() {},
      async key() {},
      async scroll() {},
      async screenshot() {
        return {
          pngBase64: "",
          viewport: { width: 0, height: 0, devicePixelRatio: 1 },
        };
      },
    } as HostExecutor;
    const driver = createHostDriver({ enabled: true, executor });
    await expect(driver.click(0, 0)).rejects.toBeInstanceOf(ComputerUseDriverError);
  });

  test("goto throws — host backend cannot navigate URLs", async () => {
    const driver = createHostDriver({
      enabled: true,
      executor: {
        async screenshot() {
          return {
            pngBase64: "",
            viewport: { width: 0, height: 0, devicePixelRatio: 1 },
          };
        },
      } as HostExecutor,
    });
    await driver.connect();
    await expect(driver.goto("https://x.com")).rejects.toBeInstanceOf(ComputerUseDriverError);
  });
});

describe("remote driver — Section 30", () => {
  test("missing url throws on construction", () => {
    expect(() => createRemoteDriver({ url: "" })).toThrow(ComputerUseDriverError);
  });

  test("connect without _puppeteer throws with install hint", async () => {
    const driver = createRemoteDriver({ url: "ws://test" });
    await expect(driver.connect()).rejects.toThrow(/puppeteer-core/);
  });

  test("connect + screenshot + click delegate to puppeteer-core stub", async () => {
    const ops: string[] = [];
    const stubPage = {
      async goto(url: string) {
        ops.push(`goto ${url}`);
      },
      async screenshot() {
        ops.push("screenshot");
        return Buffer.from("png-data");
      },
      mouse: {
        async click(x: number, y: number, opts?: { button?: string }) {
          ops.push(`click ${x},${y} ${opts?.button}`);
        },
      },
      keyboard: {
        async type(text: string) {
          ops.push(`type ${text}`);
        },
        async press(key: string) {
          ops.push(`press ${key}`);
        },
      },
      async evaluate<T>(_fn: () => T) {
        return undefined as unknown as T;
      },
      async close() {
        ops.push("close-page");
      },
    };
    const stubBrowser = {
      async newPage() {
        return stubPage;
      },
      async close() {
        ops.push("close-browser");
      },
    };
    const stubPuppeteer: PuppeteerCoreLike = {
      async connect(_opts) {
        ops.push("connect");
        return stubBrowser as never;
      },
    };
    const driver = createRemoteDriver({ url: "ws://test", _puppeteer: stubPuppeteer });
    await driver.connect();
    await driver.goto("https://x.com");
    await driver.click(50, 60, "right");
    await driver.disconnect();
    expect(ops).toContain("connect");
    expect(ops).toContain("goto https://x.com");
    expect(ops).toContain("click 50,60 right");
    expect(ops).toContain("close-browser");
  });

  /** Build a fully-stubbed puppeteer-core whose page records into `ops`. */
  function makeStub(ops: string[], opts?: { screenshotAsString?: boolean }) {
    const page = {
      async goto(url: string) {
        ops.push(`goto ${url}`);
      },
      async screenshot(_o?: { encoding?: "base64" }) {
        ops.push("screenshot");
        // "aGk=" is base64 for "hi"; cover both the string and Buffer arms.
        return opts?.screenshotAsString ? "aGk=" : Buffer.from("hi");
      },
      mouse: {
        async click(x: number, y: number, o?: { button?: string }) {
          ops.push(`click ${x},${y} ${o?.button}`);
        },
      },
      keyboard: {
        async type(text: string) {
          ops.push(`type ${text}`);
        },
        async press(key: string) {
          ops.push(`press ${key}`);
        },
      },
      // The real driver casts the page and calls evaluate(fn, arg). Run the fn
      // against a stub global exposing scrollBy so the closure body executes.
      async evaluate(fn: (d: { dx: number; dy: number }) => void, arg: { dx: number; dy: number }) {
        const g = globalThis as Record<string, unknown>;
        const prev = g["scrollBy"];
        g["scrollBy"] = (dx: number, dy: number) => {
          ops.push(`scrollBy ${dx},${dy}`);
        };
        try {
          fn(arg);
        } finally {
          g["scrollBy"] = prev;
        }
      },
      async close() {
        ops.push("close-page");
      },
    };
    const browser = {
      async newPage() {
        return page;
      },
      async close() {
        ops.push("close-browser");
      },
    };
    const puppeteer: PuppeteerCoreLike = {
      async connect(_o) {
        return browser as never;
      },
    };
    return { puppeteer, page, browser };
  }

  test("screenshot decodes a base64 string from puppeteer", async () => {
    const ops: string[] = [];
    const { puppeteer } = makeStub(ops, { screenshotAsString: true });
    const driver = createRemoteDriver({ url: "ws://t", _puppeteer: puppeteer });
    await driver.connect();
    const png = await driver.screenshot();
    expect(png).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(png).toString()).toBe("hi");
  });

  test("screenshot re-encodes a Buffer from puppeteer", async () => {
    const ops: string[] = [];
    const { puppeteer } = makeStub(ops, { screenshotAsString: false });
    const driver = createRemoteDriver({ url: "ws://t", _puppeteer: puppeteer });
    await driver.connect();
    const png = await driver.screenshot();
    expect(Buffer.from(png).toString()).toBe("hi");
  });

  test("type / key / scroll delegate through puppeteer", async () => {
    const ops: string[] = [];
    const { puppeteer } = makeStub(ops);
    const driver = createRemoteDriver({ url: "ws://t", _puppeteer: puppeteer });
    await driver.connect();
    await driver.type("hello");
    await driver.key("Enter");
    await driver.scroll(11, 22);
    expect(ops).toContain("type hello");
    expect(ops).toContain("press Enter");
    // The scroll closure runs in the (stubbed) page context and calls scrollBy.
    expect(ops).toContain("scrollBy 11,22");
  });

  test("click defaults to the left button when none is given", async () => {
    const ops: string[] = [];
    const { puppeteer } = makeStub(ops);
    const driver = createRemoteDriver({ url: "ws://t", _puppeteer: puppeteer });
    await driver.connect();
    await driver.click(1, 2);
    expect(ops).toContain("click 1,2 left");
  });

  test("getViewport returns the override when provided", async () => {
    const ops: string[] = [];
    const { puppeteer } = makeStub(ops);
    const viewport: Viewport = { width: 640, height: 480, devicePixelRatio: 2 };
    const driver = createRemoteDriver({ url: "ws://t", viewport, _puppeteer: puppeteer });
    await driver.connect();
    expect(await driver.getViewport()).toEqual(viewport);
  });

  test("getViewport falls back to 1280x800 when no override", async () => {
    const ops: string[] = [];
    const { puppeteer } = makeStub(ops);
    const driver = createRemoteDriver({ url: "ws://t", _puppeteer: puppeteer });
    await driver.connect();
    expect(await driver.getViewport()).toEqual({ width: 1280, height: 800, devicePixelRatio: 1 });
  });

  test("operations before connect throw 'not connected'", async () => {
    const driver = createRemoteDriver({ url: "ws://t", _puppeteer: makeStub([]).puppeteer });
    await expect(driver.goto("https://x.com")).rejects.toThrow(/not connected/);
    await expect(driver.screenshot()).rejects.toThrow(/not connected/);
    await expect(driver.click(0, 0)).rejects.toThrow(/not connected/);
    await expect(driver.type("x")).rejects.toThrow(/not connected/);
    await expect(driver.key("Enter")).rejects.toThrow(/not connected/);
    await expect(driver.scroll(0, 0)).rejects.toThrow(/not connected/);
  });

  test("disconnect closes page then browser and resets state", async () => {
    const ops: string[] = [];
    const { puppeteer } = makeStub(ops);
    const driver = createRemoteDriver({ url: "ws://t", _puppeteer: puppeteer });
    await driver.connect();
    await driver.disconnect();
    expect(ops).toContain("close-page");
    expect(ops).toContain("close-browser");
    // After disconnect the page handle is cleared → operations throw again.
    await expect(driver.click(0, 0)).rejects.toThrow(/not connected/);
  });

  test("disconnect swallows close() failures (best-effort)", async () => {
    const ops: string[] = [];
    const { puppeteer, page } = makeStub(ops);
    page.close = async () => {
      throw new Error("page close failed");
    };
    const driver = createRemoteDriver({ url: "ws://t", _puppeteer: puppeteer });
    await driver.connect();
    await expect(driver.disconnect()).resolves.toBeUndefined();
  });

  test("disconnect before connect is a no-op (no page / browser handles)", async () => {
    const driver = createRemoteDriver({ url: "ws://t", _puppeteer: makeStub([]).puppeteer });
    await expect(driver.disconnect()).resolves.toBeUndefined();
  });
});
