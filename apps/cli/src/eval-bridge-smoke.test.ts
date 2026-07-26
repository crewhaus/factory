/**
 * Evals Wave 4, cluster S (D36 + NEW-shape-1) — bridged-bundle smoke: fixture
 * specs for the four multi-stage shapes compile through
 * `crewhaus compile --with-eval-harness`, and the emitted bundles' runtime
 * entries are then driven with a scripted provider adapter — the shape's
 * ACTUAL compiled runtime runs (workflow steps / graph nodes / crew
 * orchestrator / indexed pipeline), no credentials, no network.
 *
 * The drive happens in a spawned `bun` subprocess
 * (test-fixtures/bridge-smoke/driver.ts): under `bun run`, a compiled bundle
 * in a manifest-free tmp dir resolves its `@crewhaus/*` imports against the
 * in-tree workspace, which `bun test`'s resolver does not do for out-of-tree
 * files. The driver prints one `RESULT:{json}` line the tests assert on.
 *
 * Sandboxing: every bundle + eval artifact lands in an os.tmpdir mkdtemp; the
 * emitted package.json is removed before import (a manifest-carrying dir opts
 * out of Bun's cwd-workspace resolution, and the smoke wants the in-tree
 * packages, not published ones).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");
const REPO_ROOT = join(import.meta.dir, "../../..");
const DRIVER_PATH = join(REPO_ROOT, "apps/cli/test-fixtures/bridge-smoke/driver.ts");
const FIXTURE = (name: string) => join(REPO_ROOT, `apps/cli/test-fixtures/${name}/crewhaus.yaml`);

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function newTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function spawnBun(args: ReadonlyArray<string>): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn([process.execPath, ...args], {
    cwd: REPO_ROOT,
    env: { PATH: process.env["PATH"] ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Compile a fixture with the eval harness into a fresh tmp dir and strip the
 *  pinned manifests so the driver's import resolves the in-tree workspace. */
async function compileBridged(fixture: string): Promise<string> {
  const out = newTmp("bridge-smoke-");
  const r = await spawnBun([
    CLI_PATH,
    "compile",
    FIXTURE(fixture),
    "--with-eval-harness",
    "--no-register",
    "-o",
    out,
  ]);
  if (r.exitCode !== 0) throw new Error(`compile failed (${r.exitCode}): ${r.stdout}\n${r.stderr}`);
  rmSync(join(out, "package.json"), { force: true });
  rmSync(join(out, "eval", "package.json"), { force: true });
  return out;
}

/** Run the smoke driver for one shape and parse its RESULT line. */
async function drive(mode: string, bundleDir: string): Promise<Record<string, unknown>> {
  const r = await spawnBun([DRIVER_PATH, mode, bundleDir]);
  if (r.exitCode !== 0) throw new Error(`driver ${mode} failed (${r.exitCode}): ${r.stderr}`);
  const line = r.stdout.split("\n").find((l) => l.startsWith("RESULT:"));
  if (line === undefined) throw new Error(`driver ${mode} printed no RESULT line: ${r.stdout}`);
  return JSON.parse(line.slice("RESULT:".length)) as Record<string, unknown>;
}

describe("eval bridge smoke — workflow (workflow-run)", () => {
  test("the compiled workflow runs end-to-end per sample; step events land on the runner bus and in the sample artifacts", async () => {
    const out = await compileBridged("minimal-workflow");
    // The emitted eval bundle drives the REAL compiled runtime.
    const evalAgent = readFileSync(join(out, "eval", "agent.ts"), "utf-8");
    expect(evalAgent).toContain('import * as __entry from "../agent.ts";');
    expect(evalAgent).toContain(
      'const BRIDGE = { sourceTarget: "workflow", kind: "workflow-run", chatCapable: false } as const;',
    );
    expect(evalAgent).toContain("invoker: __invoker,");
    // The primary bundle exports the entry AND keeps its CLI guarded.
    const agent = readFileSync(join(out, "agent.ts"), "utf-8");
    expect(agent).toContain("export async function runForEval(");
    expect(agent).toContain("if (import.meta.main) {");

    const r = await drive("workflow", out);
    expect(r["hasRunForEval"]).toBe(true);
    // Step 2's output is the graded output; its seed is step 1's output.
    expect(String(r["agentOutput"])).toContain("wf:");
    expect(String(r["agentOutput"])).toContain("Output of previous step");
    // Real-runtime invocation: BOTH compiled steps ran on the per-sample bus.
    expect(r["modelResponses"]).toBe(2);
    expect(r["hasTurnStart"]).toBe(true);
    // Full runEval through the bridge invoker: graded + artifacts persisted.
    expect(r["passRate"]).toBe(1);
    expect(r["persistedModelResponses"]).toBe(2);
  }, 240_000);
});

describe("eval bridge smoke — graph (graph-run)", () => {
  test("the compiled graph drives to run_done; both node outputs land in the graded state JSON", async () => {
    const out = await compileBridged("minimal-graph");
    const r = await drive("graph", out);
    const state = r["state"] as Record<string, unknown>;
    expect(String(state["plan"])).toContain("node:");
    expect(String(state["answer"])).toContain("node:");
    expect(r["modelResponses"]).toBe(2);
  }, 240_000);
});

describe("eval bridge smoke — crew (crew-run)", () => {
  test("one crew turn runs through the compiled orchestrator; crew_done.finalOutput is returned", async () => {
    const out = await compileBridged("minimal-crew");
    expect(existsSync(join(out, "eval-entry.ts"))).toBe(true);
    const r = await drive("crew", out);
    expect(r["output"]).toBe("crew:say hi");
    // The crew's REAL session machinery wrote its transcript under the
    // caller's session root (the per-sample artifact dir in an eval run).
    const sessionRoot = String(r["sessionRoot"]);
    tempDirs.push(sessionRoot);
    const logs = readdirSync(sessionRoot).filter((f) => f.endsWith(".jsonl"));
    expect(logs.length).toBeGreaterThan(0);
  }, 240_000);
});

describe("eval bridge smoke — pipeline (pipeline-query)", () => {
  test("one query runs through the indexed pipeline agent; history seeds ahead of the graded input", async () => {
    const out = await compileBridged("minimal-pipeline");
    const r = await drive("pipeline", out);
    // The adapter reads the LAST user message — the graded final input, not
    // the seeded history.
    expect(r["output"]).toBe("rag:what does the fox do?");
    expect(r["modelResponses"]).toBe(1);
  }, 240_000);
});

describe("eval bridge — cf-worker emission stays rejected", () => {
  test("--emit-as cf-worker cannot combine with --with-eval-harness", async () => {
    const out = newTmp("cf-reject-");
    const r = await spawnBun([
      CLI_PATH,
      "compile",
      FIXTURE("minimal-workflow"),
      "--emit-as",
      "cf-worker",
      "--with-eval-harness",
      "-o",
      out,
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("cf-worker cannot combine with --with-eval-harness");
  }, 60_000);
});
