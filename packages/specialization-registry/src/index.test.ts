import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_SPECIALIZATIONS, SpecializationRegistryError, loadRegistry, match } from "./index";

describe("BUILTIN_SPECIALIZATIONS", () => {
  test("includes payments, auth, booking", () => {
    const names = BUILTIN_SPECIALIZATIONS.map((s) => s.name);
    expect(names).toContain("payments");
    expect(names).toContain("auth");
    expect(names).toContain("booking");
  });

  test("payments specialization names the four key invariants", () => {
    const p = BUILTIN_SPECIALIZATIONS.find((s) => s.name === "payments");
    const ids = p?.invariants.map((i) => i.id);
    expect(ids).toContain("idempotency-key");
    expect(ids).toContain("state-transitions");
    expect(ids).toContain("trust-boundary-client-status");
  });
});

describe("match (auto mode)", () => {
  test("matches payments when text mentions Stripe + paymentintent + refund", () => {
    const result = match("Implement Stripe paymentIntent flow with refund support and idempotency");
    expect(result?.specialization.name).toBe("payments");
    expect(result?.confidence).toBeGreaterThanOrEqual(0.3);
  });

  test("matches auth when text mentions jwt + login + token", () => {
    const result = match("We need to add JWT-based login with refresh-token and revocation");
    expect(result?.specialization.name).toBe("auth");
  });

  test("matches booking on appointment + slot + calendar", () => {
    const result = match("Online booking with appointment slot calendar availability");
    expect(result?.specialization.name).toBe("booking");
  });

  test("returns undefined when no specialization is confident enough", () => {
    expect(match("Add a CSS spinner to the homepage")).toBeUndefined();
  });

  test("returns the highest-confidence specialization when multiple match", () => {
    // Both auth and payments keywords; auth has more keyword density.
    const result = match("session token jwt oauth refresh-token login logout stripe");
    expect(result?.specialization.name).toBe("auth");
  });
});

describe("match (strict mode)", () => {
  test("returns named specialization with confidence 1 when forceMatch is set", () => {
    const result = match("anything at all", { mode: "strict", forceMatch: "payments" });
    expect(result?.specialization.name).toBe("payments");
    expect(result?.confidence).toBe(1);
  });

  test("returns undefined when forceMatch is omitted in strict mode", () => {
    expect(match("stripe refund paymentintent", { mode: "strict" })).toBeUndefined();
  });

  test("throws when forceMatch names an unknown specialization", () => {
    expect(() => match("x", { mode: "strict", forceMatch: "nonexistent" })).toThrow(
      SpecializationRegistryError,
    );
  });
});

describe("loadRegistry", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spec-registry-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns built-ins when directory is empty", () => {
    const r = loadRegistry(dir);
    expect(r.length).toBe(BUILTIN_SPECIALIZATIONS.length);
  });

  test("returns built-ins when directory is missing", () => {
    const r = loadRegistry(join(dir, "missing"));
    expect(r.length).toBe(BUILTIN_SPECIALIZATIONS.length);
  });

  test("project-local files override built-ins by name", () => {
    const override = {
      name: "payments",
      description: "custom payments",
      keywords: ["stripe"],
      invariants: [{ id: "x", description: "x", required: true }],
      confidenceThreshold: 0.1,
    };
    writeFileSync(join(dir, "payments.json"), JSON.stringify(override));
    const r = loadRegistry(dir);
    const p = r.find((s) => s.name === "payments");
    expect(p?.description).toBe("custom payments");
    expect(p?.invariants.length).toBe(1);
  });

  test("project-local file with a new name is appended", () => {
    const fresh = {
      name: "ecommerce-checkout",
      description: "new spec",
      keywords: ["checkout", "cart"],
      invariants: [{ id: "i", description: "i", required: true }],
      confidenceThreshold: 0.5,
    };
    writeFileSync(join(dir, "ecommerce.json"), JSON.stringify(fresh));
    const r = loadRegistry(dir);
    expect(r.some((s) => s.name === "ecommerce-checkout")).toBe(true);
  });

  test("throws on malformed JSON", () => {
    writeFileSync(join(dir, "bad.json"), "{this is not json}");
    expect(() => loadRegistry(dir)).toThrow(SpecializationRegistryError);
  });
});
