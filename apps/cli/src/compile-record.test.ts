/**
 * What a compile records, and how it writes. A compile into the harness's own bundle
 * directory appends one `prepared` deployment whose digest is the build it wrote; a compile
 * anywhere else records nothing. The bundle writer replaces a link at a leaf with a regular
 * file and refuses a linked directory on the way, leaving the link's target untouched.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDeployments } from "@crewhaus/control-records";
import { buildDigest, buildLinkMessage, collectBuildFiles } from "@crewhaus/harness-supervisor";
import { BundleWriteError, probeBundleFile, writeBundleFile } from "./bundle-writer";
import { harnessBundleOf, recordCompiledBundle } from "./compile-record";

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");
const REPO_ROOT = join(SRC_DIR, "..", "..", "..");
const WORKFLOW_FIXTURE = join(REPO_ROOT, "apps/cli/test-fixtures/minimal-workflow");

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

async function compile(
  cwd: string,
  args: readonly string[],
): Promise<{ code: number; out: string }> {
  const registry = tmp("compile-record-registry-");
  const proc = Bun.spawn([process.execPath, "--no-install", CLI_PATH, "compile", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CREWHAUS_REGISTRY_ROOT: registry, CREWHAUS_NO_REGISTRY: "1" },
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out: out + err };
}

describe("crewhaus compile records a prepared deployment", () => {
  test("into dist/ with the eval bridge: one prepared row whose digest is the build it wrote", async () => {
    const harness = tmp("compile-record-");
    cpSync(join(WORKFLOW_FIXTURE, "crewhaus.yaml"), join(harness, "crewhaus.yaml"));
    const result = await compile(harness, [
      "crewhaus.yaml",
      "-o",
      "dist",
      "--with-eval-harness",
      "--no-register",
    ]);
    expect(result.code).toBe(0);
    const read = readDeployments(harness);
    if (read.state !== "present") throw new Error(`no records: ${result.out}`);
    expect(read.records).toHaveLength(1);
    const row = read.records[0] as Record<string, unknown>;
    expect(row["state"]).toBe("prepared");
    const artifact = row["artifact"] as { digest: string; entry: string; specHash: string };
    expect(artifact.entry).toBe("dist/agent.ts");
    expect(artifact.specHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const files = collectBuildFiles(harness, artifact);
    expect(Array.isArray(files) && files.some((f) => f.path.startsWith("dist/eval/"))).toBe(true);
    const fresh = buildDigest(harness, artifact);
    expect("digest" in fresh && fresh.digest).toBe(artifact.digest);
    expect(result.out).toContain(`crewhaus deploy activate ${String(row["id"])}`);
  }, 60_000);

  test("into a directory outside the harness: nothing is recorded anywhere", async () => {
    const harness = tmp("compile-record-");
    const elsewhere = tmp("compile-record-out-");
    cpSync(join(WORKFLOW_FIXTURE, "crewhaus.yaml"), join(harness, "crewhaus.yaml"));
    const result = await compile(harness, ["crewhaus.yaml", "-o", elsewhere, "--no-register"]);
    expect(result.code).toBe(0);
    expect(readDeployments(harness)).toEqual({ state: "absent" });
    expect(readDeployments(elsewhere)).toEqual({ state: "absent" });
  }, 60_000);

  test("a repo spec compiled into a temp dir leaves the repo's fixture directory clean", async () => {
    const out = tmp("compile-record-repo-");
    const result = await compile(out, [
      join(WORKFLOW_FIXTURE, "crewhaus.yaml"),
      "-o",
      out,
      "--no-register",
    ]);
    expect(result.code).toBe(0);
    expect(existsSync(join(WORKFLOW_FIXTURE, ".crewhaus"))).toBe(false);
  }, 60_000);

  test("a linked dist/ refuses the compile and leaves the link's target untouched", async () => {
    const harness = tmp("compile-record-");
    const target = tmp("compile-record-target-");
    writeFileSync(join(target, "agent.ts"), "theirs\n");
    cpSync(join(WORKFLOW_FIXTURE, "crewhaus.yaml"), join(harness, "crewhaus.yaml"));
    symlinkSync(target, join(harness, "dist"));
    const result = await compile(harness, ["crewhaus.yaml", "-o", "dist", "--no-register"]);
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("it is a link");
    expect(readFileSync(join(target, "agent.ts"), "utf8")).toBe("theirs\n");
    expect(readDeployments(harness)).toEqual({ state: "absent" });
  }, 60_000);
});

describe("compile records a build of regular files only", () => {
  function harnessWithDist(): { readonly harness: string; readonly yamlText: string } {
    const harness = tmp("compile-record-links-");
    const yamlText = readFileSync(join(WORKFLOW_FIXTURE, "crewhaus.yaml"), "utf8");
    writeFileSync(join(harness, "crewhaus.yaml"), yamlText);
    mkdirSync(join(harness, "dist"));
    writeFileSync(join(harness, "dist", "agent.ts"), "// bundle\n");
    return { harness, yamlText };
  }
  const record = (harness: string, yamlText: string) =>
    recordCompiledBundle({
      specPath: join(harness, "crewhaus.yaml"),
      outDir: join(harness, "dist"),
      yamlText,
      written: [],
      registryIdOf: () => undefined,
    });

  test("a link in the bundle is named, and nothing is recorded", async () => {
    const { harness, yamlText } = harnessWithDist();
    const outside = tmp("compile-record-outside-");
    writeFileSync(join(outside, "helper.ts"), "// elsewhere\n");
    symlinkSync(join(outside, "helper.ts"), join(harness, "dist", "helper.ts"));
    expect(await record(harness, yamlText)).toEqual({
      recorded: false,
      reason: buildLinkMessage("dist/helper.ts"),
    });
    expect(readDeployments(harness)).toEqual({ state: "absent" });
  });

  test("regular files are recorded", async () => {
    const { harness, yamlText } = harnessWithDist();
    expect(await record(harness, yamlText)).toMatchObject({ recorded: true });
    expect(readDeployments(harness).state).toBe("present");
  });
});

describe("compile records the delegation ceiling", () => {
  function harnessWith(yamlText: string): string {
    const harness = tmp("compile-record-ceiling-");
    writeFileSync(join(harness, "crewhaus.yaml"), yamlText);
    mkdirSync(join(harness, "dist"));
    writeFileSync(join(harness, "dist", "agent.ts"), "// bundle\n");
    return harness;
  }
  const record = (harness: string, yamlText: string) =>
    recordCompiledBundle({
      specPath: join(harness, "crewhaus.yaml"),
      outDir: join(harness, "dist"),
      yamlText,
      written: [],
      registryIdOf: () => undefined,
    });
  const base = readFileSync(join(WORKFLOW_FIXTURE, "crewhaus.yaml"), "utf8");
  const prepared = (harness: string): Record<string, unknown> => {
    const read = readDeployments(harness);
    if (read.state !== "present") throw new Error(read.state);
    return read.records[0] as Record<string, unknown>;
  };

  test("present: the prepared row carries it as the IR has it", async () => {
    const yamlText = `${base.trimEnd()}\npermissions:\n  delegation:\n    max_days: 21\n`;
    const harness = harnessWith(yamlText);
    expect(await record(harness, yamlText)).toMatchObject({ recorded: true });
    expect(prepared(harness)["delegation"]).toEqual({ maxDays: 21 });
  });

  test("absent: the prepared row has no delegation key", async () => {
    const harness = harnessWith(base);
    expect(await record(harness, base)).toMatchObject({ recorded: true });
    expect(prepared(harness)).not.toHaveProperty("delegation");
  });
});

describe("harnessBundleOf", () => {
  test("dist, build and the root are a harness's bundle directories; nothing else is", () => {
    const harness = tmp("compile-record-");
    const spec = join(harness, "crewhaus.yaml");
    expect(harnessBundleOf(spec, join(harness, "dist"))?.bundleRel).toBe("dist");
    expect(harnessBundleOf(spec, join(harness, "build"))?.bundleRel).toBe("build");
    expect(harnessBundleOf(spec, harness)?.bundleRel).toBe(".");
    expect(harnessBundleOf(spec, join(harness, "out"))).toBeUndefined();
    expect(harnessBundleOf(spec, tmp("elsewhere-"))).toBeUndefined();
  });
});

describe("the bundle writer", () => {
  for (const leaf of ["agent.ts", "package.json", "eval/agent.ts"]) {
    test(`a link planted at ${leaf} is replaced by a regular file; its target is untouched`, () => {
      const out = tmp("bundle-writer-");
      const target = join(tmp("bundle-writer-target-"), "victim.txt");
      writeFileSync(target, "untouched\n");
      mkdirSync(join(out, "eval"), { recursive: true });
      symlinkSync(target, join(out, leaf));
      expect(probeBundleFile(out, leaf)).toEqual({ kind: "other" });
      writeBundleFile(out, leaf, "ours\n");
      expect(lstatSync(join(out, leaf)).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(out, leaf), "utf8")).toBe("ours\n");
      expect(readFileSync(target, "utf8")).toBe("untouched\n");
    });
  }

  test("a linked directory on the way refuses, naming it", () => {
    const out = tmp("bundle-writer-");
    const target = tmp("bundle-writer-target-");
    symlinkSync(target, join(out, "eval"));
    expect(() => writeBundleFile(out, "eval/agent.ts", "x")).toThrow(BundleWriteError);
    expect(() => writeBundleFile(out, "eval/agent.ts", "x")).toThrow("it is a link");
    expect(existsSync(join(target, "agent.ts"))).toBe(false);
  });

  test("a path that leaves the output directory is refused", () => {
    const out = tmp("bundle-writer-");
    expect(() => writeBundleFile(out, "../escape.ts", "x")).toThrow(BundleWriteError);
  });
});
