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
import {
  BUNDLE_MANIFEST_NAME,
  compareBundleSpecHash,
  ensureBundleManifest,
  hashSpecSource,
  readBundleSpecStamp,
} from "./bundle-manifest";
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

  test("a SUBPATH import pins its package, not the subpath", () => {
    // The bridged eval bundle imports `@crewhaus/target-eval-bundle/runtime`
    // (the two runtime helpers, without the codegen tree behind the root
    // entry). The dependency is still the PACKAGE — pinning the subpath, or
    // dropping it entirely, would leave the emitted manifest uninstallable.
    const bridged = {
      path: "agent.ts",
      content:
        'import { runEval } from "@crewhaus/eval-runner";\n' +
        'import { createBridgeInvoker } from "@crewhaus/target-eval-bundle/runtime";\n',
    };
    const result = ensureBundleManifest([bridged], tmp);
    const manifest = JSON.parse(readFileSync(result.path, "utf-8"));
    expect(manifest.dependencies).toEqual({
      "@crewhaus/eval-runner": cliVersion(),
      "@crewhaus/target-eval-bundle": cliVersion(),
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

/**
 * F-5 — the spec-hash provenance stamp. Before it, the only "is this bundle
 * stale?" signal was file mtimes, and mtimes lie across `git checkout`, file
 * copies and clock skew. The stamp makes the answer exact.
 */
describe("bundle spec stamp (F-5)", () => {
  const SPEC = "name: acme\ntarget: cli\nagent:\n  model: m\n  instructions: hi\n";

  test("hashSpecSource is stable, prefixed, and ignores line-ending + trailing-newline noise", () => {
    const h = hashSpecSource(SPEC);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashSpecSource(SPEC)).toBe(h);
    // A Windows checkout of the same file is the same spec.
    expect(hashSpecSource(SPEC.replace(/\n/g, "\r\n"))).toBe(h);
    // So is one an editor re-saved with(out) a final newline.
    expect(hashSpecSource(SPEC.replace(/\n$/, ""))).toBe(h);
    // Anything else IS a change — block scalars carry whitespace into
    // instructions, so treating it as insignificant would hide real drift.
    expect(hashSpecSource(SPEC.replace("hi", "hi "))).not.toBe(h);
  });

  test("a compile with a spec source stamps specHash + compiledWith", () => {
    const result = ensureBundleManifest([AGENT], tmp, { specYaml: SPEC });
    expect(result.action).toBe("wrote");
    const manifest = JSON.parse(readFileSync(result.path, "utf-8"));
    expect(manifest.crewhaus).toEqual({
      specHash: hashSpecSource(SPEC),
      compiledWith: cliVersion(),
    });
    // The pin list is unaffected — the stamp is additive.
    expect(manifest.dependencies).toEqual({
      "@crewhaus/queue-protocol": cliVersion(),
      "@crewhaus/runtime-core": cliVersion(),
    });
  });

  test("no spec source ⇒ no stamp, so pre-F-5 call paths stay byte-identical", () => {
    const result = ensureBundleManifest([AGENT], tmp);
    const raw = readFileSync(result.path, "utf-8");
    expect(raw).not.toContain('crewhaus":');
    expect(JSON.parse(raw).crewhaus).toBeUndefined();
  });

  test("a re-ensure with no spec source CARRIES the stamp forward", () => {
    // This is the `compile --check` path: the compile stamps, then the check
    // re-ensures the manifest moments later with no spec in hand.
    ensureBundleManifest([AGENT], tmp, { specYaml: SPEC });
    ensureBundleManifest([AGENT], tmp);
    expect(readBundleSpecStamp(tmp)?.specHash).toBe(hashSpecSource(SPEC));
  });

  test("the stamp is deterministic — recompiling the same spec is not a diff", () => {
    const first = readFileSync(
      ensureBundleManifest([AGENT], tmp, { specYaml: SPEC }).path,
      "utf-8",
    );
    const second = readFileSync(
      ensureBundleManifest([AGENT], tmp, { specYaml: SPEC }).path,
      "utf-8",
    );
    expect(second).toBe(first);
  });

  test("readBundleSpecStamp refuses manifests this synthesizer did not write", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "my-harness", crewhaus: { specHash: "sha256:deadbeef" } }),
    );
    expect(readBundleSpecStamp(tmp)).toBeUndefined();
  });

  test("readBundleSpecStamp returns undefined for missing / malformed / pre-F-5 manifests", () => {
    expect(readBundleSpecStamp(join(tmp, "nope"))).toBeUndefined();
    writeFileSync(join(tmp, "package.json"), "not json {");
    expect(readBundleSpecStamp(tmp)).toBeUndefined();
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: BUNDLE_MANIFEST_NAME, dependencies: {} }),
    );
    expect(readBundleSpecStamp(tmp)).toBeUndefined();
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: BUNDLE_MANIFEST_NAME, crewhaus: { specHash: 7 } }),
    );
    expect(readBundleSpecStamp(tmp)).toBeUndefined();
  });
});

describe("compareBundleSpecHash — stale vs fresh, exactly", () => {
  const SPEC = "name: acme\ntarget: cli\nagent:\n  model: m\n  instructions: hi\n";

  test("an unchanged spec reads fresh and reports what compiled it", () => {
    ensureBundleManifest([AGENT], tmp, { specYaml: SPEC });
    expect(compareBundleSpecHash({ specYaml: SPEC, outDir: tmp })).toEqual({
      state: "fresh",
      specHash: hashSpecSource(SPEC),
      compiledWith: cliVersion() as string,
    });
  });

  test("an edited spec reads stale and names both hashes", () => {
    ensureBundleManifest([AGENT], tmp, { specYaml: SPEC });
    const edited = SPEC.replace("instructions: hi", "instructions: hello");
    const verdict = compareBundleSpecHash({ specYaml: edited, outDir: tmp });
    expect(verdict.state).toBe("stale");
    expect(verdict).toMatchObject({
      specHash: hashSpecSource(edited),
      bundleSpecHash: hashSpecSource(SPEC),
    });
  });

  test("a re-checkout that only rewrites mtimes (or line endings) stays fresh", () => {
    ensureBundleManifest([AGENT], tmp, { specYaml: SPEC });
    // This is the case the mtime heuristic gets wrong: `git checkout` rewrites
    // every mtime, and a Windows checkout rewrites every line ending, while
    // the spec itself is untouched.
    const reChecked = SPEC.replace(/\n/g, "\r\n");
    expect(compareBundleSpecHash({ specYaml: reChecked, outDir: tmp }).state).toBe("fresh");
  });

  test("a pre-F-5 bundle reads `unstamped`, never `stale`", () => {
    // An older crewhaus wrote no stamp; nagging every operator who has not
    // recompiled since upgrading would be worse than saying "no exact answer".
    ensureBundleManifest([AGENT], tmp);
    expect(compareBundleSpecHash({ specYaml: SPEC, outDir: tmp })).toEqual({ state: "unstamped" });
  });
});
