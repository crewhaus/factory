/**
 * Catalog R18 `computer-use-driver` — Section 25 BROW.
 *
 * Cross-platform driver for mouse/keyboard/screenshot operations. The
 * `Driver` interface exposes:
 *   - `screenshot()` → PNG `Uint8Array`
 *   - `click(x, y, button?)`
 *   - `type(text)`
 *   - `key(combo)`            // "Enter", "Tab", "Control+a"
 *   - `scroll(dx, dy)`
 *   - `getViewport()` → { width, height, devicePixelRatio }
 *   - `goto(url)`              // browser-only; `host` backend rejects
 *
 * v0 ships ONE concrete backend — `chromium` — driven by Playwright's
 * bundled headless chromium. The kickoff names this `docker-chromium`
 * because it's intended to run inside a Section-18 sandbox; in v0 we
 * lean on Playwright's own chromium-sandboxing (the chromium binary
 * runs as a sandboxed renderer process) and defer the explicit Docker
 * wrapping to a follow-up.
 *
 * The `host` backend (drives the developer's actual desktop) and
 * `remote` backend (CDP-style remote control) are interface stubs that
 * throw at `connect()` — see the kickoff explicitly forbidding the host
 * backend in the smoke ("never use `host` backend for the smoke since
 * it would drive the dev's actual desktop").
 */
import { CrewhausError } from "@crewhaus/errors";

export class ComputerUseDriverError extends CrewhausError {
  override readonly name = "ComputerUseDriverError";
  constructor(message: string, cause?: unknown) {
    super("tool", message, cause);
  }
}

export type DriverBackend = "host" | "chromium" | "remote";
export type MouseButton = "left" | "right" | "middle";

export type Viewport = {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
};

export interface Driver {
  readonly backend: DriverBackend;
  /** Open / connect / launch chromium. Idempotent. */
  connect(): Promise<void>;
  /** Navigate the chromium tab. Throws on `host` backend. */
  goto(url: string): Promise<void>;
  /** Capture a PNG screenshot. */
  screenshot(): Promise<Uint8Array>;
  click(x: number, y: number, button?: MouseButton): Promise<void>;
  type(text: string): Promise<void>;
  key(combo: string): Promise<void>;
  scroll(dx: number, dy: number): Promise<void>;
  getViewport(): Promise<Viewport>;
  /** Best-effort DOM snapshot. Used by tests + the post-action assertions. */
  domText?(): Promise<string>;
  disconnect(): Promise<void>;
}

export type CreateDriverOptions = {
  readonly backend: DriverBackend;
  /** Playwright launch overrides (e.g. headless: false). chromium-only. */
  readonly playwrightOptions?: Record<string, unknown>;
  /** Initial viewport — chromium-only. Default 1280x720@1. */
  readonly viewport?: { width: number; height: number };
  /** Test injection: a pre-built Driver instance the factory returns verbatim. */
  readonly _injected?: Driver;
};

export function createDriver(opts: CreateDriverOptions): Driver {
  if (opts._injected !== undefined) return opts._injected;
  if (opts.backend === "chromium") return createChromiumDriver(opts);
  if (opts.backend === "host") return createHostDriverStub();
  if (opts.backend === "remote") return createRemoteDriverStub();
  throw new ComputerUseDriverError(`unknown backend: ${opts.backend}`);
}

// ---------------------------------------------------------------------------
// Playwright-backed chromium driver.
// ---------------------------------------------------------------------------

function createChromiumDriver(opts: CreateDriverOptions): Driver {
  let browser: unknown;
  let context: unknown;
  let page: unknown;
  let connected = false;

  async function loadPlaywright(): Promise<{
    chromium: { launch: (...args: unknown[]) => unknown };
  }> {
    try {
      // Lazy import so non-browser users don't need Playwright in their tree.
      const mod = await import("playwright");
      return mod as unknown as { chromium: { launch: (...args: unknown[]) => unknown } };
    } catch (err) {
      throw new ComputerUseDriverError(
        "Playwright not installed. Run `bun add -D playwright` and `bunx playwright install chromium` to use the chromium backend.",
        err,
      );
    }
  }

  return {
    backend: "chromium",
    async connect() {
      if (connected) return;
      const { chromium } = await loadPlaywright();
      // Playwright defaults: chromium runs in its own sandbox (its own
      // sandboxed renderer process). Headless by default.
      const launchOpts: Record<string, unknown> = {
        headless: true,
        ...(opts.playwrightOptions ?? {}),
      };
      browser = await (chromium.launch as (o: unknown) => Promise<unknown>)(launchOpts);
      const ctxOpts: Record<string, unknown> = {
        viewport: opts.viewport ?? { width: 1280, height: 720 },
      };
      context = await (browser as { newContext: (o: unknown) => Promise<unknown> }).newContext(
        ctxOpts,
      );
      page = await (context as { newPage: () => Promise<unknown> }).newPage();
      connected = true;
    },

    async goto(url) {
      if (!connected)
        throw new ComputerUseDriverError("driver not connected — call connect() first");
      await (page as { goto: (u: string, o?: unknown) => Promise<unknown> }).goto(url, {
        waitUntil: "domcontentloaded",
      });
    },

    async screenshot() {
      if (!connected) throw new ComputerUseDriverError("driver not connected");
      const buf = (await (page as { screenshot: (o?: unknown) => Promise<unknown> }).screenshot({
        type: "png",
      })) as Uint8Array;
      return buf;
    },

    async click(x, y, button = "left") {
      if (!connected) throw new ComputerUseDriverError("driver not connected");
      await (
        page as { mouse: { click: (x: number, y: number, o?: unknown) => Promise<void> } }
      ).mouse.click(x, y, { button });
    },

    async type(text) {
      if (!connected) throw new ComputerUseDriverError("driver not connected");
      await (page as { keyboard: { type: (t: string) => Promise<void> } }).keyboard.type(text);
    },

    async key(combo) {
      if (!connected) throw new ComputerUseDriverError("driver not connected");
      await (page as { keyboard: { press: (k: string) => Promise<void> } }).keyboard.press(combo);
    },

    async scroll(dx, dy) {
      if (!connected) throw new ComputerUseDriverError("driver not connected");
      await (page as { mouse: { wheel: (dx: number, dy: number) => Promise<void> } }).mouse.wheel(
        dx,
        dy,
      );
    },

    async getViewport() {
      if (!connected) throw new ComputerUseDriverError("driver not connected");
      const vp = (
        page as { viewportSize: () => { width: number; height: number } | null }
      ).viewportSize();
      const w = vp?.width ?? opts.viewport?.width ?? 1280;
      const h = vp?.height ?? opts.viewport?.height ?? 720;
      return { width: w, height: h, devicePixelRatio: 1 };
    },

    async domText() {
      if (!connected) throw new ComputerUseDriverError("driver not connected");
      return (page as { textContent: (sel: string) => Promise<string | null> })
        .textContent("body")
        .then((t) => t ?? "");
    },

    async disconnect() {
      if (!connected) return;
      try {
        await (browser as { close: () => Promise<void> }).close();
      } catch {
        // best-effort
      }
      connected = false;
      browser = undefined;
      context = undefined;
      page = undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Stubs for host + remote backends.
// ---------------------------------------------------------------------------

function createHostDriverStub(): Driver {
  return {
    backend: "host",
    async connect() {
      throw new ComputerUseDriverError(
        "host backend is not implemented in v0. The kickoff explicitly forbids it for smokes (would drive the dev's actual desktop). Native macOS / Linux / Windows backends land in a follow-up gated on `CREWHAUS_BROW_HOST_SMOKE=1`.",
      );
    },
    async goto() {
      throw new ComputerUseDriverError("host backend not implemented");
    },
    async screenshot() {
      throw new ComputerUseDriverError("host backend not implemented");
    },
    async click() {
      throw new ComputerUseDriverError("host backend not implemented");
    },
    async type() {
      throw new ComputerUseDriverError("host backend not implemented");
    },
    async key() {
      throw new ComputerUseDriverError("host backend not implemented");
    },
    async scroll() {
      throw new ComputerUseDriverError("host backend not implemented");
    },
    async getViewport() {
      throw new ComputerUseDriverError("host backend not implemented");
    },
    async disconnect() {},
  };
}

function createRemoteDriverStub(): Driver {
  return {
    backend: "remote",
    async connect() {
      throw new ComputerUseDriverError(
        "remote backend (CDP / Browserless) is not implemented in v0",
      );
    },
    async goto() {
      throw new ComputerUseDriverError("remote backend not implemented");
    },
    async screenshot() {
      throw new ComputerUseDriverError("remote backend not implemented");
    },
    async click() {
      throw new ComputerUseDriverError("remote backend not implemented");
    },
    async type() {
      throw new ComputerUseDriverError("remote backend not implemented");
    },
    async key() {
      throw new ComputerUseDriverError("remote backend not implemented");
    },
    async scroll() {
      throw new ComputerUseDriverError("remote backend not implemented");
    },
    async getViewport() {
      throw new ComputerUseDriverError("remote backend not implemented");
    },
    async disconnect() {},
  };
}
