import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { THREDZ_MCP_PACKAGE_SPEC } from "./index";

/**
 * The compiler and `target-managed` each spawn the thredz stdio server, and
 * each spells the pin out separately — the managed emitter builds its server
 * entry as a JSON string, so it cannot import the constant without dragging the
 * compiler into its dependency graph. Both sites carry a "keep in sync" comment,
 * which is exactly the kind of promise that rots.
 *
 * A drifted pin does not fail loudly: managed bundles would keep working, but
 * against a server that silently ignores `THREDZ_DEFAULT_SPACE`, so every write
 * lands in the unspaced legacy wiki instead of the space the spec asked for.
 * That is a data-placement bug found only by inspecting articles after the fact.
 */
describe("thredz-mcp pin parity", () => {
  const managedSource = readFileSync(
    join(import.meta.dir, "..", "..", "target-managed", "src", "index.ts"),
    "utf8",
  );

  test("target-managed pins the exact spec the compiler exports", () => {
    const pins = [...managedSource.matchAll(/"-y",\s*"(thredz-mcp@[^"]+)"/g)].map((m) => m[1]);

    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins) expect(pin).toBe(THREDZ_MCP_PACKAGE_SPEC);
  });

  test("the pin is a hard version, never a floating range", () => {
    // A range would make a bundle's tool surface depend on when it happened to
    // be run, which breaks the reproducibility the pin exists to provide.
    expect(THREDZ_MCP_PACKAGE_SPEC).toMatch(/^thredz-mcp@\d+\.\d+\.\d+$/);
  });

  test("the pinned server is new enough to understand wiki spaces", () => {
    // THREDZ_DEFAULT_SPACE landed in thredz-mcp 0.3.0. Emitting it at a lower
    // pin would be a silent no-op.
    const version = THREDZ_MCP_PACKAGE_SPEC.split("@")[1] ?? "";
    const [major = 0, minor = 0] = version.split(".").map(Number);
    expect(major > 0 || minor >= 3).toBe(true);
  });
});
