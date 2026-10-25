/**
 * The runtime-state roots a run hands its tools (`protectedRootsOf`), and
 * where a path stands against them: inside one (`protectedRootHolding`), or
 * above one (`protectedRootBeneath`, `protectedRootsBeneath`) — through a
 * link too, in either direction.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  protectedRootBeneath,
  protectedRootHolding,
  protectedRootsBeneath,
  protectedRootsOf,
} from "./protected";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "tool-safety-protected-"));
  mkdirSync(join(ws, ".crewhaus", "sessions"), { recursive: true });
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe("protected roots", () => {
  test("read off the bridge; anything else is none", () => {
    expect(protectedRootsOf({ bridge: { protectedRoots: ["a", "", 3, "b"] } })).toEqual(["a", "b"]);
    for (const ctx of [undefined, {}, { bridge: null }, { bridge: { protectedRoots: "a" } }]) {
      expect(protectedRootsOf(ctx)).toEqual([]);
    }
  });

  test("inside, above, and neither — relative roots read against cwd", () => {
    const roots = [".crewhaus/sessions"];
    expect(protectedRootHolding(join(ws, ".crewhaus/sessions/x.jsonl"), roots, ws)).toBe(
      ".crewhaus/sessions",
    );
    expect(protectedRootHolding(join(ws, ".crewhaus"), roots, ws)).toBeUndefined();
    expect(protectedRootBeneath(join(ws, ".crewhaus"), roots, ws)).toBe(".crewhaus/sessions");
    expect(protectedRootBeneath(ws, roots, ws)).toBe(".crewhaus/sessions");
    expect(protectedRootBeneath(join(ws, "src"), roots, ws)).toBeUndefined();
    expect(protectedRootsBeneath(ws, roots, ws)).toEqual([
      { root: ".crewhaus/sessions", rel: join(".crewhaus", "sessions") },
    ]);
  });

  test("a link on the way neither hides a root nor invents one", () => {
    const real = realpathSync(ws);
    symlinkSync(join(ws, ".crewhaus"), join(ws, "state-link"));
    const roots = [join(real, ".crewhaus", "sessions")];
    // Through the link, the sessions directory is inside.
    expect(protectedRootHolding(join(ws, "state-link", "sessions", "x"), roots, ws)).toBe(roots[0]);
    // The link itself stands above it.
    expect(protectedRootBeneath(join(ws, "state-link"), roots, ws)).toBe(roots[0]);
    expect(protectedRootsBeneath(join(ws, "state-link"), roots, ws)).toEqual([
      { root: roots[0] as string, rel: "sessions" },
    ]);
  });
});
