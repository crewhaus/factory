/**
 * The release's acceptance scenarios (design §0) with the model MISBEHAVING,
 * through the live loop: `runChatLoop` + `wireEvaluation` + the real
 * verifier, the real session event log, the real `MoneyAdd` and the real
 * builtin proof checker. §0 says v0.8.0 is done when each scenario is
 * un-servable even when the model misbehaves; loop.test.ts runs the honest
 * and self-correcting paths, and this file runs the dishonest ones.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EXIT_CODES, RunFailedError } from "@crewhaus/errors";
import { type ProofBundle, proofsRoot } from "@crewhaus/provability";
import { moneyAdd } from "@crewhaus/tool-math";
import { defaultProvabilityConfig } from "@crewhaus/tool-proof";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { config, tempDirs } from "./__fixtures__/helpers";
import { type Script, URL_A, runTurn, scriptedModel, webFetch } from "./__fixtures__/loop";
import { wireEvaluation } from "./wire";

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

type Graded = TraceEvent & { verdict: string; retryIndex: number };

/** Every bundle the run persisted for its session, in pass order. */
function bundles(cwd: string, spec: string, sessionId: string): ProofBundle[] {
  const dir = join(proofsRoot(cwd, spec), sessionId);
  const order = (f: string): number => Number(/^turn-\d+(?:\.(\d+))?\.json$/.exec(f)?.[1] ?? 0);
  return readdirSync(dir)
    .sort((a, b) => order(a) - order(b))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as ProofBundle);
}

const reasons = (bundle: ProofBundle | undefined): Array<string | undefined> =>
  (bundle?.claims ?? []).flatMap((c) =>
    c.bindings.length === 0 ? ["no_citation"] : c.bindings.map((b) => b.reason),
  );

/**
 * The text of the LAST message a model request carried — on a re-run, the
 * runtime's synthetic nudge. A whole serialized request would also hold the
 * rejected answer the nudge quotes, so an assertion on it proves nothing.
 */
function nudgeOf(request: string | undefined): string {
  const messages = JSON.parse(request ?? "[]") as Array<{ role: string; content: unknown }>;
  const last = messages.at(-1);
  expect(last?.role).toBe("user");
  const content = last?.content;
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : [])
    .map((b: { type?: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : ""))
    .join("");
}

/** The page says 14 days; the model says 30, citing it. */
const THIRTY = `The refund window is 30 days [1].\n\n[1]: ${URL_A}`;
const MISQUOTE_ARC: ReadonlyArray<Script> = [
  // 1. Cites a page it never fetched.
  [{ type: "text", text: THIRTY }],
  // 2. Nudged, it fetches the page (which says 14 days)…
  [{ type: "tool_use", id: "toolu_fetch1", name: "WebFetch", input: { url: URL_A } }],
  // 3. …and misquotes it anyway.
  [{ type: "text", text: THIRTY }],
];

/**
 * One acceptance-A run through the live loop. `"reply"` is the support bot's
 * surface (a channel bot: the reply is what is served, the output is the
 * operator's log); `"stream"` is the cli's, where the reader watches every
 * attempt print.
 */
const arc = async (
  onFail: "retry" | "halt" | "note",
  footerTarget: "reply" | "stream" = "reply",
  scripts: ReadonlyArray<Script> = MISQUOTE_ARC,
) => {
  const cwd = dirs.make();
  const sessionRootDir = join(cwd, ".crewhaus", "sessions");
  const gates = await wireEvaluation(
    {
      specName: "support-bot",
      primaryModel: "test-model",
      provability: config("grounded", { onFail }),
    },
    { cwd, sessionRootDir, footerTarget, catalog: [webFetch] },
  );
  const model = scriptedModel(scripts);
  const graded: Graded[] = [];
  const out: string[] = [];
  let sessionId = "";
  let result: string | undefined;
  let caught: unknown;
  try {
    const run = await runTurn({
      model,
      tools: [webFetch],
      gates,
      sessionRootDir,
      onEvent: (e) => {
        if (e.kind === "provability_graded") graded.push(e as Graded);
        if (sessionId === "") sessionId = e.sessionId ?? "";
      },
      onStdout: (chunk) => {
        out.push(chunk);
      },
    });
    result = run.result;
    sessionId = run.sessionId;
  } catch (err) {
    caught = err;
  }
  return { cwd, model, graded, sessionId, result, caught, stdout: out.join("") };
};

const FAIL_FOOTER = "── provability · grounded ✗";
const PASS_FOOTER = "── provability · grounded ✓";
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("acceptance A — the fabricated citation, model misbehaving (grounded)", () => {
  test("retry: unfetched fails, the model fetches and misquotes, fails again; served only with a ✗", async () => {
    const run = await arc("retry");
    expect(run.caught).toBeUndefined();
    expect(run.model.calls()).toBe(3);
    expect(run.graded.map((e) => [e.verdict, e.retryIndex])).toEqual([
      ["fail", 0],
      ["fail", 1],
    ]);
    const [first, second] = bundles(run.cwd, "support-bot", run.sessionId);
    expect(reasons(first)).toEqual(["not_fetched"]);
    // The body was fetched this time; it does not say 30 days.
    expect(reasons(second)).toEqual(["not_found_in_source"]);
    // The retry nudge — the runtime's own message, read alone — named the
    // reason and quoted the model's own sentence.
    const nudge = nudgeOf(run.model.requests[1]);
    expect(nudge).toContain("The provability gate did not accept your last answer");
    expect(nudge).toContain("never fetched or read it");
    expect(nudge).toContain("The refund window is 30 days");
    // The last attempt is served, but never as proven.
    expect(run.result).toStartWith(THIRTY);
    expect(run.result).toContain("── provability · grounded ✗ · 0/1 claim");
    expect(run.result).not.toContain("✓");
    // The reply is all the channel serves: the operator's log carries no verdict of its own.
    expect(run.stdout).not.toContain("── provability");
  });

  test("halt: the first failing verdict stops the run, classified provability (exit 37); nothing is served", async () => {
    const run = await arc("halt");
    expect(run.result).toBeUndefined();
    expect(run.caught).toBeInstanceOf(RunFailedError);
    const report = (run.caught as RunFailedError).report;
    expect(report.class).toBe("provability");
    expect(report.exitCode).toBe(EXIT_CODES.provability);
    expect(EXIT_CODES.provability).toBe(37);
    // halt is terminal on the first failure (design §5.1): no retry, no fetch.
    expect(run.model.calls()).toBe(1);
    expect(run.graded.map((e) => [e.verdict, e.retryIndex])).toEqual([["fail", 0]]);
    // No reply carries the answer; the operator's log shows it with the ✗
    // the halted run had no reply to put it on.
    expect(run.stdout.indexOf("The refund window is 30 days")).toBeLessThan(
      run.stdout.indexOf(`${FAIL_FOOTER} · 0/1 claim`),
    );
    expect(run.stdout).not.toContain(PASS_FOOTER);
  });

  test("note: one pass, served with the ✗ footer", async () => {
    const run = await arc("note");
    expect(run.model.calls()).toBe(1);
    expect(run.graded.map((e) => e.verdict)).toEqual(["fail"]);
    expect(run.result).toContain("── provability · grounded ✗ · 0/1 claim");
  });
});

describe("acceptance A on the cli, where the reader watches every attempt stream (§5.4)", () => {
  test("retry: every attempt the reader saw carries its ✗ — the rejected one before the retry runs — and no ✓ appears", async () => {
    const run = await arc("retry", "stream");
    expect(run.caught).toBeUndefined();
    expect(run.graded.map((e) => [e.verdict, e.retryIndex])).toEqual([
      ["fail", 0],
      ["fail", 1],
    ]);
    expect(count(run.stdout, FAIL_FOOTER)).toBe(2);
    expect(run.stdout).not.toContain(PASS_FOOTER);
    const first = run.stdout.indexOf("The refund window is 30 days");
    const firstMark = run.stdout.indexOf(FAIL_FOOTER);
    const second = run.stdout.indexOf("The refund window is 30 days", firstMark);
    expect(first).toBeLessThan(firstMark);
    expect(firstMark).toBeLessThan(second);
    expect(second).toBeLessThan(run.stdout.lastIndexOf(FAIL_FOOTER));
  });

  test("halt: the answer has printed, its ✗ follows it, and the run stops classified (exit 37) — refused, never passed off as proven", async () => {
    const run = await arc("halt", "stream");
    expect(run.result).toBeUndefined();
    expect((run.caught as RunFailedError).report.exitCode).toBe(EXIT_CODES.provability);
    expect(run.stdout.indexOf("The refund window is 30 days")).toBeLessThan(
      run.stdout.indexOf(FAIL_FOOTER),
    );
    expect(run.stdout).not.toContain(PASS_FOOTER);
  });

  test("a claim streamed before a tool call, then a bare 'Done.': the printed claim is graded, refused and corrected", async () => {
    const run = await arc("retry", "stream", [
      [
        {
          type: "text",
          text: "The refund window is 30 days from the date of purchase. I'll pull up the policy page for you.",
        },
        { type: "tool_use", id: "toolu_fetch1", name: "WebFetch", input: { url: URL_A } },
      ],
      [{ type: "text", text: "Done." }],
      [{ type: "text", text: `The refund window is 14 days [1].\n\n[1]: ${URL_A}` }],
    ]);
    expect(run.caught).toBeUndefined();
    expect(run.graded.map((e) => [e.verdict, e.retryIndex])).toEqual([
      ["fail", 0],
      ["pass", 1],
    ]);
    // The nudge quoted the sentence the reader saw, though "Done." made no claim.
    expect(nudgeOf(run.model.requests[2])).toContain("The refund window is 30 days");
    expect(run.stdout.indexOf("Done.")).toBeLessThan(run.stdout.indexOf(FAIL_FOOTER));
    expect(run.stdout.indexOf(FAIL_FOOTER)).toBeLessThan(run.stdout.indexOf("14 days [1]"));
    expect(run.stdout.indexOf("14 days [1]")).toBeLessThan(run.stdout.indexOf(PASS_FOOTER));
  });

  test("a vacuous retry ('See above.') never passes over the answer it points at", async () => {
    const run = await arc("retry", "stream", [
      [{ type: "text", text: THIRTY }],
      [{ type: "text", text: "See above." }],
    ]);
    expect(run.caught).toBeUndefined();
    expect(run.graded.map((e) => [e.verdict, e.retryIndex])).toEqual([
      ["fail", 0],
      ["fail", 1],
    ]);
    const [, second] = bundles(run.cwd, "support-bot", run.sessionId);
    expect(reasons(second)).toEqual(["not_fetched"]);
    expect(count(run.stdout, FAIL_FOOTER)).toBe(2);
    expect(run.stdout).not.toContain(PASS_FOOTER);
    expect(run.stdout.lastIndexOf(FAIL_FOOTER)).toBeGreaterThan(run.stdout.indexOf("See above."));
  });
});

describe("acceptance B — the hand-computed total, model misbehaving (checked, real MoneyAdd)", () => {
  const ADD = {
    type: "tool_use",
    id: "toolu_money1",
    name: "MoneyAdd",
    input: { currency: "USD", amountsMinor: ["100000", "28450"] },
  } as const;

  const run = async (scripts: ReadonlyArray<Script>) => {
    const cwd = dirs.make();
    const sessionRootDir = join(cwd, ".crewhaus", "sessions");
    // The lowered default allowlist (tool-proof's copy is pinned equal to the
    // compiler's): MoneyAdd counts as evidence with no spec edit.
    const allow = defaultProvabilityConfig().execution.allow;
    expect(allow).toContain("moneyAdd");
    const gates = await wireEvaluation(
      {
        specName: "invoicer",
        primaryModel: "test-model",
        provability: config("checked", { onFail: "note", execution: { allow } }),
      },
      { cwd, sessionRootDir, footerTarget: "reply", catalog: [moneyAdd] },
    );
    const turn = await runTurn({
      model: scriptedModel(scripts),
      tools: [moneyAdd],
      gates,
      sessionRootDir,
      seed: "what is the invoice total?",
    });
    const all = bundles(cwd, "invoicer", turn.sessionId);
    return { turn, bundle: all.at(-1) };
  };

  test("a total the model added up itself has no evidence", async () => {
    const { turn, bundle } = await run([
      [{ type: "text", text: "The invoice total is 1,284.50." }],
    ]);
    expect(turn.graded.map((e) => e.verdict)).toEqual(["fail"]);
    expect(reasons(bundle)).toEqual(["no_citation"]);
    expect(turn.result).toContain("── provability · checked ✗ · 0/1 claim · unmet: 1 uncited");
  });

  test("a total it computed and then misquoted fails value containment", async () => {
    const { turn, bundle } = await run([
      [ADD],
      [{ type: "text", text: "The invoice total is 1,284.60 [1].\n\n[1]: tool:toolu_money1" }],
    ]);
    expect(turn.graded.map((e) => e.verdict)).toEqual(["fail"]);
    expect(reasons(bundle)).toEqual(["value_absent"]);
  });

  test("the honest total passes, and the gate re-ran MoneyAdd to confirm it", async () => {
    const { turn, bundle } = await run([
      [ADD],
      [{ type: "text", text: "The invoice total is 1,284.50 [1].\n\n[1]: tool:toolu_money1" }],
    ]);
    expect(turn.graded.map((e) => e.verdict)).toEqual(["pass"]);
    expect(bundle?.claims[0]?.bindings[0]).toMatchObject({
      ok: true,
      kind: "execution",
      rung: "checked",
      replayed: true,
    });
    expect(turn.result).toContain("── provability · checked ✓ · 1/1 claim");
  });
});

describe("acceptance C — the overlap claim, model misbehaving (proven, builtin checker)", () => {
  // Meetings [9,10], [10.5,12], [11,14]: the second and third overlap.
  const FALSE_CLAIM = {
    checker: "builtin",
    claim: "No two of the three meetings overlap.",
    statement:
      "let s = [9, 10.5, 11], e = [10, 12, 14] in forall i in 0..2: forall j in 0..2: i = j or e[i] <= s[j] or e[j] <= s[i]",
    proof: "eval",
  };
  const citeTheArtifact: Script = (messages) => {
    const id = /prf_[0-9a-f]{16}/.exec(messages)?.[0] ?? "prf_missing";
    return [
      { type: "text", text: `No two of the three meetings overlap [1].\n\n[1]: proof:${id}` },
    ];
  };

  test("a false claim: the checker rejects it, citing the rejected proof fails, and the counterexample is the nudge", async () => {
    const cwd = dirs.make();
    const sessionRootDir = join(cwd, ".crewhaus", "sessions");
    const gates = await wireEvaluation(
      {
        specName: "scheduler",
        primaryModel: "test-model",
        provability: config("proven", {
          formal: { checkers: ["builtin"], forbid: [], timeoutMs: 30_000 },
        }),
      },
      { cwd, sessionRootDir, footerTarget: "reply", catalog: [] },
    );
    const model = scriptedModel([
      [{ type: "tool_use", id: "toolu_proof1", name: "ProofCheck", input: FALSE_CLAIM }],
      citeTheArtifact,
      citeTheArtifact,
    ]);
    const turn = await runTurn({
      model,
      tools: [],
      gates,
      sessionRootDir,
      seed: "do any of the meetings overlap?",
    });
    expect(model.calls()).toBe(3);
    expect(turn.graded.map((e) => [e.verdict, e.retryIndex])).toEqual([
      ["fail", 0],
      ["fail", 1],
    ]);
    const [first, second] = bundles(cwd, "scheduler", turn.sessionId);
    expect(reasons(first)).toEqual(["proof_rejected"]);
    expect(reasons(second)).toEqual(["proof_rejected"]);
    // The nudge — the runtime's own message, read alone — is the
    // counterexample, not a rationale.
    const nudge = nudgeOf(model.requests[2]);
    expect(nudge).toContain("The provability gate did not accept your last answer");
    expect(nudge).toContain("the checker rejected the proof");
    expect(nudge).toMatch(/counterexample: i = 1, j = 2/);
    expect(turn.result).toContain("── provability · proven ✗ · 0/1 claim · unmet: [1]");
  });

  test("under the bundles' own permission floor (default mode, no spec rules): the builtin proof runs unprompted and the honest claim is served proven", async () => {
    const cwd = dirs.make();
    const sessionRootDir = join(cwd, ".crewhaus", "sessions");
    const gates = await wireEvaluation(
      {
        specName: "scheduler",
        primaryModel: "test-model",
        // The lowered default checkers: builtin first, smt behind it.
        provability: config("proven"),
      },
      { cwd, sessionRootDir, footerTarget: "reply", catalog: [] },
    );
    // Meetings [9,10], [10.5,12], [12,14]: none overlaps.
    const TRUE_CLAIM = {
      ...FALSE_CLAIM,
      statement:
        "let s = [9, 10.5, 12], e = [10, 12, 14] in forall i in 0..2: forall j in 0..2: i = j or e[i] <= s[j] or e[j] <= s[i]",
    };
    const model = scriptedModel([
      [{ type: "tool_use", id: "toolu_proof1", name: "ProofCheck", input: TRUE_CLAIM }],
      citeTheArtifact,
    ]);
    // No bypass and no permission rules: only the builtin defaults every
    // bundle falls back to, where an unruled call asks — and a headless ask
    // parks the turn (`crewhaus run --prompt` exit 36, a channel bot or the
    // managed gateway pausing for approval).
    const turn = await runTurn({
      model,
      tools: [],
      gates,
      sessionRootDir,
      seed: "do any of the meetings overlap?",
      permissionMode: "default",
    });
    expect(turn.decisions.map((d) => [d.toolName, d.decision])).toEqual([["ProofCheck", "allow"]]);
    expect(model.calls()).toBe(2);
    expect(turn.graded.map((e) => [e.verdict, e.retryIndex])).toEqual([["pass", 0]]);
    expect(turn.result).toContain("── provability · proven ✓ · 1/1 claim");
  });
});
