/**
 * The onchain primitives, against published vectors.
 *
 * Every one of these has a canonical answer somebody else published: real
 * calldata, the EIP-712 specification's own worked example, EIP-55's
 * checksums. A codec tested only against itself agrees with itself and with
 * nothing on a chain, which is the only place the answer matters.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeData, encodeCall, parseSignature, parseType, selectorOf } from "./lib/abi";
import { formatUnits, parseUnits, toChecksumAddress, validateAddress } from "./lib/address";
import {
  healthFactorBps,
  maximumIn,
  minimumOut,
  priceImpactBps,
  rescaleDecimals,
  shareBps,
} from "./lib/defi";
import * as multicall from "./lib/multicall";
import {
  AGGREGATE3_SELECTOR,
  AGGREGATE3_SIGNATURE,
  ERROR_STRING_SELECTOR,
  MULTICALL3_ADDRESS,
  PANIC_SELECTOR,
  decodeAggregate3,
  decodeRevertData,
  encodeAggregate3,
} from "./lib/multicall";
import { encodeType, personalSignHash, typedDataDigest } from "./lib/typed";

const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

describe("ABI encoding, against real calldata", () => {
  test("an ERC-20 transfer encodes to the bytes a chain would see", () => {
    expect(encodeCall("transfer(address,uint256)", [VITALIK, 10n ** 18n])).toBe(
      "0xa9059cbb000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa960450000000000000000000000000000000000000000000000000de0b6b3a7640000",
    );
  });

  test("a dynamic value leaves an offset in the head and its bytes in the tail", () => {
    const data = encodeCall("setGreeting(string)", ["hello"]);
    expect(data.slice(10)).toBe(
      `${"0".repeat(62)}20${"0".repeat(63)}5${"68656c6c6f".padEnd(64, "0")}`,
    );
  });

  test("a dynamic array carries its length before its items", () => {
    const data = encodeCall("sum(uint256[])", [[1n, 2n]]).slice(10);
    expect(data.length / 64).toBe(4);
    expect(data.slice(0, 64).endsWith("20")).toBe(true);
    expect(data.slice(64, 128).endsWith("2")).toBe(true);
  });

  test("fixed bytes are left-aligned and integers right-aligned", () => {
    // The classic way to produce a word a contract reads as a different
    // value entirely.
    expect(encodeCall("f(bytes4)", ["0xdeadbeef"]).slice(10)).toBe(`deadbeef${"0".repeat(56)}`);
    expect(encodeCall("g(uint32)", [0xdeadbeefn]).slice(10)).toBe(`${"0".repeat(56)}deadbeef`);
  });

  test("bare uint canonicalises to uint256, which is what the selector is hashed over", () => {
    expect(encodeCall("transfer(address,uint)", [VITALIK, 1n]).slice(0, 10)).toBe("0xa9059cbb");
    expect(parseType("uint").canonical).toBe("uint256");
    expect(parseType("int").canonical).toBe("int256");
  });

  test("a negative integer is two's complement, sign-extended", () => {
    expect(encodeCall("h(int256)", [-1n]).slice(10)).toBe("f".repeat(64));
    expect(encodeCall("h(int8)", [-1n]).slice(10)).toBe("f".repeat(64));
  });

  test("selectors match the ones every explorer shows", () => {
    expect(selectorOf("transfer(address,uint256)")).toBe("a9059cbb");
    expect(selectorOf("approve(address,uint256)")).toBe("095ea7b3");
    expect(selectorOf("balanceOf(address)")).toBe("70a08231");
  });

  test("tuples and nested arrays parse to their canonical form", () => {
    expect(parseType("(uint256,address)").canonical).toBe("(uint256,address)");
    expect(parseType("uint256[2][]").canonical).toBe("uint256[2][]");
    expect(parseType("uint256[2][]").dynamic).toBe(true);
    expect(parseType("uint256[2]").dynamic).toBe(false);
  });

  test("a function with no arguments is encodable", () => {
    expect(encodeCall("totalSupply()", [])).toBe(`0x${selectorOf("totalSupply()")}`);
    expect(parseSignature("totalSupply()").types).toEqual([]);
  });

  test("values that do not fit are refused rather than truncated", () => {
    expect(() => encodeCall("f(uint8)", [256n])).toThrow(/does not fit in a uint8/);
    expect(() => encodeCall("f(uint256)", [-1n])).toThrow(/negative/);
    expect(() => encodeCall("f(int8)", [128n])).toThrow(/does not fit in an int8/);
    expect(() => encodeCall("f(address)", ["0x1234"])).toThrow(/0x followed by 40 hex characters/);
    expect(() => encodeCall("f(bytes4)", ["0xdead"])).toThrow(/needs 4 bytes/);
  });

  test("a number past the safe integer range is refused, not silently rounded", () => {
    // By the time it arrives it has already lost its low bits, and a uint256
    // read as a double loses everything under about nine quadrillion wei.
    expect(() => encodeCall("f(uint256)", [2 ** 60])).toThrow(/already lost precision/);
  });

  test("a type the codec does not know is named rather than guessed", () => {
    expect(() => parseType("uint257")).toThrow(/multiple of 8/);
    expect(() => parseType("bytes33")).toThrow(/1 to 32/);
    expect(() => parseType("widget")).toThrow(/not an ABI type/);
  });

  test("an argument count mismatch is caught before anything is encoded", () => {
    expect(() => encodeCall("transfer(address,uint256)", [VITALIK])).toThrow(/takes 2 argument/);
  });
});

describe("an address is checked where it is encoded, not only by AddressCheck (C132)", () => {
  // EIP-55's own vector, and the same address with its last letter's case flipped.
  const GOOD = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
  const TYPO = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD";

  test("a mixed-case address whose checksum fails is refused, not encoded", () => {
    expect(validateAddress(TYPO).valid).toBe(false);
    expect(() => encodeCall("transfer(address,uint256)", [TYPO, 1n])).toThrow(
      "argument[0]: the EIP-55 checksum does not match — at least one character is wrong",
    );
    // Nested: an address inside a tuple inside an array.
    expect(() =>
      encodeCall("f((address,uint256)[])", [
        [
          [GOOD, 1n],
          [TYPO, 2n],
        ],
      ]),
    ).toThrow(/argument\[0\]\[1\]\[0\]: the EIP-55 checksum does not match/);
  });

  test("an address without its 0x, or with 0X, is refused as AddressCheck refuses it", () => {
    expect(() => encodeCall("f(address)", [GOOD.slice(2)])).toThrow(/an address starts with 0x/);
    expect(() => encodeCall("f(address)", [`0X${GOOD.slice(2)}`])).toThrow(
      /starts with a lowercase 0x; this starts with 0X/,
    );
    expect(() => encodeCall("f(address)", [42])).toThrow(/an address is a 0x hex string/);
  });

  test("a good checksum, all-lowercase and all-uppercase hex encode to the same calldata", () => {
    const want = encodeCall("f(address)", [GOOD]);
    expect(encodeCall("f(address)", [GOOD.toLowerCase()])).toBe(want);
    expect(encodeCall("f(address)", [`0x${GOOD.slice(2).toUpperCase()}`])).toBe(want);
  });

  test("TypedDataHash refuses the typo in a message field and in verifyingContract", () => {
    const types = { Mail: [{ name: "to", type: "address" }] };
    const digest = (domain: Record<string, unknown>, to: string) =>
      typedDataDigest({ name: "T", chainId: 1, ...domain }, types, "Mail", { to }).digest;
    expect(() => digest({}, TYPO)).toThrow(/Mail\.to\[0\]: the EIP-55 checksum does not match/);
    expect(() => digest({ verifyingContract: TYPO }, GOOD)).toThrow(
      /EIP712Domain\.verifyingContract\[0\]: the EIP-55 checksum does not match/,
    );
    // The refusal is about the value, not reported as an unknown type.
    expect(() => digest({}, TYPO)).not.toThrow(/neither a struct/);
    expect(digest({ verifyingContract: GOOD.toLowerCase() }, GOOD)).toBe(
      digest({ verifyingContract: GOOD }, GOOD.toLowerCase()),
    );
  });
});

describe("EIP-712 bytes are read by the coder's strict decoder (C133)", () => {
  const types = { Blob: [{ name: "data", type: "bytes" }] };
  const digest = (data: unknown) =>
    typedDataDigest({ name: "T", chainId: 1 }, types, "Blob", { data }).digest;

  test("an odd number of hex digits is refused, not hashed without its last nibble", () => {
    // 0.7.0: 0xabc, 0xabd and 0xab all gave one digest, and 0xa hashed as 0x.
    expect(() => digest("0xabc")).toThrow("Blob.data has an odd number of hex digits");
    expect(() => digest("0xa")).toThrow(/odd number of hex digits/);
    expect(() => digest("0xzz")).toThrow(/is not hex/);
  });

  test("a number is refused rather than read as hex digits", () => {
    expect(() => digest(4660)).toThrow("Blob.data: bytes are a 0x hex string, not a number");
    expect(() => digest([1, 2])).toThrow(/not a object/);
    // The ABI coder refuses the same, for bytes and bytesN.
    expect(() => encodeCall("f(bytes)", [4660])).toThrow(/bytes are a 0x hex string/);
    expect(() => encodeCall("f(bytes2)", [4660])).toThrow(/bytes are a 0x hex string/);
  });

  test("well-formed bytes still hash, case-insensitively, and distinctly", () => {
    expect(digest("0xab")).toBe(digest("0xAB"));
    expect(digest("0xab")).not.toBe(digest("0xabcd"));
    expect(digest("0x")).not.toBe(digest("0x00"));
  });
});

describe("ABI decoding", () => {
  test("a round trip returns what went in", () => {
    const data = encodeCall("t(address,uint256,string,bool)", [VITALIK, 42n, "hi", true]);
    expect(decodeData(["address", "uint256", "string", "bool"], `0x${data.slice(10)}`)).toEqual([
      VITALIK.toLowerCase(),
      "42",
      "hi",
      true,
    ]);
  });

  test("a uint256 comes back as a string, so it survives JSON", () => {
    const big = (2n ** 200n).toString(16).padStart(64, "0");
    expect(decodeData(["uint256"], `0x${big}`)).toEqual([(2n ** 200n).toString()]);
  });

  test("a signed integer decodes negative", () => {
    expect(decodeData(["int256"], `0x${"f".repeat(64)}`)).toEqual(["-1"]);
  });

  test("data that ends early is an error, not a short answer", () => {
    expect(() => decodeData(["uint256", "uint256"], "0x00")).toThrow(/truncated or mistyped/);
  });

  test("a bool word holding something other than 0 or 1 is rejected", () => {
    expect(() => decodeData(["bool"], `0x${"0".repeat(63)}2`)).toThrow(/neither true nor false/);
  });

  test("odd-length or non-hex data is rejected", () => {
    expect(() => decodeData(["uint256"], "0xabc")).toThrow(/odd number of hex/);
    expect(() => decodeData(["uint256"], "0xzz")).toThrow(/not hex/);
  });
});

describe("a word that is not the encoding of its type is refused (C209)", () => {
  /** One word from hex digits, left-padded to 64. */
  const w = (hex: string): string => `0x${hex.padStart(64, "0")}`;

  test("a uint word must fit its width", () => {
    expect(() => decodeData(["uint8"], w("100"))).toThrow(
      "value[0]: a uint8 word holds 256, which does not fit in 8 bits",
    );
    // The common mistake the check exists for: a uint256 slot read as uint8.
    expect(() => decodeData(["uint8"], w((10n ** 18n).toString(16)))).toThrow(/uint8/);
    expect(decodeData(["uint8"], w("ff"))).toEqual(["255"]);
    expect(decodeData(["uint64"], w("f".repeat(16)))).toEqual([(2n ** 64n - 1n).toString()]);
    expect(() => decodeData(["uint64"], w(`1${"0".repeat(16)}`))).toThrow(/uint64/);
  });

  test("an int word must be the sign extension of its low bits", () => {
    expect(() => decodeData(["int8"], w("80"))).toThrow(
      "value[0]: the word is not a sign-extended int8",
    );
    expect(() => decodeData(["int8"], w("100"))).toThrow(/sign-extended int8/);
    expect(() => decodeData(["int8"], `0x${"f".repeat(60)}0080`)).toThrow(/sign-extended/);
    expect(decodeData(["int8"], `0x${"f".repeat(62)}80`)).toEqual(["-128"]);
    expect(decodeData(["int8"], w("7f"))).toEqual(["127"]);
    expect(decodeData(["int8"], `0x${"f".repeat(64)}`)).toEqual(["-1"]);
  });

  test("an address word must have zero upper bytes", () => {
    expect(() => decodeData(["address"], `0x${"ff".repeat(12)}${"11".repeat(20)}`)).toThrow(
      "value[0]: an address word has non-zero upper bytes (0xffffffffffffffffffffffff)",
    );
    expect(decodeData(["address"], `0x${"00".repeat(12)}${"11".repeat(20)}`)).toEqual([
      `0x${"11".repeat(20)}`,
    ]);
  });

  test("a bytesN word must have zero padding after its bytes", () => {
    expect(() => decodeData(["bytes4"], `0xdeadbeef${"ab".repeat(28)}`)).toThrow(
      "value[0]: a bytes4 word has non-zero padding after its 4 bytes",
    );
    expect(decodeData(["bytes4"], `0xdeadbeef${"00".repeat(28)}`)).toEqual(["0xdeadbeef"]);
    expect(decodeData(["bytes32"], `0x${"ab".repeat(32)}`)).toEqual([`0x${"ab".repeat(32)}`]);
  });

  test("the check reaches inside arrays and tuples, and names the element", () => {
    const pad = (hex: string): string => hex.padStart(64, "0");
    expect(() => decodeData(["uint8[2]"], `0x${pad("1")}${pad("10000")}`)).toThrow(
      /^value\[0\]\[1\]: a uint8 word/,
    );
    expect(() => decodeData(["(uint256,address)"], `0x${pad("1")}${"ff".repeat(32)}`)).toThrow(
      /^value\[0\]\[1\]: an address word/,
    );
  });

  test("the widest types take every word, at their extremes", () => {
    const max = (2n ** 256n - 1n).toString(16);
    expect(decodeData(["uint256"], w(max))).toEqual([(2n ** 256n - 1n).toString()]);
    expect(decodeData(["int256"], w(`8${"0".repeat(63)}`))).toEqual([(-(2n ** 255n)).toString()]);
    expect(decodeData(["int256"], w(`7${"f".repeat(63)}`))).toEqual([(2n ** 255n - 1n).toString()]);
  });

  test("whatever the encoder writes, the decoder reads back", () => {
    const cases: Array<[string, unknown]> = [
      ["uint8", 255n],
      ["uint16", 65535n],
      ["uint64", 2n ** 64n - 1n],
      ["uint256", 2n ** 256n - 1n],
      ["int8", -128n],
      ["int8", 127n],
      ["int64", -(2n ** 63n)],
      ["int256", -1n],
      ["int256", 2n ** 255n - 1n],
      ["address", VITALIK],
      ["bytes1", "0xab"],
      ["bytes4", "0xdeadbeef"],
      ["bytes32", `0x${"cd".repeat(32)}`],
      ["bool", true],
      ["bool", false],
    ];
    for (const [type, value] of cases) {
      const data = `0x${encodeCall(`f(${type})`, [value as never]).slice(10)}`;
      const expected =
        typeof value === "bigint"
          ? value.toString()
          : typeof value === "string"
            ? value.toLowerCase()
            : value;
      expect({ type, decoded: decodeData([type], data)[0] }).toEqual({ type, decoded: expected });
    }
  });
});

/** One ABI word holding `n`. */
const word = (n: number | bigint): string => BigInt(n).toString(16).padStart(64, "0");

/**
 * `uint256` nested `depth` arrays deep, where every level's `w` heads point at
 * ONE shared child: `w^depth` values from about `depth * (w + 1)` words. No
 * encoder writes this; a hostile contract's return data can.
 */
function sharedOffsets(depth: number, w: number): string {
  let hex = word(32);
  for (let level = 1; level < depth; level++) hex += word(w) + word(w * 32).repeat(w);
  return `0x${hex}${word(w)}${word(7).repeat(w)}`;
}

describe("ABI decoding cannot be made to inflate (C085)", () => {
  test("heads that share one tail are refused, not decoded again and again", () => {
    // 196 words that decode to 262,144 values on 0.7.0.
    const data = sharedOffsets(3, 64);
    expect(data.length).toBeLessThan(13_000);
    expect(() => decodeData(["uint256[][][]"], data)).toThrow(
      /decodes to more than 4 times its own size — its offsets point at the same bytes/,
    );
  });

  test("a hundred strings sharing one 10,000-byte tail are refused", () => {
    const text = `${word(10_000)}${"61".repeat(10_000)}${"00".repeat(16)}`;
    const data = `0x${word(32)}${word(100)}${word(100 * 32).repeat(100)}${text}`;
    expect(() => decodeData(["string[]"], data)).toThrow(/decodes to more than 4 times/);
  });

  test("a batch whose rows share one revert blob is a batch-level refusal", () => {
    // (bool,bytes)[] with 1,000 rows: every row's head points at one row,
    // whose bytes point at one 4 KB blob.
    const rows = 1_000;
    const row = `${word(1)}${word(64)}${word(4096)}${"ab".repeat(4096)}`;
    const data = `0x${word(32)}${word(rows)}${word(rows * 32).repeat(rows)}${row}`;
    expect(() => decodeAggregate3(data, rows)).toThrow(
      /^the batch's own return data is not \(bool,bytes\)\[\].*decodes to more than 4 times/,
    );
  });

  test("a length the data cannot hold is refused before anything is allocated", () => {
    // 0.7.0 built a 20,000,000-slot array from the type string first, then
    // failed on the empty data.
    expect(() => decodeData(["uint256[20000000]"], "0x")).toThrow(
      "value[0]: claims 20000000 items, more than the data could hold",
    );
    expect(() => decodeData(["uint256[4294967295]"], "0x")).toThrow(/claims 4294967295 items/);
    // A dynamic length is checked against what follows its own offset, not
    // against the whole blob.
    const data = `0x${word(64)}${word(0)}${word(3)}${word(1)}${word(2)}`;
    expect(() => decodeData(["uint256[]"], data)).toThrow(/claims 3 items/);
    expect(() => decodeData(["(uint256[1000000])[1000000]"], "0x")).toThrow(/claims 1000000 items/);
  });

  test("an array of a type that takes no bytes cannot claim a length", () => {
    expect(() => decodeData(["()[]"], `0x${word(32)}${word(1_000_000_000)}`)).toThrow(
      /an array of \(\) holds nothing the data can back/,
    );
  });

  test("an empty tuple is refused, so a type string cannot multiply the data (C085)", () => {
    // Each item is ONE word of data, but the type gives it 2,700 components
    // that read nothing: 0.7.1's first cut decoded 2,000 words to 5.4M values.
    const type = `(${"(),".repeat(2_700)}uint256)[]`;
    expect(type.length).toBeLessThan(8192);
    const items = 250;
    const data = `0x${word(32)}${word(items)}${word(1).repeat(items)}`;
    expect(() => decodeData([type], data)).toThrow(
      "value[0][0][0]: () is an empty tuple — no Solidity type is one, and it decodes from no bytes, so nothing in the data can back it",
    );
    expect(() => decodeData(["()"], "0x")).toThrow(/\(\) is an empty tuple/);
    expect(() => decodeData(["(uint256,())"], `0x${word(1)}`)).toThrow(/\(\) is an empty tuple/);
  });

  test("a decode yields at most as many values as its words could hold for its types", () => {
    // Every head of an outer array points at ONE inner array of two
    // `uint256[1]` items. That reads three words per item (within the word
    // budget) but yields five values per item from a single word of heads.
    const heads = 400;
    const data = `0x${word(32)}${word(heads)}${word(heads * 32).repeat(heads)}${word(2)}${word(7)}${word(8)}`;
    expect(() => decodeData(["uint256[1][][]"], data)).toThrow(
      /^value\[0\]\[\d+\]\[\d+\]\[0\]: the data decodes to more than 1620 values, more than its size can hold for these types when each word is read once .* Refusing to inflate it\.$/,
    );
    // The same shape with each head pointing at its own inner array decodes.
    const honest = [
      Array.from({ length: heads }, (_, i) => [[String(i)], [String(i + 1)]]),
    ] as const;
    const hex = `0x${encodeCall("f(uint256[1][][])", [...honest]).slice(10)}`;
    expect(decodeData(["uint256[1][][]"], hex)).toEqual([...honest]);
  });

  // Slow by construction (it decodes the largest honest encodings; 2.3 s on CI's loaded runner).
  test("honest encodings, however large, still decode exactly", () => {
    const square = Array.from({ length: 200 }, (_, i) =>
      Array.from({ length: 200 }, (_, j) => String(i * 200 + j)),
    );
    const t = parseType("uint256[][]");
    const hex = `0x${encodeCall("f(uint256[][])", [square]).slice(10)}`;
    expect(decodeData([t.canonical], hex)).toEqual([square]);
    const strings = Array.from({ length: 300 }, (_, i) => "x".repeat(i));
    const packed = `0x${encodeCall("f(string[],bytes[2])", [strings, ["0xabcd", "0x"]]).slice(10)}`;
    expect(decodeData(["string[]", "bytes[2]"], packed)).toEqual([strings, ["0xabcd", "0x"]]);
  }, 20_000);
});

describe("type strings are parsed in linear time (C085)", () => {
  test("nesting past the depth limit is refused, at any length", () => {
    expect(() => parseType(`uint256${"[1]".repeat(33)}`)).toThrow(/more than 32 levels deep/);
    expect(() => parseType(`${"(".repeat(40)}uint256${")".repeat(40)}`)).toThrow(
      /more than 32 levels deep/,
    );
    expect(parseType(`uint256${"[1]".repeat(32)}`).canonical).toEndWith("[1]");
  });

  test("a type or signature longer than the cap is refused before it is scanned", () => {
    const long = `(${Array.from({ length: 1200 }, () => "uint256").join(",")})`;
    expect(long.length).toBeGreaterThan(8192);
    expect(() => parseType(long)).toThrow(/characters is longer than the 8192 this reads/);
    expect(() => parseSignature(`f${long}`)).toThrow(/signature of \d+ characters/);
  });

  test("a fixed length past the safe-integer range is refused", () => {
    expect(() => parseType("uint256[99999999999999999999]")).toThrow(/too large to lay out/);
    expect(() => parseType("uint256[4294967295][4294967295]")).toThrow(/too large to lay out/);
  });
});

describe("EIP-712, against the specification's own example", () => {
  const types = {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Person: [
      { name: "name", type: "string" },
      { name: "wallet", type: "address" },
    ],
    Mail: [
      { name: "from", type: "Person" },
      { name: "to", type: "Person" },
      { name: "contents", type: "string" },
    ],
  };
  const domain = {
    name: "Ether Mail",
    version: "1",
    chainId: 1,
    verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
  };
  const message = {
    from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
    to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
    contents: "Hello, Bob!",
  };

  test("every published value matches", () => {
    const result = typedDataDigest(domain, types, "Mail", message);
    expect(result.encodedType).toBe(
      "Mail(Person from,Person to,string contents)Person(string name,address wallet)",
    );
    expect(result.typeHash).toBe(
      "0xa0cedeb2dc280ba39b857546d74f5549c3a1d7bdc2dd96bf881f76108e23dac2",
    );
    expect(result.domainSeparator).toBe(
      "0xf2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f",
    );
    expect(result.messageHash).toBe(
      "0xc52c0ee5d84264471806290a3f2c4cecfc5490626bf912d01f240d7a274b371e",
    );
    expect(result.digest).toBe(
      "0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2",
    );
  });

  test("referenced types are ordered alphabetically after the primary one", () => {
    // The order is part of the standard: a different order is a different
    // type hash and therefore a signature no verifier accepts.
    expect(encodeType("Mail", types)).toStartWith("Mail(");
    expect(encodeType("Mail", types)).toContain("Person(string name,address wallet)");
  });

  test("a domain field that is absent is left out of the separator", () => {
    const withChain = typedDataDigest(
      { name: "A", chainId: 1 },
      { T: [{ name: "x", type: "uint256" }] },
      "T",
      { x: 1 },
    );
    const withoutChain = typedDataDigest(
      { name: "A" },
      { T: [{ name: "x", type: "uint256" }] },
      "T",
      { x: 1 },
    );
    expect(withChain.domainSeparator).not.toBe(withoutChain.domainSeparator);
  });

  test("a message missing a declared field is refused rather than hashed as zero", () => {
    expect(() =>
      typedDataDigest(domain, types, "Mail", { from: message.from, to: message.to }),
    ).toThrow(/requires the field "contents"/);
  });

  test("a type that is referenced but not defined is named", () => {
    expect(() => encodeType("X", { X: [{ name: "a", type: "Missing" }] })).not.toThrow();
    expect(() =>
      typedDataDigest({}, { X: [{ name: "a", type: "Missing" }] }, "X", { a: {} }),
    ).toThrow(/neither a struct defined in types nor an ABI type/);
  });

  test("changing one character of the message changes the digest", () => {
    const a = typedDataDigest(domain, types, "Mail", message);
    const b = typedDataDigest(domain, types, "Mail", { ...message, contents: "Hello, Bob?" });
    expect(a.digest).not.toBe(b.digest);
  });
});

describe("EIP-712 types are checked once, before anything is hashed", () => {
  const domain = { name: "T", chainId: 1 };

  test("a struct referenced but never instantiated still has its field types checked", () => {
    // Q only appears inside an empty array, so no Q is ever hashed; its type
    // string went into the encoded type unexamined, and the digest came back.
    const types = {
      M: [{ name: "ps", type: "P[]" }],
      P: [{ name: "qs", type: "Q[]" }],
      Q: [{ name: "z", type: "[1][1]x" }],
    };
    expect(() => typedDataDigest(domain, types, "M", { ps: [{ qs: [] }] })).toThrow(
      /^Q\.z: "\[1\]\[1\]x" is neither a struct defined in types nor an ABI type/,
    );
  });

  test("a long type string is refused by its length, not scanned in the square of it", () => {
    // `(\[\d*\])+$` backtracked quadratically on this, once per struct
    // instance: about 120 KB of request blocked the event loop for 30 s.
    const long = `${"[1]".repeat(3_000)}x`;
    const types = {
      M: [{ name: "ps", type: "P[]" }],
      P: [{ name: "qs", type: "Q[]" }],
      Q: [{ name: "z", type: long }],
    };
    const message = { ps: Array.from({ length: 6 }, () => ({ qs: [] })) };
    expect(() => typedDataDigest(domain, types, "M", message)).toThrow(
      /^Q\.z: "\[1\]\[1\].*… \(9001 characters\)" is neither a struct .* longer than the 8192 this reads/,
    );
  });

  test("a struct array may nest no deeper than an ABI type", () => {
    const types = {
      M: [{ name: "p", type: `P${"[]".repeat(33)}` }],
      P: [{ name: "a", type: "uint8" }],
    };
    expect(() => typedDataDigest(domain, types, "M", { p: [] })).toThrow(
      /^M\.p: "P\[\]\[\].*" nests arrays more than 32 levels deep/,
    );
    const ok = {
      M: [{ name: "p", type: `P${"[]".repeat(32)}` }],
      P: [{ name: "a", type: "uint8" }],
    };
    expect(typedDataDigest(domain, ok, "M", { p: [] }).digest).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("a struct's type hash is computed once per digest, not once per instance", () => {
    // Every P re-encoded every struct P refers to, so a message of many small
    // instances cost its count times the size of the types. Counting the
    // reads of Q's field list shows the work does not grow with the count.
    let reads = 0;
    const qFields = new Proxy([{ name: "a", type: "uint256" }], {
      get(target, key, receiver) {
        if (key === "length") reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    const types = {
      M: [{ name: "ps", type: "P[]" }],
      P: [
        { name: "x", type: "uint8" },
        { name: "qs", type: "Q[]" },
      ],
      Q: qFields,
    };
    const readsFor = (count: number): number => {
      reads = 0;
      const message = { ps: Array.from({ length: count }, () => ({ x: 1, qs: [] })) };
      expect(typedDataDigest(domain, types, "M", message).digest).toMatch(/^0x[0-9a-f]{64}$/);
      return reads;
    };
    const one = readsFor(1);
    expect(one).toBeGreaterThan(0);
    expect(readsFor(50)).toBe(one);
  });

  test("array suffixes are read the same way the digest always read them", () => {
    // EIP-712's own example, with a fixed and a nested array added: the
    // encoded type is unchanged by the linear reader.
    const types = {
      Mail: [
        { name: "to", type: "Person[2]" },
        { name: "ids", type: "uint256[][1]" },
      ],
      Person: [{ name: "name", type: "string" }],
    };
    expect(encodeType("Mail", types)).toBe(
      "Mail(Person[2] to,uint256[][1] ids)Person(string name)",
    );
    const digest = typedDataDigest(domain, types, "Mail", {
      to: [{ name: "a" }, { name: "b" }],
      ids: [[1, 2]],
    });
    expect(digest.encodedType).toBe("Mail(Person[2] to,uint256[][1] ids)Person(string name)");
    expect(() =>
      typedDataDigest(domain, types, "Mail", { to: [{ name: "a" }], ids: [[1]] }),
    ).toThrow("Mail.to: expected 2 items, got 1");
  });
});

describe("EIP-712 reads only what the message and the types define (C210)", () => {
  const domain = { name: "X", version: "1", chainId: 1 };
  const INHERITED = ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"];

  test("a field every object inherits is still a missing field", () => {
    // 0.7.0 hashed Object.prototype.toString's source text for "toString".
    for (const name of INHERITED) {
      expect(() => typedDataDigest(domain, { M: [{ name, type: "string" }] }, "M", {})).toThrow(
        `"M" requires the field "${name}", which the message does not have`,
      );
    }
  });

  test("the same field, present in the message, is hashed as written", () => {
    const own = typedDataDigest(domain, { M: [{ name: "toString", type: "string" }] }, "M", {
      toString: "hi",
    });
    const plain = typedDataDigest(domain, { M: [{ name: "note", type: "string" }] }, "M", {
      note: "hi",
    });
    expect(own.digest).toMatch(/^0x[0-9a-f]{64}$/);
    // Same value, different field name: the type hash differs, so the digest does.
    expect(own.digest).not.toBe(plain.digest);
  });

  test("a type name every object inherits is not a struct nobody defined", () => {
    expect(() =>
      typedDataDigest(domain, { M: [{ name: "a", type: "constructor" }] }, "M", { a: {} }),
    ).toThrow(/M\.a: "constructor" is neither a struct defined in types nor an ABI type/);
    expect(() =>
      typedDataDigest(domain, { M: [{ name: "a", type: "string" }] }, "toString", {}),
    ).toThrow('the type "toString" is not defined');
  });

  test("a struct field whose value is not an object is refused by name", () => {
    const nested = {
      M: [{ name: "a", type: "P" }],
      P: [{ name: "b", type: "string" }],
    };
    expect(() => typedDataDigest(domain, nested, "M", { a: "str" })).toThrow(
      '"P" expects an object for its fields, got a string',
    );
    expect(() => typedDataDigest(domain, nested, "M", { a: null })).toThrow(/got null/);
    expect(() => typedDataDigest(domain, nested, "M", { a: [] })).toThrow(/got an array/);
  });

  test("a string field takes text, not an object printed as [object Object]", () => {
    expect(() =>
      typedDataDigest(domain, { M: [{ name: "s", type: "string" }] }, "M", { s: { x: 1 } }),
    ).toThrow("M.s: a string field takes text, not an object");
    // A number still reads as the text it prints as.
    expect(
      typedDataDigest(domain, { M: [{ name: "s", type: "string" }] }, "M", { s: 42 }).digest,
    ).toBe(
      typedDataDigest(domain, { M: [{ name: "s", type: "string" }] }, "M", { s: "42" }).digest,
    );
  });
});

describe("EIP-191", () => {
  test("personal_sign matches the known vector", () => {
    expect(personalSignHash("Hello, world!")).toBe(
      "0xb453bd4e271eed985cbab8231da609c4ce0a9cf1f763b6c1594e76315510e0f1",
    );
  });

  test("the length is the byte length, not the character count", () => {
    // A message with any non-ASCII character hashes differently if the
    // prefix counts characters.
    expect(personalSignHash("é")).not.toBe(personalSignHash("e"));
  });
});

describe("EIP-55 addresses", () => {
  test("the specification's checksummed examples round-trip", () => {
    for (const address of [
      "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
      "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
      "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
    ]) {
      expect({ address, checksummed: toChecksumAddress(address) }).toEqual({
        address,
        checksummed: address,
      });
      expect({ address, valid: validateAddress(address).valid }).toEqual({ address, valid: true });
    }
  });

  test("a single wrong character in a checksummed address is caught", () => {
    const result = validateAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96046");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("checksum does not match");
  });

  test("an all-lowercase address is valid but says it could not be verified", () => {
    // The distinction matters: `valid` here does not mean "no typo".
    const result = validateAddress("0xd8da6bf26964af9d7eed9e03e53415d37aa96045");
    expect(result.valid).toBe(true);
    expect(result.hadChecksum).toBe(false);
    expect(result.reason).toContain("cannot be detected");
    expect(result.checksummed).toBe(VITALIK);
  });

  test("shape problems are named", () => {
    expect(validateAddress("0x1234").reason).toContain("40 hex characters");
    expect(validateAddress("d8da6bf26964af9d7eed9e03e53415d37aa96045").reason).toContain(
      "starts with 0x",
    );
  });

  test("the zero address is flagged", () => {
    expect(validateAddress(`0x${"0".repeat(40)}`).isZero).toBe(true);
  });
});

describe("units", () => {
  test("decimals convert exactly, in both directions", () => {
    expect(parseUnits("0.1", 18)).toBe(100000000000000000n);
    expect(parseUnits("1", 18)).toBe(10n ** 18n);
    expect(parseUnits("1234.5678", 6)).toBe(1234567800n);
    expect(formatUnits(100000000000000000n, 18)).toBe("0.1");
    expect(formatUnits(10n ** 18n, 18)).toBe("1");
    expect(formatUnits(1n, 18)).toBe("0.000000000000000001");
    expect(formatUnits(0n, 18)).toBe("0");
  });

  test("a wei amount survives that a double would round away", () => {
    // The hazard is not that every conversion is wrong — it is that values
    // at this scale lose their low digits the moment they become a double,
    // and a balance one wei apart becomes the same number.
    const exact = "1000000000000000001";
    expect(parseUnits("1.000000000000000001", 18).toString()).toBe(exact);
    expect(Number(exact).toString()).not.toBe(exact);
    expect(Number(exact)).toBe(Number("1000000000000000000"));
  });

  test("negative amounts round-trip", () => {
    expect(formatUnits(parseUnits("-1.5", 18), 18)).toBe("-1.5");
  });

  test("more decimal places than the unit has is refused", () => {
    expect(() => parseUnits("0.1234567", 6)).toThrow(/would be silently dropped/);
  });

  test("a non-numeric amount is refused", () => {
    expect(() => parseUnits("abc", 18)).toThrow(/not a decimal amount/);
    expect(() => parseUnits("", 18)).toThrow(/not a decimal amount/);
  });

  test("rescaling between decimalisations is exact or refused", () => {
    expect(rescaleDecimals(1_000_000n, 6, 18)).toBe("1000000000000000000");
    expect(rescaleDecimals(10n ** 18n, 18, 6)).toBe("1000000");
    expect(() => rescaleDecimals(10n ** 18n + 1n, 18, 6)).toThrow(/discarding/);
  });
});

describe("DeFi maths", () => {
  test("a minimum is rounded DOWN and a maximum UP", () => {
    // A bound rounded the wrong way rejects a swap that was inside tolerance,
    // or accepts one that was not.
    expect(minimumOut(10n ** 18n, 50).minOut).toBe("995000000000000000");
    expect(minimumOut(1_999n, 1).minOut).toBe("1998");
    expect(maximumIn(1_999n, 1)).toBe("2000");
  });

  test("zero slippage changes nothing", () => {
    expect(minimumOut(12_345n, 0).minOut).toBe("12345");
    expect(maximumIn(12_345n, 0)).toBe("12345");
  });

  test("slippage outside 0 to 10000 basis points is refused", () => {
    expect(() => minimumOut(1n, -1)).toThrow(/0 to 10000/);
    expect(() => minimumOut(1n, 10_001)).toThrow(/0 to 10000/);
    expect(() => minimumOut(1n, 1.5)).toThrow(/integer/);
  });

  test("price impact is signed against the reference", () => {
    expect(priceImpactBps(99n, 100n)).toBe(100);
    expect(priceImpactBps(101n, 100n)).toBe(-100);
    expect(() => priceImpactBps(1n, 0n)).toThrow(/must be positive/);
  });

  test("a share is basis points of the total", () => {
    expect(shareBps(1n, 4n)).toBe(2_500);
    expect(() => shareBps(1n, 0n)).toThrow(/must be positive/);
  });

  test("no debt has no health factor, rather than an infinite one", () => {
    // Infinity would be read as safe by a caller comparing to a threshold,
    // and NaN as unsafe, both by accident.
    expect(healthFactorBps(1_000n, 0n, 8_000)).toBeNull();
    expect(healthFactorBps(1_000n, 1_000n, 8_000)).toBe(8_000);
    expect(healthFactorBps(2_000n, 1_000n, 8_000)).toBe(16_000);
  });
});

/**
 * Multicall3, against encodings derived by hand from the ABI specification.
 *
 * The argument is an array of dynamic tuples, which is the shape with the
 * most ways to be plausibly wrong: an offset relative to the wrong base, a
 * length word in the wrong place, an empty `bytes` that does or does not
 * carry a padding word. Every vector below is written out word by word, so a
 * change in any of those is a diff and not a passing test.
 */
const EMPTY_BATCH = [
  // head: the array is dynamic, so its one head word is an offset
  "0000000000000000000000000000000000000000000000000000000000000020",
  // the array's length: zero, and nothing after it
  "0000000000000000000000000000000000000000000000000000000000000000",
].join("");

const ONE_CALL = [
  "0000000000000000000000000000000000000000000000000000000000000020",
  // one element
  "0000000000000000000000000000000000000000000000000000000000000001",
  // the element is a dynamic tuple, so the array's head holds its offset —
  // relative to the start of the array's DATA, which is this word, not to
  // the start of the call
  "0000000000000000000000000000000000000000000000000000000000000020",
  // target, right-aligned in its word
  "000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045",
  // allowFailure = true
  "0000000000000000000000000000000000000000000000000000000000000001",
  // offset of `callData` within the tuple: three head words
  "0000000000000000000000000000000000000000000000000000000000000060",
  // callData length, then the bytes LEFT-aligned in their word
  "0000000000000000000000000000000000000000000000000000000000000004",
  "18160ddd00000000000000000000000000000000000000000000000000000000",
].join("");

const TWO_CALLS = [
  "0000000000000000000000000000000000000000000000000000000000000020",
  "0000000000000000000000000000000000000000000000000000000000000002",
  // two element offsets: the first past both of them, the second past the
  // first element's five words
  "0000000000000000000000000000000000000000000000000000000000000040",
  "00000000000000000000000000000000000000000000000000000000000000e0",
  // element 0: target, allowFailure = true, offset, length 1, one byte
  "0000000000000000000000000000000000000000000000000000000000000001",
  "0000000000000000000000000000000000000000000000000000000000000001",
  "0000000000000000000000000000000000000000000000000000000000000060",
  "0000000000000000000000000000000000000000000000000000000000000001",
  "1100000000000000000000000000000000000000000000000000000000000000",
  // element 1: target, allowFailure = FALSE, offset, and an empty `bytes`,
  // which is a length word and no padding word after it
  "0000000000000000000000000000000000000000000000000000000000000002",
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0000000000000000000000000000000000000000000000000000000000000060",
  "0000000000000000000000000000000000000000000000000000000000000000",
].join("");

/** `revert("insufficient balance")` as a contract returns it. */
const ERROR_INSUFFICIENT = `${ERROR_STRING_SELECTOR}${[
  "0000000000000000000000000000000000000000000000000000000000000020",
  "0000000000000000000000000000000000000000000000000000000000000014",
  "696e73756666696369656e742062616c616e6365000000000000000000000000",
].join("")}`;

/** Three results, the middle one reverted: `(bool,bytes)[]` as returned. */
const THREE_RESULTS = `0x${[
  "0000000000000000000000000000000000000000000000000000000000000020",
  "0000000000000000000000000000000000000000000000000000000000000003",
  // three element offsets, relative to the word after the length
  "0000000000000000000000000000000000000000000000000000000000000060",
  "00000000000000000000000000000000000000000000000000000000000000e0",
  "00000000000000000000000000000000000000000000000000000000000001c0",
  // [0] success, 32 bytes of return data holding 42
  "0000000000000000000000000000000000000000000000000000000000000001",
  "0000000000000000000000000000000000000000000000000000000000000040",
  "0000000000000000000000000000000000000000000000000000000000000020",
  "000000000000000000000000000000000000000000000000000000000000002a",
  // [1] FAILED, carrying 0x64 bytes of Error(string) revert data
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0000000000000000000000000000000000000000000000000000000000000040",
  "0000000000000000000000000000000000000000000000000000000000000064",
  "08c379a000000000000000000000000000000000000000000000000000000000",
  "0000002000000000000000000000000000000000000000000000000000000000",
  "00000014696e73756666696369656e742062616c616e63650000000000000000",
  "0000000000000000000000000000000000000000000000000000000000000000",
  // [2] success, no return data at all
  "0000000000000000000000000000000000000000000000000000000000000001",
  "0000000000000000000000000000000000000000000000000000000000000040",
  "0000000000000000000000000000000000000000000000000000000000000000",
].join("")}`;

describe("Multicall3 request packing", () => {
  test("the selectors are the four bytes an explorer shows", () => {
    expect(`0x${selectorOf(AGGREGATE3_SIGNATURE)}`).toBe(AGGREGATE3_SELECTOR);
    expect(AGGREGATE3_SELECTOR).toBe("0x82ad56cb");
    expect(`0x${selectorOf("Error(string)")}`).toBe(ERROR_STRING_SELECTOR);
    expect(`0x${selectorOf("Panic(uint256)")}`).toBe(PANIC_SELECTOR);
  });

  test("the canonical address carries an EIP-55 checksum that verifies", () => {
    // The address is mixed case, so a typo in the constant is catchable —
    // and this is the one constant nobody would notice being one nibble off.
    const checked = validateAddress(MULTICALL3_ADDRESS);
    expect({ valid: checked.valid, hadChecksum: checked.hadChecksum }).toEqual({
      valid: true,
      hadChecksum: true,
    });
    expect(checked.checksummed).toBe(MULTICALL3_ADDRESS);
  });

  test("an empty batch encodes to an empty array, not to nothing", () => {
    const packed = encodeAggregate3([]);
    expect(packed.data).toBe(`${AGGREGATE3_SELECTOR}${EMPTY_BATCH}`);
    expect(packed.callCount).toBe(0);
  });

  test("a single call encodes byte for byte", () => {
    const packed = encodeAggregate3([{ target: VITALIK, callData: "0x18160ddd" }]);
    expect(packed.data).toBe(`${AGGREGATE3_SELECTOR}${ONE_CALL}`);
    expect(packed.callCount).toBe(1);
  });

  test("allowFailure defaults to true, and false is a zero word", () => {
    const packed = encodeAggregate3([
      { target: "0x0000000000000000000000000000000000000001", callData: "0x11" },
      {
        target: "0x0000000000000000000000000000000000000002",
        callData: "0x",
        allowFailure: false,
      },
    ]);
    expect(packed.data).toBe(`${AGGREGATE3_SELECTOR}${TWO_CALLS}`);
  });

  test("the Multicall3 address is an argument, defaulting to the canonical one", () => {
    // The deterministic deploy is at the same address on most chains, which
    // is not the same as all of them.
    expect(encodeAggregate3([]).to).toBe(MULTICALL3_ADDRESS);
    const elsewhere = encodeAggregate3([], "0x1111111111111111111111111111111111111111");
    expect(elsewhere.to).toBe("0x1111111111111111111111111111111111111111");
    // The calldata does not depend on where it is sent.
    expect(elsewhere.data).toBe(encodeAggregate3([]).data);
  });

  test("a malformed target or address is refused, with which one it was", () => {
    expect(() => encodeAggregate3([], "0xnothex")).toThrow(/Multicall3 address/);
    expect(() => encodeAggregate3([{ target: "0x01", callData: "0x" }])).toThrow(
      /call\[0\]\.target/,
    );
    expect(() => encodeAggregate3([{ target: VITALIK, callData: "0x123" }])).toThrow(
      /call\[0\]\.callData/,
    );
  });
});

describe("Multicall3 result unpacking", () => {
  test("a reverted sub-call is a row, not an exception", () => {
    const results = decodeAggregate3(THREE_RESULTS, 3);
    expect(results.map((r) => r.success)).toEqual([true, false, true]);
    expect(results.map((r) => r.index)).toEqual([0, 1, 2]);
  });

  test("order and per-call data survive, including the empty one", () => {
    const [first, second, third] = decodeAggregate3(THREE_RESULTS, 3);
    expect(first?.returnData).toBe(`0x${"0".repeat(62)}2a`);
    expect(first?.revert).toBeNull();
    expect(second?.returnData).toBe(ERROR_INSUFFICIENT);
    expect(third?.returnData).toBe("0x");
  });

  test("the middle call's revert decodes to its reason", () => {
    const [, failed] = decodeAggregate3(THREE_RESULTS, 3);
    expect(failed?.revert).toEqual({
      kind: "string",
      reason: "insufficient balance",
      selector: ERROR_STRING_SELECTOR,
      panicCode: null,
      data: ERROR_INSUFFICIENT,
    });
  });

  test("an empty batch decodes to no results", () => {
    expect(decodeAggregate3(`0x${EMPTY_BATCH}`, 0)).toEqual([]);
  });

  test("the packed batch's own callCount is what the answer is checked against", () => {
    // The pairing a caller actually writes: pack, send, unpack against the
    // count that was packed.
    const packed = encodeAggregate3([
      { target: VITALIK, callData: "0x18160ddd" },
      { target: VITALIK, callData: "0x18160ddd" },
      { target: VITALIK, callData: "0x18160ddd" },
    ]);
    expect(decodeAggregate3(THREE_RESULTS, packed.callCount).map((r) => r.success)).toEqual([
      true,
      false,
      true,
    ]);
  });

  test("a result count that differs from the batch is refused, not truncated", () => {
    // Results are matched by POSITION, so a short answer zipped against the
    // calls attributes every result after the gap to the wrong call.
    expect(() => decodeAggregate3(THREE_RESULTS, 2)).toThrow(
      /3 result\(s\) for 2 call\(s\).*matched by position/s,
    );
    expect(() => decodeAggregate3(THREE_RESULTS, 4)).toThrow(/3 result\(s\) for 4 call\(s\)/);
    expect(() => decodeAggregate3(THREE_RESULTS, -1)).toThrow(/non-negative integer/);
  });

  test("an unreadable blob is reported as the BATCH failing, not a sub-call", () => {
    // The distinction is the whole point: this is a wrong address or a
    // reverted aggregate, and there are no partial results to look at.
    expect(() => decodeAggregate3("0x", 1)).toThrow(/batch's own return data/);
    expect(() => decodeAggregate3(`0x${"00".repeat(31)}`, 1)).toThrow(/batch's own return data/);
  });
});

describe("revert data", () => {
  test("Error(string) gives the reason a human was shown", () => {
    expect(decodeRevertData(ERROR_INSUFFICIENT).reason).toBe("insufficient balance");
    expect(decodeRevertData(ERROR_INSUFFICIENT).kind).toBe("string");
    // Hex pasted out of an explorer arrives mixed-case, and a selector
    // compared without normalising would fall through to "unknown".
    expect(decodeRevertData(ERROR_INSUFFICIENT.toUpperCase().replace("0X", "0x")).kind).toBe(
      "string",
    );
  });

  test("Panic(uint256) gives the documented meaning of its code", () => {
    const panic = decodeRevertData(`${PANIC_SELECTOR}${"0".repeat(62)}11`);
    expect({ kind: panic.kind, code: panic.panicCode }).toEqual({
      kind: "panic",
      code: "0x11",
    });
    expect(panic.reason).toMatch(/overflow/);
    // A code outside the documented table keeps the code and gets no meaning.
    const unlisted = decodeRevertData(`${PANIC_SELECTOR}${"0".repeat(62)}99`);
    expect({ kind: unlisted.kind, code: unlisted.panicCode, reason: unlisted.reason }).toEqual({
      kind: "panic",
      code: "0x99",
      reason: null,
    });
  });

  test("an unknown selector stays hex rather than acquiring a message", () => {
    const custom = `0xdeadbeef${"0".repeat(63)}1`;
    expect(decodeRevertData(custom)).toEqual({
      kind: "unknown",
      reason: null,
      selector: "0xdeadbeef",
      panicCode: null,
      data: custom,
    });
  });

  test("empty revert data is its own kind, with no invented reason", () => {
    // A bare revert(), a call to an address with no code, an out-of-gas.
    expect(decodeRevertData("0x")).toEqual({
      kind: "none",
      reason: null,
      selector: null,
      panicCode: null,
      data: "0x",
    });
    // Too short to hold a selector, so it does not get one.
    expect(decodeRevertData("0xdead").selector).toBeNull();
  });

  test("a malformed Error(string) payload degrades to hex instead of throwing", () => {
    // Throwing here would lose the other results in the same batch over one
    // contract's bad revert data.
    const lying = `${ERROR_STRING_SELECTOR}${"0".repeat(62)}20${"0".repeat(62)}ff`;
    const decoded = decodeRevertData(lying);
    expect({ kind: decoded.kind, reason: decoded.reason, selector: decoded.selector }).toEqual({
      kind: "unknown",
      reason: null,
      selector: ERROR_STRING_SELECTOR,
    });
  });

  test("revert data that is not hex is refused", () => {
    expect(() => decodeRevertData("nope")).toThrow(/revert data/);
  });
});

describe("the Multicall3 surface signs nothing and sends nothing", () => {
  test("no export takes a key, and nothing in the source submits anything", () => {
    const source = readFileSync(join(import.meta.dir, "lib/multicall.ts"), "utf8");
    // A source scan that read nothing passes vacuously, so say how much it read.
    expect(source.length).toBeGreaterThan(4_000);
    for (const forbidden of [
      "privateKey",
      "mnemonic",
      "keystore",
      "signTransaction",
      "sendTransaction",
      "sendRawTransaction",
    ]) {
      expect({
        forbidden,
        present: source.toLowerCase().includes(forbidden.toLowerCase()),
      }).toEqual({ forbidden, present: false });
    }
    // Whole words, not substrings: `AGGREGATE3_SIGNATURE` is a function
    // signature and has nothing to do with signing anything.
    const words = Object.keys(multicall)
      .flatMap((name) => name.split(/[^A-Za-z]+|(?=[A-Z][a-z])/))
      .map((word) => word.toLowerCase())
      .filter((word) => word !== "");
    expect(words.length).toBeGreaterThan(15);
    expect(words).toContain("encode");
    for (const forbidden of ["sign", "signer", "send", "submit", "broadcast", "key", "secret"]) {
      expect({ forbidden, present: words.includes(forbidden) }).toEqual({
        forbidden,
        present: false,
      });
    }
  });
});
