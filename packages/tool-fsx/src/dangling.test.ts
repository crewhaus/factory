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
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolPermissionError, resolveSafe } from "./paths";

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
