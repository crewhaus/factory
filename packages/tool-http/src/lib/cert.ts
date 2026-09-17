/**
 * Turning a TLS peer certificate into something readable.
 *
 * Pure shaping, kept away from the socket so it can be tested without one.
 * Two decisions worth stating:
 *
 *   - A distinguished name is rendered in the conventional CN, O, OU, L, ST,
 *     C order, with any remaining attribute appended in plain string order.
 *     Node hands the attributes back as an object, and object key order is
 *     not something to build a stable output on.
 *   - `daysRemaining` is FLOORED and measured against a caller-supplied
 *     `nowMs`, so "0 days remaining" means "expires sometime today" and the
 *     clock is an argument rather than a hidden dependency.
 */

/** Node's shape for a certificate, narrowed to the fields used here. */
export type CertLike = {
  readonly subject?: unknown;
  readonly issuer?: unknown;
  readonly valid_from?: string;
  readonly valid_to?: string;
  readonly subjectaltname?: string;
  readonly serialNumber?: string;
  readonly fingerprint256?: string;
};

const DN_ORDER = ["CN", "O", "OU", "L", "ST", "C"];

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `CN=example.com, O=Example Inc, C=US`. Empty string for a missing name. */
export function formatDn(dn: unknown): string {
  if (typeof dn !== "object" || dn === null || Array.isArray(dn)) return "";
  const record = dn as Record<string, unknown>;
  const keys = Object.keys(record).sort((a, b) => {
    const ai = DN_ORDER.indexOf(a);
    const bi = DN_ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return byString(a, b);
  });
  return keys
    .map((key) => {
      const value = record[key];
      return `${key}=${Array.isArray(value) ? value.join("+") : String(value)}`;
    })
    .join(", ");
}

/** `DNS:a.example.com, IP Address:1.2.3.4` split and sorted. */
export function parseSubjectAltNames(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .sort(byString);
}

/** Whole days between now and `validTo`; negative once it has expired. */
export function daysRemaining(validTo: string | undefined, nowMs: number): number | undefined {
  if (validTo === undefined) return undefined;
  const expiresAt = Date.parse(validTo);
  if (!Number.isFinite(expiresAt)) return undefined;
  return Math.floor((expiresAt - nowMs) / 86_400_000);
}

/** The summary shape a `TlsInspect` result carries for one certificate. */
export function summarizeCert(cert: CertLike, nowMs: number): Record<string, unknown> {
  const sans = parseSubjectAltNames(cert.subjectaltname);
  const days = daysRemaining(cert.valid_to, nowMs);
  return {
    subject: formatDn(cert.subject),
    issuer: formatDn(cert.issuer),
    ...(cert.valid_from !== undefined ? { validFrom: cert.valid_from } : {}),
    ...(cert.valid_to !== undefined ? { validTo: cert.valid_to } : {}),
    ...(days !== undefined ? { daysRemaining: days, expired: days < 0 } : {}),
    ...(cert.serialNumber !== undefined ? { serialNumber: cert.serialNumber } : {}),
    ...(cert.fingerprint256 !== undefined ? { fingerprint256: cert.fingerprint256 } : {}),
    ...(sans.length > 0 ? { subjectAltNames: sans } : {}),
  };
}
