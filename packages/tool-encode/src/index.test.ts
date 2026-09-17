import { describe, expect, test } from "bun:test";
/**
 * Every tool this package registers, exercised through its own `execute`.
 *
 * Two things are checked for all of them, because they are the contract the
 * runtime relies on: the safety flags are what the tool contract expects for a
 * pure-compute tool, and the declared schema actually rejects bad input. After
 * that, each tool gets the behaviour tests that matter for it — including the
 * ones that prove a caller mistake comes back as a sentence rather than an
 * exception, and that the answer is the same on the second call.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ENCODE_TOOLS,
  base64Decode,
  base64Encode,
  checksum,
  hash,
  hexDecode,
  hexEncode,
  hmac,
  jwtDecode,
  jwtVerify,
  nanoId,
  slugify,
  ulid,
  urlBuild,
  urlDecode,
  urlEncode,
  urlNormalize,
  urlParse,
  uuid,
} from "./index";

/** Tools return compact JSON; parse it so assertions read as data. */
// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
async function run(tool: (typeof ENCODE_TOOLS)[number], input: unknown): Promise<any> {
  const out = await tool.execute(input);
  if (typeof out !== "string") throw new Error("expected a string result");
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

const text = async (tool: (typeof ENCODE_TOOLS)[number], input: unknown): Promise<string> =>
  (await tool.execute(input)) as string;

const CLASSIC_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const CLAIMS_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1MSIsImlzcyI6ImNyZXdoYXVzIiwiYXVkIjoiYXBpIiwiZXhwIjoxODAwMDAwMDAwLCJuYmYiOjE3MDAwMDAwMDAsImlhdCI6MTcwMDAwMDAwMH0.wwjyUCuZTvM819X6zcW_gQCOv1NcAJGA28KSTKSQ5oc";

describe("package-wide contract", () => {
  test("every tool is exported in ENCODE_TOOLS", () => {
    expect(ENCODE_TOOLS.length).toBe(18);
  });

  test("names are unique", () => {
    const names = ENCODE_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every tool is PascalCase", () => {
    for (const t of ENCODE_TOOLS) expect(t.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("every tool is read-only, non-destructive and internal — this package touches nothing", () => {
    for (const t of ENCODE_TOOLS) {
      expect({ name: t.name, readOnly: t.readOnly }).toEqual({ name: t.name, readOnly: true });
      expect({ name: t.name, destructive: t.destructive }).toEqual({
        name: t.name,
        destructive: false,
      });
      expect({ name: t.name, scope: t.scope }).toEqual({ name: t.name, scope: "internal" });
      expect({ name: t.name, sandbox: t.requiresSandbox }).toEqual({
        name: t.name,
        sandbox: false,
      });
    }
  });

  test("no tool declares an io capability, because none crosses a boundary", () => {
    for (const t of ENCODE_TOOLS) {
      expect({ name: t.name, io: t.ioCapability }).toEqual({ name: t.name, io: undefined });
    }
  });

  test("every tool is concurrency-safe, since all are pure", () => {
    for (const t of ENCODE_TOOLS) {
      expect({ name: t.name, safe: t.concurrencySafe }).toEqual({ name: t.name, safe: true });
    }
  });

  test("every description says what it is for, not just what it is", () => {
    for (const t of ENCODE_TOOLS) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.description).toContain("Use ");
    }
  });

  test("every schema rejects a wholly wrong input shape", () => {
    for (const t of ENCODE_TOOLS) {
      expect({ name: t.name, ok: t.inputSchema.safeParse(42).success }).toEqual({
        name: t.name,
        ok: false,
      });
    }
  });

  test("no tool reads a clock, a locale, an environment or a device", () => {
    // The package's whole claim is that a result is a function of its inputs.
    // The two bugs this catches were both invisible in a single-process test:
    // `Date.parse` read a time zone, and `localeCompare` read a collation
    // locale, so the same call answered differently on another machine.
    const banned: ReadonlyArray<[RegExp, string]> = [
      [/\bDate\.now\s*\(/, "Date.now() reads the clock"],
      [/\bnew Date\s*\(\s*\)/, "new Date() reads the clock"],
      [/\bDate\.parse\s*\(/, "Date.parse reads the machine's time zone for an offsetless string"],
      [/\bMath\.random\s*\(/, "Math.random is unseeded"],
      [/\blocaleCompare\s*\(/, "localeCompare orders by the ambient locale"],
      [/\btoLocale[A-Z]/, "toLocale* formats by the ambient locale"],
      [/\bIntl\./, "Intl reads the ambient locale"],
      [/\bprocess\.env\b/, "process.env is ambient input"],
      [/from "node:/, "a node builtin means filesystem, process or network reach"],
      [/\bfetch\s*\(/, "fetch is a network call"],
    ];
    const root = join(import.meta.dir);
    const files = [
      "index.ts",
      ...readdirSync(join(root, "lib"))
        .filter((f) => f.endsWith(".ts"))
        .map((f) => join("lib", f)),
    ];
    const found: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(root, file), "utf8");
      for (const [pattern, why] of banned) {
        if (pattern.test(source)) found.push(`${file}: ${why}`);
      }
    }
    expect(found).toEqual([]);
  });

  test("the system CSPRNG is reached from exactly one place, and it is labelled", () => {
    // `Uuid` with no seed is the documented exception. If a second call site
    // for it ever appears, this fails and the README has to change with it.
    const root = join(import.meta.dir);
    const callers = ["index.ts", ...readdirSync(join(root, "lib")).map((f) => join("lib", f))]
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /getRandomValues|randomUUID/.test(readFileSync(join(root, f), "utf8")));
    expect(callers).toEqual(["lib/ids.ts"]);
  });

  test("every tool that takes a large string refuses one that is too large", async () => {
    const big = "a".repeat(2_000_001);
    const calls: ReadonlyArray<[(typeof ENCODE_TOOLS)[number], unknown]> = [
      [hash, { text: big }],
      [hmac, { message: big, key: "k" }],
      [checksum, { text: big }],
      [base64Encode, { text: big }],
      [base64Decode, { data: big }],
      [hexEncode, { text: big }],
      [hexDecode, { hex: big }],
      [slugify, { text: big }],
      [urlEncode, { text: big }],
      [urlDecode, { text: big }],
      [urlParse, { url: big }],
      [urlNormalize, { url: big }],
      [jwtDecode, { token: big }],
      [jwtVerify, { token: big, secret: "s", now: 1 }],
      [nanoId, { seed: "s", alphabet: big }],
    ];
    for (const [tool, input] of calls) {
      expect({ name: tool.name, said: (await text(tool, input)).includes("over the") }).toEqual({
        name: tool.name,
        said: true,
      });
    }
  });

  test("the tools list is frozen, so a caller cannot mutate the catalog", () => {
    expect(Object.isFrozen(ENCODE_TOOLS)).toBe(true);
  });

  test("no schema uses .default(), which this repo's compiler settings mishandle", () => {
    for (const t of ENCODE_TOOLS) {
      expect({
        name: t.name,
        hasDefault: JSON.stringify(t.inputSchema).includes("ZodDefault"),
      }).toEqual({ name: t.name, hasDefault: false });
    }
  });
});

describe("Hash", () => {
  test("defaults to sha256 in hex", async () => {
    const out = await run(hash, { text: "abc" });
    expect(out.algorithm).toBe("sha256");
    expect(out.digest).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("every algorithm and encoding is reachable", async () => {
    const md5Result = await run(hash, { text: "abc", algorithm: "md5" });
    expect(md5Result.digest).toBe("900150983cd24fb0d6963f7d28e17f72");
    const base64Result = await run(hash, { text: "abc", encoding: "base64" });
    expect(base64Result.digest).toBe("ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=");
    const urlResult = await run(hash, { text: "abc", encoding: "base64url" });
    expect(urlResult.digest.includes("+")).toBe(false);
  });

  test("warns that md5 and sha1 are broken for security", async () => {
    expect((await run(hash, { text: "x", algorithm: "md5" })).warning).toContain("broken");
    expect((await run(hash, { text: "x", algorithm: "sha1" })).warning).toContain("broken");
    expect((await run(hash, { text: "x" })).warning).toBeUndefined();
  });

  test("hashes binary supplied as hex", async () => {
    const viaHex = await run(hash, { text: "616263", inputEncoding: "hex" });
    expect(viaHex.digest).toBe((await run(hash, { text: "abc" })).digest);
  });

  test("bad hex input is a sentence, not an exception", async () => {
    expect(await text(hash, { text: "zz", inputEncoding: "hex" })).toContain("could not read");
  });

  test("the schema rejects an unknown algorithm", () => {
    expect(hash.inputSchema.safeParse({ text: "x", algorithm: "sha3" }).success).toBe(false);
  });

  test("the same input twice gives the same bytes", async () => {
    expect(await text(hash, { text: "abc" })).toBe(await text(hash, { text: "abc" }));
  });
});

describe("Hmac", () => {
  test("signs with sha256 by default", async () => {
    const out = await run(hmac, { message: "Hi There", key: "0b".repeat(20), keyEncoding: "hex" });
    expect(out.signature).toBe("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
  });

  test("an expected signature is compared and reported", async () => {
    const signed = await run(hmac, { message: "payload", key: "secret" });
    const good = await run(hmac, { message: "payload", key: "secret", expected: signed.signature });
    expect(good.matches).toBe(true);
    const bad = await run(hmac, { message: "payload", key: "secret", expected: "00" });
    expect(bad.matches).toBe(false);
  });

  test("an expected signature spelled differently still matches", async () => {
    // A digest pasted from a dashboard often arrives uppercase, and base64
    // arrives with or without its padding. Comparing the TEXT would report a
    // correct signature as a mismatch, which is the worst possible answer for
    // a webhook check.
    const hex = (await run(hmac, { message: "payload", key: "secret" })).signature as string;
    expect(
      (await run(hmac, { message: "payload", key: "secret", expected: hex.toUpperCase() })).matches,
    ).toBe(true);
    const b64 = (await run(hmac, { message: "payload", key: "secret", encoding: "base64" }))
      .signature as string;
    expect(
      (
        await run(hmac, {
          message: "payload",
          key: "secret",
          encoding: "base64",
          expected: b64.replace(/=+$/, ""),
        })
      ).matches,
    ).toBe(true);
  });

  test("a wrong signature of the right shape still does not match", async () => {
    const hex = (await run(hmac, { message: "payload", key: "secret" })).signature as string;
    const flipped = (hex[0] === "a" ? "b" : "a") + hex.slice(1);
    expect(
      (await run(hmac, { message: "payload", key: "secret", expected: flipped })).matches,
    ).toBe(false);
    expect(
      (await run(hmac, { message: "payload", key: "secret", expected: "not-a-digest" })).matches,
    ).toBe(false);
  });

  test("the algorithm and output encoding are selectable", async () => {
    const out = await run(hmac, {
      message: "x",
      key: "k",
      algorithm: "sha512",
      encoding: "base64",
    });
    expect(out.algorithm).toBe("sha512");
    expect(out.signature.endsWith("=") || out.signature.length > 80).toBe(true);
  });

  test("an empty key is refused by the schema-passing path with a readable message", async () => {
    expect(await text(hmac, { message: "x", key: "", keyEncoding: "utf8" })).toContain(
      "could not compute",
    );
  });

  test("the schema rejects md5, which Web Crypto has no HMAC for", () => {
    expect(hmac.inputSchema.safeParse({ message: "x", key: "k", algorithm: "md5" }).success).toBe(
      false,
    );
  });

  test("a missing key is rejected", () => {
    expect(hmac.inputSchema.safeParse({ message: "x" }).success).toBe(false);
  });
});

describe("Checksum", () => {
  test("crc32 is the default and matches the standard check value", async () => {
    const out = await run(checksum, { text: "123456789" });
    expect(out.algorithm).toBe("crc32");
    expect(out.checksum).toBe("cbf43926");
  });

  test("adler32 and decimal output are available", async () => {
    const out = await run(checksum, {
      text: "123456789",
      algorithm: "adler32",
      encoding: "decimal",
    });
    expect(out.checksum).toBe(0x091e01de);
  });

  test("it says plainly that it is not a tamper check", async () => {
    expect((await run(checksum, { text: "x" })).note).toContain("not tampering");
  });

  test("the schema rejects an unknown algorithm", () => {
    expect(checksum.inputSchema.safeParse({ text: "x", algorithm: "crc16" }).success).toBe(false);
  });

  test("bad input encoding is reported", async () => {
    expect(await text(checksum, { text: "!!", inputEncoding: "hex" })).toContain("could not read");
  });
});

describe("Base64Encode", () => {
  test("encodes text with padding", async () => {
    expect((await run(base64Encode, { text: "hello world" })).encoded).toBe("aGVsbG8gd29ybGQ=");
  });

  test("the URL-safe alphabet drops padding by default", async () => {
    const out = await run(base64Encode, { text: "a", urlSafe: true });
    expect(out.encoded).toBe("YQ");
    expect(out.padded).toBe(false);
    expect(out.alphabet).toBe("base64url");
  });

  test("padding can be forced back on", async () => {
    expect((await run(base64Encode, { text: "a", urlSafe: true, padding: true })).encoded).toBe(
      "YQ==",
    );
  });

  test("hex input lets arbitrary bytes be encoded", async () => {
    expect((await run(base64Encode, { text: "fafbfcfd", inputEncoding: "hex" })).encoded).toBe(
      "+vv8/Q==",
    );
  });

  test("bad hex is a message, not a throw", async () => {
    expect(await text(base64Encode, { text: "xyz", inputEncoding: "hex" })).toContain(
      "could not read",
    );
  });

  test("the schema rejects a non-string text", () => {
    expect(base64Encode.inputSchema.safeParse({ text: 5 }).success).toBe(false);
  });
});

describe("Base64Decode", () => {
  test("decodes to text", async () => {
    expect((await run(base64Decode, { data: "aGVsbG8gd29ybGQ=" })).decoded).toBe("hello world");
  });

  test("accepts base64url and missing padding", async () => {
    expect((await run(base64Decode, { data: "aGVsbG8" })).decoded).toBe("hello");
  });

  test("non-UTF-8 bytes fall back to hex with a note rather than mojibake", async () => {
    const out = await run(base64Decode, { data: "//79" });
    expect(out.encoding).toBe("hex");
    expect(out.note).toContain("not valid UTF-8");
  });

  test("hex output can be requested outright", async () => {
    expect((await run(base64Decode, { data: "aGk=", outputEncoding: "hex" })).decoded).toBe("6869");
  });

  test("invalid base64 explains itself", async () => {
    expect(await text(base64Decode, { data: "aa!a" })).toContain("not valid base64");
  });

  test("the schema requires data", () => {
    expect(base64Decode.inputSchema.safeParse({}).success).toBe(false);
  });
});

describe("HexEncode", () => {
  test("encodes to lowercase hex and counts the bytes", async () => {
    const out = await run(hexEncode, { text: "hi" });
    expect(out.encoded).toBe("6869");
    expect(out.bytes).toBe(2);
  });

  test("uppercase and separators are available", async () => {
    expect((await run(hexEncode, { text: "hi", uppercase: true, separator: ":" })).encoded).toBe(
      "68:69",
    );
  });

  test("multi-byte characters are encoded as their UTF-8 bytes", async () => {
    const out = await run(hexEncode, { text: "é" });
    expect(out.encoded).toBe("c3a9");
    expect(out.bytes).toBe(2);
  });

  test("the schema caps the separator length", () => {
    expect(hexEncode.inputSchema.safeParse({ text: "x", separator: "-----" }).success).toBe(false);
  });
});

describe("HexDecode", () => {
  test("decodes back to text", async () => {
    expect((await run(hexDecode, { hex: "6869" })).decoded).toBe("hi");
  });

  test("tolerates 0x prefixes and separators", async () => {
    expect((await run(hexDecode, { hex: "0x68:69" })).decoded).toBe("hi");
  });

  test("non-UTF-8 bytes come back as base64 with a note", async () => {
    const out = await run(hexDecode, { hex: "fffefd" });
    expect(out.encoding).toBe("base64");
    expect(out.note).toContain("not valid UTF-8");
  });

  test("invalid hex explains itself", async () => {
    expect(await text(hexDecode, { hex: "abc" })).toContain("not valid hex");
  });

  test("the schema rejects an unknown output encoding", () => {
    expect(hexDecode.inputSchema.safeParse({ hex: "00", outputEncoding: "utf16" }).success).toBe(
      false,
    );
  });
});

describe("UrlEncode", () => {
  test("component encoding is the default", async () => {
    expect(await text(urlEncode, { text: "a b&c" })).toBe("a%20b%26c");
  });

  test("uri mode preserves URL structure", async () => {
    expect(await text(urlEncode, { text: "https://e.test/a b", mode: "uri" })).toBe(
      "https://e.test/a%20b",
    );
  });

  test("form mode uses + for space", async () => {
    expect(await text(urlEncode, { text: "a b", mode: "form" })).toBe("a+b");
  });

  test("text that is not valid UTF-16 is a message, not a URIError", async () => {
    const out = await text(urlEncode, { text: `a${String.fromCharCode(0xd800)}b` });
    expect(out).toContain("unpaired surrogate");
  });

  test("the schema rejects an unknown mode", () => {
    expect(urlEncode.inputSchema.safeParse({ text: "x", mode: "raw" }).success).toBe(false);
  });
});

describe("UrlDecode", () => {
  test("decodes a component", async () => {
    expect(await text(urlDecode, { text: "a%20b%26c" })).toBe("a b&c");
  });

  test("form mode maps + back to a space", async () => {
    expect(await text(urlDecode, { text: "a+b", mode: "form" })).toBe("a b");
  });

  test("a malformed escape is a message, not a crash", async () => {
    expect(await text(urlDecode, { text: "%zz" })).toContain("percent-escape");
  });

  test("the schema requires text", () => {
    expect(urlDecode.inputSchema.safeParse({}).success).toBe(false);
  });
});

describe("UrlParse", () => {
  test("splits a URL into its parts", async () => {
    const out = await run(urlParse, { url: "https://e.test:8443/a/b?x=1#f" });
    expect(out.scheme).toBe("https");
    expect(out.hostname).toBe("e.test");
    expect(out.port).toBe(8443);
    expect(out.pathSegments).toEqual(["a", "b"]);
    expect(out.params).toEqual([{ key: "x", value: "1" }]);
    expect(out.fragment).toBe("f");
  });

  test("a password is masked rather than echoed into the transcript", async () => {
    const out = await run(urlParse, { url: "https://user:hunter2@e.test/" });
    expect(out.password).toBe("***");
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });

  test("a relative reference resolves against a base", async () => {
    expect((await run(urlParse, { url: "../c", base: "https://e.test/a/b/" })).href).toBe(
      "https://e.test/a/c",
    );
  });

  test("an unparseable URL is a message", async () => {
    expect(await text(urlParse, { url: "not a url" })).toContain("not a valid URL");
  });

  test("the schema requires a url", () => {
    expect(urlParse.inputSchema.safeParse({ base: "https://e.test" }).success).toBe(false);
  });
});

describe("UrlBuild", () => {
  test("encodes parameter values that would otherwise break the query", async () => {
    const built = await text(urlBuild, {
      scheme: "https",
      host: "e.test",
      path: "/search",
      params: [{ key: "q", value: "a&b c" }],
    });
    expect(built).toBe("https://e.test/search?q=a%26b+c");
  });

  test("carries port and fragment", async () => {
    expect(
      await text(urlBuild, { scheme: "http", host: "e.test", port: 8080, fragment: "top" }),
    ).toBe("http://e.test:8080/#top");
  });

  test("a bad scheme is a message", async () => {
    expect(await text(urlBuild, { scheme: "1!", host: "e.test" })).toContain("scheme");
  });

  test("the schema rejects an out-of-range port", () => {
    expect(
      urlBuild.inputSchema.safeParse({ scheme: "https", host: "e.test", port: 70000 }).success,
    ).toBe(false);
  });

  test("the schema requires a host", () => {
    expect(urlBuild.inputSchema.safeParse({ scheme: "https" }).success).toBe(false);
  });
});

describe("UrlNormalize", () => {
  test("canonicalizes host, port, dot segments and parameter order", async () => {
    const out = await run(urlNormalize, { url: "HTTPS://Example.COM:443/a/./b/../c?b=2&a=1" });
    expect(out.url).toBe("https://example.com/a/c?a=1&b=2");
    expect(out.changed).toBe(true);
  });

  test("an already-canonical URL is reported as unchanged", async () => {
    expect((await run(urlNormalize, { url: "https://example.com/a" })).changed).toBe(false);
  });

  test("tracking parameters can be dropped by prefix", async () => {
    expect(
      (
        await run(urlNormalize, {
          url: "https://e.test/p?utm_source=x&id=7",
          removeParams: ["utm_*"],
        })
      ).url,
    ).toBe("https://e.test/p?id=7");
  });

  test("two spellings of one resource normalize to the same string", async () => {
    const a = await run(urlNormalize, { url: "https://WWW.e.test:443/a/?b=2&a=1#x" });
    const b = await run(urlNormalize, { url: "https://www.e.test/a/?a=1&b=2#y" });
    expect(a.url.split("#")[0]).toBe(b.url.split("#")[0]);
  });

  test("a relative reference is a message", async () => {
    expect(await text(urlNormalize, { url: "/a" })).toContain("absolute");
  });

  test("the parameter order is the same on every machine", async () => {
    // Sorted by code unit, so an uppercase key sorts before a lowercase one
    // whatever locale the runtime happens to default to.
    expect((await run(urlNormalize, { url: "https://e.test/?a=1&B=2" })).url).toBe(
      "https://e.test/?B=2&a=1",
    );
  });

  test("a question mark in the fragment survives", async () => {
    expect((await run(urlNormalize, { url: "https://e.test/p#x?" })).url).toBe(
      "https://e.test/p#x?",
    );
  });

  test("the schema rejects a non-array removeParams", () => {
    expect(
      urlNormalize.inputSchema.safeParse({ url: "https://e.test", removeParams: "utm_*" }).success,
    ).toBe(false);
  });
});

describe("Uuid", () => {
  test("v5 from a namespace and name matches the published vector", async () => {
    const out = await run(uuid, { version: "v5", namespace: "dns", name: "python.org" });
    expect(out.uuids).toEqual(["886313e1-3b8a-5372-9b90-0c9aee199e5d"]);
    expect(out.deterministic).toBe(true);
  });

  test("v3 is available and says to prefer v5", async () => {
    const out = await run(uuid, { version: "v3", namespace: "dns", name: "python.org" });
    expect(out.uuids[0]).toBe("6fa459ea-ee8a-3ca4-894e-db77e160355e");
    expect(out.note).toContain("prefer v5");
  });

  test("a seeded v4 is reproducible and says it must not be used as a token", async () => {
    const first = await run(uuid, { seed: "run-1" });
    const second = await run(uuid, { seed: "run-1" });
    expect(first.uuids).toEqual(second.uuids);
    expect(first.deterministic).toBe(true);
    expect(first.note).toContain("never use as a token");
  });

  test("an unseeded v4 is flagged as the one non-deterministic path", async () => {
    const out = await run(uuid, {});
    expect(out.deterministic).toBe(false);
    expect(out.warning).toContain("CSPRNG");
    expect((await run(uuid, {})).uuids[0]).not.toBe(out.uuids[0]);
  });

  test("a batch produces distinct ids rather than one repeated", async () => {
    const out = await run(uuid, { seed: "batch", count: 5 });
    expect(out.uuids.length).toBe(5);
    expect(new Set(out.uuids).size).toBe(5);
  });

  test("a name-based batch is refused rather than inventing names", async () => {
    // The old behaviour appended the index to the NAME, so count: 2 returned
    // the ids of "python.org0" and "python.org1" while reporting the name as
    // "python.org" — a wrong answer dressed as a right one.
    const refusal = await text(uuid, {
      version: "v5",
      namespace: "dns",
      name: "python.org",
      count: 2,
    });
    expect(refusal).toContain("once per name");
    expect(refusal).not.toContain("-");
  });

  test("a seeded batch agrees with a batch of one about the first id", async () => {
    // A step that asked for one id and a retry that asked for three must not
    // disagree about id zero.
    const one = await run(uuid, { seed: "run", count: 1 });
    const three = await run(uuid, { seed: "run", count: 3 });
    expect(three.uuids[0]).toBe(one.uuids[0]);
  });

  test("v5 without a name says what is missing", async () => {
    expect(await text(uuid, { version: "v5", namespace: "dns" })).toContain("needs both");
  });

  test("an unknown namespace is a message listing the known ones", async () => {
    expect(await text(uuid, { version: "v5", namespace: "nope", name: "x" })).toContain("dns");
  });

  test("the schema rejects an unknown version and an oversized count", () => {
    expect(uuid.inputSchema.safeParse({ version: "v7" }).success).toBe(false);
    expect(uuid.inputSchema.safeParse({ count: 10_000 }).success).toBe(false);
  });
});

describe("Ulid", () => {
  test("generates a 26-character time-sortable id from an ISO instant", async () => {
    const out = await run(ulid, { timestamp: "2016-07-30T22:36:16.385Z", seed: "s" });
    expect(out.ulids[0].length).toBe(26);
    expect(out.ulids[0].startsWith("01ARYZ6S41")).toBe(true);
  });

  test("epoch milliseconds work too, and agree with the ISO form", async () => {
    const fromNumber = await run(ulid, { timestamp: 1_469_918_176_385, seed: "s" });
    const fromIso = await run(ulid, { timestamp: "2016-07-30T22:36:16.385Z", seed: "s" });
    expect(fromNumber.ulids).toEqual(fromIso.ulids);
  });

  test("the same timestamp and seed always give the same id", async () => {
    const args = { timestamp: 1_000_000, seed: "seed" };
    expect(await text(ulid, args)).toBe(await text(ulid, args));
  });

  test("later timestamps sort after earlier ones", async () => {
    const early = await run(ulid, { timestamp: 1_000, seed: "s" });
    const late = await run(ulid, { timestamp: 2_000, seed: "s" });
    expect(early.ulids[0] < late.ulids[0]).toBe(true);
  });

  test("a batch is distinct", async () => {
    const out = await run(ulid, { timestamp: 1_000, seed: "s", count: 4 });
    expect(new Set(out.ulids).size).toBe(4);
  });

  test("a batch agrees with a batch of one about the first id", async () => {
    const one = await run(ulid, { timestamp: 1_000, seed: "s" });
    const four = await run(ulid, { timestamp: 1_000, seed: "s", count: 4 });
    expect(four.ulids[0]).toBe(one.ulids[0]);
  });

  test("an instant no date can represent is a message, not a crash", async () => {
    expect(await text(ulid, { timestamp: 1e17, seed: "s" })).toContain("outside the range");
  });

  test("a timestamp with no offset is read as UTC, not as this machine's zone", async () => {
    const zoneless = await run(ulid, { timestamp: "2016-07-30T22:36:16.385Z", seed: "s" });
    const explicit = await run(ulid, { timestamp: "2016-07-30T22:36:16.385", seed: "s" });
    expect(explicit.ulids).toEqual(zoneless.ulids);
    expect(explicit.ulids[0].startsWith("01ARYZ6S41")).toBe(true);
  });

  test("an unreadable timestamp is a message", async () => {
    expect(await text(ulid, { timestamp: "last tuesday", seed: "s" })).toContain("ISO-8601");
  });

  test("the schema requires a seed", () => {
    expect(ulid.inputSchema.safeParse({ timestamp: 1 }).success).toBe(false);
  });
});

describe("NanoId", () => {
  test("produces a 21-character URL-safe id by default", async () => {
    const out = await run(nanoId, { seed: "seed" });
    expect(out.ids[0].length).toBe(21);
    expect(/^[A-Za-z0-9_-]+$/.test(out.ids[0])).toBe(true);
  });

  test("is reproducible for a seed", async () => {
    expect(await text(nanoId, { seed: "seed" })).toBe(await text(nanoId, { seed: "seed" }));
  });

  test("size and alphabet are respected", async () => {
    const out = await run(nanoId, { seed: "seed", size: 8, alphabet: "0123456789" });
    expect(out.ids[0].length).toBe(8);
    expect(/^[0-9]{8}$/.test(out.ids[0])).toBe(true);
    expect(out.alphabetSize).toBe(10);
  });

  test("a batch is distinct", async () => {
    const out = await run(nanoId, { seed: "seed", count: 10 });
    expect(new Set(out.ids).size).toBe(10);
  });

  test("a batch agrees with a batch of one about the first id", async () => {
    const one = await run(nanoId, { seed: "seed" });
    const ten = await run(nanoId, { seed: "seed", count: 10 });
    expect(ten.ids[0]).toBe(one.ids[0]);
  });

  test("the schema rejects a one-character alphabet and a size below two", () => {
    expect(nanoId.inputSchema.safeParse({ seed: "s", alphabet: "a" }).success).toBe(false);
    expect(nanoId.inputSchema.safeParse({ seed: "s", size: 1 }).success).toBe(false);
  });
});

describe("Slugify", () => {
  test("folds accents and joins with hyphens", async () => {
    expect((await run(slugify, { text: "Crème Brûlée à la Niño" })).slug).toBe(
      "creme-brulee-a-la-nino",
    );
  });

  test("a separator, case and replacements are configurable", async () => {
    const out = await run(slugify, {
      text: "Tom & Jerry",
      separator: "_",
      lowercase: false,
      replacements: { "&": "and" },
    });
    expect(out.slug).toBe("Tom_and_Jerry");
  });

  test("maxLength cuts at a word boundary and reports it", async () => {
    const out = await run(slugify, { text: "the quick brown fox", maxLength: 12 });
    expect(out.slug).toBe("the-quick");
    expect(out.truncated).toBe(true);
  });

  test("a title in a script it cannot romanize yields an empty slug, and says so", async () => {
    const out = await run(slugify, { text: "日本語のタイトル" });
    expect(out.slug).toBe("");
    expect(out.note).toContain("allowUnicode");
  });

  test("allowUnicode keeps those letters", async () => {
    expect((await run(slugify, { text: "日本語", allowUnicode: true })).slug).toBe("日本語");
  });

  test("the schema rejects an oversized maxLength", () => {
    expect(slugify.inputSchema.safeParse({ text: "x", maxLength: 10_000 }).success).toBe(false);
  });
});

describe("JwtDecode", () => {
  test("reads the header and payload", async () => {
    const out = await run(jwtDecode, { token: CLASSIC_JWT });
    expect(out.header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(out.payload.name).toBe("John Doe");
  });

  test("says loudly that nothing was verified", async () => {
    const out = await run(jwtDecode, { token: CLASSIC_JWT });
    expect(out.verified).toBe(false);
    expect(out.warning).toContain("NOT VERIFIED");
  });

  test("renders the time claims as instants", async () => {
    expect((await run(jwtDecode, { token: CLASSIC_JWT })).instants.iat).toBe(
      "2018-01-18T01:30:22.000Z",
    );
  });

  test("a supplied now decides expiry without reading a clock", async () => {
    const before = await run(jwtDecode, { token: CLAIMS_JWT, now: 1_700_000_100 });
    const after = await run(jwtDecode, { token: CLAIMS_JWT, now: 1_900_000_000 });
    expect(before.expired).toBe(false);
    expect(after.expired).toBe(true);
  });

  test("an exp no date can represent does not crash the tool", async () => {
    // The payload is attacker-controlled: a token can claim exp 1e14 and the
    // tool has to answer rather than throw a RangeError at the runtime.
    const head = Buffer.from('{"alg":"HS256"}').toString("base64url");
    const body = Buffer.from('{"exp":99999999999999}').toString("base64url");
    const out = await run(jwtDecode, { token: `${head}.${body}.x` });
    expect(out.payload.exp).toBe(99_999_999_999_999);
    expect(out.instants.exp).toBeUndefined();
  });

  test("a now no date can represent is a message", async () => {
    expect(await text(jwtDecode, { token: CLASSIC_JWT, now: 1e17 })).toContain("outside the range");
  });

  test("a now with no offset is UTC, so the verdict is not the machine's", async () => {
    const zoneless = await run(jwtDecode, { token: CLAIMS_JWT, now: "2023-11-14T22:13:20" });
    expect(zoneless.now).toBe("2023-11-14T22:13:20.000Z");
    expect(zoneless.expired).toBe(false);
  });

  test("a malformed token is a message", async () => {
    expect(await text(jwtDecode, { token: "nope" })).toContain("not a readable JWT");
  });

  test("the schema requires a token", () => {
    expect(jwtDecode.inputSchema.safeParse({}).success).toBe(false);
  });
});

describe("JwtVerify", () => {
  const now = 1_700_000_100;

  test("a good signature inside its window is valid", async () => {
    const out = await run(jwtVerify, { token: CLAIMS_JWT, secret: "topsecret", now });
    expect(out.valid).toBe(true);
    expect(out.reasons).toEqual([]);
  });

  test("the wrong secret is invalid and says why", async () => {
    const out = await run(jwtVerify, { token: CLAIMS_JWT, secret: "wrong", now });
    expect(out.valid).toBe(false);
    expect(out.reasons.join(" ")).toContain("signature does not match");
  });

  test("an expired token fails even with a good signature", async () => {
    const out = await run(jwtVerify, {
      token: CLAIMS_JWT,
      secret: "topsecret",
      now: 1_900_000_000,
    });
    expect(out.signatureValid).toBe(true);
    expect(out.valid).toBe(false);
    expect(out.reasons.join(" ")).toContain("expired");
  });

  test("claims are checked when the caller names them", async () => {
    const out = await run(jwtVerify, {
      token: CLAIMS_JWT,
      secret: "topsecret",
      now,
      issuer: "somebody-else",
    });
    expect(out.valid).toBe(false);
    expect(out.reasons.join(" ")).toContain("iss is");
  });

  test("the expected algorithm comes from the caller, never the token", async () => {
    const out = await run(jwtVerify, {
      token: CLAIMS_JWT,
      secret: "topsecret",
      now,
      algorithm: "HS512",
    });
    expect(out.signatureValid).toBe(false);
    expect(out.reasons.join(" ")).toContain("refusing to verify");
  });

  test("the schema refuses an asymmetric algorithm outright", () => {
    expect(
      jwtVerify.inputSchema.safeParse({
        token: "x",
        secret: "s",
        now: 1,
        algorithm: "RS256",
      }).success,
    ).toBe(false);
  });

  test("now is required, because the tool will not read a clock", () => {
    expect(jwtVerify.inputSchema.safeParse({ token: "x", secret: "s" }).success).toBe(false);
  });

  test("an unreadable now is a message", async () => {
    expect(await text(jwtVerify, { token: CLAIMS_JWT, secret: "s", now: "whenever" })).toContain(
      "ISO-8601",
    );
  });
});
