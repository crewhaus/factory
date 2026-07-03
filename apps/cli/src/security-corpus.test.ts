import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyText } from "@crewhaus/prompt-injection-detector";
import {
  RULE_IDS,
  type SecurityCorpus,
  SecurityCorpusError,
  buildSecurityCorpus,
  checkSecurityCorpus,
  clusterCandidateRules,
  exemplarForRule,
  harvestBlockedAttempts,
  harvestNearMisses,
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
  test("observed rules with an exemplar become regression cases; gaps are separated", () => {
    const harvest = {
      sessionsScanned: 1,
      redactions: 3,
      ruleHits: [
        { rule: "ignore-previous", count: 3 },
        { rule: "unicode-tag-spoof", count: 1 }, // real rule, no exemplar
      ],
      unknownIds: ["ghost-rule"],
    };
    const corpus = buildSecurityCorpus(harvest, "all", "2026-07-02T00:00:00.000Z");
    expect(corpus.cases).toEqual([
      {
        rule: "ignore-previous",
        observed: 3,
        exemplar: exemplarForRule("ignore-previous") as string,
      },
    ]);
    expect(corpus.withoutExemplar).toEqual([{ rule: "unicode-tag-spoof", count: 1 }]);
    expect(corpus.unknownIds).toEqual(["ghost-rule"]);
  });

  test("no harvested attack payload is embedded — cases carry only assembled exemplars", () => {
    const harvest = {
      sessionsScanned: 1,
      redactions: 1,
      ruleHits: [{ rule: "destructive-rm", count: 1 }],
      unknownIds: [],
    };
    const corpus = buildSecurityCorpus(harvest, "all", "2026-07-02T00:00:00.000Z");
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
      cases: [{ rule: "ignore-previous", observed: 2, exemplar: "x" }],
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
    const corpus = buildSecurityCorpus(
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
      cases: [{ rule: "ignore-previous", observed: 5, exemplar: "hello world" }],
      withoutExemplar: [],
      unknownIds: [],
    };
    const result = await checkSecurityCorpus(corpus);
    expect(result.verdict).toBe("fail");
    expect(result.regressions).toEqual([
      { rule: "ignore-previous", classification: "clean", stillBlocked: false },
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
    expect(c?.samples).toEqual(["you must a", "you must b", "you must c"]);
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
