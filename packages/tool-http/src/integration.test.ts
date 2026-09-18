/**
 * The tools driven the way the runtime drives them: registered in a catalog
 * and dispatched through `executeTool`, which validates the input against the
 * declared schema and checks the permission patterns before `execute` ever
 * runs.
 *
 * A tool that works when called directly but fails here is a tool the runtime
 * cannot actually use, which is why this file exists separately. The server
 * is a real one on 127.0.0.1, as in `index.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import {
  HTTP_TOOLS,
  __setPrivateHostsAllowedForTest,
  _resetHttpConfig,
  registerHttpConfig,
} from "./index";

const originalCwd = process.cwd();
let catalog: ToolCatalog;
let server: ReturnType<typeof Bun.serve>;
let origin = "";
let tmp: string;

const SECRET_VAR = "CREWHAUS_INT_WEBHOOK_SECRET";

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-http-int-"));
  process.chdir(tmp);
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/robots.txt") {
        return new Response("User-agent: *\nDisallow: /nope/", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (url.pathname === "/sitemap.xml") {
        return new Response("<urlset><url><loc>http://x.test/a</loc></url></urlset>", {
          headers: { "content-type": "application/xml" },
        });
      }
      if (url.pathname === "/feed.xml") {
        return new Response(
          "<rss><channel><title>T</title><item><title>i</title></item></channel></rss>",
          { headers: { "content-type": "application/xml" } },
        );
      }
      if (url.pathname === "/sse") {
        return new Response("event: done\ndata: bye\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.pathname === "/graphql") {
        return new Response(JSON.stringify({ data: { ok: true } }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/items") {
        return new Response(JSON.stringify({ items: [1] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ hello: "world" }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  registerHttpConfig({ allowed_origins: [origin] });
  __setPrivateHostsAllowedForTest(true);
  process.env[SECRET_VAR] = "whsec_int";
  catalog = new ToolCatalog();
  for (const tool of HTTP_TOOLS) catalog.register(tool);
});

afterEach(() => {
  process.chdir(originalCwd);
  server.stop(true);
  rmSync(tmp, { recursive: true, force: true });
  _resetHttpConfig();
  __setPrivateHostsAllowedForTest(false);
  delete process.env[SECRET_VAR];
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(HTTP_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of HTTP_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("a valid call returns a non-error result", async () => {
    const result = await executeTool(
      lookup("HttpRequest"),
      { url: `${origin}/json` },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"status":200');
  });

  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await executeTool(lookup("HttpRequest"), { url: 42 }, { toolUseId: "t2" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("HttpRequest");
  });

  test("a missing required field is rejected", async () => {
    const result = await executeTool(
      lookup("HttpPaginate"),
      { url: `${origin}/items`, style: "link" },
      { toolUseId: "t3" },
    );
    expect(result.isError).toBe(true);
  });

  test("an out-of-range value is rejected by the schema, not clamped by the tool", async () => {
    const result = await executeTool(
      lookup("LinkCheck"),
      { urls: [`${origin}/json`], timeoutMs: 0 },
      { toolUseId: "t4" },
    );
    expect(result.isError).toBe(true);
  });

  test("an unknown enum member is rejected", async () => {
    const result = await executeTool(
      lookup("WebhookSign"),
      { scheme: "stripe", payload: "p", secretEnvVar: SECRET_VAR },
      { toolUseId: "t5" },
    );
    expect(result.isError).toBe(true);
  });

  test("permission patterns gate the call", async () => {
    const denied = await executeTool(
      lookup("UrlReachable"),
      { url: `${origin}/json` },
      { toolUseId: "t6", allowedPatterns: ["Read"] },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("not permitted");
  });

  test("an explicit allow lets it through", async () => {
    const allowed = await executeTool(
      lookup("UrlReachable"),
      { url: `${origin}/json` },
      { toolUseId: "t7", allowedPatterns: ["UrlReachable"] },
    );
    expect(allowed.isError).toBe(false);
  });

  test("a refusal comes back as a normal result the model can read, not a thrown error", async () => {
    const result = await executeTool(
      lookup("HttpRequest"),
      { url: "http://example.com/blocked" },
      { toolUseId: "t8" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("not in allowed_origins");
  });

  test("a per-call tool_config block replaces the registered allow-list for that call", async () => {
    const denied = await executeTool(
      lookup("HttpRequest"),
      { url: `${origin}/json` },
      { toolUseId: "t9", toolConfig: { allowed_origins: ["https://elsewhere.example"] } },
    );
    expect(denied.content).toContain("not in allowed_origins");

    const allowed = await executeTool(
      lookup("HttpRequest"),
      { url: `${origin}/json` },
      { toolUseId: "t10", toolConfig: { allowed_origins: [origin] } },
    );
    expect(allowed.content).toContain('"status":200');
  });

  test("a non-object tool_config override is ignored, never treated as permission", async () => {
    const result = await executeTool(
      lookup("HttpRequest"),
      { url: `${origin}/json` },
      { toolUseId: "t11", toolConfig: "allow everything" },
    );
    expect(result.content).toContain('"status":200');
  });

  test("every tool survives a schema-valid call — none throws out of execute", async () => {
    const calls: Record<string, unknown> = {
      DnsLookup: { name: "127.0.0.1", types: ["A"], timeoutMs: 1_000 },
      DownloadFile: { url: `${origin}/json`, path: "dl.json", timeoutMs: 5_000 },
      FeedParse: { url: `${origin}/feed.xml`, timeoutMs: 5_000 },
      GraphqlQuery: { url: `${origin}/graphql`, query: "{ ok }", timeoutMs: 5_000 },
      HeadRequest: { url: `${origin}/json`, timeoutMs: 5_000 },
      HttpBatch: { requests: [{ url: `${origin}/json` }], timeoutMs: 5_000 },
      HttpPaginate: {
        url: `${origin}/items`,
        style: "link",
        itemsPath: "items",
        maxPages: 2,
        timeoutMs: 5_000,
      },
      HttpRequest: { url: `${origin}/json`, timeoutMs: 5_000 },
      HttpWaitFor: { url: `${origin}/json`, expectStatus: [200], timeoutMs: 2_000 },
      LinkCheck: { urls: [`${origin}/json`], timeoutMs: 5_000 },
      RobotsCheck: { url: `${origin}/nope/x`, timeoutMs: 5_000 },
      SitemapParse: { url: `${origin}/sitemap.xml`, timeoutMs: 5_000 },
      SseRead: { url: `${origin}/sse`, timeoutMs: 2_000, maxEvents: 5 },
      TlsInspect: { host: "127.0.0.1", port: server.port, timeoutMs: 1_000 },
      UrlReachable: { url: `${origin}/json`, timeoutMs: 5_000 },
      WebhookSign: {
        scheme: "body",
        payload: "p",
        secretEnvVar: SECRET_VAR,
      },
      WebhookVerify: {
        scheme: "body",
        payload: "p",
        signatureHeader: "sha256=00",
        secretEnvVar: SECRET_VAR,
      },
    };
    expect(Object.keys(calls).sort()).toEqual(HTTP_TOOLS.map((t) => t.name).sort());

    for (const tool of HTTP_TOOLS) {
      const result = await executeTool(tool, calls[tool.name], { toolUseId: `all-${tool.name}` });
      // A world-level failure (a plaintext port refusing a TLS handshake, say)
      // must still come back as a readable result rather than a thrown error.
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
      expect(typeof result.content).toBe("string");
    }
  });
});
