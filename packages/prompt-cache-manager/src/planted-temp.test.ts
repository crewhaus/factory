/**
 * 0.7.1 — the prompt-cache rotation record is replaced through a random
 * O_EXCL|O_NOFOLLOW temp. 0.7.0 wrote the fixed `<spec>.json.tmp` through any
 * link planted there.
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
import { createPromptCacheRotationStore } from "./index";

const ROOTS: string[] = [];
afterAll(() => {
  for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
});

describe("the rotation record never goes through a planted link (0.7.1)", () => {
  test("a link at <spec>.json.tmp is not written through; a link at <spec>.json is refused", async () => {
    const base = mkdtempSync(join(tmpdir(), "prompt-cache-links-"));
    ROOTS.push(base);
    const rootDir = join(base, "ws", ".crewhaus", "prompt-cache");
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(base, "outside"));
    const victim = join(base, "outside", "victim");
    writeFileSync(victim, "ORIGINAL\n");

    symlinkSync(victim, join(rootDir, "spec.json.tmp"));
    const store = createPromptCacheRotationStore({ specName: "spec", rootDir });
    await store.write(1234);
    expect(readFileSync(victim, "utf8")).toBe("ORIGINAL\n");
    expect(lstatSync(join(rootDir, "spec.json")).isSymbolicLink()).toBe(false);
    expect(await store.read()).toBe(1234);

    const other = createPromptCacheRotationStore({ specName: "other", rootDir });
    symlinkSync(victim, join(rootDir, "other.json"));
    await expect(other.write(1)).rejects.toThrow(/\(code is-symlink\)/);
    expect(readFileSync(victim, "utf8")).toBe("ORIGINAL\n");
  });
});
