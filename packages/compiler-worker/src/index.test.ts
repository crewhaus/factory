import { describe, expect, test } from "bun:test";
import worker from "./index";

const env = {
  ALLOWED_ORIGINS: "https://studio.crewhaus.dev",
  MAX_BODY_BYTES: "262144",
};

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://compiler.crewhaus.dev${path}`, {
    headers: { origin: "https://studio.crewhaus.dev", ...init?.headers },
    ...init,
  });
}

describe("compiler-worker", () => {
  test("GET /health → 200", async () => {
    const res = await worker.fetch(request("/health"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("OPTIONS preflight returns CORS headers", async () => {
    const res = await worker.fetch(request("/compile", { method: "OPTIONS" }), env);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://studio.crewhaus.dev");
  });

  test("POST /compile with valid CLI spec returns a bundle", async () => {
    const yaml = `
name: hello-cli
target: cli
agent:
  model: claude-haiku-4-5-20251001
  instructions: You are a helpful assistant.
`;
    const res = await worker.fetch(
      request("/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bundle: { files: { path: string }[] } };
    expect(body.bundle).toBeDefined();
    expect(Array.isArray(body.bundle.files)).toBe(true);
    expect(body.bundle.files.some((f) => f.path === "agent.ts")).toBe(true);
  });

  test("POST /compile emitAs:cf-worker with a CLI spec returns a worker.js bundle", async () => {
    const yaml = `
name: hello-cli
target: cli
agent:
  model: claude-haiku-4-5-20251001
  instructions: You are a helpful assistant.
`;
    const res = await worker.fetch(
      request("/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml, emitAs: "cf-worker" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bundle: { files: { path: string; content: string }[] };
    };
    const file = body.bundle.files.find((f) => f.path === "worker.js");
    expect(file).toBeDefined();
    expect(file?.content).toContain("api.anthropic.com");
  });

  test("POST /compile emitAs:cf-worker with a workflow spec returns a worker.js bundle", async () => {
    const yaml = `
name: hello-workflow
target: workflow
model: claude-haiku-4-5-20251001
steps:
  - name: research
    instructions: Research the topic thoroughly.
  - name: summarize
    instructions: Summarize what you found.
`;
    const res = await worker.fetch(
      request("/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml, emitAs: "cf-worker" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bundle: { files: { path: string; content: string }[] };
    };
    const file = body.bundle.files.find((f) => f.path === "worker.js");
    expect(file).toBeDefined();
    expect(file?.content).toContain("api.anthropic.com");
  });

  test("POST /compile emitAs:cf-worker with a graph spec returns a worker.js bundle", async () => {
    const yaml = `
name: hello-graph
target: graph
model: claude-haiku-4-5-20251001
entry: plan
nodes:
  plan:
    instructions: Plan the work.
  execute:
    instructions: Execute the plan.
  summarise:
    instructions: Summarise the result.
edges:
  - from: plan
    to: execute
  - from: execute
    to: summarise
`;
    const res = await worker.fetch(
      request("/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml, emitAs: "cf-worker" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bundle: { files: { path: string; content: string }[] };
    };
    const file = body.bundle.files.find((f) => f.path === "worker.js");
    expect(file).toBeDefined();
    expect(file?.content).toContain("api.anthropic.com");
  });

  test("POST /compile emitAs:cf-worker with an unsupported target returns 400 UNSUPPORTED_TARGET", async () => {
    const yaml = `
name: voice-agent
target: voice
agent:
  model: claude-haiku-4-5-20251001
  instructions: You are a voice assistant.
voice:
  provider: openai
`;
    const res = await worker.fetch(
      request("/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml, emitAs: "cf-worker" }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNSUPPORTED_TARGET");
  });

  test("POST /compile with malformed YAML returns 400 PARSE", async () => {
    const res = await worker.fetch(
      request("/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml: "not: valid: yaml: at all:" }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PARSE");
  });

  test("POST /validate with valid spec returns { ok: true }", async () => {
    const yaml = `
name: hello-cli
target: cli
agent:
  model: claude-haiku-4-5-20251001
  instructions: You are a helpful assistant.
`;
    const res = await worker.fetch(
      request("/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("unknown route → 404", async () => {
    const res = await worker.fetch(request("/nope"), env);
    expect(res.status).toBe(404);
  });

  test("oversize body is rejected", async () => {
    const huge = JSON.stringify({ yaml: "x".repeat(300_000) });
    const res = await worker.fetch(
      request("/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json", "content-length": String(huge.length) },
        body: huge,
      }),
      env,
    );
    expect(res.status).toBe(500);
  });

  test("CORS: unknown origin gets first allowed origin", async () => {
    const res = await worker.fetch(
      request("/health", { headers: { origin: "https://evil.example.com" } }),
      env,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("https://studio.crewhaus.dev");
  });

  test("OPTIONS preflight allows Authorization + PUT (for /cf proxy)", async () => {
    const res = await worker.fetch(request("/cf/accounts", { method: "OPTIONS" }), env);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(res.headers.get("access-control-allow-methods")).toContain("PUT");
  });

  test("/cf/* proxies to api.cloudflare.com, forwarding the token", async () => {
    const orig = globalThis.fetch;
    let captured: { url: string; auth: string | null } = { url: "", auth: null };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: typeof input === "string" ? input : String(input),
        auth: new Headers(init?.headers).get("Authorization"),
      };
      return new Response(JSON.stringify({ success: true, result: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const res = await worker.fetch(
        request("/cf/accounts", { method: "GET", headers: { Authorization: "Bearer tkn" } }),
        env,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://studio.crewhaus.dev");
      expect(captured.url).toBe("https://api.cloudflare.com/client/v4/accounts");
      expect(captured.auth).toBe("Bearer tkn");
    } finally {
      globalThis.fetch = orig;
    }
  });
});
