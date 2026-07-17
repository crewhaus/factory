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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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

function safeParse(path: string): AgentIdentityFile | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AgentIdentityFile>;
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
  const path = resolve(dir, IDENTITY_FILENAME);
  const existing = safeParse(path);
  if (existing !== undefined) return existing;

  const identity = mint(now);
  const body = `${JSON.stringify(identity, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    // create-exclusive: the first concurrent first-boot wins the keypair.
    writeFileSync(path, body, { flag: "wx", mode: 0o600 });
    return identity;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // Lost the create race, or a corrupt file squats the path.
    const winner = safeParse(path);
    if (winner !== undefined) return winner;
    writeFileSync(path, body, { mode: 0o600 });
    return identity;
  }
}
