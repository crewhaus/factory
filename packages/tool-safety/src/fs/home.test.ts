import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { homeHeldBy } from "./home";

const roots: string[] = [];

function layout(): { base: string; home: string } {
  const base = mkdtempSync(join(tmpdir(), "tool-safety-home-"));
  roots.push(base);
  const home = join(base, "people", "me");
  mkdirSync(home, { recursive: true });
  return { base, home };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("homeHeldBy", () => {
  test("the home directory holds itself, by HOME", () => {
    const { home } = layout();
    expect(homeHeldBy(home, { HOME: home })).toBe(home);
  });

  test("the home directory holds itself, by USERPROFILE", () => {
    const { home } = layout();
    expect(homeHeldBy(home, { USERPROFILE: home })).toBe(home);
  });

  test("an ancestor of the home directory holds it", () => {
    const { base, home } = layout();
    expect(homeHeldBy(dirname(home), { HOME: home })).toBe(home);
    expect(homeHeldBy(base, { USERPROFILE: home })).toBe(home);
  });

  test("a directory under the home directory holds nothing", () => {
    const { home } = layout();
    const below = join(home, "harnesses", "bot");
    mkdirSync(below, { recursive: true });
    expect(homeHeldBy(below, { HOME: home })).toBeUndefined();
  });

  test("a sibling sharing the home directory's prefix holds nothing", () => {
    const { home } = layout();
    const sibling = `${home}2`;
    mkdirSync(sibling);
    expect(homeHeldBy(sibling, { HOME: home })).toBeUndefined();
  });

  test("a home directory whose name opens with two dots is still inside its parent", () => {
    const { base } = layout();
    const home = join(base, "..me");
    mkdirSync(home);
    expect(homeHeldBy(base, { HOME: home })).toBe(home);
  });

  test("a link to the home directory counts as the home directory", () => {
    const { base, home } = layout();
    const link = join(base, "link");
    symlinkSync(home, link);
    expect(homeHeldBy(link, { HOME: home })).toBe(home);
    expect(homeHeldBy(dirname(home), { HOME: link })).toBe(link);
  });

  test("a directory linked to one under the home directory holds nothing", () => {
    const { base, home } = layout();
    const below = join(home, "bot");
    mkdirSync(below);
    const link = join(base, "link");
    symlinkSync(below, link);
    expect(homeHeldBy(link, { HOME: home })).toBeUndefined();
  });

  test("a home directory that is not there is compared by its spelling", () => {
    // Real, so the absent home's spelling and the directory's share a prefix.
    const base = realpathSync(layout().base);
    const absent = join(base, "absent");
    expect(homeHeldBy(base, { HOME: absent })).toBe(absent);
    expect(homeHeldBy(join(base, "people"), { HOME: absent })).toBeUndefined();
  });

  test("an empty value and a relative value name nothing", () => {
    const { home } = layout();
    expect(homeHeldBy(home, { HOME: "" })).toBeUndefined();
    expect(homeHeldBy(process.cwd(), { HOME: "." })).toBeUndefined();
    expect(homeHeldBy(home, { USERPROFILE: "." })).toBeUndefined();
  });

  test("the account's home stays a candidate when the env names another", () => {
    const { base } = layout();
    expect(homeHeldBy(homedir(), { HOME: base })).toBe(homedir());
  });

  test("an env with neither variable still leaves a temp directory holding nothing", () => {
    const { home } = layout();
    expect(homeHeldBy(home, {})).toBeUndefined();
  });
});
