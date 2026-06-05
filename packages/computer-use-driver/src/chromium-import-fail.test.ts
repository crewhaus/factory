/**
 * Catalog R18 — covers the chromium driver's `loadPlaywright` failure path
 * (the catch arm that rethrows a `ComputerUseDriverError` with an install
 * hint when `import("playwright")` rejects).
 *
 * This lives in its own file because bun's `mock.module` is process-global:
 * once "playwright" has been successfully imported anywhere in the process
 * (even as a fake), re-registering a *throwing* factory is evaluated eagerly
 * and blows up at registration time. By registering the throwing factory at
 * module scope here — before any test imports playwright — the factory stays
 * lazy and `import("playwright")` rejects as intended.
 */
import { beforeEach, expect, mock, test } from "bun:test";
import { ComputerUseDriverError, createDriver } from "./index.js";

// Re-register before every test: a throwing factory is evicted by bun once it
// has thrown during an import, so each test must reinstall it.
beforeEach(() => {
  mock.module("playwright", () => {
    throw new Error("Cannot find module 'playwright'");
  });
});

test("connect surfaces a clean diagnostic when playwright import fails", async () => {
  const d = createDriver({ backend: "chromium" });
  await expect(d.connect()).rejects.toThrow(/Playwright not installed/);
});

test("the import error is preserved as the error cause", async () => {
  const d = createDriver({ backend: "chromium" });
  try {
    await d.connect();
    throw new Error("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(ComputerUseDriverError);
    // `cause` is the standard Error.cause carrying the original import error.
    const cause = (err as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toContain("Cannot find module");
  }
});
