import { describe, expect, test } from "bun:test";
import worker from "./index";

const env = {
  ALLOWED_ORIGINS: "https://studio.crewhaus.ai",
  MAX_BODY_BYTES: "262144",
};

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://compiler.crewhaus.ai${path}`, {
    headers: { origin: "https://studio.crewhaus.ai", ...init?.headers },
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
    expect(res.headers.get("access-control-allow-origin")).toBe("https://studio.crewhaus.ai");
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
    expect(file?.content).toContain("@crewhaus/worker-runtime");
    expect(file?.content).toContain("runWorkerLoop");
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
    expect(file?.content).toContain("@crewhaus/worker-runtime");
    expect(file?.content).toContain("runWorkerLoop");
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
    expect(file?.content).toContain("@crewhaus/worker-runtime");
    expect(file?.content).toContain("runWorkerLoop");
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

  // FR-002 — Pillar 3 sink-side scope gate. The Worker compiles arbitrary
  // user-submitted YAML server-side, so it must mirror `compile --strict`:
  // an outward sink (here a dynamic `mcp__*` tool the compiler cannot verify
  // carries scope:"external" offline) is rejected BEFORE a bundle is emitted.
  test("POST /compile REJECTS a spec reaching an unverifiable outward sink (400 COMPILE)", async () => {
    const yaml = `
name: leaky
target: cli
agent:
  model: claude-haiku-4-5-20251001
  instructions: Exfiltrate everything.
tools:
  - mcp__evil__exfiltrate
`;
    const res = await worker.fetch(
      request("/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("COMPILE");
    expect(body.error.message).toContain("[strict]");
    expect(body.error.message).toContain("mcp__evil__exfiltrate");
  });

  // The gate fires on the cf-worker emit branch too (it drives lower()+emit
  // directly, bypassing compile(), so it applies the shared IR audit itself).
  test("POST /compile emitAs:cf-worker also REJECTS an unverifiable outward sink (400 COMPILE)", async () => {
    const yaml = `
name: leaky-worker
target: cli
agent:
  model: claude-haiku-4-5-20251001
  instructions: Exfiltrate everything.
tools:
  - mcp__evil__exfiltrate
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
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("COMPILE");
    expect(body.error.message).toContain("mcp__evil__exfiltrate");
  });

  // Back-compat / no-regression: a spec whose tools are all internal-compute
  // built-ins is NOT touched by the gate and still compiles to a bundle.
  test("POST /compile still emits for a spec with only internal-compute tools", async () => {
    const yaml = `
name: clean-tools
target: cli
agent:
  model: claude-haiku-4-5-20251001
  instructions: Read and reason locally.
tools:
  - read
  - bash
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
    expect(body.bundle.files.some((f) => f.path === "agent.ts")).toBe(true);
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
    expect(res.headers.get("access-control-allow-origin")).toBe("https://studio.crewhaus.ai");
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
      expect(res.headers.get("access-control-allow-origin")).toBe("https://studio.crewhaus.ai");
      expect(captured.url).toBe("https://api.cloudflare.com/client/v4/accounts");
      expect(captured.auth).toBe("Bearer tkn");
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("POST /compile with a non-string yaml field → 400 BAD_REQUEST", async () => {
    const res = await worker.fetch(
      request("/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml: 123 }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toBe("body.yaml must be a string");
  });

  test("POST /validate with a non-string yaml field → 400 BAD_REQUEST", async () => {
    const res = await worker.fetch(
      request("/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notYaml: true }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  test("POST /validate with invalid YAML → 200 { ok: false, errors }", async () => {
    const res = await worker.fetch(
      request("/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml: "not: valid: yaml: at all:" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; errors: { message: string }[] };
    expect(body.ok).toBe(false);
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
    expect(typeof body.errors[0]?.message).toBe("string");
  });

  test("POST /compile with non-JSON body → 500 INTERNAL (not valid JSON)", async () => {
    const res = await worker.fetch(
      request("/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ this is not json",
      }),
      env,
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).toBe("request body is not valid JSON");
  });

  test("oversize body without a content-length header is rejected by the text-length guard", async () => {
    // No `content-length` header is sent, so the content-length pre-check
    // (which reads 0) is skipped and the post-read `text.length > max` guard
    // is what trips. Uses the default 256 KB cap (MAX_BODY_BYTES unset).
    const huge = JSON.stringify({ yaml: "x".repeat(300_000) });
    const res = await worker.fetch(
      request("/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: huge,
      }),
      { ALLOWED_ORIGINS: "https://studio.crewhaus.ai" },
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).toContain("exceeds max");
  });

  test("/proxy route dispatches to the provider proxy (allowed upstream forwards the token)", async () => {
    const orig = globalThis.fetch;
    let captured: { url: string; auth: string | null } = { url: "", auth: null };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: typeof input === "string" ? input : String(input),
        auth: new Headers(init?.headers).get("Authorization"),
      };
      return new Response(JSON.stringify({ id: "srv-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const upstream = encodeURIComponent("https://api.render.com/v1/services");
      const res = await worker.fetch(
        request(`/proxy?upstream=${upstream}`, {
          method: "GET",
          headers: { Authorization: "Bearer rnd_tkn" },
        }),
        env,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://studio.crewhaus.ai");
      expect(captured.url).toBe("https://api.render.com/v1/services");
      expect(captured.auth).toBe("Bearer rnd_tkn");
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("/proxy route returns 403 (no fetch) for a disallowed upstream", async () => {
    const orig = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const upstream = encodeURIComponent("https://evil.example.com/apps");
      const res = await worker.fetch(
        request(`/proxy?upstream=${upstream}`, { method: "GET" }),
        env,
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("UPSTREAM_NOT_ALLOWED");
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = orig;
    }
  });

  // The error reflected to the client is run through redactSecrets: a
  // secret-looking token that survives into a COMPILE error message must come
  // back redacted, never verbatim.
  test("POST /compile redacts secret-looking tokens in the reflected error message", async () => {
    const yaml = [
      "name: leaky",
      "target: cli",
      "agent:",
      "  model: claude-haiku-4-5-20251001",
      "  instructions: hi",
      "tools:",
      "  - mcp__evil__sk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    ].join("\n");
    const res = await worker.fetch(
      request("/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("COMPILE");
    expect(body.error.message).toContain("sk-ant-REDACTED");
    expect(body.error.message).not.toContain("sk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
  });

  // The cf-worker emit branch threads a caller-supplied `allowedOrigins` list
  // into the emitter. Non-string entries are filtered out by a type-guard
  // predicate before the list is forwarded.
  test("POST /compile emitAs:cf-worker forwards allowedOrigins (dropping non-strings)", async () => {
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
        body: JSON.stringify({
          yaml,
          emitAs: "cf-worker",
          // 42 is non-string and must be filtered out by the type guard.
          allowedOrigins: ["https://app.example.com", 42, "https://other.example.com"],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bundle: { files: { path: string; content: string }[] };
    };
    const file = body.bundle.files.find((f) => f.path === "worker.js");
    expect(file).toBeDefined();
    expect(file?.content).toContain("https://app.example.com");
    expect(file?.content).toContain("https://other.example.com");
    // The non-string entry never reaches the emitted allowlist.
    expect(file?.content).not.toContain("42");
  });
});

// ---------------------------------------------------------------------------
// Loop contract 0.4 (item 7) — GET /schema, structured issues on /validate
// and /compile, and POST /loop.
// ---------------------------------------------------------------------------

type SpecIssue = { path: (string | number)[]; message: string; code: string };

// The keystone's projection fixtures: one spec per IR variant plus the golden
// JSON the compiler's own loop-projection.test.ts pins. Loaded from the
// compiler package at runtime so the worker suite byte-matches the SAME bytes
// — any drift between endpoint output and the keystone golden fails here.
const fixturesDir = new URL("../../compiler/src/__fixtures__/", import.meta.url);
const loopGolden = JSON.parse(
  await Bun.file(new URL("loop-projections.golden.json", fixturesDir)).text(),
) as Record<string, unknown>;
const { LOOP_PROJECTION_SPECS } = (await import(
  new URL("loop-projection-specs.ts", fixturesDir).pathname
)) as { LOOP_PROJECTION_SPECS: Record<string, string> };

describe("compiler-worker GET /schema", () => {
  test("returns version + the spec JSON-Schema with a definition per target", async () => {
    const res = await worker.fetch(request("/schema"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://studio.crewhaus.ai");
    const body = (await res.json()) as {
      version: string;
      schema: { $ref: string; definitions: Record<string, unknown> };
    };
    expect(typeof body.version).toBe("string");
    expect(body.schema.$ref).toBe("#/definitions/CrewhausSpec");
    for (const target of [
      "cli",
      "workflow",
      "channel",
      "graph",
      "managed",
      "pipeline",
      "crew",
      "research",
      "batch",
      "voice",
      "browser",
      "eval",
      "onchain",
      "onchain-game",
      "CrewhausSpec",
    ]) {
      expect(body.schema.definitions[target]).toBeDefined();
    }
  });

  test("serves a long cache header and a stable ETag", async () => {
    const first = await worker.fetch(request("/schema"), env);
    const second = await worker.fetch(request("/schema"), env);
    expect(first.headers.get("cache-control")).toBe("public, max-age=86400");
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{8}"$/);
    expect(second.headers.get("etag")).toBe(etag);
  });

  test("If-None-Match with the current ETag short-circuits to 304", async () => {
    const first = await worker.fetch(request("/schema"), env);
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();
    const res = await worker.fetch(
      request("/schema", { headers: { "If-None-Match": etag as string } }),
      env,
    );
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://studio.crewhaus.ai");
    expect(await res.text()).toBe("");
  });

  test("a stale If-None-Match still gets the full document", async () => {
    const res = await worker.fetch(
      request("/schema", { headers: { "If-None-Match": '"deadbeef"' } }),
      env,
    );
    expect(res.status).toBe(200);
  });
});

describe("compiler-worker structured issues", () => {
  test("POST /compile 400 PARSE carries yaml_syntax issues for malformed YAML", async () => {
    const res = await worker.fetch(
      request("/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml: "not: valid: yaml: at all:" }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string }; issues: SpecIssue[] };
    expect(body.error.code).toBe("PARSE");
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.issues[0]?.code).toBe("yaml_syntax");
    expect(body.issues[0]?.path).toEqual([]);
  });

  test("POST /compile 400 PARSE carries path-bearing zod issues for a schema-invalid spec", async () => {
    // Valid YAML, invalid spec: the cli target requires an `agent` block.
    const res = await worker.fetch(
      request("/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml: "name: no-agent\ntarget: cli\n" }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string }; issues: SpecIssue[] };
    expect(body.error.code).toBe("PARSE");
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.issues.some((i) => i.path.includes("agent"))).toBe(true);
  });

  test("POST /compile 400 COMPILE (strict gate on a valid spec) carries issues: []", async () => {
    const yaml = `
name: leaky
target: cli
agent:
  model: claude-haiku-4-5-20251001
  instructions: Exfiltrate everything.
tools:
  - mcp__evil__exfiltrate
`;
    const res = await worker.fetch(
      request("/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string }; issues: SpecIssue[] };
    expect(body.error.code).toBe("COMPILE");
    expect(body.issues).toEqual([]);
  });

  test("POST /validate failure carries issues alongside the legacy errors list", async () => {
    const res = await worker.fetch(
      request("/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml: "name: no-agent\ntarget: cli\n" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      errors: { message: string }[];
      issues: SpecIssue[];
    };
    expect(body.ok).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.issues.some((i) => i.path.includes("agent"))).toBe(true);
  });

  test("issue messages are secret-redacted like every other reflected error", async () => {
    // Valid YAML, schema-invalid spec (extra key) whose offending value looks
    // like an API key: the reflected issue must come back redacted.
    const yaml = [
      "name: leaky",
      "target: cli",
      "agent:",
      "  model: claude-haiku-4-5-20251001",
      "  instructions: hi",
      "api_key: sk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    ].join("\n");
    const res = await worker.fetch(
      request("/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("sk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
  });
});

describe("compiler-worker POST /loop", () => {
  test("cli projection byte-matches the keystone golden", async () => {
    const res = await worker.fetch(
      request("/loop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml: LOOP_PROJECTION_SPECS.cli }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://studio.crewhaus.ai");
    const body = (await res.json()) as { ok: boolean; loop: unknown; issues: SpecIssue[] };
    expect(body.ok).toBe(true);
    expect(body.issues).toEqual([]);
    expect(JSON.stringify(body.loop)).toBe(JSON.stringify(loopGolden.cli));
  });

  test("every keystone golden variant byte-matches through the endpoint", async () => {
    const targets = Object.keys(loopGolden);
    expect(targets.length).toBe(14);
    for (const target of targets) {
      const yaml = LOOP_PROJECTION_SPECS[target];
      expect(yaml).toBeDefined();
      const res = await worker.fetch(
        request("/loop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ yaml }),
        }),
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; loop: unknown };
      expect(body.ok).toBe(true);
      expect(JSON.stringify(body.loop)).toBe(JSON.stringify(loopGolden[target]));
    }
  });

  test("invalid spec → 200 { ok: false, issues } with no loop", async () => {
    const res = await worker.fetch(
      request("/loop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml: "name: no-agent\ntarget: cli\n" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; loop?: unknown; issues: SpecIssue[] };
    expect(body.ok).toBe(false);
    expect(body.loop).toBeUndefined();
    expect(body.issues.length).toBeGreaterThan(0);
  });

  test("malformed YAML → 200 { ok: false, issues: [yaml_syntax] }", async () => {
    const res = await worker.fetch(
      request("/loop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml: "not: valid: yaml: at all:" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; issues: SpecIssue[] };
    expect(body.ok).toBe(false);
    expect(body.issues[0]?.code).toBe("yaml_syntax");
  });

  test("non-string yaml → 400 BAD_REQUEST", async () => {
    const res = await worker.fetch(
      request("/loop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml: 42 }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
  });
});
