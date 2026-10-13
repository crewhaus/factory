/**
 * 0.7.1 — the scoreboard's rewrites (`compact()`, `promoteLanes()`) and the
 * route-freeze marker are written through a random O_EXCL|O_NOFOLLOW temp, and
 * the observation appends refuse a link at `arms.jsonl`. 0.7.0 wrote the fixed
 * `<file>.tmp` through any link planted there and appended through a link at
 * the file, so a model that could plant one under `.crewhaus/routing/` chose
 * where the runtime's scoreboard went.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openScoreboard, writeRouteFreeze } from "./index";

const ROOTS: string[] = [];
afterAll(() => {
  for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
});

function layout(): { store: string; victim: string } {
  const base = mkdtempSync(join(tmpdir(), "routing-links-"));
  ROOTS.push(base);
  const store = join(base, "ws", ".crewhaus");
  mkdirSync(join(store, "routing"), { recursive: true });
  mkdirSync(join(base, "outside"));
  const victim = join(base, "outside", "victim");
  writeFileSync(victim, "ORIGINAL\n");
  return { store, victim };
}

const OBS = { success: true, latencyMs: 10 } as const;

describe("routing-store writes never go through a planted link (0.7.1)", () => {
  test("compact() ignores a link at arms.jsonl.tmp and leaves arms.jsonl a file", () => {
    const { store, victim } = layout();
    const sb = openScoreboard(store);
    sb.record("k", "m", 1, OBS);
    symlinkSync(victim, join(store, "routing", "arms.jsonl.tmp"));
    sb.compact();
    expect(readFileSync(victim, "utf8")).toBe("ORIGINAL\n");
    expect(lstatSync(join(store, "routing", "arms.jsonl")).isSymbolicLink()).toBe(false);
    expect(openScoreboard(store).score("k", "m")?.n).toBe(1);
  });

  test("an observation is not appended through a link at arms.jsonl", () => {
    const { store, victim } = layout();
    symlinkSync(victim, join(store, "routing", "arms.jsonl"));
    const sb = openScoreboard(store);
    expect(() => sb.record("k", "m", 1, OBS)).toThrow(
      /refusing to append to routing[/\\]arms\.jsonl .*\(code is-symlink\)/,
    );
    expect(readFileSync(victim, "utf8")).toBe("ORIGINAL\n");
  });

  test("the freeze marker ignores a link at freeze.json.tmp", () => {
    const { store, victim } = layout();
    symlinkSync(victim, join(store, "routing", "freeze.json.tmp"));
    writeRouteFreeze(store, { policyVersion: "v1" });
    expect(readFileSync(victim, "utf8")).toBe("ORIGINAL\n");
    expect(
      JSON.parse(readFileSync(join(store, "routing", "freeze.json"), "utf8")).policyVersion,
    ).toBe("v1");
  });
});
