#!/usr/bin/env bun
/**
 * Section 40 template-registry smoke.
 *
 * Probes:
 *   A) LocalRegistrySource put + fetch + list round-trip
 *   B) signature round-trip — sign, verify, then tamper and verify
 *      catches the mutation
 *   C) cachedRegistry + refresh — TTL hit/miss + manual flush
 *   D) verifyingRegistry — T8 supply-chain check refuses unsigned and
 *      untrusted manifests
 *   E) HttpRegistrySource list shape via stub fetch
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HttpRegistrySource,
  LocalRegistrySource,
  type TemplateManifest,
  cachedRegistry,
  generateSigningKeypair,
  signManifest,
  verifyManifest,
  verifyingRegistry,
} from "@crewhaus/template-registry";

const log = (s: string) => process.stdout.write(`[section-40-registry] ${s}\n`);
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) log(`✓ ${name}`);
  else {
    log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
};

const tmp = mkdtempSync(join(tmpdir(), "section-40-registry-smoke-"));

const seed = {
  name: "hello-cli-template",
  version: "1.0.0",
  description: "Hello-world CLI template",
  author: "smoke",
  target: "cli",
  yaml: "name: hello\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n",
};

// ── Probe A: local round-trip ─────────────────────────────────────────────
log("probe A: LocalRegistrySource put + fetch + list");
{
  const local = new LocalRegistrySource({ rootDir: tmp });
  local.put({ ...seed });
  local.put({ ...seed, name: "second-template" });
  const list = await local.list();
  check("list returns 2 metadata entries", list.length === 2);
  const fetched = await local.fetch("hello-cli-template");
  check("fetch returns the seeded manifest", fetched.name === seed.name);
  const meta = await local.metadata("hello-cli-template");
  check("metadata strips yaml field", !("yaml" in meta));
}

// ── Probe B: signature round-trip ─────────────────────────────────────────
log("probe B: sign + verify; tamper detection");
{
  const { privateKey, publicKey } = generateSigningKeypair();
  const signature = signManifest({ ...seed, publicKey }, privateKey);
  const signed: TemplateManifest = { ...seed, publicKey, signature };
  const ok = verifyManifest(signed, { publicKeys: [publicKey] });
  check("signed manifest verifies", ok.ok === true);
  const tampered: TemplateManifest = { ...signed, yaml: "evil: true\n" };
  const bad = verifyManifest(tampered, { publicKeys: [publicKey] });
  check("tampered yaml fails verification", !bad.ok);
}

// ── Probe C: TTL cache + refresh ──────────────────────────────────────────
log("probe C: cachedRegistry — TTL hit, refresh flushes");
{
  let calls = 0;
  const local = new LocalRegistrySource({ rootDir: tmp });
  const wrapper = {
    id: "wrap",
    async list() {
      calls += 1;
      return local.list();
    },
    async fetch(name: string) {
      return local.fetch(name);
    },
    async metadata(name: string) {
      return local.metadata(name);
    },
  };
  const cached = cachedRegistry({ source: wrapper, ttlMs: 60_000 });
  await cached.list();
  await cached.list();
  check("repeated list within TTL → 1 upstream call", calls === 1);
  cached.refresh();
  await cached.list();
  check("refresh() forces a re-fetch", calls === 2);
}

// ── Probe D: T8 supply-chain check ────────────────────────────────────────
log("probe D: T8 — verifyingRegistry refuses unsigned + untrusted");
{
  const local = new LocalRegistrySource({ rootDir: tmp });
  // Put an unsigned manifest under a fresh name.
  local.put({ ...seed, name: "unsigned-victim" });
  const { publicKey } = generateSigningKeypair();
  const verifying = verifyingRegistry({
    source: local,
    trustRoot: { publicKeys: [publicKey] },
  });
  let refused = false;
  try {
    await verifying.fetch("unsigned-victim");
  } catch (err) {
    refused = (err as Error).message.includes("failed signature verification");
  }
  check("unsigned manifest is refused", refused);

  const a = generateSigningKeypair();
  const b = generateSigningKeypair();
  const sig = signManifest({ ...seed, name: "signed-by-a", publicKey: a.publicKey }, a.privateKey);
  local.put({ ...seed, name: "signed-by-a", publicKey: a.publicKey, signature: sig });
  const verifyingB = verifyingRegistry({
    source: local,
    trustRoot: { publicKeys: [b.publicKey] }, // trusts B only
  });
  let untrustedRefused = false;
  try {
    await verifyingB.fetch("signed-by-a");
  } catch (err) {
    untrustedRefused = (err as Error).message.includes("not in trust root");
  }
  check("signature from untrusted key is refused", untrustedRefused);
}

// ── Probe E: HTTP source list shape ───────────────────────────────────────
log("probe E: HttpRegistrySource list → templates[]");
{
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    if (url.endsWith("/list")) {
      return new Response(
        JSON.stringify({
          templates: [
            { ...seed, name: "remote-a", yaml: undefined },
            { ...seed, name: "remote-b", yaml: undefined },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/fetch/remote-a")) {
      return new Response(JSON.stringify({ ...seed, name: "remote-a" }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const src = new HttpRegistrySource({
    id: "git",
    listUrl: "https://example.test/list",
    fetchUrl: (n) => `https://example.test/fetch/${n}`,
    fetchImpl,
  });
  const list = await src.list();
  check("HTTP list returns 2 templates", list.length === 2);
  const single = await src.fetch("remote-a");
  check("HTTP fetch returns the named manifest", single.name === "remote-a");
}

rmSync(tmp, { recursive: true, force: true });

if (failed === 0) {
  log("ALL PROBES PASSED");
  process.exit(0);
}
log(`FAILED: ${failed} probe(s)`);
process.exit(1);
