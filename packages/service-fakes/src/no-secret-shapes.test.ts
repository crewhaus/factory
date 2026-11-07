import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { scanForSecretShapes, secretShapesIn } from "./secret-shapes";

describe("no real-shaped credential in this package", () => {
  test("the real tree is clean, and the scan really walked it", () => {
    const { scanned, hits } = scanForSecretShapes(dirname(import.meta.dir));
    expect(hits).toEqual([]);
    // Six fakes and their tests, at the very least.
    expect(scanned).toBeGreaterThan(10);
  });

  test.each([
    ["Slack bot", ["xox", "b-", "1234567890-abcdefghij"].join("")],
    ["Anthropic", ["sk", "-ant-", "0123456789abcdef0123"].join("")],
    ["GitHub", ["gh", "p_", "0123456789abcdef0123456789abcdef0123"].join("")],
    ["GitHub fine-grained", ["github", "_pat_", "0123456789abcdefghij"].join("")],
    ["AWS", ["AKIA", "ABCDEFGHIJKLMNOP"].join("")],
    ["private key", ["-----BEGIN RSA ", "PRIVATE KEY-----"].join("")],
  ])("the scanner finds a planted %s", (_name, planted) => {
    expect(secretShapesIn(`const x = "${planted}";`)).toEqual([planted]);
  });

  test("an ordinary string is nothing", () => {
    expect(secretShapesIn("const x = 'token value for a test';")).toEqual([]);
  });
});
