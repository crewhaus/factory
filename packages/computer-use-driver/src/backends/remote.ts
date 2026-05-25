/**
 * Section 30 — remote backend for `computer-use-driver`. Connects to a
 * remote chromium instance over Chrome DevTools Protocol (browserless.io,
 * BrowserBase, self-hosted DevTools). Same `Driver` surface as the
 * Playwright-backed `chromium` backend; the difference is the connection
 * layer.
 *
 * Production deployments install `puppeteer-core` and pass it as
 * `_puppeteer`. Without it, the constructor returns a driver whose
 * `connect()` throws a clear diagnostic — matching the SQS / Vapi
 * pattern of "abstraction always builds; deployment-time SDK presence
 * gates the operation".
 */
import { ComputerUseDriverError, type Driver, type Viewport } from "../index";

export type RemoteBackendOptions = {
  /** Browserless / BrowserBase WebSocket endpoint. */
  readonly url: string;
  /** Optional viewport override; defaults to 1280×800. */
  readonly viewport?: Viewport;
  /**
   * Test / production injection: `puppeteer-core` `import` namespace.
   * When undefined, the driver throws at `connect()` with a hint to
   * install puppeteer-core.
   */
  readonly _puppeteer?: PuppeteerCoreLike;
};

export type PuppeteerCoreLike = {
  connect(opts: { browserWSEndpoint: string }): Promise<{
    newPage(): Promise<{
      goto(url: string): Promise<void>;
      screenshot(opts?: { encoding?: "base64" }): Promise<string | Buffer>;
      mouse: {
        click(x: number, y: number, opts?: { button?: string }): Promise<void>;
      };
      keyboard: {
        type(text: string): Promise<void>;
        press(key: string): Promise<void>;
      };
      evaluate<T>(fn: () => T): Promise<T>;
      close(): Promise<void>;
    }>;
    close(): Promise<void>;
  }>;
};

export function createRemoteDriver(opts: RemoteBackendOptions): Driver {
  if (!opts.url) throw new ComputerUseDriverError("remote backend requires url");
  let browser: Awaited<ReturnType<NonNullable<typeof opts._puppeteer>["connect"]>> | undefined;
  let page: Awaited<ReturnType<NonNullable<typeof browser>["newPage"]>> | undefined;
  let connected = false;

  function ensure(): NonNullable<typeof page> {
    if (!page) throw new ComputerUseDriverError("remote driver not connected");
    return page;
  }

  return {
    backend: "remote",
    async connect(): Promise<void> {
      const pup = opts._puppeteer;
      if (!pup) {
        throw new ComputerUseDriverError(
          "remote backend requires `puppeteer-core` to be installed and passed as `_puppeteer`. e.g. `import * as pc from 'puppeteer-core'; createDriver({ backend: 'remote', url, _puppeteer: pc })`.",
        );
      }
      browser = await pup.connect({ browserWSEndpoint: opts.url });
      page = await browser.newPage();
      connected = true;
    },
    async goto(url: string): Promise<void> {
      await ensure().goto(url);
    },
    async screenshot(): Promise<Uint8Array> {
      const buffer = await ensure().screenshot({ encoding: "base64" });
      const pngBase64 = typeof buffer === "string" ? buffer : buffer.toString("base64");
      return Buffer.from(pngBase64, "base64");
    },
    async click(x: number, y: number, button = "left"): Promise<void> {
      await ensure().mouse.click(x, y, { button });
    },
    async type(text: string): Promise<void> {
      await ensure().keyboard.type(text);
    },
    async key(combo: string): Promise<void> {
      await ensure().keyboard.press(combo);
    },
    async scroll(dx: number, dy: number): Promise<void> {
      // Puppeteer doesn't expose mouse.wheel directly; dispatch from the
      // page context where `window` is defined. The eval-with-args shape
      // isn't on the local PuppeteerCoreLike type; cast to puppeteer's
      // actual surface to call it.
      const pageWithArgs = ensure() as unknown as {
        evaluate(
          fn: (d: { dx: number; dy: number }) => void,
          arg: { dx: number; dy: number },
        ): Promise<void>;
      };
      await pageWithArgs.evaluate(
        (d: { dx: number; dy: number }) => {
          (globalThis as unknown as { scrollBy: (dx: number, dy: number) => void }).scrollBy(
            d.dx,
            d.dy,
          );
        },
        { dx, dy },
      );
    },
    async getViewport(): Promise<Viewport> {
      const v = opts.viewport;
      if (v !== undefined) return v;
      return { width: 1280, height: 800, devicePixelRatio: 1 };
    },
    async disconnect(): Promise<void> {
      try {
        if (page) await page.close();
        if (browser) await browser.close();
      } catch {
        /* best-effort */
      }
      connected = false;
      page = undefined;
      browser = undefined;
    },
  };
}
