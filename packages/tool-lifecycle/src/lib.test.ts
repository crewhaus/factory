/**
 * The parts underneath the tools, where the conditions that matter are easy
 * to build: a tree with a file that cannot be read, a manifest that no longer
 * matches what is on disk, a registry manifest in each of the shapes it can
 * be wrong in, a selection full of impossible timestamps.
 *
 * These are the answers the tools' refusals are built on, so each test here
 * is about the DIFFERENCE between two answers that a careless implementation
 * would collapse into one: absent vs unreadable, verified vs unverifiable,
 * unpinned vs unknown, empty vs unparsed.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  auditHarnessMemoryFiles,
  auditSharedFragments,
  auditSharedMemories,
  harnessMemoryHashes,
  makeRedactor,
} from "./lib/knowledge";
import {
  inspectDestination,
  plannedPaths,
  readStoreVersion,
  uncoveredStateEntries,
} from "./lib/migrate";
import { contain, isInside, overlaps, renderPath, sample } from "./lib/result";
import { EPOCH_SANITY_MS, breadthRefusal, summarizeSelection } from "./lib/retention";
import {
  AUDIT_VERIFY_UNAVAILABLE,
  buildRetireSteps,
  readRegistryPins,
  recordSteps,
  specNameIsSafe,
} from "./lib/retire";
import { type Tree, verifyAgainst, walkTree } from "./lib/tree";

const originalCwd = process.cwd();
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-tool-lifecycle-lib-"));
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const abs = path.join(tmp, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

const BUDGET = { maxFiles: 1000, maxBytes: 10_000_000, hash: true };

function unwrap(tree: ReturnType<typeof walkTree>): Tree {
  if (!tree.ok) throw new Error(`expected a tree, got: ${tree.reason}`);
  return tree.value;
}

// ---------------------------------------------------------------------------
// paths and rendering
// ---------------------------------------------------------------------------

test("renderPath neutralises control characters and bounds the length", () => {
  const nasty = "a\u0000b\u001bc\nd\u007f";
  expect(renderPath(nasty)).toBe("a\uFFFDb\uFFFDc\uFFFDd\uFFFD");
  const long = renderPath("x".repeat(5000));
  expect(long.length).toBeLessThanOrEqual(201);
  expect(long.endsWith("…")).toBe(true);
});

test("a path carrying a NUL is refused at the gate, before any syscall", () => {
  const result = contain("T", "sessions\u0000/../../etc/passwd");
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.code).toBe("refused");
  expect(result.reason).toContain("NUL");
  // The rendered path in the message carries no raw control byte.
  expect(result.reason.includes("\u0000")).toBe(false);
});

test("containment relations are computed on whole path segments", () => {
  expect(isInside("/a/b", "/a/b/c")).toBe(true);
  expect(isInside("/a/b", "/a/b")).toBe(true);
  // The classic prefix pitfall: /a/b-sibling is not inside /a/b.
  expect(isInside("/a/b", "/a/b-sibling")).toBe(false);
  expect(overlaps("/a/b/c", "/a/b")).toBe(true);
  expect(overlaps("/a/b", "/a/c")).toBe(false);
});

test("sample reports the total, not just what it shows", () => {
  expect(sample([1, 2, 3, 4], 2)).toEqual({ shown: [1, 2], total: 4 });
});

// ---------------------------------------------------------------------------
// tree: fingerprint and verify
// ---------------------------------------------------------------------------

test("walkTree hashes files, records symlinks without following them, and sorts", () => {
  write("state/b.txt", "beta");
  write("state/a.txt", "alpha");
  write("state/nested/c.txt", "gamma");
  symlinkSync("/etc/passwd", path.join(tmp, "state/link"));
  const tree = unwrap(walkTree(path.join(tmp, "state"), BUDGET));
  expect(tree.entries.map((e) => e.rel)).toEqual(["a.txt", "b.txt", "link", "nested/c.txt"]);
  expect(tree.fileCount).toBe(3);
  expect(tree.complete).toBe(true);
  const link = tree.entries.find((e) => e.rel === "link");
  // Recorded as the link itself: no hash, and the target kept verbatim. A
  // followed symlink would have hashed /etc/passwd and counted its bytes.
  expect(link?.kind).toBe("symlink");
  expect(link?.sha256).toBeUndefined();
  expect(link?.target).toBe("/etc/passwd");
  expect(tree.entries.find((e) => e.rel === "a.txt")?.sha256).toMatch(/^[0-9a-f]{64}$/);
});

test("walkTree refuses a tree over its file budget, naming the budget", () => {
  for (let i = 0; i < 5; i += 1) write(`state/f${i}.txt`, "x");
  const result = walkTree(path.join(tmp, "state"), { maxFiles: 3, maxBytes: 1_000, hash: true });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.code).toBe("too-large");
  expect(result.reason).toContain("more than 3 files");
});

test("walkTree refuses a tree over its byte budget", () => {
  write("state/big.bin", "x".repeat(2048));
  const result = walkTree(path.join(tmp, "state"), { maxFiles: 10, maxBytes: 1024, hash: true });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.reason).toContain("more than 1024 bytes");
});

test("a subdirectory that cannot be listed makes the fingerprint incomplete, with the reason", () => {
  write("state/keep.txt", "kept");
  mkdirSync(path.join(tmp, "state/locked"));
  writeFileSync(path.join(tmp, "state/locked/secret.txt"), "s");
  chmodSync(path.join(tmp, "state/locked"), 0o000);
  try {
    const tree = unwrap(walkTree(path.join(tmp, "state"), BUDGET));
    if (tree.unreadable.length === 0) {
      // Running as root, where the mode is not enforced: the case cannot be
      // built here, and asserting on it anyway would be asserting on nothing.
      console.log("UNREADABLE_SKIPPED running with permission to read a 0o000 directory");
      return;
    }
    expect(tree.complete).toBe(false);
    expect(tree.unreadable[0]?.rel).toBe("locked");
    expect(String(tree.unreadable[0]?.reason)).toContain("could not be listed");
    // The readable part is still reported — an unreadable corner does not
    // erase what was seen.
    expect(tree.entries.map((e) => e.rel)).toContain("keep.txt");
  } finally {
    chmodSync(path.join(tmp, "state/locked"), 0o700);
  }
});

test("verifyAgainst catches changed bytes, changed size and a missing file", () => {
  write("src/a.txt", "alpha");
  write("src/b.txt", "beta");
  write("src/c.txt", "gamma");
  const tree = unwrap(walkTree(path.join(tmp, "src"), BUDGET));
  write("dst/a.txt", "alpha");
  write("dst/b.txt", "BETA");
  write("dst/c.txt", "gamma but longer");
  const verdict = verifyAgainst(path.join(tmp, "dst"), tree.entries);
  expect(verdict.checked).toBe(3);
  expect(verdict.verified).toBe(1);
  expect(verdict.ok).toBe(false);
  expect(verdict.mismatched.map((m) => [m.rel, m.problem]).sort()).toEqual([
    ["b.txt", "sha256"],
    ["c.txt", "size"],
  ]);

  rmSync(path.join(tmp, "dst/a.txt"));
  const afterDelete = verifyAgainst(path.join(tmp, "dst"), tree.entries);
  expect(afterDelete.mismatched.some((m) => m.rel === "a.txt" && m.problem === "missing")).toBe(
    true,
  );
});

test("an entry with no recorded hash is unverifiable, never verified", () => {
  write("dst/a.txt", "alpha");
  const verdict = verifyAgainst(path.join(tmp, "dst"), [{ rel: "a.txt", kind: "file", bytes: 5 }]);
  expect(verdict.verified).toBe(0);
  expect(verdict.mismatched[0]?.problem).toBe("unreadable");
  expect(String(verdict.mismatched[0]?.detail)).toContain("cannot be verified");
});

test("an incomplete manifest can never verify, even with nothing mismatched", () => {
  write("dst/a.txt", "alpha");
  const tree = unwrap(walkTree(path.join(tmp, "dst"), BUDGET));
  expect(verifyAgainst(path.join(tmp, "dst"), tree.entries, true).ok).toBe(true);
  // Same bytes, same digests — but the manifest itself had a hole in it, so
  // the files it never covered are exactly the ones nothing was checked.
  expect(verifyAgainst(path.join(tmp, "dst"), tree.entries, false).ok).toBe(false);
});

// ---------------------------------------------------------------------------
// registry pins
// ---------------------------------------------------------------------------

test("a spec name that is a path is rejected", () => {
  for (const bad of ["", ".", "..", "a/b", "a\\b", "../etc", "a\u0000b"]) {
    expect({ bad, safe: specNameIsSafe(bad) }).toEqual({ bad, safe: false });
  }
  for (const good of ["demo", "support-bot", "a.b_c-1"]) {
    expect({ good, safe: specNameIsSafe(good) }).toEqual({ good, safe: true });
  }
});

test("registry pins: absent, known, and every shape of unknown", () => {
  const registry = path.join(tmp, "registry");
  expect(readRegistryPins(registry, "nope")).toEqual({ state: "absent" });

  write(
    "registry/demo/manifest.json",
    JSON.stringify({ versions: ["v2", "v1"], pins: { prod: "v2" } }),
  );
  expect(readRegistryPins(registry, "demo")).toEqual({
    state: "known",
    pins: { prod: "v2" },
    versions: ["v1", "v2"],
  });

  const badShapes: Array<[string, string]> = [
    ["not-json", "{ nope"],
    ["not-object", "[1,2,3]"],
    ["pins-not-object", JSON.stringify({ pins: ["prod"] })],
    ["pin-not-string", JSON.stringify({ pins: { prod: 7 } })],
    ["versions-not-array", JSON.stringify({ versions: "v1" })],
  ];
  for (const [name, body] of badShapes) {
    write(`registry/${name}/manifest.json`, body);
    const state = readRegistryPins(registry, name);
    console.log(`PINS ${name} -> ${state.state} ${"reason" in state ? state.reason : ""}`);
    // Never "absent", never an empty pin set: an unreadable manifest is its
    // own answer, and the retirement refuses on it.
    expect(state.state).toBe("unknown");
  }

  // A directory where the manifest file belongs reads as unknown too (EISDIR),
  // not as an unregistered spec.
  mkdirSync(path.join(registry, "dir-manifest/manifest.json"), { recursive: true });
  expect(readRegistryPins(registry, "dir-manifest").state).toBe("unknown");
});

// ---------------------------------------------------------------------------
// retirement steps
// ---------------------------------------------------------------------------

test("backupState writes the fingerprint, and refuses when the fingerprint has a hole", async () => {
  write("state/a.txt", "alpha");
  const tree = unwrap(walkTree(path.join(tmp, "state"), BUDGET));
  mkdirSync(path.join(tmp, "archive"), { recursive: true });
  const steps = buildRetireSteps({
    stateTree: tree,
    harnessDir: tmp,
    pinState: { state: "absent" },
    now: () => new Date("2026-09-19T00:00:00.000Z"),
  });
  const ok = await steps.backupState(path.join(tmp, "archive"));
  expect(ok.ok).toBe(true);
  expect(String(ok.tarball)).toContain("state-manifest.json");

  const holed = buildRetireSteps({
    stateTree: {
      ...tree,
      complete: false,
      unreadable: [{ rel: "x", reason: "could not be stat'd (EACCES)" }],
    },
    harnessDir: tmp,
    pinState: { state: "absent" },
    now: () => new Date(),
  });
  const refused = await holed.backupState(path.join(tmp, "archive"));
  // ok:false is what aborts the retirement before anything is destroyed.
  expect(refused.ok).toBe(false);
  expect(refused.detail).toContain("could not be read");
});

test("the audit and compliance steps report that they did not run, rather than succeeding", async () => {
  const steps = buildRetireSteps({
    stateTree: undefined,
    harnessDir: tmp,
    pinState: { state: "absent" },
    now: () => new Date(),
  });
  const audit = await steps.auditVerify();
  const compliance = await steps.complianceEvidence(path.join(tmp, "archive"));
  expect(audit.ok).toBe(false);
  expect(audit.detail).toBe(AUDIT_VERIFY_UNAVAILABLE);
  expect(audit.detail).toContain("AuditVerify");
  expect(compliance.ok).toBe(false);
  expect(compliance.detail).toContain("not performed");
});

test("tombstoneRegistry succeeds only when there is genuinely nothing to tombstone", async () => {
  const make = (pinState: Parameters<typeof buildRetireSteps>[0]["pinState"]) =>
    buildRetireSteps({ stateTree: undefined, harnessDir: tmp, pinState, now: () => new Date() });
  expect((await make({ state: "absent" }).tombstoneRegistry()).ok).toBe(true);
  expect((await make({ state: "known", pins: {}, versions: [] }).tombstoneRegistry()).ok).toBe(
    true,
  );
  const withVersions = await make({
    state: "known",
    pins: {},
    versions: ["v1"],
  }).tombstoneRegistry();
  expect(withVersions.ok).toBe(false);
  expect(withVersions.detail).toContain("@crewhaus/spec-registry");
  const unknown = await make({
    state: "unknown",
    reason: "manifest unreadable",
  }).tombstoneRegistry();
  expect(unknown.ok).toBe(false);
  expect(unknown.detail).toBe("manifest unreadable");
});

test("recordSteps keeps the outcomes of the steps that ran before one failed", async () => {
  const { steps, recorded } = recordSteps(
    buildRetireSteps({
      stateTree: undefined,
      harnessDir: tmp,
      pinState: { state: "known", pins: {}, versions: ["v1"] },
      now: () => new Date(),
    }),
  );
  await steps.backupState(tmp);
  await steps.auditVerify();
  await steps.tombstoneRegistry();
  expect(recorded.map((o) => `${o.step}:${o.ok}`)).toEqual([
    "backupState:true",
    "auditVerify:false",
    "tombstoneRegistry:false",
  ]);
});

// ---------------------------------------------------------------------------
// retention selection
// ---------------------------------------------------------------------------

const inventory = (entries: Array<[string, number]>) =>
  entries.map(([id, createdAt]) => ({ sessionId: id, record: { id: `session:${id}`, createdAt } }));

const report = (ids: string[]) =>
  ({
    deleted: ids.map((id) => ({ id: `session:${id}`, paths: [`/x/${id}.json`] })),
  }) as unknown as Parameters<typeof summarizeSelection>[0];

test("a selection reports its span, and an id the snapshot never saw as unknown", () => {
  const now = Date.UTC(2026, 8, 19);
  const selection = summarizeSelection(
    report(["a", "b", "ghost"]),
    inventory([
      ["a", now - 90 * 86_400_000],
      ["b", now - 40 * 86_400_000],
      ["c", now],
    ]),
  );
  expect(selection.count).toBe(3);
  expect(selection.sessionsInStore).toBe(3);
  expect(selection.oldestMs).toBe(now - 90 * 86_400_000);
  expect(selection.newestMs).toBe(now - 40 * 86_400_000);
  // Not age zero, not silently dropped: unknown.
  expect(selection.unknownTimestamp).toEqual(["session:ghost"]);
});

test("the breadth refusals fire in the order that explains the selection", () => {
  const now = Date.UTC(2026, 8, 19);
  const broken = summarizeSelection(report(["a"]), inventory([["a", 0]]));
  // Epoch zero first, and with no override — allowDeleteAll does not excuse a
  // timestamp nobody believes.
  for (const allowDeleteAll of [false, true]) {
    const verdict = breadthRefusal(broken, { allowDeleteAll, nowMs: now });
    expect(String(verdict?.reason)).toContain("no flag to override this");
  }
  expect(EPOCH_SANITY_MS).toBe(Date.UTC(1971, 0, 1));

  const all = summarizeSelection(
    report(["a", "b"]),
    inventory([
      ["a", now - 1],
      ["b", now - 2],
    ]),
  );
  expect(String(breadthRefusal(all, { allowDeleteAll: false, nowMs: now })?.reason)).toContain(
    "EVERY session in the store — 2 of 2",
  );
  expect(breadthRefusal(all, { allowDeleteAll: true, nowMs: now })).toBeUndefined();

  const some = summarizeSelection(
    report(["a"]),
    inventory([
      ["a", now - 1],
      ["b", now - 2],
      ["c", now - 3],
    ]),
  );
  expect(breadthRefusal(some, { allowDeleteAll: false, nowMs: now })).toBeUndefined();
  expect(
    String(breadthRefusal(some, { allowDeleteAll: false, maxDeletions: 0, nowMs: now })?.reason),
  ).toContain("maxDeletions limit of 0");
  expect(
    String(
      breadthRefusal(some, { allowDeleteAll: false, cutoffMs: now + 86_400_000, nowMs: now })
        ?.reason,
    ),
  ).toContain("is in the future");
  // A cutoff in the past is ordinary and is not refused.
  expect(
    breadthRefusal(some, { allowDeleteAll: false, cutoffMs: now - 86_400_000, nowMs: now }),
  ).toBeUndefined();
});

test("an empty selection is never refused for breadth", () => {
  const now = Date.UTC(2026, 8, 19);
  const nothing = summarizeSelection(report([]), inventory([["a", now]]));
  expect(breadthRefusal(nothing, { allowDeleteAll: false, nowMs: now })).toBeUndefined();
});

// ---------------------------------------------------------------------------
// store migration
// ---------------------------------------------------------------------------

test("store version: stamped, unstamped, and unreadable are three answers", () => {
  expect(readStoreVersion(tmp)).toEqual({ state: "unstamped" });
  write(".crewhaus/meta.json", JSON.stringify({ other: true }));
  expect(readStoreVersion(tmp)).toEqual({ state: "unstamped" });
  write(".crewhaus/meta.json", JSON.stringify({ memories: { schemaVersion: 2 } }));
  expect(readStoreVersion(tmp)).toEqual({ state: "known", memoriesSchemaVersion: 2 });
  for (const bad of [
    "{{{",
    JSON.stringify([1]),
    JSON.stringify({ memories: 4 }),
    JSON.stringify({ memories: { schemaVersion: "2" } }),
  ]) {
    write(".crewhaus/meta.json", bad);
    expect(readStoreVersion(tmp).state).toBe("unknown");
  }
});

test("what the export path does not carry is enumerated", () => {
  write(".crewhaus/sessions/x.json", "{}");
  write(".crewhaus/audit/2026-01-01.jsonl", "{}");
  write(".crewhaus/memories/demo.jsonl", "{}");
  write(".crewhaus/retention.json", "{}");
  const uncovered = uncoveredStateEntries(tmp);
  expect(uncovered.ok).toBe(true);
  if (!uncovered.ok) throw new Error("unreachable");
  expect(uncovered.value.map((u) => u.entry).sort()).toEqual([
    ".crewhaus/memories",
    ".crewhaus/retention.json",
  ]);
  // No state directory at all is an empty list, not a failure.
  const empty = uncoveredStateEntries(path.join(tmp, "elsewhere"));
  expect(empty.ok).toBe(true);
});

test("planned destination paths cover event logs and the chain anchor", () => {
  expect(
    plannedPaths({
      sessions: ["s1", "s2"],
      auditDays: ["2026-01-01"],
      chainTail: true,
      withEventLog: new Set(["s2"]),
    }),
  ).toEqual([
    "sessions/s1.json",
    "sessions/s2.json",
    "sessions/s2.jsonl",
    "audit/2026-01-01.jsonl",
    "audit/_chain-tail.json",
  ]);
});

test("the destination reports conflicts and an untrustworthy receipt separately", () => {
  const dest = path.join(tmp, "dest");
  const absent = inspectDestination(dest, ["sessions/a.json"]);
  expect(absent.ok).toBe(true);
  if (!absent.ok) throw new Error("unreachable");
  expect(absent.value).toEqual({ exists: false, conflicts: [] });

  write("dest/sessions/a.json", "{}");
  write("dest/store-migration.json", "{ truncated");
  const broken = inspectDestination(dest, ["sessions/a.json", "sessions/b.json"]);
  if (!broken.ok) throw new Error("unreachable");
  expect(broken.value.conflicts).toEqual(["sessions/a.json"]);
  expect(String(broken.value.receiptProblem)).toContain("not valid JSON");
  expect(broken.value.receipt).toBeUndefined();

  write("dest/store-migration.json", JSON.stringify({ sourceRoot: "/elsewhere", writtenAt: "x" }));
  const foreign = inspectDestination(dest, []);
  if (!foreign.ok) throw new Error("unreachable");
  expect(foreign.value.receipt?.sourceRoot).toBe("/elsewhere");
});

// ---------------------------------------------------------------------------
// knowledge
// ---------------------------------------------------------------------------

test("the redactor masks a known credential shape and flags one it does not know", async () => {
  const redact = makeRedactor();
  const known = await redact(`key ${["sk", "live", "51H8xQ2eZvKYlo2Cdcfghjkmnpqrstvw"].join("_")}`);
  expect(known.text).toBe("key ***");
  expect(known.secretRemains).toBe(false);
  const unknown = await redact(`token ${["Zq7Wm3Kx9Lp2Vb8Nc", "4Ht6Rj1Ds5Fg0Ay2Qw"].join("")}`);
  // Nothing masked it, so it is refused rather than shared — the fallback the
  // identity redactor in the library would have let straight through.
  expect(unknown.secretRemains).toBe(true);
  const plain = await redact("prefer the cached path");
  expect(plain).toEqual({ text: "prefer the cached path", secretRemains: false });
});

test("shared memories: valid, rejected with a reason, and unreadable", () => {
  const shared = path.join(tmp, "shared");
  expect(auditSharedMemories(shared).ok).toBe(true);
  const emptyStore = auditSharedMemories(shared);
  if (!emptyStore.ok) throw new Error("unreachable");
  expect(emptyStore.value).toEqual({ memories: [], rejected: [], linesSeen: 0 });

  write(
    "shared/memories.jsonl",
    [
      JSON.stringify({ contentHash: "deadbeef", text: "lying hash", tags: [] }),
      "{ not json",
      JSON.stringify({ contentHash: "x", text: 7, tags: [] }),
    ].join("\n"),
  );
  const audited = auditSharedMemories(shared);
  if (!audited.ok) throw new Error("unreachable");
  expect(audited.value.memories).toEqual([]);
  expect(audited.value.linesSeen).toBe(3);
  expect(audited.value.rejected.map((r) => r.reason)).toEqual([
    "contentHash does not match recomputed hash of text+tags",
    "not valid JSON",
    "text not a string",
  ]);

  // A directory where the file belongs: unreadable, and NOT an empty store.
  rmSync(path.join(shared, "memories.jsonl"));
  mkdirSync(path.join(shared, "memories.jsonl"));
  const unreadable = auditSharedMemories(shared);
  expect(unreadable.ok).toBe(false);
  if (unreadable.ok) throw new Error("unreachable");
  expect(unreadable.code).toBe("unreadable");
});

test("a fragment whose filename does not match its body is counted as rejected", () => {
  const shared = path.join(tmp, "shared");
  write(
    "shared/prompts/0000000000000000000000000000000000000000000000000000000000000000.md",
    "body",
  );
  const audited = auditSharedFragments(shared, "prompt");
  if (!audited.ok) throw new Error("unreachable");
  expect(audited.value.fragments).toEqual([]);
  expect(audited.value.rejected.length).toBe(1);
  expect(String(audited.value.rejected[0]?.reason)).toContain("does not match");
});

test("a pulled memory is recognised under its shared hash as well as its local one", async () => {
  const { memoryContentHash } = await import("@crewhaus/harness-lifecycle");
  const sharedHash = memoryContentHash("a lesson", ["ops"]);
  const landed = [{ text: "a lesson", tags: ["ops", "shared:other-harness"] }];
  const hashes = harnessMemoryHashes(landed);
  // Both: the hash it has on disk, and the hash it had in the shared store.
  // Without the second, every pull re-imports everything it pulled before.
  expect(hashes.has(memoryContentHash("a lesson", ["ops", "shared:other-harness"]))).toBe(true);
  expect(hashes.has(sharedHash)).toBe(true);
  // A purely local memory contributes one hash, not two.
  expect(harnessMemoryHashes([{ text: "local", tags: ["x"] }]).size).toBe(1);
});

test("the pulled-memory hash is the exact inverse of the tag applyPull appends", async () => {
  const { memoryContentHash } = await import("@crewhaus/harness-lifecycle");
  // A shared record whose OWN tags already carry a `shared:` tag — one
  // harness pulled it and pushed it on. applyPull appends exactly one more,
  // so exactly one is taken back off. Stripping every `shared:`-prefixed tag
  // reproduced neither hash, so the pull that had just landed this memory
  // reported it missing and the next pull re-imported it.
  const sharedTags = ["ops", "shared:alpha"];
  const landed = [{ text: "a lesson", tags: [...sharedTags, "shared:beta"] }];
  const hashes = harnessMemoryHashes(landed);
  expect(hashes.has(memoryContentHash("a lesson", sharedTags))).toBe(true);
  expect(hashes.has(memoryContentHash("a lesson", [...sharedTags, "shared:beta"]))).toBe(true);
  // And it does NOT invent the hash of a record nobody ever shared.
  expect(hashes.has(memoryContentHash("a lesson", ["ops"]))).toBe(false);
});

test("a timestamp exactly at the epoch-sanity boundary is refused, as the message says", () => {
  // The refusal says "at or before"; the comparison has to agree with it, or
  // the one value the rule is named after is the one it lets through.
  const selection = summarizeSelection(
    { deleted: [{ id: "session:s1", paths: ["/tmp/s1.json"] }] } as never,
    [{ sessionId: "s1", record: { id: "session:s1", createdAt: EPOCH_SANITY_MS } }],
  );
  expect(selection.epochZero.length).toBe(1);
  const refused = breadthRefusal(selection, { allowDeleteAll: true, nowMs: Date.now() });
  expect(refused?.reason).toContain("at or before");
  // One millisecond later is ordinary old data, not a broken clock.
  const justAfter = summarizeSelection(
    { deleted: [{ id: "session:s1", paths: ["/tmp/s1.json"] }] } as never,
    [{ sessionId: "s1", record: { id: "session:s1", createdAt: EPOCH_SANITY_MS + 1 } }],
  );
  expect(justAfter.epochZero.length).toBe(0);
});

test("a symlink that now points somewhere else does not verify", () => {
  write("src/real.txt", "bytes");
  symlinkSync(path.join(tmp, "src/real.txt"), path.join(tmp, "src/link"));
  const before = unwrap(walkTree(path.join(tmp, "src"), BUDGET));

  // The archive has a link of the same name pointing at something else. A
  // check that only asked "is it still a symlink?" verified it — at exactly
  // the moment the original was about to be destroyed.
  mkdirSync(path.join(tmp, "dst"), { recursive: true });
  writeFileSync(path.join(tmp, "dst/real.txt"), "bytes");
  symlinkSync(path.join(tmp, "elsewhere.txt"), path.join(tmp, "dst/link"));
  const verified = verifyAgainst(path.join(tmp, "dst"), before.entries, before.complete);
  expect(verified.ok).toBe(false);
  expect(verified.mismatched.map((m) => m.rel)).toEqual(["link"]);
  expect(String(verified.mismatched[0]?.detail)).toContain("pointed at");
});

test("harness memory files: absent, present, and unreadable", () => {
  const absent = auditHarnessMemoryFiles(tmp);
  if (!absent.ok) throw new Error("unreachable");
  expect(absent.value).toEqual({ dirPresent: false, files: 0, linesSeen: 0 });

  write(".crewhaus/memories/a.jsonl", '{"text":"one"}\n\n{"text":"two"}\n');
  write(".crewhaus/memories/notes.txt", "ignored");
  const present = auditHarnessMemoryFiles(tmp);
  if (!present.ok) throw new Error("unreachable");
  expect(present.value).toEqual({ dirPresent: true, files: 1, linesSeen: 2 });

  rmSync(path.join(tmp, ".crewhaus/memories/a.jsonl"));
  mkdirSync(path.join(tmp, ".crewhaus/memories/a.jsonl"));
  const unreadable = auditHarnessMemoryFiles(tmp);
  expect(unreadable.ok).toBe(false);
});
