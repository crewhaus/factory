/**
 * config-delivery#0 end to end, with tool-http: a cli spec restricts
 * HttpRequest to one origin with the documented `tool_config.http` block.
 *
 * In 0.7.0 that block reached nothing — every HttpRequest answered "empty
 * allow-list = deny all", allowed origin or not. Here the same block is
 * proven to reach the tool twice over:
 *
 *   1. The compiled bundle's own lines, EXECUTED: the tool imports and boot
 *      registrations `compile()` emits are run against this checkout's
 *      packages, then HttpRequest is called against two local servers. The
 *      allowed one answers; the other is refused by the allow-list. (The
 *      loopback refusal is lifted with tool-http's test-only flag, so the
 *      allowed call can complete.)
 *   2. `crewhaus run`, as a subprocess, driven by an in-test model stub that
 *      asks for both calls. With the same test-only flag set by a preload,
 *      the allowed origin answers and the other is refused by the allow-list.
 *      With loopback closed, as it ships, the allowed call gets past the
 *      allow-list and stops at the SSRF gate while the other stops at the
 *      allow-list — two different refusals, where 0.7.0 gave one.
 *
 * Assertions read what the tool returned, never the CLI's stdout.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "@crewhaus/compiler";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { __setPrivateHostsAllowedForTest } from "@crewhaus/tool-http";
import { importToolPackage } from "./tool-packages";

const CLI_PATH = join(import.meta.dir.replace(/([/\\])dist$/, "$1src"), "index.ts");

let allowed: ReturnType<typeof Bun.serve>;
let other: ReturnType<typeof Bun.serve>;
let allowedOrigin = "";
let otherOrigin = "";

beforeAll(() => {
  allowed = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("status: up"),
  });
  other = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("should never be reached"),
  });
  allowedOrigin = `http://127.0.0.1:${allowed.port}`;
  otherOrigin = `http://127.0.0.1:${other.port}`;
});

const roots: string[] = [];
afterAll(() => {
  allowed.stop(true);
  other.stop(true);
  stub.stop(true);
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function spec(model: string, block: string): string {
  return [
    "name: http-allowlist",
    "target: cli",
    "agent:",
    `  model: ${model}`,
    "  instructions: Call the internal status API with HttpRequest to check that the service is up.",
    "tools:",
    "  - httpRequest",
    block,
    "permissions:",
    "  mode: auto",
    "  rules:",
    "    - { type: alwaysAllow, pattern: HttpRequest }",
    "",
  ].join("\n");
}

const httpBlock = (origin: string): string =>
  `tool_config:\n  http:\n    allowed_origins: ["${origin}"]`;

/**
 * Run the emitted bundle's tool wiring: its `@crewhaus/*` tool imports are
 * resolved through the CLI's own package loaders, and every boot line (the
 * registrar calls) is executed as written. Returns the registered tools.
 */
async function bootEmitted(agentTs: string): Promise<Record<string, RegisteredTool>> {
  const scope: Record<string, unknown> = {};
  for (const m of agentTs.matchAll(/^import \{ ([^}]+) \} from "(@crewhaus\/[a-z-]+)";$/gm)) {
    const pkg = m[2] as string;
    if (!pkg.startsWith("@crewhaus/tool-") || pkg === "@crewhaus/tool-catalog") continue;
    const mod =
      pkg === "@crewhaus/tool-categories"
        ? ((await import("@crewhaus/tool-categories")) as Record<string, unknown>)
        : await importToolPackage(pkg);
    for (const name of (m[1] as string).split(",").map((s) => s.trim())) scope[name] = mod[name];
  }
  const boot = agentTs
    .split("\n")
    .filter((l) => /^(register\w+Config|bind\w+Chains|applyToolConfig)\(/.test(l));
  expect(boot.length).toBeGreaterThan(0);
  new Function(...Object.keys(scope), "process", boot.join("\n"))(...Object.values(scope), process);
  const tools: Record<string, RegisteredTool> = {};
  for (const m of agentTs.matchAll(/^defaultCatalog\.register\((\w+)\);$/gm)) {
    const tool = scope[m[1] as string] as RegisteredTool;
    tools[tool.name] = tool;
  }
  return tools;
}

describe("the compiled bundle's boot lines, executed against this checkout", () => {
  test("HttpRequest reaches the allowed origin and is refused everywhere else", async () => {
    const agentTs =
      compile(spec("claude-sonnet-4-6", httpBlock(allowedOrigin))).files.find(
        (f) => f.path === "agent.ts",
      )?.content ?? "";
    expect(agentTs).toContain(`registerHttpConfig({"allowed_origins":["${allowedOrigin}"]});`);
    const tools = await bootEmitted(agentTs);
    const httpRequest = tools["HttpRequest"] as RegisteredTool;
    __setPrivateHostsAllowedForTest(true);
    try {
      const ok = JSON.parse(
        (await httpRequest.execute({ url: `${allowedOrigin}/status`, method: "GET" })) as string,
      ) as { status: number; body: string };
      expect(ok.status).toBe(200);
      expect(ok.body).toBe("status: up");
      // A refusal is the tool's answer, not a throw — the model reads it.
      expect(await httpRequest.execute({ url: `${otherOrigin}/steal`, method: "GET" })).toBe(
        `denied: origin "${otherOrigin}" is not in allowed_origins`,
      );
    } finally {
      __setPrivateHostsAllowedForTest(false);
    }
  });

  test("the same block written as $VAR is read from the environment at boot", async () => {
    const agentTs =
      compile(spec("claude-sonnet-4-6", httpBlock("$E2E_STATUS_ORIGIN"))).files.find(
        (f) => f.path === "agent.ts",
      )?.content ?? "";
    expect(agentTs).not.toContain(allowedOrigin);
    Reflect.deleteProperty(process.env, "E2E_STATUS_ORIGIN");
    await expect(bootEmitted(agentTs)).rejects.toThrow(
      "tool_config.http.allowed_origins[0] reads $E2E_STATUS_ORIGIN, but E2E_STATUS_ORIGIN is not set.",
    );
    process.env["E2E_STATUS_ORIGIN"] = allowedOrigin;
    try {
      const httpRequest = (await bootEmitted(agentTs))["HttpRequest"] as RegisteredTool;
      __setPrivateHostsAllowedForTest(true);
      const ok = JSON.parse(
        (await httpRequest.execute({ url: `${allowedOrigin}/status`, method: "GET" })) as string,
      ) as { status: number };
      expect(ok.status).toBe(200);
      expect(await httpRequest.execute({ url: `${otherOrigin}/steal`, method: "GET" })).toBe(
        `denied: origin "${otherOrigin}" is not in allowed_origins`,
      );
    } finally {
      __setPrivateHostsAllowedForTest(false);
      Reflect.deleteProperty(process.env, "E2E_STATUS_ORIGIN");
    }
  });
});

// ---- crewhaus run, driven by an OpenAI-compatible stub ----------------------

const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
const base = { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1, model: "stub" };
let calls: ReadonlyArray<{ url: string }> = [];
/** The tool results each run sent back, captured off the model request. */
const captured: string[] = [];

function toolCallsSse(): string {
  return [
    sse({
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }],
    }),
    ...calls.map((c, i) =>
      sse({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: i,
                  id: `call_${i}`,
                  type: "function",
                  function: {
                    name: "HttpRequest",
                    arguments: JSON.stringify({
                      url: c.url,
                      method: "GET",
                      justification: "check that the internal status API service is up",
                    }),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    ),
    sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    "data: [DONE]\n\n",
  ].join("");
}

function textSse(text: string): string {
  return [
    sse({
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    }),
    sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
  ].join("");
}

const stub = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
      return new Response("not found", { status: 404 });
    }
    const body = JSON.parse(await req.text()) as {
      messages: Array<{ role: string; content?: unknown }>;
    };
    const results = body.messages.filter((m) => m.role === "tool");
    if (results.length > 0) {
      for (const r of results) captured.push(String(r.content));
      return new Response(textSse("done"), { headers: { "content-type": "text/event-stream" } });
    }
    return new Response(toolCallsSse(), { headers: { "content-type": "text/event-stream" } });
  },
});

/**
 * A preload for the `crewhaus run` child that lifts tool-http's loopback
 * refusal with its test-only flag, as the bundle test above does in-process,
 * so the allowed call can reach the local server. It imports the same file
 * the CLI's package loader resolves to, so both see one module.
 */
const LIFT_LOOPBACK = `import { __setPrivateHostsAllowedForTest } from ${JSON.stringify(
  join(import.meta.dir, "..", "..", "..", "packages", "tool-http", "src", "index.ts"),
)};\n__setPrivateHostsAllowedForTest(true);\n`;

async function crewhausRun(
  yaml: string,
  opts: { readonly liftLoopback?: boolean } = {},
): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), "crewhaus-tool-config-e2e-"));
  roots.push(root);
  writeFileSync(join(root, "crewhaus.yaml"), yaml);
  const preload: string[] = [];
  if (opts.liftLoopback === true) {
    writeFileSync(join(root, "lift-loopback.ts"), LIFT_LOOPBACK);
    preload.push("--preload", join(root, "lift-loopback.ts"));
  }
  captured.length = 0;
  const argv = [process.execPath, ...preload, CLI_PATH, "run", "crewhaus.yaml", "--prompt", "go"];
  const proc = Bun.spawn(argv, {
    cwd: root,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: root,
      CREWHAUS_NO_REGISTRY: "1",
      CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION: "1",
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await proc.exited).toBe(0);
  return [...captured];
}

describe("crewhaus run honours the same block", () => {
  test("HttpRequest reaches the allowed origin and is refused everywhere else", async () => {
    calls = [{ url: `${allowedOrigin}/status` }, { url: `${otherOrigin}/steal` }];
    const model = `local/stub@http://127.0.0.1:${stub.port}/v1`;
    const results = await crewhausRun(spec(model, httpBlock(allowedOrigin)), {
      liftLoopback: true,
    });
    expect(results).toHaveLength(2);
    const ok = JSON.parse(results[0] as string) as { status: number; body: string };
    expect(ok.status).toBe(200);
    expect(ok.body).toBe("status: up");
    expect(results[1]).toBe(`denied: origin "${otherOrigin}" is not in allowed_origins`);
  }, 90_000);

  test("with loopback closed, the allowed origin still passes the allow-list and stops at the SSRF gate", async () => {
    calls = [{ url: `${allowedOrigin}/status` }, { url: `${otherOrigin}/steal` }];
    const model = `local/stub@http://127.0.0.1:${stub.port}/v1`;

    const withBlock = await crewhausRun(spec(model, httpBlock(allowedOrigin)));
    expect(withBlock).toHaveLength(2);
    // Past the allow-list, the loopback address is refused by the SSRF gate —
    // a later, different refusal than the one the other origin gets.
    expect(withBlock[0]).toContain('SSRF: host "127.0.0.1" is a private/loopback IP');
    expect(withBlock[1]).toContain(`denied: origin "${otherOrigin}" is not in allowed_origins`);

    // The 0.7.0 behaviour, for contrast: without a delivered block both
    // calls stop at an empty allow-list.
    const without = await crewhausRun(spec(model, ""));
    expect(without).toHaveLength(2);
    for (const r of without) expect(r).toContain("empty allow-list = deny all");
  }, 90_000);
});
