/**
 * The pure functions, tested against published vectors wherever one exists.
 *
 * A hash or an encoder is only worth having if it agrees with everyone else's,
 * so these tests assert the RFC's own numbers rather than whatever this
 * implementation happens to produce: RFC 1321 for MD5, FIPS 180 for SHA,
 * RFC 4231 and RFC 2202 for HMAC, the ULID and UUID specifications for the
 * identifiers. MD5 additionally gets a differential test against Bun's own
 * implementation across three hundred input lengths, which is what catches a
 * padding bug at a block boundary.
 */
import { describe, expect, test } from "bun:test";
import {
  base64ToBytes,
  byteAt,
  bytesToBase64,
  bytesToBase64Url,
  bytesToHex,
  bytesToUtf8,
  decodeInput,
  encodeOutput,
  hexToBytes,
  timingSafeEqual,
  utf8ToBytes,
} from "./lib/bytes";
import { adler32, checksum, crc32, toHex32 } from "./lib/checksum";
import { digest, digestLength, hmac, md5 } from "./lib/hash";
import {
  CROCKFORD,
  NANOID_ALPHABET,
  UUID_NAMESPACES,
  encodeCrockford,
  encodeUlidTime,
  formatUuid,
  isUuid,
  nanoId,
  parseUuid,
  seedState,
  seededBytes,
  seededGenerator,
  seededIndices,
  stampUuidBits,
  ulid,
  uuidNamed,
  uuidV4Random,
  uuidV4Seeded,
  uuidVersion,
} from "./lib/ids";
import { claimInstants, decodeJwt, verifyJwt } from "./lib/jwt";
import { slugify } from "./lib/slug";
import { instantToMillis, isoFromMillis } from "./lib/time";
import { buildUrl, decodeUrlText, encodeUrlText, normalizeUrl, parseUrl } from "./lib/url";

const bytes = (text: string): Uint8Array => utf8ToBytes(text);
const hexOf = (value: Uint8Array): string => bytesToHex(value);

/** The jwt.io example token: HS256 over the classic payload, secret below. */
const CLASSIC_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const CLASSIC_SECRET = "your-256-bit-secret";
/** iss crewhaus, aud api, sub u1, nbf 1_700_000_000, exp 1_800_000_000, secret "topsecret". */
const CLAIMS_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1MSIsImlzcyI6ImNyZXdoYXVzIiwiYXVkIjoiYXBpIiwiZXhwIjoxODAwMDAwMDAwLCJuYmYiOjE3MDAwMDAwMDAsImlhdCI6MTcwMDAwMDAwMH0.wwjyUCuZTvM819X6zcW_gQCOv1NcAJGA28KSTKSQ5oc";
const CLAIMS_SECRET = "topsecret";
const NONE_JWT = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.";

describe("bytes: utf8", () => {
  test("round-trips ascii", () => {
    expect(bytesToUtf8(bytes("hello"))).toBe("hello");
  });

  test("round-trips astral characters and combining marks", () => {
    for (const text of ["日本語", "é", "a b\tc\n"]) {
      expect(bytesToUtf8(bytes(text))).toBe(text);
    }
  });

  test("counts bytes, not characters", () => {
    expect(bytes("é").length).toBe(2);
    expect(bytes("日").length).toBe(3);
  });

  test("decoding refuses invalid UTF-8 rather than substituting U+FFFD", () => {
    expect(() => bytesToUtf8(new Uint8Array([0xff, 0xfe, 0xfd]))).toThrow();
  });

  test("byteAt is in range or zero", () => {
    const buffer = new Uint8Array([7, 8]);
    expect(byteAt(buffer, 1)).toBe(8);
    expect(byteAt(buffer, 99)).toBe(0);
  });
});

describe("bytes: hex", () => {
  test("encodes lowercase by default", () => {
    expect(bytesToHex(new Uint8Array([0x0a, 0xff]))).toBe("0aff");
  });

  test("encodes uppercase and with a separator on request", () => {
    expect(bytesToHex(new Uint8Array([0x0a, 0xff]), true, ":")).toBe("0A:FF");
  });

  test("decodes a plain hex string", () => {
    expect([...hexToBytes("0aff")]).toEqual([0x0a, 0xff]);
  });

  test("tolerates 0x, colons, dashes and whitespace", () => {
    for (const input of ["0x0aff", "0a:ff", "0a-ff", " 0a ff\n"]) {
      expect([...hexToBytes(input)]).toEqual([0x0a, 0xff]);
    }
  });

  test("an odd digit count is an error that says so", () => {
    expect(() => hexToBytes("abc")).toThrow(/odd number/);
  });

  test("a non-hex character names itself", () => {
    expect(() => hexToBytes("0azz")).toThrow(/zz/);
  });

  test("round-trips arbitrary bytes", () => {
    const original = new Uint8Array(256).map((_, i) => i);
    expect([...hexToBytes(bytesToHex(original))]).toEqual([...original]);
  });
});

describe("bytes: base64", () => {
  test("pads to a multiple of four", () => {
    expect(bytesToBase64(bytes("a"))).toBe("YQ==");
    expect(bytesToBase64(bytes("ab"))).toBe("YWI=");
    expect(bytesToBase64(bytes("abc"))).toBe("YWJj");
  });

  test("encodes the classic vector", () => {
    expect(bytesToBase64(bytes("hello world"))).toBe("aGVsbG8gd29ybGQ=");
  });

  test("the URL-safe alphabet avoids + and /", () => {
    const awkward = new Uint8Array([0xfa, 0xfb, 0xfc, 0xfd]);
    expect(bytesToBase64(awkward)).toBe("+vv8/Q==");
    expect(bytesToBase64(awkward, { urlSafe: true })).toBe("-vv8_Q");
  });

  test("padding can be turned off", () => {
    expect(bytesToBase64(bytes("a"), { padding: false })).toBe("YQ");
  });

  test("base64url helper is unpadded", () => {
    expect(bytesToBase64Url(bytes("a"))).toBe("YQ");
  });

  test("decodes with or without padding, either alphabet", () => {
    for (const input of ["aGVsbG8=", "aGVsbG8"]) {
      expect(bytesToUtf8(base64ToBytes(input))).toBe("hello");
    }
    expect([...base64ToBytes("-vv8_Q")]).toEqual([0xfa, 0xfb, 0xfc, 0xfd]);
  });

  test("tolerates the line breaks a PEM body arrives with", () => {
    expect(bytesToUtf8(base64ToBytes("aGVs\nbG8=\n"))).toBe("hello");
  });

  test("an invalid character names itself and its position", () => {
    expect(() => base64ToBytes("aa!a")).toThrow(/"!" at position 2/);
  });

  test("a length that cannot exist is refused", () => {
    expect(() => base64ToBytes("aaaaa")).toThrow(/leftover/);
  });

  test("round-trips every byte value", () => {
    const original = new Uint8Array(256).map((_, i) => i);
    expect([...base64ToBytes(bytesToBase64(original))]).toEqual([...original]);
  });

  test("the empty input is the empty output", () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe("");
    expect(base64ToBytes("").length).toBe(0);
  });
});

describe("bytes: encodings and comparison", () => {
  test("decodeInput reads each declared encoding", () => {
    expect(hexOf(decodeInput("hi", "utf8"))).toBe("6869");
    expect(hexOf(decodeInput("6869", "hex"))).toBe("6869");
    expect(hexOf(decodeInput("aGk=", "base64"))).toBe("6869");
    expect(hexOf(decodeInput("aGk", "base64url"))).toBe("6869");
  });

  test("encodeOutput writes each requested encoding", () => {
    const value = bytes("hi");
    expect(encodeOutput(value, "utf8")).toBe("hi");
    expect(encodeOutput(value, "hex")).toBe("6869");
    expect(encodeOutput(value, "base64")).toBe("aGk=");
    expect(encodeOutput(value, "base64url")).toBe("aGk");
  });

  test("timingSafeEqual is true only for identical bytes", () => {
    expect(timingSafeEqual(bytes("abc"), bytes("abc"))).toBe(true);
    expect(timingSafeEqual(bytes("abc"), bytes("abd"))).toBe(false);
    expect(timingSafeEqual(bytes("abc"), bytes("abcd"))).toBe(false);
    expect(timingSafeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });
});

describe("hash: MD5 against RFC 1321", () => {
  const vectors: ReadonlyArray<[string, string]> = [
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
    [
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
      "d174ab98d277d9f5a5611c2c9f419d9f",
    ],
    [
      "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
      "57edf4a22be3c955ac49da2e2107b67a",
    ],
  ];

  for (const [input, expected] of vectors) {
    test(`md5("${input.slice(0, 20)}${input.length > 20 ? "..." : ""}")`, () => {
      expect(hexOf(md5(bytes(input)))).toBe(expected);
    });
  }

  test("matches Bun's own MD5 across 300 lengths, which is where padding bugs hide", () => {
    let mismatches = 0;
    for (let length = 0; length < 300; length++) {
      const buffer = new Uint8Array(length).map((_, i) => (i * 37 + 11) & 0xff);
      const theirs = new Bun.CryptoHasher("md5").update(buffer).digest("hex");
      if (hexOf(md5(buffer)) !== theirs) mismatches++;
    }
    expect(mismatches).toBe(0);
  });

  test("the digest is always sixteen bytes", () => {
    expect(md5(bytes("")).length).toBe(16);
    expect(md5(bytes("x".repeat(1000))).length).toBe(16);
  });

  test("the well-known pangram vector", async () => {
    expect(hexOf(await digest("md5", bytes("The quick brown fox jumps over the lazy dog")))).toBe(
      "9e107d9d372bb6826bd81d3542a419d6",
    );
  });
});

describe("hash: SHA against the FIPS examples", () => {
  test('sha1("abc")', async () => {
    expect(hexOf(await digest("sha1", bytes("abc")))).toBe(
      "a9993e364706816aba3e25717850c26c9cd0d89d",
    );
  });

  test('sha256("abc")', async () => {
    expect(hexOf(await digest("sha256", bytes("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test('sha384("abc")', async () => {
    expect(hexOf(await digest("sha384", bytes("abc")))).toBe(
      "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7",
    );
  });

  test('sha512("abc")', async () => {
    expect(hexOf(await digest("sha512", bytes("abc")))).toBe(
      "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
    );
  });

  test("digestLength describes every algorithm", () => {
    expect([
      digestLength("md5"),
      digestLength("sha1"),
      digestLength("sha256"),
      digestLength("sha384"),
      digestLength("sha512"),
    ]).toEqual([16, 20, 32, 48, 64]);
  });

  test("the declared length matches the actual digest", async () => {
    for (const algorithm of ["md5", "sha1", "sha256", "sha384", "sha512"] as const) {
      expect((await digest(algorithm, bytes("x"))).length).toBe(digestLength(algorithm));
    }
  });
});

describe("hash: HMAC against RFC 4231 and RFC 2202", () => {
  const key = new Uint8Array(20).fill(0x0b);

  test("HMAC-SHA256, case 1", async () => {
    expect(hexOf(await hmac("sha256", key, bytes("Hi There")))).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
  });

  test("HMAC-SHA1, case 1", async () => {
    expect(hexOf(await hmac("sha1", key, bytes("Hi There")))).toBe(
      "b617318655057264e28bc0b6fb378c8ef146be00",
    );
  });

  test("a key longer than the block size still works", async () => {
    const long = new Uint8Array(200).fill(0xaa);
    expect((await hmac("sha256", long, bytes("x"))).length).toBe(32);
  });

  test("changing one message byte changes the signature", async () => {
    const a = await hmac("sha256", key, bytes("payload"));
    const b = await hmac("sha256", key, bytes("payloae"));
    expect(timingSafeEqual(a, b)).toBe(false);
  });

  test("changing the key changes the signature", async () => {
    const a = await hmac("sha256", bytes("k1"), bytes("payload"));
    const b = await hmac("sha256", bytes("k2"), bytes("payload"));
    expect(timingSafeEqual(a, b)).toBe(false);
  });

  test("an empty key is refused, because that is an unset secret", async () => {
    await expect(hmac("sha256", new Uint8Array(0), bytes("x"))).rejects.toThrow(/empty/);
  });
});

describe("checksum", () => {
  test("crc32 of the standard check string", () => {
    expect(toHex32(crc32(bytes("123456789")))).toBe("cbf43926");
  });

  test("crc32 of the pangram", () => {
    expect(toHex32(crc32(bytes("The quick brown fox jumps over the lazy dog")))).toBe("414fa339");
  });

  test("crc32 of nothing is zero", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  test("adler32 of the standard check string", () => {
    expect(toHex32(adler32(bytes("123456789")))).toBe("091e01de");
  });

  test('adler32("Wikipedia")', () => {
    expect(toHex32(adler32(bytes("Wikipedia")))).toBe("11e60398");
  });

  test("adler32 of nothing is one, per RFC 1950", () => {
    expect(adler32(new Uint8Array(0))).toBe(1);
    expect(toHex32(adler32(bytes("a")))).toBe("00620062");
  });

  test("adler32 survives inputs longer than its 5552-byte block", () => {
    const long = new Uint8Array(20_000).fill(0xff);
    expect(adler32(long)).toBeGreaterThan(0);
    expect(adler32(long)).toBeLessThanOrEqual(0xffffffff);
  });

  test("checksum dispatches to the named algorithm", () => {
    expect(checksum("crc32", bytes("123456789"))).toBe(crc32(bytes("123456789")));
    expect(checksum("adler32", bytes("123456789"))).toBe(adler32(bytes("123456789")));
  });

  test("toHex32 always produces eight digits", () => {
    expect(toHex32(1)).toBe("00000001");
    expect(toHex32(0xffffffff)).toBe("ffffffff");
  });
});

describe("ids: seeded randomness", () => {
  test("the same seed gives the same stream", () => {
    const a = seededGenerator("seed");
    const b = seededGenerator("seed");
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  test("different seeds give different streams", () => {
    expect(seededGenerator("a")()).not.toBe(seededGenerator("b")());
  });

  test("the stream is not constant", () => {
    const next = seededGenerator("seed");
    expect(new Set([next(), next(), next(), next()]).size).toBeGreaterThan(1);
  });

  test("seededBytes returns exactly the requested count", () => {
    for (const count of [0, 1, 3, 4, 5, 16, 33]) {
      expect(seededBytes("seed", count).length).toBe(count);
    }
  });

  test("seededBytes is deterministic", () => {
    expect([...seededBytes("s", 16)]).toEqual([...seededBytes("s", 16)]);
  });

  test("seededIndices stay inside the bound", () => {
    for (const index of seededIndices("seed", 500, 7)) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(7);
    }
  });

  test("seededIndices covers its range rather than collapsing", () => {
    expect(new Set(seededIndices("seed", 500, 7)).size).toBe(7);
  });

  test("seededIndices returns the requested count", () => {
    expect(seededIndices("seed", 64, 64).length).toBe(64);
  });
});

describe("ids: the seeded stream is the published algorithm", () => {
  /**
   * cyrb128 and sfc32, transcribed from the published algorithms rather than
   * from `lib/ids.ts`. A seeded id is only reproducible if the stream under it
   * never moves, so the stream is checked against an independent copy of what
   * it claims to be — not merely against itself twice.
   */
  function referenceCyrb128(seed: string): [number, number, number, number] {
    let h1 = 1779033703;
    let h2 = 3144134277;
    let h3 = 1013904242;
    let h4 = 2773480762;
    for (let i = 0; i < seed.length; i++) {
      const k = seed.charCodeAt(i);
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
  }

  function referenceSfc32(seed: string): () => number {
    let [a, b, c, d] = referenceCyrb128(seed);
    return () => {
      a >>>= 0;
      b >>>= 0;
      c >>>= 0;
      d >>>= 0;
      let t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return t >>> 0;
    };
  }

  test("seedState is cyrb128", () => {
    for (const seed of ["", "seed", "run-1#0", "a much longer seed with spaces"]) {
      expect(seedState(seed)).toEqual(referenceCyrb128(seed));
    }
  });

  test("the stream is sfc32 over that state, for a thousand draws", () => {
    const mine = seededGenerator("release");
    const reference = referenceSfc32("release");
    let mismatches = 0;
    for (let i = 0; i < 1000; i++) if (mine() !== reference()) mismatches++;
    expect(mismatches).toBe(0);
  });

  test("the first draws are pinned, so the stream cannot be changed quietly", () => {
    // Every seeded id in this package is a function of these numbers. Changing
    // the PRNG would silently renumber every id a harness ever recorded, so
    // the values are nailed down here and a change has to be deliberate.
    const next = seededGenerator("seed");
    expect([next(), next(), next(), next()]).toEqual([
      1_452_853_800, 1_711_681_158, 2_414_175_077, 4_063_236_911,
    ]);
  });

  test("every byte value shows up across a long seeded draw", () => {
    // A stuck or byte-aligned generator would fail this; 4096 draws over 256
    // values leaves a vanishing chance of a false alarm.
    expect(new Set(seededBytes("coverage", 4096)).size).toBe(256);
  });
});

describe("ids: UUID", () => {
  test("formatUuid lays out 8-4-4-4-12", () => {
    const value = new Uint8Array(16).map((_, i) => i);
    expect(formatUuid(value)).toBe("00010203-0405-0607-0809-0a0b0c0d0e0f");
  });

  test("parseUuid round-trips the canonical form", () => {
    const text = "886313e1-3b8a-5372-9b90-0c9aee199e5d";
    const parsed = parseUuid(text);
    expect(parsed).toBeDefined();
    expect(formatUuid(parsed as Uint8Array)).toBe(text);
  });

  test("parseUuid accepts braces and the urn prefix", () => {
    expect(parseUuid("{886313e1-3b8a-5372-9b90-0c9aee199e5d}")).toBeDefined();
    expect(parseUuid("urn:uuid:886313e1-3b8a-5372-9b90-0c9aee199e5d")).toBeDefined();
  });

  test("parseUuid rejects a non-UUID", () => {
    expect(parseUuid("not-a-uuid")).toBeUndefined();
    expect(isUuid("886313e1-3b8a-5372-9b90-0c9aee199e5")).toBe(false);
  });

  test("stampUuidBits sets the version and the RFC 4122 variant", () => {
    const stamped = stampUuidBits(new Uint8Array(16).fill(0xff), 5);
    expect(byteAt(stamped, 6) >> 4).toBe(5);
    expect(byteAt(stamped, 8) & 0xc0).toBe(0x80);
  });

  test("uuid v5 matches the published DNS/python.org vector", async () => {
    expect(await uuidNamed(5, "dns", "python.org")).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
  });

  test("uuid v3 matches the published DNS/python.org vector", async () => {
    expect(await uuidNamed(3, "dns", "python.org")).toBe("6fa459ea-ee8a-3ca4-894e-db77e160355e");
  });

  test("a namespace can be given as a literal UUID", async () => {
    expect(await uuidNamed(5, UUID_NAMESPACES["dns"] as string, "python.org")).toBe(
      "886313e1-3b8a-5372-9b90-0c9aee199e5d",
    );
  });

  test("a different name gives a different id", async () => {
    expect(await uuidNamed(5, "dns", "python.org")).not.toBe(await uuidNamed(5, "dns", "ruby.org"));
  });

  test("a bad namespace is refused by name", async () => {
    await expect(uuidNamed(5, "nope", "x")).rejects.toThrow(/nope/);
  });

  test("seeded v4 is stable, well-formed and version 4", () => {
    const first = uuidV4Seeded("run-1");
    expect(first).toBe(uuidV4Seeded("run-1"));
    expect(isUuid(first)).toBe(true);
    expect(uuidVersion(first)).toBe(4);
  });

  test("seeded v4 differs by seed", () => {
    expect(uuidV4Seeded("run-1")).not.toBe(uuidV4Seeded("run-2"));
  });

  test("random v4 is well-formed and, being random, differs each call", () => {
    const first = uuidV4Random();
    expect(isUuid(first)).toBe(true);
    expect(uuidVersion(first)).toBe(4);
    expect(first).not.toBe(uuidV4Random());
  });

  test("uuidVersion reads the version digit of a name-based id", () => {
    expect(uuidVersion("886313e1-3b8a-5372-9b90-0c9aee199e5d")).toBe(5);
    expect(uuidVersion("nope")).toBeUndefined();
  });
});

describe("ids: ULID", () => {
  test("encodes the specification's example instant", () => {
    expect(encodeUlidTime(1_469_918_176_385)).toBe("01ARYZ6S41");
  });

  test("the time prefix is always ten characters", () => {
    expect(encodeUlidTime(0)).toBe("0000000000");
    expect(encodeUlidTime(0xffff_ffff_ffff).length).toBe(10);
  });

  test("an out-of-range instant is refused", () => {
    expect(() => encodeUlidTime(-1)).toThrow(/48-bit/);
    expect(() => encodeUlidTime(0x1_0000_0000_0000)).toThrow(/48-bit/);
    expect(() => encodeUlidTime(1.5)).toThrow();
  });

  test("a ULID is 26 Crockford characters", () => {
    const value = ulid(1_469_918_176_385, "seed");
    expect(value.length).toBe(26);
    for (const character of value) expect(CROCKFORD).toContain(character);
  });

  test("the same instant and seed give the same ULID", () => {
    expect(ulid(1_000, "seed")).toBe(ulid(1_000, "seed"));
  });

  test("a different seed changes only the entropy half", () => {
    const a = ulid(1_000, "one");
    const b = ulid(1_000, "two");
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
    expect(a.slice(10)).not.toBe(b.slice(10));
  });

  test("later instants sort after earlier ones, lexicographically", () => {
    const early = ulid(1_000, "seed");
    const late = ulid(2_000, "seed");
    expect(early < late).toBe(true);
  });

  test("encodeCrockford pads to the requested width", () => {
    expect(encodeCrockford(new Uint8Array([0]), 4)).toBe("0000");
    expect(encodeCrockford(seededBytes("s", 10), 16).length).toBe(16);
  });
});

describe("ids: NanoId", () => {
  test("is deterministic in the seed", () => {
    expect(nanoId("seed", 21, NANOID_ALPHABET)).toBe(nanoId("seed", 21, NANOID_ALPHABET));
  });

  test("honours the requested size", () => {
    for (const size of [2, 8, 21, 64]) {
      expect(nanoId("seed", size, NANOID_ALPHABET).length).toBe(size);
    }
  });

  test("uses only the alphabet it was given", () => {
    const value = nanoId("seed", 50, "abc");
    expect(/^[abc]+$/.test(value)).toBe(true);
  });

  test("the default alphabet is URL-safe", () => {
    expect(/^[A-Za-z0-9_-]+$/.test(nanoId("seed", 64, NANOID_ALPHABET))).toBe(true);
  });

  test("duplicate characters in the alphabet do not weight themselves", () => {
    expect(nanoId("seed", 10, "aab")).toBe(nanoId("seed", 10, "ab"));
  });

  test("an alphabet of one is refused", () => {
    expect(() => nanoId("seed", 5, "aaa")).toThrow(/two distinct/);
  });

  test("different seeds give different ids", () => {
    expect(nanoId("a", 21, NANOID_ALPHABET)).not.toBe(nanoId("b", 21, NANOID_ALPHABET));
  });
});

describe("url: parse", () => {
  const parsed = parseUrl("https://user:secret@Example.COM:8443/a/b?x=1&y=two#frag");

  test("lowercases the host and keeps an explicit non-default port", () => {
    expect(parsed.hostname).toBe("example.com");
    expect(parsed.port).toBe(8443);
  });

  test("splits the path into segments", () => {
    expect(parsed.pathSegments).toEqual(["a", "b"]);
  });

  test("returns query parameters as ordered pairs", () => {
    expect(parsed.params).toEqual([
      { key: "x", value: "1" },
      { key: "y", value: "two" },
    ]);
  });

  test("keeps the username but masks the password", () => {
    expect(parsed.username).toBe("user");
    expect(parsed.password).toBe("***");
  });

  test("a default port is reported as absent", () => {
    expect(parseUrl("https://example.com/").port).toBeNull();
  });

  test("repeated parameters are preserved, not collapsed", () => {
    expect(parseUrl("https://e.test/?a=1&a=2").params).toEqual([
      { key: "a", value: "1" },
      { key: "a", value: "2" },
    ]);
  });

  test("a relative reference resolves against a base", () => {
    expect(parseUrl("../c", "https://e.test/a/b/").href).toBe("https://e.test/a/c");
  });

  test("a relative reference without a base says what is missing", () => {
    expect(() => parseUrl("/just/a/path")).toThrow(/needs a base/);
  });

  test("a non-URL is refused", () => {
    expect(() => parseUrl("not a url")).toThrow();
  });
});

describe("url: build", () => {
  test("encodes a value that would otherwise break the query", () => {
    const built = buildUrl({
      scheme: "https",
      host: "e.test",
      path: "/search",
      params: [{ key: "q", value: "a&b=c d" }],
    });
    expect(built).toBe("https://e.test/search?q=a%26b%3Dc+d");
    expect(parseUrl(built).params).toEqual([{ key: "q", value: "a&b=c d" }]);
  });

  test("adds a leading slash to a path that lacks one", () => {
    expect(buildUrl({ scheme: "https", host: "e.test", path: "a" })).toBe("https://e.test/a");
  });

  test("carries a port and a fragment", () => {
    expect(
      buildUrl({ scheme: "http", host: "e.test", port: 8080, path: "/x", fragment: "top" }),
    ).toBe("http://e.test:8080/x#top");
  });

  test("repeated parameters stay repeated", () => {
    expect(
      buildUrl({
        scheme: "https",
        host: "e.test",
        params: [
          { key: "a", value: "1" },
          { key: "a", value: "2" },
        ],
      }),
    ).toBe("https://e.test/?a=1&a=2");
  });

  test("an empty host is refused", () => {
    expect(() => buildUrl({ scheme: "https", host: " " })).toThrow(/host/);
  });

  test("a nonsense scheme is refused", () => {
    expect(() => buildUrl({ scheme: "1http!", host: "e.test" })).toThrow(/scheme/);
  });
});

describe("url: normalize", () => {
  test("lowercases, drops the default port and resolves dot segments", () => {
    expect(normalizeUrl("HTTPS://Example.COM:443/a/./b/../c")).toBe("https://example.com/a/c");
  });

  test("sorts query parameters by default", () => {
    expect(normalizeUrl("https://e.test/?b=2&a=1")).toBe("https://e.test/?a=1&b=2");
  });

  test("the sort is by code unit, not by the machine's locale", () => {
    // `localeCompare` under en-US orders "a" before "B"; a canonical form has
    // to be a function of the URL alone, so the codepoint order stands.
    expect(normalizeUrl("https://e.test/?B=1&a=2")).toBe("https://e.test/?B=1&a=2");
    expect(normalizeUrl("https://e.test/?a=2&B=1")).toBe("https://e.test/?B=1&a=2");
    expect(normalizeUrl("https://e.test/?b=1&A=2")).toBe("https://e.test/?A=2&b=1");
  });

  test("repeated keys are ordered by value, also by code unit", () => {
    expect(normalizeUrl("https://e.test/?a=2&a=10&a=1")).toBe("https://e.test/?a=1&a=10&a=2");
  });

  test("a question mark inside the fragment is fragment text, and stays", () => {
    expect(normalizeUrl("https://e.test/p#x?")).toBe("https://e.test/p#x?");
    expect(normalizeUrl("https://e.test/p#a?b=c")).toBe("https://e.test/p#a?b=c");
  });

  test("an empty query is dropped even when a fragment follows it", () => {
    expect(normalizeUrl("https://e.test/p?#f")).toBe("https://e.test/p#f");
  });

  test("sorting can be turned off for a signed URL", () => {
    expect(normalizeUrl("https://e.test/?b=2&a=1", { sortQuery: false })).toBe(
      "https://e.test/?b=2&a=1",
    );
  });

  test("a bare question mark is removed", () => {
    expect(normalizeUrl("https://e.test/?")).toBe("https://e.test/");
  });

  test("tracking parameters can be dropped by prefix", () => {
    expect(
      normalizeUrl("https://e.test/p?utm_source=x&utm_medium=y&id=7", { removeParams: ["utm_*"] }),
    ).toBe("https://e.test/p?id=7");
  });

  test("a named parameter can be dropped exactly", () => {
    expect(normalizeUrl("https://e.test/?a=1&b=2", { removeParams: ["b"] })).toBe(
      "https://e.test/?a=1",
    );
  });

  test("the fragment, www and credentials can each be stripped", () => {
    expect(normalizeUrl("https://www.e.test/x#frag", { stripFragment: true, stripWww: true })).toBe(
      "https://e.test/x",
    );
    expect(normalizeUrl("https://u:p@e.test/x", { stripAuth: true })).toBe("https://e.test/x");
  });

  test("a trailing slash is stripped only below the root", () => {
    expect(normalizeUrl("https://e.test/a/", { stripTrailingSlash: true })).toBe(
      "https://e.test/a",
    );
    expect(normalizeUrl("https://e.test/", { stripTrailingSlash: true })).toBe("https://e.test/");
  });

  test("normalizing is idempotent", () => {
    const once = normalizeUrl("HTTPS://E.test:443/a/../b?z=1&a=2#f");
    expect(normalizeUrl(once)).toBe(once);
  });

  test("a relative reference is refused, since there is nothing to canonicalize", () => {
    expect(() => normalizeUrl("/a/b")).toThrow(/absolute/);
  });
});

describe("url: percent-encoding", () => {
  test("component encodes the characters that would break a query value", () => {
    expect(encodeUrlText("a b&c=d/e", "component")).toBe("a%20b%26c%3Dd%2Fe");
  });

  test("uri leaves URL punctuation intact", () => {
    expect(encodeUrlText("https://e.test/a b?x=1", "uri")).toBe("https://e.test/a%20b?x=1");
  });

  test("form uses + for a space, as an HTML form POST does", () => {
    expect(encodeUrlText("a b+c&d", "form")).toBe("a+b%2Bc%26d");
  });

  test("each mode round-trips its own output", () => {
    for (const mode of ["component", "uri", "form"] as const) {
      const original = "a b&c/d?e=f";
      expect(decodeUrlText(encodeUrlText(original, mode), mode)).toBe(original);
    }
  });

  test("form decoding maps + back to a space", () => {
    expect(decodeUrlText("a+b%2Bc", "form")).toBe("a b+c");
  });

  test("a malformed escape is reported, not thrown as a bare URIError", () => {
    expect(() => decodeUrlText("%zz", "component")).toThrow(/percent-escape/);
  });

  test("an unpaired surrogate is named, in every mode", () => {
    // encodeURIComponent throws a bare URIError on one and URLSearchParams
    // silently swaps in U+FFFD; neither is an answer a caller can act on.
    const lone = `a${String.fromCharCode(0xd800)}b`;
    for (const mode of ["component", "uri", "form"] as const) {
      expect(() => encodeUrlText(lone, mode)).toThrow(/unpaired surrogate/);
    }
    const lowOnly = String.fromCharCode(0xdc00);
    expect(() => encodeUrlText(lowOnly, "component")).toThrow(/unpaired surrogate/);
  });

  test("a well-formed surrogate pair still encodes", () => {
    expect(encodeUrlText("\u{20000}", "component")).toBe("%F0%A0%80%80");
  });
});

describe("jwt: decode", () => {
  test("reads the header and payload of the standard example token", () => {
    const decoded = decodeJwt(CLASSIC_JWT);
    expect(decoded.header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(decoded.payload["name"]).toBe("John Doe");
  });

  test("keeps the signing input so a signature can be recomputed", () => {
    const decoded = decodeJwt(CLASSIC_JWT);
    expect(decoded.signingInput).toBe(CLASSIC_JWT.split(".").slice(0, 2).join("."));
  });

  test("ignores a Bearer prefix and surrounding whitespace", () => {
    expect(decodeJwt(`  Bearer ${CLASSIC_JWT} `).payload["sub"]).toBe("1234567890");
  });

  test("a five-segment token is named as a JWE rather than mis-parsed", () => {
    expect(() => decodeJwt("a.b.c.d.e")).toThrow(/JWE/);
  });

  test("a wrong segment count says how many it found", () => {
    expect(() => decodeJwt("a.b")).toThrow(/found 2/);
  });

  test("a segment that is not JSON is reported", () => {
    const notJson = `${bytesToBase64Url(bytes("hello"))}.${bytesToBase64Url(bytes("{}"))}.x`;
    expect(() => decodeJwt(notJson)).toThrow(/header segment is not JSON/);
  });

  test("a payload that is a JSON array is refused", () => {
    const header = bytesToBase64Url(bytes('{"alg":"HS256"}'));
    const payload = bytesToBase64Url(bytes("[1,2]"));
    expect(() => decodeJwt(`${header}.${payload}.x`)).toThrow(/not a JSON object/);
  });

  test("claimInstants renders the time claims as ISO", () => {
    expect(claimInstants({ iat: 1_516_239_022 })["iat"]).toBe("2018-01-18T01:30:22.000Z");
  });

  test("claimInstants ignores claims that are not numbers", () => {
    expect(claimInstants({ exp: "soon", sub: "x" })).toEqual({});
  });

  test("a claim outside the range of a date is skipped, not thrown over", () => {
    // The payload is attacker-controlled; `new Date(1e17).toISOString()`
    // throws a bare RangeError, which a tool must never do to its caller.
    expect(() => claimInstants({ exp: 99_999_999_999_999 })).not.toThrow();
    expect(claimInstants({ exp: 99_999_999_999_999, iat: 1_516_239_022 })).toEqual({
      iat: "2018-01-18T01:30:22.000Z",
    });
  });
});

describe("jwt: verify", () => {
  const now = 1_700_000_100;

  /** Mint a correctly-signed HS256 token so claim handling can be tested alone. */
  async function signed(payload: Record<string, unknown>): Promise<string> {
    const head = bytesToBase64Url(bytes(JSON.stringify({ alg: "HS256", typ: "JWT" })));
    const body = bytesToBase64Url(bytes(JSON.stringify(payload)));
    const signature = await hmac("sha256", bytes(CLAIMS_SECRET), bytes(`${head}.${body}`));
    return `${head}.${body}.${bytesToBase64Url(signature)}`;
  }

  test("a correctly-signed, in-window token is valid", async () => {
    const result = await verifyJwt(CLAIMS_JWT, bytes(CLAIMS_SECRET), { now, algorithm: "HS256" });
    expect(result.valid).toBe(true);
    expect(result.signatureValid).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  test("the jwt.io example verifies with its published secret", async () => {
    const result = await verifyJwt(CLASSIC_JWT, bytes(CLASSIC_SECRET), {
      now,
      algorithm: "HS256",
    });
    expect(result.signatureValid).toBe(true);
  });

  test("the wrong secret fails, and says so", async () => {
    const result = await verifyJwt(CLAIMS_JWT, bytes("wrong"), { now, algorithm: "HS256" });
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("signature does not match");
  });

  test("an expired token is invalid even though the signature is good", async () => {
    const result = await verifyJwt(CLAIMS_JWT, bytes(CLAIMS_SECRET), {
      now: 1_900_000_000,
      algorithm: "HS256",
    });
    expect(result.signatureValid).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain("expired");
  });

  test("a token used before its nbf is invalid", async () => {
    const result = await verifyJwt(CLAIMS_JWT, bytes(CLAIMS_SECRET), {
      now: 1_600_000_000,
      algorithm: "HS256",
    });
    expect(result.reasons.join(" ")).toContain("not valid for another");
  });

  test("leeway absorbs a small clock skew", async () => {
    const justExpired = 1_800_000_030;
    const strict = await verifyJwt(CLAIMS_JWT, bytes(CLAIMS_SECRET), {
      now: justExpired,
      algorithm: "HS256",
    });
    const lenient = await verifyJwt(CLAIMS_JWT, bytes(CLAIMS_SECRET), {
      now: justExpired,
      algorithm: "HS256",
      leewaySeconds: 60,
    });
    expect(strict.valid).toBe(false);
    expect(lenient.valid).toBe(true);
  });

  test("alg none is refused rather than treated as unsigned-but-fine", async () => {
    const result = await verifyJwt(NONE_JWT, bytes(CLAIMS_SECRET), { now, algorithm: "HS256" });
    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain("refusing to verify");
  });

  test("a header algorithm the caller did not expect is refused", async () => {
    const result = await verifyJwt(CLAIMS_JWT, bytes(CLAIMS_SECRET), { now, algorithm: "HS512" });
    expect(result.signatureValid).toBe(false);
    expect(result.reasons.join(" ")).toContain("HS512");
  });

  test("an asymmetric algorithm is refused outright, not faked", async () => {
    await expect(
      verifyJwt(CLAIMS_JWT, bytes(CLAIMS_SECRET), { now, algorithm: "RS256" }),
    ).rejects.toThrow(/HMAC/);
  });

  test("issuer, audience and subject are checked when asked for", async () => {
    const good = await verifyJwt(CLAIMS_JWT, bytes(CLAIMS_SECRET), {
      now,
      algorithm: "HS256",
      issuer: "crewhaus",
      audience: "api",
      subject: "u1",
    });
    expect(good.valid).toBe(true);
    const bad = await verifyJwt(CLAIMS_JWT, bytes(CLAIMS_SECRET), {
      now,
      algorithm: "HS256",
      issuer: "somebody-else",
    });
    expect(bad.valid).toBe(false);
    expect(bad.reasons.join(" ")).toContain("iss is");
  });

  test("expiresInSeconds is relative to the supplied now, not to a clock", async () => {
    const result = await verifyJwt(CLAIMS_JWT, bytes(CLAIMS_SECRET), { now, algorithm: "HS256" });
    expect(result.expiresInSeconds).toBe(1_800_000_000 - now);
  });

  test("an exp that is not a number is refused, not read as 'never expires'", async () => {
    // RFC 7519 says exp is a NumericDate. A token whose exp is the STRING
    // "1800000000" must not sail through every time check untouched.
    const token = await signed({ sub: "u1", exp: "1800000000" });
    const result = await verifyJwt(token, bytes(CLAIMS_SECRET), { now, algorithm: "HS256" });
    expect(result.signatureValid).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain("not a number");
  });

  test("an nbf that is not a number is refused too", async () => {
    const token = await signed({ sub: "u1", nbf: { seconds: 1 } });
    const result = await verifyJwt(token, bytes(CLAIMS_SECRET), { now, algorithm: "HS256" });
    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain("nbf is");
  });

  test("a token with no exp at all is still fine — absent is not malformed", async () => {
    const token = await signed({ sub: "u1" });
    const result = await verifyJwt(token, bytes(CLAIMS_SECRET), { now, algorithm: "HS256" });
    expect(result.valid).toBe(true);
    expect(result.expiresInSeconds).toBeNull();
  });

  test("a garbled signature fails without throwing", async () => {
    const tampered = `${CLAIMS_JWT.split(".").slice(0, 2).join(".")}.!!!!`;
    const result = await verifyJwt(tampered, bytes(CLAIMS_SECRET), { now, algorithm: "HS256" });
    expect(result.signatureValid).toBe(false);
  });
});

describe("slugify", () => {
  test("lowercases and joins words with a hyphen", () => {
    expect(slugify("Hello World").slug).toBe("hello-world");
  });

  test("folds accented Latin letters to their base letter", () => {
    expect(slugify("Crème Brûlée à la Niño").slug).toBe("creme-brulee-a-la-nino");
  });

  test("maps letters that have no decomposition", () => {
    expect(slugify("Straße Øre Þing Łódź").slug).toBe("strasse-ore-thing-lodz");
  });

  test("collapses punctuation and trims the ends", () => {
    expect(slugify("  --A, B & C!!  ").slug).toBe("a-b-c");
  });

  test("applies caller replacements first", () => {
    expect(slugify("Tom & Jerry", { replacements: { "&": "and" } }).slug).toBe("tom-and-jerry");
  });

  test("honours a custom separator", () => {
    expect(slugify("Hello World", { separator: "_" }).slug).toBe("hello_world");
  });

  test("keeps case when asked to", () => {
    expect(slugify("Hello World", { lowercase: false }).slug).toBe("Hello-World");
  });

  test("truncates at a word boundary and reports it", () => {
    const result = slugify("the quick brown fox", { maxLength: 12 });
    expect(result.slug).toBe("the-quick");
    expect(result.truncated).toBe(true);
  });

  test("drops non-Latin scripts by default and says the slug is empty", () => {
    const result = slugify("日本語のタイトル");
    expect(result.slug).toBe("");
    expect(result.empty).toBe(true);
  });

  test("keeps non-Latin scripts with allowUnicode", () => {
    expect(slugify("日本語 の タイトル", { allowUnicode: true }).slug).toBe("日本語-の-タイトル");
  });

  test("truncation counts code points, so a surrogate pair is never split", () => {
    // 𠀀 is a single astral code point stored as two UTF-16 units; a naive
    // slice at 2 would cut it in half and leave a lone surrogate in a URL.
    const result = slugify("𠀀𠀁𠀂𠀃", { allowUnicode: true, maxLength: 2 });
    expect(result.slug).toBe("𠀀𠀁");
    expect([...result.slug].length).toBe(2);
    expect(result.truncated).toBe(true);
  });

  test("is idempotent on its own output", () => {
    const once = slugify("Crème Brûlée & Straße — 2026!").slug;
    expect(slugify(once).slug).toBe(once);
  });

  test("an already-safe string is unchanged", () => {
    expect(slugify("already-safe-123").slug).toBe("already-safe-123");
  });
});

describe("time", () => {
  /**
   * 2026-09-17T00:00:00Z, computed rather than parsed: 20,454 days from the
   * epoch to 2026-01-01 (56 years, 14 of them leap) plus 259 days to
   * September 17th, times 86,400,000.
   */
  const SEPTEMBER_17 = 1_789_603_200_000;

  test("parses an ISO instant", () => {
    expect(instantToMillis("2026-09-17T00:00:00.000Z", "ms")).toBe(SEPTEMBER_17);
  });

  test("an instant with no offset is UTC, not the machine's time zone", () => {
    // The bug this pins: `Date.parse` reads a date-time with no offset as
    // LOCAL time, so this same string would be eight hours earlier on a laptop
    // in Los Angeles than on a runner in UTC — and every ULID and expiry
    // derived from it would differ by machine.
    expect(instantToMillis("2026-09-17T00:00:00", "ms")).toBe(SEPTEMBER_17);
    expect(instantToMillis("2026-09-17T00:00", "ms")).toBe(SEPTEMBER_17);
    expect(instantToMillis("2026-09-17", "ms")).toBe(SEPTEMBER_17);
  });

  test("an explicit offset is applied", () => {
    expect(instantToMillis("2026-09-17T05:30:00+05:30", "ms")).toBe(SEPTEMBER_17);
    expect(instantToMillis("2026-09-16T16:00:00-0800", "ms")).toBe(SEPTEMBER_17);
    expect(instantToMillis("2026-09-17T01:00:00+01:00", "ms")).toBe(SEPTEMBER_17);
  });

  test("fractional seconds are read to the millisecond", () => {
    expect(instantToMillis("2016-07-30T22:36:16.385Z", "ms")).toBe(1_469_918_176_385);
    expect(instantToMillis("2026-09-17T00:00:00.5Z", "ms")).toBe(SEPTEMBER_17 + 500);
  });

  test("reads a number in the unit it was told", () => {
    expect(instantToMillis(1_700_000_000, "s")).toBe(1_700_000_000_000);
    expect(instantToMillis(1_700_000_000_000, "ms")).toBe(1_700_000_000_000);
  });

  test("a numeric string uses the same unit as a number", () => {
    expect(instantToMillis("1700000000", "s")).toBe(1_700_000_000_000);
  });

  test("a non-instant is refused by name", () => {
    expect(() => instantToMillis("last tuesday", "ms")).toThrow(/ISO-8601/);
  });

  test("a format only some engines parse is refused, not guessed at", () => {
    // `Date.parse` accepts these and decides for itself what they mean, which
    // would make the accepted grammar a property of the runtime.
    for (const input of ["Sep 17 2026", "2026/09/17", "17 September 2026", "Thu Sep 17 2026"]) {
      expect(() => instantToMillis(input, "ms")).toThrow(/ISO-8601/);
    }
  });

  test("a date that does not exist is refused rather than rolled over", () => {
    expect(() => instantToMillis("2026-02-31", "ms")).toThrow(/real calendar date/);
    expect(() => instantToMillis("2026-13-01", "ms")).toThrow(/outside its range/);
    expect(() => instantToMillis("2026-09-17T25:00:00Z", "ms")).toThrow(/outside its range/);
  });

  test("a two-digit year is the year it says, not nineteen-hundred-and-it", () => {
    // Date.UTC(26, ...) means 1926; "0026-01-01" has to mean the year 26.
    expect(new Date(instantToMillis("0026-01-01", "ms")).getUTCFullYear()).toBe(26);
  });

  test("a non-finite number is refused", () => {
    expect(() => instantToMillis(Number.NaN, "ms")).toThrow(/finite/);
  });

  test("an instant no date can represent is refused", () => {
    expect(() => instantToMillis(1e17, "s")).toThrow(/outside the range/);
    expect(() => instantToMillis(-1e17, "ms")).toThrow(/outside the range/);
  });

  test("isoFromMillis renders what it can and declines what it cannot", () => {
    expect(isoFromMillis(SEPTEMBER_17)).toBe("2026-09-17T00:00:00.000Z");
    expect(isoFromMillis(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(isoFromMillis(1e17)).toBeUndefined();
    expect(isoFromMillis(Number.NaN)).toBeUndefined();
  });
});
