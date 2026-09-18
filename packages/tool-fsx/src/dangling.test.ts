/**
 * The dangling-symlink containment escape (CWE-59), pinned.
 *
 * `existsSync` FOLLOWS symlinks, so a link whose target does not exist yet
 * answers false — and the containment walk then treats the link's own name as
 * part of the "does not exist yet" tail, re-appends it to the resolved root,
 * and passes. A write through that name then creates the file wherever the
 * link points. Probing with `lstat` keeps the name in the resolved portion,
 * which is what closes it.
 *
 * Every path-taking package in this repo carries a copy of the same resolver,
 * so this is the test that stops the copies drifting back.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "@crewhaus/tool-executor";
import { removePath } from "./index";
import { ToolPermissionError, resolveSafe, workspaceRoot } from "./paths";

let dir: string;
let prev: string;
let outsideDir: string;

beforeEach(() => {
  prev = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "crewhaus-dangling-"));
  process.chdir(dir);
  outsideDir = mkdtempSync(join(tmpdir(), "crewhaus-outside-"));
});
afterEach(() => {
  process.chdir(prev);
  rmSync(dir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

test("a symlink to a MISSING target outside the workspace is refused", () => {
  const target = join(outsideDir, "not-yet-there.txt");
  expect(existsSync(target)).toBe(false);
  symlinkSync(target, join(dir, "innocent.txt"));
  expect(() => resolveSafe("Probe", "innocent.txt")).toThrow(ToolPermissionError);
});

test("a symlink to an EXISTING target outside the workspace is refused too", () => {
  const target = join(outsideDir, "already-there.txt");
  Bun.write(target, "x");
  symlinkSync(target, join(dir, "innocent2.txt"));
  expect(() => resolveSafe("Probe", "innocent2.txt")).toThrow(ToolPermissionError);
});

test("a dangling symlink pointing INSIDE the workspace is still allowed", () => {
  // The rule is about escaping, not about dangling — a link to a file this
  // harness is about to create must keep working.
  symlinkSync(join(dir, "pending.txt"), join(dir, "link-in.txt"));
  expect(() => resolveSafe("Probe", "link-in.txt")).not.toThrow();
});

test("an ordinary path that does not exist yet is still allowed", () => {
  expect(() => resolveSafe("Probe", "brand-new.txt")).not.toThrow();
});

test("a nested path whose parent directories do not exist yet is allowed", () => {
  expect(() => resolveSafe("Probe", "a/b/c/new.txt")).not.toThrow();
});

/**
 * Regression — a RELATIVE symlink target belongs to the directory that
 * actually CONTAINS the link, not to the link's lexical parent.
 *
 * The two readings only diverge when that parent is itself reached through a
 * symlink, which is why following a `readlink` hop by hand is what makes the
 * difference reachable at all: the link's own name stays in the RESOLVED part
 * of the path, so whichever directory it is measured from decides where the
 * walk thinks the path lands.
 *
 * In the fixture below `pdir` leaves the workspace, so `l` really sits in
 * <outside>/realdir and its "../escape" truly names <outside>/escape. Read
 * from the lexical parent <ws>/pdir the very same target reads as
 * <ws>/escape — an in-root path, which sails through containment. That is the
 * shape of the fault: the wrong base does not produce an out-of-root verdict
 * for an in-root path, it produces a plausible in-root verdict for a path
 * that does not lead there.
 *
 * `RemovePath` is the tool driven here because in this package the
 * consequence is visible rather than theoretical: it unlinks `target.abs`,
 * the LEXICAL path, so a resolution that wrongly passes carries the call on
 * to delete <outside>/realdir/l. Measured with the base mutated back, that
 * is exactly what happened — the tool reported success and the link was gone.
 */
test("a relative dangling link under an outward directory link is refused", async () => {
  mkdirSync(join(outsideDir, "realdir"));
  symlinkSync(join(outsideDir, "realdir"), join(dir, "pdir"));
  symlinkSync("../escape", join(outsideDir, "realdir", "l"));

  // A plain workspace-relative path: no `..`, nothing absolute, so the cheap
  // lexical pre-check has nothing to catch and the symlink walk is the only
  // thing that can refuse this.
  expect(() => resolveSafe("Probe", "pdir/l")).toThrow(ToolPermissionError);

  const result = await executeTool(removePath, { path: "pdir/l" }, { toolUseId: "rel-base" });
  expect(result.isError).toBe(true);
  expect(String(result.content)).toMatch(/escapes the workspace root/);

  // The link lives outside the workspace, so it is what a wrongly-passed
  // resolution would have taken. `existsSync` follows, and it dangles, so the
  // question has to be put to `lstat`.
  expect(() => lstatSync(join(outsideDir, "realdir", "l"))).not.toThrow();
  // And nothing at either reading of "../escape": neither the true
  // destination nor the in-root path the lexical base would have named.
  expect(existsSync(join(outsideDir, "escape"))).toBe(false);
  expect(existsSync(join(dir, "escape"))).toBe(false);

  // The mirror, because refusing every relative dangling target would also
  // "pass" everything above: one whose parent is an ordinary directory has to
  // keep resolving, and to the file it actually names.
  mkdirSync(join(dir, "sub"));
  symlinkSync("../pending.txt", join(dir, "sub", "rel-in.txt"));
  expect(resolveSafe("Probe", "sub/rel-in.txt").real).toBe(join(workspaceRoot(), "pending.txt"));
});
