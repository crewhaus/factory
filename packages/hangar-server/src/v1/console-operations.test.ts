/**
 * Every versioned-API operation the console names, by `call("<id>")`, `createAction("<id>")`
 * or a menu action's operation, is one Home serves: a screen never asks for an operation
 * that does not exist, and the scan counts what it found.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { OPERATIONS } from "@crewhaus/control-contract";
import { HOME_AREAS, handlersOf } from "./areas";

const ASSETS = join(import.meta.dir, "..", "..", "..", "hangar-ui", "assets", "js");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : name.endsWith(".js") ? [path] : [];
  });
}

describe("the console's operations", () => {
  test("each one the console names is declared and has a handler", () => {
    const declared = new Set(OPERATIONS.map((op) => op.id));
    const handled = new Set(handlersOf(HOME_AREAS).keys());
    const named = new Map<string, string>();
    for (const path of files(ASSETS)) {
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/\b(?:call|createAction)\(\s*"([a-zA-Z.]+)"/g)) {
        named.set(match[1] as string, relative(ASSETS, path));
      }
    }
    for (const id of ["home.status", "home.spend", "home.harnessAccess", "decisions.resolve"]) {
      expect(`${id}: ${named.has(id)}`).toBe(`${id}: true`);
    }
    for (const [id, where] of named) {
      expect(`${id} (${where}): ${declared.has(id)} ${handled.has(id)}`).toBe(
        `${id} (${where}): true true`,
      );
    }
    expect(named.size).toBeGreaterThanOrEqual(20);
  });
});
