/**
 * `classifyRunId` fed by the real minters. A hand-written id cannot catch a
 * minter's real shape, so no id here is typed by hand. Each source is run, or for an emitted mint, its
 * expression is read from the source that prints it and from the byte-pinned
 * fixture that shows what it printed, and then that exact text is run.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newGraphRunId } from "../packages/checkpoint-store/src/index";
import { newRunId as citationRunId } from "../packages/citation-tracker/src/index";
import { lower } from "../packages/compiler/src/index";
import {
  CANONICAL_RUN_ID_RE,
  EXECUTION_RUN_ID_RE,
  HARNESS_ID_RE,
  classifyRunId,
  mintRunId,
} from "../packages/control-contract/src/index";
import { parseGradersConfig } from "../packages/eval-grader/src/index";
import { runEval } from "../packages/eval-runner/src/index";
import { runIdForJob } from "../packages/hangar-server/src/runtime-ops";
import { HARNESS_ID_RE as REGISTRY_HARNESS_ID_RE } from "../packages/harness-registry/src/index";
import {
  RUN_ID_RE as SUPERVISOR_RUN_ID_RE,
  newRunId as supervisorRunId,
} from "../packages/harness-supervisor/src/index";
import type { IrV0 } from "../packages/ir/src/index";
import { createRunContext } from "../packages/run-context/src/index";
import { parseSpec } from "../packages/spec/src/index";

const ROOT = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const RUNS = 1_000;

function familyOf(mint: () => string, runs = RUNS): Set<string> {
  const families = new Set<string>();
  for (let i = 0; i < runs; i++) families.add(classifyRunId(mint()).family);
  return families;
}

/** Assert a line is in a file, verbatim. A mint that moved fails here, not silently. */
function expectLine(path: string, line: string): void {
  const lines = read(path).split("\n");
  expect(`${path}: ${lines.some((l) => l.includes(line))}`).toBe(`${path}: true`);
}

/** Compile the backticked expression on a line into a function that runs it. */
function expressionOf(line: string): () => string {
  const expression = /`[^`]+`/.exec(line)?.[0];
  if (expression === undefined) throw new Error(`no template expression on: ${line}`);
  const run = new Function("randomBytes", "randomUUID", "__randomUUID", `return ${expression};`);
  return () => run(randomBytes, randomUUID, randomUUID) as string;
}

/** Run a private function as its source writes it, with any preamble it leans on. */
function functionFrom(path: string, name: string, preamble = ""): () => string {
  const body = new RegExp(`function ${name}\\(\\): string \\{[\\s\\S]*?\\n\\}`).exec(
    read(path),
  )?.[0];
  if (body === undefined) throw new Error(`${name} moved out of ${path}`);
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(`${preamble}\n${body}`);
  return new Function(`${code}\nreturn ${name};`)() as () => string;
}

describe("library minters", () => {
  test("mintRunId is canonical", () => {
    expect(familyOf(() => mintRunId())).toEqual(new Set(["canonical"]));
  });

  test("createRunContext mints a canonical id", () => {
    expect(familyOf(() => createRunContext().runId, 100)).toEqual(new Set(["canonical"]));
  });

  test("the supervisor's execution id and the research id are hex16", () => {
    expect(familyOf(() => supervisorRunId())).toEqual(new Set(["hex16"]));
    expect(familyOf(() => citationRunId())).toEqual(new Set(["hex16"]));
    expect(classifyRunId(supervisorRunId()).refKinds).toEqual(["exec", "evalrun"]);
  });

  test("the job log's id is hex16, by a prefix swap", () => {
    const jobId = functionFrom("packages/harness-supervisor/src/queue.ts", "defaultJobId");
    expect(familyOf(() => runIdForJob(jobId()) as string)).toEqual(new Set(["hex16"]));
    expectLine("packages/hangar-server/src/process.ts", 'job.jobId.replace(/^job_/, "run_")');
  });

  test("a graph run", () => {
    expect(familyOf(() => newGraphRunId())).toEqual(new Set(["graph"]));
  });

  test("an eval run is hex16", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "run-id-families-eval-"));
    roots.push(outDir);
    const spec =
      "name: run-id-families\ntarget: cli\nagent:\n  model: claude-opus-4-7\n  instructions: hi\n";
    const ir = lower(parseSpec(spec)) as IrV0;
    const { compiled } = parseGradersConfig("graders:\n  - name: same\n    type: exact_match\n");
    const samples = (async function* () {
      yield { id: "one", input: "in", expected_output: "out" };
    })();
    const summary = await runEval({
      ir,
      dataset: { name: "families", samples },
      compiledGraders: compiled,
      opts: {
        invoker: async () => ({ agentOutput: "out", transcript: [], events: [] }),
        outDir,
      },
    });
    expect(classifyRunId(summary.runId).family).toBe("hex16");
    expect(summary.runId).toMatch(EXECUTION_RUN_ID_RE);
  }, 20_000); // Lowers a spec and writes a run; slow on a loaded runner.
});

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("mints written inline", () => {
  /** The runtime's and the child minters' own mints: each is the one minter now. */
  const TRACE_LINES = [
    ["packages/runtime-core/src/index.ts", "const runId = mintRunId();"],
    ["packages/agent-context-isolation/src/index.ts", "const childRunId = mintRunId();"],
    ["packages/model-service/src/side-calls.ts", "const childRunId = mintRunId();"],
  ] as const;
  const OLD_TRACE_MINT = "`run_${randomUUID().slice(0, 8)}`";

  test("every inline mint calls mintRunId(), and none keeps the 8-hex trace id", () => {
    let filesRead = 0;
    let oldMints = 0;
    for (const [path, line] of TRACE_LINES) {
      expectLine(path, line);
      filesRead += 1;
      oldMints += read(path).split(OLD_TRACE_MINT).length - 1;
    }
    expect(filesRead).toBe(3);
    expect(oldMints).toBe(0);
  });

  test("the channel bridge's literal is never a routable id", () => {
    const source = read("packages/channel-adapter-base/src/approvals.ts");
    const literal = /runId: "(run_[a-z]+)",/.exec(source)?.[1];
    expect(literal).toBeDefined();
    expect(classifyRunId(literal)).toEqual({ family: "literal", refKinds: [] });
  });

  test("sub-agent federation ids", () => {
    const path = "packages/sub-agent-spawner/src/index.ts";
    expectLine(path, "const childRunId = `fedrun_${fedId()}`;");
    expectLine(path, "let __fedSeq = 0;");
    const fedId = functionFrom(path, "fedId", "let __fedSeq = 0;");
    expect(familyOf(() => `fedrun_${fedId()}`)).toEqual(new Set(["federation"]));
  });
});

describe("mints the compiler emits", () => {
  const MANAGED_SOURCE = "packages/target-managed/src/index.ts";
  const MANAGED_FIXTURE = "packages/compiler/src/__fixtures__/pre-continuity/managed.daemon.ts.txt";
  const WORKFLOW_SOURCE = "packages/target-workflow/src/index.ts";
  const WORKFLOW_FIXTURE =
    "packages/compiler/src/__fixtures__/model-wiring/workflow-steps.agent.ts.txt";

  test("a managed run is canonical", async () => {
    // The daemon delegates its runs to managed-runs, which mints with mintRunId unless the
    // client named the run with a canonical id of its own.
    expectLine(
      "packages/gateway-server/src/managed-runs.ts",
      "const runId = p.runId ?? mintRunId();",
    );
    for (const path of [MANAGED_FIXTURE, MANAGED_SOURCE]) {
      expect(`${path}: ${read(path).includes("Math.random().toString(36)")}`).toBe(
        `${path}: false`,
      );
    }
    const { createManagedRuns } = await import("../packages/gateway-server/src/managed-runs");
    const { buildTenant } = await import("../packages/tenancy/src/index");
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-run-id-managed-"));
    try {
      const runs = createManagedRuns({
        harnessDir: dir,
        tenantsRoot: dir,
        env: { CREWHAUS_RUN_LEDGER: "0" },
        getAuditLog: async () =>
          ({ append: async () => undefined, read: async function* () {} }) as never,
        recordUsage: async () => undefined,
        executeTurn: async () => ({ reply: "done" }),
      });
      const tenant = buildTenant("tenant-a", { tenantsRoot: dir });
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) {
        const result = (await runs.handler({
          method: "runs.create",
          params: { spec: "s", input: "go" },
          tenant,
        })) as { runId: string };
        ids.push(result.runId);
      }
      expect(new Set(ids.map((id) => classifyRunId(id).family))).toEqual(new Set(["canonical"]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a federated managed run", () => {
    const plain = 'runId: `fedrun_${randomBytes(4).toString("hex")}`,';
    expectLine(MANAGED_FIXTURE, plain);
    expectLine(MANAGED_SOURCE, 'runId: \\`fedrun_\\${randomBytes(4).toString("hex")}\\`,');
    expect(familyOf(expressionOf(plain))).toEqual(new Set(["federation"]));
  });

  test("a workflow's durable key", () => {
    const plain = 'const __runId = process.env["CREWHAUS_RUN_ID"] ?? `wf_${__randomUUID()}`;';
    expectLine(WORKFLOW_FIXTURE, plain);
    expectLine(
      WORKFLOW_SOURCE,
      'const __runId = process.env["CREWHAUS_RUN_ID"] ?? \\`wf_\\${__randomUUID()}\\`;',
    );
    expect(familyOf(expressionOf(plain))).toEqual(new Set(["workflow"]));
  });

  test("the workflow eval entry's form, which has no fixture", () => {
    const line = "const __runId = `wf_${__randomUUID()}`;";
    expectLine(WORKFLOW_SOURCE, line);
    expect(familyOf(expressionOf(line))).toEqual(new Set(["workflow"]));
  });
});

describe("the grammars are the ones their owners hold", () => {
  test("the supervisor's run id and the registry's harness id", () => {
    expect(EXECUTION_RUN_ID_RE.source).toBe(SUPERVISOR_RUN_ID_RE.source);
    expect(HARNESS_ID_RE.source).toBe(REGISTRY_HARNESS_ID_RE.source);
  });

  test("a canonical id can never be mistaken for a legacy one", () => {
    const id = mintRunId();
    expect(id).toMatch(CANONICAL_RUN_ID_RE);
    expect(id).not.toMatch(EXECUTION_RUN_ID_RE);
  });
});
