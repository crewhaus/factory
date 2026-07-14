/**
 * Tests for the `crewhaus memory` verb helpers + the `crewhaus migrate
 * memories` v2 backfill (0.3.0 memory release, design §3.4). The store
 * semantics themselves live in @crewhaus/memory-store; here we cover the
 * CLI-side resolution, rendering, and the file migration (idempotency,
 * dry-run, verbatim passthrough, meta stamping).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryListItem } from "@crewhaus/memory-store";
import {
  MEMORIES_SUBDIR,
  MEMORY_ENTRY_1_TO_2,
  MemoryCliError,
  deriveAutoCaptureSessionId,
  formatMigrateMemoriesReport,
  humanAge,
  listMemorySpecs,
  migrateMemories,
  renderMemoryList,
  renderMemoryListRow,
  renderMemoryShow,
  resolveMemorySpec,
} from "./memory-cli";

let root: string;
let memoriesDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "memory-cli-"));
  memoriesDir = join(root, MEMORIES_SUBDIR);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeMemoryFile(specName: string, lines: string[]): string {
  mkdirSync(memoriesDir, { recursive: true });
  const p = join(memoriesDir, `${specName}.jsonl`);
  writeFileSync(p, lines.map((l) => `${l}\n`).join(""));
  return p;
}

const v1Entry = (id: string, text: string, tags: string[] = []): string =>
  JSON.stringify({ id, text, tags, createdAt: "2026-01-01T00:00:00.000Z" });

describe("listMemorySpecs + resolveMemorySpec", () => {
  test("lists spec names from .jsonl files, sorted", () => {
    writeMemoryFile("beta", [v1Entry("mem_00000000000000b1", "b")]);
    writeMemoryFile("alpha", [v1Entry("mem_00000000000000a1", "a")]);
    expect(listMemorySpecs(memoriesDir)).toEqual(["alpha", "beta"]);
  });

  test("missing dir lists nothing and resolve throws", () => {
    expect(listMemorySpecs(memoriesDir)).toEqual([]);
    expect(() => resolveMemorySpec(memoriesDir)).toThrow(MemoryCliError);
  });

  test("a lone file auto-resolves; multiple require --spec", () => {
    writeMemoryFile("only", []);
    expect(resolveMemorySpec(memoriesDir)).toBe("only");
    writeMemoryFile("second", []);
    expect(() => resolveMemorySpec(memoriesDir)).toThrow(/--spec/);
    expect(resolveMemorySpec(memoriesDir, "second")).toBe("second");
    expect(() => resolveMemorySpec(memoriesDir, "ghost")).toThrow(/no memory file/);
  });
});

describe("rendering", () => {
  const nowMs = Date.parse("2026-01-03T00:00:00.000Z"); // createdAt + 2d

  const item = (
    over: Partial<MemoryListItem["entry"]>,
    status: MemoryListItem["status"],
  ): MemoryListItem => ({
    entry: {
      id: "mem_0123456789abcdef",
      text: "the deploy pipeline runs on bun",
      tags: ["ops"],
      createdAt: "2026-01-01T00:00:00.000Z",
      ...over,
    },
    status,
  });

  test("humanAge buckets", () => {
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    expect(humanAge("2026-01-01T00:00:00.000Z", t0 + 5 * 60_000)).toBe("5m");
    expect(humanAge("2026-01-01T00:00:00.000Z", t0 + 7 * 3_600_000)).toBe("7h");
    expect(humanAge("2026-01-01T00:00:00.000Z", t0 + 3 * 86_400_000)).toBe("3d");
    expect(humanAge("not-a-date", t0)).toBe("?");
  });

  test("list row carries id, age, provenance flag, and superseded flag", () => {
    const plain = renderMemoryListRow(item({}, "live"), nowMs);
    expect(plain).toContain("mem_0123456789abcdef");
    expect(plain).toContain("2d");
    expect(plain).toContain("[ops]");
    expect(plain).not.toContain("prov");
    expect(plain).not.toContain("superseded");

    const proved = renderMemoryListRow(
      item({ provenance: { sessionId: "sess_0123456789abcdef" } }, "live"),
      nowMs,
    );
    expect(proved).toContain("prov");

    const superseded = renderMemoryListRow(item({}, "superseded"), nowMs);
    expect(superseded).toContain("superseded");
    const expired = renderMemoryListRow(item({}, "expired"), nowMs);
    expect(expired).toContain("expired");
  });

  test("list header counts statuses", () => {
    const lines = renderMemoryList(
      "support-bot",
      [item({}, "live"), item({ id: "mem_0123456789abcd00" }, "superseded")],
      nowMs,
    );
    expect(lines[0]).toBe("[memory] support-bot — 1 live, 1 superseded, 0 expired");
    expect(lines).toHaveLength(3);
  });

  test("show renders provenance, expiry, and supersededBy when present", () => {
    const lines = renderMemoryShow(
      item(
        {
          schemaVersion: 2,
          expiresAt: Date.parse("2026-02-01T00:00:00.000Z"),
          supersededBy: "mem_ffffffffffffffff",
          provenance: { sessionId: "sess_0123456789abcdef", evidence: ["tu_1", "tu_2"] },
        },
        "superseded",
      ),
    ).join("\n");
    expect(lines).toContain("status:        superseded");
    expect(lines).toContain("schemaVersion: 2");
    expect(lines).toContain("expires:       2026-02-01T00:00:00.000Z");
    expect(lines).toContain("supersededBy:  mem_ffffffffffffffff");
    expect(lines).toContain("session sess_0123456789abcdef · evidence tu_1, tu_2");
  });

  test("show marks v1 entries as implicit version 1", () => {
    const lines = renderMemoryShow(item({}, "live")).join("\n");
    expect(lines).toContain("schemaVersion: 1 (implicit)");
  });
});

describe("crewhaus migrate memories", () => {
  const sessTag = "sess_00112233445566aa";
  const tombstoneLine = JSON.stringify({
    tombstone: "superseded",
    target: "mem_00000000000000dd",
    at: "2026-01-02T00:00:00.000Z",
    schemaVersion: 2,
  });
  const unknownLine = `{"futureKind":"reserved","x":1}`;
  const malformedLine = "{broken json";
  const v2Line = JSON.stringify({
    id: "mem_00000000000000ee",
    text: "already v2",
    tags: [],
    createdAt: "2026-01-02T00:00:00.000Z",
    schemaVersion: 2,
  });

  function seed(): string {
    return writeMemoryFile("support-bot", [
      v1Entry("mem_00000000000000aa", "auto-captured fact", ["auto-capture", sessTag]),
      v1Entry("mem_00000000000000bb", "manual fact", ["preference"]),
      v2Line,
      tombstoneLine,
      unknownLine,
      malformedLine,
    ]);
  }

  test("deriveAutoCaptureSessionId needs both the auto-capture tag and a sess_ tag", () => {
    expect(deriveAutoCaptureSessionId(["auto-capture", sessTag])).toBe(sessTag);
    expect(deriveAutoCaptureSessionId([sessTag])).toBeUndefined();
    expect(deriveAutoCaptureSessionId(["auto-capture"])).toBeUndefined();
  });

  test("backfills schemaVersion + derivable provenance; preserves everything else verbatim", () => {
    const filePath = seed();
    const now = () => new Date("2026-07-13T12:00:00.000Z");
    const report = migrateMemories(root, { now });
    expect(report.dryRun).toBe(false);
    expect(report.migrated).toBe(2);
    expect(report.skipped).toBe(1);
    expect(report.files).toEqual([
      { specName: "support-bot", migrated: 2, skipped: 1, passthrough: 3 },
    ]);

    const lines = readFileSync(filePath, "utf-8")
      .split("\n")
      .filter((l) => l !== "");
    expect(lines).toHaveLength(6);
    const auto = JSON.parse(lines[0] as string);
    expect(auto.schemaVersion).toBe(2);
    expect(auto.version).toBeUndefined(); // the walk-time shim never persists
    expect(auto.provenance).toEqual({ sessionId: sessTag });
    expect(auto.tags).toEqual(["auto-capture", sessTag]); // tags untouched
    const manual = JSON.parse(lines[1] as string);
    expect(manual.schemaVersion).toBe(2);
    expect(manual.provenance).toBeUndefined(); // nothing derivable
    // v2 entry, tombstone, unknown, and malformed lines byte-identical.
    expect(lines[2]).toBe(v2Line);
    expect(lines[3]).toBe(tombstoneLine);
    expect(lines[4]).toBe(unknownLine);
    expect(lines[5]).toBe(malformedLine);

    // meta.json stamped.
    const meta = JSON.parse(readFileSync(join(root, ".crewhaus", "meta.json"), "utf-8"));
    expect(meta.memories).toEqual({
      schemaVersion: 2,
      migratedAt: "2026-07-13T12:00:00.000Z",
    });
    expect(report.metaPath).toBe(join(root, ".crewhaus", "meta.json"));
  });

  test("idempotent: a second run migrates 0 and leaves the file byte-identical", () => {
    const filePath = seed();
    migrateMemories(root);
    const afterFirst = readFileSync(filePath, "utf-8");
    const second = migrateMemories(root);
    expect(second.migrated).toBe(0);
    expect(second.skipped).toBe(3);
    expect(readFileSync(filePath, "utf-8")).toBe(afterFirst);
  });

  test("dry-run reports the plan without touching files or meta", () => {
    const filePath = seed();
    const before = readFileSync(filePath, "utf-8");
    const report = migrateMemories(root, { dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.migrated).toBe(2);
    expect(report.metaPath).toBeUndefined();
    expect(readFileSync(filePath, "utf-8")).toBe(before);
    expect(existsSync(join(root, ".crewhaus", "meta.json"))).toBe(false);
  });

  test("no memory files ⇒ empty report, no meta stamp", () => {
    const report = migrateMemories(root);
    expect(report.files).toEqual([]);
    expect(report.metaPath).toBeUndefined();
    expect(existsSync(join(root, ".crewhaus", "meta.json"))).toBe(false);
  });

  test("meta stamping preserves unrelated keys", () => {
    seed();
    mkdirSync(join(root, ".crewhaus"), { recursive: true });
    writeFileSync(join(root, ".crewhaus", "meta.json"), `${JSON.stringify({ other: true })}\n`);
    migrateMemories(root);
    const meta = JSON.parse(readFileSync(join(root, ".crewhaus", "meta.json"), "utf-8"));
    expect(meta.other).toBe(true);
    expect(meta.memories.schemaVersion).toBe(2);
  });

  test("the 1→2 step's down() strips every v2 field (rollback works)", () => {
    const up = MEMORY_ENTRY_1_TO_2.up({
      id: "mem_00000000000000aa",
      text: "t",
      tags: ["auto-capture", sessTag],
      createdAt: "2026-01-01T00:00:00.000Z",
      version: 1,
    });
    expect(up["schemaVersion"]).toBe(2);
    const down = MEMORY_ENTRY_1_TO_2.down(up);
    expect(down["schemaVersion"]).toBeUndefined();
    expect(down["provenance"]).toBeUndefined();
    expect(down["version"]).toBe(1);
    expect(down["text"]).toBe("t");
  });

  test("formatMigrateMemoriesReport renders per-file + summary lines", () => {
    seed();
    const lines = formatMigrateMemoriesReport(migrateMemories(root));
    expect(lines.some((l) => l.includes("support-bot: 2 migrated"))).toBe(true);
    expect(lines.some((l) => l.includes("2 entry(ies) migrated across 1 file(s)"))).toBe(true);
    expect(lines.some((l) => l.includes("meta.json"))).toBe(true);
  });
});
