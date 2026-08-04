import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
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
