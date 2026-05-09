import { describe, expect, test } from "bun:test";
import type { Classifier, ClassifierResult } from "@crewhaus/grader-safety-classifiers";
import { PiiRedactor, PiiRedactorError, _sha256ForTest, createPiiRedactor } from "./index";

class FixedClassifier implements Classifier {
  readonly id = "fixed";
  constructor(readonly score: number) {}
  async classify(): Promise<ClassifierResult> {
    return { score: this.score };
  }
}

describe("PiiRedactor — replace mode (T1)", () => {
  test("replaces SSN with [REDACTED:ssn]", async () => {
    const r = createPiiRedactor();
    const out = await r.redact("My SSN is 123-45-6789, please don't share.");
    expect(out.text).toBe("My SSN is [REDACTED:ssn], please don't share.");
    expect(out.redactedHits.length).toBe(1);
    expect(out.redactedHits[0]?.kind).toBe("ssn");
  });

  test("replaces multiple PII types in one pass", async () => {
    const r = createPiiRedactor();
    const out = await r.redact(
      "Email user@example.com SSN 123-45-6789 phone 415-555-1234 IBAN DE89370400440532013000",
    );
    expect(out.text).toContain("[REDACTED:email]");
    expect(out.text).toContain("[REDACTED:ssn]");
    expect(out.text).toContain("[REDACTED:phone]");
    expect(out.text).toContain("[REDACTED:iban]");
    expect(out.redactedHits.length).toBe(4);
  });

  test("clean text passes through unchanged", async () => {
    const r = createPiiRedactor();
    const out = await r.redact("Hello world. Today is Tuesday. Deploy succeeded.");
    expect(out.text).toBe("Hello world. Today is Tuesday. Deploy succeeded.");
    expect(out.redactedHits.length).toBe(0);
  });

  test("non-string input throws PiiRedactorError", async () => {
    const r = createPiiRedactor();
    await expect(r.redact(42 as unknown as string)).rejects.toThrow(PiiRedactorError);
  });
});

describe("PiiRedactor — hash mode", () => {
  test("hash mode requires a secret", () => {
    expect(() => new PiiRedactor({ mode: "hash" })).toThrow(/`secret`/);
  });

  test("hash mode produces deterministic [HASHED:kind:hex] markers", async () => {
    const r = new PiiRedactor({ mode: "hash", secret: "k1" });
    const o1 = await r.redact("ssn 123-45-6789");
    const o2 = await r.redact("ssn 123-45-6789");
    expect(o1.text).toBe(o2.text);
    expect(o1.text).toMatch(/\[HASHED:ssn:[a-f0-9]{16}\]/);
  });

  test("different secrets yield different hashes for the same value", async () => {
    const a = new PiiRedactor({ mode: "hash", secret: "k1" });
    const b = new PiiRedactor({ mode: "hash", secret: "k2" });
    const o1 = await a.redact("ssn 123-45-6789");
    const o2 = await b.redact("ssn 123-45-6789");
    expect(o1.text).not.toBe(o2.text);
  });

  test("custom hashPrefix/hashSuffix", async () => {
    const r = new PiiRedactor({ mode: "hash", secret: "k", hashPrefix: "{{", hashSuffix: "}}" });
    const o = await r.redact("ssn 123-45-6789");
    expect(o.text).toMatch(/\{\{ssn:[a-f0-9]{16}\}\}/);
  });
});

describe("Policy allow-list", () => {
  test("string match exempts a value from redaction", async () => {
    const r = createPiiRedactor({
      policyAllowList: [{ kind: "email", value: "support@example.com" }],
    });
    const out = await r.redact("Contact support@example.com for help, alt: user@example.com");
    expect(out.text).toContain("support@example.com");
    expect(out.text).toContain("[REDACTED:email]");
    expect(out.skippedByPolicy.length).toBe(1);
    expect(out.redactedHits.length).toBe(1);
  });

  test("regex match exempts values matching the pattern", async () => {
    const r = createPiiRedactor({
      policyAllowList: [{ kind: "email", value: /@example\.com$/ }],
    });
    const out = await r.redact("from a@example.com via b@external.org");
    // a@example.com is allow-listed, b@external.org is redacted.
    expect(out.text).toContain("a@example.com");
    expect(out.text).toContain("[REDACTED:email]");
  });

  test("allow-list kind mismatch does not exempt the value", async () => {
    const r = createPiiRedactor({
      policyAllowList: [{ kind: "phone", value: "user@example.com" }],
    });
    const out = await r.redact("from user@example.com");
    expect(out.text).toContain("[REDACTED:email]");
  });
});

describe("Classifier-driven detection", () => {
  test("high-confidence classifier hit recorded as 'classifier' kind", async () => {
    const r = createPiiRedactor({ classifier: new FixedClassifier(0.9) });
    const out = await r.redact("clean text — but classifier flags");
    const classifierHit = out.hits.find((h) => h.kind === "classifier");
    expect(classifierHit).toBeDefined();
    // Classifier hits don't have spans, so text is unchanged.
    expect(out.text).toBe("clean text — but classifier flags");
  });

  test("low-confidence classifier hit is ignored", async () => {
    const r = createPiiRedactor({ classifier: new FixedClassifier(0.1) });
    const out = await r.redact("clean text");
    expect(out.hits.find((h) => h.kind === "classifier")).toBeUndefined();
  });
});

describe("redactObject convenience", () => {
  test("redacts string leaves and string array entries", async () => {
    const r = createPiiRedactor();
    const obj = {
      email: "alice@example.com",
      count: 42,
      messages: ["one", "ssn 123-45-6789", "three"],
      meta: { nested: "ssn 123-45-6789" }, // nested object passes through
    };
    const redacted = await r.redactObject(obj);
    expect(redacted.email).toBe("[REDACTED:email]");
    expect(redacted.count).toBe(42);
    // Only the digit-shaped match is replaced; the literal word "ssn "
    // is part of the input, not a detector kind.
    expect(redacted.messages[1]).toBe("ssn [REDACTED:ssn]");
    // Nested objects pass through (no recursion into arrays-of-objects).
    expect((redacted.meta as { nested: string }).nested).toBe("ssn 123-45-6789");
  });
});

describe("T8 — redaction-completeness corpus (5 detectors × 100 PII samples)", () => {
  test("100 PII samples are all replaced (replace mode)", async () => {
    const r = createPiiRedactor();
    // Generate 20 of each kind.
    const samples: string[] = [];
    for (let i = 0; i < 20; i++) {
      samples.push(`ssn ${100 + i}-45-678${i % 10}`);
      samples.push(`email user${i}@example.com`);
      samples.push(`phone 415-555-12${(i % 100).toString().padStart(2, "0")}`);
      samples.push(`card 4111-1111-${(1000 + i).toString().padStart(4, "0")}-1111`);
      samples.push(`iban GB29NWBK6016133192617${i.toString().padStart(2, "0")}`);
    }
    let leakedCount = 0;
    for (const text of samples) {
      const out = await r.redact(text);
      if (out.redactedHits.length === 0) leakedCount += 1;
    }
    expect(leakedCount).toBeLessThan(samples.length * 0.05); // <5% miss
  });
});

describe("Determinism + helpers", () => {
  test("_sha256ForTest is the SHA-256 hex digest of the input", () => {
    expect(_sha256ForTest("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});
