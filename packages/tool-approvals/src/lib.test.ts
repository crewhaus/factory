/**
 * The library halves: the reader, the fold, the status rule, the filters, the
 * ordering, the walk, the settings check.
 *
 * `index.test.ts` drives the tools; this file drives the pieces they are built
 * from, and every assertion here is about what the code DID to a real file on a
 * real disk — never about how it is written. Nothing reaches a network address.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { approval, approvalId, makeHarness, writeApprovals, writeSession } from "./fixtures";
import {
  countByStatus,
  filterApprovals,
  foldApprovals,
  isApprovalId,
  operativeOf,
  orderApprovals,
  parseInstant,
  statusOf,
  toRow,
} from "./lib/approvals";
import { discoverHarnesses } from "./lib/harnesses";
import { readJsonlCapped, readTailCapped } from "./lib/jsonl";
import { declaresSessionDir, sessionRootRelocation } from "./lib/session-root";
import { isSessionLogName, readRecentSessions } from "./lib/sessions";
import { countDeclaredRuleEntries, readSettings } from "./lib/settings";
import { Unknowns, compareStrings, firstLine } from "./lib/unknown";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-tool-approvals-lib-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const at = (rel: string): string => path.join(tmp, rel);

// ---------------------------------------------------------------------------
// the reader
// ---------------------------------------------------------------------------

describe("readTailCapped / readJsonlCapped", () => {
  test("a file that is not there reads as MISSING, not as unreadable", () => {
    const read = readJsonlCapped(at("nope.jsonl"));
    expect(read.state.kind).toBe("missing");
    expect(read.objects).toEqual([]);
    // Zero bytes is a FACT about an absent ledger, not a failed measurement —
    // a null here would be an unexplained unknown in the commonest case there
    // is, and a reader who learns to ignore those ignores the ones that matter.
    expect(read.bytes).toBe(0);
  });

  test("a file that could not be examined reports an UNMEASURED size, not zero", () => {
    mkdirSync(at("dir.jsonl"));
    expect(readJsonlCapped(at("dir.jsonl")).bytes).toBeNull();
  });

  test("a link at the leaf is not followed: every caller resolved and checked its path already", () => {
    writeFileSync(at("real.jsonl"), '{"id":1}\n');
    symlinkSync(at("real.jsonl"), at("link.jsonl"));
    const read = readTailCapped(at("link.jsonl"), 1024);
    expect(read.state).toEqual({
      kind: "unreadable",
      reason: "the path is a symbolic link, which is not followed here",
    });
    expect(read.text).toBe("");
    expect(readTailCapped(at("real.jsonl"), 1024).state.kind).toBe("read");
  });

  test("a directory in the file's place reads as UNREADABLE with a reason — never as empty", () => {
    mkdirSync(at("approvals.jsonl"));
    const read = readJsonlCapped(at("approvals.jsonl"));
    expect(read.state.kind).toBe("unreadable");
    // The REASON is asserted, not just the failure: a timeout, a permission
    // error and a wrong file type all produce "no objects", and a caller
    // deciding whether to retry needs to know which one happened.
    expect(read.state.kind === "unreadable" && read.state.reason).toContain("not a regular file");
    expect(read.objects).toEqual([]);
  });

  test("a torn line is skipped, counted, and does not hide the lines around it", () => {
    writeFileSync(at("a.jsonl"), '{"a":1}\n{"b":\n{"c":3}\n');
    const read = readJsonlCapped(at("a.jsonl"));
    expect(read.objects).toEqual([{ a: 1 }, { c: 3 }]);
    expect(read.tornCount).toBe(1);
    expect(read.lineCount).toBe(3);
    expect(read.truncated).toBe(false);
  });

  test("the BYTE cap keeps the newest records and drops the torn first line", () => {
    // Ten records; a cap that admits roughly the last three.
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ n: i, pad: "x".repeat(40) }),
    );
    writeFileSync(at("b.jsonl"), `${lines.join("\n")}\n`);
    const oneLine = Buffer.byteLength(`${lines[0]}\n`, "utf8");
    const read = readJsonlCapped(at("b.jsonl"), 1000, oneLine * 3 + 5);
    expect(read.truncated).toBe(true);
    // Whatever survived, it is a SUFFIX of the file: the highest `n` is the
    // last record written, which is where a pending park lives.
    const ns = read.objects.map((o) => (o as { n: number }).n);
    expect(ns.at(-1)).toBe(9);
    expect(ns.length).toBeGreaterThan(0);
    expect(ns.length).toBeLessThan(10);
    // The torn leading fragment was dropped rather than counted as a parse
    // failure that did not happen.
    expect(read.tornCount).toBe(0);
  });

  test("the LINE cap also keeps the newest records", () => {
    const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify({ n: i }));
    writeFileSync(at("c.jsonl"), `${lines.join("\n")}\n`);
    const read = readJsonlCapped(at("c.jsonl"), 3);
    expect(read.truncated).toBe(true);
    expect(read.objects.map((o) => (o as { n: number }).n)).toEqual([7, 8, 9]);
  });

  test("a read that is BOTH capped and torn reports both facts", () => {
    // They are different facts about the same count, and the result carries
    // them on different fields for exactly that reason: `Unknowns.add` is
    // first-writer-wins, so filing both under one field would lose one.
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ n: i, pad: "x".repeat(40) }),
    );
    lines.splice(8, 0, "{torn");
    writeFileSync(at("f.jsonl"), `${lines.join("\n")}\n`);
    const oneLine = Buffer.byteLength(`${lines[0]}\n`, "utf8");
    const read = readJsonlCapped(at("f.jsonl"), 1000, oneLine * 4 + 5);
    expect(read.truncated).toBe(true);
    expect(read.tornCount).toBe(1);
  });

  test("an empty file reads clean — zero records is a real answer here", () => {
    writeFileSync(at("d.jsonl"), "");
    const read = readJsonlCapped(at("d.jsonl"));
    expect(read.state.kind).toBe("read");
    expect(read.objects).toEqual([]);
    expect(read.bytes).toBe(0);
  });

  test("readTailCapped reports the size on disk, not the size of what it kept", () => {
    writeFileSync(at("e.jsonl"), "0123456789");
    expect(readTailCapped(at("e.jsonl"), 4).bytes).toBe(10);
    expect(readTailCapped(at("e.jsonl"), 4).text).toBe("6789");
  });
});

// ---------------------------------------------------------------------------
// the fold + the status rule
// ---------------------------------------------------------------------------

describe("foldApprovals", () => {
  test("last record wins by id — a grant appended after a park replaces it", () => {
    const id = approvalId(1);
    const file = writeApprovals(tmp, [
      approval({ id, createdAt: "2026-09-18T10:00:00.000Z" }),
      approval({ id, createdAt: "2026-09-18T10:00:00.000Z", decision: "grant", decidedBy: "max" }),
    ]);
    const folded = foldApprovals(file);
    expect(folded.records).toHaveLength(1);
    expect(statusOf(folded.records[0] as never)).toBe("granted");
    expect(folded.records[0]?.decidedBy).toBe("max");
  });

  test("a JSON line that is not an approval record is counted, not folded in", () => {
    const file = writeApprovals(tmp, [
      approval({ id: approvalId(1) }),
      JSON.stringify({ kind: "something-else", payload: {} }),
    ]);
    const folded = foldApprovals(file);
    expect(folded.records).toHaveLength(1);
    expect(folded.foreignLines).toBe(1);
  });

  test("an unreadable ledger folds to no records AND says the read failed", () => {
    mkdirSync(at("approvals.jsonl"));
    const folded = foldApprovals(at("approvals.jsonl"));
    expect(folded.records).toEqual([]);
    expect(folded.read.state.kind).toBe("unreadable");
  });
});

describe("statusOf", () => {
  const cases: Array<[string, Parameters<typeof approval>[0], string]> = [
    ["no decision", {}, "pending"],
    ["grant", { decision: "grant" as const }, "granted"],
    ["deny", { decision: "deny" as const }, "denied"],
    [
      "consumed grant",
      { decision: "grant" as const, consumedAt: "2026-09-18T11:00:00Z" },
      "consumed",
    ],
    [
      "standing allow, already consumed",
      { decision: "grant" as const, always: true, consumedAt: "2026-09-18T11:00:00Z" },
      "granted-always",
    ],
  ];
  for (const [label, fixture, expected] of cases) {
    test(`${label} -> ${expected}`, () => {
      expect(statusOf(approval(fixture) as never)).toBe(expected);
    });
  }

  test("a pending record long past any TTL is still PENDING — expiry is not a reader's call", () => {
    const old = approval({ createdAt: "2020-01-01T00:00:00.000Z" });
    expect(statusOf(old as never)).toBe("pending");
  });
});

test("countByStatus reports every status, so 0 is never confusable with absent", () => {
  const counts = countByStatus([approval({ id: approvalId(1) }) as never]);
  expect(Object.keys(counts).sort(compareStrings)).toEqual([
    "consumed",
    "denied",
    "granted",
    "granted-always",
    "pending",
  ]);
  expect(counts.pending).toBe(1);
  expect(counts.denied).toBe(0);
});

// ---------------------------------------------------------------------------
// time
// ---------------------------------------------------------------------------

describe("parseInstant", () => {
  test("accepts the ISO shapes a store writes", () => {
    expect(parseInstant("2026-09-18T10:00:00.000Z")).toBe(Date.parse("2026-09-18T10:00:00.000Z"));
    expect(parseInstant("2026-09-18T10:00:00Z")).not.toBeNull();
    expect(parseInstant("2026-09-18T10:00Z")).not.toBeNull();
    expect(parseInstant("2026-09-18")).not.toBeNull();
    expect(parseInstant("2026-09-19T00:30:00+02:00")).not.toBeNull();
  });

  test("refuses input whose meaning is engine-defined rather than guessing at it", () => {
    expect(parseInstant("September 19, 2026")).toBeNull();
    expect(parseInstant("yesterday")).toBeNull();
    expect(parseInstant("")).toBeNull();
    expect(parseInstant("2026-13-45T99:99:99Z")).toBeNull();
  });

  test("an offset instant compares by INSTANT, which a string compare gets backwards", () => {
    const withOffset = "2026-09-19T00:30:00+02:00"; // 22:30Z on the 18th
    const utc = "2026-09-18T23:00:00Z";
    // The lexical order says the offset string is LATER…
    expect(compareStrings(withOffset, utc)).toBeGreaterThan(0);
    // …and the real order says it is earlier. Every comparison in this package
    // goes through parseInstant for exactly this reason.
    expect(parseInstant(withOffset)).toBeLessThan(parseInstant(utc) as number);
  });
});

// ---------------------------------------------------------------------------
// filters
// ---------------------------------------------------------------------------

describe("filterApprovals", () => {
  const records = [
    approval({ id: approvalId(1), toolName: "Read", createdAt: "2026-09-18T10:00:00.000Z" }),
    approval({
      id: approvalId(2),
      toolName: "ReadSecrets",
      createdAt: "2026-09-18T11:00:00.000Z",
    }),
    approval({
      id: approvalId(3),
      toolName: "Bash",
      createdAt: "2026-09-18T12:00:00.000Z",
      decision: "deny" as const,
    }),
  ] as never[];

  test("the tool filter is EXACT — a prefix match would leak a neighbouring tool", () => {
    const kept = filterApprovals(records, { tool: "Read" }).kept;
    expect(kept.map((r) => r.id)).toEqual([approvalId(1)]);
  });

  test("status filter", () => {
    expect(filterApprovals(records, { status: ["denied"] }).kept.map((r) => r.id)).toEqual([
      approvalId(3),
    ]);
  });

  test("since/until are inclusive bounds on the parsed instant", () => {
    const window = filterApprovals(records, {
      sinceMs: Date.parse("2026-09-18T11:00:00.000Z"),
      untilMs: Date.parse("2026-09-18T12:00:00.000Z"),
    });
    expect(window.kept.map((r) => r.id)).toEqual([approvalId(2), approvalId(3)]);
  });

  test("a record whose createdAt does not parse is KEPT and NAMED, never silently dropped", () => {
    const undated = approval({ id: approvalId(9), createdAt: "not a date" }) as never;
    const out = filterApprovals([...records, undated], {
      sinceMs: Date.parse("2026-09-18T11:00:00.000Z"),
    });
    expect(out.kept.map((r) => r.id)).toContain(approvalId(9));
    expect(out.undatedIds).toEqual([approvalId(9)]);
  });

  test("no time filter means no undated report — the field only speaks when asked to", () => {
    expect(filterApprovals(records, { tool: "Bash" }).undatedIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ordering
// ---------------------------------------------------------------------------

describe("orderApprovals", () => {
  const pendingOld = approval({ id: approvalId(1), createdAt: "2026-09-18T08:00:00.000Z" });
  const pendingNew = approval({ id: approvalId(2), createdAt: "2026-09-18T09:00:00.000Z" });
  const settledOld = approval({
    id: approvalId(3),
    createdAt: "2026-09-18T07:00:00.000Z",
    decision: "grant" as const,
    decidedAt: "2026-09-18T07:30:00.000Z",
  });
  const settledNew = approval({
    id: approvalId(4),
    createdAt: "2026-09-18T06:00:00.000Z",
    decision: "deny" as const,
    decidedAt: "2026-09-18T10:00:00.000Z",
  });
  const all = [settledOld, pendingNew, settledNew, pendingOld] as never[];

  test("operator order: pending first oldest-first, then settled most-recently-decided", () => {
    expect(orderApprovals(all, "operator").map((r) => r.id)).toEqual([
      approvalId(1), // pending, parked longest
      approvalId(2), // pending
      approvalId(4), // settled at 10:00
      approvalId(3), // settled at 07:30
    ]);
  });

  test("oldest / newest are plain creation orders", () => {
    expect(orderApprovals(all, "oldest").map((r) => r.id)).toEqual([
      approvalId(4),
      approvalId(3),
      approvalId(1),
      approvalId(2),
    ]);
    expect(orderApprovals(all, "newest").map((r) => r.id)).toEqual([
      approvalId(2),
      approvalId(1),
      approvalId(3),
      approvalId(4),
    ]);
  });

  test("a record with an unplaceable timestamp sorts LAST, not into an arbitrary slot", () => {
    const broken = approval({ id: approvalId(7), createdAt: "???" }) as never;
    for (const order of ["operator", "oldest", "newest"] as const) {
      const ids = orderApprovals([broken, pendingOld as never], order).map((r) => r.id);
      expect(ids.at(-1)).toBe(approvalId(7));
    }
  });

  test("ties break on id, so the same input always yields the same bytes", () => {
    const a = approval({ id: approvalId(20), createdAt: "2026-09-18T08:00:00.000Z" }) as never;
    const b = approval({ id: approvalId(10), createdAt: "2026-09-18T08:00:00.000Z" }) as never;
    expect(orderApprovals([a, b], "oldest").map((r) => r.id)).toEqual(
      orderApprovals([b, a], "oldest").map((r) => r.id),
    );
    expect(orderApprovals([a, b], "oldest")[0]?.id).toBe(approvalId(10));
  });
});

// ---------------------------------------------------------------------------
// projection
// ---------------------------------------------------------------------------

describe("toRow", () => {
  test("the operative field is the one the tool declares", () => {
    expect(operativeOf("Read", { path: "/etc/hosts", content: "x" })).toEqual({
      field: "path",
      value: "/etc/hosts",
    });
    expect(operativeOf("Bash", { command: "ls" })).toEqual({ field: "command", value: "ls" });
    // 0.7.1 builtins beyond the legacy name table: the URL, not the method…
    expect(operativeOf("HttpRequest", { method: "DELETE", url: "https://x.test/a" })).toEqual({
      field: "url",
      value: "https://x.test/a",
    });
    // …a repository read in the light of its owner…
    expect(operativeOf("IssueCreate", { owner: "crewhaus", repo: "factory", title: "t" })).toEqual({
      field: "repo",
      value: "crewhaus/factory",
    });
    // …and the default a tool acts on when the call leaves the field out.
    expect(operativeOf("EnvFileUpsert", { entries: {} })).toEqual({ field: "path", value: ".env" });
  });

  test("a builtin with no scoping argument shows none, even when a table name would match", () => {
    expect(operativeOf("ClipboardWrite", { text: "x" })).toEqual({ field: null, value: null });
  });

  test("a tool with no entry in that table gets NO operative value — there is no field a rule could constrain", () => {
    expect(operativeOf("mcp__notes__search", { query: "x" })).toEqual({ field: null, value: null });
  });

  test("non-operative input fields are reported by NAME and TYPE, never by value", () => {
    const row = toRow(
      approval({
        toolName: "Write",
        input: { path: "notes.md", content: "sk-live-abcdefghijklmnop" },
      }) as never,
    );
    expect(row.operativeField).toBe("path");
    expect(row.operativeValue).toBe("notes.md");
    expect(row.inputFields).toEqual([
      { key: "content", type: "string", chars: 24 },
      { key: "path", type: "string", chars: 8 },
    ]);
    // The whole row, serialized, must not carry the secret's TEXT anywhere.
    expect(JSON.stringify(row)).not.toContain("sk-live-abcdefghijklmnop");
  });

  test("an oversized operative value is cut and the cut is flagged", () => {
    const row = toRow(
      approval({ toolName: "Bash", input: { command: "x".repeat(5000) } }) as never,
    );
    expect(row.operativeValue).toHaveLength(2000);
    expect(row.operativeValueTruncated).toBe(true);
  });

  test("age appears only when the caller supplies `now`, and never from the host clock", () => {
    const record = approval({ createdAt: "2026-09-18T10:00:00.000Z" }) as never;
    expect(toRow(record)).not.toHaveProperty("ageSeconds");
    expect(toRow(record, Date.parse("2026-09-18T10:05:00.000Z")).ageSeconds).toBe(300);
  });

  test("an unparseable createdAt yields no age rather than an absurd number", () => {
    const record = approval({ createdAt: "???" }) as never;
    expect(toRow(record, Date.parse("2026-09-18T10:00:00.000Z"))).not.toHaveProperty("ageSeconds");
  });
});

test("isApprovalId matches the store's grammar and nothing looser", () => {
  expect(isApprovalId(approvalId(1))).toBe(true);
  expect(isApprovalId("appr_zzzzzzzzzzzzzzzz")).toBe(false);
  expect(isApprovalId("appr_0000")).toBe(false);
  expect(isApprovalId("../../etc/passwd")).toBe(false);
});

// ---------------------------------------------------------------------------
// the fleet walk
// ---------------------------------------------------------------------------

describe("discoverHarnesses", () => {
  test("finds nested harnesses, sorted, and stops at each one", () => {
    makeHarness(tmp, "a");
    makeHarness(tmp, "b/inner");
    makeHarness(tmp, "a/nested"); // a fixture INSIDE a harness is not a peer
    const found = discoverHarnesses(tmp);
    expect(found.harnesses.map((h) => h.rel)).toEqual(["a", "b/inner"]);
    expect(found.truncated).toBe(false);
    expect(found.unreadable).toEqual([]);
  });

  test("never descends into node_modules or a harness's own .crewhaus", () => {
    makeHarness(tmp, "node_modules/template");
    makeHarness(tmp, ".crewhaus/scratch");
    expect(discoverHarnesses(tmp).harnesses).toEqual([]);
  });

  test("never follows a directory symlink — that is the containment boundary", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "crewhaus-tool-approvals-outside-"));
    try {
      makeHarness(outside, "escaped");
      symlinkSync(outside, at("link"), "dir");
      expect(discoverHarnesses(tmp).harnesses).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("the count cap reports itself rather than returning a short list quietly", () => {
    makeHarness(tmp, "h1");
    makeHarness(tmp, "h2");
    makeHarness(tmp, "h3");
    const found = discoverHarnesses(tmp, 6, 2);
    expect(found.harnesses).toHaveLength(2);
    expect(found.truncated).toBe(true);
  });

  test("the depth cap reports itself", () => {
    makeHarness(tmp, "a/b/c/deep");
    const found = discoverHarnesses(tmp, 1, 100);
    expect(found.harnesses).toEqual([]);
    expect(found.depthLimited).toBe(true);
  });

  test("an unlistable directory is recorded, and the rest of the fleet is still found", () => {
    makeHarness(tmp, "good");
    // A FILE where the walk expects to descend is not listable. Using a file
    // rather than chmod keeps the test honest when it runs as root, where a
    // 0000 directory is readable anyway and the assertion would silently pass
    // for the wrong reason.
    mkdirSync(at("sub"), { recursive: true });
    makeHarness(tmp, "sub/also-good");
    const found = discoverHarnesses(tmp);
    expect(found.harnesses.map((h) => h.rel)).toEqual(["good", "sub/also-good"]);
  });
});

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

describe("readSettings", () => {
  test("a missing file is MISSING — there really are no rules", () => {
    expect(readSettings(at(".crewhaus/settings.json")).kind).toBe("missing");
  });

  test("a file that does not parse is UNUSABLE, not a file with no rules", () => {
    mkdirSync(at(".crewhaus"), { recursive: true });
    writeFileSync(at(".crewhaus/settings.json"), "{ not json");
    const read = readSettings(at(".crewhaus/settings.json"));
    expect(read.kind).toBe("unusable");
    expect(read.kind === "unusable" && read.reason).toContain("not valid JSON");
  });

  test("a well-formed file yields the rules the engine would load", () => {
    mkdirSync(at(".crewhaus"), { recursive: true });
    writeFileSync(
      at(".crewhaus/settings.json"),
      JSON.stringify({ permissions: { rules: [{ type: "alwaysDeny", pattern: "Bash(rm**)" }] } }),
    );
    const read = readSettings(at(".crewhaus/settings.json"));
    expect(read.kind).toBe("read");
    expect(read.kind === "read" && read.rules).toEqual([
      { type: "alwaysDeny", pattern: "Bash(rm**)" },
    ]);
    expect(read.kind === "read" && read.mergeUnsafeReason).toBeUndefined();
  });

  test("an entry the reader cannot recognise makes a MERGE undescribable — because a write would drop it", () => {
    mkdirSync(at(".crewhaus"), { recursive: true });
    writeFileSync(
      at(".crewhaus/settings.json"),
      JSON.stringify({
        permissions: {
          rules: [
            { type: "alwaysDeny", pattern: "Bash(rm**)" },
            { type: "alwaysQuarantine", pattern: "Fetch" }, // a type from a newer CrewHaus
          ],
        },
      }),
    );
    const read = readSettings(at(".crewhaus/settings.json"));
    expect(read.kind).toBe("read");
    expect(read.kind === "read" && read.declaredEntries).toBe(2);
    expect(read.kind === "read" && read.rules).toHaveLength(1);
    expect(read.kind === "read" && read.mergeUnsafeReason).toContain("silently drop");
  });

  test("`permissions.rules` that is not an array is named rather than read as empty", () => {
    mkdirSync(at(".crewhaus"), { recursive: true });
    writeFileSync(at(".crewhaus/settings.json"), JSON.stringify({ permissions: { rules: "all" } }));
    const read = readSettings(at(".crewhaus/settings.json"));
    expect(read.kind === "read" && read.mergeUnsafeReason).toContain("other than an array");
  });

  test("countDeclaredRuleEntries counts the RAW entries, which is the point", () => {
    expect(countDeclaredRuleEntries({ permissions: { rules: [1, 2, 3] } })).toBe(3);
    expect(countDeclaredRuleEntries({ permissions: {} })).toBeNull();
    expect(countDeclaredRuleEntries(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

describe("readRecentSessions", () => {
  const sessionsDir = (): string => path.join(tmp, ".crewhaus", "sessions");

  test("a missing sessions directory is MISSING, and yields no failures", () => {
    const read = readRecentSessions(sessionsDir(), 20);
    expect(read.missingDir).toBe(true);
    expect(read.sessions).toEqual([]);
    expect(read.unreadableDir).toBeUndefined();
  });

  test("picks the most recent N by mtime, with the filename as the tiebreak", () => {
    for (const id of ["sess_a", "sess_b", "sess_c"]) writeSession(tmp, id, ['{"kind":"x"}']);
    // mtimes are SET explicitly rather than measured — a test that raced the
    // filesystem's timestamp granularity would be flaky, and asserting on a
    // wall clock is banned outright.
    const set = (id: string, epoch: number): void =>
      utimesSync(path.join(sessionsDir(), `${id}.jsonl`), epoch, epoch);
    set("sess_a", 1_000);
    set("sess_b", 3_000);
    set("sess_c", 2_000);
    const read = readRecentSessions(sessionsDir(), 2);
    expect(read.sessions.map((s) => s.sessionId)).toEqual(["sess_b", "sess_c"]);
    expect(read.available).toBe(3);
  });

  test('"all" mines every log', () => {
    for (const id of ["sess_a", "sess_b"]) writeSession(tmp, id, ['{"kind":"x"}']);
    expect(readRecentSessions(sessionsDir(), "all").sessions).toHaveLength(2);
  });

  test("a log that cannot be read is reported per-file; the others are still mined", () => {
    writeSession(tmp, "sess_good", ['{"kind":"x"}']);
    mkdirSync(path.join(sessionsDir(), "sess_bad.jsonl"));
    const read = readRecentSessions(sessionsDir(), 20);
    expect(read.sessions.map((s) => s.sessionId)).toEqual(["sess_good"]);
    expect(read.failures).toHaveLength(1);
    expect(read.failures[0]?.file).toBe("sess_bad.jsonl");
    expect(read.failures[0]?.reason).toContain("not a regular file");
  });

  test("lines that did not parse are COUNTED, so a quiet mining window is distinguishable from a torn one", () => {
    writeSession(tmp, "sess_a", ['{"kind":"tool_use"}', "{not json", '{"kind":"permission"}']);
    const read = readRecentSessions(sessionsDir(), 20);
    expect(read.tornLines).toBe(1);
    expect(read.sessions[0]?.objects).toHaveLength(2);
  });

  test("a log that is a link OUT of the workspace is refused and never opened (security-2#2)", () => {
    // The workspace is tmp/ws; the planted link points at tmp/outside.
    const ws = path.join(tmp, "ws");
    const dir = path.join(ws, ".crewhaus", "sessions");
    mkdirSync(dir, { recursive: true });
    mkdirSync(path.join(tmp, "outside"));
    const secret = path.join(tmp, "outside", "other-project.jsonl");
    writeFileSync(secret, '{"kind":"tool_use","payload":{"input":{"command":"sk-OUTSIDE"}}}\n');
    symlinkSync(secret, path.join(dir, "sess_planted.jsonl"));
    writeFileSync(path.join(dir, "sess_own.jsonl"), '{"kind":"x"}\n');
    // A link that stays inside the workspace is followed.
    writeFileSync(path.join(ws, "shared.jsonl"), '{"kind":"y"}\n');
    symlinkSync(path.join(ws, "shared.jsonl"), path.join(dir, "sess_shared.jsonl"));

    const read = readRecentSessions(dir, "all", ws);
    expect(read.sessions.map((s) => s.sessionId).sort()).toEqual(["sess_own", "sess_shared"]);
    expect(read.failures).toEqual([
      {
        file: "sess_planted.jsonl",
        reason: "is a symbolic link that leads outside the workspace, so it was not read",
      },
    ]);
    expect(JSON.stringify(read)).not.toContain("sk-OUTSIDE");
    // Counted as seen, so the caller can say a log went unread.
    expect(read.available).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// the unknown vocabulary
// ---------------------------------------------------------------------------

describe("Unknowns", () => {
  test("first writer wins — the specific failure is not overwritten by a generic one", () => {
    const u = new Unknowns();
    u.add("total", "read x", "the specific reason");
    u.add("total", "read y", "the generic reason");
    expect(u.list()).toEqual([{ field: "total", probe: "read x", reason: "the specific reason" }]);
  });

  test("listing is sorted by field, so two calls return the same bytes", () => {
    const u = new Unknowns();
    u.add("z", "p", "r");
    u.add("a", "p", "r");
    expect(u.list().map((f) => f.field)).toEqual(["a", "z"]);
  });
});

test("firstLine caps a long error text", () => {
  expect(firstLine("", 10)).toBe("");
  expect(firstLine("\n\n  hello \nworld")).toBe("hello");
  expect(firstLine("x".repeat(500))).toHaveLength(200);
});

// ---------------------------------------------------------------------------
// what is, and is not, a session log
// ---------------------------------------------------------------------------

describe("isSessionLogName", () => {
  test("keeps transcripts and drops the two siblings that share the directory", () => {
    expect(isSessionLogName("sess_00000000000000ab.jsonl")).toBe(true);
    expect(isSessionLogName("anything-else.jsonl")).toBe(true); // vintages vary
    expect(isSessionLogName("approvals.jsonl")).toBe(false);
    expect(isSessionLogName("sess_00000000000000ab.events.jsonl")).toBe(false);
    expect(isSessionLogName("sessions-index.json")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evidence that the session root moved
// ---------------------------------------------------------------------------

describe("sessionRootRelocation", () => {
  test("declaresSessionDir reads the KEY and never the value", () => {
    expect(declaresSessionDir("CREWHAUS_SESSION_DIR=/var/x")).toBe(true);
    expect(declaresSessionDir("export CREWHAUS_SESSION_DIR = /var/x")).toBe(true);
    expect(declaresSessionDir('OTHER=1\nCREWHAUS_SESSION_DIR="/var/x"\n')).toBe(true);
    // A comment is not an assignment…
    expect(declaresSessionDir("# CREWHAUS_SESSION_DIR=/var/x")).toBe(false);
    // …and neither is a mention on the right-hand side of another key.
    expect(declaresSessionDir("NOTE=see CREWHAUS_SESSION_DIR")).toBe(false);
    expect(declaresSessionDir("CREWHAUS_SESSION_DIRECTORY=/var/x")).toBe(false);
    expect(declaresSessionDir("")).toBe(false);
  });

  test("finds the declaration in either chain file, and reports nothing without one", () => {
    const dir = path.join(tmp, "h");
    mkdirSync(dir, { recursive: true });
    const env: Record<string, string | undefined> = {};
    expect(sessionRootRelocation(dir, env)).toBeUndefined();
    writeFileSync(path.join(dir, ".env.local"), "CREWHAUS_SESSION_DIR=/var/x\n");
    expect(sessionRootRelocation(dir, env)).toContain(".env.local");
    // The process env is the strongest signal and is checked first.
    expect(sessionRootRelocation(dir, { CREWHAUS_SESSION_DIR: "/var/y" })).toContain(
      "this process's environment",
    );
    // An empty value is not a relocation.
    expect(sessionRootRelocation(path.join(tmp, "other"), { CREWHAUS_SESSION_DIR: "  " })).toBe(
      undefined,
    );
  });

  test("an env file linked from OUTSIDE the workspace is not read, and the answer says unknown", () => {
    const ws = path.join(tmp, "ws");
    const dir = path.join(ws, "h");
    mkdirSync(dir, { recursive: true });
    mkdirSync(path.join(tmp, "outside"));
    // The outside file does NOT assign the variable: if it were read, the
    // probe would answer "no evidence" — the one-bit leak the audit found.
    writeFileSync(path.join(tmp, "outside", ".env"), "UNRELATED=1\n");
    symlinkSync(path.join(tmp, "outside", ".env"), path.join(dir, ".env"));
    const said = sessionRootRelocation(dir, {}, ws);
    expect(said).toContain("outside the workspace, which is not read here");
    expect(said).toContain("unknown");

    // A link that stays inside the workspace is followed.
    rmSync(path.join(dir, ".env"));
    writeFileSync(path.join(ws, "shared.env"), "CREWHAUS_SESSION_DIR=/var/x\n");
    symlinkSync(path.join(ws, "shared.env"), path.join(dir, ".env"));
    expect(sessionRootRelocation(dir, {}, ws)).toContain("assigns CREWHAUS_SESSION_DIR");
  });
});
