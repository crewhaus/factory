import { afterEach, beforeEach, describe, expect, test } from "bun:test";
/**
 * Unit coverage for the local-bundle manifest synthesizer — the compile-path
 * write that makes `bun install` + `bun agent.ts` in an emitted out-dir
 * resolve the bundle's `@crewhaus/*` imports standalone. (The scan/render
 * helpers it composes keep their coverage in compile-check.test.ts, where
 * they were born.)
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE_MANIFEST_NAME, ensureBundleManifest } from "./bundle-manifest";
import { cliVersion } from "./version";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "crewhaus-bundle-manifest-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const AGENT = {
  path: "agent.ts",
  content:
    'import { createInMemoryQueue } from "@crewhaus/queue-protocol";\n' +
    'import { runChatLoop } from "@crewhaus/runtime-core";\n',
};

describe("ensureBundleManifest", () => {
  test("writes the pinned manifest when the bundle ships none", () => {
    const result = ensureBundleManifest([AGENT], tmp);
    expect(result).toEqual({ path: join(tmp, "package.json"), action: "wrote" });
    const manifest = JSON.parse(readFileSync(result.path, "utf-8"));
    expect(manifest.name).toBe(BUNDLE_MANIFEST_NAME);
    expect(manifest.dependencies).toEqual({
      "@crewhaus/queue-protocol": cliVersion(),
      "@crewhaus/runtime-core": cliVersion(),
    });
  });

  test("skips when the bundle ships its own package.json (cf-worker flavour)", () => {
    const result = ensureBundleManifest(
      [AGENT, { path: "package.json", content: '{ "name": "emitted-by-target" }' }],
      tmp,
    );
    expect(result.action).toBe("skipped");
    // Nothing was written — the emitter's file is the CLI write-loop's job.
    expect(() => readFileSync(join(tmp, "package.json"), "utf-8")).toThrow();
  });

  test("keeps a user-authored package.json on disk untouched", () => {
    const path = join(tmp, "package.json");
    const foreign = '{ "name": "my-harness", "dependencies": { "left-pad": "1.0.0" } }\n';
    writeFileSync(path, foreign);
    const result = ensureBundleManifest([AGENT], tmp);
    expect(result).toEqual({ path, action: "kept" });
    expect(readFileSync(path, "utf-8")).toBe(foreign);
  });

  test("an unparseable package.json counts as user-authored (never clobbered)", () => {
    const path = join(tmp, "package.json");
    writeFileSync(path, "not json {");
    expect(ensureBundleManifest([AGENT], tmp).action).toBe("kept");
    expect(readFileSync(path, "utf-8")).toBe("not json {");
  });

  test("refreshes its own manifest from a previous compile", () => {
    const path = join(tmp, "package.json");
    writeFileSync(
      path,
      `${JSON.stringify({ name: BUNDLE_MANIFEST_NAME, private: true, type: "module", dependencies: { "@crewhaus/stale-dep": "0.0.1" } })}\n`,
    );
    const result = ensureBundleManifest([AGENT], tmp);
    expect(result.action).toBe("wrote");
    const manifest = JSON.parse(readFileSync(path, "utf-8"));
    expect(manifest.dependencies).toEqual({
      "@crewhaus/queue-protocol": cliVersion(),
      "@crewhaus/runtime-core": cliVersion(),
    });
  });

  test("an import-free bundle still gets a manifest so bun install anchors to the out-dir", () => {
    const result = ensureBundleManifest([{ path: "agent.ts", content: "console.log(1);\n" }], tmp);
    expect(result.action).toBe("wrote");
    const manifest = JSON.parse(readFileSync(join(tmp, "package.json"), "utf-8"));
    expect(manifest.dependencies).toEqual({});
  });
});
