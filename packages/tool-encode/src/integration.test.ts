/**
 * The tools driven the way the runtime drives them: registered in a catalog,
 * dispatched through `executeTool`, which validates the input against the
 * declared schema and checks the permission patterns before calling execute.
 *
 * A tool that works when called directly but fails here is a tool the runtime
 * cannot actually use, which is why this file exists separately.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { ENCODE_TOOLS } from "./index";

/** iss crewhaus, aud api, sub u1, nbf 1_700_000_000, exp 1_800_000_000, secret "topsecret". */
const CLAIMS_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1MSIsImlzcyI6ImNyZXdoYXVzIiwiYXVkIjoiYXBpIiwiZXhwIjoxODAwMDAwMDAwLCJuYmYiOjE3MDAwMDAwMDAsImlhdCI6MTcwMDAwMDAwMH0.wwjyUCuZTvM819X6zcW_gQCOv1NcAJGA28KSTKSQ5oc";

let catalog: ToolCatalog;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of ENCODE_TOOLS) catalog.register(tool);
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(ENCODE_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of ENCODE_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("a valid call returns a non-error result", async () => {
    const result = await executeTool(lookup("Hash"), { text: "abc" }, { toolUseId: "t1" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("ba7816bf");
  });

  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await executeTool(lookup("Hash"), { text: 42 }, { toolUseId: "t2" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Hash");
  });

  test("a missing required field is rejected", async () => {
    const result = await executeTool(lookup("Hmac"), { message: "x" }, { toolUseId: "t3" });
    expect(result.isError).toBe(true);
  });

  test("an unknown enum member is rejected", async () => {
    const result = await executeTool(
      lookup("Checksum"),
      { text: "x", algorithm: "crc16" },
      { toolUseId: "t4" },
    );
    expect(result.isError).toBe(true);
  });

  test("permission patterns gate the call", async () => {
    const denied = await executeTool(
      lookup("Slugify"),
      { text: "x" },
      { toolUseId: "t5", allowedPatterns: ["Read"] },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("not permitted");
  });

  test("an explicit allow lets it through", async () => {
    const allowed = await executeTool(
      lookup("Slugify"),
      { text: "x" },
      { toolUseId: "t6", allowedPatterns: ["Slugify"] },
    );
    expect(allowed.isError).toBe(false);
  });

  test("every tool survives a schema-valid call — none throws out of execute", async () => {
    const calls: Record<string, unknown> = {
      Base64Decode: { data: "aGk=" },
      Base64Encode: { text: "hi" },
      Checksum: { text: "123456789" },
      Hash: { text: "abc" },
      HexDecode: { hex: "6869" },
      HexEncode: { text: "hi" },
      Hmac: { message: "payload", key: "secret" },
      JwtDecode: { token: CLAIMS_JWT },
      JwtVerify: { token: CLAIMS_JWT, secret: "topsecret", now: 1_700_000_100 },
      NanoId: { seed: "s" },
      Slugify: { text: "Hello World" },
      Ulid: { timestamp: 1_000, seed: "s" },
      UrlBuild: { scheme: "https", host: "e.test" },
      UrlDecode: { text: "a%20b" },
      UrlEncode: { text: "a b" },
      UrlNormalize: { url: "https://E.test/a/../b" },
      UrlParse: { url: "https://e.test/a?b=1" },
      Uuid: { version: "v5", namespace: "dns", name: "python.org" },
    };
    // Every registered tool must appear above; a new tool without a call here
    // would otherwise go unexercised.
    expect(Object.keys(calls).sort()).toEqual(ENCODE_TOOLS.map((t) => t.name).sort());
    for (const tool of ENCODE_TOOLS) {
      const result = await executeTool(tool, calls[tool.name], { toolUseId: `x-${tool.name}` });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });

  test("results are deterministic — the same call twice gives the same bytes", async () => {
    for (const [name, args] of [
      ["Hash", { text: "abc", algorithm: "sha512" }],
      ["Uuid", { version: "v5", namespace: "url", name: "https://crewhaus.ai" }],
      ["Ulid", { timestamp: 1_469_918_176_385, seed: "release" }],
      ["NanoId", { seed: "release", size: 12 }],
      ["JwtVerify", { token: CLAIMS_JWT, secret: "topsecret", now: 1_700_000_100 }],
    ] as const) {
      const a = await executeTool(lookup(name), args, { toolUseId: `d1-${name}` });
      const b = await executeTool(lookup(name), args, { toolUseId: `d2-${name}` });
      expect({ name, same: a.content === b.content }).toEqual({ name, same: true });
    }
  });

  test("the one non-deterministic path is the unseeded v4, and it is labelled", async () => {
    const a = await executeTool(lookup("Uuid"), {}, { toolUseId: "r1" });
    const b = await executeTool(lookup("Uuid"), {}, { toolUseId: "r2" });
    expect(a.content).not.toBe(b.content);
    expect(a.content).toContain('"deterministic":false');
  });

  test("a caller mistake comes back as a readable result, not an error result", async () => {
    const result = await executeTool(
      lookup("Base64Decode"),
      { data: "not base64!!" },
      { toolUseId: "m1" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("not valid base64");
  });

  test("a hash and its hmac round-trip through the catalog end to end", async () => {
    const signature = await executeTool(
      lookup("Hmac"),
      { message: "body", key: "k", encoding: "base64" },
      { toolUseId: "s1" },
    );
    const parsed = JSON.parse(signature.content) as { signature: string };
    const verified = await executeTool(
      lookup("Hmac"),
      { message: "body", key: "k", encoding: "base64", expected: parsed.signature },
      { toolUseId: "s2" },
    );
    expect(verified.content).toContain('"matches":true');
  });
});
