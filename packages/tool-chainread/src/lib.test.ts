/**
 * The floor the seven tools stand on, tested directly.
 *
 * Two things here are load-bearing beyond their size. The endpoint guard is
 * what stops a model-supplied URL from becoming a request to a metadata
 * service, and the timestamp search is the only thing in the package with an
 * invariant that a plausible wrong answer satisfies exactly as well as the
 * right one — so both get the boundary cases, not the happy path.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { functionSelector } from "@crewhaus/tool-onchain";
import {
  ALICE,
  BOB,
  type Chain,
  TOKEN,
  addTransferLogs,
  hash32,
  makeChain,
  rpcStub,
  topicFor,
  word,
} from "./fixtures";
import { projectBlock, searchBlockAtTimestamp } from "./lib/blocks";
import {
  RpcEndpointError,
  _setDnsLookup,
  isPrivateIp,
  normalizeIpv4,
  parseIpv6,
  setRpcEndpointPolicy,
  vetEndpoint,
} from "./lib/endpoint";
import { parseSuggestedSpan, projectLog, scanLogs, shouldNarrow } from "./lib/logs";
import { ChainReadError, hexToBigint, toBigint, toHexQuantity, unixToIso } from "./lib/quantity";
import { type RpcClient, type RpcOutcome, _setFetch, openRpc } from "./lib/rpc";
import {
  APPROVAL_FOR_ALL_TOPIC,
  APPROVAL_TOPIC,
  TOPIC_SIGNATURES,
  TRANSFER_SINGLE_TOPIC,
  TRANSFER_TOPIC,
  decodeApproval,
  decodeTransfer,
  feeBreakdown,
  projectReceipt,
  topicToAddress,
} from "./lib/transfers";

const PUBLIC_IP = "93.184.216.34";
const RPC_URL = "https://rpc.example.com/v2/a-key-that-must-not-leak";

beforeEach(() => {
  _setDnsLookup(async () => ({ address: PUBLIC_IP, family: 4 }));
  setRpcEndpointPolicy({});
});

afterEach(() => {
  _setDnsLookup(undefined);
  _setFetch(undefined);
  setRpcEndpointPolicy({});
});

async function connect(
  chain: Chain,
  options: Parameters<typeof rpcStub>[1] = {},
): Promise<{ rpc: Awaited<ReturnType<typeof openRpc>>; stub: ReturnType<typeof rpcStub> }> {
  const stub = rpcStub(chain, options);
  _setFetch(stub.fetch);
  return { rpc: await openRpc(RPC_URL), stub };
}

// ---------------------------------------------------------------------------

describe("quantities", () => {
  test("a hex quantity becomes a bigint, and a decimal string is refused as one", () => {
    expect(hexToBigint("0x64", "x")).toBe(100n);
    // "100" from a node would mean 0x100. Reading it as one hundred is a
    // 156-block error in a search bound, so it is a malformed answer instead.
    expect(() => hexToBigint("100", "block number")).toThrow(/0x hex quantity/);
  });

  test("a padded quantity is accepted, because real nodes pad", () => {
    expect(hexToBigint("0x0064", "x")).toBe(100n);
  });

  test("a number past the safe integer range is refused, not rounded", () => {
    // Written as an expression: the literal 9007199254740993 cannot be spelled
    // in source without already being rounded to 9007199254740992.
    expect(() => toBigint(Number.MAX_SAFE_INTEGER + 2, "block")).toThrow(/already lost digits/);
    expect(toBigint("9007199254740993", "block")).toBe(9_007_199_254_740_993n);
  });

  test("a negative quantity cannot be encoded for the wire", () => {
    expect(() => toHexQuantity(-1n)).toThrow(/negative/);
  });

  test("a timestamp past what a Date can hold is null, not the string Invalid Date", () => {
    expect(unixToIso(1_700_000_000n)).toBe("2023-11-14T22:13:20.000Z");
    expect(unixToIso(10n ** 20n)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("a block header, projected", () => {
  const header = {
    number: "0x2",
    hash: `0x${"ab".repeat(32)}`,
    parentHash: `0x${"cd".repeat(32)}`,
    timestamp: "0x6553f100",
    gasLimit: "0x1c9c380",
    gasUsed: "0xe4e1c0",
  };

  test("the transaction list is read in both shapes a node sends it", () => {
    // Asked for hashes, a node answers with strings; asked to hydrate — or
    // configured to hydrate regardless, which some gateways are — it answers
    // with objects. Reading only the first shape silently produced a block with
    // a transactionCount and no transactions, which is a documented field that
    // is simply not there.
    const hashes = [`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`];
    expect(projectBlock({ ...header, transactions: hashes }).transactions).toEqual(hashes);
    expect(
      projectBlock({
        ...header,
        transactions: hashes.map((hash) => ({ hash, from: ALICE, value: "0x1" })),
      }).transactions,
    ).toEqual(hashes);
  });

  test("a transaction entry with no hash in it leaves the list off rather than inventing one", () => {
    const projected = projectBlock({ ...header, transactions: [{ from: ALICE }] });
    expect(projected.transactions).toBeUndefined();
    expect(projected.transactionCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("the endpoint guard", () => {
  test("every inet_aton spelling of loopback normalises to 127.0.0.1", () => {
    for (const spelling of ["127.0.0.1", "0177.0.0.1", "0x7f.0.0.1", "2130706433", "127.1"]) {
      expect({ spelling, normalised: normalizeIpv4(spelling) }).toEqual({
        spelling,
        normalised: "127.0.0.1",
      });
    }
  });

  test("a hostname is not mistaken for an IPv4 literal", () => {
    expect(normalizeIpv4("rpc.example.com")).toBeNull();
    expect(normalizeIpv4("")).toBeNull();
  });

  test("the ranges that are never a public RPC endpoint", () => {
    for (const address of [
      "127.0.0.1",
      "169.254.169.254",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::ffff:127.0.0.1",
      "fe80::1",
      "fc00::1",
    ]) {
      expect({ address, private: isPrivateIp(address) }).toEqual({ address, private: true });
    }
    for (const address of [PUBLIC_IP, "1.1.1.1", "2606:4700::1111"]) {
      expect({ address, private: isPrivateIp(address) }).toEqual({ address, private: false });
    }
  });

  test("an IPv4 inside an IPv6 address is only as safe as the IPv4 it carries", () => {
    // The spelling above (`::ffff:127.0.0.1`) is the one a human writes and the
    // one a URL NEVER produces: the WHATWG parser re-serialises the embedded
    // quad as hex pieces, so the guard only ever sees `::ffff:7f00:1`. A
    // classifier that knows the dotted form and not the hex one is a classifier
    // that never fires in production.
    expect(new URL("http://[::ffff:169.254.169.254]/").hostname).toBe("[::ffff:a9fe:a9fe]");
    for (const address of [
      "::ffff:7f00:1", // 127.0.0.1, mapped
      "::ffff:a9fe:a9fe", // 169.254.169.254 — the cloud metadata service
      "::ffff:c0a8:1", // 192.168.0.1
      "::ffff:0:7f00:1", // the IPv4-translated spelling of the same loopback
      "64:ff9b::a9fe:a9fe", // NAT64: what a DNS64 resolver hands out for the metadata service
      "2002:a9fe:a9fe::1", // 6to4, which carries its IPv4 in the next two groups
      "::7f00:1", // IPv4-compatible, deprecated and still routed
      "fe80::1",
      "fd00::1",
      "ff02::1",
    ]) {
      expect({ address, private: isPrivateIp(address) }).toEqual({ address, private: true });
    }
    // And a mapped PUBLIC address is still public: over-refusing every `::ffff:`
    // would be a guard that works by breaking the feature.
    for (const address of ["::ffff:5db8:d822", "2606:4700::1111", "2001:4860:4860::8888"]) {
      expect({ address, private: isPrivateIp(address) }).toEqual({ address, private: false });
    }
  });

  test("an IPv6 address is expanded to numbers, and a malformed one is not guessed at", () => {
    // The classifier's answers are only as good as this: a spelling it fails to
    // expand is a spelling it reports as public.
    expect(parseIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("[64:ff9b::a9fe:a9fe]")).toEqual([0x64, 0xff9b, 0, 0, 0, 0, 0xa9fe, 0xa9fe]);
    expect(parseIpv6("::ffff:127.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    // A scope id belongs to the interface, not the address, and leaving it on
    // makes the whole string unparseable — which reads as "not private".
    expect(parseIpv6("fe80::1%eth0")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(isPrivateIp("fe80::1%eth0")).toBe(true);
    for (const malformed of [
      "1:2:3", // too few groups without a `::` to say where the gap is
      "1:2:3:4:5:6:7:8:9",
      "::1::2",
      "fe80::gggg", // a bad group after the gap
      "gggg::1", // and before it
      "12345::1", // five hex digits is not a 16-bit group
      "rpc.example.com",
      "",
    ]) {
      expect({ malformed, groups: parseIpv6(malformed) }).toEqual({ malformed, groups: null });
    }
  });

  test("a bracketed IPv6 literal for a private address is refused before the socket opens", async () => {
    for (const url of [
      "http://[::ffff:169.254.169.254]/",
      "http://[::ffff:a9fe:a9fe]/",
      "http://[::ffff:7f00:1]:8545/",
      "http://[64:ff9b::a9fe:a9fe]/",
      "http://[::1]:8545/",
    ]) {
      await expect(vetEndpoint(url)).rejects.toThrow(/refusing to dial/);
    }
  });

  test("a public NAME that resolves to an IPv6-wrapped private address is refused", async () => {
    // dns.lookup answers with whatever the resolver holds, and on a DNS64
    // network that is a NAT64 address for an IPv4-only name.
    _setDnsLookup(async () => ({ address: "64:ff9b::a9fe:a9fe", family: 6 }));
    await expect(vetEndpoint("https://totally-normal.example.com")).rejects.toThrow(
      /private address 64:ff9b::a9fe:a9fe/,
    );
  });

  test("a public endpoint is accepted and pinned to the address that was vetted", async () => {
    const vetted = await vetEndpoint(RPC_URL);
    expect(vetted.pinnedIp).toBe(PUBLIC_IP);
  });

  test("refuses a websocket URL, which is a transport this package does not speak", async () => {
    await expect(vetEndpoint("wss://rpc.example.com")).rejects.toThrow(/refusing scheme "wss"/);
  });

  test("refuses credentials in the URL rather than putting them in a log line", async () => {
    await expect(vetEndpoint("https://user:secret@rpc.example.com")).rejects.toThrow(
      /credentials in it/,
    );
  });

  test("refuses loopback by name and by literal, and says how an operator can allow it", async () => {
    await expect(vetEndpoint("http://localhost:8545")).rejects.toThrow(/allowPrivateHosts/);
    await expect(vetEndpoint("http://127.0.0.1:8545")).rejects.toThrow(/private address 127.0.0.1/);
    await expect(vetEndpoint("http://0x7f000001:8545")).rejects.toThrow(/private address/);
  });

  test("refuses a public NAME that resolves to a private address", async () => {
    // DNS rebinding: the name looks fine and the answer does not.
    _setDnsLookup(async () => ({ address: "169.254.169.254", family: 4 }));
    await expect(vetEndpoint("https://totally-normal.example.com")).rejects.toThrow(
      /private address 169\.254\.169\.254/,
    );
  });

  test("an operator can open the private ranges for a local devnet", async () => {
    setRpcEndpointPolicy({ allowPrivateHosts: true });
    const vetted = await vetEndpoint("http://127.0.0.1:8545");
    expect(vetted.url.port).toBe("8545");
  });

  test("an operator allow-list refuses everything outside it", async () => {
    setRpcEndpointPolicy({ allowedOrigins: ["https://mainnet.base.org"] });
    await expect(vetEndpoint(RPC_URL)).rejects.toThrow(/rpc allow-list/);
    await expect(vetEndpoint("https://mainnet.base.org/")).resolves.toBeDefined();
  });

  test("the refusal is an RpcEndpointError, so a caller can tell it from a chain answer", async () => {
    await expect(vetEndpoint("not-a-url")).rejects.toBeInstanceOf(RpcEndpointError);
  });
});

// ---------------------------------------------------------------------------

describe("the read-only gate", () => {
  test("no write method can be dispatched, whatever asks for it", async () => {
    const { rpc } = await connect(makeChain());
    for (const method of [
      "eth_sendRawTransaction",
      "eth_sendTransaction",
      "eth_sign",
      "personal_sign",
      "eth_signTransaction",
    ]) {
      await expect(rpc.call(method, [])).rejects.toThrow(/read-only allowlist/);
    }
  });

  test("the endpoint's path never appears in an error, because a provider key lives there", async () => {
    const { rpc } = await connect(makeChain(), { httpStatus: 429 });
    const outcome = await rpc.call("eth_blockNumber", []);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.message).toContain("https://rpc.example.com");
    expect(outcome.message).not.toContain("a-key-that-must-not-leak");
  });

  test("a redirect is refused rather than followed to a host nothing vetted", async () => {
    // The pin is only worth as much as the refusal to follow a hop past it: an
    // endpoint that 302s to 169.254.169.254 has just been handed the request
    // the guard spent a DNS lookup keeping away from there. `redirect:
    // "manual"` is what makes the 3xx visible here instead of transparently
    // followed, and this asserts the refusal names it.
    _setFetch(
      async () =>
        new Response("", { status: 302, headers: { location: "http://169.254.169.254/" } }),
    );
    const rpc = await openRpc(RPC_URL);
    const outcome = await rpc.call("eth_blockNumber", []);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect({ kind: outcome.kind, status: outcome.status }).toEqual({ kind: "status", status: 302 });
    expect(outcome.message).toMatch(/refusing to follow it to a host that was never vetted/);
    // And the location it was pointed at is not repeated back into a transcript.
    expect(outcome.message).not.toContain("169.254.169.254");
  });

  test("an error message from the endpoint cannot be longer than a sentence", async () => {
    // The one field in the exchange a provider fills in freely, inside a body
    // allowed sixteen megabytes, on its way to a refusal and a model's context.
    const message = "x".repeat(100_000);
    _setFetch(
      async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const rpc = await openRpc(RPC_URL);
    const outcome = await rpc.call("eth_blockNumber", []);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.message.length).toBeLessThan(2_200);
    expect(outcome.message).toContain("truncated from 100000 characters");
  });

  test("an unreachable endpoint is a transport failure, not a chain answer", async () => {
    const { rpc } = await connect(makeChain(), { unreachable: true });
    const outcome = await rpc.call("eth_blockNumber", []);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    // The KIND is what a caller branches on: retrying a transport failure can
    // help, retrying a 429 in halves cannot.
    expect(outcome.kind).toBe("transport");
  });
});

// ---------------------------------------------------------------------------

describe("the timestamp search", () => {
  const start = 1_700_000_000n;

  test("an exact hit returns that block, and the next block proves the boundary", async () => {
    const chain = makeChain({ blocks: 64, startTimestamp: start, blockTime: 12n });
    const { rpc } = await connect(chain);
    const result = await searchBlockAtTimestamp(rpc, start + 120n, { low: 0n, high: 63n });
    expect(result.outcome).toBe("found");
    if (result.outcome !== "found") throw new Error("unreachable");
    expect(result.at.number).toBe("10");
    expect(result.at.timestamp).toBe((start + 120n).toString());
    expect(result.next?.number).toBe("11");
    expect(BigInt(result.next?.timestamp ?? "0") > start + 120n).toBe(true);
  });

  test("between two blocks it returns the earlier one — at or BEFORE, never after", async () => {
    const chain = makeChain({ blocks: 64, startTimestamp: start, blockTime: 12n });
    const { rpc } = await connect(chain);
    const result = await searchBlockAtTimestamp(rpc, start + 125n, { low: 0n, high: 63n });
    if (result.outcome !== "found") throw new Error("unreachable");
    expect({ at: result.at.number, next: result.next?.number }).toEqual({ at: "10", next: "11" });
  });

  test("a timestamp before genesis is refused rather than answered with block zero", async () => {
    const chain = makeChain({ blocks: 64, startTimestamp: start });
    const { rpc } = await connect(chain);
    const result = await searchBlockAtTimestamp(rpc, start - 1n, { low: 0n, high: 63n });
    // The refusal is structured rather than thrown here so the tool can put the
    // genesis timestamp in its message; the tool turns it into an error.
    expect(result.outcome).toBe("beforeRange");
    if (result.outcome !== "beforeRange") throw new Error("unreachable");
    expect(result.first.number).toBe("0");
  });

  test("a timestamp past the head returns the head and says there is nothing after it", async () => {
    const chain = makeChain({ blocks: 64, startTimestamp: start, blockTime: 12n });
    const { rpc } = await connect(chain);
    const result = await searchBlockAtTimestamp(rpc, start + 1_000_000n, { low: 0n, high: 63n });
    if (result.outcome !== "found") throw new Error("unreachable");
    expect({ at: result.at.number, next: result.next, atHead: result.atHead }).toEqual({
      at: "63",
      next: null,
      atHead: true,
    });
  });

  test("the timestamp of the head itself is at the head, not one block short of it", async () => {
    const chain = makeChain({ blocks: 64, startTimestamp: start, blockTime: 12n });
    const { rpc } = await connect(chain);
    const headTs = start + 63n * 12n;
    const result = await searchBlockAtTimestamp(rpc, headTs, { low: 0n, high: 63n });
    if (result.outcome !== "found") throw new Error("unreachable");
    expect(result.at.number).toBe("63");
  });

  test("with several blocks sharing a timestamp it returns the LAST of them", async () => {
    // "At or before" has one answer only if ties resolve upward: a caller that
    // reads state at the returned block wants the state after everything that
    // happened at that instant.
    const chain = makeChain({ blocks: 32, startTimestamp: start, blockTime: 12n });
    for (const n of [10, 11, 12]) {
      const block = chain.blocks[n];
      if (block === undefined) throw new Error("fixture");
      chain.blocks[n] = { ...block, timestamp: start + 120n };
    }
    const { rpc } = await connect(chain);
    const result = await searchBlockAtTimestamp(rpc, start + 120n, { low: 0n, high: 31n });
    if (result.outcome !== "found") throw new Error("unreachable");
    expect(result.at.number).toBe("12");
    expect(BigInt(result.next?.timestamp ?? "0") > start + 120n).toBe(true);
  });

  test("a chain whose timestamps go backwards is refused, naming both blocks", async () => {
    const chain = makeChain({ blocks: 16, startTimestamp: start, blockTime: 12n });
    const seven = chain.blocks[7];
    if (seven === undefined) throw new Error("fixture");
    chain.blocks[7] = { ...seven, timestamp: start - 500n };
    const { rpc } = await connect(chain);
    await expect(searchBlockAtTimestamp(rpc, start + 60n, { low: 0n, high: 15n })).rejects.toThrow(
      /timestamps go backwards/,
    );
  });

  test("the probe count is logarithmic, and it is the number the tool reports", async () => {
    const chain = makeChain({ blocks: 1024, startTimestamp: start, blockTime: 12n });
    const { rpc, stub } = await connect(chain);
    const result = await searchBlockAtTimestamp(rpc, start + 5_000n, { low: 0n, high: 1023n });
    if (result.outcome !== "found") throw new Error("unreachable");
    expect(result.probes).toBe(stub.count("eth_getBlockByNumber"));
    expect(result.probes).toBeLessThan(16);
  });

  test("the probe budget is a ceiling, and running out of it names the bracket", async () => {
    // The loop terminates on its own, so this guard only ever fires on a
    // bracket nobody could have meant — `toBlock: 10^30` needs a hundred
    // probes. Untested, it was a ceiling that had never been shown to hold.
    const chain = makeChain({ blocks: 512, startTimestamp: start, blockTime: 12n });
    const { rpc, stub } = await connect(chain);
    await expect(
      searchBlockAtTimestamp(rpc, start + 3_000n, { low: 0n, high: 511n }, 3),
    ).rejects.toThrow(/used more than 3 probes over blocks 0–511/);
    // And it stops AT the budget rather than after it.
    expect(stub.count("eth_getBlockByNumber")).toBe(3);
  });

  test("a bracket wider than the chain is a refusal, not a silent wrong answer", async () => {
    const chain = makeChain({ blocks: 16, startTimestamp: start });
    const { rpc } = await connect(chain);
    await expect(
      searchBlockAtTimestamp(rpc, start + 60n, { low: 0n, high: 5_000n }),
    ).rejects.toThrow(/does not exist/);
  });
});

// ---------------------------------------------------------------------------

const SCAN_DEFAULTS = {
  from: 0n,
  to: 15n,
  span: 16n,
  suspectAt: 1_000,
  maxLogs: 1_000,
  maxCalls: 64,
} as const;

/**
 * An endpoint that serves any range up to `cap` blocks and complains about
 * anything wider, recording the span of every request.
 *
 * Hand-built rather than driven through `rpcStub`, because what is under test
 * is the splitter's arithmetic — which spans it asks for, in which order — and
 * a stub that also decides what a log looks like puts a second variable in the
 * way of that.
 */
function servedBySpan(cap: bigint, asked: bigint[], complaint: string): RpcClient {
  const client: RpcClient = {
    origin: "https://rpc.example.com",
    calls: 0,
    async call(_method, params): Promise<RpcOutcome> {
      const filter = params[0] as { fromBlock: string; toBlock: string };
      const span = BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n;
      asked.push(span);
      client.calls += 1;
      if (span > cap) return { ok: false, kind: "rpcError", code: -32600, message: complaint };
      return { ok: true, result: [] };
    },
  };
  return client;
}

describe("what a provider's range complaint means", () => {
  test("the explicit hex range Alchemy suggests", () => {
    expect(
      parseSuggestedSpan(
        "Log response size exceeded. You can make eth_getLogs requests with up to a 2000 block range; based on your parameters this block range should work: [0x1, 0x7d0]",
      ),
    ).toBe(2000n);
  });

  test("a range named in words, with and without the k suffix", () => {
    expect(parseSuggestedSpan("eth_getLogs is limited to a 10,000 block range")).toBe(10_000n);
    expect(parseSuggestedSpan("you may query at most 2k blocks")).toBe(2_000n);
  });

  test("a complaint that names no range at all", () => {
    expect(parseSuggestedSpan("query timeout exceeded")).toBeNull();
  });

  test("only the head of a complaint is read, because the endpoint writes the rest", () => {
    // The error text is attacker-controlled: it arrives inside a body that is
    // capped at sixteen megabytes, and it is the only field here a provider
    // fills in freely. Reading a bounded prefix is what keeps the cost of
    // parsing it proportional to a sentence rather than to the body.
    const hint = "up to a 10000 block range";
    expect(parseSuggestedSpan(`${"padding. ".repeat(10)}${hint}`)).toBe(10_000n);
    expect(parseSuggestedSpan(`${"padding. ".repeat(500)}${hint}`)).toBeNull();
  });

  test("a complaint made of a million digits is parsed in linear time, not quadratic", () => {
    // `(\d[\d,_]*)\s*(k)?\s*blocks?` backtracks once per character of a digit
    // run for every position the run starts at, so one long run of digits with
    // no "block" after it is O(n^2): 160k digits took a minute before the
    // quantifiers were bounded, and a 16MB body is a hang, not a slow call.
    // The assertion is the VALUE, not the time — the bug's failure mode is
    // this test never returning.
    expect(parseSuggestedSpan("9".repeat(2_000_000))).toBeNull();
    expect(parseSuggestedSpan(`[0x${"f".repeat(1_000_000)}, 0x1]`)).toBeNull();
  }, 20_000); // pays for two multi-megabyte strings; the fixed parser needs milliseconds

  test("a suggested range wider than the request is not taken up on", async () => {
    // "You can make requests with up to a 10000 block range" is the endpoint
    // describing its own limit, not this request. Widening on it walks straight
    // back into the same error, and because every retry re-widens, the scan
    // only stops when it runs out of maxCalls — a refusal, for a range the
    // endpoint would have served in halves.
    const asked: bigint[] = [];
    const client = servedBySpan(2n, asked, "up to a 10000 block range");
    const report = await scanLogs(client, {}, SCAN_DEFAULTS);
    expect(report.finalSpan).toBe("2");
    expect(asked.some((span) => span > SCAN_DEFAULTS.span)).toBe(false);
  });

  test("once an endpoint has forced the span down, the scan does not let it grow back", async () => {
    // Without the clamp, a wide piece that fails late in the scan resets the
    // working span upward and the next chunks rediscover the same cap one
    // after another — more requests, against an endpoint that has already said
    // no, and every one of them a chance to be rate-limited instead.
    const asked: bigint[] = [];
    const client = servedBySpan(2n, asked, "query returned too much");
    const report = await scanLogs(client, {}, SCAN_DEFAULTS);
    expect(report.finalSpan).toBe("2");
    // Thirteen is what the clamp buys over blocks 0–15 against a two-block cap:
    // 16, 8, 4, 2, 2, 4, 2, 2, 8 and then four two-block chunks. Letting the
    // span grow back splits the last eight twice more.
    expect(report.calls).toBeLessThanOrEqual(13);
  });

  test("the same log listed twice in one answer is collected once", async () => {
    // Endpoints behind a merging proxy do send a log twice in one array. Two
    // copies of one event is the same lie as a missing one, in the other
    // direction: a balance reconciled from this would be double the movement.
    const entry = {
      address: TOKEN,
      topics: [TRANSFER_TOPIC, topicFor(ALICE), topicFor(BOB)],
      data: `0x${word(4_200n)}`,
      blockNumber: "0x3",
      blockHash: hash32("block-3"),
      transactionHash: hash32("tx-dup"),
      transactionIndex: "0x0",
      logIndex: "0x0",
      removed: false,
    };
    const client: RpcClient = {
      origin: "https://rpc.example.com",
      calls: 0,
      async call(): Promise<RpcOutcome> {
        client.calls += 1;
        return { ok: true, result: [entry, entry] };
      },
    };
    const report = await scanLogs(client, {}, { ...SCAN_DEFAULTS, from: 3n, to: 3n });
    expect(report.logs.length).toBe(1);
  });

  test("narrowing is decided by the SHAPE of the failure, not by matching error text", () => {
    // A cap phrased in a way nobody anticipated still narrows; a rate limit
    // never does, because sixteen retries is an attack on the endpoint.
    expect(shouldNarrow({ ok: false, kind: "rpcError", message: "🤷" })).toBe(true);
    expect(shouldNarrow({ ok: false, kind: "timeout", message: "slow" })).toBe(true);
    expect(shouldNarrow({ ok: false, kind: "tooLarge", message: "big" })).toBe(true);
    expect(shouldNarrow({ ok: false, kind: "status", message: "", status: 429 })).toBe(false);
    expect(shouldNarrow({ ok: false, kind: "status", message: "", status: 401 })).toBe(false);
    expect(shouldNarrow({ ok: false, kind: "transport", message: "refused" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("the log scan", () => {
  const scanDefaults = { suspectAt: 1_000, maxLogs: 100_000, maxCalls: 512 };

  test("a range the endpoint caps is halved until it is served", async () => {
    const chain = makeChain({ blocks: 200 });
    addTransferLogs(chain, 5n, 3);
    addTransferLogs(chain, 150n, 2);
    const { rpc, stub } = await connect(chain, { maxRangeBlocks: 10n });
    const report = await scanLogs(rpc, {}, { from: 0n, to: 199n, span: 200n, ...scanDefaults });
    expect(report.logs.length).toBe(5);
    // It took the range the endpoint named rather than halving 200 → 100 → 50…
    expect(report.finalSpan).toBe("10");
    expect(stub.count("eth_getLogs")).toBeLessThan(30);
  });

  test("a single block the endpoint still refuses is a refusal, not an empty result", async () => {
    const chain = makeChain({ blocks: 10 });
    const { rpc } = await connect(chain, { maxRangeBlocks: 0n });
    await expect(
      scanLogs(rpc, {}, { from: 0n, to: 9n, span: 10n, ...scanDefaults }),
    ).rejects.toThrow(/single block and this endpoint still refuses it/);
  });

  test("a rate limit is not retried in halves", async () => {
    const chain = makeChain({ blocks: 100 });
    const { rpc, stub } = await connect(chain, { httpStatus: 429 });
    await expect(
      scanLogs(rpc, {}, { from: 0n, to: 99n, span: 100n, ...scanDefaults }),
    ).rejects.toThrow(/HTTP 429/);
    expect(stub.count("eth_getLogs")).toBe(1);
  });

  test("SILENT truncation is detected and the missing logs are recovered", async () => {
    // The endpoint returns the first 10 of 40 matches with a 200 and no hint
    // that anything is missing. Splitting proves the whole was short.
    const chain = makeChain({ blocks: 64 });
    for (let block = 0; block < 8; block++) addTransferLogs(chain, BigInt(block), 5);
    const { rpc } = await connect(chain, { silentLogCap: 10 });
    const report = await scanLogs(
      rpc,
      {},
      {
        from: 0n,
        to: 63n,
        span: 64n,
        suspectAt: 10,
        maxLogs: 100_000,
        maxCalls: 512,
      },
    );
    expect(report.logs.length).toBe(40);
    expect(report.silentTruncations).toBeGreaterThan(0);
    expect(report.verifications).toBeGreaterThan(0);
  });

  test("a truncation that cannot be proved away — one block — is REFUSED", async () => {
    const chain = makeChain({ blocks: 4 });
    addTransferLogs(chain, 2n, 40);
    const { rpc } = await connect(chain, { silentLogCap: 10 });
    await expect(
      scanLogs(
        rpc,
        {},
        {
          from: 0n,
          to: 3n,
          span: 4n,
          suspectAt: 10,
          maxLogs: 100_000,
          maxCalls: 512,
        },
      ),
    ).rejects.toThrow(/cannot be split to prove otherwise/);
  });

  test("more logs than maxLogs is refused rather than sliced", async () => {
    const chain = makeChain({ blocks: 8 });
    for (let block = 0; block < 8; block++) addTransferLogs(chain, BigInt(block), 4);
    const { rpc } = await connect(chain);
    await expect(
      scanLogs(
        rpc,
        {},
        { from: 0n, to: 7n, span: 8n, suspectAt: 1_000, maxLogs: 10, maxCalls: 512 },
      ),
    ).rejects.toThrow(/refusing to return the first 10/);
  });

  test("a log from outside the range means the endpoint answered a different question", async () => {
    const chain = makeChain({ blocks: 16 });
    addTransferLogs(chain, 4n, 1);
    const stub = rpcStub(chain);
    _setFetch(async (req, ip) => {
      const res = await stub.fetch(req, ip);
      const body = (await res.json()) as { result?: unknown };
      if (Array.isArray(body.result) && body.result.length > 0) {
        const first = body.result[0] as Record<string, unknown>;
        // Same log, claiming a block far outside what was asked for.
        body.result = [{ ...first, blockNumber: "0x3e8" }];
      }
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const rpc = await openRpc(RPC_URL);
    await expect(
      scanLogs(rpc, {}, { from: 0n, to: 15n, span: 16n, ...scanDefaults }),
    ).rejects.toThrow(/not answering the question that was asked/);
  });

  test("the same height coming back with two different hashes is a reorg, and a refusal", async () => {
    // The re-query that proves a chunk was not truncated asks about blocks an
    // earlier request already answered. That is where a chain moving under the
    // scan shows itself, and it is the reason the hash map is scan-wide.
    const chain = makeChain({ blocks: 8 });
    for (let block = 0; block < 8; block++) addTransferLogs(chain, BigInt(block), 2);
    const stub = rpcStub(chain);
    let batches = 0;
    _setFetch(async (req, ip) => {
      const res = await stub.fetch(req, ip);
      const body = (await res.json()) as { result?: unknown };
      if (Array.isArray(body.result) && body.result.length > 0) {
        batches += 1;
        if (batches > 1) {
          body.result = (body.result as Array<Record<string, unknown>>).map((log) => ({
            ...log,
            blockHash: hash32("reorged"),
          }));
        }
      }
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const rpc = await openRpc(RPC_URL);
    await expect(
      scanLogs(
        rpc,
        {},
        {
          from: 0n,
          to: 7n,
          span: 8n,
          suspectAt: 10,
          maxLogs: 100_000,
          maxCalls: 512,
        },
      ),
    ).rejects.toThrow(/reorganised while this scan was running/);
  });

  test("a log marked removed belongs to a block the chain dropped, and is a refusal", async () => {
    const chain = makeChain({ blocks: 8 });
    addTransferLogs(chain, 3n, 1);
    const stub = rpcStub(chain);
    _setFetch(async (req, ip) => {
      const res = await stub.fetch(req, ip);
      const body = (await res.json()) as { result?: unknown };
      if (Array.isArray(body.result) && body.result.length > 0) {
        body.result = (body.result as Array<Record<string, unknown>>).map((log) => ({
          ...log,
          removed: true,
        }));
      }
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const rpc = await openRpc(RPC_URL);
    await expect(
      scanLogs(rpc, {}, { from: 0n, to: 7n, span: 8n, ...scanDefaults }),
    ).rejects.toThrow(/reorganised away/);
  });

  test("logs come back in block then index order however the chunks arrived", async () => {
    const chain = makeChain({ blocks: 40 });
    addTransferLogs(chain, 30n, 2);
    addTransferLogs(chain, 3n, 2);
    const { rpc } = await connect(chain);
    const report = await scanLogs(rpc, {}, { from: 0n, to: 39n, span: 10n, ...scanDefaults });
    const order = report.logs.map((l) => `${l.blockNumber}:${l.logIndex}`);
    expect(order).toEqual(["3:0", "3:1", "30:0", "30:1"]);
  });

  test("an inverted range is refused before anything is dialled", async () => {
    const chain = makeChain({ blocks: 8 });
    const { rpc, stub } = await connect(chain);
    await expect(
      scanLogs(rpc, {}, { from: 7n, to: 2n, span: 4n, ...scanDefaults }),
    ).rejects.toThrow(/inverted/);
    expect(stub.count("eth_getLogs")).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("decoding what a log says", () => {
  test("every topic constant is the Keccak this repo computes, not one that was typed", async () => {
    // A mistyped topic is a filter that silently matches nothing, which reads
    // exactly like "this never happened".
    for (const [topic, signature] of Object.entries(TOPIC_SIGNATURES)) {
      const raw = await functionSelector.execute({ signature, kind: "event" }, undefined);
      const computed = JSON.parse(raw as string) as { topic: string };
      expect({ signature, topic: computed.topic }).toEqual({ signature, topic });
    }
    expect(Object.keys(TOPIC_SIGNATURES)).toEqual([
      TRANSFER_TOPIC,
      APPROVAL_TOPIC,
      APPROVAL_FOR_ALL_TOPIC,
      TRANSFER_SINGLE_TOPIC,
    ]);
  });

  test("an indexed address is the low 20 bytes of its topic word", () => {
    expect(topicToAddress(topicFor(ALICE))).toBe(ALICE);
    expect(() => topicToAddress("0x1234")).toThrow(/32-byte topic/);
  });

  test("three topics is a fungible transfer; four is one specific NFT", () => {
    const base = {
      address: TOKEN,
      data: `0x${word(7n)}`,
      blockNumber: "1",
      blockHash: hash32("b"),
      transactionHash: hash32("t"),
      transactionIndex: 0,
      logIndex: 0,
      removed: false,
    };
    const erc20 = decodeTransfer({
      ...base,
      topics: [TRANSFER_TOPIC, topicFor(ALICE), topicFor(BOB)],
    });
    expect(erc20).toEqual({
      standard: "erc20",
      token: TOKEN,
      from: ALICE,
      to: BOB,
      amount: "7",
      logIndex: 0,
    });

    // The same event with the value INDEXED. Reading a token id as an amount
    // turns one NFT into 7e-18 of a token.
    const erc721 = decodeTransfer({
      ...base,
      data: "0x",
      topics: [TRANSFER_TOPIC, topicFor(ALICE), topicFor(BOB), `0x${word(7n)}`],
    });
    expect(erc721?.standard).toBe("erc721");
    expect({ amount: erc721?.amount, tokenId: erc721?.tokenId }).toEqual({
      amount: "1",
      tokenId: "7",
    });
  });

  test("a Transfer whose data is too short to hold a value is refused, not read as zero", () => {
    expect(() =>
      decodeTransfer({
        address: TOKEN,
        topics: [TRANSFER_TOPIC, topicFor(ALICE), topicFor(BOB)],
        data: "0x1234",
        blockNumber: "1",
        blockHash: hash32("b"),
        transactionHash: hash32("t"),
        transactionIndex: 0,
        logIndex: 0,
        removed: false,
      }),
    ).toThrow(/too few to hold word 0/);
  });

  test("an unlimited approval is flagged as one", () => {
    const max = (1n << 256n) - 1n;
    const approval = decodeApproval({
      address: TOKEN,
      topics: [APPROVAL_TOPIC, topicFor(ALICE), topicFor(BOB)],
      data: `0x${word(max)}`,
      blockNumber: "1",
      blockHash: hash32("b"),
      transactionHash: hash32("t"),
      transactionIndex: 0,
      logIndex: 3,
      removed: false,
    });
    expect({ kind: approval?.kind, unlimited: approval?.unlimited }).toEqual({
      kind: "approval",
      unlimited: true,
    });
  });
});

describe("what a transaction cost", () => {
  const view = (raw: Record<string, unknown>) => projectReceipt(raw, projectLog);

  const baseReceipt = {
    blockNumber: "0xa",
    blockHash: hash32("b"),
    transactionIndex: "0x0",
    gasUsed: "0x5208",
    effectiveGasPrice: "0x3b9aca00",
    logs: [],
  };

  test("on an L1 the fee is the single product", () => {
    const fees = feeBreakdown(baseReceipt, view(baseReceipt));
    expect({ model: fees.model, total: fees.totalFeeWei }).toEqual({
      model: "eip1559",
      total: (21_000n * 1_000_000_000n).toString(),
    });
  });

  test("on an OP-stack chain the L1 data fee is ADDED, because it is charged separately", () => {
    const receipt = { ...baseReceipt, l1Fee: "0x2386f26fc10000" };
    const fees = feeBreakdown(receipt, view(receipt));
    expect(fees.model).toBe("op-stack");
    expect(fees.totalFeeWei).toBe((21_000n * 1_000_000_000n + 10_000_000_000_000_000n).toString());
  });

  test("on Arbitrum the L1 share is already inside gasUsed, so nothing is added", () => {
    const receipt = { ...baseReceipt, gasUsedForL1: "0x2710" };
    const fees = feeBreakdown(receipt, view(receipt));
    expect({ model: fees.model, total: fees.totalFeeWei, l1: fees.l1FeeWei }).toEqual({
      model: "arbitrum",
      total: (21_000n * 1_000_000_000n).toString(),
      l1: null,
    });
  });

  test("a receipt with no effectiveGasPrice reports no fee rather than a zero one", () => {
    const receipt = { ...baseReceipt, effectiveGasPrice: undefined };
    const fees = feeBreakdown(receipt, view(receipt));
    expect({ model: fees.model, total: fees.totalFeeWei }).toEqual({
      model: "unknown",
      total: null,
    });
  });

  test("a pre-Byzantium receipt has no status, and that is not the same as failing", () => {
    const receipt = { ...baseReceipt, status: undefined, root: hash32("state-root") };
    const projected = view(receipt);
    expect(projected.status).toBe("unknown");
    expect(projected.statusReason).toContain("pre-Byzantium");
  });

  test("status 0x0 is reverted and 0x1 is success, in both zero-padded spellings", () => {
    expect(view({ ...baseReceipt, status: "0x0" }).status).toBe("reverted");
    expect(view({ ...baseReceipt, status: "0x00" }).status).toBe("reverted");
    expect(view({ ...baseReceipt, status: "0x1" }).status).toBe("success");
    expect(view({ ...baseReceipt, status: "0x01" }).status).toBe("success");
  });
});

describe("refusals carry their reason", () => {
  test("a ChainReadError is recognisable, so a caller can tell a refusal from a crash", () => {
    expect(() => hexToBigint("nope", "x")).toThrow(ChainReadError);
  });
});
