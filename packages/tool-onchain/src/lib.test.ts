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
    expect(() => encodeCall("f(address)", ["0x1234"])).toThrow(/20 bytes/);
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
