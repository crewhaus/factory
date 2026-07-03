/**
 * Item 48 — unit tests for the `crewhaus security digest` core: since-window
 * parsing, aggregation over seeded audit stores + session event logs, the
 * text/HTML/JSON renderers, and the webhook notifier.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAuditLog } from "@crewhaus/audit-log";
import {
  DECLARED_AUDIT_KINDS,
  InvalidSinceFlagError,
  NotifyError,
  buildSecurityDigest,
  notifySecurityDigest,
  parseSinceFlag,
  renderSecurityDigestHtml,
  renderSecurityDigestText,
  sanitizeContentString,
} from "./security-digest";

const MS_PER_DAY = 86_400_000;
const NOW = Date.parse("2026-07-02T12:00:00Z");
/** Built via fromCharCode so this test source carries no literal ESC byte. */
const ESC = String.fromCharCode(0x1b);

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "crewhaus-security-digest-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function auditDir(): string {
  return join(root, ".crewhaus", "audit");
}

function sessionsDir(): string {
  return join(root, ".crewhaus", "sessions");
}

/** Seed a REAL hash-chained audit store; `atMs` controls each record's ts
 *  (and its day file), so window filtering is exercised on genuine layout. */
async function seedAudit(
  records: ReadonlyArray<{ kind: string; payload: unknown; atMs: number }>,
): Promise<void> {
  for (const r of records) {
    const log = await openAuditLog({
      rootDir: auditDir(),
      now: () => r.atMs,
      day: () => new Date(r.atMs).toISOString().slice(0, 10),
    });
    await log.append({ kind: r.kind as never, payload: r.payload });
  }
}

function justificationPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    toolName: "send_message",
    justification: "sending the requested summary",
    verdict: "deny",
    reason: "justification does not tie to the session goal",
    judgeModel: "rule-based",
    ...overrides,
  };
}

function window(days: number): { sinceMs: number; label: string } {
  return parseSinceFlag(`${days}d`, () => NOW);
}

describe("parseSinceFlag", () => {
  test("defaults to a 7d window", () => {
    const w = parseSinceFlag(undefined, () => NOW);
    expect(w.label).toBe("7d");
    expect(w.sinceMs).toBe(NOW - 7 * MS_PER_DAY);
  });

  test("accepts <N>d windows and ISO dates", () => {
    expect(parseSinceFlag("30d", () => NOW).sinceMs).toBe(NOW - 30 * MS_PER_DAY);
    expect(parseSinceFlag("2026-06-01", () => NOW).sinceMs).toBe(Date.parse("2026-06-01"));
    expect(parseSinceFlag("2026-06-01T06:30:00Z", () => NOW).label).toBe("2026-06-01T06:30:00Z");
  });

  test("rejects garbage, zero-day windows, and negative shapes", () => {
    expect(() => parseSinceFlag("last week", () => NOW)).toThrow(InvalidSinceFlagError);
    expect(() => parseSinceFlag("0d", () => NOW)).toThrow(InvalidSinceFlagError);
    expect(() => parseSinceFlag("-3d", () => NOW)).toThrow(InvalidSinceFlagError);
  });
});

describe("buildSecurityDigest — audit rollup", () => {
  test("empty (or missing) stores yield an empty but complete digest", () => {
    const d = buildSecurityDigest({ rootDir: root, window: window(7), now: () => NOW });
    expect(d.audit.recordsInWindow).toBe(0);
    expect(d.justification.denyRate).toBeNull();
    expect(d.egress.decisions).toBe(0);
    expect(d.sessions.scanned).toBe(0);
    // Every declared kind is absent — including the writerless ones.
    expect(d.audit.absentDeclaredKinds).toEqual([...DECLARED_AUDIT_KINDS]);
  });

  test("ranks denied tools with judge identity, confidence, and deny rate", async () => {
    await seedAudit([
      {
        kind: "permission_justification_evaluated",
        payload: justificationPayload({ toolName: "send_message", confidence: 0.9 }),
        atMs: NOW - MS_PER_DAY,
      },
      {
        kind: "permission_justification_evaluated",
        payload: justificationPayload({
          toolName: "send_message",
          judgeModel: "claude-haiku-4-5",
          confidence: 0.7,
        }),
        atMs: NOW - MS_PER_DAY,
      },
      {
        kind: "permission_justification_evaluated",
        payload: justificationPayload({ toolName: "delete_file" }),
        atMs: NOW - MS_PER_DAY,
      },
      {
        kind: "permission_justification_evaluated",
        payload: justificationPayload({ verdict: "allow" }),
        atMs: NOW - MS_PER_DAY,
      },
    ]);
    const d = buildSecurityDigest({ rootDir: root, window: window(7), now: () => NOW });
    expect(d.justification.evaluated).toBe(4);
    expect(d.justification.denied).toBe(3);
    expect(d.justification.allowed).toBe(1);
    expect(d.justification.denyRate).toBeCloseTo(0.75);
    const top = d.justification.topDeniedTools[0];
    expect(top?.toolName).toBe("send_message");
    expect(top?.denials).toBe(2);
    expect(top?.judges).toEqual(["claude-haiku-4-5", "rule-based"]);
    expect(top?.meanConfidence).toBeCloseTo(0.8);
    expect(top?.lastReason).toContain("session goal");
    // Judge table covers both identities.
    const ruleBased = d.justification.byJudge.find((j) => j.judgeModel === "rule-based");
    expect(ruleBased?.evaluated).toBe(3);
    expect(ruleBased?.denied).toBe(2);
  });

  test("aggregates egress_decision records by sink and origin (future writer)", async () => {
    // NOTE: no production writer appends egress_decision today (the kind is
    // declared in @crewhaus/audit-log with a documented payload shape) —
    // this seeds the documented shape so the rollup is proven ready.
    await seedAudit([
      {
        kind: "egress_decision",
        payload: { sinkId: "mcp__slack__send", verdict: "warn", originsFound: ["mcp"] },
        atMs: NOW - MS_PER_DAY,
      },
      {
        kind: "egress_decision",
        payload: { sinkId: "mcp__slack__send", verdict: "block", originsFound: ["mcp", "skill"] },
        atMs: NOW - MS_PER_DAY,
      },
      {
        kind: "egress_decision",
        payload: { sinkId: "web_fetch", verdict: "pass", originsFound: [] },
        atMs: NOW - MS_PER_DAY,
      },
    ]);
    const d = buildSecurityDigest({ rootDir: root, window: window(7), now: () => NOW });
    expect(d.egress.decisions).toBe(3);
    expect(d.egress.warned).toBe(1);
    expect(d.egress.blocked).toBe(1);
    expect(d.egress.passed).toBe(1);
    expect(d.egress.topSinks[0]).toEqual({
      sinkId: "mcp__slack__send",
      warned: 1,
      blocked: 1,
      origins: ["mcp", "skill"],
    });
    expect(d.egress.topOrigins[0]).toEqual({ name: "mcp", count: 2 });
  });

  test("rolls up policy_decision denials per tool", async () => {
    await seedAudit([
      {
        kind: "policy_decision",
        payload: { toolName: "bash", decision: "deny", reason: "destructive" },
        atMs: NOW - MS_PER_DAY,
      },
      {
        kind: "policy_decision",
        payload: { toolName: "bash", decision: "deny", reason: "destructive" },
        atMs: NOW - MS_PER_DAY,
      },
      {
        kind: "policy_decision",
        payload: { toolName: "web_fetch", decision: "audit-and-allow" },
        atMs: NOW - MS_PER_DAY,
      },
    ]);
    const d = buildSecurityDigest({ rootDir: root, window: window(7), now: () => NOW });
    expect(d.policy.decisions).toBe(3);
    expect(d.policy.denied).toBe(2);
    expect(d.policy.auditAndAllow).toBe(1);
    expect(d.policy.topDeniedTools[0]).toEqual({ name: "bash", count: 2 });
  });

  test("--since windows out older records (day files AND per-record ts)", async () => {
    await seedAudit([
      {
        kind: "permission_justification_evaluated",
        payload: justificationPayload(),
        atMs: NOW - 20 * MS_PER_DAY, // outside 7d
      },
      {
        kind: "permission_justification_evaluated",
        payload: justificationPayload(),
        atMs: NOW - MS_PER_DAY, // inside
      },
    ]);
    const seven = buildSecurityDigest({ rootDir: root, window: window(7), now: () => NOW });
    expect(seven.justification.evaluated).toBe(1);
    expect(seven.audit.recordsInWindow).toBe(1);
    const thirty = buildSecurityDigest({ rootDir: root, window: window(30), now: () => NOW });
    expect(thirty.justification.evaluated).toBe(2);
  });

  test("counts every kind in window and names absent declared kinds", async () => {
    await seedAudit([
      { kind: "model_call", payload: { model: "claude-sonnet-4-6" }, atMs: NOW - MS_PER_DAY },
      { kind: "secrets_access", payload: { name: "API_KEY" }, atMs: NOW - MS_PER_DAY },
    ]);
    const d = buildSecurityDigest({ rootDir: root, window: window(7), now: () => NOW });
    expect(d.audit.countsByKind).toEqual({ model_call: 1, secrets_access: 1 });
    expect(d.audit.absentDeclaredKinds).toContain("egress_decision");
    expect(d.audit.absentDeclaredKinds).toContain("tool_classification");
    expect(d.audit.absentDeclaredKinds).not.toContain("model_call");
  });

  test("F5: a governance_approval record surfaces in the digest and is a declared kind", async () => {
    await seedAudit([
      {
        kind: "governance_approval",
        payload: {
          name: "concierge",
          toEnv: "prod",
          toVersion: "v3",
          required: 2,
          satisfied: false,
          countedApprovers: ["alice"],
          prWitness: false,
        },
        atMs: NOW - MS_PER_DAY,
      },
    ]);
    const d = buildSecurityDigest({ rootDir: root, window: window(7), now: () => NOW });
    // Counted in the window …
    expect(d.audit.countsByKind).toEqual({ governance_approval: 1 });
    // … and NOT reported as an "absent declared kind" that was seen (it was
    // added to DECLARED_AUDIT_KINDS in F5).
    expect(DECLARED_AUDIT_KINDS).toContain("governance_approval");
    expect(DECLARED_AUDIT_KINDS).toContain("governance_proposal");
    expect(d.audit.absentDeclaredKinds).not.toContain("governance_approval");
    // A run with no governance records lists both as absent-but-declared.
    expect(d.audit.absentDeclaredKinds).toContain("governance_proposal");
  });

  // F7 — the item-31 alert watchdog's `alert_raised` AuditKind must be
  // counted like any other declared kind, and must NOT show up as
  // "absent" once a record for it lands in the window.
  test("F7: an alert_raised audit record is counted and not reported absent", async () => {
    await seedAudit([
      {
        kind: "alert_raised",
        payload: {
          sessionId: "sess_x",
          metric: "turn_p95_seconds",
          observed: 30,
          threshold: 5,
          baselineSessions: 6,
          detail: "turn_p95_seconds 30s exceeded baseline threshold 5s",
        },
        atMs: NOW - MS_PER_DAY,
      },
    ]);
    const d = buildSecurityDigest({ rootDir: root, window: window(7), now: () => NOW });
    expect(d.audit.countsByKind).toEqual({ alert_raised: 1 });
    expect(d.audit.absentDeclaredKinds).not.toContain("alert_raised");
    expect(DECLARED_AUDIT_KINDS).toContain("alert_raised");
  });

  // F6 — the ops-item-37 SLO monitor's `slo_mitigation` AuditKind must be a
  // declared kind so a mitigation record (pause-intake / rollback) surfaces in
  // the digest and is never reported "absent" once one lands in the window.
  test("F6: an slo_mitigation audit record is counted and not reported absent", async () => {
    await seedAudit([
      {
        kind: "slo_mitigation",
        payload: {
          sessionId: "sess_x",
          rung: "rollback",
          breach: {
            metric: "ttft_ms",
            observed: 2000,
            target: 1400,
            detail: "ttft_ms 2000ms exceeded SLO target 1400ms",
          },
          windowMs: 300_000,
        },
        atMs: NOW - MS_PER_DAY,
      },
    ]);
    const d = buildSecurityDigest({ rootDir: root, window: window(7), now: () => NOW });
    expect(d.audit.countsByKind).toEqual({ slo_mitigation: 1 });
    expect(d.audit.absentDeclaredKinds).not.toContain("slo_mitigation");
    expect(DECLARED_AUDIT_KINDS).toContain("slo_mitigation");
  });

  test("F1 defense in depth: control chars in audit payload strings are stripped and clamped", async () => {
    await seedAudit([
      {
        kind: "permission_justification_evaluated",
        payload: justificationPayload({
          toolName: `evil${ESC}[31m\ntool`,
          judgeModel: `judge${String.fromCharCode(0x07)}-x`,
          reason: `line1\nline2 ${"r".repeat(300)}`,
        }),
        atMs: NOW - MS_PER_DAY,
      },
    ]);
    const d = buildSecurityDigest({ rootDir: root, window: window(7), now: () => NOW });
    const top = d.justification.topDeniedTools[0];
    expect(top?.toolName).toBe("evil[31mtool"); // ESC + newline stripped
    expect(d.justification.byJudge[0]?.judgeModel).toBe("judge-x"); // BEL stripped
    expect(top?.lastReason?.includes("\n")).toBe(false);
    expect((top?.lastReason ?? "").length).toBeLessThanOrEqual(257); // 256 + ellipsis
  });

  test("malformed JSONL lines are counted, not fatal", async () => {
    await seedAudit([
      {
        kind: "permission_justification_evaluated",
        payload: justificationPayload(),
        atMs: NOW - MS_PER_DAY,
      },
    ]);
    const day = new Date(NOW - MS_PER_DAY).toISOString().slice(0, 10);
    const file = join(auditDir(), `${day}.jsonl`);
    writeFileSync(file, `${"{not json"}\n`, { flag: "a" });
    const d = buildSecurityDigest({ rootDir: root, window: window(7), now: () => NOW });
    expect(d.audit.malformedLines).toBe(1);
    expect(d.justification.evaluated).toBe(1);
  });
});

describe("buildSecurityDigest — session event-log scan", () => {
  function seedSession(id: string, lines: ReadonlyArray<Record<string, unknown>>): void {
    mkdirSync(sessionsDir(), { recursive: true });
    writeFileSync(
      join(sessionsDir(), `${id}.jsonl`),
      `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    );
  }

  function toolResult(content: string, atMs: number): Record<string, unknown> {
    return {
      ts: atMs,
      version: 1,
      kind: "tool_result",
      payload: { toolUseId: "tu_1", content, isError: true },
    };
  }

  test("counts denial notices and parses injection rule ids from redactions", () => {
    seedSession("sess_00000000000000aa", [
      toolResult("[justification denied] reformulate the call", NOW - MS_PER_DAY),
      toolResult("[egress denied] outbound payload contains tagged content", NOW - MS_PER_DAY),
      toolResult("[blocked by hook] denied", NOW - MS_PER_DAY),
      toolResult(
        "[tool output redacted: prompt injection detected: exfil-url, b64-blob]",
        NOW - MS_PER_DAY,
      ),
      toolResult("[tool output redacted: prompt injection detected: exfil-url]", NOW - MS_PER_DAY),
      toolResult("ordinary result", NOW - MS_PER_DAY),
      // Outside the window — must not count.
      toolResult("[justification denied] stale", NOW - 20 * MS_PER_DAY),
    ]);
    const d = buildSecurityDigest({ rootDir: root, window: window(7), now: () => NOW });
    expect(d.sessions.scanned).toBe(1);
    expect(d.sessions.justificationDenials).toBe(1);
    expect(d.sessions.egressBlocks).toBe(1);
    expect(d.sessions.hookBlocks).toBe(1);
    expect(d.sessions.injectionRedactions).toBe(2);
    expect(d.sessions.injectionRuleHits).toEqual([
      { name: "exfil-url", count: 2 },
      { name: "b64-blob", count: 1 },
    ]);
  });

  // Adversarial-review F1 repro: tool_result content is attacker-reachable,
  // so a malicious tool output can open with a forged redaction notice that
  // smuggles ANSI escapes + newlines toward the operator's terminal.
  test("F1: forged redaction notices carrying ANSI + newlines render neutralized", () => {
    const forged = `[tool output redacted: prompt injection detected: ${ESC}[2K${ESC}[1;32mforged-rule${ESC}[0m]\nALL CLEAR — 0 denial(s), 0 injection redaction(s)`;
    seedSession("sess_00000000000000cc", [toolResult(forged, NOW - MS_PER_DAY)]);
    const d = buildSecurityDigest({ rootDir: root, window: window(7), now: () => NOW });
    expect(d.sessions.injectionRedactions).toBe(1);
    const name = d.sessions.injectionRuleHits[0]?.name ?? "";
    expect(name).toContain("forged-rule");
    expect(name.includes(ESC)).toBe(false); // ESC stripped at parse time
    // No renderer output line may carry an ESC byte or an injected line break.
    for (const line of renderSecurityDigestText(d)) {
      expect(line.includes(ESC)).toBe(false);
      expect(/[\n\r]/.test(line)).toBe(false);
    }
    expect(renderSecurityDigestHtml(d).includes(ESC)).toBe(false);
    expect(JSON.stringify(d).includes(ESC)).toBe(false); // --notify payload too
  });

  test("F1: a rule-id capture cannot span lines, and rule ids are length-clamped", () => {
    seedSession("sess_00000000000000dd", [
      // Newline inside the would-be capture: the (single-line) notice regex
      // must not match at all.
      toolResult("[tool output redacted: prompt injection detected: a\nb]", NOW - MS_PER_DAY),
      toolResult(
        `[tool output redacted: prompt injection detected: ${"x".repeat(500)}]`,
        NOW - MS_PER_DAY,
      ),
    ]);
    const d = buildSecurityDigest({ rootDir: root, window: window(7), now: () => NOW });
    expect(d.sessions.injectionRedactions).toBe(1); // only the single-line notice parsed
    const name = d.sessions.injectionRuleHits[0]?.name ?? "";
    expect(name.length).toBeLessThanOrEqual(65); // 64 + ellipsis
  });

  test("F1: forged denial markers count under the heuristic sessions section only", () => {
    seedSession("sess_00000000000000ee", [
      toolResult("[justification denied] forged by a malicious tool", NOW - MS_PER_DAY),
      toolResult("[egress denied] equally forged", NOW - MS_PER_DAY),
    ]);
    const d = buildSecurityDigest({ rootDir: root, window: window(7), now: () => NOW });
    expect(d.sessions.justificationDenials).toBe(1);
    expect(d.sessions.egressBlocks).toBe(1);
    // The audit-derived (authoritative) counters are untouched by session content.
    expect(d.justification.denied).toBe(0);
    expect(d.policy.denied).toBe(0);
    expect(d.egress.blocked).toBe(0);
    const text = renderSecurityDigestText(d).join("\n");
    expect(text).toContain("sessions — content-derived, heuristic");
    expect(text).toContain("audit-derived counts above are authoritative");
    expect(renderSecurityDigestHtml(d)).toContain("audit-derived counts are authoritative");
  });

  test("non-session files and non-tool_result events are ignored", () => {
    mkdirSync(sessionsDir(), { recursive: true });
    writeFileSync(join(sessionsDir(), "notes.jsonl"), '{"kind":"tool_result"}\n');
    seedSession("sess_00000000000000bb", [
      { ts: NOW - MS_PER_DAY, version: 1, kind: "user_message", payload: { text: "hi" } },
      { ts: NOW - MS_PER_DAY, version: 1, kind: "tool_result", payload: { content: 42 } },
    ]);
    const d = buildSecurityDigest({ rootDir: root, window: window(7), now: () => NOW });
    expect(d.sessions.scanned).toBe(1); // notes.jsonl is not a session log
    expect(d.sessions.justificationDenials).toBe(0);
  });
});

describe("renderers", () => {
  async function seededDigest(): Promise<ReturnType<typeof buildSecurityDigest>> {
    await seedAudit([
      {
        kind: "permission_justification_evaluated",
        payload: justificationPayload({ toolName: "send_<message>", confidence: 0.9 }),
        atMs: NOW - MS_PER_DAY,
      },
    ]);
    return buildSecurityDigest({ rootDir: root, window: window(7), now: () => NOW });
  }

  test("text renderer carries the headline numbers and the absent-kind note", async () => {
    const d = await seededDigest();
    const text = renderSecurityDigestText(d).join("\n");
    expect(text).toContain("window: 7d");
    expect(text).toContain("justification gate: 1 evaluated, 1 denied (deny rate 100.0%)");
    expect(text).toContain("send_<message> — 1 denial(s) [judge=rule-based");
    expect(text).toContain("no durable egress_decision records");
    expect(text).toContain("declared kinds with no records:");
  });

  test("html renderer escapes content and is self-contained", async () => {
    const d = await seededDigest();
    const html = renderSecurityDigestHtml(d);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Security digest");
    expect(html).toContain("send_&lt;message&gt;"); // escaped tool name
    expect(html).not.toContain("send_<message>");
    expect(html).not.toContain("<script src"); // no external assets
    expect(html).toContain("Judge deny rate");
  });

  test("the digest itself is JSON-serializable and versioned", async () => {
    const d = await seededDigest();
    const parsed = JSON.parse(JSON.stringify(d)) as typeof d;
    expect(parsed.version).toBe(1);
    expect(parsed.justification.denied).toBe(1);
  });
});

describe("sanitizeContentString", () => {
  test("strips C0 + C1 controls (incl. ESC and line breaks) and clamps length", () => {
    const CSI = String.fromCharCode(0x9b); // C1 single-byte CSI
    expect(sanitizeContentString(`a${ESC}[31mb\r\nc${CSI}d`)).toBe("a[31mbcd");
    expect(sanitizeContentString("plain-rule-id")).toBe("plain-rule-id");
    expect(sanitizeContentString("x".repeat(300))).toHaveLength(257); // 256 + ellipsis
    expect(sanitizeContentString("x".repeat(300), 64)).toHaveLength(65);
  });
});

describe("notifySecurityDigest", () => {
  function digest(): ReturnType<typeof buildSecurityDigest> {
    return buildSecurityDigest({ rootDir: root, window: window(7), now: () => NOW });
  }

  test("POSTs the JSON digest with the json content type", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    await notifySecurityDigest("https://hooks.example.com/digest", digest(), fetchImpl);
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe("https://hooks.example.com/digest");
    expect(calls[0]?.init?.method).toBe("POST");
    expect((calls[0]?.init?.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
    const body = JSON.parse(String(calls[0]?.init?.body)) as { version: number };
    expect(body.version).toBe(1);
  });

  test("a non-2xx response fails loudly", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await expect(
      notifySecurityDigest("https://hooks.example.com/digest", digest(), fetchImpl),
    ).rejects.toThrow(NotifyError);
  });

  test("F3: warns on stderr for a plain-http notify URL (and stays silent for https)", async () => {
    const fetchImpl = (async () => new Response("ok", { status: 200 })) as typeof fetch;
    const httpWarnings: string[] = [];
    await notifySecurityDigest("http://internal.example.com/hook", digest(), fetchImpl, (l) =>
      httpWarnings.push(l),
    );
    expect(httpWarnings).toHaveLength(1);
    expect(httpWarnings[0]).toContain("plain http");
    expect(httpWarnings[0]).toContain("unencrypted");

    const httpsWarnings: string[] = [];
    await notifySecurityDigest("https://hooks.example.com/digest", digest(), fetchImpl, (l) =>
      httpsWarnings.push(l),
    );
    expect(httpsWarnings).toHaveLength(0);
  });

  test("network failures and bad URLs fail loudly", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    await expect(
      notifySecurityDigest("https://hooks.example.com/digest", digest(), fetchImpl),
    ).rejects.toThrow("ECONNREFUSED");
    await expect(notifySecurityDigest("not a url", digest())).rejects.toThrow(NotifyError);
    await expect(notifySecurityDigest("ftp://x/y", digest())).rejects.toThrow(
      "only supports http(s)",
    );
  });
});
