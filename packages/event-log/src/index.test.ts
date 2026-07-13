import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TenancyError, buildTenant, withTenant } from "@crewhaus/tenancy";
import { type Event, openEventLog } from "./index";

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-event-log-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const TEST_ID = "sess_0123456789abcdef";

async function collect(events: AsyncIterable<Event>): Promise<Event[]> {
  const out: Event[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

describe("event-log — round-trip", () => {
  test("append + read returns events in insertion order with version 1", async () => {
    const rootDir = newTempRoot();
    let clock = 1_700_000_000_000;
    const log = await openEventLog(TEST_ID, { rootDir, now: () => clock++ });
    await log.append({ kind: "user_message", payload: { content: "hello" } });
    await log.append({
      kind: "assistant_message",
      payload: { content: [{ type: "text", text: "hi" }] },
    });
    await log.append({
      kind: "tool_use",
      payload: { id: "tu_1", name: "Read", input: { path: "x" } },
    });
    await log.append({
      kind: "tool_result",
      payload: { toolUseId: "tu_1", content: "ok", isError: false },
    });
    await log.append({ kind: "error", payload: { name: "E", message: "boom" } });
    await log.append({ kind: "compaction", payload: { kind: "snip", before: 100, after: 30 } });
    await log.close();

    const all = await collect(log.read());
    expect(all.length).toBe(6);
    expect(all.map((e) => e.kind)).toEqual([
      "user_message",
      "assistant_message",
      "tool_use",
      "tool_result",
      "error",
      "compaction",
    ]);
    for (const ev of all) {
      expect(ev.version).toBe(1);
      expect(typeof ev.ts).toBe("number");
    }
    // ts values should be strictly increasing because of clock++
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1];
      const curr = all[i];
      if (prev === undefined || curr === undefined) throw new Error("unreachable");
      expect(curr.ts).toBeGreaterThan(prev.ts);
    }
    expect(all[0]?.payload).toEqual({ content: "hello" });
  });

  test("advisor kinds (recovery, tool_stats, permission, model_meta) round-trip", async () => {
    const rootDir = newTempRoot();
    const log = await openEventLog(TEST_ID, { rootDir });
    await log.append({
      kind: "recovery",
      payload: { errorName: "MaxTokensError", action: "continue", depth: 1 },
    });
    await log.append({
      kind: "tool_stats",
      payload: { toolName: "Fetch", durationMs: 42, isError: true },
    });
    await log.append({
      kind: "permission",
      payload: { toolName: "Bash", decision: "ask", askOutcome: "approved" },
    });
    await log.append({ kind: "model_meta", payload: { stopReason: "end_turn", model: "m" } });
    await log.close();

    const all = await collect(log.read());
    expect(all.map((e) => e.kind)).toEqual(["recovery", "tool_stats", "permission", "model_meta"]);
    expect(all[1]?.payload).toEqual({ toolName: "Fetch", durationMs: 42, isError: true });
    expect(all[2]?.payload).toEqual({ toolName: "Bash", decision: "ask", askOutcome: "approved" });
  });

  test("run_failed (v0.3.0 Goal 6 terminal failure record) round-trips its report payload", async () => {
    const rootDir = newTempRoot();
    const log = await openEventLog(TEST_ID, { rootDir });
    await log.append({
      kind: "run_failed",
      payload: {
        class: "billing",
        message:
          'provider account out of funding: Anthropic said: "Your credit balance is too low to access the Anthropic API."',
        remediation: "add credits at https://console.anthropic.com/settings/billing, then rerun.",
        exitCode: 31,
      },
    });
    await log.close();

    const all = await collect(log.read());
    expect(all.length).toBe(1);
    expect(all[0]?.kind).toBe("run_failed");
    expect(all[0]?.payload).toEqual({
      class: "billing",
      message:
        'provider account out of funding: Anthropic said: "Your credit balance is too low to access the Anthropic API."',
      remediation: "add credits at https://console.anthropic.com/settings/billing, then rerun.",
      exitCode: 31,
    });
  });

  test("read filters by since and until", async () => {
    const rootDir = newTempRoot();
    let clock = 100;
    const log = await openEventLog(TEST_ID, { rootDir, now: () => clock });
    for (let i = 0; i < 5; i++) {
      clock = 100 + i * 10;
      await log.append({ kind: "user_message", payload: { i } });
    }
    await log.close();

    const all = await collect(log.read());
    expect(all.length).toBe(5);
    expect(all.map((e) => e.ts)).toEqual([100, 110, 120, 130, 140]);

    const sinceOnly = await collect(log.read({ since: 120 }));
    expect(sinceOnly.map((e) => e.ts)).toEqual([120, 130, 140]);

    const untilOnly = await collect(log.read({ until: 120 }));
    expect(untilOnly.map((e) => e.ts)).toEqual([100, 110, 120]);

    const both = await collect(log.read({ since: 110, until: 130 }));
    expect(both.map((e) => e.ts)).toEqual([110, 120, 130]);
  });

  test("read of a never-written log yields zero events", async () => {
    const rootDir = newTempRoot();
    const log = await openEventLog(TEST_ID, { rootDir });
    const all = await collect(log.read());
    expect(all).toEqual([]);
  });

  test("malformed line throws RuntimeError carrying the line number", async () => {
    const rootDir = newTempRoot();
    const log = await openEventLog(TEST_ID, { rootDir });
    await log.append({ kind: "user_message", payload: { i: 1 } });
    // Manually corrupt the file with a bogus trailing line.
    writeFileSync(
      join(rootDir, `${TEST_ID}.jsonl`),
      `{"ts":1,"version":1,"kind":"user_message","payload":{"i":1}}\nNOT JSON\n`,
    );
    await expect(collect(log.read())).rejects.toThrow(/malformed JSON on line 2/);
  });

  test("ignores blank lines without bumping the line counter visibly", async () => {
    const rootDir = newTempRoot();
    const log = await openEventLog(TEST_ID, { rootDir });
    await log.append({ kind: "user_message", payload: {} });
    // Append a blank line + a real event manually.
    writeFileSync(
      join(rootDir, `${TEST_ID}.jsonl`),
      `{"ts":1,"version":1,"kind":"user_message","payload":{}}\n\n{"ts":2,"version":1,"kind":"user_message","payload":{}}\n`,
    );
    const all = await collect(log.read());
    expect(all.length).toBe(2);
  });

  test("rejects an invalid session id", async () => {
    const rootDir = newTempRoot();
    await expect(openEventLog("../escape", { rootDir })).rejects.toThrow(/invalid sessionId/);
    await expect(openEventLog("sess_short", { rootDir })).rejects.toThrow(/invalid sessionId/);
  });

  test("creates the root directory if it does not exist", async () => {
    const rootDir = join(newTempRoot(), "deep", "nested", "dir");
    const log = await openEventLog(TEST_ID, { rootDir });
    await log.append({ kind: "user_message", payload: { ok: true } });
    const all = await collect(log.read());
    expect(all.length).toBe(1);
  });
});

describe("event-log — T7 load", () => {
  test("10 000 appends round-trip cleanly", async () => {
    const rootDir = newTempRoot();
    const log = await openEventLog(TEST_ID, { rootDir });

    const COUNT = 10_000;
    const start = performance.now();
    for (let i = 0; i < COUNT; i++) {
      await log.append({ kind: "user_message", payload: { i, padding: "x".repeat(20) } });
    }
    const appendMs = performance.now() - start;
    expect(appendMs).toBeLessThan(15_000);

    const fullPath = join(rootDir, `${TEST_ID}.jsonl`);
    expect(statSync(fullPath).size).toBeGreaterThan(COUNT * 60);

    const readStart = performance.now();
    const all = await collect(log.read());
    const readMs = performance.now() - readStart;
    expect(all.length).toBe(COUNT);
    for (let i = 0; i < COUNT; i++) {
      const ev = all[i];
      if (ev === undefined) throw new Error("unreachable");
      expect((ev.payload as { i: number }).i).toBe(i);
    }
    // Read should be substantially faster than the append loop.
    expect(readMs).toBeLessThan(5_000);
  }, 30_000);
});

describe("event-log — cross-tenant fencing (CWE-1230)", () => {
  test("inside tenantA, a log rooted under tenantB fails closed", async () => {
    const tenantsRoot = newTempRoot();
    const tenantA = buildTenant("tenant-a", { tenantsRoot });
    const tenantB = buildTenant("tenant-b", { tenantsRoot });
    // Opening a log rooted under tenantB while tenantA is active resolves a
    // path outside tenantA's sessionRoot, so it fails closed.
    await expect(
      withTenant(tenantA, () => openEventLog(TEST_ID, { rootDir: tenantB.sessionRoot })),
    ).rejects.toThrow(TenancyError);
  });

  test("inside tenantA, a log rooted under tenantA round-trips", async () => {
    const tenantsRoot = newTempRoot();
    const tenantA = buildTenant("tenant-a", { tenantsRoot });
    await withTenant(tenantA, async () => {
      const log = await openEventLog(TEST_ID, { rootDir: tenantA.sessionRoot });
      await log.append({ kind: "user_message", payload: { ok: true } });
      const all = await collect(log.read());
      expect(all.length).toBe(1);
    });
  });

  test("no active tenant — behaviour is unchanged (no fencing)", async () => {
    const rootDir = newTempRoot();
    const log = await openEventLog(TEST_ID, { rootDir });
    await log.append({ kind: "user_message", payload: { ok: true } });
    const all = await collect(log.read());
    expect(all.length).toBe(1);
  });
});

describe("event-log — security invariants", () => {
  // The header documents owner-only (0o600) append semantics, mirroring the
  // claude-code sessionStorage precedent. Pin it down so a regression that
  // drops `{ mode: 0o600 }` (widening the transcript to group/other) fails.
  test("the JSONL file is created without group/other access", async () => {
    const rootDir = newTempRoot();
    const log = await openEventLog(TEST_ID, { rootDir });
    await log.append({ kind: "user_message", payload: { secret: "transcript" } });
    const mode = statSync(join(rootDir, `${TEST_ID}.jsonl`)).mode & 0o777;
    // No bits set for group (0o070) or other (0o007).
    expect(mode & 0o077).toBe(0);
  });

  // A hostile/corrupt log line carrying a `__proto__` key must round-trip as
  // plain data and must NOT pollute Object.prototype (CWE-1321). readEvents
  // only `JSON.parse`s + yields; it never merges into an existing object, so
  // there is no pollution sink — this guards against a future refactor adding
  // one.
  test("a __proto__ payload does not pollute Object.prototype", async () => {
    const rootDir = newTempRoot();
    const log = await openEventLog(TEST_ID, { rootDir });
    await log.append({ kind: "user_message", payload: {} });
    writeFileSync(
      join(rootDir, `${TEST_ID}.jsonl`),
      `${JSON.stringify({
        ts: 1,
        version: 1,
        kind: "user_message",
        payload: JSON.parse('{"__proto__":{"polluted":true}}'),
      })}\n`,
    );
    const all = await collect(log.read());
    expect(all.length).toBe(1);
    // The global prototype must remain unpolluted for everyone else.
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  // The sessionId becomes part of the on-disk path; only `sess_<16 hex>` is
  // accepted, so traversal / absolute-path / NUL injection in the id can never
  // reach the filesystem (CWE-22).
  test("rejects traversal, separators, and NUL in the session id", async () => {
    const rootDir = newTempRoot();
    for (const bad of [
      "sess_../../etc/passwd",
      "sess_0123456789abcde/", // 15 hex + slash
      "sess_0123456789abcdeg", // non-hex char
      "sess_0123456789ABCDEF", // uppercase hex not allowed
      "sess_0123456789abcdef0", // 17 hex (too long)
      "sess_ 000000000000",
      "../escape",
    ]) {
      await expect(openEventLog(bad, { rootDir })).rejects.toThrow(/invalid sessionId/);
    }
  });
});
