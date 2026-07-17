import { describe, expect, test } from "bun:test";
import { SPEC_HOOK_EVENTS } from "@crewhaus/spec";
import { HOOK_EVENTS } from "./index";

/**
 * Loop contract 0.4 (Batch A) — the spec's `hooks:` block validates `event`
 * against `SPEC_HOOK_EVENTS`, a DUPLICATE of this package's `HOOK_EVENTS`
 * (the spec stays dependency-light, so it cannot import the engine). This
 * cross-check is the drift guard: adding/removing an event in either list
 * without the other fails here. The test lives on the hooks-engine side —
 * the package that OWNS the canonical list — mirroring the direction of
 * every other "duplicated — keep in sync" guard in the workspace.
 */
describe("SPEC_HOOK_EVENTS ↔ HOOK_EVENTS cross-check", () => {
  test("the spec's duplicated event list is exactly HOOK_EVENTS (same names, same order)", () => {
    expect([...SPEC_HOOK_EVENTS]).toEqual([...HOOK_EVENTS]);
  });
});
