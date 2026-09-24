/**
 * The two boot bindings a bundle makes for this package, from the spec. The
 * metadata fetch goes through tool-http's gate; its socket is stubbed at that
 * package's own test seam, so nothing here resolves a name or dials out.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { _setDnsLookup, _setRawFetch } from "@crewhaus/tool-http";
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
