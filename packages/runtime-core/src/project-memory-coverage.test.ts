/**
 * Coverage tests for the defensive / error branches of loadProjectMemory
 * that the happy-path suite (project-memory.test.ts) does not reach:
 *   - a matched path that is a directory, not a file (`!st.isFile()`)
 *   - `readFile()` throwing (the `catch { continue }` during read)
 *   - `classifyBoundary()` rejecting (the `.catch(() => undefined)` arrow)
 *
 * Module mocks are installed ONCE at file scope (before loadProjectMemory is
 * first imported) and gated behind mutable flags so each test toggles only
 * the failure it needs — this sidesteps ESM live-binding caching, where a
 * mock.module call made after the importer is already loaded would not be
 * observed. Flags are reset in afterEach; afterAll reinstalls the REAL
 * modules — `mock.restore()` does not undo `mock.module`, and Bun shares one
 * module registry across all test files (nondeterministic order), so only
 * the re-mock keeps the stubs from leaking into sibling test files.
 */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as realFsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Real module captured for the afterAll restore.
import * as realBoundaryClassifierNS from "@crewhaus/boundary-classifier";

const realStat = realFsPromises.stat;
const realReadFile = realFsPromises.readFile;
// Plain-object SNAPSHOTS for the afterAll restore: an `import * as` namespace
// is a live view that resolves to the stubs once mock.module patches the
// module, so restoring from it would be a no-op.
const realFsPromisesSnapshot = { ...realFsPromises };
const realBoundaryClassifierSnapshot = { ...realBoundaryClassifierNS };

// Per-test toggles. When a `*Fails` is set, the corresponding mocked fn
// rejects for the named file; otherwise it delegates to the real impl.
const flags = {
  readFileFailsFor: undefined as string | undefined,
  classifyFails: false,
  classifyCalls: 0,
};

mock.module("node:fs/promises", () => ({
  ...realFsPromises,
  stat: realStat,
  readFile: (p: string, enc: BufferEncoding) => {
    if (flags.readFileFailsFor !== undefined && String(p).endsWith(flags.readFileFailsFor)) {
      return Promise.reject(new Error("readFile EIO"));
    }
    return realReadFile(p, enc);
  },
}));

mock.module("@crewhaus/boundary-classifier", () => ({
  classifyBoundary: (..._args: unknown[]) => {
    flags.classifyCalls += 1;
    if (flags.classifyFails) return Promise.reject(new Error("classifier offline"));
    return Promise.resolve({ classification: "clean", hits: [] });
  },
}));

afterEach(() => {
  flags.readFileFailsFor = undefined;
  flags.classifyFails = false;
  flags.classifyCalls = 0;
});

afterAll(() => {
  // Reinstall the real modules — mock.restore() would only undo spies, not
  // mock.module, so re-mocking is the only way to prevent cross-file leaks.
  mock.module("node:fs/promises", () => realFsPromisesSnapshot);
  mock.module("@crewhaus/boundary-classifier", () => realBoundaryClassifierSnapshot);
});

describe("loadProjectMemory — defensive branches", () => {
  test("skips a canonical name that resolves to a directory (not a file)", async () => {
    const { loadProjectMemory } = await import("./project-memory");
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-pm-dir-"));
    try {
      // A *directory* named CLAUDE.md: existsSync true, stat ok, isFile false.
      mkdirSync(join(dir, "CLAUDE.md"));
      writeFileSync(join(dir, "AGENTS.md"), "# real file");
      const result = await loadProjectMemory({ cwd: dir });
      expect(result.files.map((f) => f.filename)).toEqual(["AGENTS.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("continues past a readFile() failure during read (catch { continue })", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-pm-read-"));
    try {
      writeFileSync(join(dir, "AGENTS.md"), "# unreadable");
      writeFileSync(join(dir, "CLAUDE.md"), "# readable");
      flags.readFileFailsFor = "AGENTS.md";
      const { loadProjectMemory } = await import("./project-memory");
      const result = await loadProjectMemory({ cwd: dir });
      // AGENTS.md's read threw → `continue`; only CLAUDE.md is loaded.
      expect(result.files.map((f) => f.filename)).toEqual(["CLAUDE.md"]);
      expect(result.files[0]?.content).toContain("# readable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tolerates classifyBoundary rejecting (.catch arrow returns undefined)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-pm-classify-"));
    try {
      writeFileSync(join(dir, "AGENTS.md"), "# content to classify");
      flags.classifyFails = true;
      const { loadProjectMemory } = await import("./project-memory");
      const result = await loadProjectMemory({ cwd: dir });
      // The classifier threw but the load still succeeded (best-effort).
      expect(flags.classifyCalls).toBe(1);
      expect(result.files.length).toBe(1);
      expect(result.files[0]?.content).toContain("# content to classify");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
