/**
 * The two boot bindings a bundle makes for this package, from the spec. The
 * metadata fetch goes through tool-http's gate; its socket is stubbed at that
 * package's own test seam, so nothing here resolves a name or dials out.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { _setDnsLookup, _setRawFetch } from "@crewhaus/tool-http";
import { erc20Balance } from "./index";
import { bindTokenChains, registerTokenConfig } from "./lib/boot";
import { _setChainReader, hasChainReader } from "./lib/chain";
import { _setMetadataFetch, fetchDocument, hasMetadataFetch } from "./lib/uri";

afterEach(() => {
  _setChainReader(undefined);
  _setMetadataFetch(undefined);
  _setDnsLookup(undefined);
  _setRawFetch(undefined);
});

describe("bindTokenChains", () => {
  test("binds the chain reader from the chains block", () => {
    expect(hasChainReader()).toBe(false);
    bindTokenChains({
      chains: [
        {
          chainId: "1",
          rpcUrls: ["https://rpc.example"],
          rpcPolicy: "single",
          finality: { kind: "finalized" },
          reorgTolerant: true,
        },
      ],
    });
    expect(hasChainReader()).toBe(true);
  });
});

describe("bindTokenChains, end to end (C026)", () => {
  const ALICE = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

  test("a compiled bundle's binding reads the chain the spec declares", async () => {
    // 0.7.0 shipped these tools in the cli map with nothing binding the
    // reader, so every call refused. Through the real adapter to a node:
    const methods: string[] = [];
    const node = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const body = (await req.json()) as { id: number; method: string };
        methods.push(body.method);
        return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x5" });
      },
    });
    try {
      bindTokenChains({
        chains: [
          {
            chainId: "1",
            rpcUrls: [`http://127.0.0.1:${node.port}/`],
            rpcPolicy: "single",
            finality: { kind: "finalized" },
            reorgTolerant: true,
          },
        ],
      });
      const out = JSON.parse(
        (await erc20Balance.execute(
          { chainId: 1, token: "native", accounts: [ALICE], batch: false } as never,
          {} as never,
        )) as string,
      );
      expect(out.balances[0].raw).toBe("5");
      expect(methods).toEqual(["eth_getBalance"]);
    } finally {
      node.stop(true);
    }
  });

  test("a chain declared under another id is named, with the id these tools look for", async () => {
    bindTokenChains({
      chains: [
        {
          chainId: "mainnet",
          rpcUrls: ["https://rpc.example"],
          rpcPolicy: "single",
          finality: { kind: "finalized" },
          reorgTolerant: true,
        },
      ],
    });
    await expect(
      erc20Balance.execute(
        { chainId: 1, token: "native", accounts: [ALICE], batch: false } as never,
        {} as never,
      ),
    ).rejects.toThrow(
      'no chain is declared with id "1", so chain 1 cannot be read. The spec declares "mainnet"; the token tools look a chain up by its EIP-155 chain id in decimal, so declare it as id: "1".',
    );
  });
});

describe("registerTokenConfig — the operator's metadata origins", () => {
  test("a block without the list binds nothing", () => {
    registerTokenConfig({});
    expect(hasMetadataFetch()).toBe(false);
  });

  test("plain http is refused, and so are two spellings of the list", () => {
    expect(() => registerTokenConfig({ metadata_origins: ["http://ipfs.example"] })).toThrow(
      'tool_config.token.metadata_origins has "http://ipfs.example", which is not https',
    );
    expect(() =>
      registerTokenConfig({ metadata_origins: ["https://a.example"], metadataOrigins: [] }),
    ).toThrow("Write the list once, as metadata_origins");
  });

  test("a listed origin is read through the gate; any other is refused", async () => {
    const dialled: string[] = [];
    _setDnsLookup(async () => ({ address: "93.184.216.34", family: 4 }));
    _setRawFetch(async (req) => {
      dialled.push(req.url);
      return new Response(JSON.stringify({ name: "#1" }), {
        headers: { "content-type": "application/json" },
      });
    });
    registerTokenConfig({ metadata_origins: ["https://metadata.example"] });
    const doc = await fetchDocument("https://metadata.example/1.json", 1024);
    expect(JSON.parse(new TextDecoder().decode(doc.bytes))).toEqual({ name: "#1" });
    await expect(fetchDocument("https://attacker.example/steal", 1024)).rejects.toThrow(
      'origin "https://attacker.example" is not in allowed_origins',
    );
    expect(dialled).toEqual(["https://metadata.example/1.json"]);
  });
});
