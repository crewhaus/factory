/**
 * Tests for the project-memory auto-loader. Covers:
 * - File discovery in cwd (AGENTS.md, CLAUDE.md, CODE-COMPANION.md, AGENT.md)
 * - Multi-file concatenation with envelope tags
 * - Cap-byte truncation with notice
 * - Graceful no-match (empty result; non-erroring)
 * - Boundary classification with user origin (smoke — full classifier
 *   tests live in boundary-classifier package).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CANONICAL_MEMORY_FILES,
  DEFAULT_PROJECT_MEMORY_CAP_BYTES,
  loadProjectMemory,
} from "./project-memory";

let workdir: string;

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), "crewhaus-project-memory-"));
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function setUpWorkdir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(workdir, "case-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

describe("loadProjectMemory", () => {
  test("returns empty result when no memory files present", async () => {
    const dir = setUpWorkdir({ "unrelated.md": "ignored", "package.json": "{}" });
    const result = await loadProjectMemory({ cwd: dir });
    expect(result.files).toEqual([]);
    expect(result.prompt).toBe("");
    expect(result.totalBytes).toBe(0);
  });

  test("loads AGENTS.md when present", async () => {
    const dir = setUpWorkdir({ "AGENTS.md": "# Project Neutral\nHandles the thing." });
    const result = await loadProjectMemory({ cwd: dir });
    expect(result.files.length).toBe(1);
    expect(result.files[0]?.filename).toBe("AGENTS.md");
    expect(result.files[0]?.content).toContain("# Project Neutral");
    expect(result.files[0]?.truncated).toBe(false);
    expect(result.prompt).toContain('<project_memory file="AGENTS.md">');
    expect(result.prompt).toContain("</project_memory>");
  });

  test("loads CLAUDE.md when present", async () => {
    const dir = setUpWorkdir({ "CLAUDE.md": "# Project X\nDoes the thing." });
    const result = await loadProjectMemory({ cwd: dir });
    expect(result.files.length).toBe(1);
    expect(result.files[0]?.filename).toBe("CLAUDE.md");
    expect(result.files[0]?.content).toContain("# Project X");
    expect(result.files[0]?.truncated).toBe(false);
    expect(result.prompt).toContain('<project_memory file="CLAUDE.md">');
    expect(result.prompt).toContain("</project_memory>");
  });

  test("loads multiple memory files in canonical priority order", async () => {
    const dir = setUpWorkdir({
      "AGENTS.md": "# agents content",
      "CLAUDE.md": "# claude content",
      "CODE-COMPANION.md": "# code companion content",
      "AGENT.md": "# agent content",
    });
    const result = await loadProjectMemory({ cwd: dir });
    expect(result.files.map((f) => f.filename)).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      "CODE-COMPANION.md",
      "AGENT.md",
    ]);
    expect(result.prompt).toContain('<project_memory file="AGENTS.md">');
    expect(result.prompt).toContain('<project_memory file="CLAUDE.md">');
    expect(result.prompt).toContain('<project_memory file="CODE-COMPANION.md">');
    expect(result.prompt).toContain('<project_memory file="AGENT.md">');
  });

  test("truncates content exceeding capBytes with a notice", async () => {
    const dir = setUpWorkdir({ "CLAUDE.md": "x".repeat(200) });
    const result = await loadProjectMemory({ cwd: dir, capBytes: 50 });
    expect(result.files.length).toBe(1);
    expect(result.files[0]?.truncated).toBe(true);
    expect(result.files[0]?.content).toContain("[...truncated to 50 bytes");
  });

  test("stops loading once total cap exhausted", async () => {
    const dir = setUpWorkdir({
      "CLAUDE.md": "a".repeat(100),
      "CODE-COMPANION.md": "b".repeat(100),
      "AGENT.md": "c".repeat(100),
    });
    const result = await loadProjectMemory({ cwd: dir, capBytes: 150 });
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.totalBytes).toBeLessThanOrEqual(150 + 200); // truncation suffix adds bytes
  });

  test("ignores non-canonical filenames", async () => {
    // Note: avoid case-only-different names — macOS is case-insensitive
    // by default so "Claude.md" would collide with "CLAUDE.md".
    const dir = setUpWorkdir({
      "MEMORY.md": "should be ignored",
      "PROJECT.md": "also ignored",
    });
    const result = await loadProjectMemory({ cwd: dir });
    expect(result.files).toEqual([]);
  });

  test("honors filenames override", async () => {
    const dir = setUpWorkdir({ "PROJECT.md": "custom content" });
    const result = await loadProjectMemory({ cwd: dir, filenames: ["PROJECT.md"] });
    expect(result.files.length).toBe(1);
    expect(result.files[0]?.filename).toBe("PROJECT.md");
  });

  test("returns valid result when cwd doesn't exist (no throw)", async () => {
    const result = await loadProjectMemory({ cwd: "/this/path/does/not/exist/anywhere" });
    expect(result.files).toEqual([]);
    expect(result.prompt).toBe("");
  });

  test("CANONICAL_MEMORY_FILES exports the right list", () => {
    expect(CANONICAL_MEMORY_FILES).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      "CODE-COMPANION.md",
      "AGENT.md",
      "LESSONS.md",
    ]);
  });

  test("DEFAULT_PROJECT_MEMORY_CAP_BYTES is 64 KB", () => {
    expect(DEFAULT_PROJECT_MEMORY_CAP_BYTES).toBe(64 * 1024);
  });

  // Item #56 — LESSONS.md is a canonical memory file, so it auto-loads.
  test("loads LESSONS.md when present", async () => {
    const dir = setUpWorkdir({ "LESSONS.md": "# LESSONS\n- prefer bun over npm" });
    const result = await loadProjectMemory({ cwd: dir });
    expect(result.files.map((f) => f.filename)).toContain("LESSONS.md");
    expect(result.prompt).toContain('<project_memory file="LESSONS.md">');
    expect(result.prompt).toContain("prefer bun over npm");
  });

  // Item #56 — per-user preference files (absolute paths outside cwd) inject
  // via `extraFiles`, wrapped like the canonical files.
  test("injects a per-user preferences file via extraFiles", async () => {
    const dir = setUpWorkdir({});
    const prefsDir = mkdtempSync(join(workdir, "prefs-"));
    const prefsFile = join(prefsDir, "max.md");
    writeFileSync(prefsFile, "# Preferences — max\n- be concise");
    const result = await loadProjectMemory({ cwd: dir, extraFiles: [prefsFile] });
    expect(result.files.map((f) => f.filename)).toContain("max.md");
    expect(result.prompt).toContain('<project_memory file="max.md">');
    expect(result.prompt).toContain("be concise");
  });

  test("extraFiles that do not exist are silently skipped", async () => {
    const dir = setUpWorkdir({});
    const result = await loadProjectMemory({
      cwd: dir,
      extraFiles: [join(dir, "nope.md")],
    });
    expect(result.files).toEqual([]);
  });
});
