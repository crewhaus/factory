/**
 * extension-path#12 (C171): plugin-sdk declares five extension points, and
 * its docs, the loader's and runtime-core's said each was wired into its
 * host. Only tools are. A plugin contributing a channel, model, grader or
 * target emitter activated with no word that the contribution does nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRegistry } from "@crewhaus/plugin-registry";
import { z } from "zod";
import { UNBOUND_CONTRIBUTION_KINDS, activatePlugins, createPluginLoader } from "./index";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plugin-unbound-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function activate(contributions: unknown, warn?: (line: string) => void) {
  const registry = createPluginRegistry({
    registryPath: join(root, "registry.json"),
    allowUnsigned: true,
  });
  mkdirSync(join(root, "chanplug"), { recursive: true });
  writeFileSync(join(root, "chanplug", "index.js"), "export default {};\n");
  const manifest = { name: "chanplug", version: "1.0.0" };
  writeFileSync(join(root, "chanplug", "plugin.json"), JSON.stringify(manifest));
  await registry.register({ manifest, sourcePath: join(root, "chanplug", "plugin.json") });
  const loader = createPluginLoader({
    trustedRoots: [root],
    allowUnsigned: true,
    warn: () => {},
    importEntrypoint: async () => ({ default: { contributions } }),
  });
  return activatePlugins({
    names: ["chanplug"],
    registry,
    loader,
    ...(warn !== undefined ? { warn } : {}),
  });
}

const channel = (id: string) => ({
  id,
  verify: async () => true,
  parseInbound: async () => ({}),
  sendReply: async () => {},
});
const model = { id: "my-model", features: {}, stream: async function* () {} };
const grader = { id: "my-grader", grade: async () => ({ pass: true }) };
const emitter = { targetShape: "my-shape", emit: () => ({ files: [] }) };
const tool = {
  name: "hi",
  description: "hi",
  inputSchema: z.object({}),
  execute: async () => "hi",
};

describe("a contribution nothing binds is called that at boot (C171)", () => {
  test("each unbound kind is named, with its ids and where to go instead; the tool still loads", async () => {
    const warned: string[] = [];
    const activated = await activate(
      {
        tools: [tool],
        channels: [channel("mastodon")],
        models: [model],
        graders: [grader],
        targetEmitters: [emitter],
      },
      (l) => warned.push(l),
    );
    expect(activated.tools.map((t) => t.name)).toEqual(["hi"]);
    expect(activated.warnings).toEqual([
      'plugin "chanplug" contributes 1 channel ("mastodon"), which has no effect: a channel daemon\'s adapters are built into it from the spec, and it does not read a plugin\'s. Only a plugin\'s tools and its skills/ directory are used.',
      'plugin "chanplug" contributes 1 model ("my-model"), which has no effect: models are resolved from the spec by the model router, which does not read a plugin\'s adapters. Only a plugin\'s tools and its skills/ directory are used.',
      'plugin "chanplug" contributes 1 grader ("my-grader"), which has no effect: graders are loaded from .crewhaus/graders/<name>/index.ts (a default export of { name, grader }), not from a plugin. Only a plugin\'s tools and its skills/ directory are used.',
      'plugin "chanplug" contributes 1 target emitter ("my-shape"), which has no effect: target shapes are part of the crewhaus compiler, which does not read a plugin\'s emitters. Only a plugin\'s tools and its skills/ directory are used.',
    ]);
    // Every boot path reports through `warn` (stderr on a real boot).
    expect(warned).toEqual(activated.warnings.map((w) => `[plugins] ${w}`));
    // The buckets are still returned, for API compatibility.
    expect([
      activated.channels.length,
      activated.models.length,
      activated.graders.length,
      activated.targetEmitters.length,
    ]).toEqual([1, 1, 1, 1]);
  });

  test("several of one kind are counted, and a list that is not a list is ignored by name", async () => {
    const activated = await activate({
      channels: [channel("a"), channel("b"), { verify: () => true }],
      graders: { id: "not-a-list" },
      models: [],
    });
    expect(activated.warnings).toEqual([
      'plugin "chanplug" contributes 3 channels ("a", "b"), which have no effect: a channel daemon\'s adapters are built into it from the spec, and it does not read a plugin\'s. Only a plugin\'s tools and its skills/ directory are used.',
      'plugin "chanplug": contributions.graders is an object, not a list, and was ignored.',
    ]);
    expect(activated.graders).toEqual([]);
  });

  test("a tools-only plugin says nothing", async () => {
    expect((await activate({ tools: [tool] })).warnings).toEqual([]);
  });

  test("every kind the SDK declares besides tools is listed as unbound", () => {
    expect(Object.keys(UNBOUND_CONTRIBUTION_KINDS).sort()).toEqual([
      "channels",
      "graders",
      "models",
      "targetEmitters",
    ]);
  });

  test("no doc says the other kinds are wired", () => {
    const read = (rel: string) => readFileSync(join(import.meta.dir, "..", "..", rel), "utf8");
    const docs = {
      sdk: read("plugin-sdk/src/index.ts"),
      loader: read("plugin-loader/src/index.ts"),
      runtime: read("runtime-core/src/index.ts"),
    };
    const count = (text: string, phrase: string) => text.split(phrase).length - 1;
    const claims = [
      "wiring each declaration into the host's registry",
      "adapts it into the\n * channel registry slot",
      "pass through verbatim\n * for their respective hosts",
      "bind at their own hosts",
    ];
    for (const [where, text] of Object.entries(docs)) {
      for (const claim of claims) {
        expect({ where, claim, hits: count(text, claim) }).toEqual({ where, claim, hits: 0 });
      }
    }
    expect(count(docs.sdk, "Only tools (and a plugin's `skills/` directory) are bound")).toBe(1);
    expect(count(docs.loader, "are COLLECTED, NOT BOUND")).toBe(1);
    expect(count(docs.runtime, "bound by no host in this release")).toBe(1);
  });
});
