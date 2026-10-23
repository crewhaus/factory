/**
 * `ProvabilityPreflight` grades a draft exactly as the gate would: every
 * verdict here is compared with `verifyDocument` run directly over the same
 * session log, the same config and the same artifacts. Where the preflight
 * deliberately differs (no HEAD, no replay, no judge) it says so in `notes`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBuiltinChecker } from "@crewhaus/proof-checker";
import {
  type ProofBundle,
  type ProofClaim,
  buildEvidenceIndex,
  createFileArtifactStore,
  evidenceFromSessionLog,
  recordFromCall,
  renderFooter,
  renderNudge,
  verifyDocument,
} from "@crewhaus/provability";
import type { ToolExecuteContext } from "@crewhaus/tool-catalog";
import { DEFAULT_THRESHOLD_BYTES, storeAndPreview } from "@crewhaus/tool-result-store";
import {
  NOTES_BYTES,
  ProofToolError,
  REPORT_BYTES,
  ROW_BINDINGS,
  TABLE_ROWS,
  createProofTools,
  preflightBundle,
  preflightConfig,
  preflightReport,
  proofRecheck,
} from "./index";
import {
  MEETINGS,
  SESSION,
  call,
  config,
  fakeRun,
  fetched,
  now,
  subAgent,
  tempDirs,
  userMessage,
  writeLog,
} from "./test-helpers";

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
type Json = any;

const POLICY = "https://acme.example/policy";
const BODY =
  "Returns and refunds. Refunds are accepted within 14 days of purchase when the item is unused. Shipping costs are not refunded.";

/** A session that fetched the refund policy (acceptance scenario A's page). */
async function fetchedPolicy(sessions: string): Promise<void> {
  await writeLog(sessions, SESSION, [
    userMessage("what is the refund window?"),
    ...call("toolu_fetch1", "WebFetch", { url: POLICY }, fetched(POLICY, BODY)),
  ]);
}

const GROUNDED = `Refunds are accepted within 14 days of purchase [1].\n\n[1]: ${POLICY}\n`;
const FABRICATED =
  "Refunds are accepted within 30 days of purchase [1].\n\n[1]: https://acme.example/terms\n";

type Setup = {
  readonly tools: ReturnType<typeof createProofTools>;
  readonly ctx: ToolExecuteContext;
  readonly sessions: string;
  readonly workspace: string;
  readonly proofs: string;
};

function setup(
  level = config("grounded"),
  extra: Parameters<typeof createProofTools>[0] = {},
): Setup {
  const workspace = dirs.make();
  const sessions = dirs.make();
  const proofs = dirs.make();
  return {
    tools: createProofTools({
      config: level,
      proofsRoot: proofs,
      workspaceRoot: workspace,
      checkers: [createBuiltinChecker()],
      now,
      ...extra,
    }),
    ctx: fakeRun({ sessionRootDir: sessions }).ctx,
    sessions,
    workspace,
    proofs,
  };
}

async function preflight(s: Setup, draft: string, ctx: ToolExecuteContext = s.ctx): Promise<Json> {
  const out = await s.tools.provabilityPreflight.execute({ draft }, ctx);
  if (typeof out !== "string") throw new Error("expected a string result");
  return JSON.parse(out);
}

/** The gate's verdict: `verifyDocument` straight over the session log, as the gate builds it. */
async function gate(s: Setup, draft: string, level = config("grounded")): Promise<ProofBundle> {
  const records = await evidenceFromSessionLog({ sessionId: SESSION, rootDir: s.sessions });
  return verifyDocument(draft, {
    config: level,
    evidence: buildEvidenceIndex(records),
    artifacts: createFileArtifactStore({ rootDir: s.proofs }),
    workspaceRoot: s.workspace,
    recheckProof: proofRecheck({ timeoutMs: level.formal.timeoutMs }),
    now,
  });
}

/**
 * One ProofCheck call as the run makes it: the tool runs, and the runtime
 * logs its `tool_use` and `tool_result` in the session log, where the
 * `proven` rung reads that a checker accepted the artifact it wrote.
 */
async function proofChecked(s: Setup, input: Record<string, unknown>): Promise<Json> {
  const raw = (await s.tools.proofCheck.execute(input, s.ctx)) as string;
  const out = JSON.parse(raw);
  await writeLog(s.sessions, SESSION, call(`toolu_${out.id}`, "ProofCheck", input, raw));
  return out;
}

/** The report the preflight would give for `bundle` (no notes). */
function reportOf(bundle: ProofBundle): Json {
  return JSON.parse(JSON.stringify(preflightReport(bundle, [])));
}

describe("the same verdict the gate would give", () => {
  test("a grounded claim over a page the run fetched: pass, identical to the gate", async () => {
    const s = setup();
    await fetchedPolicy(s.sessions);
    const out = await preflight(s, GROUNDED);
    const expected = await gate(s, GROUNDED);
    expect(expected.verdict).toBe("pass");
    expect(out).toEqual(reportOf(expected));
    expect(out).toMatchObject({
      verdict: "pass",
      level: "grounded",
      score: 1,
      claims: 1,
      met: 1,
      unmet: 0,
      sources: 1,
    });
    expect(out.footer).toBe(renderFooter(expected));
    expect(out.table[0].evidence[0]).toMatchObject({
      ref: "[1]",
      kind: "source",
      rung: "grounded",
      ok: true,
      origin: POLICY,
    });
    expect(out.nudge).toBeUndefined();
    expect(out.next).toContain("the gate would accept this draft");
    // No fetched text comes back: excerpts stay in the bundle.
    expect(JSON.stringify(out)).not.toContain("unused");
  });

  test("acceptance scenario A — a citation of a page never fetched: fail, not_fetched, with the nudge", async () => {
    const s = setup();
    await fetchedPolicy(s.sessions);
    const out = await preflight(s, FABRICATED);
    const expected = await gate(s, FABRICATED);
    expect(expected.verdict).toBe("fail");
    expect(out).toEqual(reportOf(expected));
    expect(out.verdict).toBe("fail");
    expect(out.table[0].evidence[0]).toMatchObject({ ok: false, reason: "not_fetched" });
    expect(out.table[0].evidence[0].detail).toBeDefined();
    // The gate's own nudge, addressed to a draft rather than a served answer.
    expect(out.nudge).toBe(renderNudge(expected).replace("your last answer", "this draft"));
    expect(out.nudge).toStartWith("The provability gate did not accept this draft.");
    expect(out.nudge).toContain("run ProvabilityPreflight");
    expect(out.next).toContain("would not accept this draft");
  });

  test("the page was fetched but says something else: fail, as the gate says", async () => {
    const s = setup();
    await fetchedPolicy(s.sessions);
    const draft = `Refunds are accepted within 30 days of purchase [1].\n\n[1]: ${POLICY}\n`;
    const out = await preflight(s, draft);
    const expected = await gate(s, draft);
    expect(expected.verdict).toBe("fail");
    expect(out).toEqual(reportOf(expected));
    expect(out.table[0].evidence[0].reason).toBe(expected.claims[0]?.bindings[0]?.reason);
  });

  test("an uncited claim: fail, no_citation", async () => {
    const s = setup();
    await fetchedPolicy(s.sessions);
    const draft = "Refunds are accepted within 14 days of purchase.";
    const out = await preflight(s, draft);
    expect(out).toEqual(reportOf(await gate(s, draft)));
    expect(out.table[0].evidence).toEqual([]);
    expect(out.verdict).toBe("fail");
  });

  test("a clarifying question has nothing to prove: a vacuous pass", async () => {
    const s = setup();
    const out = await preflight(s, "Which order do you mean?");
    expect(out).toEqual(reportOf(await gate(s, "Which order do you mean?")));
    expect(out.verdict).toBe("pass");
    expect(out.claims).toBe(0);
    expect(out.vacuous).toBeDefined();
  });

  test("assumptions: counted, and refused under assumptions: forbid", async () => {
    const level = config("grounded", { assumptions: "forbid" });
    const s = setup(level);
    const draft =
      "The fiscal year starts in April [A1].\n\n[A1]: assume: the fiscal year starts in April\n";
    const out = await preflight(s, draft);
    expect(out).toEqual(reportOf(await gate(s, draft, level)));
    expect(out.assumptionsRefused).toBe(1);
    expect(out.verdict).toBe("fail");
  });

  test("a pass with an unmet claim under threshold < 1 carries the nudge and says so", async () => {
    const level = config("grounded", { threshold: 0.5 });
    const s = setup(level);
    await fetchedPolicy(s.sessions);
    const draft = `Refunds are accepted within 14 days of purchase [1]. Shipping is always free of charge everywhere [2].\n\n[1]: ${POLICY}\n[2]: https://acme.example/shipping\n`;
    const out = await preflight(s, draft);
    expect(out).toEqual(reportOf(await gate(s, draft, level)));
    expect(out.verdict).toBe("pass");
    expect(out.unmet).toBe(1);
    expect(out.nudge).toBeDefined();
    expect(out.next).toContain("the claims marked unmet are not backed");
  });
});

describe("proven claims and the shared artifacts root", () => {
  test("a sentence citing a ProofCheck artifact is proven; a rejected one is proof_rejected", async () => {
    const s = setup(config("proven"));
    const good = await proofChecked(s, { checker: "builtin", ...MEETINGS });
    const bad = await proofChecked(s, {
      checker: "builtin",
      claim: MEETINGS.claim,
      statement: MEETINGS.falseStatement,
      proof: "eval",
    });
    const cite = (id: string) => `No two of the three meetings overlap [1].\n\n[1]: proof:${id}\n`;
    const proven = await preflight(s, cite(good.id));
    expect(proven).toEqual(reportOf(await gate(s, cite(good.id), config("proven"))));
    expect(proven.verdict).toBe("pass");
    expect(proven.table[0].evidence[0]).toMatchObject({
      kind: "formal",
      rung: "proven",
      ok: true,
      origin: good.id,
      checker: "builtin",
    });
    const rejected = await preflight(s, cite(bad.id));
    expect(rejected.verdict).toBe("fail");
    expect(rejected.table[0].evidence[0].reason).toBe("proof_rejected");
  });

  test("a proof cited on a sentence that says the opposite is claim_mismatch", async () => {
    const s = setup(config("proven"));
    const good = await proofChecked(s, { checker: "builtin", ...MEETINGS });
    const draft = `Two of the three meetings overlap [1].\n\n[1]: proof:${good.id}\n`;
    const out = await preflight(s, draft);
    expect(out.table[0].evidence[0].reason).toBe("claim_mismatch");
  });

  test("an accepted artifact rewritten after the check is not proven, by the log or the re-check", async () => {
    const s = setup(config("proven"));
    const good = await proofChecked(s, {
      checker: "builtin",
      claim: "Two plus two is four.",
      statement: "2 + 2 = 4",
      proof: "eval",
    });
    // The file is the model's to write: the claim and statement swapped for
    // ones the checker rejects, the id and the verdict kept.
    const store = createFileArtifactStore({ rootDir: s.proofs });
    const stored = await store.get(good.id);
    if (stored === undefined) throw new Error("no artifact");
    const path = join(s.proofs, "artifacts", `${good.id}.json`);
    writeFileSync(
      path,
      JSON.stringify({ ...stored, claim: MEETINGS.claim, statement: MEETINGS.falseStatement }),
    );
    const draft = `${MEETINGS.claim.replace(/\.$/, "")} [1].\n\n[1]: proof:${good.id}\n`;
    const out = await preflight(s, draft);
    expect(out.verdict).toBe("fail");
    expect(out.table[0].evidence[0].reason).toBe("proof_missing");
    expect(out).toEqual(reportOf(await gate(s, draft, config("proven"))));
    // Read with no log at hand (trustStoredProofs), the re-check alone
    // still refuses the statement the builtin checker rejects.
    const offline = await verifyDocument(draft, {
      config: config("proven"),
      evidence: buildEvidenceIndex([]),
      artifacts: store,
      workspaceRoot: s.workspace,
      trustStoredProofs: true,
      recheckProof: proofRecheck({ timeoutMs: config("proven").formal.timeoutMs }),
      now,
    });
    expect(offline.claims[0]?.bindings[0]?.reason).toBe("proof_rejected");
  });
});

describe("where the preflight deliberately differs from the gate, it says so", () => {
  test("sources.resolve: head — no HEAD is sent; checked as resolve: off, with a note", async () => {
    const level = config("grounded", {
      sources: { allow: [], deny: [], bibliographic: false, resolve: "head" },
    });
    const s = setup(level);
    await fetchedPolicy(s.sessions);
    const out = await preflight(s, GROUNDED);
    // The verdict the gate gives when the URL answers.
    expect(out.verdict).toBe("pass");
    expect(out.notes).toEqual([expect.stringContaining("this preflight sends none")]);
    // Without the downgrade every URL would read unresolved — the wrong answer.
    const naive = await gate(s, GROUNDED, level);
    expect(naive.claims[0]?.bindings[0]?.reason).toBe("unresolved");
  });

  test("the paraphrase judge is never consulted, and a grounded config with one says so", async () => {
    const level = config("grounded", { judge: { model: "claude-haiku-4-5" } } as never);
    const s = setup(level);
    await fetchedPolicy(s.sessions);
    const out = await preflight(s, GROUNDED);
    expect(out.notes).toEqual([expect.stringContaining("the judge is never consulted here")]);
  });

  test("checked: a cited tool result is checked without a replay, and the note says the gate replays", async () => {
    const level = config("checked");
    const s = setup(level);
    await writeLog(s.sessions, SESSION, [
      userMessage("total?"),
      ...call("toolu_add1", "MoneyAdd", { amounts: ["1000.25", "284.25"] }, "1284.50"),
    ]);
    const draft = "The total is 1,284.50 [1].\n\n[1]: tool:toolu_add1\n";
    const out = await preflight(s, draft);
    expect(out.verdict).toBe("pass");
    expect(out.table[0].evidence[0]).toMatchObject({
      kind: "execution",
      rung: "checked",
      ok: true,
      replayed: false,
    });
    expect(out.notes).toEqual([expect.stringContaining("re-runs each cited pure tool")]);
    // Absent replay, the gate's verifier reaches the same verdict.
    expect(out).toMatchObject({ verdict: (await gate(s, draft, level)).verdict });
  });

  test("preflightConfig leaves an ordinary config untouched", () => {
    const c = config("grounded");
    expect(preflightConfig(c)).toEqual({ config: c, notes: [] });
  });
});

describe("evidence", () => {
  test("scope turn: a page fetched in an earlier turn does not ground this turn's draft", async () => {
    const level = config("grounded", { scope: "turn" });
    const s = setup(level);
    await fetchedPolicy(s.sessions);
    await writeLog(s.sessions, SESSION, [userMessage("and the shipping time?")]);
    const out = await preflight(s, GROUNDED);
    expect(out.verdict).toBe("fail");
    expect(out.table[0].evidence[0].reason).toBe("not_fetched");
    // The same session at scope: session grounds it.
    const session = setup(config("grounded"));
    await fetchedPolicy(session.sessions);
    await writeLog(session.sessions, SESSION, [userMessage("and the shipping time?")]);
    expect((await preflight(session, GROUNDED)).verdict).toBe("pass");
  });

  test("a call with no run context reaches no log: nothing grounds, and a note says why", async () => {
    const s = setup();
    await fetchedPolicy(s.sessions);
    const out = await preflight(s, GROUNDED, {});
    expect(out.verdict).toBe("fail");
    expect(out.notes[0]).toContain("no session log is reachable");
  });

  test("sessionRootDir: the option wins over the run's, which wins over the default", async () => {
    const s = setup();
    const elsewhere = dirs.make();
    await fetchedPolicy(elsewhere);
    // The run's root holds nothing; the option points at the log.
    const tools = createProofTools({
      config: config("grounded"),
      proofsRoot: s.proofs,
      workspaceRoot: s.workspace,
      sessionRootDir: elsewhere,
    });
    const out = JSON.parse(
      (await tools.provabilityPreflight.execute({ draft: GROUNDED }, s.ctx)) as string,
    );
    expect(out.verdict).toBe("pass");
    // Without the option, the run's (empty) root is read.
    expect((await preflight(s, GROUNDED)).verdict).toBe("fail");
  });

  test("an injected evidence builder is the one used, with the call's context", async () => {
    const s = setup();
    const seen: unknown[] = [];
    const tools = createProofTools({
      config: config("grounded"),
      proofsRoot: s.proofs,
      workspaceRoot: s.workspace,
      evidence: async (ctx) => {
        seen.push(ctx);
        const records = await evidenceFromSessionLog({ sessionId: SESSION, rootDir: s.sessions });
        return buildEvidenceIndex(records);
      },
    });
    await fetchedPolicy(s.sessions);
    const out = JSON.parse(
      (await tools.provabilityPreflight.execute({ draft: GROUNDED }, s.ctx)) as string,
    );
    expect(out.verdict).toBe("pass");
    expect(seen).toEqual([s.ctx]);
  });

  test("scope turn with an injected session-wide index: the turns it names are the ones graded, as at the gate", async () => {
    // The composition root may hand over its whole-session index and the
    // turn to keep, the way the gate scopes it (VerifyOptions.turnNumbers).
    const level = config("grounded", { scope: "turn" });
    const s = setup(level);
    const index = buildEvidenceIndex([
      recordFromCall({
        toolUseId: "toolu_fetch1",
        toolName: "WebFetch",
        input: { url: POLICY },
        content: fetched(POLICY, BODY),
        isError: false,
        sessionId: SESSION,
        turnNumber: 1,
      }),
    ]);
    const toolsFor = (turnNumbers: ReadonlySet<number>) =>
      createProofTools({
        config: level,
        proofsRoot: s.proofs,
        workspaceRoot: s.workspace,
        evidence: async () => ({ index, turnNumbers }),
      });
    const gateAt = (turnNumbers: ReadonlySet<number>) =>
      verifyDocument(GROUNDED, {
        config: level,
        evidence: index,
        artifacts: createFileArtifactStore({ rootDir: s.proofs }),
        workspaceRoot: s.workspace,
        turnNumbers,
        now,
      });
    const laterTurn = JSON.parse(
      (await toolsFor(new Set([2])).provabilityPreflight.execute(
        { draft: GROUNDED },
        s.ctx,
      )) as string,
    );
    expect(laterTurn.verdict).toBe("fail");
    expect(laterTurn.table[0].evidence[0].reason).toBe("not_fetched");
    expect(laterTurn).toEqual(reportOf(await gateAt(new Set([2]))));
    const sameTurn = JSON.parse(
      (await toolsFor(new Set([1])).provabilityPreflight.execute(
        { draft: GROUNDED },
        s.ctx,
      )) as string,
    );
    expect(sameTurn.verdict).toBe("pass");
    expect(sameTurn).toEqual(reportOf(await gateAt(new Set([1]))));
  });

  test("an injected builder that returns no index is refused, not graded against nothing", async () => {
    const s = setup();
    for (const junk of [undefined, null, {}, { index: {} }, [], "index"]) {
      const tools = createProofTools({
        config: config("grounded"),
        proofsRoot: s.proofs,
        evidence: async () => junk as never,
      });
      const err = await tools.provabilityPreflight
        .execute({ draft: GROUNDED }, s.ctx)
        .catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(ProofToolError);
      expect((err as Error).message).toContain("returned no evidence index");
    }
    const badTurns = createProofTools({
      config: config("grounded"),
      proofsRoot: s.proofs,
      evidence: async () => ({ index: buildEvidenceIndex([]), turnNumbers: [1] as never }),
    });
    const err = await badTurns.provabilityPreflight
      .execute({ draft: GROUNDED }, s.ctx)
      .catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain("turnNumbers must be a Set");
  });

  test("an injected builder that throws is a refusal naming the cause, not a verdict", async () => {
    const s = setup();
    const tools = createProofTools({
      config: config("grounded"),
      proofsRoot: s.proofs,
      evidence: async () => {
        throw new Error("log store offline");
      },
    });
    const err = await tools.provabilityPreflight
      .execute({ draft: GROUNDED }, s.ctx)
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ProofToolError);
    expect((err as Error).message).toBe(
      "ProvabilityPreflight could not read this run's evidence: log store offline",
    );
  });
});

/** The raw text the tool returns for `draft`, as the runtime receives it. */
async function preflightText(s: Setup, draft: string): Promise<string> {
  const out = await s.tools.provabilityPreflight.execute({ draft }, s.ctx);
  if (typeof out !== "string") throw new Error("expected a string result");
  return out;
}

describe("the report", () => {
  test("lists at most TABLE_ROWS claims, counting all of them", async () => {
    // Rows small enough that the byte budget is not what stops the table.
    const s = setup();
    await fetchedPolicy(s.sessions);
    const base = await gate(s, GROUNDED);
    const claims: ProofClaim[] = Array.from({ length: TABLE_ROWS + 5 }, (_, i) => ({
      index: i + 1,
      text: "x",
      status: "met",
      best: "grounded",
      bindings: [],
    }));
    const out = reportOf({ ...base, claims, claimCount: claims.length, met: claims.length });
    expect(out.claims).toBe(TABLE_ROWS + 5);
    expect(out.table).toHaveLength(TABLE_ROWS);
    expect(out.tableOmitted).toBe(5);
    expect(Buffer.byteLength(JSON.stringify(out), "utf8")).toBeLessThanOrEqual(REPORT_BYTES);
  });

  test("an ordinary failing draft reaches the model whole: verdict, next and nudge survive the runtime's spill", async () => {
    // Twenty-odd cited sentences, none of whose pages were fetched. The
    // report used to put its instructions after a 100-row table; the
    // runtime shows only the first 10 KB of a larger result, so the model
    // read the table and never the nudge, `next`, or the later claims.
    const s = setup();
    await fetchedPolicy(s.sessions);
    const lines = Array.from(
      { length: 24 },
      (_, i) =>
        `Policy clause ${i + 1} grants a refund window of ${i + 20} days for unopened goods shipped to customers abroad [${i + 1}].`,
    );
    const defs = lines.map((_, i) => `[${i + 1}]: https://acme.example/clauses/${i + 1}`);
    const draft = `${lines.join(" ")}\n\n${defs.join("\n")}\n`;
    const text = await preflightText(s, draft);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(REPORT_BYTES);
    expect(REPORT_BYTES).toBeLessThan(DEFAULT_THRESHOLD_BYTES);
    const stored = await storeAndPreview(
      { toolUseId: "toolu_pre1", content: text, isError: false },
      { runId: "run_00000001", toolUseId: "toolu_pre1", rootDir: dirs.make() },
    );
    expect(stored.persisted).toBe(false);
    const out = JSON.parse(stored.previewContent as string);
    expect(out.verdict).toBe("fail");
    expect(out.claims).toBe(24);
    expect(out.unmet).toBe(24);
    expect(out.next).toContain("would not accept this draft");
    expect(out.nudge).toStartWith("The provability gate did not accept this draft.");
    expect(out.nudge).toContain("run ProvabilityPreflight");
    // The instructions come before the table.
    const keys = Object.keys(out);
    expect(keys.indexOf("next")).toBeLessThan(keys.indexOf("table"));
    expect(keys.indexOf("nudge")).toBeLessThan(keys.indexOf("table"));
    // Every claim is either listed or counted.
    expect(out.table.length + (out.tableOmitted ?? 0)).toBe(24);
    expect(out.table.length).toBeGreaterThan(0);
  });

  test("an adversarial draft — a long one, every sentence carrying many markers — still fits", async () => {
    const s = setup();
    await fetchedPolicy(s.sessions);
    const refs = Array.from({ length: 60 }, (_, i) => `[${i + 1}]`).join(" ");
    const lines = Array.from(
      { length: 120 },
      (_, i) => `Refund rule ${i + 1} applies to every order placed this year ${refs}.`,
    );
    const defs = Array.from(
      { length: 60 },
      (_, i) => `[${i + 1}]: https://acme.example/rules/${i + 1}`,
    );
    const text = await preflightText(s, `${lines.join(" ")}\n\n${defs.join("\n")}\n`);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(REPORT_BYTES);
    const out = JSON.parse(text);
    expect(out.claims).toBe(120);
    expect(out.table[0].evidence).toHaveLength(ROW_BINDINGS);
    expect(out.table[0].moreEvidence).toBe(60 - ROW_BINDINGS);
    expect(out.nudge).toContain("run ProvabilityPreflight");
  });

  test("unmet claims are listed first, each group in draft order", async () => {
    const s = setup();
    await fetchedPolicy(s.sessions);
    const draft = `Refunds are accepted within 14 days of purchase [1]. Shipping is always free of charge everywhere [2]. Refunds are accepted within 14 days of purchase again [1]. Gift cards never expire under any circumstances [3].\n\n[1]: ${POLICY}\n[2]: https://acme.example/shipping\n[3]: https://acme.example/gift\n`;
    const out = await preflight(s, draft);
    const order = out.table.map((r: Json) => [r.status, r.index]);
    const unmet = order.filter(([status]: [string]) => status === "unmet");
    const rest = order.filter(([status]: [string]) => status !== "unmet");
    expect(unmet.length).toBeGreaterThan(0);
    expect(rest.length).toBeGreaterThan(0);
    expect(order).toEqual([...unmet, ...rest]);
    for (const group of [unmet, rest]) {
      const indexes = group.map(([, index]: [string, number]) => index);
      expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    }
  });

  test("a nudge too long for its share is cut in the middle: the verdict and the closing instructions stay", async () => {
    const s = setup();
    await fetchedPolicy(s.sessions);
    const base = await gate(s, FABRICATED);
    const claims: ProofClaim[] = Array.from({ length: 30 }, (_, i) => ({
      index: i + 1,
      text: `Claim ${i + 1} ${"is a long sentence about refunds ".repeat(8)}`,
      status: "unmet",
      best: "none",
      bindings: Array.from({ length: 4 }, (_, j) => ({
        ref: `[${j + 1}]`,
        kind: "source",
        rung: "none",
        ok: false,
        reason: "not_fetched",
        origin: `https://acme.example/${"p".repeat(120)}/${j}`,
        detail: "d".repeat(300),
      })),
    })) as never;
    const bundle = { ...base, claims, claimCount: 30, met: 0, unmet: 30 };
    expect(Buffer.byteLength(renderNudge(bundle), "utf8")).toBeGreaterThan(REPORT_BYTES);
    const out = reportOf(bundle);
    expect(Buffer.byteLength(JSON.stringify(out), "utf8")).toBeLessThanOrEqual(REPORT_BYTES);
    expect(out.nudge).toStartWith("The provability gate did not accept this draft.");
    expect(out.nudge).toContain("characters omitted");
    expect(out.nudge).toEndWith("run ProvabilityPreflight on it and fix every claim it reports.");
  });

  test("a run with many torn session logs: one note counts them, and the nudge still reaches the model", async () => {
    // Sixty sub-agents that crashed mid-append. The report used to carry a
    // note per unreadable log ahead of the nudge: 60 of them took it to
    // ~16 KB, past the runtime's spill, so the model never saw the nudge.
    const s = setup();
    const kids = Array.from(
      { length: 60 },
      (_, i) => `sess_${(0x1000 + i).toString(16).padStart(16, "0")}`,
    );
    await writeLog(s.sessions, SESSION, [userMessage("q"), ...kids.map((k) => subAgent(k))]);
    for (const k of kids) {
      await writeLog(s.sessions, k, [userMessage("child")]);
      appendFileSync(join(s.sessions, `${k}.jsonl`), '{"ts":1,"version":1,"kind":"tool_use","payl');
    }
    const text = await preflightText(s, FABRICATED);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(REPORT_BYTES);
    const stored = await storeAndPreview(
      { toolUseId: "toolu_pre2", content: text, isError: false },
      { runId: "run_00000001", toolUseId: "toolu_pre2", rootDir: dirs.make() },
    );
    expect(stored.persisted).toBe(false);
    const out = JSON.parse(stored.previewContent as string);
    expect(out.verdict).toBe("fail");
    expect(out.notes).toEqual([expect.stringMatching(/^60 session logs could not be read/)]);
    expect(out.nudge).toContain("run ProvabilityPreflight");
    expect(out.table.length).toBe(1);
  });

  test("notes are held to their share, cut with a count, so the nudge and the table keep their room", async () => {
    const s = setup();
    await fetchedPolicy(s.sessions);
    const bundle = await gate(s, FABRICATED);
    const notes = Array.from({ length: 40 }, (_, i) => `note ${i + 1}: ${"n".repeat(900)}`);
    const out = JSON.parse(JSON.stringify(preflightReport(bundle, notes)));
    expect(Buffer.byteLength(JSON.stringify(out.notes), "utf8")).toBeLessThanOrEqual(NOTES_BYTES);
    expect(out.notes[0]).toStartWith("note 1: ");
    expect(out.notes[0].length).toBeLessThan(900);
    expect(out.notes.at(-1)).toMatch(/^… and \d+ more notes on how this preflight read the run$/);
    expect(out.nudge).toContain("run ProvabilityPreflight");
    expect(out.table).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(out), "utf8")).toBeLessThanOrEqual(REPORT_BYTES);
    // The few notes a real preflight writes pass through whole.
    const few = ["provability.sources.resolve is head: …", "the judge is never consulted here"];
    expect(JSON.parse(JSON.stringify(preflightReport(bundle, few))).notes).toEqual(few);
  });

  test("preflightBundle is verifyDocument with the preflight's config, nothing else", async () => {
    const s = setup();
    await fetchedPolicy(s.sessions);
    const records = await evidenceFromSessionLog({ sessionId: SESSION, rootDir: s.sessions });
    const { bundle, notes } = await preflightBundle(GROUNDED, {
      config: config("grounded"),
      evidence: buildEvidenceIndex(records),
      artifacts: createFileArtifactStore({ rootDir: s.proofs }),
      workspaceRoot: s.workspace,
      now,
    });
    expect(bundle).toEqual(await gate(s, GROUNDED));
    expect(notes).toEqual([]);
  });

  test("the preflight persists nothing and publishes nothing", async () => {
    const s = setup();
    await fetchedPolicy(s.sessions);
    const run = fakeRun({ sessionRootDir: s.sessions });
    await preflight(s, GROUNDED, run.ctx);
    expect(run.events.filter((e) => e.kind.startsWith("pro"))).toEqual([]);
    expect(run.appended).toEqual([]);
    expect(await createFileArtifactStore({ rootDir: s.proofs }).list()).toEqual([]);
  });
});
