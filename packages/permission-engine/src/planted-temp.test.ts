/**
 * 0.7.1 — `approvals grant --always` (and the channel bot's "Always allow")
 * writes `.crewhaus/settings.json` through a random O_EXCL|O_NOFOLLOW temp.
 * 0.7.0 wrote the fixed `.crewhaus/settings.json.tmp` through any link a
 * model had planted there, overwriting the link's target with the settings.
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
import { appendSettingsRule, loadSettingsRules } from "./index";

const ROOTS: string[] = [];
afterAll(() => {
  for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
});

function layout(): { ws: string; victim: string } {
  const base = mkdtempSync(join(tmpdir(), "settings-links-"));
  ROOTS.push(base);
  const ws = join(base, "ws");
  mkdirSync(join(ws, ".crewhaus"), { recursive: true });
  mkdirSync(join(base, "outside"));
  const victim = join(base, "outside", "victim");
  writeFileSync(victim, "ORIGINAL\n");
  return { ws, victim };
}

describe("appendSettingsRule never writes through a planted link (0.7.1)", () => {
  test("a link at settings.json.tmp is not written through", () => {
    const { ws, victim } = layout();
    symlinkSync(victim, join(ws, ".crewhaus", "settings.json.tmp"));
    const res = appendSettingsRule(ws, { type: "alwaysAllow", pattern: "Skill" });
    expect(res.added).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("ORIGINAL\n");
    const settings = join(ws, ".crewhaus", "settings.json");
    expect(lstatSync(settings).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(settings, "utf8")).permissions.rules).toEqual([
      { type: "alwaysAllow", pattern: "Skill" },
    ]);
  });

  test("a settings.json that links out of the workspace is refused; one that links inside it is written where it leads", () => {
    const { ws, victim } = layout();
    // The outside file must at least parse, or the read refuses first.
    writeFileSync(victim, "{}\n");
    symlinkSync(victim, join(ws, ".crewhaus", "settings.json"));
    expect(() => appendSettingsRule(ws, { type: "alwaysAllow", pattern: "Skill" })).toThrow(
      /cannot write settings file .*settings\.json: /,
    );
    expect(readFileSync(victim, "utf8")).toBe("{}\n");

    const inside = layout();
    const shared = join(inside.ws, "shared-settings.json");
    writeFileSync(shared, "{}\n");
    symlinkSync(shared, join(inside.ws, ".crewhaus", "settings.json"));
    appendSettingsRule(inside.ws, { type: "alwaysAllow", pattern: "Skill" });
    expect(lstatSync(join(inside.ws, ".crewhaus", "settings.json")).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(shared, "utf8")).permissions.rules.length).toBe(1);
  });

  test("a .crewhaus that is itself a link (state kept elsewhere) still takes the rule, as 0.7.0 did", () => {
    const base = mkdtempSync(join(tmpdir(), "settings-statedir-"));
    ROOTS.push(base);
    const harness = join(base, "harness");
    const state = join(base, "state", "crewhaus");
    mkdirSync(harness, { recursive: true });
    mkdirSync(state, { recursive: true });
    writeFileSync(
      join(state, "settings.json"),
      `${JSON.stringify({ permissions: { rules: [{ type: "alwaysAllow", pattern: "Read" }] } })}\n`,
    );
    symlinkSync(state, join(harness, ".crewhaus"), "dir");
    expect(appendSettingsRule(harness, { type: "alwaysAllow", pattern: "Write" }).added).toBe(true);
    // Read back through the same link, as a boot reads it.
    expect(loadSettingsRules(harness).map((r) => r.pattern)).toEqual(["Read", "Write"]);
    expect(lstatSync(join(harness, ".crewhaus")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(state, "settings.json")).isFile()).toBe(true);
  });

  test("under a linked .crewhaus, a settings.json linking out of it is still refused", () => {
    const base = mkdtempSync(join(tmpdir(), "settings-statedir-"));
    ROOTS.push(base);
    const harness = join(base, "harness");
    const state = join(base, "state");
    mkdirSync(harness, { recursive: true });
    mkdirSync(state, { recursive: true });
    const victim = join(base, "victim.json");
    writeFileSync(victim, "{}\n");
    symlinkSync(victim, join(state, "settings.json"));
    symlinkSync(state, join(harness, ".crewhaus"), "dir");
    expect(() => appendSettingsRule(harness, { type: "alwaysAllow", pattern: "Write" })).toThrow(
      /cannot write settings file .*settings\.json: /,
    );
    expect(readFileSync(victim, "utf8")).toBe("{}\n");
  });
});
