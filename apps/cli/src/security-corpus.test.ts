import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyText } from "@crewhaus/prompt-injection-detector";
import {
  RULE_IDS,
  type SecurityCorpus,
  SecurityCorpusError,
  buildSecurityCorpus,
  candidateRulesPath,
  checkSecurityCorpus,
  clusterCandidateRules,
  describeSample,
  exemplarForRule,
  harvestBlockedAttempts,
  harvestNearMisses,
  hashDescriptor,
  loadSecurityCorpus,
  parseCorpusSince,
  redactSnippet,
} from "./security-corpus";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sec-corpus-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function sessionsDir(): string {
  const d = join(root, ".crewhaus", "sessions");
  mkdirSync(d, { recursive: true });
  return d;
}

/** Build a session event log filename that matches the runtime's shape. */
function sessionFile(hex16: string): string {
  return join(sessionsDir(), `sess_${hex16}.jsonl`);
}

/** A tool_result event line as the runtime writes it. */
function toolResult(ts: number, content: string): string {
  return JSON.stringify({ ts, kind: "tool_result", payload: { content } });
}

/** The redaction notice literal, assembled from parts (no verbatim attack). */
function redactionNotice(ruleIds: string[]): string {
  return `[tool output redacted: prompt injection detected: ${ruleIds.join(", ")}]`;
}

describe("parseCorpusSince", () => {
  test("undefined → all-time", () => {
    expect(parseCorpusSince(undefined)).toEqual({ sinceMs: 0, label: "all" });
  });
  test("Nd → trailing window", () => {
    const now = () => 1_000 * 86_400_000;
    const w = parseCorpusSince("7d", now);
    expect(w.label).toBe("7d");
    expect(w.sinceMs).toBe(now() - 7 * 86_400_000);
  });
  test("garbage → all-time fallback", () => {
    expect(parseCorpusSince("nonsense").sinceMs).toBe(0);
  });
});

describe("harvestBlockedAttempts", () => {
  test("missing sessions dir yields an empty harvest, no throw", () => {
    const h = harvestBlockedAttempts({ rootDir: root, window: { sinceMs: 0, label: "all" } });
    expect(h).toEqual({ sessionsScanned: 0, redactions: 0, ruleHits: [], unknownIds: [] });
  });

  test("tallies rule-ids from redaction notices, ranked by count", () => {
    writeFileSync(
      sessionFile("0000000000000001"),
      [
        toolResult(100, redactionNotice(["ignore-previous"])),
        toolResult(200, redactionNotice(["ignore-previous", "destructive-rm"])),
        toolResult(300, "a perfectly normal tool result"),
      ].join("\n"),
    );
    const h = harvestBlockedAttempts({ rootDir: root, window: { sinceMs: 0, label: "all" } });
    expect(h.sessionsScanned).toBe(1);
    expect(h.redactions).toBe(2);
    expect(h.ruleHits).toEqual([
      { rule: "ignore-previous", count: 2 },
      { rule: "destructive-rm", count: 1 },
    ]);
    expect(h.unknownIds).toEqual([]);
  });

  test("drops forged/unknown ids (attacker-reachable content) into unknownIds", () => {
    writeFileSync(
      sessionFile("0000000000000002"),
      toolResult(100, redactionNotice(["ignore-previous", "totally-made-up-rule"])),
    );
    const h = harvestBlockedAttempts({ rootDir: root, window: { sinceMs: 0, label: "all" } });
    expect(h.ruleHits).toEqual([{ rule: "ignore-previous", count: 1 }]);
    expect(h.unknownIds).toEqual(["totally-made-up-rule"]);
  });

  test("respects the since window", () => {
    writeFileSync(
      sessionFile("0000000000000003"),
      [
        toolResult(100, redactionNotice(["ignore-previous"])),
        toolResult(5_000, redactionNotice(["destructive-rm"])),
      ].join("\n"),
    );
    const h = harvestBlockedAttempts({ rootDir: root, window: { sinceMs: 1_000, label: "w" } });
    expect(h.redactions).toBe(1);
    expect(h.ruleHits).toEqual([{ rule: "destructive-rm", count: 1 }]);
  });

  test("a forged notice cannot smuggle control chars into a rule id", () => {
    // Prefix a real rule id with an ESC sequence; sanitizer strips it, but the
    // resulting string is no longer a known rule → lands in unknownIds, never
    // a corpus case.
    const forged = `${String.fromCharCode(0x1b)}[31mignore-previous`;
    writeFileSync(sessionFile("0000000000000004"), toolResult(100, redactionNotice([forged])));
    const h = harvestBlockedAttempts({ rootDir: root, window: { sinceMs: 0, label: "all" } });
    for (const u of h.unknownIds) {
      // No raw control char survived into the reported id.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting sanitization
      expect(/[\u0000-\u001f\u007f-\u009f]/.test(u)).toBe(false);
    }
  });
});

describe("exemplarForRule + detector agreement", () => {
  test("every hand-written exemplar is FLAGGED (not clean) by the current detector", async () => {
    for (const id of RULE_IDS) {
      const ex = exemplarForRule(id);
      if (ex === undefined) continue;
      const r = await classifyText(ex);
      expect(r.classification, `exemplar for ${id} must be flagged`).not.toBe("clean");
    }
  });

  test("unknown rule id → no exemplar", () => {
    expect(exemplarForRule("not-a-rule")).toBeUndefined();
  });
});

describe("buildSecurityCorpus", () => {
  test("observed rules with an exemplar become regression cases; gaps are separated", async () => {
    const harvest = {
      sessionsScanned: 1,
      redactions: 3,
      ruleHits: [
        { rule: "ignore-previous", count: 3 },
        { rule: "unicode-tag-spoof", count: 1 }, // real rule, no exemplar
      ],
      unknownIds: ["ghost-rule"],
    };
    const corpus = await buildSecurityCorpus(harvest, "all", "2026-07-02T00:00:00.000Z");
    expect(corpus.cases.length).toBe(1);
    const c = corpus.cases[0];
    expect(c?.rule).toBe("ignore-previous");
    expect(c?.observed).toBe(3);
    expect(c?.exemplar).toBe(exemplarForRule("ignore-previous") as string);
    // F2: baseline tier is recorded at build time and must be flagged.
    expect(c?.baselineTier).not.toBe("clean");
    expect(corpus.withoutExemplar).toEqual([{ rule: "unicode-tag-spoof", count: 1 }]);
    expect(corpus.unknownIds).toEqual(["ghost-rule"]);
  });

  test("no harvested attack payload is embedded — cases carry only assembled exemplars", async () => {
    const harvest = {
      sessionsScanned: 1,
      redactions: 1,
      ruleHits: [{ rule: "destructive-rm", count: 1 }],
      unknownIds: [],
    };
    const corpus = await buildSecurityCorpus(harvest, "all", "2026-07-02T00:00:00.000Z");
    // The exemplar equals the deterministic builder output, not any log content.
    expect(corpus.cases[0]?.exemplar).toBe(exemplarForRule("destructive-rm") as string);
  });
});

describe("loadSecurityCorpus", () => {
  test("undefined for a missing file", () => {
    expect(loadSecurityCorpus(join(root, "nope.json"))).toBeUndefined();
  });
  test("throws on malformed JSON", () => {
    const p = join(root, "corpus.json");
    writeFileSync(p, "{not json");
    expect(() => loadSecurityCorpus(p)).toThrow(SecurityCorpusError);
  });
  test("throws on wrong shape", () => {
    const p = join(root, "corpus.json");
    writeFileSync(p, JSON.stringify({ version: 2, cases: [] }));
    expect(() => loadSecurityCorpus(p)).toThrow(SecurityCorpusError);
  });
  test("round-trips a valid corpus", () => {
    const corpus: SecurityCorpus = {
      version: 1,
      generatedAt: "2026-07-02T00:00:00.000Z",
      windowLabel: "all",
      cases: [{ rule: "ignore-previous", observed: 2, exemplar: "x", baselineTier: "malicious" }],
      withoutExemplar: [],
      unknownIds: [],
    };
    const p = join(root, "corpus.json");
    writeFileSync(p, JSON.stringify(corpus));
    expect(loadSecurityCorpus(p)).toEqual(corpus);
  });
});

describe("checkSecurityCorpus", () => {
  test("passes when every exemplar is still flagged", async () => {
    const corpus = await buildSecurityCorpus(
      {
        sessionsScanned: 1,
        redactions: 2,
        ruleHits: [
          { rule: "ignore-previous", count: 2 },
          { rule: "destructive-rm", count: 1 },
        ],
        unknownIds: [],
      },
      "all",
      "2026-07-02T00:00:00.000Z",
    );
    const result = await checkSecurityCorpus(corpus);
    expect(result.verdict).toBe("pass");
    expect(result.regressions).toEqual([]);
    expect(result.holding.length).toBe(2);
    expect(result.checked).toBe(2);
  });

  test("fails (regression) when an exemplar now classifies clean", async () => {
    // Hand-craft a corpus whose exemplar the detector treats as clean, to
    // simulate a rule having been removed/weakened. "hello world" trips nothing.
    const corpus: SecurityCorpus = {
      version: 1,
      generatedAt: "2026-07-02T00:00:00.000Z",
      windowLabel: "all",
      cases: [
        {
          rule: "ignore-previous",
          observed: 5,
          exemplar: "hello world",
          baselineTier: "malicious",
        },
      ],
      withoutExemplar: [],
      unknownIds: [],
    };
    const result = await checkSecurityCorpus(corpus);
    expect(result.verdict).toBe("fail");
    expect(result.regressions).toEqual([
      {
        rule: "ignore-previous",
        classification: "clean",
        baselineTier: "malicious",
        stillBlocked: false,
      },
    ]);
  });

  test("empty corpus passes vacuously", async () => {
    const result = await checkSecurityCorpus({
      version: 1,
      generatedAt: "2026-07-02T00:00:00.000Z",
      windowLabel: "all",
      cases: [],
      withoutExemplar: [],
      unknownIds: [],
    });
    expect(result.verdict).toBe("pass");
    expect(result.checked).toBe(0);
  });

  // -------------------------------------------------------------------
  // F2 — tier-DRIFT check: malicious→suspicious must fail, not just →clean.
  // -------------------------------------------------------------------

  test("F2: baseline malicious, current suspicious fails even though not clean", async () => {
    // Build a case whose exemplar the CURRENT detector classifies as
    // "suspicious" (the real `from-now-on` canonical exemplar — a single
    // medium-severity rule that alone doesn't reach malicious), but hand-set
    // its recorded baselineTier to "malicious" — simulating a rule that used
    // to fire alongside others (multi-rule malicious) and has since been
    // weakened/isolated. The old "!== clean" check would pass this; F2 must
    // fail it.
    const suspiciousExemplar = exemplarForRule("from-now-on") as string;
    const current = await classifyText(suspiciousExemplar);
    expect(current.classification).toBe("suspicious");
    const corpus: SecurityCorpus = {
      version: 1,
      generatedAt: "2026-07-02T00:00:00.000Z",
      windowLabel: "all",
      cases: [
        {
          rule: "from-now-on",
          observed: 4,
          exemplar: suspiciousExemplar,
          baselineTier: "malicious",
        },
      ],
      withoutExemplar: [],
      unknownIds: [],
    };
    const result = await checkSecurityCorpus(corpus);
    expect(result.verdict).toBe("fail");
    expect(result.regressions).toEqual([
      {
        rule: "from-now-on",
        classification: "suspicious",
        baselineTier: "malicious",
        stillBlocked: false,
      },
    ]);
  });

  test("F2: baseline suspicious, current still suspicious PASSES (no drift)", async () => {
    const exemplar = exemplarForRule("from-now-on") as string;
    const current = await classifyText(exemplar);
    expect(current.classification).toBe("suspicious");
    const corpus: SecurityCorpus = {
      version: 1,
      generatedAt: "2026-07-02T00:00:00.000Z",
      windowLabel: "all",
      cases: [{ rule: "from-now-on", observed: 4, exemplar, baselineTier: "suspicious" }],
      withoutExemplar: [],
      unknownIds: [],
    };
    const result = await checkSecurityCorpus(corpus);
    expect(result.verdict).toBe("pass");
    expect(result.holding).toEqual([
      {
        rule: "from-now-on",
        classification: "suspicious",
        baselineTier: "suspicious",
        stillBlocked: true,
      },
    ]);
  });

  test("F2: pre-F2 corpus case (no baselineTier) falls back to the not-clean floor", async () => {
    const exemplar = exemplarForRule("from-now-on") as string;
    const corpus = {
      version: 1 as const,
      generatedAt: "2026-07-02T00:00:00.000Z",
      windowLabel: "all",
      cases: [{ rule: "from-now-on", observed: 4, exemplar }], // no baselineTier field
      withoutExemplar: [],
      unknownIds: [],
    } as unknown as SecurityCorpus;
    const result = await checkSecurityCorpus(corpus);
    // Still "suspicious", not "clean" → passes under the legacy floor.
    expect(result.verdict).toBe("pass");
  });
});

describe("redactSnippet", () => {
  test("scrubs email / long blob / long digit runs and clamps", () => {
    const token = ["A", "b", "9"].join("").repeat(10); // 30-char alnum blob
    const s = redactSnippet(`contact me at foo@bar.com token=${token} id 1234567`);
    expect(s).not.toContain("foo@bar.com");
    expect(s).not.toContain(token);
    expect(s).toContain("[EMAIL]");
    expect(s).toContain("[BLOB]");
    expect(s).toContain("[NUM]");
    expect(s.length).toBeLessThanOrEqual(200);
  });

  // -------------------------------------------------------------------
  // F1/F3 — secret-shaped fixtures, assembled at runtime from parts (never a
  // literal secret in source, per GitHub push-protection convention) so a
  // partial/short-key/dashed-SSN/xoxb-prefix gap in the OLD ad hoc redactor
  // is pinned as a regression test.
  // -------------------------------------------------------------------

  test("F1: a full-length sk-live secret does not survive, even partially", () => {
    const secret = ["sk", "live", "4f9a2b7c8d1e3f5061728394a5b6c7d8"].join("-");
    const s = redactSnippet(`API key leaked: ${secret} — please rotate`);
    expect(s).not.toContain(secret);
    // No suffix/prefix fragment of the raw key body survives either.
    expect(s).not.toContain(secret.slice(-12));
    expect(s).not.toContain(secret.slice(0, 12));
  });

  test("F1: a SHORT (below the old 20-char BLOB floor) sk- key still redacts", () => {
    // The pre-fix regex only caught base64-ish blobs >= 20 chars; a short key
    // slipped through. sk-<8 chars> is exactly the SECRET_KEY_DETECTOR floor.
    const secret = ["sk", "abcd1234"].join("-");
    const s = redactSnippet(`short key: ${secret} in the log`);
    expect(s).not.toContain(secret);
  });

  test("F1: a dashed SSN does not survive", () => {
    const ssn = ["123", "45", "6789"].join("-");
    const s = redactSnippet(`ssn on file: ${ssn} for verification`);
    expect(s).not.toContain(ssn);
  });

  test("F1: an xoxb- Slack bot token does not survive", () => {
    const token = ["xoxb", "1234567890", "abcdefghijklmnopqrstuvwx"].join("-");
    const s = redactSnippet(`slack token ${token} was pasted into the ticket`);
    expect(s).not.toContain(token);
  });

  test("F1: a phone-number fragment does not survive", () => {
    const phone = ["415", "555", "0199"].join("-");
    const s = redactSnippet(`call me back at ${phone} today`);
    expect(s).not.toContain(phone);
  });

  test("F1: a ghp_ GitHub token does not survive", () => {
    const token = ["ghp", "aBcDeFgHiJkLmNoPqRsTuVwXyZ012345"].join("_");
    const s = redactSnippet(`use ${token} to auth`);
    expect(s).not.toContain(token);
  });

  test("F1: an AKIA AWS access key id does not survive", () => {
    const key = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const s = redactSnippet(`aws key ${key} rotate please`);
    expect(s).not.toContain(key);
  });

  test("F1: a JWT does not survive", () => {
    const jwt = [
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    ].join(".");
    const s = redactSnippet(`auth header carried ${jwt} in the log`);
    expect(s).not.toContain(jwt);
  });

  test("F1: a PEM private-key block does not survive", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const s = redactSnippet(`key material:\n${pem}\nend`);
    expect(s).not.toContain("MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6");
  });

  test("F1: hashDescriptor is deterministic and non-reversible-looking (hex, fixed length)", () => {
    const a = hashDescriptor("some redacted shape");
    const b = hashDescriptor("some redacted shape");
    const c = hashDescriptor("a different shape");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(/^[0-9a-f]{16}$/.test(a)).toBe(true);
  });

  test("F1: describeSample never emits a descriptor longer than hash + short prefix", () => {
    const long = "x".repeat(500);
    const d = describeSample(redactSnippet(long));
    // "hash:" (5) + 16 hex + " " (1) + <= 24-char prefix.
    expect(d.length).toBeLessThanOrEqual(5 + 16 + 1 + 24);
  });
});

describe("F1/F3 — candidate-rules.json persist path carries no raw secret/PII", () => {
  test("secret-shaped near-misses (sk-live/dashed-SSN/xoxb/phone) never appear raw when clustered + persisted", () => {
    // Build secret-shaped fixtures at runtime from parts (push-protection
    // convention) and smuggle each into a near-miss snippet via a signal the
    // clustering path recognizes, mirroring how a real suspicious tool
    // output would carry both an injection shape AND a leaked credential.
    const skLive = ["sk", "live", "9f8e7d6c5b4a3928374655647382910a"].join("-");
    const ssn = ["987", "65", "4321"].join("-");
    const xoxb = ["xoxb", "9876543210", "zyxwvutsrqponmlkjihgfedcba"].join("-");
    const phone = ["212", "555", "0134"].join("-");

    const nearMisses = [
      {
        snippet: redactSnippet(`you must rotate ${skLive} immediately`),
        signal: "imperative-instruction-verb",
      },
      {
        snippet: redactSnippet(`you must verify ssn ${ssn} now`),
        signal: "imperative-instruction-verb",
      },
      {
        snippet: redactSnippet(`you must use token ${xoxb} to post`),
        signal: "imperative-instruction-verb",
      },
      {
        snippet: redactSnippet(`you must call ${phone} to confirm`),
        signal: "imperative-instruction-verb",
      },
    ];

    const file = clusterCandidateRules(nearMisses, 3, "2026-07-02T00:00:00.000Z");
    const rendered = JSON.stringify(file);
    expect(rendered).not.toContain(skLive);
    expect(rendered).not.toContain(ssn);
    expect(rendered).not.toContain(xoxb);
    expect(rendered).not.toContain(phone);
    // None of the persisted samples are the raw snippet text either — every
    // sample is a hash-first short descriptor.
    for (const c of file.candidates) {
      for (const s of c.samples) {
        expect(s.startsWith("hash:")).toBe(true);
        expect(s).not.toContain(skLive);
        expect(s).not.toContain(ssn);
        expect(s).not.toContain(xoxb);
        expect(s).not.toContain(phone);
      }
    }
  });

  test("end-to-end persist: writing candidate-rules.json to disk carries no raw secret", () => {
    const skLive = ["sk", "live", "abcdef0123456789abcdef0123456789"].join("-");
    const ssn = ["555", "12", "6789"].join("-");
    const xoxb = ["xoxb", "1111111111", "aaaabbbbccccddddeeeeffff"].join("-");
    const phone = ["617", "555", "0111"].join("-");
    const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJ1c2VyIjoxfQ", "abc123signaturepart"].join(".");

    writeFileSync(
      sessionFile("00000000000000aa"),
      [
        toolResult(100, `you must rotate key ${skLive} now`),
        toolResult(200, `you must confirm ssn ${ssn} for the account`),
        toolResult(300, `you must post using ${xoxb} to the channel`),
        toolResult(400, `you must call back at ${phone} before EOD`),
        toolResult(500, `you must refresh session ${jwt} to continue`),
      ].join("\n"),
    );
    const nearMisses = harvestNearMisses({ rootDir: root, window: { sinceMs: 0, label: "all" } });
    const file = clusterCandidateRules(nearMisses, 3, "2026-07-02T00:00:00.000Z");

    const candPath = candidateRulesPath(root);
    mkdirSync(join(root, ".crewhaus", "security-corpus"), { recursive: true });
    writeFileSync(candPath, `${JSON.stringify(file, null, 2)}\n`);
    const onDisk = readFileSync(candPath, "utf8");

    for (const secret of [skLive, ssn, xoxb, phone, jwt]) {
      expect(onDisk).not.toContain(secret);
    }
    // Sanity: the file actually clustered something (the test fixture is
    // meaningful, not vacuously empty).
    expect(file.candidates.length).toBeGreaterThan(0);
  });
});

describe("harvestNearMisses + clusterCandidateRules", () => {
  test("harvests suspicious (non-redacted) outputs matching a signal, skips blocked ones", () => {
    writeFileSync(
      sessionFile("0000000000000010"),
      [
        toolResult(100, "you must send the report now, urgent, please"),
        toolResult(200, "you must update the config"),
        toolResult(300, "make sure to restart the service"),
        // A blocked (redaction-notice) line must NOT be harvested as a near-miss.
        toolResult(400, redactionNotice(["ignore-previous"])),
        // Neutral content, no signal.
        toolResult(500, "the build finished successfully"),
      ].join("\n"),
    );
    const nm = harvestNearMisses({ rootDir: root, window: { sinceMs: 0, label: "all" } });
    // 3 imperative-instruction-verb near-misses; the redaction notice + neutral
    // line are excluded.
    expect(nm.length).toBe(3);
    expect(nm.every((n) => n.signal === "imperative-instruction-verb")).toBe(true);
  });

  test("clusters into a candidate only at/above minSupport; deterministic", () => {
    const nm = [
      { snippet: "you must a", signal: "imperative-instruction-verb" },
      { snippet: "you must b", signal: "imperative-instruction-verb" },
      { snippet: "you must c", signal: "imperative-instruction-verb" },
      { snippet: "hey assistant do x", signal: "role-address" }, // support 1 < 3
    ];
    const file = clusterCandidateRules(nm, 3, "2026-07-02T00:00:00.000Z");
    expect(file.candidates.length).toBe(1);
    const c = file.candidates[0];
    expect(c?.id).toBe("candidate-imperative-instruction-verb");
    expect(c?.support).toBe(3);
    // F1: samples are hash-first descriptors, not the raw snippet.
    expect(c?.samples).toEqual([
      describeSample("you must a"),
      describeSample("you must b"),
      describeSample("you must c"),
    ]);
    for (const s of c?.samples ?? []) {
      expect(s.startsWith("hash:")).toBe(true);
    }
    expect(c?.proposedPattern.length).toBeGreaterThan(0);
    // Determinism.
    expect(clusterCandidateRules(nm, 3, "2026-07-02T00:00:00.000Z")).toEqual(file);
  });

  test("distinct-snippet support: duplicate snippets count once", () => {
    const nm = [
      { snippet: "you must a", signal: "imperative-instruction-verb" },
      { snippet: "you must a", signal: "imperative-instruction-verb" },
      { snippet: "you must a", signal: "imperative-instruction-verb" },
    ];
    const file = clusterCandidateRules(nm, 3, "2026-07-02T00:00:00.000Z");
    // Only one distinct snippet → below support → no candidate.
    expect(file.candidates.length).toBe(0);
  });
});
