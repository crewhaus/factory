/**
 * Loop contract 0.4 (Batch C, item 4) — agent identity.
 *
 * An Ed25519 keypair auto-generated at first boot into `.crewhaus/identity.json`.
 * Its `agentId` — the SHA-256 fingerprint of the public key — is stamped onto
 * every `TraceEvent` envelope (via the bus's `agentId`) and appended to
 * audit-log records, so a trace event and its audit trail attribute to one
 * agent. The private key lives beside it (mode 0600) for later record signing;
 * this module only generates and loads — signing is a downstream concern.
 *
 * `loadOrCreateAgentIdentity` is idempotent: the first call mints and persists
 * the keypair; every later call re-reads the same file and returns the same
 * `agentId`. Creation is create-exclusive so two concurrent first-boots can't
 * clobber each other's keypair (first writer wins; the loser re-reads it).
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { closeSync, mkdirSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { createExclusive, openForReadSync, writeFileSafe } from "@crewhaus/tool-safety/fs";

/** Default directory the identity file lives in (the project `.crewhaus` dir). */
export const DEFAULT_IDENTITY_DIR = ".crewhaus";
export const IDENTITY_FILENAME = "identity.json";
export const AGENT_IDENTITY_SCHEMA_VERSION = 1 as const;

/**
 * The persisted identity. `agentId` is the stable, verifiable fingerprint
 * stamped onto trace envelopes; `publicKey`/`privateKey` are base64 DER
 * (SPKI / PKCS8) so the keypair round-trips through `crypto.createPublicKey`
 * for a future signing/verification layer.
 */
export type AgentIdentityFile = {
  readonly schemaVersion: 1;
  /** SHA-256 hex digest of the SPKI-DER public key. */
  readonly agentId: string;
  readonly algorithm: "ed25519";
  /** base64 SPKI DER. */
  readonly publicKey: string;
  /** base64 PKCS8 DER. */
  readonly privateKey: string;
  readonly createdAt: string;
};

/** The public-key fingerprint that becomes `agentId`. */
export function agentFingerprint(spkiDer: Buffer): string {
  return createHash("sha256").update(spkiDer).digest("hex");
}

function mint(now: () => Date): AgentIdentityFile {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
  return {
    schemaVersion: AGENT_IDENTITY_SCHEMA_VERSION,
    agentId: agentFingerprint(spki),
    algorithm: "ed25519",
    publicKey: spki.toString("base64"),
    privateKey: pkcs8.toString("base64"),
    createdAt: now().toISOString(),
  };
}

/** The largest identity file read: a keypair is a few hundred bytes. */
const MAX_IDENTITY_BYTES = 64 * 1024;

function safeParse(dir: string): AgentIdentityFile | undefined {
  // 0.7.1: never through a link at the name, so a planted
  // `identity.json -> <elsewhere>` is never taken for (or replaced as) the
  // agent's identity.
  const read = openForReadSync(dir, IDENTITY_FILENAME, {
    maxBytes: MAX_IDENTITY_BYTES,
    followLeafSymlink: false,
  });
  if (!read.ok || read.truncated) return undefined;
  try {
    const parsed = JSON.parse(read.text) as Partial<AgentIdentityFile>;
    if (
      typeof parsed.agentId === "string" &&
      parsed.agentId.length > 0 &&
      typeof parsed.publicKey === "string" &&
      typeof parsed.privateKey === "string"
    ) {
      return parsed as AgentIdentityFile;
    }
  } catch {
    // Corrupt/unreadable — the caller regenerates.
  }
  return undefined;
}

/**
 * Load the agent identity from `<dir>/identity.json`, or mint + persist one on
 * first boot. Idempotent and race-safe (create-exclusive write). `now` is
 * injectable for deterministic tests.
 */
export function loadOrCreateAgentIdentity(
  dir: string = DEFAULT_IDENTITY_DIR,
  now: () => Date = () => new Date(),
): AgentIdentityFile {
  const root = resolve(dir);
  const path = resolve(root, IDENTITY_FILENAME);
  mkdirSync(root, { recursive: true });
  const existing = safeParse(root);
  if (existing !== undefined) return existing;

  const identity = mint(now);
  const body = `${JSON.stringify(identity, null, 2)}\n`;
  // create-exclusive: the first concurrent first-boot wins the keypair.
  const created = createExclusive(root, IDENTITY_FILENAME, { mode: 0o600 });
  if (created.ok) {
    try {
      const bytes = Buffer.from(body, "utf8");
      let at = 0;
      while (at < bytes.length) at += writeSync(created.fd, bytes, at, bytes.length - at);
    } finally {
      closeSync(created.fd);
    }
    return identity;
  }
  if (created.code !== "exists") throw identityRefusal(path, created);
  // Lost the create race, or a corrupt file squats the path.
  const winner = safeParse(root);
  if (winner !== undefined) return winner;
  // 0.7.1: replaced through a random O_EXCL|O_NOFOLLOW temp, never written
  // through what squats the name. A link there is refused: 0.7.0 wrote the
  // new keypair, private key included, through it to wherever it pointed.
  const written = writeFileSafe(root, IDENTITY_FILENAME, body, { overwrite: true, mode: 0o600 });
  if (!written.ok) throw identityRefusal(path, written);
  return identity;
}

function identityRefusal(path: string, failure: { reason: string; code: string }): Error {
  return new Error(
    `agent identity: refusing to write ${path}: ${failure.reason} (code ${failure.code})`,
  );
}
