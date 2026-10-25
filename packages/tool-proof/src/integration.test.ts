/**
 * The three tools through `@crewhaus/tool-executor`, the path runtime-core
 * takes: the schema is enforced before the tool runs, a refusal comes back
 * as an `is_error` result the model can read, and the context the executor
 * forwards (the bridge, not `runContext`) is enough for the tools to find
 * the run's session, bus and event log.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createBuiltinChecker } from "@crewhaus/proof-checker";
import { executeTool } from "@crewhaus/tool-executor";
import { PROOF_INPUT_LIMITS, createProofTools } from "./index";
import {
  MEETINGS,
  SESSION,
  call,
  config,
  fakeRun,
  fetched,
  now,
  tempDirs,
  userMessage,
  writeLog,
} from "./test-helpers";

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

const POLICY = "https://acme.example/policy";

function tools() {
  return createProofTools({
    config: config("grounded"),
    proofsRoot: dirs.make(),
    workspaceRoot: dirs.make(),
    checkers: [createBuiltinChecker()],
    now,
  });
}

describe("through executeTool", () => {
  test("a valid ProofCheck succeeds and the bridge carries the event to the run", async () => {
    const t = tools();
    const run = fakeRun();
    const result = await executeTool(
      t.proofCheck,
      { checker: "builtin", ...MEETINGS },
      { toolUseId: "toolu_1", bridge: run.ctx.bridge },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content as string).ok).toBe(true);
    expect(run.events.map((e) => e.kind)).toContain("proof_checked");
    expect(run.appended.map((e) => e.kind)).toEqual(["proof_checked"]);
  });

  test("an unknown checker is an is_error result naming the available ones", async () => {
    const result = await executeTool(
      tools().proofCheck,
      { checker: "isabelle", ...MEETINGS },
      { toolUseId: "toolu_2", bridge: fakeRun().ctx.bridge },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('unknown proof checker "isabelle"');
    expect(result.content).toContain("available: builtin");
  });

  test("an oversized proof is refused by the schema before any checker runs", async () => {
    const result = await executeTool(
      tools().proofCheck,
      { checker: "builtin", ...MEETINGS, proof: "x".repeat(PROOF_INPUT_LIMITS.proofChars + 1) },
      { toolUseId: "toolu_3" },
    );
    expect(result.isError).toBe(true);
  });

  test("a preflight reads the run's session log through the bridge", async () => {
    const sessions = dirs.make();
    await writeLog(sessions, SESSION, [
      userMessage("refund window?"),
      ...call(
        "toolu_f",
        "WebFetch",
        { url: POLICY },
        fetched(POLICY, "Refunds are accepted within 14 days of purchase."),
      ),
    ]);
    const result = await executeTool(
      tools().provabilityPreflight,
      { draft: `Refunds are accepted within 14 days of purchase [1].\n\n[1]: ${POLICY}\n` },
      { toolUseId: "toolu_4", bridge: fakeRun({ sessionRootDir: sessions }).ctx.bridge },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content as string).verdict).toBe("pass");
  });

  test("ProofCheckers answers with no arguments", async () => {
    const result = await executeTool(tools().proofCheckers, {}, { toolUseId: "toolu_5" });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content as string).checkers[0].id).toBe("builtin");
  });
});
