/**
 * The tools, driven against a real workspace.
 *
 * Every test builds a throwaway directory under the OS temp dir and chdir's
 * into it — the containment root is `process.cwd()`, so the tools must see the
 * temp tree as the workspace. Nothing here writes into the repository and
 * nothing reaches a network address.
 *
 * The assertions are about what the tools DID: which records came back, which
 * counts were withheld, which reason was named, and — for the whole package —
 * that not one byte on disk changed across a call. `adversarial.test.ts` covers
 * the rule-widening property on its own.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  approval,
  approvalId,
  askSession,
  makeHarness,
  permissionAsk,
  writeApprovals,
  writeSession,
  writeSettings,
} from "./fixtures";
import { APPROVALS_TOOLS, approvalStatus, approvalsInbox, permissionsSuggest } from "./index";

const originalCwd = process.cwd();
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-tool-approvals-"));
  process.chdir(tmp);
});
afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

type AnyTool = { readonly execute: (input: unknown) => Promise<string> };

async function call(tool: unknown, input: unknown): Promise<string> {
  return await (tool as AnyTool).execute(input);
}

async function callJson<T = Record<string, unknown>>(tool: unknown, input: unknown): Promise<T> {
  const raw = await call(tool, input);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`expected JSON, got: ${raw}`);
  }
}

/** Every file under `dir`, with its bytes — the before/after for "wrote nothing". */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) out.set(path.relative(dir, p), readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return out;
}

/**
 * Walk a result and collect the dotted path of every null it carries.
 *
 * Array indices are normalised to `[]` so a null at `suggestions[3].readOnly`
 * is matched by the one unknown entry that explains the whole column — a
 * per-row entry would be the same sentence repeated N times.
 */
function nullPaths(value: unknown, prefix = ""): string[] {
  if (value === null) return [prefix];
  if (Array.isArray(value)) return value.flatMap((v) => nullPaths(v, `${prefix}[]`));
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      nullPaths(v, prefix === "" ? k : `${prefix}.${k}`),
    );
  }
  return [];
}

// ---------------------------------------------------------------------------
// ApprovalStatus
// ---------------------------------------------------------------------------

describe("ApprovalStatus", () => {
  test("a harness that never parked anything reports zero, and says the ledger is simply absent", async () => {
    makeHarness(tmp, ".");
    const out = await callJson(approvalStatus, {});
    expect(out["store"]).toMatchObject({ state: "missing" });
    expect(out["total"]).toBe(0);
    expect(out["approvals"]).toEqual([]);
    // Nothing unknown here — "no file" really is "nothing was ever parked".
    expect(out["unknown"]).toEqual([]);
  });

  test("a ledger that CANNOT be read reports total null with the reason — never an empty inbox", async () => {
    mkdirSync(path.join(tmp, ".crewhaus", "sessions", "approvals.jsonl"), { recursive: true });
    const out = await callJson(approvalStatus, {});
    expect(out["total"]).toBeNull();
    expect(out["counts"]).toBeNull();
    const unknown = out["unknown"] as Array<{ field: string; reason: string }>;
    expect(unknown.map((u) => u.field)).toContain("total");
    // The REASON, not just the failure: an empty inbox and an unreadable one
    // are the two answers this assertion exists to keep apart.
    expect(unknown.find((u) => u.field === "total")?.reason).toContain("UNKNOWN");
  });

  test("filters run BEFORE the limit — the trap that returns zero rows when matches exist", async () => {
    // Two Bash parks, then five newer Read parks. A limit pushed into the read
    // would take the five Reads and then filter them all away.
    const records = [
      approval({ id: approvalId(1), toolName: "Bash", createdAt: "2026-09-18T01:00:00.000Z" }),
      approval({ id: approvalId(2), toolName: "Bash", createdAt: "2026-09-18T02:00:00.000Z" }),
      ...Array.from({ length: 5 }, (_, i) =>
        approval({
          id: approvalId(10 + i),
          toolName: "Read",
          createdAt: `2026-09-18T1${i}:00:00.000Z`,
        }),
      ),
    ];
    writeApprovals(tmp, records);
    const out = await callJson(approvalStatus, { tool: "Bash", limit: 2 });
    expect(out["matched"]).toBe(2);
    expect(out["returned"]).toBe(2);
    expect((out["approvals"] as Array<{ id: string }>).map((r) => r.id)).toEqual([
      approvalId(1),
      approvalId(2),
    ]);
  });

  test("an id that is absent from a PARTLY READ ledger is UNKNOWN, not a definite no", async () => {
    // The listing already calls its counts a floor when a line did not parse.
    // A single-id lookup answers true/false, and `false` reads as "there is no
    // such approval" — while the record may be in the line that did not parse
    // (or, for a capped read, in the bytes past the cap).
    writeApprovals(tmp, ["{ torn", approval({ id: approvalId(1) })]);
    const out = await callJson(approvalStatus, { approvalId: approvalId(7) });
    expect(out["found"]).toBeNull();
    const unknown = out["unknown"] as Array<{ field: string; reason: string }>;
    expect(unknown.find((u) => u.field === "found")?.reason).toContain("did not parse");
    expect(unknown.find((u) => u.field === "found")?.reason).toContain("UNKNOWN");
    // A HIT is still a hit: what was read was read.
    const hit = await callJson(approvalStatus, { approvalId: approvalId(1) });
    expect(hit["found"]).toBe(true);
    // …and an intact ledger still answers a plain no.
    writeApprovals(tmp, [approval({ id: approvalId(1) })]);
    expect((await callJson(approvalStatus, { approvalId: approvalId(7) }))["found"]).toBe(false);
  });

  test("a limit shorter than the match set says so rather than looking complete", async () => {
    writeApprovals(
      tmp,
      Array.from({ length: 5 }, (_, i) =>
        approval({ id: approvalId(i + 1), createdAt: `2026-09-18T0${i}:00:00.000Z` }),
      ),
    );
    const out = await callJson(approvalStatus, { limit: 2 });
    expect(out["matched"]).toBe(5);
    expect(out["returned"]).toBe(2);
    expect(out["moreMatchedThanReturned"]).toBe(true);
  });

  test("operator order puts the longest-parked pending first, ahead of anything settled", async () => {
    writeApprovals(tmp, [
      approval({
        id: approvalId(1),
        createdAt: "2026-09-18T09:00:00.000Z",
        decision: "grant",
        decidedAt: "2026-09-18T23:00:00.000Z",
      }),
      approval({ id: approvalId(2), createdAt: "2026-09-18T08:00:00.000Z" }),
      approval({ id: approvalId(3), createdAt: "2026-09-18T07:00:00.000Z" }),
    ]);
    const out = await callJson(approvalStatus, {});
    expect((out["approvals"] as Array<{ id: string }>).map((r) => r.id)).toEqual([
      approvalId(3),
      approvalId(2),
      approvalId(1),
    ]);
  });

  test("one approval by id, with the operative argument an approver has to judge", async () => {
    writeApprovals(tmp, [
      approval({
        id: approvalId(1),
        toolName: "Bash",
        input: { command: "rm -rf build" },
        decision: "deny",
        decidedBy: "max",
        decidedAt: "2026-09-18T11:00:00.000Z",
      }),
    ]);
    const out = await callJson(approvalStatus, { approvalId: approvalId(1) });
    expect(out["found"]).toBe(true);
    expect(out["approval"]).toMatchObject({
      toolName: "Bash",
      status: "denied",
      decidedBy: "max",
      operativeField: "command",
      operativeValue: "rm -rf build",
    });
  });

  test("an id the ledger does not hold is a clean false — the ledger WAS read", async () => {
    writeApprovals(tmp, [approval({ id: approvalId(1) })]);
    const out = await callJson(approvalStatus, { approvalId: approvalId(2) });
    expect(out["found"]).toBe(false);
    expect(out["unknown"]).toEqual([]);
  });

  test("an id of the wrong SHAPE is refused with what the shape is", async () => {
    writeApprovals(tmp, [approval({ id: approvalId(1) })]);
    const out = await callJson(approvalStatus, { approvalId: "../../etc/passwd" });
    expect(out["found"]).toBe(false);
    expect(String(out["note"])).toContain("16 hex");
  });

  test("looking for an id in an UNREADABLE ledger answers null, not false", async () => {
    mkdirSync(path.join(tmp, ".crewhaus", "sessions", "approvals.jsonl"), { recursive: true });
    const out = await callJson(approvalStatus, { approvalId: approvalId(1) });
    expect(out["found"]).toBeNull();
    const unknown = out["unknown"] as Array<{ field: string }>;
    expect(unknown.map((u) => u.field)).toContain("found");
  });

  test("a torn ledger line makes the total a declared floor", async () => {
    writeApprovals(tmp, [approval({ id: approvalId(1) }), "{not json"]);
    const out = await callJson(approvalStatus, {});
    expect(out["total"]).toBe(1);
    const unknown = out["unknown"] as Array<{ field: string; reason: string }>;
    expect(unknown.find((u) => u.field === "store.tornLines")?.reason).toContain("FLOOR");
  });

  test("a path out of the workspace is refused before any read", async () => {
    const out = await call(approvalStatus, { dir: "../.." });
    expect(out).toContain("escapes the workspace root");
  });

  test("a since/until window that selects nothing is refused rather than answered with zero", async () => {
    writeApprovals(tmp, [approval({ id: approvalId(1) })]);
    const out = await call(approvalStatus, {
      since: "2026-09-19T00:00:00Z",
      until: "2026-09-18T00:00:00Z",
    });
    expect(out).toContain('"since" is after "until"');
  });

  test("a non-ISO since is refused with the shape it wanted", async () => {
    writeApprovals(tmp, [approval({ id: approvalId(1) })]);
    expect(await call(approvalStatus, { since: "yesterday" })).toContain("ISO-8601");
  });
});

// ---------------------------------------------------------------------------
// ApprovalsInbox
// ---------------------------------------------------------------------------

describe("ApprovalsInbox", () => {
  test("folds every harness under the root into one page, tagged by harness", async () => {
    makeHarness(tmp, "alpha");
    makeHarness(tmp, "beta");
    writeApprovals(path.join(tmp, "alpha"), [
      approval({ id: approvalId(1), createdAt: "2026-09-18T08:00:00.000Z" }),
    ]);
    writeApprovals(path.join(tmp, "beta"), [
      approval({ id: approvalId(2), createdAt: "2026-09-18T07:00:00.000Z" }),
    ]);
    const out = await callJson(approvalsInbox, {});
    expect(out["harnessCount"]).toBe(2);
    expect(out["totals"]).toMatchObject({ pending: 2 });
    expect(out["totalsAreComplete"]).toBe(true);
    expect(
      (out["approvals"] as Array<{ harness: string; id: string }>).map((r) => [r.harness, r.id]),
    ).toEqual([
      ["beta", approvalId(2)],
      ["alpha", approvalId(1)],
    ]);
  });

  test("ONE unreadable harness does not blind the operator to the rest, and the totals become a FLOOR", async () => {
    makeHarness(tmp, "good");
    makeHarness(tmp, "broken");
    writeApprovals(path.join(tmp, "good"), [approval({ id: approvalId(1) })]);
    mkdirSync(path.join(tmp, "broken", ".crewhaus", "sessions", "approvals.jsonl"), {
      recursive: true,
    });
    const out = await callJson(approvalsInbox, {});
    expect(out["harnessCount"]).toBe(2);
    expect(out["harnessesRead"]).toBe(1);
    expect(out["totals"]).toMatchObject({ pending: 1 });
    expect(out["totalsAreComplete"]).toBe(false);
    expect(out["unreadableHarnesses"]).toEqual([
      { harness: "broken", reason: "the path is not a regular file" },
    ]);
    const unknown = out["unknown"] as Array<{ field: string; reason: string }>;
    expect(unknown.find((u) => u.field === "totals")?.reason).toContain("FLOOR");
    // The good harness's park is still on the page — that is the whole point.
    expect((out["approvals"] as Array<{ id: string }>).map((r) => r.id)).toEqual([approvalId(1)]);
  });

  test("a walk stopped by its cap declares it instead of reporting a short fleet", async () => {
    for (const name of ["h1", "h2", "h3"]) makeHarness(tmp, name);
    const out = await callJson(approvalsInbox, { maxHarnesses: 2 });
    expect(out["harnessCount"]).toBe(2);
    const unknown = out["unknown"] as Array<{ field: string; reason: string }>;
    expect(unknown.find((u) => u.field === "harnessCount")?.reason).toContain("cap of 2");
  });

  test("a walk stopped by its cap makes the totals a FLOOR — a fleet nobody looked at is not an idle fleet", async () => {
    // The cap is the silent case. A harness the walk never reached contributes
    // nothing to `totals`, exactly like one whose ledger would not open — but
    // only the second used to make `totalsAreComplete` false, so a capped walk
    // answered "pending: 0, complete: true" over a fleet with a parked run in
    // it. h3 sorts last, so the cap of 2 is what hides it.
    for (const name of ["h1", "h2", "h3"]) makeHarness(tmp, name);
    writeApprovals(path.join(tmp, "h3"), [approval({ id: approvalId(9) })]);
    const out = await callJson(approvalsInbox, { maxHarnesses: 2 });
    expect(out["harnessCount"]).toBe(2);
    // The park really is invisible to this page — which is why the totals must
    // not be presented as totals.
    expect(out["totals"]).toMatchObject({ pending: 0 });
    expect(out["totalsAreComplete"]).toBe(false);
    const unknown = out["unknown"] as Array<{ field: string; reason: string }>;
    expect(unknown.find((u) => u.field === "totals")?.reason).toContain("FLOOR");
    expect(unknown.find((u) => u.field === "totals")?.reason).toContain("cap of 2");
    expect(unknown.find((u) => u.field === "matched")?.reason).toContain("floor");
  });

  test("EVERY reason the walk fell short is named, not just the first one", async () => {
    // `Unknowns.add` is first-writer-wins, so three separate `add("harnessCount")`
    // calls report one condition and drop the rest. Both conditions hold here.
    makeHarness(tmp, "deep/a/b/c/d/e");
    makeHarness(tmp, "x");
    makeHarness(tmp, "y");
    const out = await callJson(approvalsInbox, { maxHarnesses: 1, maxDepth: 2 });
    expect(out["walk"]).toMatchObject({ truncated: true, depthLimited: true });
    const reason = (out["unknown"] as Array<{ field: string; reason: string }>).find(
      (u) => u.field === "harnessCount",
    )?.reason;
    expect(reason).toContain("cap of 1");
    expect(reason).toContain("depth 2");
  });

  test("a harness that relocates its session root is not reported as parking nothing", async () => {
    // `CREWHAUS_SESSION_DIR` moves the session root, and the approvals ledger
    // goes with it (hangar-server's `resolveSessionRoot` says so in those
    // words). This tool reads the one conventional path, so an absent file
    // there is evidence of nothing at all — and "nothing parked" is the one
    // answer it must never give by default.
    makeHarness(tmp, "moved");
    writeFileSync(path.join(tmp, "moved", ".env"), "CREWHAUS_SESSION_DIR=/var/crewhaus/sessions\n");
    makeHarness(tmp, "normal");
    const out = await callJson(approvalsInbox, {});
    expect(out["harnessesRead"]).toBe(1);
    expect(out["unreadableHarnesses"]).toEqual([
      {
        harness: "moved",
        reason: expect.stringContaining("CREWHAUS_SESSION_DIR") as unknown as string,
      },
    ]);
    expect(out["totalsAreComplete"]).toBe(false);

    const one = await callJson(approvalStatus, { dir: "moved" });
    expect(one["total"]).toBeNull();
    expect(one["counts"]).toBeNull();
    const unknown = one["unknown"] as Array<{ field: string; reason: string }>;
    expect(unknown.find((u) => u.field === "total")?.reason).toContain("UNKNOWN");
    // …and a harness that does NOT relocate still answers a plain zero.
    const plain = await callJson(approvalStatus, { dir: "normal" });
    expect(plain["total"]).toBe(0);
    expect(plain["unknown"]).toEqual([]);
  });

  test("an explicit harness list is used verbatim, and two spellings of one harness count once", async () => {
    makeHarness(tmp, "alpha");
    writeApprovals(path.join(tmp, "alpha"), [approval({ id: approvalId(1) })]);
    const out = await callJson(approvalsInbox, { harnesses: ["alpha", "./alpha", "alpha/"] });
    expect(out["harnessCount"]).toBe(1);
    expect(out["totals"]).toMatchObject({ pending: 1 });
    expect((out["walk"] as { source: string }).source).toBe("explicit");
  });

  test("filters and ordering behave as they do for one harness", async () => {
    makeHarness(tmp, "alpha");
    makeHarness(tmp, "beta");
    writeApprovals(path.join(tmp, "alpha"), [
      approval({ id: approvalId(1), toolName: "Bash", createdAt: "2026-09-18T08:00:00.000Z" }),
    ]);
    writeApprovals(path.join(tmp, "beta"), [
      approval({ id: approvalId(2), toolName: "Read", createdAt: "2026-09-18T07:00:00.000Z" }),
      approval({
        id: approvalId(3),
        toolName: "Bash",
        createdAt: "2026-09-18T06:00:00.000Z",
        decision: "deny",
        decidedAt: "2026-09-18T09:00:00.000Z",
      }),
    ]);
    const out = await callJson(approvalsInbox, { tool: "Bash", order: "oldest" });
    expect((out["approvals"] as Array<{ id: string }>).map((r) => r.id)).toEqual([
      approvalId(3),
      approvalId(1),
    ]);
    // The unfiltered totals still describe the whole fleet.
    expect(out["totals"]).toMatchObject({ pending: 2, denied: 1 });
    expect(out["matched"]).toBe(2);
  });

  test("age is measured only against the `now` the caller supplied", async () => {
    makeHarness(tmp, "alpha");
    writeApprovals(path.join(tmp, "alpha"), [
      approval({ id: approvalId(1), createdAt: "2026-09-18T08:00:00.000Z" }),
    ]);
    const without = await callJson(approvalsInbox, {});
    expect((without["approvals"] as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
      "ageSeconds",
    );
    const withNow = await callJson(approvalsInbox, { now: "2026-09-18T09:00:00.000Z" });
    expect((withNow["approvals"] as Array<{ ageSeconds: number }>)[0]?.ageSeconds).toBe(3600);
  });

  test("a root BELOW the workspace reads each harness's real ledger, not a same-named one at the top", async () => {
    // Regression: the walk reports each harness relative to the ROOT it was
    // given, and feeding that display path to the containment check resolves
    // `fleet/alpha` as `<cwd>/alpha`. Because a missing ledger is a legitimate
    // "nothing parked", the whole fleet then reads as idle with nothing to say
    // the wrong directory was read. The decoy at the top level is what makes
    // the failure silent, so it is part of the fixture.
    makeHarness(tmp, "fleet/alpha");
    writeApprovals(path.join(tmp, "fleet", "alpha"), [
      approval({ id: approvalId(1), toolName: "Bash" }),
    ]);
    mkdirSync(path.join(tmp, "alpha"), { recursive: true }); // the decoy: no ledger
    const out = await callJson(approvalsInbox, { root: "fleet" });
    expect(out["harnessCount"]).toBe(1);
    expect(out["harnesses"]).toEqual(["alpha"]);
    expect(out["totals"]).toMatchObject({ pending: 1 });
    expect((out["approvals"] as Array<{ id: string }>).map((r) => r.id)).toEqual([approvalId(1)]);
  });

  test("a named harness directory that is not there is reported, not counted as empty", async () => {
    makeHarness(tmp, "alpha");
    writeApprovals(path.join(tmp, "alpha"), [approval({ id: approvalId(1) })]);
    const out = await callJson(approvalsInbox, { harnesses: ["alpha", "ghost"] });
    expect(out["harnessesRead"]).toBe(1);
    expect(out["unreadableHarnesses"]).toEqual([
      { harness: "ghost", reason: "the directory does not exist" },
    ]);
    expect(out["totalsAreComplete"]).toBe(false);
  });

  test("every status survives the fleet round-trip into the shared comparator", async () => {
    // `rowAsRecord` reconstitutes the fields the row projection dropped so the
    // one-harness comparator can sort the fleet list. If that reconstitution
    // lost a status, the fleet would order settled parks as if they were
    // pending — which is the order an operator acts on.
    makeHarness(tmp, "alpha");
    writeApprovals(path.join(tmp, "alpha"), [
      approval({ id: approvalId(1) }),
      approval({ id: approvalId(2), decision: "grant" }),
      approval({ id: approvalId(3), decision: "grant", always: true }),
      approval({ id: approvalId(4), decision: "deny" }),
      approval({ id: approvalId(5), decision: "grant", consumedAt: "2026-09-18T11:00:00.000Z" }),
    ]);
    const out = await callJson(approvalsInbox, {});
    const statuses = (out["approvals"] as Array<{ id: string; status: string }>)
      .map((r) => `${r.id.slice(-1)}:${r.status}`)
      .sort();
    expect(statuses).toEqual([
      "1:pending",
      "2:granted",
      "3:granted-always",
      "4:denied",
      "5:consumed",
    ]);
    // …and the pending one is still first, which is what the comparator is for.
    expect((out["approvals"] as Array<{ status: string }>)[0]?.status).toBe("pending");
  });

  test("an empty status list is refused rather than answered with an empty inbox", async () => {
    makeHarness(tmp, "alpha");
    writeApprovals(path.join(tmp, "alpha"), [approval({ id: approvalId(1) })]);
    for (const tool of [approvalStatus, approvalsInbox]) {
      expect(await call(tool, { status: [] })).toContain("matches nothing");
    }
  });

  test("a root holding no harnesses is an empty fleet, not an error", async () => {
    const out = await callJson(approvalsInbox, {});
    expect(out["harnessCount"]).toBe(0);
    expect(out["totals"]).toMatchObject({ pending: 0 });
    expect(out["totalsAreComplete"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PermissionsSuggest
// ---------------------------------------------------------------------------

describe("PermissionsSuggest", () => {
  test("a recurring always-approved ask becomes an alwaysAllow keyed to the approved input", async () => {
    askSession(tmp, "sess_1", {
      toolName: "Read",
      input: { path: "docs/notes.md" },
      approved: 3,
    });
    const out = await callJson(permissionsSuggest, {});
    const suggestions = out["suggestions"] as Array<Record<string, unknown>>;
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      type: "alwaysAllow",
      pattern: "Read(docs/notes.md)",
      toolName: "Read",
      argConstrained: true,
    });
    expect(out["appliesRules"]).toBe(false);
    expect((out["diff"] as { additions: unknown[] }).additions).toEqual([
      { type: "alwaysAllow", pattern: "Read(docs/notes.md)" },
    ]);
  });

  test("a recurring DENIED ask becomes an alwaysAsk tightening, never a blanket deny", async () => {
    askSession(tmp, "sess_1", { toolName: "Bash", input: { command: "rm -rf /" }, denied: 4 });
    const out = await callJson(permissionsSuggest, {});
    const suggestions = out["suggestions"] as Array<{ type: string; pattern: string }>;
    expect(suggestions[0]?.type).toBe("alwaysAsk");
    expect(suggestions.every((s) => s.type !== "alwaysDeny")).toBe(true);
  });

  test("below the ask threshold nothing is proposed", async () => {
    askSession(tmp, "sess_1", { toolName: "Read", input: { path: "a.md" }, approved: 2 });
    const out = await callJson(permissionsSuggest, {});
    expect(out["suggestions"]).toEqual([]);
    expect((out["asks"] as Array<{ asks: number }>)[0]?.asks).toBe(2);
  });

  test("thresholds are overridable, and `.optional()` defaults resolve in execute", async () => {
    askSession(tmp, "sess_1", { toolName: "Read", input: { path: "a.md" }, approved: 2 });
    const out = await callJson(permissionsSuggest, { minAsks: 2 });
    expect((out["thresholds"] as { minAsks: number }).minAsks).toBe(2);
    expect(out["suggestions"]).toHaveLength(1);
  });

  test("a builtin's read-only flag is its own, not the caller's claim", async () => {
    askSession(tmp, "sess_1", { toolName: "Read", input: { path: "a.md" }, approved: 3 });
    const out = await callJson(permissionsSuggest, {});
    expect((out["suggestions"] as Array<{ readOnly: unknown }>)[0]?.readOnly).toBe(true);
    const unknown = out["unknown"] as Array<{ field: string }>;
    expect(unknown.map((u) => u.field)).not.toContain("suggestions[].readOnly");
    // A claim cannot turn a builtin that writes into a read-only one.
    rmSync(path.join(tmp, ".crewhaus"), { recursive: true, force: true });
    askSession(tmp, "sess_1", { toolName: "Write", input: { path: "a.md" }, approved: 3 });
    const claimed = await callJson(permissionsSuggest, { readOnlyTools: ["Write"] });
    expect((claimed["suggestions"] as Array<{ readOnly: unknown }>)[0]?.readOnly).toBe(false);
  });

  test("read-only-ness of a tool that is not a builtin is UNKNOWN unless the caller supplies it", async () => {
    writeSession(tmp, "sess_1", [
      permissionAsk("mcp__notes__read", "approved"),
      permissionAsk("mcp__notes__read", "approved"),
      permissionAsk("mcp__notes__read", "approved"),
    ]);
    const blind = await callJson(permissionsSuggest, {});
    expect((blind["suggestions"] as Array<{ readOnly: unknown }>)[0]?.readOnly).toBeNull();
    const unknown = blind["unknown"] as Array<{ field: string; reason: string }>;
    expect(unknown.find((u) => u.field === "suggestions[].readOnly")?.reason).toContain(
      "mcp__notes__read is not a builtin",
    );
    // The evidence must not leave harness-advice's fail-closed "NOT read-only"
    // line standing as if it were an observation.
    const evidence = (blind["suggestions"] as Array<{ evidence: string[] }>)[0]?.evidence ?? [];
    expect(evidence.some((line) => line.includes("fail-closed default"))).toBe(true);

    const told = await callJson(permissionsSuggest, { readOnlyTools: ["mcp__notes__read"] });
    expect((told["suggestions"] as Array<{ readOnly: unknown }>)[0]?.readOnly).toBe(true);
  });

  test("a settings file that does not parse withholds the diff instead of proposing against an empty baseline", async () => {
    askSession(tmp, "sess_1", { toolName: "Read", input: { path: "a.md" }, approved: 3 });
    writeSettings(tmp, "{ this is not json");
    const out = await callJson(permissionsSuggest, {});
    expect(out["diff"]).toBeNull();
    expect((out["settings"] as { state: string }).state).toBe("unusable");
    const unknown = out["unknown"] as Array<{ field: string; reason: string }>;
    expect(unknown.find((u) => u.field === "diff")?.reason).toContain("unknown");
    // The suggestions themselves are still useful and still reported.
    expect(out["suggestions"]).toHaveLength(1);
  });

  test("an existing identical rule is reported as already present, never duplicated", async () => {
    askSession(tmp, "sess_1", { toolName: "Read", input: { path: "a.md" }, approved: 3 });
    writeSettings(
      tmp,
      JSON.stringify({ permissions: { rules: [{ type: "alwaysAllow", pattern: "Read(a.md)" }] } }),
    );
    const out = await callJson(permissionsSuggest, {});
    const diff = out["diff"] as { additions: unknown[]; alreadyPresent: unknown[] };
    expect(diff.additions).toEqual([]);
    expect(diff.alreadyPresent).toEqual([{ type: "alwaysAllow", pattern: "Read(a.md)" }]);
  });

  test("a settings file holding a rule this reader cannot recognise withholds `merged`", async () => {
    askSession(tmp, "sess_1", { toolName: "Read", input: { path: "a.md" }, approved: 3 });
    writeSettings(
      tmp,
      JSON.stringify({
        permissions: {
          rules: [
            { type: "alwaysDeny", pattern: "Bash(rm**)" },
            { type: "alwaysQuarantine", pattern: "Fetch" },
          ],
        },
      }),
    );
    const out = await callJson(permissionsSuggest, {});
    const diff = out["diff"] as { additions: unknown[]; merged: unknown };
    // The ADDITIONS are still sound — they are what this tool proposes.
    expect(diff.additions).toEqual([{ type: "alwaysAllow", pattern: "Read(a.md)" }]);
    // The merged list is not, because writing it back would delete the rule the
    // reader did not recognise.
    expect(diff.merged).toBeNull();
    const unknown = out["unknown"] as Array<{ field: string; reason: string }>;
    expect(unknown.find((u) => u.field === "diff.merged")?.reason).toContain("silently drop");
  });

  test("no sessions at all is an empty result that says the directory is missing", async () => {
    const out = await callJson(permissionsSuggest, {});
    expect(out["suggestions"]).toEqual([]);
    expect((out["mined"] as { sessionsDirMissing: boolean }).sessionsDirMissing).toBe(true);
  });

  test("torn session lines make the ask counts a declared floor", async () => {
    writeSession(tmp, "sess_1", [
      JSON.stringify({ kind: "tool_use", payload: { name: "Read", input: { path: "a.md" } } }),
      "{torn",
      JSON.stringify({
        kind: "permission",
        payload: { toolName: "Read", decision: "ask", askOutcome: "approved" },
      }),
    ]);
    const out = await callJson(permissionsSuggest, {});
    const unknown = out["unknown"] as Array<{ field: string; reason: string }>;
    expect(unknown.find((u) => u.field === "mined.tornLines")?.reason).toContain("floor");
  });

  test("the approvals ledger and the watch-me sibling are not session logs, and never take a slot", async () => {
    // Three `.jsonl` files live side by side in a session root: the transcript,
    // its `<id>.events.jsonl` watch-me sibling, and the `approvals.jsonl`
    // ledger. Mining all three inflates `available`, invents session ids, and —
    // the part that changes an answer — competes for the `sessions: N` window.
    // `approvals.jsonl` is written the moment a run parks, so it is routinely
    // the NEWEST file and takes the first slot: asking for one session would
    // mine the ledger and none of the history the counts are supposed to come
    // from.
    askSession(tmp, "sess_a", { toolName: "Read", input: { path: "a.md" }, approved: 3 });
    writeFileSync(
      path.join(tmp, ".crewhaus", "sessions", "sess_a.events.jsonl"),
      `${JSON.stringify({ kind: "model_response", payload: {} })}\n`,
    );
    writeApprovals(tmp, [approval({ id: approvalId(1) })]);

    const out = await callJson(permissionsSuggest, { sessions: 1 });
    const mined = out["mined"] as { available: number; mined: string[] };
    expect(mined.available).toBe(1);
    expect(mined.mined).toEqual(["sess_a"]);
    // The real session was mined, so the grant it evidences is still proposed.
    expect((out["suggestions"] as Array<{ pattern: string }>).map((x) => x.pattern)).toEqual([
      "Read(a.md)",
    ]);
  });

  test("only the most recent N sessions are mined, and the window is reported", async () => {
    // Three sessions, each asking about a different tool; mine one.
    askSession(tmp, "sess_a", { toolName: "Read", input: { path: "a.md" }, approved: 3 });
    askSession(tmp, "sess_b", { toolName: "Grep", input: { pattern: "x" }, approved: 3 });
    const out = await callJson(permissionsSuggest, { sessions: 1 });
    expect((out["mined"] as { mined: string[] }).mined).toHaveLength(1);
    expect((out["mined"] as { available: number }).available).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// package-wide properties
// ---------------------------------------------------------------------------

describe("package properties", () => {
  test("every tool is read-only, non-destructive, internal and concurrency-safe", () => {
    expect(APPROVALS_TOOLS).toHaveLength(3);
    for (const tool of APPROVALS_TOOLS) {
      expect(tool.readOnly).toBe(true);
      expect(tool.destructive).toBe(false);
      expect(tool.scope).toBe("internal");
      expect(tool.concurrencySafe).toBe(true);
      expect(tool.ioCapability).toBeUndefined();
    }
  });

  test("the tool names are the three this package owns, and each says it decides nothing", () => {
    expect(APPROVALS_TOOLS.map((t) => t.name).sort()).toEqual([
      "ApprovalStatus",
      "ApprovalsInbox",
      "PermissionsSuggest",
    ]);
    // The claim a caller most needs from these descriptions.
    expect(approvalStatus.description).toContain("never grants, denies");
    expect(approvalsInbox.description).toContain("settles nothing");
    expect(permissionsSuggest.description).toContain("PROPOSES and writes nothing");
  });

  test("not one byte on disk changes across a call to any tool", async () => {
    makeHarness(tmp, "alpha");
    writeApprovals(path.join(tmp, "alpha"), [
      approval({ id: approvalId(1) }),
      approval({ id: approvalId(1), decision: "grant" }),
    ]);
    askSession(tmp, "sess_1", { toolName: "Read", input: { path: "a.md" }, approved: 3 });
    writeSettings(tmp, JSON.stringify({ permissions: { rules: [] } }));
    const before = snapshot(tmp);
    await call(approvalStatus, { dir: "alpha" });
    await call(approvalsInbox, {});
    await call(permissionsSuggest, {});
    const after = snapshot(tmp);
    // A store `list()` would have COMPACTED the ledger here — the superseded
    // first line would be gone. Byte equality is the proof it was not called.
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
  });

  test("every null in every result carries an unknown entry naming its field", async () => {
    // A workspace where each tool has something it genuinely cannot determine.
    makeHarness(tmp, "broken");
    mkdirSync(path.join(tmp, "broken", ".crewhaus", "sessions", "approvals.jsonl"), {
      recursive: true,
    });
    askSession(tmp, "sess_1", { toolName: "Read", input: { path: "a.md" }, approved: 3 });
    writeSettings(tmp, "{ not json");

    const results = [
      await callJson(approvalStatus, { dir: "broken" }),
      await callJson(approvalStatus, { dir: "broken", approvalId: approvalId(1) }),
      // The commonest shape of all: a harness with no ledger. Nothing here is
      // unknown, so any null it carries is a bug in the result shape.
      await callJson(approvalStatus, { dir: "." }),
      await callJson(approvalsInbox, {}),
      await callJson(permissionsSuggest, {}),
    ];
    for (const result of results) {
      const explained = new Set(
        (result["unknown"] as Array<{ field: string }>).map((u) => u.field),
      );
      for (const nullPath of nullPaths(result)) {
        if (nullPath.startsWith("unknown")) continue;
        // `decidedBy`/`decidedAt` are null because the record HAS no decision —
        // a known absence, not a failed read.
        if (/\.(decidedBy|decidedAt|operativeField|operativeValue)$/.test(nullPath)) continue;
        const root = nullPath.split(/[.[]/)[0] as string;
        expect(
          explained.has(nullPath) || explained.has(root) || explained.has(`${root}.merged`),
        ).toBe(true);
      }
    }
  });

  test("a dir argument that escapes the workspace is refused by every tool", async () => {
    const escaping = ["../..", "/etc", "\u0000/etc/passwd", "a/../../../..", "~/../.."];
    for (const dir of escaping) {
      for (const tool of [approvalStatus, permissionsSuggest]) {
        const out = await call(tool, { dir });
        // A refusal is a plain sentence; a result is JSON. The distinction is
        // what stops "it returned something" from passing for "it was refused".
        expect(out.startsWith("{")).toBe(false);
        expect(out).toMatch(/escapes the workspace root|NUL byte/);
      }
      expect(await call(approvalsInbox, { root: dir })).not.toStartWith("{");
      expect(await call(approvalsInbox, { harnesses: [dir] })).not.toStartWith("{");
    }
  });

  test("a backslash path is a FILENAME on POSIX, not a traversal — it stays contained", async () => {
    // `..\..\windows` carries no POSIX separator, so it names one (absent)
    // entry inside the workspace. Refusing it would be wrong; the assertion is
    // that it resolved INSIDE, which is what containment actually claims.
    const out = await callJson(approvalStatus, { dir: "..\\..\\windows" });
    expect(out["harnessDir"]).toBe("..\\..\\windows");
    expect(out["total"]).toBe(0);
  });

  test("the results are stable: the same tree answers with the same bytes twice", async () => {
    makeHarness(tmp, "alpha");
    makeHarness(tmp, "beta");
    for (const h of ["alpha", "beta"]) {
      writeApprovals(path.join(tmp, h), [
        approval({ id: approvalId(1), createdAt: "2026-09-18T08:00:00.000Z" }),
        approval({ id: approvalId(2), createdAt: "2026-09-18T08:00:00.000Z" }),
      ]);
    }
    expect(await call(approvalsInbox, {})).toBe(await call(approvalsInbox, {}));
  });
});

test("a large ledger is folded within a budget that a loaded CI box can also meet", async () => {
  // 20k records across 8 harnesses — ~5 MB of JSONL, which is the scale at
  // which the fold's cost is visible at all. The budget is explicit because
  // bun's default is 5000ms and CI is a two-core Linux box; the assertion is
  // on the WORK DONE, not on a stopwatch.
  for (let h = 0; h < 8; h++) {
    const dir = makeHarness(tmp, `h${h}`);
    writeApprovals(
      dir,
      Array.from({ length: 2500 }, (_, i) =>
        approval({
          id: approvalId(h * 10_000 + i),
          toolName: "Bash",
          input: { command: `echo ${"x".repeat(180)}` },
          createdAt: `2026-09-18T0${h}:00:0${i % 10}.000Z`,
        }),
      ),
    );
  }
  const totalBytes = readdirSync(tmp)
    .map((h) => path.join(tmp, h, ".crewhaus", "sessions", "approvals.jsonl"))
    .reduce((sum, p) => sum + statSync(p).size, 0);
  expect(totalBytes).toBeGreaterThan(4_000_000);
  const out = await callJson(approvalsInbox, { limit: 5 });
  expect(out["totals"]).toMatchObject({ pending: 20_000 });
  expect(out["totalsAreComplete"]).toBe(true);
  expect(out["approvals"]).toHaveLength(5);
}, 60_000);
