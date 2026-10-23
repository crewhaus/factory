/**
 * `ProofCheck` end to end: the checker runs, the artifact lands under the
 * proofs root — accepted AND rejected — the `proof_checked` trace event is
 * published and its event-log twin appended, and every refusal says what
 * would work instead. The builtin checker runs for real; `smt` runs against
 * a scripted sandbox with Z3's real output.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult, ProofChecker } from "@crewhaus/proof-checker";
import { createBuiltinChecker, createSmtChecker } from "@crewhaus/proof-checker";
import {
  type ProofArtifact,
  buildEvidenceIndex,
  createFileArtifactStore,
  evidenceFromMessages,
  isProofArtifact,
  isProofId,
  proofsRoot,
  sha256Of,
  verifyDocument,
} from "@crewhaus/provability";
import type { ToolExecuteContext } from "@crewhaus/tool-catalog";
import { DEFAULT_THRESHOLD_BYTES, storeAndPreview } from "@crewhaus/tool-result-store";
import {
  CHECK_GRACE_MS,
  OUTPUT_CHARS,
  ProofToolError,
  REPORT_BYTES,
  buildDefaultCheckers,
  checkReport,
  createProofTools,
  runChecker,
  toArtifact,
} from "./index";
import {
  MEETINGS,
  NOW,
  Z3,
  callMessages,
  config,
  fakeRun,
  now,
  tempDirs,
  z3Sandbox,
} from "./test-helpers";

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
type Json = any;

async function check(
  tools: ReturnType<typeof createProofTools>,
  input: Record<string, unknown>,
  ctx?: ToolExecuteContext,
): Promise<Json> {
  return (await checkLogged(tools, input, ctx)).out;
}

/**
 * One ProofCheck call and its transcript (`callMessages`): what the `proven`
 * rung reads to know a checker accepted the artifact the call wrote.
 */
async function checkLogged(
  tools: ReturnType<typeof createProofTools>,
  input: Record<string, unknown>,
  ctx?: ToolExecuteContext,
): Promise<{ readonly out: Json; readonly messages: ReturnType<typeof callMessages> }> {
  const raw = await tools.proofCheck.execute(input, ctx);
  if (typeof raw !== "string") throw new Error("expected a string result");
  const out = JSON.parse(raw);
  return { out, messages: callMessages(`toolu_${out.id}`, "ProofCheck", input, raw) };
}

function artifactsIn(root: string): string[] {
  const dir = join(root, "artifacts");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function builtinTools(root: string, extra: Partial<Parameters<typeof createProofTools>[0]> = {}) {
  return createProofTools({
    config: config("proven"),
    proofsRoot: root,
    checkers: [createBuiltinChecker()],
    now,
    ...extra,
  });
}

describe("ProofCheck with the builtin checker (no sandbox)", () => {
  test("an accepted proof: persisted, reported with its id and how to cite it", async () => {
    const root = dirs.make();
    const run = fakeRun();
    const out = await check(builtinTools(root), { checker: "builtin", ...MEETINGS }, run.ctx);
    expect(out.ok).toBe(true);
    expect(isProofId(out.id)).toBe(true);
    expect(out.checker).toBe("builtin");
    expect(out.assumptions).toEqual([]);
    expect(out.axioms).toEqual([]);
    expect(out.output).toContain("proved");
    expect(out.next).toBe(
      `cite it as [n]: proof:${out.id} — put [n] on the sentence that states this claim, with the same words, figures and polarity, or the gate reports claim_mismatch`,
    );
    expect(out.reason).toBeUndefined();
    expect(out.counterexample).toBeUndefined();

    expect(artifactsIn(root)).toEqual([`${out.id}.json`]);
    const artifact = (await createFileArtifactStore({ rootDir: root }).get(
      out.id,
    )) as ProofArtifact;
    expect(isProofArtifact(artifact)).toBe(true);
    expect(artifact).toMatchObject({
      version: 1,
      id: out.id,
      checker: "builtin",
      claim: MEETINGS.claim,
      statement: MEETINGS.statement,
      proof: MEETINGS.proof,
      ok: true,
      assumptions: [],
      axioms: [],
      checkedAt: NOW.toISOString(),
    });
    expect(artifact.outputDigest).toBe(sha256Of(artifact.output));
    expect(typeof artifact.durationMs).toBe("number");
    // Mode 0600: the artifact is the audit record (provability's store).
    expect(statSync(join(root, "artifacts", `${out.id}.json`)).mode & 0o777).toBe(0o600);
  });

  test("a rejected proof is persisted too, with the reason and the counterexample", async () => {
    const root = dirs.make();
    const out = await check(
      builtinTools(root),
      {
        checker: "builtin",
        claim: MEETINGS.claim,
        statement: MEETINGS.falseStatement,
        proof: "eval",
      },
      fakeRun().ctx,
    );
    expect(out.ok).toBe(false);
    expect(isProofId(out.id)).toBe(true);
    expect(out.reason).toContain("the formula is false");
    expect(out.counterexample).toContain("i = 0, j = 1");
    expect(out.next).toContain("not proven");
    expect(out.next).toContain("the counterexample shows where it fails");
    expect(out.next).toContain("proof_rejected");

    const artifact = await createFileArtifactStore({ rootDir: root }).get(out.id);
    expect(artifact).toMatchObject({ ok: false, counterexample: out.counterexample });
    expect(artifact?.reason).toBe(out.reason);
  });

  test("a rejection without a counterexample says so plainly", async () => {
    const root = dirs.make();
    const out = await check(
      builtinTools(root),
      {
        checker: "builtin",
        claim: "x plus y is at most 10.",
        statement: "x + y <= 10",
        proof: JSON.stringify([
          { id: "h1", stmt: "x <= 4", by: "given", from: [] },
          { id: "h2", stmt: "y <= 6", by: "given", from: [] },
        ]),
      },
      fakeRun().ctx,
    );
    expect(out.ok).toBe(false);
    expect(out.counterexample).toBeUndefined();
    expect(out.next).not.toContain("counterexample");
    // The givens are what the proof rests on: assumptions in the artifact.
    expect(out.assumptions).toEqual(["x <= 4", "y <= 6"]);
  });

  test("each check is its own artifact, never an overwrite", async () => {
    const root = dirs.make();
    const tools = builtinTools(root);
    const a = await check(tools, { checker: "builtin", ...MEETINGS }, fakeRun().ctx);
    const b = await check(tools, { checker: "builtin", ...MEETINGS }, fakeRun().ctx);
    expect(a.id).not.toBe(b.id);
    expect(artifactsIn(root)).toEqual([`${a.id}.json`, `${b.id}.json`].sort());
  });

  test("publishes proof_checked on the run's bus and appends its event-log twin", async () => {
    const root = dirs.make();
    const run = fakeRun();
    const out = await check(builtinTools(root), { checker: "builtin", ...MEETINGS }, run.ctx);
    const published = run.events.filter((e) => e.kind === "proof_checked");
    expect(published).toHaveLength(1);
    const event = published[0] as Json;
    expect(event).toMatchObject({
      kind: "proof_checked",
      checker: "builtin",
      ok: true,
      artifactId: out.id,
      axioms: [],
      runId: "run_00000001",
      sessionId: "sess_00000000000000aa",
    });
    expect(typeof event.durationMs).toBe("number");
    expect(typeof event.timestamp).toBe("string");
    expect(run.appended).toEqual([
      {
        kind: "proof_checked",
        payload: {
          checker: "builtin",
          ok: true,
          artifactId: out.id,
          durationMs: event.durationMs,
          axioms: [],
        },
      },
    ]);
  });

  test("a rejected proof publishes proof_checked too (ok: false)", async () => {
    const run = fakeRun();
    await check(
      builtinTools(dirs.make()),
      {
        checker: "builtin",
        claim: MEETINGS.claim,
        statement: MEETINGS.falseStatement,
        proof: "eval",
      },
      run.ctx,
    );
    expect(run.events.filter((e) => e.kind === "proof_checked").map((e) => (e as Json).ok)).toEqual(
      [false],
    );
    expect(run.appended.map((e) => (e.payload as Json).ok)).toEqual([false]);
  });

  test("off the loop (no context) it still checks and persists, and publishes nothing", async () => {
    const root = dirs.make();
    const out = await check(builtinTools(root), { checker: "builtin", ...MEETINGS });
    expect(out.ok).toBe(true);
    expect(artifactsIn(root)).toEqual([`${out.id}.json`]);
  });

  test("ctx.runContext is read first when the runtime supplies it there", async () => {
    const run = fakeRun();
    const bridge = run.ctx.bridge as { runContext: unknown };
    await check(builtinTools(dirs.make()), { checker: "builtin", ...MEETINGS }, {
      runContext: bridge.runContext,
    } as ToolExecuteContext);
    expect(run.events.filter((e) => e.kind === "proof_checked")).toHaveLength(1);
  });

  test("a failing event-log append is logged, not an error: the artifact is the record", async () => {
    const root = dirs.make();
    const run = fakeRun({ appendThrows: true });
    const out = await check(builtinTools(root), { checker: "builtin", ...MEETINGS }, run.ctx);
    expect(out.ok).toBe(true);
    expect(artifactsIn(root)).toHaveLength(1);
    expect(run.warnings.some((w) => w.includes("event log"))).toBe(true);
  });

  test("a bus whose publish throws is logged, not an error", async () => {
    const root = dirs.make();
    const warnings: string[] = [];
    const ctx = {
      bridge: {
        runContext: {
          sessionId: "sess_00000000000000aa",
          eventBus: {
            envelope: () => ({}),
            publish: () => {
              throw new Error("bus closed");
            },
          },
          logger: { warn: (msg: string) => warnings.push(msg) },
        },
      },
    } as ToolExecuteContext;
    const out = await check(builtinTools(root), { checker: "builtin", ...MEETINGS }, ctx);
    expect(out.ok).toBe(true);
    expect(warnings.some((w) => w.includes("could not be published"))).toBe(true);
  });
});

describe("ProofCheck refusals", () => {
  test("an unknown checker id is refused, naming the checkers there are", async () => {
    const root = dirs.make();
    const tools = createProofTools({
      config: config("proven"),
      proofsRoot: root,
      checkers: buildDefaultCheckers(config("proven"), {
        sandboxAvailable: false,
        createSandbox: () => z3Sandbox(""),
      }),
    });
    const err = await tools.proofCheck
      .execute({ checker: "coq", ...MEETINGS }, fakeRun().ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProofToolError);
    expect((err as Error).message).toBe(
      'unknown proof checker "coq" — available: builtin; listed but not available here: smt. Run ProofCheckers to see what each one proves.',
    );
    expect(artifactsIn(root)).toEqual([]);
  });

  test("an unavailable checker is refused with its reason; nothing is checked or saved", async () => {
    const root = dirs.make();
    const run = fakeRun();
    const tools = createProofTools({
      config: config("proven"),
      proofsRoot: root,
      checkers: buildDefaultCheckers(config("proven"), {
        sandboxAvailable: false,
        createSandbox: () => z3Sandbox(""),
      }),
    });
    const err = await tools.proofCheck
      .execute(
        { checker: "smt", claim: "x", statement: "(<= x 1)", proof: "(declare-const x Int)" },
        run.ctx,
      )
      .catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain("the smt checker cannot run here");
    expect((err as Error).message).toContain("needs a container sandbox");
    expect((err as Error).message).toContain("available: builtin");
    expect(artifactsIn(root)).toEqual([]);
    expect(run.events.filter((e) => e.kind === "proof_checked")).toEqual([]);
    expect(run.appended).toEqual([]);
  });

  test("a cancelled check saves nothing", async () => {
    const root = dirs.make();
    const controller = new AbortController();
    const slow: ProofChecker = {
      id: "slow",
      language: "slow: waits",
      async available() {
        return { ok: true };
      },
      async check(input) {
        controller.abort();
        return {
          ok: false,
          checker: "slow",
          assumptions: [],
          axioms: [],
          output: "",
          reason: input.signal?.aborted === true ? "the check was cancelled" : "?",
          durationMs: 1,
        };
      },
    };
    const tools = createProofTools({ proofsRoot: root, checkers: [slow] });
    const err = await tools.proofCheck
      .execute({ checker: "slow", ...MEETINGS }, fakeRun({ signal: controller.signal }).ctx)
      .catch((e: unknown) => e as Error);
    expect((err as Error).message).toBe("ProofCheck was cancelled; nothing was saved");
    expect(artifactsIn(root)).toEqual([]);
  });

  test("an artifact that cannot be saved is an error, saying the proof cannot be cited", async () => {
    const parent = dirs.make();
    // A FILE where the proofs root's artifacts directory must go.
    const root = join(parent, "proofs");
    const tools = builtinTools(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "artifacts"), "not a directory");
    const err = await tools.proofCheck
      .execute({ checker: "builtin", ...MEETINGS }, fakeRun().ctx)
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ProofToolError);
    expect((err as Error).message).toContain(
      "the builtin checker accepted the proof, but the artifact could not be saved, so it cannot be cited",
    );
  });
});

describe("ProofCheck with smt (a scripted sandbox)", () => {
  const SMT_INPUT = {
    checker: "smt",
    claim: "x plus y is at most 10.",
    statement: "(<= (+ x y) 10)",
    proof: "(declare-const x Int) (declare-const y Int) (assert (<= x 4)) (assert (<= y 6))",
  };

  function smtTools(root: string, answer: string) {
    const sandbox = z3Sandbox(answer);
    const tools = createProofTools({
      config: config("proven"),
      proofsRoot: root,
      checkers: buildDefaultCheckers(config("proven"), {
        sandboxAvailable: true,
        createSandbox: () => sandbox,
      }),
      now,
    });
    return { tools, sandbox };
  }

  test("unsat on the negated goal: proven, the asserts are the proof's assumptions", async () => {
    const root = dirs.make();
    const { tools, sandbox } = smtTools(root, Z3.proved);
    const run = fakeRun();
    const out = await check(tools, SMT_INPUT, run.ctx);
    expect(out.ok).toBe(true);
    expect(out.checker).toBe("smt");
    expect(out.assumptions).toEqual(["(<= x 4)", "(<= y 6)"]);
    // Probe, then one z3 run reading the script on stdin.
    expect(sandbox.calls.map((c) => c.argv)).toEqual([
      ["z3", "--version"],
      ["z3", "-in"],
    ]);
    expect(sandbox.calls[1]?.stdin).toContain("(assert (not (<= (+ x y) 10)))");
    const artifact = await createFileArtifactStore({ rootDir: root }).get(out.id);
    expect(artifact).toMatchObject({ ok: true, checker: "smt", assumptions: out.assumptions });
    expect(run.events.find((e) => e.kind === "proof_checked")).toMatchObject({
      checker: "smt",
      ok: true,
      artifactId: out.id,
    });
  });

  test("sat on the negated goal: rejected with Z3's model as the counterexample, and persisted", async () => {
    const root = dirs.make();
    const { tools } = smtTools(root, Z3.counterexample);
    const out = await check(tools, SMT_INPUT, fakeRun().ctx);
    expect(out.ok).toBe(false);
    expect(out.counterexample).toContain("x = 4");
    expect(out.reason).toContain("z3 found a counterexample");
    expect(artifactsIn(root)).toEqual([`${out.id}.json`]);
  });

  test("the probe is remembered: a second check does not re-run the health check", async () => {
    const root = dirs.make();
    const { tools, sandbox } = smtTools(root, Z3.proved);
    await check(tools, SMT_INPUT, fakeRun().ctx);
    await check(tools, SMT_INPUT, fakeRun().ctx);
    expect(sandbox.calls.filter((c) => c.argv.includes("--version"))).toHaveLength(1);
  });

  test("on a noop backend smt refuses itself — the floor is per checker, not per tool", async () => {
    const root = dirs.make();
    const tools = createProofTools({
      proofsRoot: root,
      checkers: [
        createBuiltinChecker(),
        createSmtChecker({ sandbox: { ...z3Sandbox(Z3.proved), backend: "noop" } }),
      ],
    });
    const err = await tools.proofCheck
      .execute(SMT_INPUT, fakeRun().ctx)
      .catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain("noop");
    // The builtin, on the same harness, still proves.
    const ok = await check(tools, { checker: "builtin", ...MEETINGS }, fakeRun().ctx);
    expect(ok.ok).toBe(true);
  });
});

describe("plugin checkers are normalised, never trusted", () => {
  function pluginTools(root: string, check: ProofChecker["check"]) {
    return createProofTools({
      proofsRoot: root,
      checkers: [
        {
          id: "plug",
          language: "plug: a plugin",
          async available() {
            return { ok: true };
          },
          check,
        },
      ],
      now,
    });
  }

  test("a checker that throws has proved nothing: a persisted rejection naming the failure", async () => {
    const root = dirs.make();
    const out = await check(
      pluginTools(root, async () => {
        throw new Error("segfault");
      }),
      { checker: "plug", ...MEETINGS },
      fakeRun().ctx,
    );
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("the plug checker failed: segfault");
    expect(artifactsIn(root)).toHaveLength(1);
  });

  test("only ok === true is a proof; junk fields are dropped; a reasonless rejection gets one", async () => {
    const root = dirs.make();
    const out = await check(
      pluginTools(
        root,
        async () =>
          ({
            ok: "yes",
            checker: "someone-else",
            assumptions: ["h", 3, null],
            axioms: "propext",
            output: 42,
            durationMs: -5,
          }) as unknown as CheckResult,
      ),
      { checker: "plug", ...MEETINGS },
      fakeRun().ctx,
    );
    expect(out.ok).toBe(false);
    expect(out.checker).toBe("plug");
    expect(out.assumptions).toEqual(["h"]);
    expect(out.axioms).toEqual([]);
    expect(out.output).toBe("");
    expect(out.reason).toBe("the plug checker did not accept the proof");
    const artifact = await createFileArtifactStore({ rootDir: root }).get(out.id);
    expect(artifact?.checker).toBe("plug");
    expect(artifact?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("oversized output is clipped in the artifact and the report; long lists are capped", async () => {
    const root = dirs.make();
    const tools = pluginTools(root, async () => ({
      ok: true,
      checker: "plug",
      assumptions: Array.from({ length: 60 }, (_, i) => `h${i} ${"x".repeat(600)}`),
      axioms: [],
      output: "y".repeat(50_000),
      durationMs: 3,
    }));
    const text = (await tools.proofCheck.execute(
      { checker: "plug", ...MEETINGS },
      fakeRun().ctx,
    )) as string;
    const out = JSON.parse(text);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(REPORT_BYTES);
    expect(out.output.length).toBeLessThan(OUTPUT_CHARS + 100);
    expect(out.output).toContain("characters omitted");
    // As many assumptions as fit, each clipped, then a count of the rest.
    const shown = out.assumptions.slice(0, -1);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(60);
    for (const item of shown) expect(item.length).toBeLessThanOrEqual(300);
    expect(out.assumptions.at(-1)).toBe(
      `… and ${60 - shown.length} more (the artifact keeps them all)`,
    );
    const artifact = await createFileArtifactStore({ rootDir: root }).get(out.id);
    // The artifact keeps every assumption whole; its output is clipped once.
    expect(artifact?.assumptions).toHaveLength(60);
    expect(artifact?.assumptions[0]?.length).toBe(603);
    expect(artifact?.output.length).toBeLessThan(OUTPUT_CHARS + 100);
  });

  test("whatever a checker returns, the report reaches the model whole, instruction first", async () => {
    // The runtime spills a result over 10 KB and shows only its head; a
    // report that grew past it lost `next`. Every field here is at the
    // artifact's own cap, in characters JSON escapes into six bytes each
    // or UTF-8 spends three on.
    const heavy = (n: number) => '\u0001"€\n'.repeat(n);
    const root = dirs.make();
    const tools = pluginTools(root, async () => ({
      ok: false,
      checker: "plug",
      assumptions: Array.from({ length: 200 }, () => heavy(200)),
      axioms: Array.from({ length: 200 }, () => heavy(200)),
      output: heavy(20_000),
      reason: heavy(2_000),
      counterexample: heavy(2_000),
      durationMs: 3,
    }));
    const text = (await tools.proofCheck.execute(
      { checker: "plug", ...MEETINGS },
      fakeRun().ctx,
    )) as string;
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(REPORT_BYTES);
    expect(REPORT_BYTES).toBeLessThan(DEFAULT_THRESHOLD_BYTES);
    const stored = await storeAndPreview(
      { toolUseId: "toolu_check1", content: text, isError: false },
      { runId: "run_00000001", toolUseId: "toolu_check1", rootDir: dirs.make() },
    );
    expect(stored.persisted).toBe(false);
    expect(stored.previewContent).toBe(text);
    const out = JSON.parse(text);
    const keys = Object.keys(out);
    expect(keys.slice(0, 4)).toEqual(["ok", "id", "checker", "next"]);
    expect(out.next).toContain("not proven");
    expect(out.reason.length).toBeGreaterThan(0);
    expect(out.counterexample.length).toBeGreaterThan(0);
    expect(out.output.length).toBeGreaterThan(0);
    expect(out.assumptions.at(-1)).toMatch(/^… and \d+ more \(the artifact keeps them all\)$/);
    expect(out.axioms.at(-1)).toMatch(/^… and \d+ more \(the artifact keeps them all\)$/);
  });
});

describe("a checker that does not settle", () => {
  const never: ProofChecker = {
    id: "stuck",
    language: "stuck: never answers",
    async available() {
      return { ok: true };
    },
    check: () => new Promise<CheckResult>(() => {}),
  };

  test("an abort ends the call at once, and nothing is saved", async () => {
    const root = dirs.make();
    const run = fakeRun({ signal: AbortSignal.timeout(50) });
    const tools = createProofTools({ proofsRoot: root, checkers: [never] });
    const started = performance.now();
    const err = await tools.proofCheck
      .execute({ checker: "stuck", ...MEETINGS }, run.ctx)
      .catch((e: unknown) => e as Error);
    expect((err as Error).message).toBe("ProofCheck was cancelled; nothing was saved");
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(artifactsIn(root)).toEqual([]);
    expect(run.events.filter((e) => e.kind === "proof_checked")).toEqual([]);
  });

  test("past its time limit it is a saved rejection saying so", async () => {
    const root = dirs.make();
    const run = fakeRun();
    const tools = createProofTools({ proofsRoot: root, checkers: [never], checkTimeoutMs: 50 });
    const out = await check(tools, { checker: "stuck", ...MEETINGS }, run.ctx);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("the stuck checker did not finish within 50 ms, so nothing was proved");
    expect(artifactsIn(root)).toEqual([`${out.id}.json`]);
    expect(run.events.filter((e) => e.kind === "proof_checked")).toHaveLength(1);
  });

  test("the default time limit is formal.timeoutMs plus the grace", async () => {
    const seen: number[] = [];
    const original = globalThis.setTimeout;
    // Record the backstop the tool arms, then let it fire at once.
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      seen.push(ms ?? 0);
      return original(fn, 0);
    }) as typeof setTimeout;
    try {
      const tools = createProofTools({
        config: config("proven", { formal: { timeoutMs: 1_234 } }),
        proofsRoot: dirs.make(),
        checkers: [never],
      });
      const out = await check(tools, { checker: "stuck", ...MEETINGS }, fakeRun().ctx);
      expect(out.reason).toContain(`within ${1_234 + CHECK_GRACE_MS} ms`);
    } finally {
      globalThis.setTimeout = original;
    }
    expect(seen).toContain(1_234 + CHECK_GRACE_MS);
  });
});

describe("a builtin check leaves the harness's event loop free (design §18)", () => {
  test("timers fire during each of a turn's worst-case checks, run one after another", async () => {
    // Runs until its deadline. On the harness's thread a turn of three such
    // checks — the runtime runs ProofCheck calls one at a time, and nothing
    // between them yields — held the whole process, every session and every
    // tenant, for 30 s; the builtin now checks on a worker thread.
    const statement = "let a = 3^2500 / 7^1100 in forall i in 0..9999: a * a / (a + i) > -1";
    const builtin = createBuiltinChecker({ timeoutMs: 1_000 });
    const events: string[] = [];
    let n = 0;
    // The builtin as it is, noting when each check's verdict is in (the
    // call goes on to write the artifact and the log line).
    const noted: ProofChecker = {
      ...builtin,
      check: (input) =>
        builtin.check(input).then((result) => {
          events.push(`checked ${n}`);
          return result;
        }),
    };
    const tools = builtinTools(dirs.make(), { checkers: [noted] });
    for (n = 1; n <= 2; n++) {
      const call = check(
        tools,
        { checker: "builtin", claim: "The ratio stays above -1.", statement, proof: "eval" },
        fakeRun().ctx,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      events.push(`timer ${n}`);
      const out = await call;
      expect(out.ok).toBe(false);
      expect(out.reason).toMatch(/ran out of time/);
    }
    expect(events).toEqual(["timer 1", "checked 1", "timer 2", "checked 2"]);
  }, 20_000);
});

describe("the artifact is what the proven rung reads", () => {
  test("a sentence citing the accepted artifact is proven; the rejected one is proof_rejected", async () => {
    const root = dirs.make();
    const tools = builtinTools(root);
    const goodCall = await checkLogged(tools, { checker: "builtin", ...MEETINGS }, fakeRun().ctx);
    const badCall = await checkLogged(
      tools,
      {
        checker: "builtin",
        claim: MEETINGS.claim,
        statement: MEETINGS.falseStatement,
        proof: "eval",
      },
      fakeRun().ctx,
    );
    const good = goodCall.out;
    const bad = badCall.out;
    // The run's transcript holds both calls: the rung reads the verdict and
    // the input there, never off the artifact file alone.
    const evidence = buildEvidenceIndex(
      evidenceFromMessages([...goodCall.messages, ...badCall.messages]),
    );
    const artifacts = createFileArtifactStore({ rootDir: root });
    const answer = (id: string) =>
      `No two of the three meetings overlap [1].\n\n[1]: proof:${id}\n`;
    // With no record of the call, the file alone proves nothing.
    const unlogged = await verifyDocument(answer(good.id), {
      config: config("proven"),
      evidence: buildEvidenceIndex([]),
      artifacts,
      now,
    });
    expect(unlogged.claims[0]?.bindings[0]?.reason).toBe("proof_missing");
    const proven = await verifyDocument(answer(good.id), {
      config: config("proven"),
      evidence,
      artifacts,
      now,
    });
    expect(proven.verdict).toBe("pass");
    expect(proven.claims[0]?.bindings[0]).toMatchObject({
      kind: "formal",
      rung: "proven",
      ok: true,
    });
    const rejected = await verifyDocument(answer(bad.id), {
      config: config("proven"),
      evidence,
      artifacts,
      now,
    });
    expect(rejected.verdict).toBe("fail");
    expect(rejected.claims[0]?.bindings[0]?.reason).toBe("proof_rejected");
  });

  test("the builtin instance files artifacts under <cwd>/.crewhaus/proofs/<spec or default>", async () => {
    const cwd = dirs.make();
    const tools = createProofTools({ workspaceRoot: cwd, checkers: [createBuiltinChecker()] });
    const out = await check(tools, { checker: "builtin", ...MEETINGS }, fakeRun().ctx);
    expect(artifactsIn(proofsRoot(cwd, "default"))).toEqual([`${out.id}.json`]);
    // A spec name the run carries is used when the caller gave none.
    const named = await check(
      tools,
      { checker: "builtin", ...MEETINGS },
      fakeRun({ specName: "support-bot" }).ctx,
    );
    expect(artifactsIn(proofsRoot(cwd, "support-bot"))).toEqual([`${named.id}.json`]);
    // An unusable one is ignored rather than turned into a path.
    const odd = await check(
      tools,
      { checker: "builtin", ...MEETINGS },
      fakeRun({ specName: "../../etc" }).ctx,
    );
    expect(artifactsIn(proofsRoot(cwd, "default"))).toContain(`${odd.id}.json`);
  });

  test("an explicit specName wins over the run's", async () => {
    const cwd = dirs.make();
    const tools = createProofTools({
      workspaceRoot: cwd,
      specName: "invoicer",
      checkers: [createBuiltinChecker()],
    });
    const out = await check(
      tools,
      { checker: "builtin", ...MEETINGS },
      fakeRun({ specName: "support-bot" }).ctx,
    );
    expect(artifactsIn(proofsRoot(cwd, "invoicer"))).toEqual([`${out.id}.json`]);
  });
});

describe("lib: runChecker / toArtifact / checkReport", () => {
  test("toArtifact clips the reason and counterexample and digests the clipped output", () => {
    const result: CheckResult = {
      ok: false,
      checker: "builtin",
      assumptions: [],
      axioms: [],
      output: "out",
      reason: "r".repeat(5_000),
      counterexample: "c".repeat(5_000),
      durationMs: 7,
    };
    const artifact = toArtifact({
      id: "prf_0123456789abcdef",
      checker: createBuiltinChecker(),
      input: { claim: "c", statement: "s", proof: "p" },
      result,
      checkedAt: NOW,
    });
    expect(artifact.reason?.length).toBe(2_000);
    expect(artifact.counterexample?.length).toBe(2_000);
    expect(artifact.outputDigest).toBe(sha256Of("out"));
    expect(artifact.durationMs).toBe(7);
    expect(isProofArtifact(artifact)).toBe(true);
    expect(checkReport(artifact)).toMatchObject({ ok: false, id: "prf_0123456789abcdef" });
  });

  test("runChecker forwards the signal and the three texts, nothing else", async () => {
    const seen: unknown[] = [];
    const controller = new AbortController();
    await runChecker(
      {
        id: "spy",
        language: "",
        async available() {
          return { ok: true };
        },
        async check(input) {
          seen.push(input);
          return {
            ok: true,
            checker: "spy",
            assumptions: [],
            axioms: [],
            output: "",
            durationMs: 0,
          };
        },
      },
      { claim: "c", statement: "s", proof: "p" },
      { signal: controller.signal },
    );
    expect(seen).toEqual([{ claim: "c", statement: "s", proof: "p", signal: controller.signal }]);
  });

  test("runChecker: an already-aborted signal never starts the check", async () => {
    let started = false;
    const controller = new AbortController();
    controller.abort();
    const result = await runChecker(
      {
        id: "spy",
        language: "",
        async available() {
          return { ok: true };
        },
        async check() {
          started = true;
          throw new Error("should not run");
        },
      },
      { claim: "c", statement: "s", proof: "p" },
      { signal: controller.signal },
    );
    expect(started).toBe(false);
    expect(result).toMatchObject({ ok: false, reason: "the check was cancelled" });
  });

  test("runChecker: a check that rejects after the time limit is not an unhandled rejection", async () => {
    const result = await runChecker(
      {
        id: "late",
        language: "",
        async available() {
          return { ok: true };
        },
        check: () =>
          new Promise<CheckResult>((_, reject) => setTimeout(() => reject(new Error("late")), 40)),
      },
      { claim: "c", statement: "s", proof: "p" },
      { timeoutMs: 5 },
    );
    expect(result.reason).toBe(
      "the late checker did not finish within 5 ms, so nothing was proved",
    );
    // Let the late rejection land; bun fails the test on an unhandled one.
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
});

test("the proofs root for writes is never created by a refusal", async () => {
  const cwd = dirs.make();
  const tools = createProofTools({ workspaceRoot: cwd, checkers: [createBuiltinChecker()] });
  await tools.proofCheck
    .execute({ checker: "nope", ...MEETINGS }, fakeRun().ctx)
    .catch(() => undefined);
  expect(existsSync(join(cwd, ".crewhaus"))).toBe(false);
});
