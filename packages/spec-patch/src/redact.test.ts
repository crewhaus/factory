import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isCredentialKey, maskCredentialTokens } from "./redact";

describe("isCredentialKey (adversarial review F1)", () => {
  test("matches the credential-key set and close variants, case-insensitively", () => {
    for (const key of [
      "key",
      "apiKey",
      "api_key",
      "API_KEY",
      "token",
      "secret",
      "password",
      "authorization",
      "headers",
      "env",
      "keyRef",
      "privateKey",
      // spec-schema / compiler credential carriers (lowerCredential call sites)
      "botToken",
      "signingSecret",
      "appToken",
      "secretToken",
      "accessToken",
      "GITHUB_TOKEN",
      "slack-token",
    ]) {
      expect(isCredentialKey(key)).toBe(true);
    }
  });

  test("does NOT match ordinary spec keys (suffixes need a word boundary)", () => {
    for (const key of [
      "instructions",
      "model",
      "name",
      "target",
      "chunkSize",
      "max_tokens",
      "monkey",
      "tokens",
      "keynote",
    ]) {
      expect(isCredentialKey(key)).toBe(false);
    }
  });
});

describe("maskCredentialTokens (adversarial review F1)", () => {
  test("masks the well-known token shapes", () => {
    const cases: Array<[string, string]> = [
      ["use sk-live-DEADBEEFDEADBEEF here", "use *** here"],
      ["pat is ghp_abcdefghij0123456789", "pat is ***"],
      ["oauth gho_abcdefghij0123456789", "oauth ***"],
      ["slack xoxb-123456789012-abcdef", "slack ***"],
      ["aws AKIAIOSFODNN7EXAMPLE", "aws ***"],
      ["send Authorization: Bearer abc.def-ghi_jkl", "send Authorization: Bearer ***"],
    ];
    for (const [input, expected] of cases) {
      expect(maskCredentialTokens(input)).toBe(expected);
    }
  });

  test("masks a 32+-char opaque token ONLY behind a key-ish context word", () => {
    const opaque = "A".repeat(16) + "b1_c-d2".repeat(4);
    expect(maskCredentialTokens(`api key: ${opaque}`)).toBe("api key: ***");
    expect(maskCredentialTokens(`token=${opaque}`)).toBe("token=***");
    expect(maskCredentialTokens(`the secret "${opaque}"`)).toBe('the secret "***"');
    // Same token with NO context word: left alone (a hash, a request id, …).
    expect(maskCredentialTokens(`see commit ${opaque} upstream`)).toBe(
      `see commit ${opaque} upstream`,
    );
  });

  test("leaves normal prose untouched (no-hit cases)", () => {
    for (const text of [
      "Think step by step before answering.",
      "Use the password manager to store keys.",
      "The task-completion rate improved.",
      "sk-live", // too short for the sk- shape
      "Bearer hug", // too short for a bearer token
    ]) {
      expect(maskCredentialTokens(text)).toBe(text);
    }
  });
});

describe("maskCredentialTokens: CrewHaus issued secrets", () => {
  // Built from parts at runtime, so no secret-shaped literal sits in the repo.
  const body = (seed: string): string => `${seed}Ab9_-`.repeat(9).slice(0, 43);
  const secret = (kind: "a" | "p" | "s" | "i", seed = "Q"): string =>
    ["ch", kind, "_"].join("") + body(seed);
  const scoped = (): string => `${["ch", "x_"].join("")}eyJyZWZzIjpbXX0.${body("M")}`;

  test("each issued shape is masked in prose with no context word", () => {
    for (const value of [secret("a"), secret("p"), secret("s"), secret("i"), scoped()]) {
      expect(maskCredentialTokens(`see ${value} upstream`)).toBe("see *** upstream");
      expect(maskCredentialTokens(`(${value})`)).toBe("(***)");
      expect(maskCredentialTokens(`x-${value}`)).toBe("x-***");
    }
  });

  test("a secret longer than 43 characters is masked whole", () => {
    expect(maskCredentialTokens(`${secret("s")}EXTRA tail`)).toBe("*** tail");
  });

  test("ids, digests, hints and short look-alikes are left alone", () => {
    for (const text of [
      "prn_01jbcdefghjkmnpqrstvwxyz01",
      "grt_01jbcdefghjkmnpqrstvwxyz01",
      "ab".repeat(32),
      `${["ch", "s_"].join("")}Ab9_`,
      ["ch", "s_"].join(""),
      `${["ch", "x_"].join("")}a.b`,
      `${["ch", "x_"].join("")}payload-without-a-mac`,
      `${["ch", "s_"].join("")}${body("Q").slice(0, 42)}`,
      `${["ch", "z_"].join("")}${body("Q")}`,
      `rich${["ch", "s_"].join("")}${body("Q")}`,
    ]) {
      expect(maskCredentialTokens(text)).toBe(text);
    }
  });

  test("a run of scoped-token prefixes with no mac is left whole, and a real one after it is masked", () => {
    const prefix = ["ch", "x_"].join("");
    const run = `${prefix}-`.repeat(200);
    expect(maskCredentialTokens(run)).toBe(run);
    expect(maskCredentialTokens(`${run} then ${scoped()}`)).toBe(`${run} then ***`);
  });
});

describe("redact.ts keep-in-sync duplication", () => {
  test("packages/ir/src/redact.ts and packages/spec-patch/src/redact.ts are byte-identical", () => {
    // The module is duplicated because @crewhaus/ir keeps zero package
    // dependencies and spec-patch must not depend on the IR layer. This
    // test is the sync guard the header comments promise.
    const here = join(import.meta.dir, "redact.ts");
    const mirror = join(import.meta.dir, "..", "..", "ir", "src", "redact.ts");
    expect(readFileSync(here, "utf-8")).toBe(readFileSync(mirror, "utf-8"));
  });
});
