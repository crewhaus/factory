/**
 * Test fixture — a virtual `playwright` module, registered as a Bun preload.
 *
 * `runRunBrowser` reaches its `runChatLoop({...})` options literal only AFTER
 * `await driver.connect()`, so nothing about the loop wiring is observable
 * until a browser has launched. That made the browser target's `askMode` /
 * `approvals` threading untestable without a real chromium — which the main
 * `ci` job does not install, and which `bun test` would therefore skip 100% of
 * the time if it were merely gated.
 *
 * Registering a virtual module makes the driver's lazy `import("playwright")`
 * resolve to this stub instead, so the run gets far enough to exercise the
 * permission path with no browser binary anywhere. It is the same posture as
 * `computer-use-driver`'s own tests (a faked playwright, not a skipped test) —
 * only via a preload, because the CLI under test runs in a SUBPROCESS where
 * `mock.module` cannot reach.
 *
 * Used by run-approvals-e2e.test.ts via `bun --preload <this file> <cli>`.
 */
const page = {
  goto: async () => undefined,
  screenshot: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  content: async () => "<html><body>stub</body></html>",
  evaluate: async () => "",
  setViewportSize: async () => undefined,
  mouse: {
    click: async () => undefined,
    wheel: async () => undefined,
    move: async () => undefined,
  },
  keyboard: { type: async () => undefined, press: async () => undefined },
  viewportSize: () => ({ width: 1280, height: 720 }),
  close: async () => undefined,
};

const context = {
  newPage: async () => page,
  close: async () => undefined,
};

const browser = {
  newContext: async () => context,
  close: async () => undefined,
};

Bun.plugin({
  name: "fake-playwright",
  setup(build) {
    build.module("playwright", () => ({
      exports: { chromium: { launch: async () => browser } },
      loader: "object",
    }));
  },
});
