/**
 * Every secret CrewHaus issues (`cha_`, `chp_`, `chs_`, `chi_` and the scoped
 * `chx_<payload>.<mac>`) is masked by this server's masker wherever it sits.
 * The shapes live in spec-patch's token-shape list, which `maskText` calls;
 * nothing in this package names them. Each position below is one the masker
 * would otherwise pass through: an innocent key, an argv element after a
 * flag that names no credential, a URL fragment, a YAML line under an
 * innocent key, and prose with no context word.
 */
import { describe, expect, test } from "bun:test";
import { maskDeep, maskKeyedText, maskText } from "./mask";

// Built from parts at runtime: no secret-shaped literal sits in the repo.
const BODY = "QAb9_-Zy8x".repeat(5).slice(0, 43);
const prefix = (kind: string): string => ["ch", kind, "_"].join("");
const SECRETS: Readonly<Record<string, string>> = {
  session: prefix("a") + BODY,
  personal: prefix("p") + BODY,
  service: prefix("s") + BODY,
  invite: prefix("i") + BODY,
  scoped: `${prefix("x")}eyJyZWZzIjpbXX0.${BODY}`,
};

/** Values that look a little like a secret and must come back unchanged. */
const LOOK_ALIKES: readonly string[] = [
  "prn_01jbcdefghjkmnpqrstvwxyz01",
  "grt_01jbcdefghjkmnpqrstvwxyz01",
  "0123456789abcdef".repeat(4),
  `${prefix("s")}QAb9`,
  prefix("s"),
  `${prefix("x")}a.b`,
];

describe("the issued secrets are masked by maskDeep", () => {
  for (const [kind, secret] of Object.entries(SECRETS)) {
    test(`${kind}: under an innocent key, in a body and after a flag that names no credential`, () => {
      const out = maskDeep({
        note: secret,
        body: `pasted ${secret} here`,
        argv: ["access", "grant", "--member", secret],
      }) as { note: string; body: string; argv: string[] };
      expect(out.note).toBe("***");
      expect(out.body).toBe("pasted *** here");
      expect(out.argv).toEqual(["access", "grant", "--member", "***"]);
      expect(JSON.stringify(out)).not.toContain(BODY);
    });
  }
});

describe("the issued secrets are masked by maskText", () => {
  for (const [kind, secret] of Object.entries(SECRETS)) {
    test(`${kind}: in a URL fragment and in prose with no context word`, () => {
      const url = `http://127.0.0.1:4321/invite#c=${secret}`;
      expect(maskText(url)).toBe("http://127.0.0.1:4321/invite#c=***");
      expect(maskText(`Ana sent ${secret} over chat`)).toBe("Ana sent *** over chat");
    });
  }
});

describe("the issued secrets are masked by maskKeyedText", () => {
  for (const [kind, secret] of Object.entries(SECRETS)) {
    test(`${kind}: on a YAML line under an innocent key`, () => {
      const text = `name: alpha\nnote: ${secret}\n- ${secret}\n`;
      expect(maskKeyedText(text)).toBe("name: alpha\nnote: ***\n- ***\n");
    });
  }
});

describe("what is not a secret stays as it is", () => {
  test("ids, digests, prefix hints and short look-alikes pass every layer", () => {
    for (const value of LOOK_ALIKES) {
      expect(maskDeep({ note: value, argv: ["--member", value] })).toEqual({
        note: value,
        argv: ["--member", value],
      });
      expect(maskText(`see ${value} now`)).toBe(`see ${value} now`);
      expect(maskKeyedText(`note: ${value}`)).toBe(`note: ${value}`);
    }
  });
});
