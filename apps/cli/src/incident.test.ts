/**
 * Item 32 — incident bundle assembly tests: trigger classification, the
 * timestamp-based audit-session linkage, cost summarization, dir naming, the
 * assembled file set, and the eval-report-styled HTML render.
 */
import { describe, expect, test } from "bun:test";
import {
  type AuditRecordLike,
  type IncidentInputs,
  JUSTIFICATION_DENY_STORM_THRESHOLD,
  assembleIncidentBundle,
  classifyTrigger,
  countJustificationDenials,
  incidentDirName,
  matchAuditRecordsByWindow,
  renderIncidentHtml,
  summarizeCost,
} from "./incident";

function inputs(overrides: Partial<IncidentInputs> = {}): IncidentInputs {
  return {
    kind: "circuit_open",
    sessionId: "sess_0000000000000001",
    incidentTs: "2026-07-02T18:07:03.412Z",
    reason: "circuit anthropic → open",
    ringEvents: [],
    transcript: [],
    auditRecords: [],
    cost: { totalUsdMicros: 0, byModel: {} },
    spec: { name: "hello", version: "v2", hash: "abc123" },
    doctor: "all checks passed",
    window: { startTs: 1000, endTs: 2000 },
    ...overrides,
  };
}

describe("incidentDirName", () => {
  test("is filesystem-safe and sortable", () => {
    expect(incidentDirName("2026-07-02T18:07:03.412Z", "circuit_open")).toBe(
      "20260702T180703-circuit_open",
    );
  });
});

describe("classifyTrigger", () => {
  test("circuit → open triggers circuit_open", () => {
    const t = classifyTrigger(
      { kind: "circuit_state_changed", toState: "open", adapter: "anthropic", reason: "429s" },
      [],
    );
    expect(t?.kind).toBe("circuit_open");
    expect(t?.reason).toContain("anthropic");
  });

  test("circuit → closed is not a trigger", () => {
    expect(
      classifyTrigger({ kind: "circuit_state_changed", toState: "closed", adapter: "x" }, []),
    ).toBeUndefined();
  });

  test("egress-blocked triggers egress_blocked", () => {
    const t = classifyTrigger(
      {
        kind: "permission_decision",
        decision: "deny",
        outcome: "egress-blocked",
        toolName: "fetch",
      },
      [],
    );
    expect(t?.kind).toBe("egress_blocked");
  });

  test("a justification-deny storm triggers only past the threshold", () => {
    const denial = {
      kind: "permission_decision",
      decision: "deny",
      judgeModel: "claude-haiku",
      toolName: "bash",
    };
    // Ring already holds (threshold - 1) denials; this event tips it over.
    const ring = Array.from({ length: JUSTIFICATION_DENY_STORM_THRESHOLD - 1 }, () => denial);
    const t = classifyTrigger(denial, ring);
    expect(t?.kind).toBe("justification_deny_storm");

    // One short of the threshold ⇒ no trigger.
    const below = classifyTrigger(denial, ring.slice(0, JUSTIFICATION_DENY_STORM_THRESHOLD - 2));
    expect(below).toBeUndefined();
  });

  test("a lone policy deny (no judge) is not a storm", () => {
    expect(
      classifyTrigger({ kind: "permission_decision", decision: "deny", toolName: "bash" }, []),
    ).toBeUndefined();
  });
});

describe("countJustificationDenials", () => {
  test("counts only judge-backed denials", () => {
    const events = [
      { kind: "permission_decision", decision: "deny", judgeModel: "m" },
      { kind: "permission_decision", decision: "deny" }, // no judge
      { kind: "permission_decision", decision: "allow", judgeModel: "m" },
      { kind: "turn_end" },
    ];
    expect(countJustificationDenials(events)).toBe(1);
  });
});

describe("matchAuditRecordsByWindow", () => {
  const rec = (ts: number): AuditRecordLike => ({ ts, kind: "deployment_action", payload: {} });
  test("keeps records inside the window (± margin), drops outsiders", () => {
    const records = [rec(500), rec(1500), rec(2500), rec(10_000)];
    // window 1000..2000, margin 2000 ⇒ keep 500? (lo=-1000) yes; 1500 yes; 2500 yes (hi=4000); 10000 no.
    const matched = matchAuditRecordsByWindow(records, { startTs: 1000, endTs: 2000 });
    expect(matched.map((r) => r.ts)).toEqual([500, 1500, 2500]);
  });
  test("a tight margin excludes edge records", () => {
    const records = [rec(900), rec(1500), rec(2100)];
    const matched = matchAuditRecordsByWindow(records, { startTs: 1000, endTs: 2000 }, 0);
    expect(matched.map((r) => r.ts)).toEqual([1500]);
  });
});

describe("summarizeCost", () => {
  test("sums per-model, skips the FR-003 summary aggregate", () => {
    const events = [
      { kind: "cost_accrual", modelId: "a", costUsdMicros: 1_000_000 },
      { kind: "cost_accrual", modelId: "a", costUsdMicros: 500_000 },
      { kind: "cost_accrual", modelId: "b", costUsdMicros: 2_000_000 },
      { kind: "cost_accrual", modelId: "x", costUsdMicros: 9_000_000, summary: true },
      { kind: "turn_end" },
    ];
    const cost = summarizeCost(events);
    expect(cost.totalUsdMicros).toBe(3_500_000);
    expect(cost.byModel["a"]).toEqual({ calls: 2, usdMicros: 1_500_000 });
    expect(cost.byModel["b"]).toEqual({ calls: 1, usdMicros: 2_000_000 });
    expect(cost.byModel["x"]).toBeUndefined();
  });
});

describe("assembleIncidentBundle", () => {
  test("produces the full file set with a manifest", () => {
    const b = assembleIncidentBundle(
      inputs({
        ringEvents: [{ kind: "turn_end", timestamp: "2026-07-02T18:07:00Z" }],
        auditRecords: [{ ts: 1500, kind: "deployment_action", payload: { name: "hello" } }],
        cost: { totalUsdMicros: 1_000_000, byModel: { a: { calls: 1, usdMicros: 1_000_000 } } },
      }),
    );
    expect(b.dirName).toBe("20260702T180703-circuit_open");
    const names = b.files.map((f) => f.name).sort();
    expect(names).toEqual(
      [
        "audit.jsonl",
        "bundle.json",
        "cost.json",
        "doctor.txt",
        "events.jsonl",
        "index.html",
        "spec.json",
        "transcript.jsonl",
      ].sort(),
    );
    const manifest = JSON.parse(b.files.find((f) => f.name === "bundle.json")?.contents ?? "{}");
    expect(manifest.kind).toBe("circuit_open");
    expect(manifest.counts.ringEvents).toBe(1);
    expect(manifest.counts.auditRecords).toBe(1);
    expect(manifest.spec.name).toBe("hello");
  });

  test("jsonl files are newline-delimited and empty when there is no data", () => {
    const b = assembleIncidentBundle(inputs());
    const events = b.files.find((f) => f.name === "events.jsonl");
    expect(events?.contents).toBe("");
    const b2 = assembleIncidentBundle(inputs({ ringEvents: [{ a: 1 }, { b: 2 }] }));
    const events2 = b2.files.find((f) => f.name === "events.jsonl");
    expect(events2?.contents).toBe('{"a":1}\n{"b":2}\n');
  });

  test("index.html renders the eval-report shell + escapes content", () => {
    const html = renderIncidentHtml(
      inputs({
        reason: "<script>alert(1)</script>",
        ringEvents: [{ kind: "turn_end", timestamp: "2026-07-02T18:07:00Z" }],
      }),
    );
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Incident — circuit_open");
    // The dangerous reason is escaped, not injected.
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
