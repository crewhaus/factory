import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleFreshnessItem, compareBundleFreshnessByMtime } from "./bundle";

function makeHarness(): string {
  return mkdtempSync(join(tmpdir(), "preflight-bundle-"));
}

function touch(path: string, epochSeconds: number): void {
  utimesSync(path, epochSeconds, epochSeconds);
}

describe("compareBundleFreshnessByMtime", () => {
  test("missing spec / missing bundle / stale / fresh", () => {
    const dir = makeHarness();
    expect(compareBundleFreshnessByMtime(dir).state).toBe("missing-spec");

    const spec = join(dir, "crewhaus.yaml");
    writeFileSync(spec, "name: t\n");
    expect(compareBundleFreshnessByMtime(dir).state).toBe("missing-bundle");

    // Nested dist file OLDER than the spec → stale.
    mkdirSync(join(dir, "dist", "skills"), { recursive: true });
    const artifact = join(dir, "dist", "skills", "agent.ts");
    writeFileSync(artifact, "// generated\n");
    touch(spec, 2_000_000_000);
    touch(artifact, 1_000_000_000);
    const stale = compareBundleFreshnessByMtime(dir);
    expect(stale.state).toBe("stale");
    expect(stale.specMtimeMs).toBeGreaterThan(stale.bundleMtimeMs ?? 0);

    // Bundle newer than spec → fresh.
    touch(artifact, 3_000_000_000);
    expect(compareBundleFreshnessByMtime(dir).state).toBe("fresh");
  });

  test("the NEWEST dist file wins (one fresh artifact among old ones)", () => {
    const dir = makeHarness();
    const spec = join(dir, "crewhaus.yaml");
    writeFileSync(spec, "name: t\n");
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "old.ts"), "");
    writeFileSync(join(dir, "dist", "new.ts"), "");
    touch(spec, 2_000_000_000);
    touch(join(dir, "dist", "old.ts"), 1_000_000_000);
    touch(join(dir, "dist", "new.ts"), 3_000_000_000);
    expect(compareBundleFreshnessByMtime(dir).state).toBe("fresh");
  });
});

/**
 * A permission bit cannot stop root, and Windows has no mode bits: on either
 * the chmod below would not make anything unreadable, and the test would be
 * asserting nothing.
 */
const canRevoke = process.platform !== "win32" && process.getuid?.() !== 0;

/** Run `body` with `path` at `mode`, restoring 0o755 so the tree can be removed. */
function withMode(path: string, mode: number, body: () => void): void {
  chmodSync(path, mode);
  try {
    body();
  } finally {
    chmodSync(path, 0o755);
  }
}

describe("an answer that could not be determined is not a verdict (flag-truth-3#10)", () => {
  function compiled(): string {
    const dir = makeHarness();
    writeFileSync(join(dir, "crewhaus.yaml"), "name: t\n");
    mkdirSync(join(dir, "dist", "sub"), { recursive: true });
    writeFileSync(join(dir, "dist", "index.js"), "// compiled\n");
    writeFileSync(join(dir, "dist", "sub", "agent.js"), "// compiled\n");
    return dir;
  }

  test.skipIf(!canRevoke)("a dist/ that cannot be listed is unreadable, not missing", () => {
    const dir = compiled();
    try {
      withMode(join(dir, "dist"), 0o000, () => {
        const r = compareBundleFreshnessByMtime(dir);
        // On 0.7.0: "missing-bundle", with a recompile as the remedy.
        expect(r.state).toBe("unreadable");
        expect(r.reason).toMatch(/^(EACCES|EPERM) listing dist\/$/);
        expect(r.specMtimeMs).toBeGreaterThan(0);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!canRevoke)("a subdirectory that cannot be listed is unreadable, not fresh", () => {
    // The unreadable subdirectory could hold the one file newer than the
    // spec: skipping it, as 0.7.0 did, turns "stale" into "fresh".
    const dir = compiled();
    try {
      utimesSync(join(dir, "crewhaus.yaml"), 1_000_000_000, 1_000_000_000);
      withMode(join(dir, "dist", "sub"), 0o000, () => {
        const r = compareBundleFreshnessByMtime(dir);
        expect(r.state).toBe("unreadable");
        expect(r.reason).toMatch(/^(EACCES|EPERM) listing dist\/sub\/$/);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!canRevoke)("a spec that cannot be examined is unreadable, not missing-spec", () => {
    const dir = compiled();
    try {
      // Read without search: the directory lists, but nothing in it can be
      // statted.
      withMode(dir, 0o600, () => {
        const r = compareBundleFreshnessByMtime(dir);
        expect(r.state).toBe("unreadable");
        expect(r.reason).toMatch(/^(EACCES|EPERM) examining crewhaus\.yaml$/);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("absent and empty dist/ are still missing-bundle; dist/ as a file too", () => {
    const dir = makeHarness();
    try {
      writeFileSync(join(dir, "crewhaus.yaml"), "name: t\n");
      expect(compareBundleFreshnessByMtime(dir).state).toBe("missing-bundle");
      mkdirSync(join(dir, "dist"));
      expect(compareBundleFreshnessByMtime(dir).state).toBe("missing-bundle");
      rmSync(join(dir, "dist"), { recursive: true });
      writeFileSync(join(dir, "dist"), "");
      expect(compareBundleFreshnessByMtime(dir).state).toBe("missing-bundle");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the report item says unknown and does not prescribe a recompile", () => {
    const item = bundleFreshnessItem({ state: "unreadable", reason: "EACCES listing dist/" });
    expect(item?.id).toBe("bundle.unreadable");
    expect(item?.level).toBe("warn");
    expect(item?.message).toContain("EACCES listing dist/");
    expect(item?.remediation).not.toContain("compile");
  });
});

describe("bundleFreshnessItem", () => {
  test("stale and missing-bundle are warn (approximate, never blocking); fresh is info", () => {
    const stale = bundleFreshnessItem({ state: "stale", specMtimeMs: 2, bundleMtimeMs: 1 });
    expect(stale?.level).toBe("warn");
    expect(stale?.message).toContain("approximate mtime heuristic");
    expect(bundleFreshnessItem({ state: "missing-bundle" })?.level).toBe("warn");
    expect(bundleFreshnessItem({ state: "fresh" })?.level).toBe("info");
    expect(bundleFreshnessItem({ state: "missing-spec" })).toBeUndefined();
  });
});
