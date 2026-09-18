/**
 * The onchain primitives, against published vectors.
 *
 * Every one of these has a canonical answer somebody else published: real
 * calldata, the EIP-712 specification's own worked example, EIP-55's
 * checksums. A codec tested only against itself agrees with itself and with
 * nothing on a chain, which is the only place the answer matters.
 */
import { describe, expect, test } from "bun:test";
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
