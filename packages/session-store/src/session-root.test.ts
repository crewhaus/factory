/**
 * Where a harness's session root is, given the variables its environment files
 * set: the default, an override inside the harness, and every way an override can
 * escape it, which is ignored.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { SESSION_DIR_ENV, resolveHarnessSessionRoot } from "./index";
import { removeTempRoots, tempRoot } from "./test-helpers";

afterAll(removeTempRoots);

/** A harness `<base>/a` with a sibling `<base>/ab` whose name it is a prefix of. */
function harness(): { readonly base: string; readonly dir: string; readonly sibling: string } {
  const base = realpathSync(tempRoot("crewhaus-session-root-"));
  const dir = join(base, "a");
  const sibling = join(base, "ab");
  mkdirSync(dir);
  mkdirSync(sibling);
  return { base, dir, sibling };
}

describe("resolveHarnessSessionRoot", () => {
  test("no override, or a blank one, is the default", () => {
    const { dir } = harness();
    const fallback = { root: join(dir, ".crewhaus", "sessions"), overrideActive: false };
    expect(resolveHarnessSessionRoot(dir, {})).toEqual({ ...fallback, overrideIgnored: false });
    expect(resolveHarnessSessionRoot(dir, { [SESSION_DIR_ENV]: "   " })).toEqual({
      ...fallback,
      overrideIgnored: false,
    });
  });

  test("an override inside the harness is honoured, trimmed, relative to the harness", () => {
    const { dir } = harness();
    mkdirSync(join(dir, "state"));
    expect(resolveHarnessSessionRoot(dir, { [SESSION_DIR_ENV]: " state " })).toEqual({
      root: join(dir, "state"),
      overrideActive: true,
      overrideIgnored: false,
    });
    expect(resolveHarnessSessionRoot(dir, { [SESSION_DIR_ENV]: join(dir, "state") }).root).toBe(
      join(dir, "state"),
    );
  });

  test("an override whose directory does not exist yet, inside the harness, is honoured", () => {
    const { dir } = harness();
    expect(resolveHarnessSessionRoot(dir, { [SESSION_DIR_ENV]: "later/sessions" })).toEqual({
      root: join(dir, "later", "sessions"),
      overrideActive: true,
      overrideIgnored: false,
    });
  });

  test("an override that escapes is ignored: .., absolute, and a sibling that shares a prefix", () => {
    const { base, dir, sibling } = harness();
    const ignored = {
      root: join(dir, ".crewhaus", "sessions"),
      overrideActive: false,
      overrideIgnored: true,
    };
    for (const override of ["..", "../ab", join(base, "elsewhere"), sibling, join(sibling, "x")]) {
      expect({
        override,
        got: resolveHarnessSessionRoot(dir, { [SESSION_DIR_ENV]: override }),
      }).toEqual({ override, got: ignored });
    }
  });

  test("a link inside the harness that points out of it is ignored", () => {
    const { dir, sibling } = harness();
    symlinkSync(sibling, join(dir, "out"));
    expect(resolveHarnessSessionRoot(dir, { [SESSION_DIR_ENV]: "out" }).overrideIgnored).toBe(true);
    expect(
      resolveHarnessSessionRoot(dir, { [SESSION_DIR_ENV]: "out/sessions" }).overrideIgnored,
    ).toBe(true);
  });

  test("a harness directory that cannot be read ignores any override", () => {
    const { base } = harness();
    const gone = join(base, "gone");
    expect(resolveHarnessSessionRoot(gone, { [SESSION_DIR_ENV]: "state" })).toEqual({
      root: join(gone, ".crewhaus", "sessions"),
      overrideActive: false,
      overrideIgnored: true,
    });
  });
});
