/**
 * The compile service carries the compiler and every emitter, so it stays out
 * of everything a harness runs: only the tools that check drafts depend on it,
 * and no compiled bundle ever imports it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { compile } from "@crewhaus/compiler";
import { ABSENT_CORPUS } from "../../compiler/src/absent-corpus";
import { collectCrewhausDeps } from "./bundle-stamp";

const ROOT = join(import.meta.dir, "..", "..", "..");
const SELF = "@crewhaus/compile-service";

describe("who depends on the compile service", () => {
  test("exactly the CLI and Home's server; a later consumer adds itself here", () => {
    const dependents: string[] = [];
    let read = 0;
    for (const group of ["packages", "apps"]) {
      for (const dir of readdirSync(join(ROOT, group))) {
        const file = join(ROOT, group, dir, "package.json");
        if (!existsSync(file)) continue;
        const manifest = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        read += 1;
        const fields = [
          "dependencies",
          "devDependencies",
          "peerDependencies",
          "optionalDependencies",
        ];
        if (
          fields.some((f) => Object.hasOwn((manifest[f] ?? {}) as Record<string, string>, SELF))
        ) {
          dependents.push(String(manifest["name"]));
        }
      }
    }
    expect(read).toBeGreaterThan(100);
    expect(dependents.sort()).toEqual(["@crewhaus/hangar-server", "crewhaus"]);
  });

  test("no compiled bundle of any shape lists it", () => {
    let shapes = 0;
    for (const [shape, text] of Object.entries(ABSENT_CORPUS)) {
      const deps = collectCrewhausDeps(compile(text).files);
      expect(deps.length, shape).toBeGreaterThan(0);
      expect(deps.includes(SELF), shape).toBe(false);
      shapes += 1;
    }
    expect(shapes).toBe(14);
  });
});
