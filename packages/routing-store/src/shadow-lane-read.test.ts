/**
 * 0.6.0 §7.8 — reading the shadow lane's two sides apart from the raw lines.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHADOW_LANE_PRIMARY_ARM, SHADOW_LANE_SHADOW_ARM, shadowRouteKey } from "./lanes";
import { readShadowLaneSides } from "./shadow-lane-read";

function seed(lines: ReadonlyArray<Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), "crewhaus-shadow-read-"));
  mkdirSync(join(root, "routing"), { recursive: true });
  writeFileSync(
    join(root, "routing", "arms.jsonl"),
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    { mode: 0o600 },
  );
  return root;
}

const lane = (model: string, at?: string): Record<string, unknown> => ({
  v: 2,
  k: shadowRouteKey("hard"),
  m: model,
  r: 0.8,
  l: 100,
  ...(at !== undefined ? { at } : {}),
});

describe("readShadowLaneSides", () => {
  test("splits the audition's two sides by the `at` stamp", () => {
    const sides = readShadowLaneSides(
      seed([
        lane("challenger", SHADOW_LANE_SHADOW_ARM),
        lane("incumbent", SHADOW_LANE_PRIMARY_ARM),
        { v: 1, k: "hard", m: "incumbent", r: 0.7, l: 90 },
      ]),
    );
    expect([...sides.shadow]).toEqual(["challenger"]);
    expect([...sides.primary]).toEqual(["incumbent"]);
    expect([...sides.unattributed]).toEqual([]);
  });

  test("an unstamped lane line is UNATTRIBUTED, not a candidate", () => {
    const sides = readShadowLaneSides(seed([lane("mystery")]));
    expect([...sides.shadow]).toEqual([]);
    expect([...sides.unattributed]).toEqual(["mystery"]);
  });

  test("a torn line is skipped and a missing store reads empty", () => {
    const root = mkdtempSync(join(tmpdir(), "crewhaus-shadow-read-"));
    expect([...readShadowLaneSides(root).shadow]).toEqual([]);
    mkdirSync(join(root, "routing"), { recursive: true });
    writeFileSync(
      join(root, "routing", "arms.jsonl"),
      `${JSON.stringify(lane("challenger", SHADOW_LANE_SHADOW_ARM))}\n{"k":"shadow:ha\n`,
    );
    expect([...readShadowLaneSides(root).shadow]).toEqual(["challenger"]);
  });

  test("live and `q:` lines are not lane lines", () => {
    const sides = readShadowLaneSides(
      seed([
        { v: 2, k: "hard", m: "live", r: 0.5, l: 10, at: SHADOW_LANE_SHADOW_ARM },
        { v: 2, k: "q:hard", m: "offline", r: 0.5, l: 10 },
      ]),
    );
    expect([...sides.shadow]).toEqual([]);
    expect([...sides.unattributed]).toEqual([]);
  });
});
