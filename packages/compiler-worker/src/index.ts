import {
  type Bundle,
  SpecParseError,
  assertToolScopesStrict,
  compile,
  lower,
  parseSpec,
} from "@crewhaus/compiler";
import { projectLoop } from "@crewhaus/ir";
import { type SpecIssue, parseSpecIssues, specJsonSchema } from "@crewhaus/spec";
import { emitCfWorkerCli } from "@crewhaus/target-cf-worker-cli";
import { emitCfWorkerGraph } from "@crewhaus/target-cf-worker-graph";
import { emitCfWorkerWorkflow } from "@crewhaus/target-cf-worker-workflow";
import { handleProviderProxy } from "./proxy";

/**
 * compiler-worker — stateless CF Worker that exposes the CrewHaus compiler
 * pipeline over HTTP so the studio PWA can compile specs without a local
 * Bun runtime.
 *
 * Surface:
 *   POST /compile  { yaml: string, applyIrPasses?: boolean }
 *      → 200 { bundle: Bundle }
 *      → 400 { error: { code: "PARSE" | "COMPILE", message, path? }, issues }
 *      `issues` (loop contract 0.4, item 7) is the structured
 *      `parseSpecIssues()` list riding alongside the legacy flattened error
 *      — `[{ path, message, code }]` for PARSE failures, `[]` when the spec
 *      parsed but compilation failed. The compile path is scope-gated
 *      server-side (FR-002, Pillar 3): a spec reaching an outward sink (a
 *      `mcp__*` tool, or a built-in like Fetch / WebFetch / SendMessage)
 *      whose `scope: "external"` cannot be verified offline is refused with
 *      code "COMPILE" — mirroring `compile --strict`.
 *
 *   POST /validate { yaml: string }
 *      → 200 { ok: true }
 *      → 200 { ok: false, errors: [{ message, path? }], issues }
 *
 *   POST /loop     { yaml: string }
 *      → 200 { ok: true, loop: LoopProjection, issues: [] }
 *      → 200 { ok: false, issues }
 *      `loop` is `projectLoop(lower(parseSpec(yaml)))` — the same projection
 *      the compiler goldens pin (packages/compiler/src/__fixtures__/
 *      loop-projections.golden.json) — so the studio can render the
 *      agent-loop ring/canvas without a local compiler.
 *
 *   GET  /schema   → 200 { version, schema } where schema is
 *      `specJsonSchema()` (root $ref → #/definitions/CrewhausSpec plus one
 *      named definition per target shape). The document is a pure function
 *      of the deployed spec package, so it is served with a long
 *      Cache-Control and a content-hash ETag (If-None-Match → 304).
 *
 *   GET  /health   → 200 { ok: true, version }
 *
 *   ALL  /cf/*     → reverse-proxy to api.cloudflare.com. The CF API sends
 *      no CORS headers, so the studio PWA can't call it from the browser;
 *      this Worker (running on the user's own CF account) relays the call
 *      server-side. The caller's CF token rides in the Authorization header.
 *
 *   ALL  /proxy    → host-allowlisted reverse-proxy to {render,fly,railway,
 *      heroku} APIs (host allowlist in proxy.ts; not an open proxy). Same
 *      CORS rationale as /cf — those provider APIs aren't browser-callable.
 *
 * No state, no auth — CORS-locked to the studio origin. Compile time is
 * bounded by CF Worker CPU limit; we benchmark large specs in M0 to
 * ensure they fit comfortably.
 */

type Env = {
  readonly ALLOWED_ORIGINS: string;
  readonly MAX_BODY_BYTES?: string;
};

const VERSION = "0.0.0";
const DEFAULT_MAX_BODY = 262144; // 256 KB

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("origin");
    const cors = buildCorsHeaders(origin, env.ALLOWED_ORIGINS);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, version: VERSION }, 200, cors);
      }
      if (request.method === "GET" && url.pathname === "/schema") {
        return handleSchema(request, cors);
      }
      if (request.method === "POST" && url.pathname === "/compile") {
        return await handleCompile(request, env, cors);
      }
      if (request.method === "POST" && url.pathname === "/validate") {
        return await handleValidate(request, env, cors);
      }
      if (request.method === "POST" && url.pathname === "/loop") {
        return await handleLoop(request, env, cors);
      }
      if (url.pathname === "/cf" || url.pathname.startsWith("/cf/")) {
        return await handleCfProxy(request, cors, url);
      }
      if (url.pathname === "/proxy") {
        return await handleProviderProxy(request, cors, url);
      }
      return jsonResponse({ error: { code: "NOT_FOUND", message: "no route" } }, 404, cors);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse(
        { error: { code: "INTERNAL", message: redactSecrets(message) } },
        500,
        cors,
      );
    }
  },
};

type CompileBody = {
  readonly yaml?: unknown;
  readonly applyIrPasses?: unknown;
  readonly emitAs?: unknown;
  readonly allowedOrigins?: unknown;
};

async function handleCompile(request: Request, env: Env, cors: HeadersInit): Promise<Response> {
  const body = await readJsonBody<CompileBody>(request, env);
  if (typeof body.yaml !== "string") {
    return jsonResponse(
      { error: { code: "BAD_REQUEST", message: "body.yaml must be a string" } },
      400,
      cors,
    );
  }
  const applyIrPasses = body.applyIrPasses === true;
  const emitAs: "local" | "cf-worker" = body.emitAs === "cf-worker" ? "cf-worker" : "local";

  try {
    let bundle: Bundle;
    if (emitAs === "cf-worker") {
      const spec = parseSpec(body.yaml);
      const ir = lower(spec);
      // FR-002 — Pillar 3 sink-side gate. This branch drives lower()+emit
      // directly (bypassing compile()), so apply the SAME offline scope audit
      // compile({ strict: true }) runs over the lowered IR: an outward-reaching
      // sink (a `mcp__*` tool, or a built-in like Fetch/WebFetch/SendMessage)
      // whose scope:"external" cannot be verified offline is rejected here too.
      assertToolScopesStrict(ir);
      const allowedOrigins = Array.isArray(body.allowedOrigins)
        ? body.allowedOrigins.filter((o): o is string => typeof o === "string")
        : undefined;
      const opts = allowedOrigins ? { allowedOrigins } : {};
      // `ir` is the IrNode union; the per-case narrowing on the `target`
      // discriminant hands each emitter its typed variant (Pillar 1: new
      // target shapes are driven from the IR, not re-derived in the target).
      switch (ir.target) {
        case "cli":
          bundle = emitCfWorkerCli(ir, opts);
          break;
        case "workflow":
          bundle = emitCfWorkerWorkflow(ir, opts);
          break;
        case "graph":
          bundle = emitCfWorkerGraph(ir, opts);
          break;
        default:
          return jsonResponse(
            {
              error: {
                code: "UNSUPPORTED_TARGET",
                message: `cf-worker emit supports target=cli|workflow|graph, got ${ir.target}`,
              },
              issues: [],
            },
            400,
            cors,
          );
      }
    } else {
      // FR-002 — Pillar 3 sink-side gate. The Worker compiles arbitrary
      // user-submitted YAML server-side, so it mirrors `compile --strict` /
      // the CLI: { strict: true } refuses to emit a bundle that reaches an
      // outward sink (mcp__*, Fetch/WebFetch/SendMessage, …) whose external
      // scope is unverifiable offline. CompilerError surfaces as 400 COMPILE.
      bundle = compile(body.yaml, { applyIrPasses, strict: true });
    }
    return jsonResponse({ bundle }, 200, cors);
  } catch (err) {
    // Loop contract 0.4 (item 7): every /compile 400 carries the structured
    // `parseSpecIssues()` list alongside the legacy flattened error. PARSE
    // failures get the full issue list; post-parse (COMPILE) failures get []
    // — the spec itself was valid, so there are no spec issues to report.
    if (err instanceof SpecParseError) {
      return jsonResponse(
        {
          error: { code: "PARSE", message: redactSecrets(err.message) },
          issues: specIssuesFor(body.yaml, err),
        },
        400,
        cors,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse(
      { error: { code: "COMPILE", message: redactSecrets(message) }, issues: [] },
      400,
      cors,
    );
  }
}

/**
 * Reverse-proxy for the Cloudflare API. The studio PWA cannot call
 * api.cloudflare.com directly: that API returns no CORS headers, so the
 * browser blocks the request (unlike api.github.com, which is CORS-enabled,
 * and so the GitHub PAT flow needs no proxy). This Worker runs on the user's
 * own Cloudflare account, so it relays the call server-side — where CORS
 * does not apply — and echoes the studio's CORS headers back to the browser.
 *
 * The user's CF API token rides in the Authorization header and is forwarded
 * verbatim to Cloudflare; it is never stored. The upstream base is hardcoded
 * to api.cloudflare.com, so this cannot be used as an open proxy (no SSRF).
 */
async function handleCfProxy(request: Request, cors: HeadersInit, url: URL): Promise<Response> {
  const upstreamPath = url.pathname.slice("/cf".length); // "/accounts/…"
  const upstreamUrl = `https://api.cloudflare.com/client/v4${upstreamPath}${url.search}`;

  const headers = new Headers();
  const auth = request.headers.get("Authorization");
  if (auth) headers.set("Authorization", auth);
  const contentType = request.headers.get("Content-Type");
  if (contentType) headers.set("Content-Type", contentType);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? await request.arrayBuffer() : undefined;

  const upstream = await fetch(upstreamUrl, { method: request.method, headers, body });
  const respBody = await upstream.arrayBuffer();
  return new Response(respBody, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      ...cors,
    },
  });
}

type ValidateBody = { readonly yaml?: unknown };

async function handleValidate(request: Request, env: Env, cors: HeadersInit): Promise<Response> {
  const body = await readJsonBody<ValidateBody>(request, env);
  if (typeof body.yaml !== "string") {
    return jsonResponse(
      { error: { code: "BAD_REQUEST", message: "body.yaml must be a string" } },
      400,
      cors,
    );
  }
  try {
    parseSpec(body.yaml);
    return jsonResponse({ ok: true }, 200, cors);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Legacy flattened `errors` kept verbatim for existing studio callers;
    // `issues` (loop contract 0.4, item 7) is the structured list.
    return jsonResponse(
      {
        ok: false,
        errors: [{ message: redactSecrets(message) }],
        issues: specIssuesFor(body.yaml, err),
      },
      200,
      cors,
    );
  }
}

type LoopBody = { readonly yaml?: unknown };

/**
 * Loop contract 0.4 (item 7) — project a spec onto the agent-loop diagram
 * (ring for the loop-running shapes, canvas for the step/node shapes) so the
 * studio can render it without a local compiler. `projectLoop` is total over
 * all 14 IR variants and never throws; the only failure modes are parse
 * (structured issues) and lowering errors (flattened into one issue).
 */
async function handleLoop(request: Request, env: Env, cors: HeadersInit): Promise<Response> {
  const body = await readJsonBody<LoopBody>(request, env);
  if (typeof body.yaml !== "string") {
    return jsonResponse(
      { error: { code: "BAD_REQUEST", message: "body.yaml must be a string" } },
      400,
      cors,
    );
  }
  try {
    const loop = projectLoop(lower(parseSpec(body.yaml)));
    return jsonResponse({ ok: true, loop, issues: [] }, 200, cors);
  } catch (err) {
    return jsonResponse({ ok: false, issues: specIssuesFor(body.yaml, err) }, 200, cors);
  }
}

/**
 * The structured issue list reflected to the client for a failed parse /
 * lower of `yaml`. SpecParseError → the full `parseSpecIssues()` list (the
 * structured counterpart of the thrown message); anything else (a lowering
 * error on a spec that parsed fine) → one synthetic root-path issue. Issue
 * messages pass through redactSecrets like every other reflected error.
 */
function specIssuesFor(yaml: string, err: unknown): SpecIssue[] {
  const issues = err instanceof SpecParseError ? parseSpecIssues(yaml) : [];
  if (issues.length === 0) {
    const message = err instanceof Error ? err.message : String(err);
    issues.push({ path: [], code: err instanceof SpecParseError ? "parse" : "compile", message });
  }
  return issues.map((issue) => ({ ...issue, message: redactSecrets(issue.message) }));
}

/**
 * GET /schema — the whole spec grammar as a JSON-Schema document (root $ref
 * → #/definitions/CrewhausSpec, one named definition per target shape).
 * `specJsonSchema()` is deterministic and depends only on the deployed spec
 * package, so the serialized body is computed once per isolate and served
 * with a long Cache-Control plus a content-hash ETag; a matching
 * If-None-Match short-circuits to 304.
 */
let schemaCache: { readonly body: string; readonly etag: string } | undefined;

function handleSchema(request: Request, cors: HeadersInit): Response {
  if (schemaCache === undefined) {
    const body = JSON.stringify({ version: VERSION, schema: specJsonSchema() });
    schemaCache = { body, etag: `"${fnv1a(body)}"` };
  }
  const cacheHeaders = {
    ETag: schemaCache.etag,
    "Cache-Control": "public, max-age=86400",
    ...cors,
  };
  if (request.headers.get("If-None-Match") === schemaCache.etag) {
    return new Response(null, { status: 304, headers: cacheHeaders });
  }
  return new Response(schemaCache.body, {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cacheHeaders },
  });
}

/** 32-bit FNV-1a over the serialized schema — a stable content hash for the ETag. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function readJsonBody<T>(request: Request, env: Env): Promise<T> {
  const max = Number(env.MAX_BODY_BYTES ?? DEFAULT_MAX_BODY);
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > max) {
    throw new Error(`request body exceeds max ${max} bytes`);
  }
  const text = await request.text();
  if (text.length > max) {
    throw new Error(`request body exceeds max ${max} bytes`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("request body is not valid JSON");
  }
}

function buildCorsHeaders(origin: string | null, allowed: string): HeadersInit {
  const allowedList = allowed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allow = origin !== null && allowedList.includes(origin) ? origin : (allowedList[0] ?? "*");
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    // `Accept` is needed because the Heroku provider client sends a versioned
    // `Accept: application/vnd.heroku+json; version=3` header on preflighted
    // requests through /proxy; without it the browser blocks the call.
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonResponse(body: unknown, status: number, cors: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...cors,
    },
  });
}

/**
 * Redact patterns that look like API keys before reflecting an error message
 * to the client. The compiler shouldn't see real keys (they're env refs in
 * IR), but defense-in-depth.
 */
function redactSecrets(message: string): string {
  return message
    .replace(/sk-ant-[A-Za-z0-9_\-]{20,}/g, "sk-ant-REDACTED")
    .replace(/sk-[A-Za-z0-9_\-]{20,}/g, "sk-REDACTED")
    .replace(/ghp_[A-Za-z0-9]{20,}/g, "ghp_REDACTED")
    .replace(/gho_[A-Za-z0-9]{20,}/g, "gho_REDACTED");
}
