import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createEvmAdapters } from "./index";

let server: ReturnType<typeof Bun.serve>;
let origin = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      if (new URL(req.url).pathname.endsWith("/down")) return new Response("no", { status: 503 });
      const body = (await req.json()) as { id: number };
      return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x10" });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

const chain = (chainId: string, rpcUrls: string[]) => ({
  chainId,
  rpcUrls,
  rpcPolicy: "single" as const,
  finality: { kind: "finalized" as const },
  reorgTolerant: true,
});

describe("createEvmAdapters — one adapter per declared chain", () => {
  test("keys each adapter by its chain id, and each one reads its own endpoint", async () => {
    const adapters = createEvmAdapters([
      chain("1", [`${origin}/a`]),
      chain("8453", [`${origin}/b`]),
    ]);
    expect([...adapters.keys()]).toEqual(["1", "8453"]);
    expect(await adapters.get("8453")?.rpcRead("eth_blockNumber", [])).toBe("0x10");
  });

  test("a URL that is not http(s) is refused by position, without repeating it", () => {
    let message = "";
    try {
      createEvmAdapters([chain("1", ["wss://node.example/v2/SECRETKEY"])]);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("chains[0].rpcUrls[0] is not an absolute http(s) URL");
    expect(message).not.toContain("SECRETKEY");
  });

  test("a repeated chain id is refused", () => {
    expect(() => createEvmAdapters([chain("1", [origin]), chain("1", [origin])])).toThrow(
      'chains[1] repeats chain id "1"',
    );
  });

  test("an HTTP error names the endpoint's origin, never the path a provider keeps its key in", async () => {
    const adapters = createEvmAdapters([chain("1", [`${origin}/v2/SECRETKEY/down`])]);
    let message = "";
    try {
      await adapters.get("1")?.rpcRead("eth_blockNumber", []);
    } catch (err) {
      message = `${(err as Error).message} ${String((err as { cause?: Error }).cause?.message)}`;
    }
    expect(message).toContain(`HTTP 503 from ${origin}`);
    expect(message).not.toContain("SECRETKEY");
  });
});
