/**
 * 0.7.1 — a tenant's wrapped DEK file is replaced through a random
 * O_EXCL|O_NOFOLLOW temp. 0.7.0 wrote the fixed `dek-<tenant>.json.tmp`
 * through any link planted there.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
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
import { createFileDekStore, staticKekProvider } from "./index";

const ROOTS: string[] = [];
afterAll(() => {
  for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
});

describe("the file DEK store never writes through a planted link (0.7.1)", () => {
  test("a link at dek-<tenant>.json.tmp is not written through; a link at the key file is refused", async () => {
    const base = mkdtempSync(join(tmpdir(), "dek-links-"));
    ROOTS.push(base);
    const dir = join(base, "keys");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(base, "outside"));
    const victim = join(base, "outside", "victim");
    writeFileSync(victim, "ORIGINAL\n");
    const store = createFileDekStore(
      dir,
      staticKekProvider({ kekRef: "kek:KEK_TEST:v1", kekValue: "kek-v1-secret-12345678" }),
    );

    symlinkSync(victim, join(dir, "dek-t1.json.tmp"));
    const dek = randomBytes(32);
    await store.set("t1", dek);
    expect(readFileSync(victim, "utf8")).toBe("ORIGINAL\n");
    expect(lstatSync(join(dir, "dek-t1.json")).isSymbolicLink()).toBe(false);
    expect((await store.get("t1"))?.equals(dek)).toBe(true);

    // A victim that parses, so the store gets as far as the write.
    const jsonVictim = join(base, "outside", "config.json");
    writeFileSync(jsonVictim, "{}");
    symlinkSync(jsonVictim, join(dir, "dek-t2.json"));
    await expect(store.set("t2", randomBytes(32))).rejects.toThrow(/\(code is-symlink\)/);
    expect(readFileSync(jsonVictim, "utf8")).toBe("{}");
  });
});
