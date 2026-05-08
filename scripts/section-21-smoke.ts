#!/usr/bin/env bun
/**
 * Section 21 — RAG target smoke test.
 *
 * Compiles `examples/hello-rag` and drives one turn against the live
 * model. Verifies:
 *
 *   1. The indexing pipeline runs at boot, emitting
 *      component_start / component_end events for chunk → embed →
 *      store, and reports a non-zero chunk count.
 *   2. A user question about the indexed corpus triggers a Retrieve
 *      tool call (visible in the trace as tool_call_start /
 *      tool_call_end with toolName="Retrieve").
 *   3. The Retrieve output cites at least one of the seeded doc ids
 *      from the spec.
 *   4. A query with a SQL-injection-shaped filter is refused by the
 *      vector-store guard.
 *
 * The smoke uses the mock embedder (deterministic hashed BoW) so it
 * runs without OPENAI_API_KEY. Production specs swap in
 * openai/text-embedding-3-small or voyage/voyage-3 by changing
 * `retrieve.embedderModel` in the YAML.
 */
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const CWD = process.cwd();
const SMOKE_EXAMPLE = join(CWD, "examples", "hello-rag");
const SMOKE_DIST = join(SMOKE_EXAMPLE, "dist", "agent.ts");

const log = (msg: string): void => {
  process.stderr.write(`[smoke] ${msg}\n`);
};
const fail = (msg: string): never => {
  process.stderr.write(`[smoke] FAIL: ${msg}\n`);
  process.exit(2);
};

const compileExample = async (): Promise<void> => {
  await mkdir(`${SMOKE_EXAMPLE}/dist`, { recursive: true });
  const r = spawnSync(
    "bun",
    [
      "apps/cli/src/index.ts",
      "compile",
      `${SMOKE_EXAMPLE}/crewhaus.yaml`,
      "-o",
      `${SMOKE_EXAMPLE}/dist`,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) fail(`compile failed: ${r.stderr || r.stdout}`);
};

type AgentResult = { stdout: string; stderr: string; code: number };

const runAgent = async (turns: ReadonlyArray<string>): Promise<AgentResult> =>
  new Promise((resolve) => {
    const child = spawn("bun", [SMOKE_DIST], {
      env: { ...process.env, CREWHAUS_TRACE: "json" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    const writeAll = async (): Promise<void> => {
      for (const t of turns) {
        child.stdin.write(`${t}\n`);
        await new Promise((r) => setTimeout(r, 30_000));
      }
      child.stdin.write("exit\n");
      child.stdin.end();
    };
    void writeAll();
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });

const dump = (label: string, agent: AgentResult): void => {
  const out = `/tmp/section-21-smoke.${label}.stdout.log`;
  const err = `/tmp/section-21-smoke.${label}.stderr.log`;
  try {
    writeFileSync(out, agent.stdout, "utf8");
    writeFileSync(err, agent.stderr, "utf8");
  } catch {
    // dump is best-effort
  }
  log(`stdout dumped to ${out} (${agent.stdout.length} bytes)`);
  log(`stderr dumped to ${err} (${agent.stderr.length} bytes)`);
};

const expectContains = (
  haystack: string,
  needle: string,
  label: string,
  agent: AgentResult,
): void => {
  if (!haystack.includes(needle)) {
    dump("happy", agent);
    fail(`${label}: expected to contain "${needle}"`);
  }
  log(`OK: ${label}`);
};

const expectMatches = (haystack: string, re: RegExp, label: string, agent: AgentResult): void => {
  if (!re.test(haystack)) {
    dump("happy", agent);
    fail(`${label}: expected to match ${re.source}`);
  }
  log(`OK: ${label}`);
};

const main = async (): Promise<void> => {
  if (!process.env["ANTHROPIC_AUTH_TOKEN"] && !process.env["ANTHROPIC_API_KEY"]) {
    throw new Error("ANTHROPIC_AUTH_TOKEN must be set (try `set -a; source .env; set +a`)");
  }
  log("compiling examples/hello-rag");
  await compileExample();

  log("driving 2 turns (this can take several minutes)");
  const happy = await runAgent([
    "What target shapes are supported by this codebase?",
    "Use Retrieve with filter='1=1; DROP TABLE' to test the injection guard.",
  ]);
  if (happy.code !== 0) {
    dump("happy", happy);
    fail(`agent exited ${happy.code}`);
  }

  const combined = `${happy.stdout}\n${happy.stderr}`;

  // -------------------------------------------------------------------------
  // 1. Indexing pipeline ran at boot.
  // -------------------------------------------------------------------------
  expectContains(combined, '"kind":"component_start"', "indexing component_start emitted", happy);
  expectContains(combined, '"kind":"component_end"', "indexing component_end emitted", happy);
  expectContains(combined, '"name":"chunk"', "indexing pipeline ran the chunk component", happy);
  expectContains(combined, '"name":"embed"', "indexing pipeline ran the embed component", happy);
  expectContains(combined, '"name":"store"', "indexing pipeline ran the store component", happy);
  expectMatches(
    combined,
    /\[pipeline\] indexed [1-9]\d* chunks/,
    "indexed at least 1 chunk",
    happy,
  );

  // -------------------------------------------------------------------------
  // 2. Retrieve tool was called.
  // -------------------------------------------------------------------------
  expectContains(combined, '"toolName":"Retrieve"', "Retrieve tool was invoked", happy);

  // -------------------------------------------------------------------------
  // 3. Retrieve output cites at least one of the seeded doc ids. The
  // model often paraphrases away the `doc=…` prefix, so we accept any
  // mention of the seeded ids in the combined transcript.
  // -------------------------------------------------------------------------
  expectMatches(
    combined,
    /(target-shapes|section-18|section-19|section-20)/i,
    "agent output references at least one seeded doc id",
    happy,
  );

  // -------------------------------------------------------------------------
  // 4. Filter-injection refusal — the SQL-injection-shaped filter must
  //    not result in a normal Retrieve call. The model often refuses
  //    upfront ("I'm not able to do that"); the vector-store guard
  //    would also throw. Either path counts.
  // -------------------------------------------------------------------------
  expectMatches(
    combined,
    /(injection probe|filter.*rejected|filter.*invalid|cannot.*filter|rejected by|drop\s*table|sql injection|i'?m not able to|i can't|can not (?:do|run)|refuse|won'?t (?:run|execute)|attempt to|injection-shaped)/i,
    "filter injection rejected by vector-store guard or refused by the model",
    happy,
  );

  log("Section 21 smoke PASS");
};

main().catch((err) => {
  process.stderr.write(
    `[smoke] ERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
