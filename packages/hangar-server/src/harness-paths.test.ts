/**
 * The one rule a harness-relative path is resolved by: inside the harness after
 * symlinks, and never in Home's own records, wherever the harness sits.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessPathOf, isWithin } from "./harness-paths";

const root = mkdtempSync(join(tmpdir(), "harness-paths-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const home = join(root, "home");
const harness = join(root, "harness");
const outside = join(root, "outside");
for (const dir of [home, harness, outside]) mkdirSync(dir, { recursive: true });
writeFileSync(join(harness, "crewhaus.yaml"), "name: x\n");
writeFileSync(join(outside, "secret.txt"), "no\n");
symlinkSync(join(outside, "secret.txt"), join(harness, "link.txt"));

describe("harnessPathOf", () => {
  test("a file inside the harness resolves, and one not there yet does too", () => {
    expect(harnessPathOf(harness, home, ["crewhaus.yaml"])).toEqual({
      ok: true,
      path: join(harness, "crewhaus.yaml"),
    });
    expect(harnessPathOf(harness, home, [".crewhaus", "new.json"]).ok).toBe(true);
  });

  test("a path that leaves the harness, by segments or by a symlink, escapes", () => {
    expect(harnessPathOf(harness, home, ["..", "outside", "secret.txt"])).toEqual({
      ok: false,
      reason: "escapes",
    });
    expect(harnessPathOf(harness, home, ["link.txt"])).toEqual({ ok: false, reason: "escapes" });
  });

  test("a harness that holds Home's own records never serves them", () => {
    const nested = join(harness, "records");
    mkdirSync(nested, { recursive: true });
    expect(harnessPathOf(harness, nested, ["records", "access.json"])).toEqual({
      ok: false,
      reason: "home-records",
    });
    expect(harnessPathOf(harness, nested, ["crewhaus.yaml"]).ok).toBe(true);
  });
});

describe("isWithin", () => {
  test("by relative(), never by a string prefix", () => {
    expect(isWithin(join(root, "a"), join(root, "a", "b"))).toBe(true);
    expect(isWithin(join(root, "a"), join(root, "a"))).toBe(true);
    // A sibling that starts with the same letters is not inside.
    expect(isWithin(join(root, "a"), join(root, "ab"))).toBe(false);
  });
});
