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
 *
 * The spawn cwd is a mkdtemp sandbox too, NOT the repo root. Whatever the
 * driven runtime fails to pin lands in `<cwd>/.crewhaus` — the crew shape's
 * sub-agent sessions, the graph shape's `graphs/` checkpoints, the gateway
 * `prompt-cache/` entry all did — and with cwd at the repo root that was
 * written straight into the operator's checkout, hidden by `.gitignore`.
 * Sandboxing the cwd contains them without weakening resolution: the root
 * `node_modules` holds no `@crewhaus/*` entries under the isolated install
 * layout, so a repo-root cwd never resolved the workspace for these
 * out-of-tree bundles in the first place — `@crewhaus/runtime-core` resolves
 * to the same file from either cwd.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

/** The spawn cwd for every compile/drive subprocess — see the file header. */
const SPAWN_CWD = newTmp("crewhaus-bridge-cwd-");

/**
 * Hermetic harness registry for every spawn in this file.
 *
 * `run`/`compile`/`eval`/`dev` self-register the harness they touch, and for
 * a spec passed by path that is the SPEC's directory — every fixture here
 * lives under `apps/cli/test-fixtures/`, inside the repo. The default
 * registry root's ephemeral-cwd guard cannot help (it looks at the cwd, not
 * at the spec dir), so without this every run of this file writes a row per
 * fixture into the developer's real `~/.crewhaus/harnesses.json`.
 */
const REGISTRY_ROOT = newTmp("crewhaus-bridge-reg-");
const HERMETIC_REGISTRY: Record<string, string> = {
  CREWHAUS_REGISTRY_ROOT: join(REGISTRY_ROOT, "registry"),
  CREWHAUS_WATCHME_ROOT: join(REGISTRY_ROOT, "watchme"),
};

/**
 * Link the in-tree `@crewhaus/*` packages into the spawn sandbox, so the
 * driven bundle resolves THIS working tree.
 *
 * The header above promises "the in-tree packages, not published ones", and
 * until now nothing delivered it: an out-of-tree bundle in a manifest-free
 * tmp dir resolved nothing, so Bun's auto-install quietly fetched
 * `@crewhaus/*` from npm and the smoke measured the last RELEASE. That is how
 * 0.5.5 shipped a `runtime-core` that could not resolve `zod` with every gate
 * green — and it also meant a release could never be verified before it was
 * published, because the newest thing on npm was always the previous cut.
 *
 * Symlinks (not copies) so external deps still resolve: a symlink resolves to
 * its real path under `packages/`, and the lookup then walks up to the repo
 * root's `node_modules` for `zod`, the Anthropic SDK, and friends. Paired
 * with `--no-install` on the spawn, which makes a MISSING link fail loudly
 * instead of silently reaching for the registry.
 */
function linkWorkspacePackages(sandbox: string): void {
  const nodeModules = join(sandbox, "node_modules");
  for (const entry of readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(REPO_ROOT, "packages", entry.name);
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) continue;
    const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
    if (name === undefined || !name.startsWith("@crewhaus/")) continue;
    const dest = join(nodeModules, name);
    mkdirSync(dirname(dest), { recursive: true });
    if (!existsSync(dest)) symlinkSync(dir, dest, "dir");
  }
}

async function spawnBun(args: ReadonlyArray<string>): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  // `--no-install` enforces what this file's header already promised: the
  // smoke drives the IN-TREE packages. Without it, the sandbox cwd has no
  // node_modules, so Bun's auto-install silently fetches @crewhaus/* from
  // npm and the smoke measures the last PUBLISHED release instead of the
  // working tree — which is how 0.5.5 shipped a runtime-core that could not
  // resolve `zod` with every gate green. It also makes the smoke offline.
  const proc = Bun.spawn([process.execPath, "--no-install", ...args], {
    cwd: SPAWN_CWD,
    env: { PATH: process.env["PATH"] ?? "", ...HERMETIC_REGISTRY },
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
  // Bun resolves a bare import from the IMPORTING FILE's directory upward, so
  // the links belong beside the bundle, not beside the spawn cwd.
  linkWorkspacePackages(out);
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
      'const BRIDGE = { sourceTarget: "workflow", kind: "workflow-run", chatCapable: false, entryImport: "../agent.ts" } as const;',
    );
    // Run identity tracks the DRIVEN stages, not just the stage count.
    expect(evalAgent).toMatch(/step digest: [0-9a-f]{16} /);
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
    // An exported CREWHAUS_RUN_ID must not make samples dedup against each
    // other: the SECOND invocation under a pinned run id still runs both
    // steps and returns its own output, not the first invocation's.
    expect(r["pinnedRunIdSecondModelResponses"]).toBe(2);
    expect(String(r["pinnedRunIdSecondOutput"])).toContain("second:");
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
    // The node session log lands in the caller's per-sample dir — the file
    // runSample reads to build transcript.jsonl (turns, tool-call accuracy and
    // Wave-2 `target: transcript` judges all depend on it) — and NOT in the
    // operator's working directory.
    expect(r["sampleSessionLogs"]).toBeGreaterThan(0);
    expect(r["cwdSessionsAdded"]).toBe(0);
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

describe("eval bridge smoke — channel (channel-resume-turn)", () => {
  test("both a history-less and a history-carrying sample run through the REAL runTurn", async () => {
    const out = await compileBridged("minimal-channel");
    expect(existsSync(join(out, "eval-entry.ts"))).toBe(true);
    const evalAgent = readFileSync(join(out, "eval", "agent.ts"), "utf-8");
    expect(evalAgent).toContain('import * as __entry from "../eval-entry.ts";');
    expect(evalAgent).toContain("invoker: __invoker,");

    const r = await drive("channel", out);
    expect(r["hasRunForEval"]).toBe(true);
    // (a) fresh session.
    expect(r["freshOutput"]).toBe("chan:first ask");
    // (b) the RESUME path — this is the combination the bridge advertises and
    // it used to die at `sessionStore.get()` because the eval entry seeded an
    // event log without ever creating the session record.
    expect(r["resumeOutput"]).toBe("chan:follow-up");
    // The session RECORD + transcript both live in the per-sample dir.
    const sessionId = String(r["resumeSessionId"]);
    expect(r["resumeFiles"]).toContain(`${sessionId}.json`);
    expect(r["resumeFiles"]).toContain(`${sessionId}.jsonl`);
    expect(r["freshFiles"]).toContain(`${String(r["freshSessionId"])}.jsonl`);
    // The seeded turn is really in the transcript, ahead of the graded input.
    expect(r["resumeUserMessages"]).toEqual(["hello", "follow-up"]);
  }, 240_000);
});

describe("eval bridge smoke — managed (gateway-request)", () => {
  test("both sample kinds run through the gateway's runOneTurn dispatcher", async () => {
    const out = await compileBridged("minimal-managed");
    const evalAgent = readFileSync(join(out, "eval", "agent.ts"), "utf-8");
    expect(evalAgent).toContain('import * as __entry from "../agent.ts";');
    expect(evalAgent).toContain(
      'const BRIDGE = { sourceTarget: "managed", kind: "gateway-request", chatCapable: true, entryImport: "../agent.ts" } as const;',
    );

    const r = await drive("managed", out);
    expect(r["hasRunOneTurn"]).toBe(true);
    expect(r["freshOutput"]).toBe("mg:first ask");
    expect(r["freshModelResponses"]).toBe(1);
    // history rides extraOptions.seedMessages and OVERRIDES the dispatcher's
    // single seed (extraOptions spreads last) — asserted on the real bundle,
    // not on a hand-written stub.
    expect(r["historyOutput"]).toBe("mg:follow-up");
    expect(r["historyUserMessages"]).toEqual(["hello", "follow-up"]);
    // Per-sample artifacts: the transcript + the isolated tenant root.
    const sessionId = String(r["historySessionId"]);
    expect(r["historyFiles"]).toContain(`${sessionId}.jsonl`);
    expect(r["historyFiles"]).toContain("tenants");
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
