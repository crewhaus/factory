#!/usr/bin/env bun
/**
 * Section 39 pii-redactor smoke.
 *
 * Probes:
 *   A) replace mode redacts SSN/email/phone/CC/IBAN simultaneously
 *   B) hash mode produces deterministic markers; different secrets
 *      yield different markers
 *   C) policy allow-list exempts whitelisted values
 *   D) redactObject walks string fields + string arrays
 *   E) T8 — 100-sample multi-detector corpus: <5% leakage
 */
import { MockPiiClassifier } from "@crewhaus/grader-safety-classifiers";
import { PiiRedactor, createPiiRedactor } from "@crewhaus/pii-redactor";

const log = (s: string) => process.stdout.write(`[section-39-pii] ${s}\n`);
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) log(`✓ ${name}`);
  else {
    log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
};

// ── Probe A: replace mode ─────────────────────────────────────────────────
log("probe A: replace mode redacts multi-PII text");
{
  const r = createPiiRedactor();
  const out = await r.redact(
    "Hi alice@example.com — call 415-555-1234 — SSN 123-45-6789 — IBAN GB29NWBK60161331926819",
  );
  check("email redacted", out.text.includes("[REDACTED:email]"));
  check("phone redacted", out.text.includes("[REDACTED:phone]"));
  check("ssn redacted", out.text.includes("[REDACTED:ssn]"));
  check("iban redacted", out.text.includes("[REDACTED:iban]"));
  check("4 distinct redactions", out.redactedHits.length === 4);
}

// ── Probe B: hash mode determinism ────────────────────────────────────────
log("probe B: hash mode determinism + secret-dependent output");
{
  const a = new PiiRedactor({ mode: "hash", secret: "secret-1" });
  const b = new PiiRedactor({ mode: "hash", secret: "secret-2" });
  const t = "ssn 123-45-6789";
  const o1 = await a.redact(t);
  const o2 = await a.redact(t);
  const o3 = await b.redact(t);
  check("same secret → same hash", o1.text === o2.text);
  check("different secret → different hash", o1.text !== o3.text);
  check("hash marker shape [HASHED:kind:hex]", /\[HASHED:ssn:[a-f0-9]{16}\]/.test(o1.text));
}

// ── Probe C: policy allow-list ────────────────────────────────────────────
log("probe C: policy allow-list exempts whitelisted values");
{
  const r = createPiiRedactor({
    policyAllowList: [
      { kind: "email", value: "support@crewhaus.test" },
      { kind: "email", value: /@allowed\.com$/ },
    ],
  });
  const out = await r.redact(
    "Contact support@crewhaus.test or jane@allowed.com — but redact joe@external.org",
  );
  check(
    "string-match allow-list keeps support@crewhaus.test",
    out.text.includes("support@crewhaus.test"),
  );
  check("regex-match allow-list keeps @allowed.com email", out.text.includes("jane@allowed.com"));
  check("non-allow-listed email redacted", out.text.includes("[REDACTED:email]"));
  check("2 emails skipped by policy", out.skippedByPolicy.length === 2);
}

// ── Probe D: redactObject ─────────────────────────────────────────────────
log("probe D: redactObject walks string leaves + string arrays");
{
  const r = createPiiRedactor();
  const audit = {
    user_email: "user@example.com",
    note: "no pii here",
    flags: ["ssn 123-45-6789", "ok"],
    count: 7,
  };
  const redacted = await r.redactObject(audit);
  check("user_email redacted", redacted.user_email === "[REDACTED:email]");
  check("non-pii note unchanged", redacted.note === "no pii here");
  // The digit portion is redacted, keeping the literal "ssn " prefix.
  check("flags[0] digits redacted", redacted.flags[0] === "ssn [REDACTED:ssn]");
  check("count passed through", redacted.count === 7);
}

// ── Probe E: T8 100-sample corpus ─────────────────────────────────────────
log("probe E: T8 — 100 PII samples × 5 detectors, leakage < 5%");
{
  const r = createPiiRedactor({ classifier: new MockPiiClassifier() });
  const samples: string[] = [];
  for (let i = 0; i < 20; i++) {
    samples.push(
      `SSN ${(100 + i).toString()}-${(40 + (i % 50)).toString().padStart(2, "0")}-${(1000 + i).toString().padStart(4, "0")}`,
    );
    samples.push(`email user${i}@example.com sent the report`);
    samples.push(`phone 415-555-${(2000 + i).toString().slice(0, 4)}`);
    samples.push(`card 4111-1111-${(1000 + i).toString().padStart(4, "0")}-1111 was charged`);
    samples.push(`IBAN GB29NWBK6016133192${(60000 + i).toString().padStart(5, "0")}`);
  }
  let leaked = 0;
  for (const text of samples) {
    const out = await r.redact(text);
    if (out.redactedHits.length === 0) leaked += 1;
  }
  const leakRate = leaked / samples.length;
  check(`leakage rate ${(leakRate * 100).toFixed(1)}% < 5%`, leakRate < 0.05);
}

if (failed === 0) {
  log("ALL PROBES PASSED");
  process.exit(0);
}
log(`FAILED: ${failed} probe(s)`);
process.exit(1);
