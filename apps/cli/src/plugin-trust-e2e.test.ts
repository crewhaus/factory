/**
 * extension-path#0 end to end: `crewhaus run` loads a SIGNED plugin.
 *
 * In 0.7.0 no boot path had a trust anchor, so a signed plugin was refused and
 * the only way to run any plugin was the unsigned dev mode, which said
 * nothing. Here a throwaway HOME holds a plugin installed the way `crewhaus
 * plugins install` leaves it — a signed manifest with an entrypoint digest and
 * a real index.js — and the publisher's key in `~/.crewhaus/plugin-trust`.
 * An in-test model stub asks for the plugin's tool, and the test reads what
 * the tool returned, so "loaded" means imported, registered and run.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPluginPaths, defaultTrustAnchorDir } from "@crewhaus/plugin-loader";
import { createPluginRegistry } from "@crewhaus/plugin-registry";
import {
  type PluginManifest,
  entrypointDigest,
  manifestPayloadForSigning,
} from "@crewhaus/plugin-sdk";

const CLI_PATH = join(import.meta.dir.replace(/([/\\])dist$/, "$1src"), "index.ts");

// A plugin has no zod of its own here, so its tool carries a JSON Schema for
// the model and a pass-through validator.
const ENTRY = `export default { contributions: { tools: [{ name: "Greet", description: "says hi", jsonSchema: { type: "object", properties: {} }, inputSchema: { safeParse: (v) => ({ success: true, data: v }), parse: (v) => v }, execute: async () => "hi from a plugin" }] } };\n`;

const roots: string[] = [];
afterAll(() => {
  stub.stop(true);
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { pem: publicKey.export({ type: "spki", format: "pem" }).toString(), privateKey };
}

/** Install `greeter` under `home` as `crewhaus plugins install` would; signed when a key is given. */
async function install(home: string, key?: ReturnType<typeof keypair>["privateKey"]) {
  const { pluginsDir, registryPath } = defaultPluginPaths(home);
  const dir = join(pluginsDir, "greeter");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.js"), ENTRY);
  let manifest: PluginManifest = {
    name: "greeter",
    version: "1.0.0",
    entrypointDigest: entrypointDigest(new TextEncoder().encode(ENTRY)),
  };
  if (key !== undefined) {
    const sig = sign(null, Buffer.from(manifestPayloadForSigning(manifest), "utf8"), key);
    manifest = {
      ...manifest,
      signature: { algorithm: "ed25519", publicKeyB64: "unused", sigB64: sig.toString("base64") },
    };
  }
  const sourcePath = join(dir, "plugin.json");
  writeFileSync(sourcePath, JSON.stringify(manifest));
  await createPluginRegistry({ registryPath, allowUnsigned: true }).register({
    manifest,
    sourcePath,
  });
}

// ---- an OpenAI-compatible model stub that calls Greet once ------------------

const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
const base = { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1, model: "stub" };
const captured: string[] = [];

const stub = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const body = JSON.parse(await req.text()) as {
      messages: Array<{ role: string; content?: unknown }>;
    };
    const results = body.messages.filter((m) => m.role === "tool");
    const events =
      results.length > 0
        ? (() => {
            for (const r of results) captured.push(String(r.content));
            return [
              sse({ ...base, choices: [{ index: 0, delta: { content: "done" } }] }),
              sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
            ];
          })()
        : [
            sse({
              ...base,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_0",
                        type: "function",
                        function: { name: "Greet", arguments: "{}" },
                      },
                    ],
                  },
                },
              ],
            }),
            sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
          ];
    return new Response(`${events.join("")}data: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  },
});

const SPEC = [
  "name: plugin-trust",
  "target: cli",
  "agent:",
  `  model: local/stub@http://127.0.0.1:${stub.port}/v1`,
  "  instructions: Greet the user with the Greet tool.",
  "plugins:",
  "  - greeter",
  "permissions:",
  "  mode: auto",
  "  rules:",
  "    - { type: alwaysAllow, pattern: Greet }",
  "",
].join("\n");

async function crewhausRun(
  home: string,
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stderr: string; results: string[] }> {
  writeFileSync(join(home, "crewhaus.yaml"), SPEC);
  captured.length = 0;
  const proc = Bun.spawn([process.execPath, CLI_PATH, "run", "crewhaus.yaml", "--prompt", "go"], {
    cwd: home,
    env: { PATH: process.env["PATH"] ?? "", HOME: home, CREWHAUS_NO_REGISTRY: "1", ...env },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stderr, results: [...captured] };
}

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "crewhaus-plugin-trust-"));
  roots.push(home);
  return home;
}

describe("crewhaus run and plugin signatures", () => {
  test("a signed plugin loads against a key in ~/.crewhaus/plugin-trust, with no dev warning", async () => {
    const home = freshHome();
    const publisher = keypair();
    await install(home, publisher.privateKey);
    mkdirSync(defaultTrustAnchorDir(home), { recursive: true });
    writeFileSync(join(defaultTrustAnchorDir(home), "publisher.pem"), publisher.pem);

    const run = await crewhausRun(home);
    expect(run.exitCode).toBe(0);
    expect(run.results).toEqual(["hi from a plugin"]);
    expect(run.stderr).not.toContain("CREWHAUS_PLUGIN_ALLOW_UNSIGNED");
  }, 60_000);

  test("signed by a key nobody trusts, it is refused before anything runs", async () => {
    const home = freshHome();
    const publisher = keypair();
    await install(home, publisher.privateKey);
    mkdirSync(defaultTrustAnchorDir(home), { recursive: true });
    writeFileSync(join(defaultTrustAnchorDir(home), "someone-else.pem"), keypair().pem);

    const run = await crewhausRun(home);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain(
      'plugin manifest "greeter" signature does not verify against any configured trustAnchor',
    );
    expect(run.results).toEqual([]);
  }, 60_000);

  test("an unsigned plugin loads only under the dev opt-in, which says so", async () => {
    const home = freshHome();
    await install(home);

    const refused = await crewhausRun(home);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("no plugin can be verified: no trust anchor is configured");

    const dev = await crewhausRun(home, { CREWHAUS_PLUGIN_ALLOW_UNSIGNED: "1" });
    expect(dev.exitCode).toBe(0);
    expect(dev.results).toEqual(["hi from a plugin"]);
    expect(dev.stderr).toContain(
      "[plugins] CREWHAUS_PLUGIN_ALLOW_UNSIGNED=1 — unsigned plugins load without verification. Development only; unset it in production.",
    );
    expect(dev.stderr).toContain(
      '[plugins] "greeter" is unsigned and loads only because CREWHAUS_PLUGIN_ALLOW_UNSIGNED=1 — development only',
    );
  }, 60_000);
});
