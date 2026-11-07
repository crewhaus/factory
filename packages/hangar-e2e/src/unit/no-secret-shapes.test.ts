import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { scanForSecretShapes, secretShapesIn } from "service-fakes";

describe("no real-shaped credential in this package", () => {
  test("the real tree is clean, and the scan really walked it", () => {
    const { scanned, hits } = scanForSecretShapes(join(import.meta.dir, "..", ".."));
    expect(hits).toEqual([]);
    expect(scanned).toBeGreaterThan(20);
  });

  test("the scanner finds a planted string", () => {
    const planted = ["xox", "b-", "1234567890-abcdefghij"].join("");
    expect(secretShapesIn(`token = "${planted}"`)).toEqual([planted]);
  });
});
