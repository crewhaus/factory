/**
 * Catalog R18 — covers the chromium driver's `loadPlaywright` failure path
 * (the catch arm that rethrows a `ComputerUseDriverError` with an install
 * hint when `import("playwright")` rejects).
 *
 * The failing import is injected via the `_importPlaywright` seam instead of
 * `mock.module("playwright", throwingFactory)`: bun's `mock.module` is
 * process-global, and once "playwright" has been successfully imported
 * anywhere in the test process (chromium.test.ts imports it as a fake), a
 * *throwing* factory is evaluated eagerly and blows up at registration time.
 * Because `bun test` runs every file in one process in nondeterministic
 * order, the module-mock approach worked or exploded depending on which file
 * ran first; the seam is order-independent.
 */
import { expect, test } from "bun:test";
import { ComputerUseDriverError, createDriver } from "./index.js";

// Rejects the way a missing optional peer dep does, exercising the same
// catch arm in `loadPlaywright` as a genuine import failure.
const failingImport = () => Promise.reject(new Error("Cannot find module 'playwright'"));

test("connect surfaces a clean diagnostic when playwright import fails", async () => {
  const d = createDriver({ backend: "chromium", _importPlaywright: failingImport });
  await expect(d.connect()).rejects.toThrow(/Playwright not installed/);
});

test("the import error is preserved as the error cause", async () => {
  const d = createDriver({ backend: "chromium", _importPlaywright: failingImport });
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
