/**
 * PR 19 — the FILE backend runs the cross-backend WikiStore conformance
 * suite (design §5: "local and Thredz are contract-identical" is a test,
 * not a convention). The suite itself lives in
 * `@crewhaus/memory-service/src/backend-conformance.ts` (the composition
 * root that owns both backends once PR 16 lands the Thredz flip); this file
 * is the file backend's enrollment, plus a negative control proving the
 * suite actually DISCRIMINATES: a backend that silently swallows version
 * conflicts (last-write-wins) must fail `upsert.version-conflict`.
 *
 * memory-service is a devDependency here (test-only): tsconfig project
 * references exclude test files, so the runtime dependency graph stays
 * acyclic — memory-service depends on wiki-store, never the reverse.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WIKI_CONFORMANCE_CHECKS,
  type WikiBackendFactory,
  runWikiBackendConformance,
} from "@crewhaus/memory-service";
import { type WikiStore, type WikiWrite, createWikiStore } from "./index";

/** The file backend, one fresh store per check. Visibility probe: the
 *  local wiki is private by construction (design §3.1). */
const fileBackendFactory: WikiBackendFactory = ({ specName, now }) => {
  const rootDir = mkdtempSync(join(tmpdir(), `wiki-conformance-${specName}-`));
  return {
    store: createWikiStore({ specName, rootDir, now }),
    visibilityOf: async () => "private" as const,
  };
};

describe("WikiStore backend conformance — file backend", () => {
  test("the file backend passes every contract check", async () => {
    const report = await runWikiBackendConformance("file", fileBackendFactory);
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual([...WIKI_CONFORMANCE_CHECKS]);
    expect(report.checks).toHaveLength(7);
  });

  test("negative control: a last-write-wins backend fails the version-conflict check", async () => {
    const cheatingFactory: WikiBackendFactory = ({ specName, now }) => {
      const rootDir = mkdtempSync(join(tmpdir(), `wiki-conformance-cheat-${specName}-`));
      const real = createWikiStore({ specName, rootDir, now });
      // A broken backend that "helpfully" retries stale writes against the
      // current version — exactly the contract violation the suite exists
      // to catch (a Thredz impl that ignored 409s would look like this).
      const cheating: WikiStore = {
        ...real,
        write: async (input: WikiWrite) => {
          try {
            return await real.write(input);
          } catch {
            const current = await real.get(input.slug);
            return real.write({ ...input, expectedVersion: current?.version ?? 0 });
          }
        },
      };
      return { store: cheating, visibilityOf: async () => "private" as const };
    };
    const report = await runWikiBackendConformance("cheating-file", cheatingFactory);
    expect(report.passed).toBe(false);
    const conflict = report.checks.find((c) => c.name === "upsert.version-conflict");
    expect(conflict?.passed).toBe(false);
    expect(conflict?.detail).toContain("stale");
  });
});
