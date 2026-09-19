/**
 * The libraries, on their own.
 *
 * Two things here are checked against something other than themselves, which
 * is the only kind of check worth making about a codec: every selector and
 * every ERC-165 interface id is recomputed from its signature through
 * `tool-onchain`'s `FunctionSelector`, and the fixture encoders are checked
 * byte for byte against `AbiEncodeCall`. A codec tested only against its own
 * output agrees with itself and with nothing on a chain.
 *
 * Nothing in this file touches the network. The chain seam is driven with
 * stubs and the metadata seam is left unbound so that a policy test proves a
 * URI was never dialled rather than merely that it failed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { abiEncodeCall, functionSelector } from "@crewhaus/tool-onchain";
import {
  ALICE,
  USDC,
  chainStub,
  encodeBytes32String,
  encodeString,
  encodeUint,
  erc20,
  revertWith,
} from "./fixtures";
import {
  TokenError,
  _setChainReader,
  assertReadMethod,
  chainReaderFromAdapters,
  checkBlockTag,
  hasChainReader,
  readCalls,
  readHasCode,
  readNativeBalance,
} from "./lib/chain";
import {
  INTERFACE_ID,
  MAX_STRING_BYTES,
  SELECTOR,
  addressWord,
  bytes4Word,
  decodeAddressValue,
  decodeBool,
  decodeStringish,
  decodeUint,
  padTokenIdHex,
  uintWord,
} from "./lib/erc";
import { confusableSkeleton, findCandidates, fingerprintLists, textConcerns } from "./lib/lists";
import { checkAddress, formatUnits } from "./lib/onchain";
import {
  _setMetadataFetch,
  checkIpfsGateway,
  decodeDataUri,
  fetchDocument,
  planUri,
  referencedUrls,
} from "./lib/uri";

const GATEWAY = "https://gateway.example/ipfs/";

async function selectorOf(signature: string): Promise<string> {
  const out = await functionSelector.execute({ signature });
  return (JSON.parse(out as string) as { selector: string }).selector;
}

/** The arguments of `f(...)` as encoded by the reference codec, selector removed. */
async function encodedArgs(signature: string, args: ReadonlyArray<unknown>): Promise<string> {
  const out = await abiEncodeCall.execute({ signature, args });
  return `0x${(JSON.parse(out as string) as { data: string }).data.slice(10)}`;
}

afterEach(() => {
  _setChainReader(undefined);
  _setMetadataFetch(undefined);
});

describe("the selectors are derived, not remembered", () => {
  const signatures: Record<keyof typeof SELECTOR, string> = {
    balanceOf: "balanceOf(address)",
    allowance: "allowance(address,address)",
    decimals: "decimals()",
    symbol: "symbol()",
    name: "name()",
    totalSupply: "totalSupply()",
    ownerOf: "ownerOf(uint256)",
    tokenURI: "tokenURI(uint256)",
    uri: "uri(uint256)",
    balanceOf1155: "balanceOf(address,uint256)",
    supportsInterface: "supportsInterface(bytes4)",
    getEthBalance: "getEthBalance(address)",
    getBlockNumber: "getBlockNumber()",
  };

  test("every selector constant is what Keccak-256 says of its signature", async () => {
    for (const [key, signature] of Object.entries(signatures)) {
      expect({ key, selector: SELECTOR[key as keyof typeof SELECTOR] }).toEqual({
        key,
        selector: await selectorOf(signature),
      });
    }
  });

  test("ERC-20 and ERC-1155 balanceOf are different functions with different selectors", () => {
    // Same name, different arity. Sending an ERC-1155 balance query to an
    // ERC-20 selector returns somebody's ERC-20 balance instead of an error.
    expect(SELECTOR.balanceOf).not.toBe(SELECTOR.balanceOf1155);
  });
});

describe("the interface ids are derived from their interfaces", () => {
  async function xorOf(signatures: ReadonlyArray<string>): Promise<string> {
    let acc = 0;
    for (const signature of signatures)
      acc ^= Number.parseInt((await selectorOf(signature)).slice(2), 16);
    return `0x${(acc >>> 0).toString(16).padStart(8, "0")}`;
  }

  test("ERC-721 is the XOR of the nine functions its interface declares", async () => {
    expect(INTERFACE_ID.erc721).toBe(
      await xorOf([
        "balanceOf(address)",
        "ownerOf(uint256)",
        "safeTransferFrom(address,address,uint256,bytes)",
        "safeTransferFrom(address,address,uint256)",
        "transferFrom(address,address,uint256)",
        "approve(address,uint256)",
        "setApprovalForAll(address,bool)",
        "getApproved(uint256)",
        "isApprovedForAll(address,address)",
      ]),
    );
  });

  test("ERC-721Metadata, ERC-721Enumerable, ERC-1155 and ERC-1155MetadataURI likewise", async () => {
    expect(INTERFACE_ID.erc721Metadata).toBe(
      await xorOf(["name()", "symbol()", "tokenURI(uint256)"]),
    );
    expect(INTERFACE_ID.erc721Enumerable).toBe(
      await xorOf([
        "totalSupply()",
        "tokenOfOwnerByIndex(address,uint256)",
        "tokenByIndex(uint256)",
      ]),
    );
    expect(INTERFACE_ID.erc1155).toBe(
      await xorOf([
        "balanceOf(address,uint256)",
        "balanceOfBatch(address[],uint256[])",
        "setApprovalForAll(address,bool)",
        "isApprovedForAll(address,address)",
        "safeTransferFrom(address,address,uint256,uint256,bytes)",
        "safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)",
      ]),
    );
    expect(INTERFACE_ID.erc1155MetadataUri).toBe(await xorOf(["uri(uint256)"]));
    expect(INTERFACE_ID.erc165).toBe(await xorOf(["supportsInterface(bytes4)"]));
  });

  test("the invalid id is the one ERC-165 requires a contract to deny", () => {
    expect(INTERFACE_ID.invalid).toBe("0xffffffff");
  });
});

describe("word packing agrees with the reference ABI coder", () => {
  test("an address is right-aligned", async () => {
    expect(`0x${addressWord(ALICE)}`).toBe(await encodedArgs("f(address)", [ALICE]));
  });

  test("a uint256 is right-aligned", async () => {
    expect(`0x${uintWord(123456789n)}`).toBe(await encodedArgs("f(uint256)", ["123456789"]));
  });

  test("a bytes4 is LEFT-aligned, which is the opposite of an integer", async () => {
    // Getting this backwards makes every supportsInterface answer false,
    // which reads as "not an NFT" rather than as a bug.
    expect(`0x${bytes4Word(INTERFACE_ID.erc721)}`).toBe(
      await encodedArgs("f(bytes4)", [INTERFACE_ID.erc721]),
    );
    expect(bytes4Word(INTERFACE_ID.erc721).startsWith("80ac58cd")).toBe(true);
  });

  test("the fixture string encoder produces what a contract would return", async () => {
    expect(encodeString("USD Coin")).toBe(await encodedArgs("f(string)", ["USD Coin"]));
    expect(encodeString("")).toBe(await encodedArgs("f(string)", [""]));
    expect(encodeString("a".repeat(40))).toBe(await encodedArgs("f(string)", ["a".repeat(40)]));
  });

  test("an address that is not 20 bytes is refused rather than padded", () => {
    expect(() => addressWord("0x1234")).toThrow("an address is 20 bytes");
  });

  test("a uint256 that does not fit is refused", () => {
    expect(() => uintWord(1n << 256n)).toThrow("does not fit in a uint256");
    expect(() => uintWord(-1n)).toThrow("negative");
  });
});

describe("reading what a token actually returned", () => {
  test("an ordinary dynamic string", () => {
    const read = decodeStringish(encodeString("USD Coin"));
    expect({ value: read.value, encoding: read.encoding }).toEqual({
      value: "USD Coin",
      encoding: "string",
    });
  });

  test("a bytes32 symbol — the MKR case — is decoded, not crashed on", () => {
    const read = decodeStringish(encodeBytes32String("MKR"));
    expect({ value: read.value, encoding: read.encoding }).toEqual({
      value: "MKR",
      encoding: "bytes32",
    });
    expect(read.note).toContain("bytes32");
  });

  test("no data at all is absent, which is not the same fact as an empty name", () => {
    const read = decodeStringish("0x");
    expect({ value: read.value, encoding: read.encoding }).toEqual({
      value: null,
      encoding: "absent",
    });
  });

  test("a bytes32 of all zeros decodes to an empty string, and says it was bytes32", () => {
    const read = decodeStringish(`0x${"00".repeat(32)}`);
    expect({ value: read.value, encoding: read.encoding }).toEqual({
      value: "",
      encoding: "bytes32",
    });
  });

  test("bytes that are not UTF-8 are undecodable rather than a row of replacement characters", () => {
    const read = decodeStringish(`0x${"ff".repeat(4)}${"00".repeat(28)}`);
    expect({ value: read.value, encoding: read.encoding }).toEqual({
      value: null,
      encoding: "undecodable",
    });
    expect(read.note).toContain("UTF-8");
  });

  test("a blob that is neither a word nor a string falls back to the first word as bytes32", () => {
    // Offset 64 rather than 32: not what an ABI string looks like.
    const blob = `0x${"4d4b52".padEnd(64, "0")}${"40".padStart(64, "0")}`;
    const read = decodeStringish(blob);
    expect(read.encoding).toBe("bytes32");
    expect(read.note).toContain("not a well-formed dynamic string");
  });

  test("a string claiming more bytes than a symbol could be is refused, not read", () => {
    const declared = BigInt(MAX_STRING_BYTES + 1);
    const read = decodeStringish(`0x${uintWord(32n)}${uintWord(declared)}${"00".repeat(32)}`);
    expect({ value: read.value, encoding: read.encoding }).toEqual({
      value: null,
      encoding: "undecodable",
    });
    expect(read.note).toContain("cap");
  });

  test("a truncated word is undecodable rather than zero-padded into a number", () => {
    expect(decodeUint("0x1234")).toBeNull();
    expect(decodeStringish("0x1234").encoding).toBe("undecodable");
  });

  test("an address word with rubbish in its top bytes is not an address", () => {
    // Masking it off would turn a contract's garbage into a plausible
    // destination for somebody's funds.
    expect(decodeAddressValue(`0x${"11".repeat(32)}`)).toBeNull();
    expect(decodeAddressValue(encodeUint(0n))).toBe("0x0000000000000000000000000000000000000000");
  });

  test("a bool word holding 2 is not a bool", () => {
    expect(decodeBool(encodeUint(2n))).toBeNull();
    expect(decodeBool(encodeUint(1n))).toBe(true);
    expect(decodeBool(encodeUint(0n))).toBe(false);
  });
});

describe("the {id} placeholder", () => {
  test("is 64 lowercase hex digits, zero-padded, with no 0x", () => {
    expect(padTokenIdHex(1n)).toBe(`${"0".repeat(63)}1`);
    expect(padTokenIdHex(0n)).toBe("0".repeat(64));
    expect(padTokenIdHex(0xabcdefn)).toBe(`${"0".repeat(58)}abcdef`);
    expect(padTokenIdHex(1n)).toHaveLength(64);
  });

  test("refuses an id that is not a uint256", () => {
    expect(() => padTokenIdHex(-1n)).toThrow("cannot be negative");
    expect(() => padTokenIdHex(1n << 256n)).toThrow("does not fit");
  });
});

describe("the confusable skeleton", () => {
  test("a Cyrillic \u0421 folds onto the Latin C it is drawn as", () => {
    expect(confusableSkeleton("USD\u0421")).toBe(confusableSkeleton("USDC"));
    expect("USD\u0421").not.toBe("USDC");
  });

  test("zero-width padding disappears", () => {
    expect(confusableSkeleton("USD\u200BC")).toBe("usdc");
  });

  test("digits that read as letters fold too", () => {
    expect(confusableSkeleton("USD0")).toBe(confusableSkeleton("USDO"));
    expect(confusableSkeleton("DA1")).toBe(confusableSkeleton("DAl"));
  });

  test("an accent decomposes rather than surviving as a different string", () => {
    expect(confusableSkeleton("CAFÉ")).toBe("cafe");
  });

  test("two genuinely different tickers stay different", () => {
    expect(confusableSkeleton("USDC")).not.toBe(confusableSkeleton("USDT"));
    expect(confusableSkeleton("WETH")).not.toBe(confusableSkeleton("WBTC"));
  });
});

describe("textConcerns names what is wrong with a string", () => {
  test("invisible characters are reported with their codepoints", () => {
    const concerns = textConcerns("USD\u200BC");
    expect(concerns[0]?.code).toBe("invisible-characters");
    expect(concerns[0]?.detail).toContain("U+200B");
  });

  test("a homoglyph is reported as confusable, with what it folds to", () => {
    const codes = textConcerns("USD\u0421").map((c) => c.code);
    expect(codes).toContain("non-ascii");
    expect(codes).toContain("confusable");
  });

  test("an ordinary ticker has nothing to say about it", () => {
    expect(textConcerns("USDC")).toEqual([]);
  });

  test("whitespace and absurd length are flagged", () => {
    expect(textConcerns(" USDC").map((c) => c.code)).toContain("whitespace");
    expect(textConcerns("x".repeat(100)).map((c) => c.code)).toContain("over-long");
  });
});

describe("finding candidates never picks one", () => {
  const listA = {
    id: "a",
    tokens: [{ chainId: 1, address: USDC, symbol: "USDC", name: "USD Coin", decimals: 6 }],
  };
  const listB = {
    id: "b",
    tokens: [
      {
        chainId: 1,
        address: "0x1111111111111111111111111111111111111111",
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
      },
    ],
  };
  const listAgain = {
    id: "a2",
    tokens: [
      {
        chainId: 1,
        address: USDC.toUpperCase().replace("0X", "0x"),
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
      },
    ],
  };

  test("two lists that disagree produce two candidates, not a winner", () => {
    const found = findCandidates([listA, listB], 1, "USDC");
    expect(found).toHaveLength(2);
  });

  test("two lists that agree produce one candidate with both claims", () => {
    const found = findCandidates([listA, listAgain], 1, "USDC");
    expect(found).toHaveLength(1);
    expect(found[0]?.claims.map((c) => c.listId)).toEqual(["a", "a2"]);
  });

  test("a homoglyph entry is pulled in and labelled as a confusable match", () => {
    const shady = {
      id: "shady",
      tokens: [
        {
          chainId: 1,
          address: "0x2222222222222222222222222222222222222222",
          symbol: "USD\u0421",
          name: "USD Coin",
          decimals: 6,
        },
      ],
    };
    const found = findCandidates([listA, shady], 1, "USDC");
    expect(found).toHaveLength(2);
    const impostor = found.find((c) => c.address.startsWith("0x2222"));
    expect(impostor?.matchedBy).toContain("symbol-confusable");
  });

  test("a chain id that does not match is not a candidate", () => {
    expect(findCandidates([listA], 8453, "USDC")).toEqual([]);
  });

  test("an address query matches whatever case it was written in", () => {
    const found = findCandidates([listA], 1, USDC.toUpperCase().replace("0X", "0x"));
    expect(found).toHaveLength(1);
    expect(found[0]?.matchedBy).toEqual(["address"]);
  });
});

describe("the list fingerprint", () => {
  const list = (decimals: number) => ({
    id: "a",
    tokens: [
      { chainId: 1, address: USDC, symbol: "USDC", name: "USD Coin", decimals },
      {
        chainId: 1,
        address: "0x1111111111111111111111111111111111111111",
        symbol: "X",
        name: "X",
        decimals: 18,
      },
    ],
  });

  test("does not move when the tokens are reordered", () => {
    const forward = list(6);
    const backward = { id: "a", tokens: [...forward.tokens].reverse() };
    expect(fingerprintLists([forward], 1)).toBe(fingerprintLists([backward], 1));
  });

  test("moves when a decimals field changes", () => {
    expect(fingerprintLists([list(6)], 1)).not.toBe(fingerprintLists([list(18)], 1));
  });
});

describe("the chain seam", () => {
  test("with nothing bound, a read refuses and names the setter", async () => {
    expect(hasChainReader()).toBe(false);
    await expect(
      readCalls({
        chainId: 1,
        calls: [{ key: "k", target: USDC, callData: "0x313ce567" }],
        blockTag: "latest",
        batch: false,
      }),
    ).rejects.toThrow("_setChainReader");
  });

  test("a write method is refused before it reaches the reader", () => {
    // The three read methods are the whole surface. Nothing here signs.
    expect(() => assertReadMethod("eth_sendRawTransaction")).toThrow("Nothing here signs");
    expect(() => assertReadMethod("eth_sendTransaction")).toThrow("not one of the read methods");
    expect(() => assertReadMethod("eth_call")).not.toThrow();
  });

  test("an adapter-backed reader refuses a write method too", async () => {
    const reader = chainReaderFromAdapters(() => undefined);
    await expect(
      reader({ chainId: 1, method: "eth_sendRawTransaction" as never, params: [] }),
    ).rejects.toThrow("not one of the read methods");
  });

  test("an adapter-backed reader says which chain has no adapter", async () => {
    const reader = chainReaderFromAdapters(() => undefined);
    await expect(reader({ chainId: 8453, method: "eth_call", params: [] })).rejects.toThrow(
      "no chain adapter is registered for chain 8453",
    );
  });

  test("a block tag that is not one is refused, with the list of the ones that are", () => {
    expect(() => checkBlockTag("yesterday")).toThrow("is not a block tag");
    for (const tag of ["latest", "safe", "finalized", "earliest", "pending", "0x1b4"]) {
      expect(() => checkBlockTag(tag)).not.toThrow();
    }
  });

  test("a batch reports the block it was read at", async () => {
    const stub = chainStub({
      contracts: {
        [USDC]: erc20({ decimals: 6n, symbol: "USDC", name: "USD Coin", totalSupply: 1n }),
      },
      blockNumber: 19_000_000n,
    });
    _setChainReader(stub.reader);
    const read = await readCalls({
      chainId: 1,
      calls: [{ key: "d", target: USDC, callData: SELECTOR.decimals }],
      blockTag: "latest",
      batch: true,
    });
    expect({ block: read.blockNumber, batched: read.batched }).toEqual({
      block: "19000000",
      batched: true,
    });
    expect(read.outcomes.get("d")?.data).toBe(encodeUint(6n));
  });

  test("a sub-call that reverts is an outcome with its reason, not a thrown error", async () => {
    const revert = await revertWith("no decimals here");
    const stub = chainStub({
      contracts: {
        [USDC]: (selector) =>
          selector === SELECTOR.decimals ? { ok: false, data: revert } : { ok: true, data: "0x" },
      },
    });
    _setChainReader(stub.reader);
    const read = await readCalls({
      chainId: 1,
      calls: [{ key: "d", target: USDC, callData: SELECTOR.decimals }],
      blockTag: "latest",
      batch: true,
    });
    expect(read.outcomes.get("d")?.ok).toBe(false);
    expect(read.outcomes.get("d")?.revert?.reason).toBe("no decimals here");
  });

  test("an answer that is not a Multicall3 result is refused, and says how to get past it", async () => {
    const stub = chainStub({ contracts: {}, brokenBatchAnswer: "0x" });
    _setChainReader(stub.reader);
    await expect(
      readCalls({
        chainId: 1,
        calls: [{ key: "d", target: USDC, callData: SELECTOR.decimals }],
        blockTag: "latest",
        batch: true,
      }),
    ).rejects.toThrow("did not answer with results");
  });

  test("unbatched, a reverting call fails alone instead of taking the others with it", async () => {
    const stub = chainStub({
      contracts: {
        [USDC]: (selector) =>
          selector === SELECTOR.decimals
            ? { ok: false, data: "0x" }
            : { ok: true, data: encodeUint(7n) },
      },
    });
    _setChainReader(stub.reader);
    const read = await readCalls({
      chainId: 1,
      calls: [
        { key: "d", target: USDC, callData: SELECTOR.decimals },
        { key: "s", target: USDC, callData: SELECTOR.totalSupply },
      ],
      blockTag: "latest",
      batch: false,
    });
    expect(read.outcomes.get("d")?.ok).toBe(false);
    expect(read.outcomes.get("d")?.error).toContain("reverted");
    expect(read.outcomes.get("s")?.data).toBe(encodeUint(7n));
    expect(read.blockNumber).toBeNull();
  });

  test("eth_getBalance answering 0x is an absent answer, not a zero balance", async () => {
    // A quantity is at least 0x0. Bare 0x is what a node says when it has
    // nothing to say, and this used to coerce it to 0n — the same mistake as
    // reading an EOA's empty eth_call as "this token has no symbol", except
    // the number it produces is a balance somebody acts on.
    _setChainReader(async () => "0x");
    await expect(readNativeBalance(1, ALICE, "latest")).rejects.toThrow(TokenError);
    await expect(readNativeBalance(1, ALICE, "latest")).rejects.toThrow(
      /absent answer rather than a zero one/,
    );
    // 0x0 IS a quantity, and it is genuinely zero.
    _setChainReader(async () => "0x0");
    expect(await readNativeBalance(1, ALICE, "latest")).toBe(0n);
  });

  test("an address with no code is reported as having none", async () => {
    const stub = chainStub({ contracts: {} });
    _setChainReader(stub.reader);
    expect(await readHasCode(1, USDC, "latest")).toEqual({ hasCode: false, codeSize: 0 });
  });

  test("the seam is what every read goes through, and it sees only read methods", async () => {
    const stub = chainStub({
      contracts: { [USDC]: erc20({ decimals: 6n, symbol: "U", name: "U", totalSupply: 0n }) },
    });
    _setChainReader(stub.reader);
    await readCalls({
      chainId: 1,
      calls: [{ key: "d", target: USDC, callData: SELECTOR.decimals }],
      blockTag: "latest",
      batch: true,
    });
    await readHasCode(1, USDC, "latest");
    expect(new Set(stub.reads.map((r) => r.method))).toEqual(new Set(["eth_call", "eth_getCode"]));
  });
});

describe("the arithmetic comes from tool-onchain", () => {
  test("EIP-55 is verified, not reproduced", async () => {
    const verdict = await checkAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    expect({ valid: verdict.valid, hadChecksum: verdict.hadChecksum }).toEqual({
      valid: true,
      hadChecksum: true,
    });
  });

  test("a mixed-case address with one character wrong fails its checksum", async () => {
    const verdict = await checkAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96046");
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain("checksum");
  });

  test("base units scale exactly, with no float anywhere near them", async () => {
    expect(await formatUnits(1_000_000n, 6)).toBe("1");
    expect(await formatUnits(123_456_789_012_345_678_901n, 18)).toBe("123.456789012345678901");
    expect(await formatUnits(1n, 18)).toBe("0.000000000000000001");
  });
});

describe("what may be done with a URI a contract handed back", () => {
  test("a data: URI is read in process, with no seam involved at all", () => {
    const uri = `data:application/json;base64,${Buffer.from('{"name":"On-chain #1"}').toString("base64")}`;
    const plan = planUri(uri, {});
    expect(plan).toEqual({ action: "inline", scheme: "data", mediaType: "application/json" });
    expect(new TextDecoder().decode(decodeDataUri(uri, 1024))).toBe('{"name":"On-chain #1"}');
  });

  test("a percent-encoded data: URI is read too", () => {
    const decoded = decodeDataUri("data:application/json,%7B%22a%22%3A1%7D", 1024);
    expect(new TextDecoder().decode(decoded)).toBe('{"a":1}');
  });

  test("a data: URI over the cap is refused rather than truncated", () => {
    const uri = `data:text/plain,${"x".repeat(100)}`;
    expect(() => decodeDataUri(uri, 10)).toThrow("over the 10-byte cap");
  });

  test("an ipfs URI is skipped when no gateway was supplied", () => {
    const plan = planUri("ipfs://QmHash/1.json", {});
    expect(plan).toEqual({
      action: "skip",
      scheme: "ipfs",
      reason: "no ipfsGateway was supplied, and this package will not pick one for you",
    });
  });

  test("an ipfs URI is rewritten onto the gateway the caller named", () => {
    expect(planUri("ipfs://QmHash/1.json", { ipfsGateway: GATEWAY })).toEqual({
      action: "fetch",
      scheme: "ipfs",
      url: `${GATEWAY}QmHash/1.json`,
    });
  });

  test("the ipfs://ipfs/ form does not produce a doubled path segment", () => {
    expect(planUri("ipfs://ipfs/QmHash/1.json", { ipfsGateway: GATEWAY })).toEqual({
      action: "fetch",
      scheme: "ipfs",
      url: `${GATEWAY}QmHash/1.json`,
    });
  });

  test("a URI that escapes the gateway is skipped, not followed", () => {
    // `ipfs:////evil.example/x` resolves to somebody else's origin under a
    // naive join. This is contract data, so it is assumed to be trying.
    const plan = planUri("ipfs://QmHash/../../../evil", {
      ipfsGateway: "https://gateway.example/ipfs/",
    });
    expect(plan.action).toBe("skip");
    expect((plan as { reason: string }).reason).toContain("outside the gateway prefix");
  });

  test("a gateway that is not a usable prefix is refused before anything is joined to it", () => {
    expect(() => checkIpfsGateway("https://gateway.example/ipfs")).toThrow('must end with "/"');
    expect(() => checkIpfsGateway("http://gateway.example/ipfs/")).toThrow("must be https");
    expect(() => checkIpfsGateway("https://gateway.example/ipfs/?k=v")).toThrow("query string");
    expect(() => checkIpfsGateway("not a url")).toThrow("is not a URL");
  });

  test("an https URI is skipped unless the caller allow-listed its host", () => {
    const plan = planUri("https://metadata.example/1.json", {});
    expect(plan.action).toBe("skip");
    expect((plan as { reason: string }).reason).toContain("not a reason to dial it");
    expect(
      planUri("https://metadata.example/1.json", { allowedHosts: ["metadata.example"] }),
    ).toEqual({
      action: "fetch",
      scheme: "https",
      url: "https://metadata.example/1.json",
    });
  });

  test("an allow-list for one host does not admit another", () => {
    const plan = planUri("https://evil.example/1.json", { allowedHosts: ["metadata.example"] });
    expect(plan.action).toBe("skip");
    expect((plan as { reason: string }).reason).toContain("not in allowedHosts");
  });

  test("plaintext http is never fetched", () => {
    const plan = planUri("http://metadata.example/1.json", { allowedHosts: ["metadata.example"] });
    expect(plan.action).toBe("skip");
    expect((plan as { reason: string }).reason).toContain("plaintext http");
  });

  test("a scheme nobody asked about is skipped by name", () => {
    expect((planUri("ar://abc", {}) as { reason: string }).reason).toContain("ar:");
    expect((planUri("", {}) as { reason: string }).reason).toContain("no URI");
  });

  test("with nothing bound, a fetch refuses and names the setter", async () => {
    await expect(fetchDocument("https://metadata.example/1.json", 1024)).rejects.toThrow(
      "_setMetadataFetch",
    );
  });

  test("the byte cap is re-checked on what came back, not trusted to the fetcher", async () => {
    _setMetadataFetch(async () => ({
      status: 200,
      contentType: "application/json",
      bytes: new Uint8Array(5000),
    }));
    await expect(fetchDocument("https://metadata.example/1.json", 100)).rejects.toThrow(
      "over the 100-byte cap",
    );
  });

  test("the URLs inside a metadata document are listed and not followed", () => {
    const refs = referencedUrls({
      name: "x",
      image: "ipfs://QmImage",
      external_url: "https://example.org/x",
    });
    expect(refs.map((r) => r.field).sort()).toEqual(["external_url", "image"]);
    expect(refs.find((r) => r.field === "image")?.scheme).toBe("ipfs");
  });
});

describe("TokenError is this package's own refusal", () => {
  test("it is distinguishable from a node's error", () => {
    const err = new TokenError("nope");
    expect(err.name).toBe("TokenError");
    expect(err instanceof Error).toBe(true);
  });
});
