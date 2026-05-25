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

  test("connect + click + screenshot delegates to executor", async () => {
    const calls: string[] = [];
    const viewport: Viewport = { width: 1920, height: 1080, devicePixelRatio: 1 };
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
    };
    const driver = createHostDriver({ enabled: true, executor });
    await driver.connect();
    await driver.click(100, 200, "left");
    const shot = await driver.screenshot();
    expect(shot).toBeInstanceOf(Uint8Array);
    expect(shot[0]).toBe(0x89);
    expect(shot[1]).toBe(0x50);
    expect(calls).toEqual(["click 100,200 left", "screenshot"]);
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
});
