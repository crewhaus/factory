/**
 * The four tools, driven against real directories and real stores.
 *
 * Every test builds a throwaway workspace under the OS temp dir and chdir's
 * into it, because the containment root is `process.cwd()`. Fixtures are
 * written through the ACTUAL stores — `openScoreboard().record()`,
 * `openWatchmeStore().appendObservation()`, `appendExperimentOutcomes()` —
 * rather than by hand-writing JSONL, so a test cannot pass against a format
 * this package invented.
 *
 * What these tests assert is WHAT HAPPENED ON DISK: after a refusal the file
 * is byte-identical, after a dry run nothing exists, after a promotion the
 * lane line is stamped and a second promotion folds nothing. A test that only
 * checked the returned JSON would pass for a tool that reported a fold it
 * never performed — and for one that performed a fold it never reported.
 *
 * Nothing here asserts elapsed time, heap size or readdir order. The two
 * tests that need an unreadable file skip themselves when the process can
 * read anything (running as root), and say so, rather than passing vacuously.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promoteLanes } from "@crewhaus/routing-store";
import { openScoreboard } from "@crewhaus/routing-store";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { openWatchmeStore } from "@crewhaus/watchme-store";
import { experimentLedger, flywheelStatus, routeControl, watchmeReport } from "./index";

const TOOLS = [routeControl, experimentLedger, flywheelStatus, watchmeReport];
const WRITERS = [routeControl, experimentLedger];
const READERS = [flywheelStatus, watchmeReport];

const originalCwd = process.cwd();
let tmp: string;
const outside: string[] = [];

/** Running as root defeats a mode-based unreadable test; it is skipped, loudly. */
const canTestUnreadable = (process.getuid?.() ?? 0) !== 0;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-tool-routing-"));
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(originalCwd);
  // Restore any mode we tightened, or the cleanup fails.
  for (const rel of [".crewhaus/routing/arms.jsonl", ".github/workflows"]) {
    const abs = path.join(tmp, rel);
    if (existsSync(abs)) {
      try {
        chmodSync(abs, 0o700);
      } catch {
        // Already removed, or never tightened.
      }
    }
  }
  rmSync(tmp, { recursive: true, force: true });
  for (const dir of outside.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Json = Record<string, unknown>;

/** Reach into a parsed result without casting noise at each call site. */
const at = (value: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((acc, key) => (acc as Json | undefined)?.[key], value);

async function callJson(tool: RegisteredTool, input: unknown): Promise<Json> {
  const raw = String(await tool.execute(input as never));
  try {
    return JSON.parse(raw) as Json;
  } catch {
    throw new Error(`expected JSON, got: ${raw}`);
  }
}

function outsideDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "crewhaus-tool-routing-outside-"));
  outside.push(dir);
  return dir;
}

function schemaFields(tool: RegisteredTool): string[] {
  const shape = (
    tool.inputSchema as unknown as { _def?: { shape?: () => object } }
  )._def?.shape?.();
  return shape === undefined ? [] : Object.keys(shape).sort();
}

const STATE = ".crewhaus";
const ARMS = path.join(STATE, "routing", "arms.jsonl");

/** Seed the real scoreboard with live and lane arms. */
function seedArms(): void {
  const board = openScoreboard(path.join(tmp, STATE));
  for (let i = 0; i < 12; i += 1) {
    board.record("hard", "strong", 0.9, { success: true, latencyMs: 100, quality: 0.9 });
  }
  board.record("hard", "cheap", 0.4, { success: true, latencyMs: 20, quality: 0.4 });
  board.ungraded("hard", "cheap");
  board.record("q:hard", "strong", 0.8, { success: true, latencyMs: 90, quality: 0.8 });
  board.record("shadow:hard", "audition", 0.7, {
    success: true,
    latencyMs: 80,
    quality: 1,
    attributedTo: "shadow",
  });
  board.record("shadow:hard", "strong", 0.7, {
    success: true,
    latencyMs: 80,
    quality: 0,
    attributedTo: "primary",
  });
}

// ---------------------------------------------------------------------------
// contract
// ---------------------------------------------------------------------------

test("the writing tools declare destructive and take a dryRun; the readers declare read-only", () => {
  for (const tool of WRITERS) {
    const fields = schemaFields(tool);
    console.log(`SCHEMA ${tool.name} ${fields.join(",")}`);
    expect({
      name: tool.name,
      destructive: tool.destructive,
      dryRun: fields.includes("dryRun"),
      justify: tool.requireJustification,
    }).toEqual({ name: tool.name, destructive: true, dryRun: true, justify: true });
    // The default is stated where a model will read it.
    expect(tool.description).toContain("dryRun defaults to true");
  }
  for (const tool of READERS) {
    expect({ name: tool.name, readOnly: tool.readOnly, destructive: tool.destructive }).toEqual({
      name: tool.name,
      readOnly: true,
      destructive: false,
    });
    expect(tool.concurrencySafe).toBe(true);
  }
  for (const tool of TOOLS) {
    // Nothing here reaches a network or spawns a process.
    expect(tool.scope).toBe("internal");
    expect(tool.ioCapability).toBeUndefined();
  }
  expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
});

test("no schema offers a way around the containment root", () => {
  for (const tool of TOOLS) {
    const fields = schemaFields(tool);
    for (const field of ["cwd", "workspaceRoot", "absolute", "followSymlinks", "unsafe", "force"]) {
      expect({ tool: tool.name, field, present: fields.includes(field) }).toEqual({
        tool: tool.name,
        field,
        present: false,
      });
    }
  }
});

test("every tool refuses a path that escapes the workspace, and says so", async () => {
  const escapes: Array<[RegisteredTool, Json]> = [
    [routeControl, { action: "status", dir: "../escape" }],
    [experimentLedger, { action: "list", dir: "../escape" }],
    [flywheelStatus, { dir: "../escape" }],
    [watchmeReport, { dir: "../escape" }],
  ];
  for (const [tool, input] of escapes) {
    const r = await callJson(tool, input);
    console.log(`ESCAPE ${tool.name} -> ${r["status"]} ${String(r["reason"]).slice(0, 80)}`);
    expect(r["status"]).toBe("refused");
    // The REASON, not just a failure: a missing-directory error would also
    // stop the call without proving the boundary held.
    expect(String(r["reason"])).toMatch(/escapes the workspace root|does not exist/);
  }
});

test("a NUL in a path is refused at the gate, not left to fail as unreadable", async () => {
  const r = await callJson(routeControl, { action: "status", dir: "a\u0000/b" });
  expect(r["status"]).toBe("refused");
  expect(String(r["reason"])).toContain("NUL byte");
});

// ---------------------------------------------------------------------------
// RouteControl — status
// ---------------------------------------------------------------------------

test("RouteControl status on a harness that has never routed is empty, not a refusal", async () => {
  mkdirSync(path.join(tmp, STATE), { recursive: true });
  const r = await callJson(routeControl, { action: "status" });
  expect(r["status"]).toBe("ok");
  expect(r["storeExists"]).toBe(false);
  expect(at(r, "arms", "total")).toBe(0);
  expect(at(r, "freeze", "state")).toBe("none");
});

test("RouteControl status reports every arm with its interval and its n", async () => {
  seedArms();
  const r = await callJson(routeControl, { action: "status" });
  const arms = at(r, "arms", "shown") as Json[];
  const strong = arms.find((a) => a["routeKey"] === "hard" && a["model"] === "strong") as Json;
  const cheap = arms.find((a) => a["routeKey"] === "hard" && a["model"] === "cheap") as Json;
  console.log(`ARMS ${JSON.stringify(arms.map((a) => [a["routeKey"], a["model"], a["n"]]))}`);
  expect(strong["n"]).toBe(12);
  expect(at(strong, "reward", "interval")).not.toBeNull();
  // The single-observation arm has a mean and NO interval, with the reason.
  expect(cheap["n"]).toBe(1);
  expect(at(cheap, "reward", "interval")).toBeNull();
  expect(String(at(cheap, "reward", "note"))).toContain("one observation");
  // Its grade-attempt rate is a proportion with a Wilson interval: one graded,
  // one ungraded.
  expect(at(cheap, "graded", "successes")).toBe(1);
  expect(at(cheap, "graded", "trials")).toBe(2);
  expect(at(cheap, "graded", "interval")).not.toBeNull();
  // And the report says why a rank test between arms is not offered, rather
  // than leaving a reader to assume one was run and found nothing.
  expect(JSON.stringify(r["notes"])).toContain("Welford");
});

test("RouteControl status separates the lanes and reads the audition's two sides apart", async () => {
  seedArms();
  const r = await callJson(routeControl, { action: "status" });
  expect(at(r, "counts", "live")).toBe(2);
  expect(at(r, "counts", "quality")).toBe(1);
  expect(at(r, "counts", "shadow")).toBe(2);
  // The `at` stamp is the only thing separating the candidate from the
  // incumbent; both sides have the same observation count.
  expect(at(r, "shadowSides", "shadow")).toEqual(["audition"]);
  expect(at(r, "shadowSides", "primary")).toEqual(["strong"]);
  const onlyLive = await callJson(routeControl, { action: "status", lane: "live" });
  expect((at(onlyLive, "arms", "shown") as Json[]).every((a) => a["lane"] === "live")).toBe(true);
});

test("RouteControl reports a scoreboard it cannot read as unreadable, never as empty", async () => {
  // Containment succeeds (the name resolves cleanly) and the READ fails: a
  // directory where the arms file should be. This is `loadArms`' own failure
  // branch, the one that must never come back as "no arms".
  mkdirSync(path.join(tmp, ARMS), { recursive: true });
  const r = await callJson(routeControl, { action: "status" });
  expect(r["status"]).toBe("refused");
  expect(r["code"]).toBe("unreadable");
  // Assert the REASON: a plain failure could also be a missing directory.
  expect(String(r["reason"])).toContain("not an empty scoreboard");
});

test("RouteControl refuses a scoreboard whose path it cannot resolve, and does not call it an escape", async () => {
  if (!canTestUnreadable) {
    console.log("SKIP unresolvable-arms: this process can read any file (uid 0)");
    return;
  }
  seedArms();
  chmodSync(path.join(tmp, ARMS), 0o000);
  const r = await callJson(routeControl, { action: "status" });
  expect(r["status"]).toBe("refused");
  expect(r["code"]).toBe("unreadable");
  // The property is that the refusal NAMES the obstruction and rules out the
  // benign reading — not which stage hit it. A chmod-000 file fails at
  // realpath on macOS ("could not resolve ... not an escape") and at open on
  // Linux ("could not be read ... not an empty scoreboard"), because the two
  // kernels differ about resolving a path whose final component is
  // unreadable. Pinning one phrasing tests the platform, and CI is Linux
  // while this is usually written on macOS.
  const reason = String(r["reason"]);
  expect(reason).toMatch(/could not (resolve|be read|be listed)/);
  // ...and it must not let the caller read this as "there is nothing here".
  expect(reason).toMatch(/not an escape|not an empty/);
});

// ---------------------------------------------------------------------------
// RouteControl — freeze / unfreeze
// ---------------------------------------------------------------------------

test("RouteControl freeze previews without writing, then writes the marker it previewed", async () => {
  seedArms();
  const marker = path.join(tmp, STATE, "routing", "freeze.json");
  const preview = await callJson(routeControl, { action: "freeze", policyVersion: "pv-1" });
  expect(preview["status"]).toBe("preview");
  expect(preview["changed"]).toBe(false);
  expect(existsSync(marker)).toBe(false);

  const real = await callJson(routeControl, {
    action: "freeze",
    policyVersion: "pv-1",
    reason: "incident 42",
    dryRun: false,
  });
  expect(real["changed"]).toBe(true);
  expect(at(real, "pinned", "policyVersion")).toBe("pv-1");
  expect(existsSync(marker)).toBe(true);
  const onDisk = JSON.parse(readFileSync(marker, "utf8")) as Json;
  expect(onDisk["policyVersion"]).toBe("pv-1");
  expect(onDisk["reason"]).toBe("incident 42");

  const status = await callJson(routeControl, { action: "status" });
  expect(at(status, "freeze", "state")).toBe("frozen");
});

test("RouteControl freeze without a policyVersion pins nothing and says so", async () => {
  mkdirSync(path.join(tmp, STATE), { recursive: true });
  const r = await callJson(routeControl, { action: "freeze", dryRun: false });
  expect(r["status"]).toBe("refused");
  expect(String(r["reason"])).toContain("policyVersion");
  expect(existsSync(path.join(tmp, STATE, "routing", "freeze.json"))).toBe(false);
});

test("RouteControl unfreeze removes the marker, and reports a no-op as a no-op", async () => {
  mkdirSync(path.join(tmp, STATE), { recursive: true });
  const none = await callJson(routeControl, { action: "unfreeze", dryRun: false });
  expect(none["changed"]).toBe(false);
  expect(none["removed"]).toBe(false);

  await callJson(routeControl, { action: "freeze", policyVersion: "pv-2", dryRun: false });
  const preview = await callJson(routeControl, { action: "unfreeze" });
  expect(preview["status"]).toBe("preview");
  expect(existsSync(path.join(tmp, STATE, "routing", "freeze.json"))).toBe(true);

  const real = await callJson(routeControl, { action: "unfreeze", dryRun: false });
  expect(real["removed"]).toBe(true);
  expect(at(real, "lifted", "policyVersion")).toBe("pv-2");
  expect(existsSync(path.join(tmp, STATE, "routing", "freeze.json"))).toBe(false);
});

// ---------------------------------------------------------------------------
// RouteControl — the kill switch, including the corrupt one
// ---------------------------------------------------------------------------

test("RouteControl refuses to promote or compact under a freeze, and folds nothing", async () => {
  seedArms();
  await callJson(routeControl, { action: "freeze", policyVersion: "pv-3", dryRun: false });
  const before = readFileSync(path.join(tmp, ARMS), "utf8");

  const promote = await callJson(routeControl, {
    action: "promote",
    dryRun: false,
    acceptUngated: true,
  });
  expect(promote["status"]).toBe("refused");
  expect(promote["code"]).toBe("frozen");
  expect(String(promote["reason"])).toContain("pv-3");

  const compact = await callJson(routeControl, { action: "compact", dryRun: false });
  expect(compact["code"]).toBe("frozen");

  // The file is byte-identical: neither refusal touched it.
  expect(readFileSync(path.join(tmp, ARMS), "utf8")).toBe(before);
});

test("a CORRUPT freeze marker stops a promotion that routing-store itself would have run", async () => {
  seedArms();
  const marker = path.join(tmp, STATE, "routing", "freeze.json");
  mkdirSync(path.dirname(marker), { recursive: true });
  writeFileSync(marker, "{ truncated");

  // The library's own freeze check passes no `onMalformed`, so it reads this
  // file as an ABSENT marker and folds. Asserting that here is what makes the
  // guard below a real guard rather than a restatement.
  const wouldFold = promoteLanes(path.join(tmp, STATE), { dryRun: true });
  expect(wouldFold.frozenPolicyVersion).toBeUndefined();
  expect(wouldFold.lines).toBeGreaterThan(0);

  const before = readFileSync(path.join(tmp, ARMS), "utf8");
  const r = await callJson(routeControl, {
    action: "promote",
    dryRun: false,
    acceptUngated: true,
  });
  expect(r["status"]).toBe("refused");
  expect(r["code"]).toBe("corrupt");
  expect(String(r["reason"])).toContain("read this file as ABSENT");
  expect(readFileSync(path.join(tmp, ARMS), "utf8")).toBe(before);

  const compact = await callJson(routeControl, { action: "compact", dryRun: false });
  expect(compact["code"]).toBe("corrupt");
  expect(readFileSync(path.join(tmp, ARMS), "utf8")).toBe(before);

  // Status still answers, and names the state rather than saying "not frozen".
  const status = await callJson(routeControl, { action: "status" });
  expect(at(status, "freeze", "state")).toBe("corrupt");
});

// ---------------------------------------------------------------------------
// RouteControl — promote
// ---------------------------------------------------------------------------

test("RouteControl refuses an ungated real promotion and names the gate it did not resolve", async () => {
  seedArms();
  const before = readFileSync(path.join(tmp, ARMS), "utf8");
  const r = await callJson(routeControl, { action: "promote", dryRun: false });
  expect(r["status"]).toBe("refused");
  expect(String(r["reason"])).toContain("acceptUngated");
  expect(String(r["reason"])).toContain("as-declared");
  expect(readFileSync(path.join(tmp, ARMS), "utf8")).toBe(before);
});

test("RouteControl promote previews with the same fold it performs, then folds once", async () => {
  seedArms();
  const before = readFileSync(path.join(tmp, ARMS), "utf8");
  const preview = await callJson(routeControl, { action: "promote" });
  expect(preview["status"]).toBe("preview");
  expect(preview["changed"]).toBe(false);
  const previewed = preview["linesFolded"] as number;
  expect(previewed).toBeGreaterThan(0);
  // A preview that wrote would be the bug this default exists to stop.
  expect(readFileSync(path.join(tmp, ARMS), "utf8")).toBe(before);

  const real = await callJson(routeControl, {
    action: "promote",
    dryRun: false,
    acceptUngated: true,
  });
  expect(real["status"]).toBe("ok");
  expect(real["changed"]).toBe(true);
  // The real fold moved exactly what the preview said it would.
  expect(real["linesFolded"]).toBe(previewed);
  const after = readFileSync(path.join(tmp, ARMS), "utf8");
  expect(after).not.toBe(before);
  // The PRIMARY side of the audition stayed in the lane: its arm already
  // recorded the turn live, and its lane quality is a pairwise verdict.
  const promotions = at(real, "promotions", "shown") as Json[];
  console.log(`PROMOTIONS ${JSON.stringify(promotions.map((p) => [p["from"], p["model"]]))}`);
  expect(promotions.some((p) => p["from"] === "shadow:hard" && p["model"] === "strong")).toBe(
    false,
  );
  expect(promotions.some((p) => p["from"] === "shadow:hard" && p["model"] === "audition")).toBe(
    true,
  );

  // Idempotent: a second promotion folds nothing and says why.
  const again = await callJson(routeControl, {
    action: "promote",
    dryRun: false,
    acceptUngated: true,
  });
  expect(again["linesFolded"]).toBe(0);
  expect(again["alreadyPromoted"]).toBeGreaterThan(0);
  expect(again["changed"]).toBe(false);
  expect(readFileSync(path.join(tmp, ARMS), "utf8")).toBe(after);
});

// ---------------------------------------------------------------------------
// RouteControl — compact, and the leaf paths a rename lands on
// ---------------------------------------------------------------------------

test("RouteControl compact previews, then rewrites the store without changing an arm", async () => {
  seedArms();
  const statBefore = await callJson(routeControl, { action: "status" });
  const armsBefore = at(statBefore, "arms", "shown") as Json[];
  const bytesBefore = readFileSync(path.join(tmp, ARMS), "utf8").length;

  const preview = await callJson(routeControl, { action: "compact" });
  expect(preview["status"]).toBe("preview");
  expect(readFileSync(path.join(tmp, ARMS), "utf8").length).toBe(bytesBefore);

  const real = await callJson(routeControl, { action: "compact", dryRun: false });
  expect(real["changed"]).toBe(true);
  const lines = readFileSync(path.join(tmp, ARMS), "utf8").trim().split("\n");
  // One aggregate line per arm, where there were seventeen delta lines.
  expect(lines.length).toBe(armsBefore.length);

  const statAfter = await callJson(routeControl, { action: "status" });
  const armsAfter = at(statAfter, "arms", "shown") as Json[];
  expect(armsAfter.map((a) => [a["routeKey"], a["model"], a["n"]])).toEqual(
    armsBefore.map((a) => [a["routeKey"], a["model"], a["n"]]),
  );
});

test("RouteControl refuses when the rename target of a compaction is a link out of the workspace", async () => {
  seedArms();
  const victim = outsideDir();
  // `compact()` writes `arms.jsonl.tmp` and renames it ON TOP of the store.
  // A dangling link at that name is created by the write, so `stat` reporting
  // it absent is exactly what makes it dangerous.
  symlinkSync(path.join(victim, "stolen.jsonl"), path.join(tmp, `${ARMS}.tmp`));
  const before = readFileSync(path.join(tmp, ARMS), "utf8");
  const r = await callJson(routeControl, { action: "compact", dryRun: false });
  expect(r["status"]).toBe("refused");
  expect(String(r["reason"])).toContain("outside the workspace root");
  expect(existsSync(path.join(victim, "stolen.jsonl"))).toBe(false);
  expect(readFileSync(path.join(tmp, ARMS), "utf8")).toBe(before);
});

test("RouteControl refuses a routing directory that is a symlink out of the workspace", async () => {
  const elsewhere = outsideDir();
  mkdirSync(path.join(tmp, STATE), { recursive: true });
  symlinkSync(elsewhere, path.join(tmp, STATE, "routing"));
  const r = await callJson(routeControl, { action: "promote", dryRun: false, acceptUngated: true });
  expect(r["status"]).toBe("refused");
  expect(String(r["reason"])).toContain("outside the workspace root");
  expect(readdirSync(elsewhere)).toEqual([]);
});

test("RouteControl on a harness directory that does not exist is missing, not empty", async () => {
  const r = await callJson(routeControl, { action: "status", dir: "nowhere" });
  expect(r["status"]).toBe("refused");
  expect(r["code"]).toBe("missing");
});

// ---------------------------------------------------------------------------
// ExperimentLedger
// ---------------------------------------------------------------------------

const EXP = path.join(STATE, "experiments");

function assignment(): void {
  mkdirSync(path.join(tmp, EXP), { recursive: true });
  writeFileSync(
    path.join(tmp, EXP, "ramp.assignment.json"),
    `${JSON.stringify(
      {
        name: "ramp",
        variants: [
          { version: "v1", weight: 50 },
          { version: "v2", weight: 50 },
        ],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      null,
      2,
    )}\n`,
  );
}

test("ExperimentLedger lists nothing on a harness with no experiments, and says the dir is absent", async () => {
  mkdirSync(path.join(tmp, STATE), { recursive: true });
  const r = await callJson(experimentLedger, { action: "list" });
  expect(r["status"]).toBe("ok");
  expect(r["exists"]).toBe(false);
  expect(at(r, "experiments", "total")).toBe(0);
});

test("ExperimentLedger assign returns canary-controller's own bucket for the key", async () => {
  assignment();
  const r = await callJson(experimentLedger, {
    action: "assign",
    name: "ramp",
    requestKey: "tenant-a",
  });
  expect(r["status"]).toBe("ok");
  const bucket = r["bucket"] as number;
  expect(bucket).toBeGreaterThanOrEqual(0);
  expect(bucket).toBeLessThan(100);
  expect(r["version"]).toBe(bucket < 50 ? "v1" : "v2");
  // The same key lands on the same side every time, in every process.
  const again = await callJson(experimentLedger, {
    action: "assign",
    name: "ramp",
    requestKey: "tenant-a",
  });
  expect(again["bucket"]).toBe(bucket);
  expect(String(r["note"])).toContain("CanaryController.route()");
});

test("ExperimentLedger refuses to assign without a manifest, because a concluded ramp removes it", async () => {
  mkdirSync(path.join(tmp, EXP), { recursive: true });
  const r = await callJson(experimentLedger, {
    action: "assign",
    name: "ramp",
    requestKey: "tenant-a",
  });
  expect(r["status"]).toBe("refused");
  expect(r["code"]).toBe("missing");
  expect(String(r["reason"])).toContain("concluded ramp removes it");
});

test("ExperimentLedger record previews without appending, then appends exactly one line", async () => {
  assignment();
  const ledger = path.join(tmp, EXP, "ramp.jsonl");
  const preview = await callJson(experimentLedger, {
    action: "record",
    name: "ramp",
    version: "v1",
    outcome: "success",
  });
  expect(preview["status"]).toBe("preview");
  expect(existsSync(ledger)).toBe(false);

  const real = await callJson(experimentLedger, {
    action: "record",
    name: "ramp",
    version: "v1",
    outcome: "success",
    score: 0.8,
    source: "eval",
    requestKey: "s1",
    dryRun: false,
  });
  expect(real["changed"]).toBe(true);
  const lines = readFileSync(ledger, "utf8").trim().split("\n");
  expect(lines.length).toBe(1);
  const written = JSON.parse(lines[0] as string) as Json;
  expect(written["version"]).toBe("v1");
  expect(written["score"]).toBe(0.8);
});

test("ExperimentLedger refuses a version the assignment does not list, so a typo is not a third arm", async () => {
  assignment();
  const r = await callJson(experimentLedger, {
    action: "record",
    name: "ramp",
    version: "v3",
    outcome: "success",
    dryRun: false,
  });
  expect(r["status"]).toBe("refused");
  expect(String(r["reason"])).toContain("phantom variant");
  expect(existsSync(path.join(tmp, EXP, "ramp.jsonl"))).toBe(false);

  const forced = await callJson(experimentLedger, {
    action: "record",
    name: "ramp",
    version: "v3",
    outcome: "success",
    allowUnknownVersion: true,
    dryRun: false,
  });
  expect(forced["changed"]).toBe(true);
});

test("ExperimentLedger writes under the SANITIZED filename and nothing lands outside", async () => {
  mkdirSync(path.join(tmp, EXP), { recursive: true });
  const r = await callJson(experimentLedger, {
    action: "record",
    name: "../evil",
    version: "v1",
    outcome: "success",
    dryRun: false,
  });
  expect(r["status"]).toBe("ok");
  // The file the caller's name became lives inside the experiments dir.
  const inside = readdirSync(path.join(tmp, EXP));
  console.log(`SANITIZED ${JSON.stringify(inside)}`);
  expect(inside.some((f) => f.endsWith(".jsonl"))).toBe(true);
  expect(inside.every((f) => !f.includes("/"))).toBe(true);
  // And nothing was created beside the experiments directory.
  expect(existsSync(path.join(tmp, STATE, "evil.jsonl"))).toBe(false);
  expect(existsSync(path.join(tmp, "evil.jsonl"))).toBe(false);
});

test("ExperimentLedger refuses an experiment name with no filesystem-safe character", async () => {
  mkdirSync(path.join(tmp, EXP), { recursive: true });
  const r = await callJson(experimentLedger, { action: "tally", name: "///" });
  expect(r["status"]).toBe("refused");
  expect(r["code"]).toBe("bad-input");
});

test("ExperimentLedger tally on an absent ledger is not a tie", async () => {
  assignment();
  const r = await callJson(experimentLedger, { action: "tally", name: "ramp" });
  expect(r["status"]).toBe("ok");
  expect(r["exists"]).toBe(false);
  expect(at(r, "verdict", "verdict")).toBe("not-comparable");
  expect(String(at(r, "verdict", "reason"))).toContain("no ledger file");
});

test("ExperimentLedger tally collapses re-run eval measurements before it folds", async () => {
  assignment();
  // Four ramp steps grading the same two samples against v1 — the shape that
  // otherwise reports n=8 and halves the interval.
  for (let step = 0; step < 4; step += 1) {
    for (const sampleId of ["s1", "s2"]) {
      await callJson(experimentLedger, {
        action: "record",
        name: "ramp",
        version: "v1",
        outcome: "success",
        score: 0.9,
        source: "eval",
        requestKey: sampleId,
        dryRun: false,
      });
    }
  }
  const r = await callJson(experimentLedger, { action: "tally", name: "ramp" });
  expect(
    readFileSync(path.join(tmp, EXP, "ramp.jsonl"), "utf8")
      .trim()
      .split("\n").length,
  ).toBe(8);
  expect(r["collapsedRepeats"]).toBe(6);
  const v1 = (at(r, "variants", "shown") as Json[])[0] as Json;
  expect(v1["n"]).toBe(2);
  expect(String(r["dedupeNote"])).toContain("inflated n");
});

test("ExperimentLedger names a winner only when a rank test separates the versions", async () => {
  assignment();
  const record = async (version: string, score: number, key: string) =>
    callJson(experimentLedger, {
      action: "record",
      name: "ramp",
      version,
      outcome: "success",
      score,
      source: "serving",
      requestKey: key,
      dryRun: false,
    });
  // Two observations a side: a clear gap in the means, nowhere near enough
  // evidence for the test.
  await record("v1", 0.1, "a");
  await record("v1", 0.2, "b");
  await record("v2", 0.9, "c");
  await record("v2", 0.95, "d");
  const thin = await callJson(experimentLedger, { action: "tally", name: "ramp" });
  expect(at(thin, "verdict", "verdict")).toBe("undecided");
  expect(at(thin, "verdict", "winner")).toBeNull();

  // Ten more a side, same direction: now it separates.
  for (let i = 0; i < 10; i += 1) {
    await record("v1", 0.1 + i / 1000, `v1-${i}`);
    await record("v2", 0.9 + i / 1000, `v2-${i}`);
  }
  const thick = await callJson(experimentLedger, { action: "tally", name: "ramp" });
  console.log(`VERDICT ${JSON.stringify(at(thick, "verdict", "reason"))}`);
  expect(at(thick, "verdict", "verdict")).toBe("winner");
  expect(at(thick, "verdict", "winner")).toBe("v2");
  expect(String(at(thick, "verdict", "reason"))).toContain("Mann-Whitney");
}, 20_000);

// ---------------------------------------------------------------------------
// FlywheelStatus
// ---------------------------------------------------------------------------

test("FlywheelStatus on an unscaffolded harness reports no runs and names what that means", async () => {
  mkdirSync(path.join(tmp, STATE), { recursive: true });
  const r = await callJson(flywheelStatus, {});
  expect(r["status"]).toBe("ok");
  expect(at(r, "flywheelDir", "state")).toBe("absent");
  expect(at(r, "runs", "total")).toBe(0);
  expect(at(r, "workflows", "scaffoldedCount")).toBe(0);
  expect(String(r["note"])).toContain("never run here");
  // An absent state.json says nothing on its own, and the result says so.
  expect(at(r, "stateJson", "state")).toBe("absent");
  expect(String(at(r, "stateJson", "note"))).toContain("read `runs` instead");
});

test("FlywheelStatus enumerates run directories with the stages they hold", async () => {
  for (const stage of ["before", "after", "optimize"]) {
    mkdirSync(path.join(tmp, STATE, "flywheel", "fly_abc", stage), { recursive: true });
  }
  mkdirSync(path.join(tmp, STATE, "flywheel", "fly_def", "before"), { recursive: true });
  const r = await callJson(flywheelStatus, {});
  const runs = at(r, "runs", "shown") as Json[];
  expect(runs.map((x) => x["runId"])).toEqual(["fly_abc", "fly_def"]);
  expect(runs[0]?.["stages"]).toEqual(["before", "after", "optimize"]);
  expect(runs[1]?.["stages"]).toEqual(["before"]);
  // The verdict inside those artifacts is not read, and the result names what
  // reads it instead of implying the run passed.
  expect(JSON.stringify(r["unavailable"])).toContain("@crewhaus/eval-report");
  expect(JSON.stringify(r["unavailable"])).toContain("@crewhaus/spec-patch");
});

test("FlywheelStatus lists a workflow it does not recognise rather than calling it absent", async () => {
  mkdirSync(path.join(tmp, STATE), { recursive: true });
  mkdirSync(path.join(tmp, ".github", "workflows"), { recursive: true });
  writeFileSync(path.join(tmp, ".github", "workflows", "crewhaus-flywheel.yml"), "on: {}\n");
  writeFileSync(path.join(tmp, ".github", "workflows", "our-nightly.yml"), "on: {}\n");
  const r = await callJson(flywheelStatus, {});
  const entries = at(r, "workflows", "entries", "shown") as Json[];
  expect(entries.map((e) => e["name"])).toEqual(["crewhaus-flywheel.yml", "our-nightly.yml"]);
  expect(entries[0]?.["scaffoldedBy"]).toBe("crewhaus flywheel init");
  expect(entries[1]?.["scaffoldedBy"]).toBeNull();
  expect(at(r, "workflows", "scaffoldedCount")).toBe(1);
});

test("FlywheelStatus reports an unlistable workflows directory as unreadable, not unscaffolded", async () => {
  mkdirSync(path.join(tmp, STATE), { recursive: true });
  mkdirSync(path.join(tmp, ".github"), { recursive: true });
  // A FILE where the workflows directory should be: the name resolves, so
  // containment passes and the LISTING is what fails. `readdir` answering
  // ENOTDIR must not come back as "no workflows here".
  writeFileSync(path.join(tmp, ".github", "workflows"), "not a directory\n");
  const r = await callJson(flywheelStatus, {});
  expect(r["status"]).toBe("refused");
  expect(r["code"]).toBe("unreadable");
  expect(String(r["reason"])).toContain("not an empty directory");
});

test("FlywheelStatus refuses a workflows directory it cannot resolve, and does not call it unscaffolded", async () => {
  if (!canTestUnreadable) {
    console.log("SKIP unresolvable-workflows: this process can read any directory (uid 0)");
    return;
  }
  mkdirSync(path.join(tmp, STATE), { recursive: true });
  mkdirSync(path.join(tmp, ".github", "workflows"), { recursive: true });
  chmodSync(path.join(tmp, ".github", "workflows"), 0o000);
  const r = await callJson(flywheelStatus, {});
  expect(r["status"]).toBe("refused");
  expect(r["code"]).toBe("unreadable");
  // Either stage may catch it — see the note on the RouteControl case above.
  const reason = String(r["reason"]);
  expect(reason).toMatch(/could not (resolve|be read|be listed)/);
  expect(reason).toMatch(/not an escape|not an empty|not unscaffolded/);
});

test("FlywheelStatus flags the shadowing case and refuses to guess the registry fact", async () => {
  mkdirSync(path.join(tmp, STATE), { recursive: true });
  mkdirSync(path.join(tmp, "eval"), { recursive: true });
  writeFileSync(path.join(tmp, "eval", "dataset.jsonl"), '{"input":"x"}\n');
  const r = await callJson(flywheelStatus, { specName: "demo" });
  expect(at(r, "datasetPrecedence", "withoutDatasetFlag")).toBe("convention");
  expect(at(r, "datasetPrecedence", "wouldShadowRatings")).toBe(true);
  expect(at(r, "datasetPrecedence", "ratingsRegistered")).toBe("unknown");
  expect(String(at(r, "datasetPrecedence", "ruleOwner"))).toContain("resolveFlywheelData");

  // With no spec name the ratings reference is unnameable, and is reported as
  // such rather than guessed from the directory name.
  const bare = await callJson(flywheelStatus, {});
  expect(at(bare, "datasetPrecedence", "ratingsRef")).toBeNull();
  expect(String(at(bare, "datasetPrecedence", "reason"))).toContain("@crewhaus/spec");
});

test("FlywheelStatus refuses a conventional dataset path that is a link out of the workspace", async () => {
  mkdirSync(path.join(tmp, STATE), { recursive: true });
  const elsewhere = outsideDir();
  mkdirSync(path.join(tmp, "eval"), { recursive: true });
  symlinkSync(path.join(elsewhere, "dataset.jsonl"), path.join(tmp, "eval", "dataset.jsonl"));
  const r = await callJson(flywheelStatus, { specName: "demo" });
  expect(r["status"]).toBe("refused");
  expect(String(r["reason"])).toContain("outside the workspace root");
});

// ---------------------------------------------------------------------------
// WatchmeReport
// ---------------------------------------------------------------------------

function watchme() {
  return openWatchmeStore(path.join(tmp, STATE), { specName: "demo" });
}

function observation(sessionId: string, turns: number, over: Record<string, unknown> = {}) {
  return {
    v: 1 as const,
    sessionId,
    specName: "demo",
    target: "cli",
    ts: 1_700_000_000_000,
    turnCount: turns,
    joinConfidence: "exact" as const,
    models: [
      {
        wire: "m",
        provider: "p",
        turns,
        usage: { in: 100, out: 20, cacheRead: 0, cacheCreate: 0 },
        costUsdMicros: 500,
      },
    ],
    toolStats: [{ name: "Read", calls: 10, errors: 1 }],
    intentKeys: ["k1"],
    feedback: { up: 3, down: 1 },
    ...over,
  };
}

test("WatchmeReport on an empty store is ok, and the state file is reported absent", async () => {
  mkdirSync(path.join(tmp, STATE), { recursive: true });
  const r = await callJson(watchmeReport, {});
  expect(r["status"]).toBe("ok");
  expect(at(r, "state", "probe", "state")).toBe("absent");
  expect(at(r, "state", "watching")).toBe(false);
  expect(at(r, "observations", "rawSessions")).toBe(0);
});

test("WatchmeReport reports a torn state.json as unreadable, never as never-watched", async () => {
  const store = watchme();
  store.setState({ watching: true });
  writeFileSync(path.join(tmp, STATE, "watchme", "state.json"), "{ truncated");
  const r = await callJson(watchmeReport, {});
  expect(at(r, "state", "probe", "state")).toBe("unreadable");
  // Assert the REASON. The store falls back to its default here, which reads
  // as `watching: false` — the opposite of what was last set.
  expect(String(at(r, "state", "probe", "detail"))).toContain("never watched anything");
});

test("WatchmeReport keeps the three window outcomes apart and does not absorb an unknown one", async () => {
  const store = watchme();
  store.setState({
    watching: true,
    windows: {
      "watchme:demo:1": "ok",
      "watchme:demo:2": "model_refused_unpriced",
      "watchme:demo:3": "model_failed",
      "watchme:demo:4": "model_refused",
    } as never,
  });
  const r = await callJson(watchmeReport, {});
  expect(at(r, "windows", "ok")).toBe(1);
  expect(at(r, "windows", "model_refused_unpriced")).toBe(1);
  expect(at(r, "windows", "model_failed")).toBe(1);
  expect(at(r, "windows", "unrecognised")).toEqual([
    { windowKey: "watchme:demo:4", value: "model_refused" },
  ]);
});

test("WatchmeReport rolls up raw lines and aggregates, with every rate carrying an interval", async () => {
  const store = watchme();
  store.appendObservation(observation("sess_1", 4) as never);
  store.appendObservation(observation("sess_2", 6) as never);
  const r = await callJson(watchmeReport, {});
  expect(at(r, "observations", "rawSessions")).toBe(2);
  const rows = at(r, "observations", "fromRaw", "shown") as Json[];
  expect(rows[0]?.["key"]).toBe("demo|cli");
  expect(rows[0]?.["sessions"]).toBe(2);
  expect(rows[0]?.["toolCalls"]).toBe(20);
  expect(at(rows[0], "toolErrorRate", "successes")).toBe(2);
  expect(at(rows[0], "toolErrorRate", "interval")).not.toBeNull();
  // No session carried a quality score; that is null, not zero.
  expect(at(rows[0], "quality", "mean")).toBeNull();
  expect(at(rows[0], "quality", "n")).toBe(0);
  // Turns per session is a number an operator reads, so it carries its spread:
  // 4 and 6 turns is mean 5 with an interval, not a bare 5.
  expect(at(rows[0], "turns", "mean")).toBe(5);
  expect(at(rows[0], "turns", "interval")).not.toBeNull();

  // After compaction the same numbers come back through the aggregate half.
  store.compact();
  const compacted = await callJson(watchmeReport, {});
  expect(at(compacted, "observations", "rawSessions")).toBe(0);
  const aggRows = at(compacted, "observations", "fromAggregates", "shown") as Json[];
  expect(aggRows[0]?.["sessions"]).toBe(2);
  expect(aggRows[0]?.["toolErrors"]).toBe(2);
});

test("WatchmeReport counts a STAGED fed key as the turn it names, not as a different one", async () => {
  const store = watchme();
  const judgment = (turnNumber: number) => ({
    v: 1 as const,
    sessionId: "sess_1",
    turnNumber,
    model: "m",
    judgeModel: "j",
    score: 0.8,
    rationale: "",
    ts: 1_700_000_000_000,
  });
  store.appendJudgment(judgment(4) as never);
  store.appendJudgment(judgment(5) as never);
  // Turn 4 was fed as a hybrid turn (two stages); turn 5 has not been fed.
  store.setState({ fedRoutingKeys: ["sess_1#4#draft", "sess_1#4#escalate", "sess_9#1"] });
  const r = await callJson(watchmeReport, {});
  expect(at(r, "judgments", "turns")).toBe(2);
  // Two stage keys and one plain key collapse to two distinct turns.
  expect(at(r, "judgments", "fedTurns")).toBe(2);
  // Only turn 5 is pending. A reader that compared spellings would say two.
  expect(at(r, "judgments", "pendingFeedTurns")).toBe(1);
  expect(at(r, "judgments", "unparsedFedKeys")).toBe(0);
});

test("WatchmeReport counts a fed key it cannot parse rather than silently dropping it", async () => {
  const store = watchme();
  store.setState({ fedRoutingKeys: ["not-a-key", "sess_1#2"] });
  const r = await callJson(watchmeReport, {});
  expect(at(r, "judgments", "fedTurns")).toBe(1);
  expect(at(r, "judgments", "unparsedFedKeys")).toBe(1);
});

test("WatchmeReport reports the quality lane from the routing store, marked observe-only", async () => {
  watchme().setState({ watching: true });
  seedArms();
  const r = await callJson(watchmeReport, {});
  expect(at(r, "routing", "read")).toBe(true);
  const arms = at(r, "routing", "qualityArms", "shown") as Json[];
  expect(arms.map((a) => a["routeKey"])).toEqual(["q:hard"]);
  expect(arms[0]?.["auditsRouteKey"]).toBe("hard");
  expect(String(at(r, "routing", "note"))).toContain("observe-only");
});

test("WatchmeReport says the routing store could not be read, never that there is no quality", async () => {
  watchme().setState({ watching: true });
  // A directory where the arms file should be: containment passes, the read
  // fails. An empty `qualityArms` table here would read as "no quality
  // signal", which is the opposite of what happened.
  mkdirSync(path.join(tmp, ARMS), { recursive: true });
  const r = await callJson(watchmeReport, {});
  // The watchme half still answers; only the routing half degrades.
  expect(r["status"]).toBe("ok");
  expect(at(r, "state", "watching")).toBe(true);
  expect(at(r, "routing", "read")).toBe(false);
  // `loadArms`' own reason, carried through instead of being flattened into
  // an empty table.
  expect(String(at(r, "routing", "reason"))).toContain("not an empty scoreboard");
});

test("WatchmeReport degrades the routing half when the scoreboard path cannot be resolved", async () => {
  if (!canTestUnreadable) {
    console.log("SKIP unresolvable-routing: this process can read any file (uid 0)");
    return;
  }
  watchme().setState({ watching: true });
  seedArms();
  chmodSync(path.join(tmp, ARMS), 0o000);
  const r = await callJson(watchmeReport, {});
  expect(r["status"]).toBe("ok");
  expect(at(r, "routing", "read")).toBe(false);
  // Either stage may catch it — see the note on the RouteControl case above.
  expect(String(at(r, "routing", "reason"))).toMatch(
    /could not (be resolved|resolve|be read|be listed)/,
  );
});

test("WatchmeReport can be asked not to open the routing store at all, and says which it is", async () => {
  mkdirSync(path.join(tmp, STATE), { recursive: true });
  const r = await callJson(watchmeReport, { includeRouting: false });
  expect(at(r, "routing", "read")).toBe(false);
  expect(String(at(r, "routing", "reason"))).toContain("includeRouting");
});

test("WatchmeReport refuses a watchme directory that is a symlink out of the workspace", async () => {
  const elsewhere = outsideDir();
  mkdirSync(path.join(tmp, STATE), { recursive: true });
  symlinkSync(elsewhere, path.join(tmp, STATE, "watchme"));
  const r = await callJson(watchmeReport, {});
  expect(r["status"]).toBe("refused");
  expect(String(r["reason"])).toContain("outside the workspace root");
});

test("WatchmeReport names the model-backed surface it is not", async () => {
  mkdirSync(path.join(tmp, STATE), { recursive: true });
  const r = await callJson(watchmeReport, {});
  expect(JSON.stringify(r["unavailable"])).toContain("synthesize");
  expect(JSON.stringify(r["unavailable"])).toContain("--feed-routing");
});

// ---------------------------------------------------------------------------
// the paths a listing hands back
// ---------------------------------------------------------------------------

test("RouteControl compact on a harness that has never routed creates nothing", async () => {
  mkdirSync(path.join(tmp, STATE), { recursive: true });
  const r = await callJson(routeControl, { action: "compact", dryRun: false });
  expect(r["status"]).toBe("ok");
  expect(r["changed"]).toBe(false);
  expect(String(r["note"])).toContain("Nothing was created");
  // `compact()` would otherwise mkdir the routing directory and write an
  // empty arms file onto a harness that has never routed.
  expect(existsSync(path.join(tmp, STATE, "routing"))).toBe(false);
});

test("RouteControl refuses a policyVersion that is only whitespace, rather than throwing", async () => {
  mkdirSync(path.join(tmp, STATE), { recursive: true });
  // `z.string().min(1)` admits " "; `writeRouteFreeze` throws on it. The
  // refusal is on the PARSED (trimmed) value, which is what the library acts on.
  const r = await callJson(routeControl, {
    action: "freeze",
    policyVersion: "   ",
    dryRun: false,
  });
  expect(r["status"]).toBe("refused");
  expect(r["code"]).toBe("bad-input");
  expect(existsSync(path.join(tmp, STATE, "routing", "freeze.json"))).toBe(false);
});

test("FlywheelStatus lists a run directory it will not follow rather than dropping it", async () => {
  const elsewhere = outsideDir();
  mkdirSync(path.join(tmp, STATE, "flywheel", "fly_ok", "before"), { recursive: true });
  symlinkSync(elsewhere, path.join(tmp, STATE, "flywheel", "fly_evil"));
  const r = await callJson(flywheelStatus, {});
  expect(r["status"]).toBe("ok");
  const runs = at(r, "runs", "shown") as Json[];
  expect(runs.map((x) => x["runId"])).toEqual(["fly_ok"]);
  // Reported, not silently dropped: a harness with a run this tool will not
  // open still has that run.
  expect(r["uncontainedRuns"]).toEqual(["fly_evil"]);
  expect(readdirSync(elsewhere)).toEqual([]);
});

test("ExperimentLedger lists a ledger it will not open rather than dropping it", async () => {
  const elsewhere = outsideDir();
  mkdirSync(path.join(tmp, EXP), { recursive: true });
  writeFileSync(path.join(tmp, EXP, "good.jsonl"), "");
  symlinkSync(path.join(elsewhere, "stolen.jsonl"), path.join(tmp, EXP, "evil.jsonl"));
  const r = await callJson(experimentLedger, { action: "list" });
  const rows = at(r, "experiments", "shown") as Json[];
  expect(rows.map((x) => x["name"])).toEqual(["good"]);
  expect(r["uncontained"]).toEqual(["evil"]);
  expect(existsSync(path.join(elsewhere, "stolen.jsonl"))).toBe(false);
});

test("RouteControl previews and reports the policyVersion the library will store, not the spelling", async () => {
  mkdirSync(path.join(tmp, STATE), { recursive: true });
  // `writeRouteFreeze` trims before it writes. A preview that promised the
  // untrimmed spelling would be promising a marker that never lands.
  const preview = await callJson(routeControl, { action: "freeze", policyVersion: "  pv-9  " });
  expect(preview["wouldPin"]).toBe("pv-9");
  const real = await callJson(routeControl, {
    action: "freeze",
    policyVersion: "  pv-9  ",
    dryRun: false,
  });
  expect(at(real, "pinned", "policyVersion")).toBe("pv-9");
  const onDisk = JSON.parse(
    readFileSync(path.join(tmp, STATE, "routing", "freeze.json"), "utf8"),
  ) as Json;
  expect(onDisk["policyVersion"]).toBe("pv-9");
});

test("ExperimentLedger tally on a ledger it cannot read refuses, rather than reporting no measurements", async () => {
  assignment();
  // A directory where the ledger should be: `readExperimentOutcomes` catches
  // the EISDIR and returns no records, which would read as "this experiment
  // was never measured".
  mkdirSync(path.join(tmp, EXP, "ramp.jsonl"), { recursive: true });
  const r = await callJson(experimentLedger, { action: "tally", name: "ramp" });
  expect(r["status"]).toBe("refused");
  expect(r["code"]).toBe("unreadable");
  expect(String(r["reason"])).toContain("never measured");
});

test("ExperimentLedger tells a corrupt assignment manifest apart from an absent one", async () => {
  mkdirSync(path.join(tmp, EXP), { recursive: true });
  writeFileSync(path.join(tmp, EXP, "ramp.assignment.json"), "{ truncated");
  const assign = await callJson(experimentLedger, {
    action: "assign",
    name: "ramp",
    requestKey: "tenant-a",
  });
  expect(assign["status"]).toBe("refused");
  expect(assign["code"]).toBe("corrupt");
  expect(String(assign["reason"])).toContain("not an absent manifest");

  // And a record cannot check the version against it, so it refuses too —
  // unless the caller says to record anyway.
  const rec = await callJson(experimentLedger, {
    action: "record",
    name: "ramp",
    version: "v1",
    outcome: "success",
    dryRun: false,
  });
  expect(rec["code"]).toBe("corrupt");
  expect(existsSync(path.join(tmp, EXP, "ramp.jsonl"))).toBe(false);

  const forced = await callJson(experimentLedger, {
    action: "record",
    name: "ramp",
    version: "v1",
    outcome: "success",
    allowUnknownVersion: true,
    dryRun: false,
  });
  expect(forced["changed"]).toBe(true);
  expect(forced["manifest"]).toBe("unreadable");
});

test("ExperimentLedger refuses a score that the ledger reader would silently drop", async () => {
  assignment();
  // The schema says `.finite()` …
  expect(
    experimentLedger.inputSchema.safeParse({
      action: "record",
      name: "ramp",
      version: "v1",
      outcome: "success",
      score: Number.POSITIVE_INFINITY,
    }).success,
  ).toBe(false);
  // … and `execute` checks it again on the value it would write, because the
  // schema is advisory and the append would otherwise succeed with a number
  // no tally will ever see.
  const r = await callJson(experimentLedger, {
    action: "record",
    name: "ramp",
    version: "v1",
    outcome: "success",
    score: Number.POSITIVE_INFINITY,
    dryRun: false,
  });
  expect(r["status"]).toBe("refused");
  expect(String(r["reason"])).toContain("finite");
  expect(existsSync(path.join(tmp, EXP, "ramp.jsonl"))).toBe(false);
});

test("WatchmeReport counts observation lines it could not parse rather than skipping them silently", async () => {
  const store = watchme();
  store.appendObservation(observation("sess_1", 4) as never);
  // Half the file overwritten with garbage, the shape a crashed writer or a
  // truncated sync leaves. The store skips those lines; a report that never
  // mentioned them would describe a small healthy ledger.
  writeFileSync(
    path.join(tmp, STATE, "watchme", "observations.jsonl"),
    `${readFileSync(path.join(tmp, STATE, "watchme", "observations.jsonl"), "utf8")}not json\n{"also\n`,
  );
  const r = await callJson(watchmeReport, {});
  expect(at(r, "observations", "rawSessions")).toBe(1);
  expect(at(r, "observations", "file", "lines")).toBe(3);
  expect(at(r, "observations", "file", "unparseable")).toBe(2);
});

// ---------------------------------------------------------------------------
// the adversarial pass — defects found by attacking the built package
// ---------------------------------------------------------------------------

/**
 * Seed the store with a `q:` lane arm and promote it, leaving the live arm it
 * audits holding ONLY a quality back-fill: `n: 0`, `ungraded: 0`, judged
 * quality. That is the arm `Scoreboard.compact()` deletes.
 */
function seedPromotedQualityOnlyArm(): void {
  const board = openScoreboard(path.join(tmp, STATE));
  board.record("q:hard", "strong", 0.8, { success: true, quality: 0.9 });
  board.record("q:hard", "strong", 0.6, { success: true, quality: 0.7 });
  const folded = promoteLanes(path.join(tmp, STATE), {});
  if (folded.lines === 0) throw new Error("fixture did not fold — the lane was not promoted");
}

test("RouteControl compact NAMES the arms it would delete, and the preview is the real selection", async () => {
  seedPromotedQualityOnlyArm();
  const before = await callJson(routeControl, { action: "status" });
  const armsBefore = (at(before, "arms", "shown") as Json[]).map((a) => [
    a["routeKey"],
    a["model"],
  ]);
  // The back-fill really is there: a live arm with no reward observation.
  expect(armsBefore).toContainEqual(["hard", "strong"]);

  const preview = await callJson(routeControl, { action: "compact" });
  expect(preview["status"]).toBe("preview");
  const previewDropped = (at(preview, "armsDropped", "shown") as Json[]).map((a) => [
    a["routeKey"],
    a["model"],
  ]);
  expect(previewDropped).toEqual([["hard", "strong"]]);
  expect(String(preview["note"])).toContain("acceptArmLoss");

  // Without the flag the real run REFUSES, and the store is untouched.
  const bytes = readFileSync(path.join(tmp, ARMS), "utf8");
  const refused = await callJson(routeControl, { action: "compact", dryRun: false });
  expect(refused["status"]).toBe("refused");
  expect(String(refused["reason"])).toContain("judged quality");
  expect(readFileSync(path.join(tmp, ARMS), "utf8")).toBe(bytes);

  // With it, the compaction runs — and the arms that actually disappeared are
  // EXACTLY the ones the preview named. This is the drift pin: the predicate
  // restates `compact()`'s own `n > 0 || ungraded > 0` filter, so it is
  // checked against the real `compact()` rather than against itself.
  const real = await callJson(routeControl, {
    action: "compact",
    dryRun: false,
    acceptArmLoss: true,
  });
  expect(real["changed"]).toBe(true);
  const after = await callJson(routeControl, { action: "status" });
  const armsAfter = (at(after, "arms", "shown") as Json[]).map((a) => [a["routeKey"], a["model"]]);
  const vanished = armsBefore.filter((b) => !armsAfter.some((a) => a[0] === b[0] && a[1] === b[1]));
  expect(vanished).toEqual(previewDropped);
});

test("RouteControl compact on an ordinary store drops nothing and does not ask for a flag", async () => {
  seedArms();
  const preview = await callJson(routeControl, { action: "compact" });
  expect(at(preview, "armsDropped", "total")).toBe(0);
  expect(String(preview["note"])).not.toContain("acceptArmLoss");
  const real = await callJson(routeControl, { action: "compact", dryRun: false });
  expect(real["status"]).toBe("ok");
  expect(real["acceptedArmLoss"]).toBe(false);
});

test("RouteControl promote that only STAMPS lane lines still reports the store as changed", async () => {
  // A `q:` lane line carrying no judged quality folds nothing — but it is
  // stamped `pm:1` and the file is rewritten, and no later promotion will
  // revisit it. `linesFolded: 0` must not read as "nothing happened".
  const board = openScoreboard(path.join(tmp, STATE));
  board.record("q:hard", "strong", 0.5, { success: true });
  board.record("q:hard", "strong", 0.6, { success: true });
  const before = readFileSync(path.join(tmp, ARMS), "utf8");

  const r = await callJson(routeControl, {
    action: "promote",
    dryRun: false,
    acceptUngated: true,
  });
  const after = readFileSync(path.join(tmp, ARMS), "utf8");
  expect(after).not.toBe(before);
  expect(after).toContain('"pm":1');
  expect(r["linesFolded"]).toBe(0);
  expect(r["changed"]).toBe(true);
  expect(String(r["note"])).toContain("stamped as already-promoted");
});

test("RouteControl promote preview leaves the store byte-identical and says nothing changed", async () => {
  const board = openScoreboard(path.join(tmp, STATE));
  board.record("q:hard", "strong", 0.5, { success: true });
  const before = readFileSync(path.join(tmp, ARMS), "utf8");
  const r = await callJson(routeControl, { action: "promote" });
  expect(r["status"]).toBe("preview");
  expect(r["changed"]).toBe(false);
  expect(readFileSync(path.join(tmp, ARMS), "utf8")).toBe(before);
});

test("WatchmeReport reports a state.json field that is not an instant, rather than throwing", async () => {
  // `WatchmeStore.state()` checks `schemaVersion` and casts the rest, so these
  // values reach the report exactly as written. `new Date(1e20).toISOString()`
  // throws a RangeError, which used to leave `execute` as a crash.
  mkdirSync(path.join(tmp, STATE, "watchme"), { recursive: true });
  writeFileSync(
    path.join(tmp, STATE, "watchme", "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      watching: true,
      startedAt: 1e20,
      lastReportAt: "yesterday",
      watermark: { lastMtimeMs: 0 },
      windows: {},
    }),
  );
  const r = await callJson(watchmeReport, {});
  expect(r["status"]).toBe("ok");
  expect(at(r, "state", "probe", "state")).toBe("unreadable");
  // The REASON names the fields, not just "broken".
  expect(String(at(r, "state", "probe", "detail"))).toContain("startedAt");
  expect(String(at(r, "state", "probe", "detail"))).toContain("lastReportAt");
  expect(at(r, "state", "startedAt", "unrenderable")).toBe("100000000000000000000");
  expect(at(r, "state", "lastReportAt", "unrenderable")).toBe("yesterday");
  // And `watching` is still the truth the file carries.
  expect(at(r, "state", "watching")).toBe(true);
});

test("WatchmeReport reports fedRoutingKeys that is not a list as unread, not as nothing fed", async () => {
  mkdirSync(path.join(tmp, STATE, "watchme"), { recursive: true });
  writeFileSync(
    path.join(tmp, STATE, "watchme", "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      watching: true,
      watermark: { lastMtimeMs: 0 },
      windows: 7,
      observed: "not-an-object",
      fedRoutingKeys: 7,
    }),
  );
  const r = await callJson(watchmeReport, {});
  expect(r["status"]).toBe("ok");
  expect(at(r, "judgments", "fedTurns")).toBe(0);
  expect(String(at(r, "judgments", "fedRoutingKeys"))).toContain("not an array");
  // `Object.keys("not-an-object")` would have invented 13 observed sessions.
  expect(at(r, "state", "observedSessions")).toBeNull();
  // And `windows: 7` is unreadable, not zero windows consumed.
  expect(at(r, "windows", "total")).toBe(0);
  expect(String(at(r, "windows", "unreadable"))).toContain("not an object");
});

test("ExperimentLedger list never reports one ledger's bytes under another ledger's name", async () => {
  mkdirSync(path.join(tmp, EXP), { recursive: true });
  // `_ramp` is a real experiment with rows and a manifest.
  writeFileSync(
    path.join(tmp, EXP, "_ramp.jsonl"),
    `${JSON.stringify({ ts: "t", experiment: "_ramp", version: "v1", outcome: "success" })}\n`,
  );
  writeFileSync(
    path.join(tmp, EXP, "_ramp.assignment.json"),
    JSON.stringify({
      name: "_ramp",
      variants: [
        { version: "v1", weight: 50 },
        { version: "v2", weight: 50 },
      ],
      updatedAt: "2026-01-01",
    }),
  );
  // `..ramp` is a DIFFERENT, empty file whose name sanitizes onto `_ramp`.
  writeFileSync(path.join(tmp, EXP, "..ramp.jsonl"), "");

  const r = await callJson(experimentLedger, { action: "list" });
  const rows = at(r, "experiments", "shown") as Json[];
  const alias = rows.find((row) => row["name"] === "..ramp") as Json;
  const real = rows.find((row) => row["name"] === "_ramp") as Json;
  expect(alias["ledgerBytes"]).toBe(0);
  expect(alias["addressable"]).toBe(false);
  expect(alias["addressableAs"]).toBe("_ramp");
  // The manifest belongs to `_ramp`; the aliased row must not claim it.
  expect(alias["assignment"]).toBeNull();
  expect(real["addressable"]).toBe(true);
  expect(real["ledgerBytes"]).toBeGreaterThan(0);
  expect(at(real, "assignment", "split", "valid")).toBe(true);
});

test("ExperimentLedger reports a manifest that assign would refuse as not a usable split", async () => {
  mkdirSync(path.join(tmp, EXP), { recursive: true });
  writeFileSync(
    path.join(tmp, EXP, "ramp.assignment.json"),
    JSON.stringify({
      name: "ramp",
      // Weights that do not sum to 100: `readExperimentAssignment` accepts the
      // shape, `selectExperimentVariant` throws on it.
      variants: [
        { version: "v1", weight: 10 },
        { version: "v2", weight: 10 },
      ],
      updatedAt: "2026-01-01",
    }),
  );
  writeFileSync(path.join(tmp, EXP, "ramp.jsonl"), "");
  const listed = await callJson(experimentLedger, { action: "list" });
  const row = (at(listed, "experiments", "shown") as Json[])[0] as Json;
  expect(at(row, "assignment", "split", "valid")).toBe(false);
  expect(String(at(row, "assignment", "split", "reason"))).toContain("sum to exactly 100");
  // The listing's verdict and `assign`'s behaviour are the same fact.
  const assigned = await callJson(experimentLedger, {
    action: "assign",
    name: "ramp",
    requestKey: "k",
  });
  expect(assigned["status"]).toBe("refused");
});

test("the raw watchme roll-up agrees with the store's OWN compact, pooling included", async () => {
  // This package pools a session's ratings and judgments count-weighted, which
  // is `watchme-store`'s private `qualitySample` rule — a second copy of a
  // rule the dependency owns, and the shape that shipped live last wave.
  // It cannot be imported (the store does not export it), so it is PINNED
  // against the store's own fold: the same sessions are read raw and then, after
  // `compact()`, through the aggregate half, and the two must agree on the mean,
  // the spread and the interval. A drift in either implementation fails here.
  const store = watchme();
  const sessions = [
    // `ratings` must be BOTH > 1 and paired with judged turns, or the
    // count-weighted rule and an unweighted mean-of-means give the same
    // answer and this pin proves nothing: (1*1 + 3*0.5)/4 and (1 + 0.5*3)/4
    // are equal at ratings=1, which is how a no-op fixture passes.
    { id: "sess_a", turns: 4, quality: { ratings: 4, meanRating: 1, judged: 2, meanJudge: 0 } },
    { id: "sess_b", turns: 6, quality: { ratings: 4, meanRating: 0.25, judged: 0 } },
    { id: "sess_c", turns: 9, quality: { ratings: 0, judged: 2, meanJudge: 0.8 } },
  ];
  for (const s of sessions) {
    store.appendObservation(observation(s.id, s.turns, { quality: s.quality }) as never);
  }
  const raw = await callJson(watchmeReport, {});
  const rawRow = (at(raw, "observations", "fromRaw", "shown") as Json[])[0] as Json;
  expect(at(rawRow, "quality", "n")).toBe(3);
  // The pooling is count-weighted, not a mean of means: session a is
  // (4*1 + 2*0)/6 = 2/3, where an unweighted pooling would give (1 + 0)/2 = 0.5.
  expect(at(rawRow, "quality", "mean")).toBeCloseTo((4 / 6 + 0.25 + 0.8) / 3, 12);

  store.compact();
  const folded = await callJson(watchmeReport, {});
  expect(at(folded, "observations", "rawSessions")).toBe(0);
  const aggRow = (at(folded, "observations", "fromAggregates", "shown") as Json[])[0] as Json;
  expect(at(aggRow, "quality", "n")).toBe(at(rawRow, "quality", "n"));
  expect(at(aggRow, "quality", "mean") as number).toBeCloseTo(
    at(rawRow, "quality", "mean") as number,
    12,
  );
  expect(at(aggRow, "quality", "sd") as number).toBeCloseTo(
    at(rawRow, "quality", "sd") as number,
    12,
  );
  expect(at(aggRow, "quality", "interval", "lower") as number).toBeCloseTo(
    at(rawRow, "quality", "interval", "lower") as number,
    12,
  );
  expect(at(aggRow, "turns", "mean") as number).toBeCloseTo(
    at(rawRow, "turns", "mean") as number,
    12,
  );
  expect(at(aggRow, "turns", "sd") as number).toBeCloseTo(at(rawRow, "turns", "sd") as number, 12);
});

test("a mean quality over one session carries no interval, and says why", async () => {
  const store = watchme();
  store.appendObservation(
    observation("sess_only", 3, { quality: { ratings: 1, meanRating: 0.95, judged: 0 } }) as never,
  );
  const r = await callJson(watchmeReport, {});
  const row = (at(r, "observations", "fromRaw", "shown") as Json[])[0] as Json;
  expect(at(row, "quality", "mean")).toBe(0.95);
  // One session is not evidence of a 0.95 harness, and the field says so
  // rather than showing a zero-width interval around a single reading.
  expect(at(row, "quality", "interval")).toBeNull();
  expect(String(at(row, "quality", "note"))).toContain("one observation");
});
