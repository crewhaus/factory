/**
 * 0.8.0 §9.1 — the eval runner's provability half: the `--provability`
 * floor override, the grader injection, the standing bundle per sample, and
 * — end to end — the gate wired by the DEFAULT invoker inside the LIVE
 * `runChatLoop` (a scripted model through the `_adapter` seam, the real
 * session log, the real verifier), graded by the real provability graders.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import { wireEvaluation } from "@crewhaus/evaluation-service";
import { provabilitySkills } from "@crewhaus/evaluation-service";
import type { IrV0 } from "@crewhaus/ir";
import {
  type ProofArtifact,
  type ProofBundle,
  buildEvidenceIndex,
  createFileArtifactStore,
  recordFromCall,
  verifyDocument,
} from "@crewhaus/provability";
import { createRunContext } from "@crewhaus/run-context";
import { runChatLoop } from "@crewhaus/runtime-core";
import type { ProvabilityTurn } from "@crewhaus/runtime-core";
import { parseSpec } from "@crewhaus/spec";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { z } from "zod";
import { runEval } from "./index";
import {
  PROOF_CHECK_TOOL,
  PROOF_FILENAME,
  defaultProvabilityBlock,
  proofCassetteEffects,
  provabilityGraderEntries,
  sampleGateIr,
  sampleProofsRoot,
  standingBundleFromEvents,
  wireSampleProvability,
  withGateTools,
  withProvabilityFloor,
} from "./provability";
import { readRunManifest, resumeMismatches } from "./resume";
import {
  TOOL_RECORDING_FILENAME,
  TOOL_REPLAY_RESTORE_MARKER,
  type ToolRecord,
} from "./tool-record";
import type { AgentInvoker } from "./types";

const TMP: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "eval-runner-provability-"));
  TMP.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});

const cliIr = (extra = ""): IrV0 =>
  lower(
    parseSpec(
      `name: prov-eval\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: cite everything\n${extra}`,
    ),
  ) as IrV0;

/** A claim the builtin checker proves (evaluation-service's fixture). */
const MEETINGS = {
  claim: "No two of the three meetings overlap.",
  statement:
    "let s = [9, 10.5, 13], e = [10, 12, 14] in forall i in 0..2: forall j in 0..2: i = j or e[i] <= s[j] or e[j] <= s[i]",
  proof: "eval",
};

/** A completed turn as runtime-core hands it to `verify`. */
function turnOf(finalText: string): ProvabilityTurn {
  return {
    finalText,
    messages: [],
    usage: { input: 0, output: 0 },
    bus: createRunContext().eventBus,
    turnNumber: 1,
    retryIndex: 0,
  } as unknown as ProvabilityTurn;
}

const URL_A = "https://acme.example/policy";
const PAGE = `URL: ${URL_A}\nStatus: 200\nContent-Type: text/html\n\nThe refund window is 14 days from the date of purchase.`;
const ANSWER = `The refund window is 14 days [1].\n\n[1]: ${URL_A}`;

async function bundleOf(text: string, fetched: boolean): Promise<ProofBundle> {
  const evidence = buildEvidenceIndex(
    fetched
      ? [
          recordFromCall({
            toolUseId: "toolu_f",
            toolName: "WebFetch",
            input: { url: URL_A },
            content: PAGE,
            isError: false,
          }),
        ]
      : [],
  );
  return verifyDocument(text, { config: defaultProvabilityBlock("grounded"), evidence });
}

describe("withProvabilityFloor", () => {
  test("absent: the IR itself, same reference (an un-flagged run is untouched)", () => {
    const ir = cliIr();
    expect(withProvabilityFloor(ir, undefined)).toBe(ir);
  });

  test("a spec with no block gets the compiler's shorthand defaults at the floor", () => {
    const ir = withProvabilityFloor(cliIr(), "grounded");
    expect(ir.provability).toEqual(cliIr("provability: grounded\n").provability);
    expect(ir.provability).toMatchObject({
      level: "grounded",
      onFail: "retry",
      maxRetries: 1,
      threshold: 1,
      render: "footer",
    });
    // The category grammar was expanded by the compiler, not re-derived here.
    expect(ir.provability?.execution.allow.length).toBeGreaterThan(0);
  });

  test("a declared block keeps every knob and only moves the floor", () => {
    const declared = cliIr(
      "provability:\n  level: cited\n  max_retries: 3\n  threshold: 0.5\n  render: none\n",
    );
    const ir = withProvabilityFloor(declared, "checked");
    expect(ir.provability).toEqual({ ...declared.provability, level: "checked" } as never);
  });

  test("anything but a rung is a loud RunnerError", () => {
    for (const bad of ["off", "Grounded", ""]) {
      expect(() => withProvabilityFloor(cliIr(), bad)).toThrow(/invalid provability/);
    }
  });
});

describe("provabilityGraderEntries", () => {
  test("all six, in order, when the graders file names none", async () => {
    const entries = await provabilityGraderEntries([{ name: "exact" }]);
    expect(entries.map((e) => e.name)).toEqual([
      "provability.claimCoverage",
      "provability.rungAchieved",
      "provability.citationValidity",
      "provability.assumptionRate",
      "provability.replayIntegrity",
      "provability.costPerProvenClaim",
    ]);
  });

  test("a name the graders file already carries keeps its own entry", async () => {
    const entries = await provabilityGraderEntries([{ name: "provability.claimCoverage" }]);
    expect(entries.map((e) => e.name)).not.toContain("provability.claimCoverage");
    expect(entries).toHaveLength(5);
  });

  test("five are requirements and the cost is a report: none joins the file's combine: policy", async () => {
    const entries = await provabilityGraderEntries([]);
    expect(Object.fromEntries(entries.map((e) => [e.name, e.role]))).toEqual({
      "provability.claimCoverage": "requirement",
      "provability.rungAchieved": "requirement",
      "provability.citationValidity": "requirement",
      "provability.assumptionRate": "requirement",
      "provability.replayIntegrity": "requirement",
      "provability.costPerProvenClaim": "report",
    });
  });
});

describe("sampleGateIr", () => {
  const gated = withProvabilityFloor(cliIr(), "cited");

  test("a gated run re-floors the sample's gate at its metadata level (every other knob kept)", async () => {
    const own = await sampleGateIr(gated, { metadata: { provability: { level: "checked" } } });
    expect(own.provability).toEqual({ ...gated.provability, level: "checked" } as never);
  });

  test("same reference when nothing changes: no metadata, the run's own level, malformed metadata", async () => {
    expect(await sampleGateIr(gated, {})).toBe(gated);
    expect(await sampleGateIr(gated, { metadata: { provability: "cited" } })).toBe(gated);
    expect(await sampleGateIr(gated, { metadata: { provability: { level: "certain" } } })).toBe(
      gated,
    );
    expect(
      await sampleGateIr(gated, { metadata: { provability: { expected_sources: ["a.md"] } } }),
    ).toBe(gated);
  });

  test("metadata never turns a gate on: an ungated run stays ungated", async () => {
    const ungated = cliIr();
    expect(await sampleGateIr(ungated, { metadata: { provability: "proven" } })).toBe(ungated);
  });
});

describe("standingBundleFromEvents", () => {
  const graded = (bundlePath: string | undefined, bundleHash: string): TraceEvent =>
    ({
      kind: "provability_graded",
      runId: "r",
      sessionId: "s",
      turnNumber: 1,
      traceId: "t",
      spanId: "p",
      timestamp: "2026-10-22T00:00:00.000Z",
      level: "grounded",
      verdict: "pass",
      score: 1,
      threshold: 1,
      achieved: "grounded",
      claims: 1,
      met: 1,
      unmet: 0,
      assumptions: 0,
      retryIndex: 0,
      maxRetries: 1,
      bundleHash,
      ...(bundlePath !== undefined ? { bundlePath } : {}),
    }) as unknown as TraceEvent;

  test("reads the file the LAST pass points at when its hash is the graded one", async () => {
    const dir = tmp();
    const first = await bundleOf(ANSWER, false);
    const last = await bundleOf(ANSWER, true);
    writeFileSync(join(dir, "turn-1.json"), JSON.stringify(last));
    const found = standingBundleFromEvents([
      graded(join(dir, "nope.json"), first.bundleHash),
      graded(join(dir, "turn-1.json"), last.bundleHash),
    ]);
    expect(found?.bundleHash).toBe(last.bundleHash);
  });

  test("a relative bundlePath resolves against cwd", async () => {
    const dir = tmp();
    const bundle = await bundleOf(ANSWER, true);
    mkdirSync(join(dir, "p"));
    writeFileSync(join(dir, "p", "turn-1.json"), JSON.stringify(bundle));
    expect(standingBundleFromEvents([graded("p/turn-1.json", bundle.bundleHash)], dir)).toEqual(
      bundle,
    );
  });

  test("a file edited after persist is refused even when it kept its bundleHash field", async () => {
    const dir = tmp();
    const bundle = await bundleOf(ANSWER, false); // fails: never fetched
    const forged = {
      ...bundle,
      verdict: "pass",
      score: 1,
      met: bundle.claims.length,
      claims: bundle.claims.map((c) => ({ ...c, status: "met" })),
    };
    writeFileSync(join(dir, "turn-1.json"), JSON.stringify(forged));
    expect(forged.bundleHash).toBe(bundle.bundleHash);
    expect(
      standingBundleFromEvents([graded(join(dir, "turn-1.json"), bundle.bundleHash)]),
    ).toBeUndefined();
    // The untouched file is accepted.
    writeFileSync(join(dir, "turn-1.json"), JSON.stringify(bundle));
    expect(
      standingBundleFromEvents([graded(join(dir, "turn-1.json"), bundle.bundleHash)])?.verdict,
    ).toBe("fail");
  });

  test("no event, no path, a missing file, a hash mismatch or junk: undefined", async () => {
    const dir = tmp();
    const bundle = await bundleOf(ANSWER, true);
    writeFileSync(join(dir, "ok.json"), JSON.stringify(bundle));
    writeFileSync(join(dir, "junk.json"), "{not json");
    writeFileSync(join(dir, "shape.json"), JSON.stringify({ version: 1 }));
    expect(standingBundleFromEvents([])).toBeUndefined();
    expect(standingBundleFromEvents([graded(undefined, bundle.bundleHash)])).toBeUndefined();
    expect(
      standingBundleFromEvents([graded(join(dir, "gone.json"), bundle.bundleHash)]),
    ).toBeUndefined();
    expect(
      standingBundleFromEvents([graded(join(dir, "ok.json"), "sha256:other")]),
    ).toBeUndefined();
    expect(standingBundleFromEvents([graded(join(dir, "junk.json"), "x")])).toBeUndefined();
    expect(standingBundleFromEvents([graded(join(dir, "shape.json"), "x")])).toBeUndefined();
  });
});

describe("wireSampleProvability", () => {
  test("no block: nothing is wired", async () => {
    const dir = tmp();
    expect(
      await wireSampleProvability(cliIr(), {
        cwd: dir,
        sessionRootDir: dir,
        catalog: { get: () => undefined },
      }),
    ).toBeUndefined();
  });

  test("the gate persists into the SAMPLE dir and keeps the last bundle as the standing one", async () => {
    const cwd = tmp();
    const sampleDir = tmp();
    const ir = withProvabilityFloor(cliIr(), "grounded");
    const gate = await wireSampleProvability(ir, {
      cwd,
      sessionRootDir: sampleDir,
      catalog: { get: () => undefined },
    });
    if (gate === undefined) throw new Error("expected a wired gate");
    expect(gate.provability).toMatchObject({ level: "grounded", onFail: "retry", maxRetries: 1 });
    expect(gate.provability.footerTarget).toBe("stream");
    expect(gate.standing()).toBeUndefined();
    const first = await bundleOf(ANSWER, false);
    const second = await bundleOf(ANSWER, true);
    gate.provability.onBundle?.(first);
    gate.provability.onBundle?.(second);
    expect(gate.standing()).toBe(second);
    const path = await gate.provability.persist?.(second, {
      sessionId: "sess_00000000000000aa",
      turnNumber: 1,
    });
    expect(path).toBe(
      join(sampleDir, ".crewhaus", "proofs", "prov-eval", "sess_00000000000000aa", "turn-1.json"),
    );
    expect(existsSync(join(cwd, ".crewhaus", "proofs"))).toBe(false);
  });

  test("ISOLATION at proven: ProofCheck files under the SAMPLE's proofs root, and a harness-tree artifact never resolves", async () => {
    const cwd = tmp();
    const sampleDir = tmp();
    const ir = withProvabilityFloor(cliIr(), "proven");
    const gate = await wireSampleProvability(ir, {
      cwd,
      sessionRootDir: sampleDir,
      catalog: { get: () => undefined },
    });
    if (gate === undefined) throw new Error("expected a wired gate");
    const proofCheckOf = (tools: ReadonlyArray<RegisteredTool>): RegisteredTool => {
      const tool = tools.find((t) => t.name === "ProofCheck");
      if (tool === undefined) throw new Error("no ProofCheck");
      return tool;
    };
    const run = async (tool: RegisteredTool) =>
      JSON.parse((await tool.execute({ checker: "builtin", ...MEETINGS })) as string) as {
        ok: boolean;
        id: string;
      };
    const own = await run(proofCheckOf(gate.tools));
    expect(own.ok).toBe(true);
    expect(
      existsSync(join(sampleProofsRoot(sampleDir, "prov-eval"), "artifacts", `${own.id}.json`)),
    ).toBe(true);
    expect(existsSync(join(cwd, ".crewhaus", "proofs"))).toBe(false);
    // The sample's own proof is met.
    const met = await gate.provability.verify(
      turnOf(`${MEETINGS.claim.slice(0, -1)} [1].\n\n[1]: proof:${own.id}`),
    );
    expect(met.verdict).toBe("pass");
    // An artifact the LIVE harness wrote (a production run, say) is not this sample's evidence.
    const harness = await wireEvaluation(
      { specName: "prov-eval", primaryModel: "claude-sonnet-4-6", provability: ir.provability },
      { cwd },
    );
    const live = await run(proofCheckOf(harness.tools));
    expect(
      existsSync(join(cwd, ".crewhaus", "proofs", "prov-eval", "artifacts", `${live.id}.json`)),
    ).toBe(true);
    const borrowed = await gate.provability.verify(
      turnOf(`${MEETINGS.claim.slice(0, -1)} [1].\n\n[1]: proof:${live.id}`),
    );
    expect(borrowed.verdict).toBe("fail");
    expect(borrowed.claims[0]?.bindings[0]?.reason).toBe("proof_missing");
  });

  test("a proven floor brings the proof tools; withGateTools merges them", async () => {
    const dir = tmp();
    const gate = await wireSampleProvability(withProvabilityFloor(cliIr(), "proven"), {
      cwd: dir,
      sessionRootDir: dir,
      catalog: { get: () => undefined },
    });
    if (gate === undefined) throw new Error("expected a wired gate");
    const names = withGateTools([], gate).map((t) => t.name);
    expect(names).toContain("ProofCheck");
    expect(names).toContain("ProvabilityPreflight");
  });
});

describe("proofCassetteEffects — a cassette carries the artifact ProofCheck names (review W3-C2)", () => {
  /** The gate's own ProofCheck at proven, filing under `sampleDir`'s proofs root. */
  async function provenGate(sampleDir: string) {
    const gate = await wireSampleProvability(withProvabilityFloor(cliIr(), "proven"), {
      cwd: tmp(),
      sessionRootDir: sampleDir,
      catalog: { get: () => undefined },
    });
    if (gate === undefined) throw new Error("expected a wired gate");
    const proofCheck = gate.proofTools.find((t) => t.name === PROOF_CHECK_TOOL);
    if (proofCheck === undefined) throw new Error(`the gate has no ${PROOF_CHECK_TOOL}`);
    return { gate, proofCheck };
  }
  const effectsOf = (root: string) => {
    const effects = proofCassetteEffects(root).get(PROOF_CHECK_TOOL);
    if (effects === undefined) throw new Error("no ProofCheck effects");
    return effects;
  };

  test("the gate's wiring carries effects for its ProofCheck, over the sample's own root", async () => {
    const sampleDir = tmp();
    const { gate, proofCheck } = await provenGate(sampleDir);
    expect([...gate.cassetteEffects.keys()]).toEqual([proofCheck.name]);
    const result = (await proofCheck.execute({ checker: "builtin", ...MEETINGS })) as string;
    const { id } = JSON.parse(result) as { id: string };
    const captured = (await gate.cassetteEffects.get(PROOF_CHECK_TOOL)?.capture(result)) as
      | ProofArtifact
      | undefined;
    expect(captured?.id).toBe(id);
    const onDisk = JSON.parse(
      readFileSync(
        join(sampleProofsRoot(sampleDir, "prov-eval"), "artifacts", `${id}.json`),
        "utf8",
      ),
    ) as ProofArtifact;
    expect(captured).toEqual(onDisk);
  });

  test("capture refuses a result that names no artifact, or one that is not filed", async () => {
    const root = sampleProofsRoot(tmp(), "prov-eval");
    const { capture } = effectsOf(root);
    await expect(capture("not json")).rejects.toThrow("names no proof artifact");
    await expect(capture(JSON.stringify({ ok: true, id: "../escape" }))).rejects.toThrow(
      "names no proof artifact",
    );
    await expect(capture(JSON.stringify({ ok: true, id: "prf_0123456789abcdef" }))).rejects.toThrow(
      "no such artifact is filed",
    );
  });

  test("restore files the artifact under the root; again is a no-op; a different one under its id is refused", async () => {
    const source = tmp();
    const { proofCheck } = await provenGate(source);
    const result = (await proofCheck.execute({ checker: "builtin", ...MEETINGS })) as string;
    const artifact = (await effectsOf(sampleProofsRoot(source, "prov-eval")).capture(
      result,
    )) as ProofArtifact;
    const root = sampleProofsRoot(tmp(), "prov-eval");
    const { restore } = effectsOf(root);
    await restore(artifact);
    const store = createFileArtifactStore({ rootDir: root });
    expect(await store.get(artifact.id)).toEqual(artifact);
    // An exhausted key's last entry replays again: already filed, left alone.
    await restore(JSON.parse(JSON.stringify(artifact)));
    await expect(restore({ ...artifact, claim: "Something else entirely." })).rejects.toThrow(
      `a different artifact is already filed as ${artifact.id}`,
    );
    expect(await store.get(artifact.id)).toEqual(artifact);
  });

  test("restore refuses a malformed artifact — and an id that would leave the root", async () => {
    const root = join(tmp(), "proofs");
    const { restore } = effectsOf(root);
    await expect(restore({ id: "prf_0123456789abcdef" })).rejects.toThrow("malformed");
    const shaped: ProofArtifact = {
      version: 1,
      id: "prf_0123456789abcdef",
      checker: "builtin",
      claim: MEETINGS.claim,
      statement: MEETINGS.statement,
      proof: MEETINGS.proof,
      ok: true,
      assumptions: [],
      axioms: [],
      output: "",
      outputDigest: "sha256:0",
      checkedAt: "2026-10-22T00:00:00.000Z",
    };
    await expect(restore({ ...shaped, id: "../../outside" })).rejects.toThrow("malformed");
    expect(existsSync(root)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// end to end: the default invoker, the live loop, the real graders
// ---------------------------------------------------------------------------

type Adapter = NonNullable<Parameters<typeof runChatLoop>[0]["_adapter"]>;
type Block =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    };

/**
 * A model that answers each call with the next scripted content (the last
 * repeats) — or, given a function, with what it returns for the request's
 * messages (serialized), so a script can echo back an id a tool returned.
 */
function scriptedModel(
  scripts: ReadonlyArray<ReadonlyArray<Block>> | ((messages: string) => ReadonlyArray<Block>),
): Adapter {
  let i = 0;
  const adapter = {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    stream(req?: { readonly messages?: unknown }) {
      const content =
        typeof scripts === "function"
          ? scripts(JSON.stringify(req?.messages ?? []))
          : (scripts[Math.min(i, scripts.length - 1)] ?? []);
      i += 1;
      const hasToolUse = content.some((b) => b.type === "tool_use");
      return (async function* () {
        yield { kind: "message_start" };
        for (let idx = 0; idx < content.length; idx += 1) {
          const block = content[idx] as Block;
          if (block.type === "text") {
            yield { kind: "content_block_start", index: idx, block: { type: "text", text: "" } };
            yield {
              kind: "content_block_delta",
              index: idx,
              delta: { type: "text_delta", text: block.text },
            };
          } else {
            yield {
              kind: "content_block_start",
              index: idx,
              block: { type: "tool_use", id: block.id, name: block.name, input: {} },
            };
            yield {
              kind: "content_block_delta",
              index: idx,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
            };
          }
          yield { kind: "content_block_stop", index: idx };
        }
        yield {
          kind: "message_delta",
          stopReason: hasToolUse ? "tool_use" : "end_turn",
          usage: { input: 10, output: 5 },
        };
        yield { kind: "message_stop" };
      })();
    },
  };
  return adapter as unknown as Adapter;
}

/** A WebFetch stand-in: the builtin reader's name and input, a fixed page, no network. */
const webFetch: RegisteredTool = {
  name: "WebFetch",
  description: "fetch a page",
  inputSchema: z.object({ url: z.string() }).strict() as never,
  execute: async () => PAGE,
  concurrencySafe: true,
  readOnly: true,
  destructive: false,
  requiresSandbox: false,
  classifyOutput: false,
  scope: "internal",
  requireJustification: false,
};

async function* samplesOf(samples: Sample[]): AsyncIterable<Sample> {
  for (const s of samples) yield s;
}

/** The scenario-A script: cite unfetched → the gate fails → fetch → cite again. */
const SCENARIO_A: ReadonlyArray<ReadonlyArray<Block>> = [
  [{ type: "text", text: ANSWER }],
  [{ type: "tool_use", id: "toolu_fetch1", name: "WebFetch", input: { url: URL_A } }],
  [{ type: "text", text: ANSWER }],
];

function liveChatLoop(scripts: Parameters<typeof scriptedModel>[0]) {
  const seen: Array<Record<string, unknown>> = [];
  const chatLoop = (opts: Parameters<typeof runChatLoop>[0]) => {
    seen.push(opts as unknown as Record<string, unknown>);
    return runChatLoop({
      ...opts,
      _adapter: scriptedModel(scripts),
      spinner: false,
      stdout: () => {},
      permissionMode: "bypass",
      tools: [...(opts.tools ?? []), webFetch],
    });
  };
  return { chatLoop, seen };
}

describe("runEval — the gate in the loop, graded (design §9.1)", () => {
  test("a spec that declares provability: the default invoker wires the gate; proof.json + artifacts.proof", async () => {
    const cwd = tmp();
    const outDir = join(tmp(), "run");
    const { chatLoop, seen } = liveChatLoop(SCENARIO_A);
    const { compiled } = parseGradersConfig(
      "graders:\n  - name: coverage\n    type: registry\n    grader: provability.claimCoverage\n",
    );
    const summary = await runEval({
      ir: cliIr("provability: grounded\n"),
      dataset: { name: "d", samples: samplesOf([{ id: "s1", input: "refund window?" }]) },
      compiledGraders: compiled,
      opts: { outDir, cwd, chatLoop, concurrency: 1, retryErrors: false },
    });
    // The gate rode the loop's options, with its footer kept OUT of the answer.
    expect(seen[0]?.["provability"]).toMatchObject({ level: "grounded", footerTarget: "stream" });
    const sample = summary.samples[0];
    expect(sample?.error).toBeUndefined();
    expect(sample?.grades.perGrader.find((g) => g.name === "coverage")).toMatchObject({
      passed: true,
      score: 1,
    });
    // The standing bundle — the retry's pass, not the original's fail.
    const proof = JSON.parse(
      readFileSync(join(outDir, "s1", PROOF_FILENAME), "utf8"),
    ) as ProofBundle;
    expect(proof).toMatchObject({ verdict: "pass", retryIndex: 1, level: "grounded" });
    // Every pass persisted in the SAMPLE's fabric root; nothing in the harness's.
    expect(existsSync(join(outDir, "s1", ".crewhaus", "proofs", "prov-eval"))).toBe(true);
    expect(existsSync(join(cwd, ".crewhaus", "proofs"))).toBe(false);
    // The trace carries both passes.
    const events = readFileSync(join(outDir, "s1", "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind: string; verdict?: string });
    expect(events.filter((e) => e.kind === "provability_graded").map((e) => e.verdict)).toEqual([
      "fail",
      "pass",
    ]);
    // No override was asked for: nothing recorded.
    expect(summary.config.provability).toBeUndefined();
  }, 30_000);

  test("--provability on a spec WITHOUT the block: gate wired, six graders appended, floor recorded", async () => {
    const cwd = tmp();
    const outDir = join(tmp(), "run");
    const { chatLoop, seen } = liveChatLoop([[{ type: "text", text: ANSWER }]]);
    const { compiled } = parseGradersConfig(
      'graders:\n  - name: has-cite\n    type: contains\n    substring: "[1]"\n',
    );
    const summary = await runEval({
      ir: cliIr(),
      dataset: { name: "d", samples: samplesOf([{ id: "s1", input: "refund window?" }]) },
      compiledGraders: compiled,
      opts: { outDir, cwd, chatLoop, concurrency: 1, retryErrors: false, provability: "cited" },
    });
    expect(seen[0]?.["provability"]).toMatchObject({ level: "cited" });
    expect(summary.config.provability).toBe("cited");
    expect(summary.config.graderNames).toEqual([
      "has-cite",
      "provability.claimCoverage",
      "provability.rungAchieved",
      "provability.citationValidity",
      "provability.assumptionRate",
      "provability.replayIntegrity",
      "provability.costPerProvenClaim",
    ]);
    const graded = Object.fromEntries(
      (summary.samples[0]?.grades.perGrader ?? []).map((g) => [g.name, g]),
    );
    expect(graded["provability.claimCoverage"]).toMatchObject({ passed: true, score: 1 });
    expect(graded["provability.rungAchieved"]).toMatchObject({ passed: true, score: 0.25 });
    expect(summary.samples[0]?.grades.overall.passed).toBe(true);
    // The floor is part of run.json and of the resume identity.
    const manifest = readRunManifest(outDir);
    expect(manifest.provability).toBe("cited");
    expect(resumeMismatches(manifest, { specHash: manifest.specHash ?? "" })).toEqual([
      "provability: cited (recorded) → (spec) (this run)",
    ]);
  }, 30_000);

  test("a sample's metadata.provability.level gates AND grades it at its own floor", async () => {
    const cwd = tmp();
    const outDir = join(tmp(), "run");
    const { chatLoop, seen } = liveChatLoop([[{ type: "text", text: ANSWER }]]);
    const summary = await runEval({
      ir: cliIr(),
      dataset: {
        name: "d",
        samples: samplesOf([
          { id: "at-run", input: "q" },
          { id: "raised", input: "q", metadata: { provability: "grounded" } },
        ]),
      },
      compiledGraders: [],
      opts: { outDir, cwd, chatLoop, concurrency: 1, retryErrors: false, provability: "cited" },
    });
    const coverage = (id: string) =>
      summary.samples
        .find((s) => s.sampleId === id)
        ?.grades.perGrader.find((g) => g.name === "provability.claimCoverage");
    expect(coverage("at-run")?.passed).toBe(true);
    expect(coverage("raised")).toMatchObject({ passed: false, score: 0 });
    // The raised sample's GATE ran at grounded (the bundle is exact, not re-read)…
    const levels = seen.map((o) => (o["provability"] as { level?: string } | undefined)?.level);
    expect(levels[0]).toBe("cited");
    expect(levels.slice(1).every((l) => l === "grounded")).toBe(true);
    const raisedProof = JSON.parse(
      readFileSync(join(outDir, "raised", PROOF_FILENAME), "utf8"),
    ) as ProofBundle;
    expect(raisedProof.level).toBe("grounded");
    expect(coverage("raised")?.rationale).toContain("not_fetched");
    // …and the `provability` skill it was handed teaches grounded, not cited.
    const skillBody = (o: Record<string, unknown>) =>
      (o["skills"] as ReadonlyArray<{ name: string; body?: string }>).find(
        (k) => k.name === "provability",
      )?.body;
    const grounded = provabilitySkills(withProvabilityFloor(cliIr(), "grounded").provability)[0];
    const cited = provabilitySkills(withProvabilityFloor(cliIr(), "cited").provability)[0];
    expect(grounded?.body).not.toBe(cited?.body);
    expect(skillBody(seen[0] as Record<string, unknown>)).toBe(cited?.body);
    expect(skillBody(seen[1] as Record<string, unknown>)).toBe(grounded?.body);
  }, 30_000);

  test("the per-sample skill swap on a fabric-less spec (wireRunOnce owns the skills)", async () => {
    const cwd = tmp();
    const outDir = join(tmp(), "run");
    const { chatLoop, seen } = liveChatLoop([[{ type: "text", text: ANSWER }]]);
    await runEval({
      ir: cliIr("continuity: false\n"),
      dataset: {
        name: "d",
        samples: samplesOf([
          { id: "at-run", input: "q" },
          { id: "raised", input: "q", metadata: { provability: "grounded" } },
        ]),
      },
      compiledGraders: [],
      opts: { outDir, cwd, chatLoop, concurrency: 1, retryErrors: false, provability: "cited" },
    });
    const skillsOf = (o: Record<string, unknown> | undefined) =>
      (o?.["skills"] as ReadonlyArray<{ name: string; body?: string }>).filter(
        (k) => k.name === "provability",
      );
    const grounded = provabilitySkills(withProvabilityFloor(cliIr(), "grounded").provability)[0];
    const cited = provabilitySkills(withProvabilityFloor(cliIr(), "cited").provability)[0];
    expect(skillsOf(seen[0]).map((k) => k.body)).toEqual([cited?.body]);
    const raised = seen.at(-1);
    expect(skillsOf(raised).map((k) => k.body)).toEqual([grounded?.body]);
    // One Skill tool, advertising the swapped list.
    const tools = (raised?.["tools"] as ReadonlyArray<{ name: string }>).filter(
      (t) => t.name === "Skill",
    );
    expect(tools).toHaveLength(1);
  }, 30_000);

  test("a hand-wired invoker's proof is persisted and graded as the standing bundle", async () => {
    const outDir = join(tmp(), "run");
    const bundle = await bundleOf(ANSWER, true);
    const summary = await runEval({
      ir: cliIr(),
      dataset: { name: "d", samples: samplesOf([{ id: "s1", input: "q" }]) },
      compiledGraders: [],
      opts: {
        outDir,
        cwd: tmp(),
        concurrency: 1,
        retryErrors: false,
        provability: "grounded",
        invoker: async () => ({ agentOutput: ANSWER, proof: bundle }),
      },
    });
    expect(JSON.parse(readFileSync(join(outDir, "s1", PROOF_FILENAME), "utf8"))).toEqual(bundle);
    const coverage = summary.samples[0]?.grades.perGrader.find(
      (g) => g.name === "provability.claimCoverage",
    );
    expect(coverage).toMatchObject({ passed: true, score: 1 });
  });

  test("an ungated run (no block, no flag) passes nothing new and writes no proof.json", async () => {
    const cwd = tmp();
    const outDir = join(tmp(), "run");
    const { chatLoop, seen } = liveChatLoop([[{ type: "text", text: ANSWER }]]);
    const { compiled } = parseGradersConfig(
      "graders:\n  - name: coverage\n    type: registry\n    grader: provability.claimCoverage\n",
    );
    const summary = await runEval({
      ir: cliIr(),
      dataset: { name: "d", samples: samplesOf([{ id: "s1", input: "q" }]) },
      compiledGraders: compiled,
      opts: { outDir, cwd, chatLoop, concurrency: 1, retryErrors: false },
    });
    expect(seen[0]?.["provability"]).toBeUndefined();
    expect(existsSync(join(outDir, "s1", PROOF_FILENAME))).toBe(false);
    const coverage = summary.samples[0]?.grades.perGrader.find((g) => g.name === "coverage");
    expect(coverage?.passed).toBe(false);
    expect(coverage?.rationale).toContain("no proof bundle (is provability: declared?)");
  }, 30_000);

  test("on_fail: halt is TERMINAL — the default noise retry never re-rolls the gate's verdict", async () => {
    const cwd = tmp();
    const outDir = join(tmp(), "run");
    // Attempt 1 cites an unfetched source (halt); a re-roll would answer with
    // no claims at all and pass vacuously — the halt must not be erased.
    const { chatLoop, seen } = liveChatLoop([
      [{ type: "text", text: ANSWER }],
      [{ type: "text", text: "Which order do you mean?" }],
    ]);
    const summary = await runEval({
      ir: cliIr("provability:\n  level: grounded\n  on_fail: halt\n"),
      dataset: { name: "d", samples: samplesOf([{ id: "s1", input: "q" }]) },
      compiledGraders: [],
      // retryErrors left at its default (on), as `crewhaus eval` runs it.
      opts: { outDir, cwd, chatLoop, concurrency: 1, provability: "grounded" },
    });
    expect(seen).toHaveLength(1);
    const sample = summary.samples[0];
    expect(sample?.error).toContain("provability gate failed");
    expect(sample?.retried).toBeUndefined();
    expect(sample?.grades.overall.passed).toBe(false);
    const coverage = sample?.grades.perGrader.find((g) => g.name === "provability.claimCoverage");
    expect(coverage).toMatchObject({ passed: false, score: 0 });
  }, 30_000);

  test("on_fail: halt — the invoker throws, the bundle is still found through the event", async () => {
    const cwd = tmp();
    const outDir = join(tmp(), "run");
    const { chatLoop } = liveChatLoop([[{ type: "text", text: ANSWER }]]);
    const summary = await runEval({
      ir: cliIr("provability:\n  level: grounded\n  on_fail: halt\n"),
      dataset: { name: "d", samples: samplesOf([{ id: "s1", input: "q" }]) },
      compiledGraders: [],
      opts: { outDir, cwd, chatLoop, concurrency: 1, retryErrors: false, provability: "grounded" },
    });
    const sample = summary.samples[0];
    expect(sample?.error).toBeDefined();
    const proof = JSON.parse(
      readFileSync(join(outDir, "s1", PROOF_FILENAME), "utf8"),
    ) as ProofBundle;
    expect(proof.verdict).toBe("fail");
    const rung = sample?.grades.perGrader.find((g) => g.name === "provability.rungAchieved");
    expect(rung).toMatchObject({ passed: false, score: 0.25 });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// the six graders never vote inside the graders file's combine: policy
// ---------------------------------------------------------------------------

describe("runEval — --provability graders beside combine: any / weighted (review W3-C2)", () => {
  const evOf = (fields: Record<string, unknown>): TraceEvent =>
    ({
      runId: "r",
      sessionId: "sess_0000000000000001",
      turnNumber: 1,
      traceId: "t",
      spanId: "s",
      timestamp: "2026-10-22T00:00:00.000Z",
      ...fields,
    }) as unknown as TraceEvent;
  const passEv = (verdict: "pass" | "fail", retryIndex: number) =>
    evOf({ kind: "provability_graded", level: "grounded", verdict, retryIndex, bundleHash: "x" });
  /** Gate spend of `usd` dollars inside a retry window. */
  const spent = (usd: number): TraceEvent[] =>
    usd === 0
      ? [passEv("pass", 0)]
      : [
          passEv("fail", 0),
          evOf({
            kind: "cost_accrual",
            provider: "anthropic",
            modelId: "claude-sonnet-4-6",
            inputTokens: 1,
            outputTokens: 1,
            cachedReadTokens: 0,
            costUsdMicros: usd * 1_000_000,
          }),
          passEv("pass", 1),
        ];

  async function overallFor(
    graders: string,
    proof: ProofBundle,
    events: ReadonlyArray<TraceEvent> = [],
  ) {
    const invoker: AgentInvoker = async () => ({ agentOutput: ANSWER, proof, events });
    // A graders FILE needs one grader; runEval itself takes none.
    const compiled = graders === "" ? [] : parseGradersConfig(graders).compiled;
    const summary = await runEval({
      ir: cliIr(),
      dataset: { name: "d", samples: samplesOf([{ id: "s1", input: "q" }]) },
      compiledGraders: compiled,
      opts: {
        outDir: join(tmp(), "run"),
        cwd: tmp(),
        concurrency: 1,
        retryErrors: false,
        provability: "grounded",
        invoker,
      },
    });
    const sample = summary.samples[0];
    if (sample === undefined) throw new Error("no sample");
    return sample.grades;
  }

  const WEIGHTED =
    'combine: weighted\npassing_threshold: 0.7\ngraders:\n  - name: own\n    type: contains\n    substring: "zzz"\n    weight: 2\n';
  const ANY = 'combine: any\ngraders:\n  - name: own\n    type: contains\n    substring: "zzz"\n';
  const ANY_PASSING =
    'combine: any\ngraders:\n  - name: own\n    type: contains\n    substring: "refund"\n';

  test("weighted: more gate spend can never turn a failing sample into a pass", async () => {
    const proof = await bundleOf(ANSWER, true);
    const cheap = await overallFor(WEIGHTED, proof, spent(0));
    const dear = await overallFor(WEIGHTED, proof, spent(3));
    expect(cheap.overall).toMatchObject({ passed: false, score: 0 });
    expect(dear.overall).toMatchObject({ passed: false, score: 0 });
    // The cost is still measured and recorded per grader.
    const cost = dear.perGrader.find((g) => g.name === "provability.costPerProvenClaim");
    expect(cost?.score).toBeCloseTo(3, 9);
  }, 30_000);

  test("any: vacuous provability passes cannot carry a sample whose own grader and coverage fail", async () => {
    const unfetched = await bundleOf(ANSWER, false); // claimCoverage 0
    const grades = await overallFor(ANY, unfetched);
    expect(grades.perGrader.find((g) => g.name === "provability.replayIntegrity")?.passed).toBe(
      true,
    );
    expect(grades.overall.passed).toBe(false);
  }, 30_000);

  test("any: the user's policy passing is not enough — every provability requirement must pass too", async () => {
    const unfetched = await bundleOf(ANSWER, false);
    const failing = await overallFor(ANY_PASSING, unfetched);
    expect(failing.overall.passed).toBe(false);
    expect(failing.overall.rationale).toContain("[provability.claimCoverage: ✗]");
    const fetched = await bundleOf(ANSWER, true);
    const passing = await overallFor(ANY_PASSING, fetched);
    expect(passing.overall).toMatchObject({ passed: true, score: 1 });
    // The reported cost never appears in the verdict's rationale.
    expect(passing.overall.rationale).not.toContain("provability.costPerProvenClaim");
  }, 30_000);

  test("no graders of the user's own: the score is the share of requirements met", async () => {
    const unfetched = await bundleOf(ANSWER, false);
    const grades = await overallFor("", unfetched);
    const required = grades.perGrader.filter((g) => g.name !== "provability.costPerProvenClaim");
    const met = required.filter((g) => g.passed).length;
    expect(grades.overall).toMatchObject({ passed: false, score: met / required.length });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// record → replay at proven: the cassette carries the proof artifacts
// ---------------------------------------------------------------------------

describe("runEval — record → replay at proven (review W3-C2)", () => {
  /**
   * A model that proves the MEETINGS claim with ProofCheck, then cites the
   * `prf_…` id the tool returned — recorded or replayed, whichever it was.
   */
  const proving = (messages: string): ReadonlyArray<Block> => {
    const id = messages.match(/prf_[0-9a-f]{16}/)?.[0];
    return id === undefined
      ? [
          {
            type: "tool_use",
            id: "toolu_pc1",
            name: PROOF_CHECK_TOOL,
            input: { checker: "builtin", ...MEETINGS },
          },
        ]
      : [{ type: "text", text: `${MEETINGS.claim.slice(0, -1)} [1].\n\n[1]: proof:${id}` }];
  };
  async function runProven(
    tools: { recordToolsDir: string } | { replayToolsDir: string },
    retryErrors = false,
  ) {
    const outDir = join(tmp(), "run");
    const { chatLoop, seen } = liveChatLoop(proving);
    const summary = await runEval({
      ir: cliIr(),
      dataset: { name: "d", samples: samplesOf([{ id: "s1", input: "do they overlap?" }]) },
      compiledGraders: [],
      // A fresh cwd per run: the cassette alone must carry the proof, as it
      // does to another machine.
      opts: {
        outDir,
        cwd: tmp(),
        chatLoop,
        concurrency: 1,
        retryErrors,
        provability: "proven",
        ...tools,
      },
    });
    const sample = summary.samples[0];
    if (sample === undefined) throw new Error("no sample");
    const proofPath = join(outDir, "s1", PROOF_FILENAME);
    const proof = existsSync(proofPath)
      ? (JSON.parse(readFileSync(proofPath, "utf8")) as ProofBundle)
      : undefined;
    const kinds = readFileSync(join(outDir, "s1", "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as { kind: string }).kind);
    return { outDir, sample, proof, kinds, seen };
  }
  const coverageOf = (sample: { grades: { perGrader: ReadonlyArray<{ name: string }> } }) =>
    sample.grades.perGrader.find((g) => g.name === "provability.claimCoverage");
  const reasonsOf = (proof: ProofBundle | undefined) =>
    proof?.claims.flatMap((c) => c.bindings.map((b) => [b.kind, b.reason ?? "ok"]));

  test("the replay files the recorded artifact back under its sample's root: the proof is met, nothing re-checked", async () => {
    const cassette = join(tmp(), "cassette");
    const recorded = await runProven({ recordToolsDir: cassette });
    expect(recorded.sample.error).toBeUndefined();
    expect(recorded.proof?.verdict).toBe("pass");
    expect(reasonsOf(recorded.proof)).toEqual([["formal", "ok"]]);
    const [record] = readFileSync(join(cassette, TOOL_RECORDING_FILENAME), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as ToolRecord)
      .filter((r) => r.toolName === PROOF_CHECK_TOOL);
    const artifact = record?.effects as ProofArtifact | undefined;
    expect(artifact?.ok).toBe(true);

    const replayed = await runProven({ replayToolsDir: cassette });
    expect(replayed.sample.error).toBeUndefined();
    expect(replayed.proof?.verdict).toBe("pass");
    expect(reasonsOf(replayed.proof)).toEqual([["formal", "ok"]]);
    expect(coverageOf(replayed.sample)).toMatchObject({ passed: true, score: 1 });
    // The very artifact the recorded run filed, under the REPLAYING sample's root…
    const restored = join(
      sampleProofsRoot(join(replayed.outDir, "s1"), "prov-eval"),
      "artifacts",
      `${artifact?.id}.json`,
    );
    expect(JSON.parse(readFileSync(restored, "utf8"))).toEqual(artifact);
    // …and the checker never ran on the replay.
    expect(recorded.kinds).toContain("proof_checked");
    expect(replayed.kinds).not.toContain("proof_checked");
  }, 60_000);

  test("a hand-edited cassette whose artifact is malformed stops the sample — terminally, never as proof_missing", async () => {
    const cassette = join(tmp(), "cassette");
    await runProven({ recordToolsDir: cassette });
    const path = join(cassette, TOOL_RECORDING_FILENAME);
    const edited = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((l) => {
        const r = JSON.parse(l) as ToolRecord & { effects?: Record<string, unknown> };
        return JSON.stringify(
          r.toolName === PROOF_CHECK_TOOL ? { ...r, effects: { ...r.effects, ok: "yes" } } : r,
        );
      });
    writeFileSync(path, `${edited.join("\n")}\n`);
    // retryErrors on, as `crewhaus eval` runs it: the noise retry is withheld.
    const replayed = await runProven({ replayToolsDir: cassette }, true);
    expect(replayed.sample.error).toContain(TOOL_REPLAY_RESTORE_MARKER);
    expect(replayed.sample.error).toContain("malformed");
    expect(replayed.sample.retried).toBeUndefined();
    expect(replayed.seen).toHaveLength(1);
  }, 60_000);
});
