/**
 * `crewhaus plugins install`, end to end (0.7.1):
 *
 * - extension-path#2 (C015): install never verified a signature. It built its
 *   registry with no publisher key, so an unsigned or forged manifest was
 *   installed with exit 0, `--allow-unsigned` changed nothing, and
 *   `--version 9.9.9` installed 1.0.0 from a local registry. Install now
 *   verifies against the keys a boot trusts plus `--trust-anchor`, refuses an
 *   unverifiable manifest, and installs the version asked for or nothing.
 * - extension-path#3 (C017): install reports that it delivered the manifest
 *   only, and where the plugin's code goes.
 *
 * A throwaway HOME and a local registry directory; the real CLI in a
 * subprocess.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PluginManifest, manifestPayloadForSigning } from "@crewhaus/plugin-sdk";

const CLI_PATH = join(import.meta.dir.replace(/([/\\])dist$/, "$1src"), "index.ts");

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { pem: publicKey.export({ type: "spki", format: "pem" }).toString(), privateKey };
}

function signed(m: PluginManifest, key: ReturnType<typeof keypair>["privateKey"]): PluginManifest {
  const sig = sign(null, Buffer.from(manifestPayloadForSigning(m), "utf8"), key);
  return {
    ...m,
    signature: { algorithm: "ed25519", publicKeyB64: "unused", sigB64: sig.toString("base64") },
  };
}

/** A HOME and a local registry holding `greeter` as `manifest`. */
function setup(manifest: PluginManifest): { home: string; registry: string } {
  const home = mkdtempSync(join(tmpdir(), "crewhaus-plugins-install-"));
  roots.push(home);
  const registry = join(home, "registry");
  mkdirSync(registry, { recursive: true });
  writeFileSync(join(registry, "greeter.json"), JSON.stringify(manifest));
  return { home, registry };
}

function trust(home: string, pem: string): void {
  const dir = join(home, ".crewhaus", "plugin-trust");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "publisher.pem"), pem);
}

async function install(
  home: string,
  registry: string,
  extra: ReadonlyArray<string> = [],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(
    [process.execPath, CLI_PATH, "plugins", "install", "greeter", "--registry", registry, ...extra],
    {
      cwd: home,
      env: { PATH: process.env["PATH"] ?? "", HOME: home, CREWHAUS_NO_REGISTRY: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

const installed = (home: string) =>
  existsSync(join(home, ".crewhaus", "plugins", "greeter", "plugin.json"));

describe("crewhaus plugins install verifies what it installs (C015)", () => {
  test("with no publisher key it refuses, saying where the key goes", async () => {
    const { home, registry } = setup({ name: "greeter", version: "1.0.0" });
    const run = await install(home, registry);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain(
      `no plugin trust anchor is configured, so no manifest can be verified. Put the publisher's Ed25519 public key (a .pem file) in ${join(home, ".crewhaus", "plugin-trust")}`,
    );
    expect(installed(home)).toBe(false);
  }, 30_000);

  test("an unsigned or forged manifest is refused against a trusted key", async () => {
    const publisher = keypair();
    const unsigned = setup({ name: "greeter", version: "1.0.0" });
    trust(unsigned.home, publisher.pem);
    const a = await install(unsigned.home, unsigned.registry);
    expect(a.exitCode).not.toBe(0);
    expect(a.stderr).toContain('refusing to register unsigned plugin "greeter"');
    expect(installed(unsigned.home)).toBe(false);

    const forged = setup(signed({ name: "greeter", version: "1.0.0" }, keypair().privateKey));
    trust(forged.home, publisher.pem);
    // --allow-unsigned accepts a MISSING signature, never a bad one.
    const b = await install(forged.home, forged.registry, ["--allow-unsigned"]);
    expect(b.exitCode).not.toBe(0);
    expect(b.stderr).toContain('signature verification failed for plugin "greeter"');
    expect(installed(forged.home)).toBe(false);
  }, 30_000);

  test("a manifest signed by a --trust-anchor key installs, verified, and says the code is missing", async () => {
    const publisher = keypair();
    // A signed manifest names its code (0.7.1: the loader refuses one that does not).
    const { home, registry } = setup(
      signed(
        { name: "greeter", version: "1.0.0", entrypointDigest: "a".repeat(64) },
        publisher.privateKey,
      ),
    );
    const pem = join(home, "publisher.pem");
    writeFileSync(pem, publisher.pem);
    const run = await install(home, registry, ["--trust-anchor", pem]);
    expect(run.exitCode).toBe(0);
    const manifestPath = join(home, ".crewhaus", "plugins", "greeter", "plugin.json");
    expect(run.stdout).toBe(`installed greeter@1.0.0 → ${manifestPath}\n`);
    const codeMissing = `[plugins] greeter@1.0.0 is installed as a manifest only: the registry delivers no code. Put the plugin's index.js at ${join(home, ".crewhaus", "plugins", "greeter", "index.js")} (its sha256 must equal the manifest's entrypointDigest) before a spec names it in plugins:.\n`;
    // The flag's key is one no boot reads (review of C017).
    expect(run.stderr).toBe(
      `${codeMissing}[plugins] greeter@1.0.0: no key a boot trusts verifies its signature (it was verified against a key given only to this install), so every boot will refuse it. Put the publisher's .pem in ~/.crewhaus/plugin-trust, or list it in CREWHAUS_PLUGIN_TRUST_ANCHORS.\n`,
    );
    // Once the boot trusts the key too, only the missing code is left to say.
    trust(home, publisher.pem);
    const again = await install(home, registry, ["--trust-anchor", pem]);
    expect(again.exitCode).toBe(0);
    expect(again.stderr).toBe(codeMissing);
  }, 30_000);

  test("--allow-unsigned installs an unsigned manifest and says it is unverified", async () => {
    const { home, registry } = setup({ name: "greeter", version: "1.0.0" });
    const run = await install(home, registry, ["--allow-unsigned"]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toStartWith(
      "installed greeter@1.0.0 (UNVERIFIED: no signature was checked) → ",
    );
    expect(installed(home)).toBe(true);
  }, 30_000);

  test("--version installs that version or nothing", async () => {
    const { home, registry } = setup({ name: "greeter", version: "1.0.0" });
    const run = await install(home, registry, ["--allow-unsigned", "--version", "9.9.9"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("served greeter@1.0.0 when 9.9.9 was asked for — not installed");
    expect(installed(home)).toBe(false);
  }, 30_000);

  test("an install where no boot looks says so", async () => {
    const { home, registry } = setup({ name: "greeter", version: "1.0.0" });
    const run = await install(home, registry, [
      "--allow-unsigned",
      "--plugins-dir",
      join(home, "elsewhere"),
    ]);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain(
      "[plugins] this install is not where a boot looks: crewhaus run and compiled bundles load plugins only from",
    );
  }, 30_000);
});
