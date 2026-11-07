/**
 * When the accessibility sweep may skip. Skipping is the risky direction, so
 * everything that cannot be read as "nothing relevant changed" runs it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { axeSweepInScope } from "./ui-e2e-scope";

const SCRIPT = join(import.meta.dir, "ui-e2e-scope.ts");
const TMP = mkdtempSync(join(tmpdir(), "ui-e2e-scope-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("axeSweepInScope", () => {
  test("could not determine is not no", () => {
    expect(axeSweepInScope(null)).toBe(true);
    expect(axeSweepInScope([])).toBe(true);
  });

  test.each([
    "packages/hangar-ui/assets/hangar.css",
    "packages/hangar-server/src/server.ts",
    "packages/hangar-e2e/src/a11y/axe.ts",
    ".github/workflows/ci.yml",
  ])("%s is in scope", (path) => {
    expect(axeSweepInScope([path])).toBe(true);
    expect(axeSweepInScope(["docs/x.md", path])).toBe(true);
  });

  test.each([
    "docs/x.md",
    "packages/hangar-uix/a.ts",
    "packages/hangar-server",
    ".github/workflows/release.yml",
    "packages/runtime-core/src/index.ts",
  ])("%s alone is not", (path) => {
    expect(axeSweepInScope([path])).toBe(false);
  });
});

describe("the script", () => {
  let runs = 0;
  async function scopeOutput(stdin: string): Promise<string> {
    runs += 1;
    const output = join(TMP, `output-${runs}`);
    const child = Bun.spawn(["bun", SCRIPT], {
      env: { PATH: process.env["PATH"] ?? "", GITHUB_OUTPUT: output },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(stdin);
    await child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(existsSync(output)).toBe(true);
    return readFileSync(output, "utf8");
  }

  test("a change out of scope writes axe=false: the skip path, end to end", async () => {
    expect(await scopeOutput("docs/x.md\0")).toBe("axe=false\n");
  });

  test("empty stdin writes axe=true: a failed diff never skips", async () => {
    expect(await scopeOutput("")).toBe("axe=true\n");
  });

  test("a change in scope among others writes axe=true", async () => {
    expect(await scopeOutput("docs/x.md\0packages/hangar-ui/a.js\0")).toBe("axe=true\n");
  });

  test("a path with an odd character stays whole, split only on NUL", async () => {
    expect(await scopeOutput('packages/hangar-ui/a b "c".js\0')).toBe("axe=true\n");
    expect(await scopeOutput("docs/new\nline.md\0")).toBe("axe=false\n");
  });

  test("it appends, so an earlier output in the step survives", async () => {
    const output = join(TMP, "appended");
    await Bun.write(output, "earlier=1\n");
    const child = Bun.spawn(["bun", SCRIPT], {
      env: { PATH: process.env["PATH"] ?? "", GITHUB_OUTPUT: output },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write("docs/x.md\0");
    await child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("earlier=1\naxe=false\n");
  });
});
