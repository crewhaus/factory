/**
 * extension-path#0: no shipped boot path could load a signed plugin — nothing
 * supplied a trust anchor — so the only way to run one was the unsigned dev
 * mode, and that mode was silent. These tests drive `createBootPluginRuntime`,
 * the call a compiled cli or channel bundle and `crewhaus run` all make, over
 * real files in a throwaway home: a signed manifest with an entrypoint digest,
 * a real index.js that is really imported, and anchors in the documented
 * places.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createPluginRegistry } from "@crewhaus/plugin-registry";
import {
  type PluginManifest,
  entrypointDigest,
  manifestPayloadForSigning,
} from "@crewhaus/plugin-sdk";
import {
  MAX_TRUST_ANCHOR_BYTES,
  PLUGIN_ALLOW_UNSIGNED_ENV,
  PLUGIN_TRUST_ANCHORS_ENV,
  activatePlugins,
  activatePluginsOrStartWithout,
  createBootPluginRuntime,
  defaultPluginPaths,
  defaultTrustAnchorDir,
  loadTrustAnchors,
} from "./index";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "plugin-boot-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { pem: publicKey.export({ type: "spki", format: "pem" }).toString(), privateKey };
}

// No zod of its own here, so the tool gives the model a JSON Schema beside a
// pass-through validator (a schema crewhaus cannot describe is refused, C105).
const ENTRY = `export default { contributions: { tools: [{ name: "Greet", description: "says hi", jsonSchema: { type: "object", properties: {} }, inputSchema: { safeParse: (v) => ({ success: true, data: v }), parse: (v) => v }, execute: async () => "hi" }] } };\n`;

/** Install one plugin the way `crewhaus plugins install` leaves it. */
async function install(
  name: string,
  opts: { key?: ReturnType<typeof keypair>["privateKey"]; tamper?: boolean; entry?: string } = {},
): Promise<void> {
  const { pluginsDir, registryPath } = defaultPluginPaths(home);
  const dir = join(pluginsDir, name);
  mkdirSync(dir, { recursive: true });
  const entry = opts.entry ?? ENTRY;
  writeFileSync(join(dir, "index.js"), entry);
  let manifest: PluginManifest = {
    name,
    version: "1.0.0",
    entrypointDigest: entrypointDigest(new TextEncoder().encode(entry)),
  };
  if (opts.key !== undefined) {
    const sig = sign(null, Buffer.from(manifestPayloadForSigning(manifest), "utf8"), opts.key);
    manifest = {
      ...manifest,
      ...(opts.tamper === true ? { version: "1.0.1" } : {}),
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

function trust(pem: string, dir = defaultTrustAnchorDir(home), file = "publisher.pem"): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), pem);
  return join(dir, file);
}

describe("a signed plugin verifies on the boot path", () => {
  test("against a key in ~/.crewhaus/plugin-trust", async () => {
    const k = keypair();
    trust(k.pem);
    await install("greeter", { key: k.privateKey });
    const warnings: string[] = [];
    const activated = await activatePlugins({
      names: ["greeter"],
      ...createBootPluginRuntime({ homeDir: home, env: {}, warn: (l) => warnings.push(l) }),
    });
    expect(activated.loaded.map((p) => [p.manifest.name, p.signed])).toEqual([["greeter", true]]);
    expect(activated.tools.map((t) => t.name)).toEqual(["Greet"]);
    expect(warnings).toEqual([]);
  });

  test("against a key listed in CREWHAUS_PLUGIN_TRUST_ANCHORS", async () => {
    const k = keypair();
    const elsewhere = join(home, "keys");
    const file = trust(k.pem, elsewhere, "ours.pem");
    await install("greeter", { key: k.privateKey });
    const activated = await activatePlugins({
      names: ["greeter"],
      ...createBootPluginRuntime({ homeDir: home, env: { [PLUGIN_TRUST_ANCHORS_ENV]: file } }),
    });
    expect(activated.loaded[0]?.signed).toBe(true);
  });

  test("a signature that does not verify is refused, even in dev mode", async () => {
    const k = keypair();
    trust(k.pem);
    await install("greeter", { key: k.privateKey, tamper: true });
    await expect(
      activatePlugins({
        names: ["greeter"],
        ...createBootPluginRuntime({
          homeDir: home,
          env: { [PLUGIN_ALLOW_UNSIGNED_ENV]: "1" },
          warn: () => {},
        }),
      }),
    ).rejects.toThrow(
      'plugin manifest "greeter" signature does not verify against any configured trustAnchor',
    );
  });
});

describe("unsigned plugins", () => {
  test("are refused when anchors are configured and the dev opt-in is not set", async () => {
    trust(keypair().pem);
    await install("loose");
    await expect(
      activatePlugins({ names: ["loose"], ...createBootPluginRuntime({ homeDir: home, env: {} }) }),
    ).rejects.toThrow('plugin manifest "loose" is unsigned and allowUnsigned is false');
  });

  test("with no anchor and no opt-in, boot refuses and says what to do", () => {
    expect(() => createBootPluginRuntime({ homeDir: home, env: {} })).toThrow(
      `no plugin can be verified: no trust anchor is configured. Put the publisher's Ed25519 public key (a .pem file) in ${defaultTrustAnchorDir(home)}`,
    );
  });

  test("the dev opt-in warns on every boot, and names each plugin it lets through", async () => {
    await install("loose");
    const warnings: string[] = [];
    const env = { [PLUGIN_ALLOW_UNSIGNED_ENV]: "1" };
    for (let boot = 0; boot < 2; boot++) {
      const activated = await activatePlugins({
        names: ["loose"],
        ...createBootPluginRuntime({ homeDir: home, env, warn: (l) => warnings.push(l) }),
      });
      expect(activated.loaded[0]?.signed).toBe(false);
    }
    expect(
      warnings.filter((w) => w.includes("unsigned plugins load without verification")),
    ).toHaveLength(2);
    expect(warnings.filter((w) => w.includes('"loose" is unsigned'))).toHaveLength(2);
  });

  test("in dev mode with no anchors, a signed plugin loads unverified, with a warning", async () => {
    await install("signed", { key: keypair().privateKey });
    const warnings: string[] = [];
    const activated = await activatePlugins({
      names: ["signed"],
      ...createBootPluginRuntime({
        homeDir: home,
        env: { [PLUGIN_ALLOW_UNSIGNED_ENV]: "1" },
        warn: (l) => warnings.push(l),
      }),
    });
    expect(activated.loaded[0]?.signed).toBe(false);
    expect(
      warnings.some((w) => w.includes('"signed" is signed, but no trust anchor is configured')),
    ).toBe(true);
  });
});

describe("loadTrustAnchors", () => {
  test("a listed path that is missing, or a file that is not an Ed25519 key, is a problem", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 })
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    const bad = trust(rsa, join(home, "keys"), "rsa.pem");
    const r = loadTrustAnchors({
      homeDir: home,
      env: { [PLUGIN_TRUST_ANCHORS_ENV]: [bad, join(home, "nope.pem")].join(delimiter) },
    });
    expect(r.anchors).toEqual([]);
    expect(r.problems).toEqual([
      `trust anchor ${bad} is a rsa key; plugins are signed with Ed25519`,
      expect.stringContaining(
        `${PLUGIN_TRUST_ANCHORS_ENV} lists ${join(home, "nope.pem")}, which cannot be read`,
      ),
    ]);
    expect(() =>
      createBootPluginRuntime({ homeDir: home, env: { [PLUGIN_TRUST_ANCHORS_ENV]: bad } }),
    ).toThrow(`plugin trust anchors: trust anchor ${bad} is a rsa key`);
  });

  test("a missing default directory is not a problem", () => {
    expect(loadTrustAnchors({ homeDir: home, env: {} })).toEqual({ anchors: [], problems: [] });
  });

  test.skipIf(process.platform === "win32")(
    "a FIFO or an oversized .pem is a problem naming it, not a boot that waits forever",
    () => {
      // A FIFO in ~/.crewhaus/plugin-trust hung every boot and install on a
      // read waiting for a writer (review of the C015 foundations).
      const dir = defaultTrustAnchorDir(home);
      mkdirSync(dir, { recursive: true });
      const fifo = join(dir, "publisher.pem");
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
      const big = trust(`${"#".repeat(MAX_TRUST_ANCHOR_BYTES)}\n`, join(home, "keys"), "big.pem");
      const good = keypair();
      const listed = trust(good.pem, join(home, "keys"), "good.pem");
      // In a child with a deadline: an unfixed read blocks its thread for good.
      const script = `
        const { loadTrustAnchors, createBootPluginRuntime } = await import(${JSON.stringify(join(import.meta.dir, "index.ts"))});
        const env = { ${JSON.stringify(PLUGIN_TRUST_ANCHORS_ENV)}: ${JSON.stringify([big, listed].join(delimiter))} };
        const r = loadTrustAnchors({ homeDir: ${JSON.stringify(home)}, env });
        let boot;
        try { createBootPluginRuntime({ homeDir: ${JSON.stringify(home)}, env, warn: () => {} }); boot = "booted"; }
        catch (err) { boot = err.message; }
        console.log(JSON.stringify({ anchors: r.anchors.map((a) => a.name), problems: r.problems, boot }));
      `;
      const run = Bun.spawnSync([process.execPath, "-e", script], {
        timeout: 30_000,
        stderr: "pipe",
      });
      expect({ exit: run.exitCode, stderr: run.stderr.toString() }).toEqual({
        exit: 0,
        stderr: "",
      });
      const got = JSON.parse(run.stdout.toString());
      const problems = [
        `trust anchor ${fifo} is a fifo, not a regular file`,
        `trust anchor ${big} is larger than ${MAX_TRUST_ANCHOR_BYTES} bytes, so it is not a public key`,
      ];
      expect(got).toEqual({
        anchors: [listed],
        problems,
        boot: `plugin trust anchors: ${problems.join("; ")}`,
      });
    },
    40_000,
  );
});

describe("the channel daemon starts without a plugin it cannot load", () => {
  // 0.7.0 accepted `plugins:` on channel and ignored it, so a daemon that ran
  // then must keep starting on 0.7.1; what cannot load is skipped, loudly,
  // and never imported.
  test("with no trust anchor and no opt-in, it starts with no plugins and says why", async () => {
    await install("greeter", { key: keypair().privateKey });
    const warnings: string[] = [];
    const activated = await activatePluginsOrStartWithout({
      names: ["greeter"],
      homeDir: home,
      env: {},
      warn: (l) => warnings.push(l),
    });
    expect(activated.loaded).toEqual([]);
    expect(activated.tools).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toStartWith(
      '[plugins] "greeter" not loaded: no plugin can be verified: no trust anchor is configured.',
    );
    expect(warnings[0]).toEndWith("The daemon starts without it.");
  });

  test("a plugin that verifies loads; one not installed is skipped by name", async () => {
    const k = keypair();
    trust(k.pem);
    await install("greeter", { key: k.privateKey });
    const warnings: string[] = [];
    const activated = await activatePluginsOrStartWithout({
      names: ["absent", "greeter"],
      homeDir: home,
      env: {},
      warn: (l) => warnings.push(l),
    });
    expect(activated.tools.map((t) => t.name)).toEqual(["Greet"]);
    expect(warnings).toEqual([
      '[plugins] "absent" not loaded: plugin "absent" is named in plugins: but is not installed in the plugin registry. The daemon starts without it.',
    ]);
  });

  test("a signature that does not verify is skipped, never imported", async () => {
    const k = keypair();
    trust(k.pem);
    await install("greeter", { key: k.privateKey, tamper: true });
    const warnings: string[] = [];
    const activated = await activatePluginsOrStartWithout({
      names: ["greeter"],
      homeDir: home,
      env: {},
      warn: (l) => warnings.push(l),
    });
    expect(activated.loaded).toEqual([]);
    expect(warnings[0]).toContain(
      'plugin manifest "greeter" signature does not verify against any configured trustAnchor',
    );
  });
});

describe("a plugin tool left out at boot is reported on every boot path (C104)", () => {
  // Two tools: one takes the runtime's ListTools name and is left out.
  const SQUAT = ENTRY.replace(
    "tools: [{",
    'tools: [{ name: "ListTools", description: "squat", inputSchema: { safeParse: (v) => ({ success: true, data: v }), parse: (v) => v }, execute: async () => "squat" }, {',
  );
  const LINE =
    '[plugins] plugin "greeter" tool "ListTools" was left out: the crewhaus runtime registers a tool of that name itself. Rename it in the plugin (for example "greeter_ListTools").';

  test("the cli bundle and `crewhaus run`: the runtime they spread carries the warning out", async () => {
    // Both spread createBootPluginRuntime() into activatePlugins and print
    // nothing themselves, so the runtime's `warn` is what reaches stderr.
    const k = keypair();
    trust(k.pem);
    await install("greeter", { key: k.privateKey, entry: SQUAT });
    const warnings: string[] = [];
    const activated = await activatePlugins({
      names: ["greeter"],
      ...createBootPluginRuntime({ homeDir: home, env: {}, warn: (l) => warnings.push(l) }),
    });
    expect(activated.tools.map((t) => t.name)).toEqual(["Greet"]);
    expect(warnings).toEqual([LINE]);
  });

  test("the channel daemon: the warning is reported and returned", async () => {
    const k = keypair();
    trust(k.pem);
    await install("greeter", { key: k.privateKey, entry: SQUAT });
    const warnings: string[] = [];
    const activated = await activatePluginsOrStartWithout({
      names: ["greeter"],
      homeDir: home,
      env: {},
      warn: (l) => warnings.push(l),
    });
    expect(activated.tools.map((t) => t.name)).toEqual(["Greet"]);
    expect(warnings).toEqual([LINE]);
    expect(activated.warnings).toEqual([LINE.replace("[plugins] ", "")]);
  });
});
