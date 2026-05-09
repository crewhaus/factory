/**
 * Test helpers for federation-protocol — generate a fresh self-signed
 * Ed25519 certificate + matching key pair for use in tests. Returns
 * PEM-encoded strings that the production code accepts as
 * caCertPem/clientCertPem/clientKeyPem.
 *
 * We use Bun.spawn over openssl rather than @peculiar/x509 because
 * openssl is universally available on macOS/Linux CI runners.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FixtureCertSet = {
  readonly caCertPem: string;
  readonly clientCertPem: string;
  readonly clientKeyPem: string;
  readonly pinnedFingerprint: string;
  readonly cleanup: () => void;
};

/**
 * Generate a self-signed CA + a leaf cert for `commonName`. Used by
 * federation-protocol tests for cert-pinning + envelope validation.
 */
export function makeFixtureCertSet(commonName = "deployment-test"): FixtureCertSet {
  const dir = mkdtempSync(join(tmpdir(), "fed-fixture-"));
  // Self-signed CA + cert. RSA so older openssl builds work too.
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${dir}/key.pem" -out "${dir}/cert.pem" ` +
      `-days 30 -subj "/CN=${commonName}" -sha256 2>/dev/null`,
    { stdio: "ignore" },
  );
  const certPem = readFileSync(join(dir, "cert.pem"), "utf8");
  const keyPem = readFileSync(join(dir, "key.pem"), "utf8");
  // Self-signed: the cert IS the CA root.
  const caPem = certPem;
  // Compute fingerprint via openssl.
  const fpRaw = execSync(`openssl x509 -in "${dir}/cert.pem" -noout -fingerprint -sha256`, {
    encoding: "utf8",
  });
  const pinnedFingerprint = (fpRaw.split("=")[1] ?? "").trim().replaceAll(":", "").toLowerCase();
  return {
    caCertPem: caPem,
    clientCertPem: certPem,
    clientKeyPem: keyPem,
    pinnedFingerprint,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
