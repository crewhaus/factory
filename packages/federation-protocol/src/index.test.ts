import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  FEDERATION_VERSION,
  type FederationEnvelope,
  FederationProtocolError,
  type FederationTransport,
  decodeFederationEnvelope,
  encodeFederationEnvelope,
  federationCall,
  fingerprintCert,
  validateCredentials,
} from "./index";
import { type FixtureCertSet, makeFixtureCertSet } from "./test-helpers";

const goodEnvelope: FederationEnvelope = {
  version: FEDERATION_VERSION,
  traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
  federation: {
    from: { deployment: "deployment-a", role: "researcher" },
    to: { deployment: "deployment-b", role: "code-reviewer" },
    mtls: { client_cert_subject: "CN=deployment-a" },
  },
  kind: "question",
  payload: "review the patch in /tmp/x",
};

let certs: FixtureCertSet;
let otherCerts: FixtureCertSet;

beforeAll(() => {
  certs = makeFixtureCertSet("deployment-test");
  otherCerts = makeFixtureCertSet("deployment-other");
});

afterAll(() => {
  certs.cleanup();
  otherCerts.cleanup();
});

describe("encodeFederationEnvelope / decodeFederationEnvelope (T2)", () => {
  test("round-trip happy path", () => {
    const text = encodeFederationEnvelope(goodEnvelope);
    const parsed = decodeFederationEnvelope(text);
    expect(parsed).toEqual(goodEnvelope);
  });

  test("rejects invalid version", () => {
    const bad = {
      ...goodEnvelope,
      version: "crewhaus.federation.v0",
    } as unknown as FederationEnvelope;
    expect(() => encodeFederationEnvelope(bad)).toThrow(/unsupported version/);
    expect(() => decodeFederationEnvelope(JSON.stringify(bad))).toThrow(/unsupported version/);
  });

  test("rejects missing federation field", () => {
    const bad = { ...goodEnvelope, federation: undefined } as unknown as FederationEnvelope;
    expect(() => decodeFederationEnvelope(JSON.stringify(bad))).toThrow(/missing federation/);
  });

  test("rejects malformed party", () => {
    const bad = JSON.parse(JSON.stringify(goodEnvelope)) as FederationEnvelope;
    (bad.federation as unknown as { from: unknown }).from = { deployment: "x" };
    expect(() => decodeFederationEnvelope(JSON.stringify(bad))).toThrow(/from\/to must be/);
  });

  test("rejects invalid kind", () => {
    const bad = { ...goodEnvelope, kind: "explosion" } as unknown as FederationEnvelope;
    expect(() => decodeFederationEnvelope(JSON.stringify(bad))).toThrow(/invalid kind/);
  });

  test("rejects non-string payload", () => {
    const bad = { ...goodEnvelope, payload: 123 } as unknown as FederationEnvelope;
    expect(() => decodeFederationEnvelope(JSON.stringify(bad))).toThrow(/payload must be a string/);
  });

  test("rejects missing traceparent", () => {
    const bad = { ...goodEnvelope, traceparent: "" } as FederationEnvelope;
    expect(() => decodeFederationEnvelope(JSON.stringify(bad))).toThrow(/traceparent/);
  });

  test("rejects malformed JSON", () => {
    expect(() => decodeFederationEnvelope("{not json")).toThrow(FederationProtocolError);
  });

  test("decode rejects mtls.client_cert_subject missing", () => {
    const bad = JSON.parse(JSON.stringify(goodEnvelope)) as FederationEnvelope;
    (bad.federation as unknown as { mtls: unknown }).mtls = {};
    expect(() => decodeFederationEnvelope(JSON.stringify(bad))).toThrow(/client_cert_subject/);
  });
});

describe("validateCredentials (T8)", () => {
  test("happy path accepts a valid set", () => {
    expect(() =>
      validateCredentials({
        caCertPem: certs.caCertPem,
        clientCertPem: certs.clientCertPem,
        clientKeyPem: certs.clientKeyPem,
        pinnedFingerprint: certs.pinnedFingerprint,
      }),
    ).not.toThrow();
  });

  test("rejects non-PEM ca", () => {
    expect(() =>
      validateCredentials({
        caCertPem: "not a cert",
        clientCertPem: certs.clientCertPem,
        clientKeyPem: certs.clientKeyPem,
        pinnedFingerprint: certs.pinnedFingerprint,
      }),
    ).toThrow(/caCertPem is not PEM-encoded/);
  });

  test("rejects non-PEM cert", () => {
    expect(() =>
      validateCredentials({
        caCertPem: certs.caCertPem,
        clientCertPem: "not a cert",
        clientKeyPem: certs.clientKeyPem,
        pinnedFingerprint: certs.pinnedFingerprint,
      }),
    ).toThrow(/clientCertPem is not PEM-encoded/);
  });

  test("rejects non-PEM key", () => {
    expect(() =>
      validateCredentials({
        caCertPem: certs.caCertPem,
        clientCertPem: certs.clientCertPem,
        clientKeyPem: "not a key",
        pinnedFingerprint: certs.pinnedFingerprint,
      }),
    ).toThrow(/clientKeyPem is not PEM-encoded/);
  });

  test("rejects malformed pinnedFingerprint (length)", () => {
    expect(() =>
      validateCredentials({
        caCertPem: certs.caCertPem,
        clientCertPem: certs.clientCertPem,
        clientKeyPem: certs.clientKeyPem,
        pinnedFingerprint: "abc",
      }),
    ).toThrow(/pinnedFingerprint must be 64-char hex/);
  });

  test("rejects malformed pinnedFingerprint (non-hex chars)", () => {
    expect(() =>
      validateCredentials({
        caCertPem: certs.caCertPem,
        clientCertPem: certs.clientCertPem,
        clientKeyPem: certs.clientKeyPem,
        pinnedFingerprint: "z".repeat(64),
      }),
    ).toThrow(/pinnedFingerprint must be 64-char hex/);
  });
});

describe("fingerprintCert", () => {
  test("matches the openssl-computed fingerprint", () => {
    const fp = fingerprintCert(certs.clientCertPem);
    expect(fp).toBe(certs.pinnedFingerprint);
  });
});

describe("federationCall — injected transport (T2)", () => {
  test("happy path round-trip", async () => {
    const captured: Array<{ url: string; envelope: FederationEnvelope }> = [];
    const transport: FederationTransport = async (url, envelope) => {
      captured.push({ url, envelope });
      return { status: 200, body: '{"reply":"ack"}' };
    };
    const result = await federationCall({
      url: "https://deployment-b.example/federation",
      envelope: goodEnvelope,
      credentials: {
        caCertPem: certs.caCertPem,
        clientCertPem: certs.clientCertPem,
        clientKeyPem: certs.clientKeyPem,
        pinnedFingerprint: certs.pinnedFingerprint,
      },
      transport,
    });
    expect(result.status).toBe(200);
    expect(captured[0]?.url).toBe("https://deployment-b.example/federation");
    expect(captured[0]?.envelope).toEqual(goodEnvelope);
  });

  test("validates credentials before invoking transport", async () => {
    const transport: FederationTransport = async () => ({ status: 200, body: "" });
    await expect(
      federationCall({
        url: "https://deployment-b.example/",
        envelope: goodEnvelope,
        credentials: {
          caCertPem: "not a cert",
          clientCertPem: certs.clientCertPem,
          clientKeyPem: certs.clientKeyPem,
          pinnedFingerprint: certs.pinnedFingerprint,
        },
        transport,
      }),
    ).rejects.toThrow(/caCertPem is not PEM-encoded/);
  });
});
