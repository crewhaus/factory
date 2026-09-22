/**
 * The seam, tested directly: the couplings this package mirrors from
 * `@crewhaus/spec-registry`, the tri-state reads, and the one place a
 * decision is evaluated twice.
 *
 * Three of these tests exist to FAIL when an upstream package changes rather
 * than to describe this one:
 *
 *   - the filename coupling. Containment needs the registry's on-disk names,
 *     and the registry does not export them. They are mirrored in
 *     `lib/registry.ts`, and asserted here against what the real adapter
 *     actually writes — so a rename upstream breaks a test instead of quietly
 *     leaving a write path uncontained.
 *   - the prediction agreement. `SpecPin`'s dry run has to say what
 *     `autoRegisterSpecVersion` would do without letting it write, so it
 *     re-evaluates that decision using the changelog package's own
 *     `contentHash`. Here the prediction and the real call are run against the
 *     same registry in every case that matters and required to agree.
 *   - the list()-is-not-presence gap. `deployment-controller`'s rollback guard
 *     is `list(name).includes(version)`; this asserts that guard passes for a
 *     version whose file is gone, which is why `probeVersion` exists.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createDeploymentController } from "@crewhaus/deployment-controller";
import { autoRegisterSpecVersion, nextVersion } from "@crewhaus/spec-changelog";
import { createFileBackedRegistry } from "@crewhaus/spec-registry";
import {
  CHANGELOG_FILENAME,
  MANIFEST_FILENAME,
  TENANTS_DIRNAME,
  predictRegistration,
  probeTenantOverlay,
  probeVersion,
  readManifest,
  resolveName,
  versionFilename,
} from "./lib/registry";
import { probeName } from "./lib/result";

const originalCwd = process.cwd();
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-tool-deploy-lib-"));
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

const ROOT_REL = ".crewhaus/specs";
const rootAbs = (): string => path.join(tmp, ROOT_REL);
const openRegistry = () => createFileBackedRegistry({ rootDir: rootAbs() });
const named = (given: string) => {
  const r = resolveName(given);
  if (!r.ok) throw new Error(`resolveName refused ${given}: ${r.reason}`);
  return r.value;
};

// ---------------------------------------------------------------------------
// the mirrored filenames
// ---------------------------------------------------------------------------

test("the mirrored on-disk names are the ones the real registry and changelog write", async () => {
  const registry = openRegistry();
  const result = await autoRegisterSpecVersion({
    registry,
    registryRootDir: rootAbs(),
    specName: "demo",
    yaml: "name: demo\n",
  });
  expect(result).toEqual({ status: "registered", name: "demo", version: "v1" });

  // If any of these three move, containment stops covering a path the
  // registry writes — so this asserts the real layout, not the constants.
  const specDir = path.join(rootAbs(), "demo");
  expect(existsSync(path.join(specDir, MANIFEST_FILENAME))).toBe(true);
  expect(existsSync(path.join(specDir, CHANGELOG_FILENAME))).toBe(true);
  expect(existsSync(path.join(specDir, versionFilename("v1")))).toBe(true);

  await registry.pinForTenant("acme", "demo", "prod", "v1");
  expect(existsSync(path.join(rootAbs(), TENANTS_DIRNAME, "acme", "demo.json"))).toBe(true);
});

// ---------------------------------------------------------------------------
// names
// ---------------------------------------------------------------------------

test("a spec name is resolved to the name the registry will really use", () => {
  const mapped = named("Brewbird Support");
  expect(mapped.registryName).toBe("Brewbird-Support");
  expect(mapped.mapped).toBe(true);
  const plain = named("demo");
  expect(plain).toEqual({ given: "demo", registryName: "demo", mapped: false });
});

test("a name that maps onto the shared fallback directory is refused, not mapped", () => {
  // registrySpecName strips leading dots and falls back to the CONSTANT
  // "spec" when nothing is left — so "..", "..." and "." all land in one
  // directory, sharing a manifest and every environment pin, whatever the
  // caller thought they were naming.
  for (const given of ["..", "...", "."]) {
    const r = resolveName(given);
    expect({ given, ok: r.ok }).toEqual({ given, ok: false });
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("bad-input");
    // The REASON, because a generic refusal would also stop the call without
    // telling the caller their two specs would share one directory.
    expect(r.reason).toContain('fallback "spec"');
  }
  // A name that maps to something usable is NOT refused, even when the
  // mapping changed it beyond recognition: that is reported, not blocked.
  const odd = resolveName("///");
  expect(odd.ok).toBe(true);
  if (!odd.ok) throw new Error("unreachable");
  expect(odd.value.registryName).toBe("-");
  expect(odd.value.mapped).toBe(true);
});

test("a NUL in a spec name is refused before it becomes a path component", () => {
  const r = resolveName(`a${String.fromCharCode(0)}b`);
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("unreachable");
  expect(r.reason).toContain("NUL byte");
  // The refusal itself must not carry the raw byte into the message.
  expect(r.reason.includes(String.fromCharCode(0))).toBe(false);
});

// ---------------------------------------------------------------------------
// tri-state reads
// ---------------------------------------------------------------------------

test("an absent manifest, a readable one and an unparseable one are three answers", async () => {
  const registry = openRegistry();
  expect((await readManifest(registry, rootAbs(), named("demo"))).state).toBe("absent");

  await registry.put("demo", "v1", "name: demo\n");
  const known = await readManifest(registry, rootAbs(), named("demo"));
  expect(known.state).toBe("known");
  if (known.state !== "known") throw new Error("unreachable");
  expect(known.manifest.versions).toEqual(["v1"]);

  writeFileSync(path.join(rootAbs(), "demo", MANIFEST_FILENAME), "{ not json");
  const broken = await readManifest(registry, rootAbs(), named("demo"));
  expect(broken.state).toBe("unknown");
  if (broken.state !== "unknown") throw new Error("unreachable");
  expect(broken.failure.code).toBe("unreadable");
  // Never "no versions": that is the answer that repoints an environment.
  expect(broken.failure.reason).not.toContain("no versions");
});

test("a manifest whose versions field is the wrong shape is unknown, not empty", async () => {
  const registry = openRegistry();
  mkdirSync(path.join(rootAbs(), "demo"), { recursive: true });
  writeFileSync(
    path.join(rootAbs(), "demo", MANIFEST_FILENAME),
    JSON.stringify({ versions: null, pins: {} }),
  );
  const state = await readManifest(registry, rootAbs(), named("demo"));
  expect(state.state).toBe("unknown");
  if (state.state !== "unknown") throw new Error("unreachable");
  expect(state.failure.reason).toContain('"versions"');
});

test("a dangling symlink at manifest.json reads as absent to the registry, and as unknown here", async () => {
  const registry = openRegistry();
  mkdirSync(path.join(rootAbs(), "demo"), { recursive: true });
  const manifestPath = path.join(rootAbs(), "demo", MANIFEST_FILENAME);
  symlinkSync(path.join(tmp, "nowhere.json"), manifestPath);

  // The registry itself cannot tell: its `existsSync` follows the link.
  expect(await registry.manifest("demo")).toEqual({ versions: [], pins: {} });
  // Which is exactly why the probe is `lstat`.
  expect(probeName(manifestPath)).toEqual({ kind: "symlink", dangling: true });

  const state = await readManifest(registry, rootAbs(), named("demo"));
  expect(state.state).toBe("unknown");
  if (state.state !== "unknown") throw new Error("unreachable");
  expect(state.failure.reason).toContain("symlink");
});

// ---------------------------------------------------------------------------
// list() is not presence
// ---------------------------------------------------------------------------

test("a version whose file is gone is still 'in the registry' to list(), and to rollback's own guard", async () => {
  const registry = openRegistry();
  await registry.put("demo", "v1", "name: demo\n");
  await registry.put("demo", "v2", "name: demo\nx: 1\n");
  await registry.pin("demo", "prod", "v2");
  rmSync(path.join(rootAbs(), "demo", versionFilename("v1")));

  // The manifest still lists it, so the controller's only guard passes...
  expect(await registry.list("demo")).toContain("v1");
  const controller = createDeploymentController({ registry });
  const record = await controller.rollback("demo", "prod", "v1");
  expect(record.toVersion).toBe("v1");
  // ...and prod now resolves to a version whose content cannot be fetched.
  expect(await registry.aliasFor("demo", "prod")).toBe("v1");
  await expect(registry.get("demo", "v1")).rejects.toThrow();

  // Which is what probeVersion is for.
  expect(await probeVersion(registry, rootAbs(), "demo", "v1")).toEqual({ state: "missing" });
  const live = await probeVersion(registry, rootAbs(), "demo", "v2");
  expect(live.state).toBe("retrievable");
});

test("probeVersion keeps a missing version apart from one it could not read", async () => {
  const registry = openRegistry();
  await registry.put("demo", "v1", "name: demo\n");
  expect(await probeVersion(registry, rootAbs(), "demo", "v9")).toEqual({ state: "missing" });

  rmSync(path.join(rootAbs(), "demo", versionFilename("v1")));
  mkdirSync(path.join(rootAbs(), "demo", versionFilename("v1")));
  const dir = await probeVersion(registry, rootAbs(), "demo", "v1");
  expect(dir.state).toBe("unreadable");
  if (dir.state !== "unreadable") throw new Error("unreachable");
  expect(dir.reason).toContain("not a regular file");
});

// ---------------------------------------------------------------------------
// the prediction
// ---------------------------------------------------------------------------

/**
 * The dry-run prediction and the real registration must agree. They are two
 * evaluations of a decision `@crewhaus/spec-changelog` owns, so this is the
 * test that catches them drifting — the failure mode the tool also reports at
 * run time via `predictionHeld`.
 *
 * Budget: this registers 30 versions and content-scans all of them on each
 * prediction, and CI is a loaded two-core box. It asserts the work done (the
 * agreement), never elapsed time.
 */
test("the registration prediction matches what autoRegisterSpecVersion really does", async () => {
  const registry = openRegistry();
  const cases: Array<{ yaml: string; label: string }> = [
    { yaml: "name: demo\n", label: "first version" },
    { yaml: "name: demo\n", label: "identical content again" },
    { yaml: "name: demo\nx: 1\n", label: "changed content" },
    { yaml: "name: demo\n", label: "back to an earlier content" },
  ];
  for (let i = 0; i < 30; i++) cases.push({ yaml: `name: demo\nn: ${i}\n`, label: `fill ${i}` });
  cases.push({ yaml: "name: demo\nn: 7\n", label: "an old fill, re-registered" });

  for (const c of cases) {
    const manifest = await registry.manifest("demo");
    const predicted = await predictRegistration(
      registry,
      "demo",
      manifest.versions,
      c.yaml,
      nextVersion(manifest.versions),
    );
    const actual = await autoRegisterSpecVersion({
      registry,
      registryRootDir: rootAbs(),
      specName: "demo",
      yaml: c.yaml,
    });
    const predictedStatus = predicted.outcome === "unchanged" ? "unchanged" : "registered";
    expect({
      label: c.label,
      status: predictedStatus,
      version: predicted.outcome === "undetermined" ? "?" : predicted.version,
    }).toEqual({ label: c.label, status: actual.status, version: actual.version });
  }
}, 30_000);

test("a version that cannot be read makes the prediction undetermined, not 'would register'", async () => {
  const registry = openRegistry();
  await registry.put("demo", "v1", "name: demo\n");
  const versionPath = path.join(rootAbs(), "demo", versionFilename("v1"));
  rmSync(versionPath);
  // A directory where the version file should be: `get` throws an errno
  // error rather than the registry's own not-found, so the content behind it
  // is genuinely unknown.
  mkdirSync(versionPath);

  const predicted = await predictRegistration(registry, "demo", ["v1"], "name: demo\n", "v2");
  expect(predicted.outcome).toBe("undetermined");
  if (predicted.outcome !== "undetermined") throw new Error("unreachable");
  expect(predicted.reason).toContain("may or may not already be stored");
});

// ---------------------------------------------------------------------------
// the tenant overlay's NAME
// ---------------------------------------------------------------------------

test("probeTenantOverlay answers about the name the real adapter writes, and keeps 'could not tell' apart from 'absent'", async () => {
  const registry = openRegistry();
  await autoRegisterSpecVersion({
    registry,
    registryRootDir: rootAbs(),
    specName: "demo",
    yaml: "name: demo\n",
  });
  await registry.pin("demo", "prod", "v1");

  // Absent is the only DEFINITE answer, and it is the one that matters: with
  // no overlay file, `aliasForTenant` can only be returning the global pin.
  expect(probeTenantOverlay(rootAbs(), "acme", "demo")).toEqual({ state: "absent" });
  expect(await registry.aliasForTenant("acme", "demo", "prod")).toBe("v1");

  // Driven through the REAL adapter, so a rename upstream fails here rather
  // than turning this probe into a permanent "absent".
  await registry.pinForTenant("acme", "demo", "prod", "v1");
  expect(probeTenantOverlay(rootAbs(), "acme", "demo")).toEqual({ state: "present" });

  // A dangling link is the case where the registry itself cannot tell: its
  // `existsSync` follows the link and answers false, so the alias falls
  // through to the global pin while `pinForTenant` through the same name
  // would CREATE the target.
  const dir = path.join(rootAbs(), TENANTS_DIRNAME, "beta");
  mkdirSync(dir, { recursive: true });
  symlinkSync(path.join(tmp, "nowhere.json"), path.join(dir, "demo.json"));
  const dangling = probeTenantOverlay(rootAbs(), "beta", "demo");
  expect(dangling.state).toBe("unknown");
  expect(dangling.state === "unknown" ? dangling.reason : "").toContain("symlink");
  // The registry really cannot tell these apart, which is why the probe is
  // by name rather than by asking it.
  expect(await registry.aliasForTenant("beta", "demo", "prod")).toBe("v1");
});
