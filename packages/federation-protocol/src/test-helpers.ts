/**
 * Test helpers for federation-protocol — read pre-generated fixture
 * certs from disk so tests don't shell to openssl on every run.
 *
 * The fixture certs are self-signed RSA 2048, valid for 10 years, with
 * CN=fed-fixture (and CN=fed-other for the "wrong key" pair). Generated
 * once via:
 *
 *   openssl req -x509 -newkey rsa:2048 -nodes \
 *     -keyout fixtures-key.pem -out fixtures-cert.pem \
 *     -days 3650 -subj "/CN=fed-fixture" -sha256
 *
 * Test-only secrets — no production deployment uses these.
 *
 * Earlier iterations shelled to openssl on every test run; that timed
 * out on CI runners with slow entropy and racy `openssl x509 ...
 * -fingerprint -sha256` invocations. Static fixtures are deterministic
 * + fast (~1 ms read).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fingerprintCert } from "./index";

export type FixtureCertSet = {
  readonly caCertPem: string;
  readonly clientCertPem: string;
  readonly clientKeyPem: string;
  readonly pinnedFingerprint: string;
  /** No-op — kept for backwards compat with the old openssl-based helper. */
  readonly cleanup: () => void;
};

const FIXTURES_DIR = import.meta.dir;

/**
 * Returns the canonical fixture cert pair (CN=fed-fixture). The
 * `_commonName` arg is accepted for backwards compat with the
 * generate-on-the-fly helper this replaced; it has no effect.
 */
export function makeFixtureCertSet(_commonName = "fed-fixture"): FixtureCertSet {
  return readFixtures("fixtures-cert.pem", "fixtures-key.pem");
}

/**
 * Returns a second, unrelated cert pair (CN=fed-other) — used by the
 * "wrong public key" / "tampered cert" tests to assert pinning rejects
 * keys that don't match the configured fingerprint.
 */
export function makeFixtureCertSetOther(): FixtureCertSet {
  return readFixtures("fixtures-other-cert.pem", "fixtures-other-key.pem");
}

function readFixtures(certFile: string, keyFile: string): FixtureCertSet {
  const certPem = readFileSync(join(FIXTURES_DIR, certFile), "utf8");
  const keyPem = readFileSync(join(FIXTURES_DIR, keyFile), "utf8");
  return {
    caCertPem: certPem,
    clientCertPem: certPem,
    clientKeyPem: keyPem,
    pinnedFingerprint: fingerprintCert(certPem),
    cleanup: () => undefined,
  };
}
