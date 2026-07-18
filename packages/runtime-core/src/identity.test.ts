/**
 * Loop contract 0.4 (Batch C, item 4) — agent identity generation:
 * `loadOrCreateAgentIdentity` mints an Ed25519 keypair on first boot, persists
 * it to `.crewhaus/identity.json`, and is idempotent (same `agentId` on every
 * later call). End-to-end `agentId` stamping through a real run is covered in
 * `approvals.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { createPublicKey } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDENTITY_FILENAME, agentFingerprint, loadOrCreateAgentIdentity } from "./identity";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "crewhaus-identity-"));
}

describe("loadOrCreateAgentIdentity", () => {
  test("mints and persists an ed25519 identity on first boot", () => {
    const dir = tmp();
    try {
      const id = loadOrCreateAgentIdentity(dir);
      expect(id.algorithm).toBe("ed25519");
      expect(id.schemaVersion).toBe(1);
      expect(id.agentId).toMatch(/^[0-9a-f]{64}$/);
      const path = join(dir, IDENTITY_FILENAME);
      expect(existsSync(path)).toBe(true);
      // The file is private (contains the private key).
      expect(statSync(path).mode & 0o777).toBe(0o600);
      // The stored public key round-trips and its fingerprint IS the agentId.
      const pub = createPublicKey({
        key: Buffer.from(id.publicKey, "base64"),
        format: "der",
        type: "spki",
      });
      expect(agentFingerprint(pub.export({ type: "spki", format: "der" }) as Buffer)).toBe(
        id.agentId,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is idempotent — a second load returns the same agentId (no re-mint)", () => {
    const dir = tmp();
    try {
      const first = loadOrCreateAgentIdentity(dir);
      const second = loadOrCreateAgentIdentity(dir);
      expect(second.agentId).toBe(first.agentId);
      expect(second.privateKey).toBe(first.privateKey);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("regenerates over a corrupt identity file", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, IDENTITY_FILENAME), "{ not valid json");
      const id = loadOrCreateAgentIdentity(dir);
      expect(id.agentId).toMatch(/^[0-9a-f]{64}$/);
      // The file now parses back to the same identity.
      const reloaded = loadOrCreateAgentIdentity(dir);
      expect(reloaded.agentId).toBe(id.agentId);
      const onDisk = JSON.parse(readFileSync(join(dir, IDENTITY_FILENAME), "utf8"));
      expect(onDisk.agentId).toBe(id.agentId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("distinct dirs mint distinct identities", () => {
    const a = tmp();
    const b = tmp();
    try {
      expect(loadOrCreateAgentIdentity(a).agentId).not.toBe(loadOrCreateAgentIdentity(b).agentId);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});
