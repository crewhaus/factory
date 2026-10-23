/**
 * The provability gate the composition root builds, end to end through
 * `wireEvaluation`: a real session log on disk, a transcript, the real
 * verifier, real artifact and bundle stores, the real proof tools (the
 * builtin checker runs for real), and scripted stand-ins only for the
 * judge's provider and the network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { proofsRoot } from "@crewhaus/provability";
import type { ProofBundle } from "@crewhaus/provability";
import { TenancyError, buildTenant, withTenant } from "@crewhaus/tenancy";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
import { uuid } from "@crewhaus/tool-encode";
import { _setDnsLookup, _setRawFetch } from "@crewhaus/tool-fetch";
import { proofCheck as builtinProofCheck } from "@crewhaus/tool-proof";
import { storeAndPreview } from "@crewhaus/tool-result-store";
import {
  MEETINGS,
  type Message,
  NOW,
  SESSION,
  assistant,
  callLines,
  callMessages,
  config,
  fetched,
  impureSumTool,
  now,
  recordingBus,
  scriptedJudge,
  sumTool,
  tempDirs,
  turnOf,
  user,
  userLine,
  writeLog,
} from "./__fixtures__/helpers";
import { displayPath } from "./provability";
import { proofsDirName } from "./roots";
import { mergeGateTools } from "./tools";
import { EvaluationServiceError, wireEvaluation } from "./wire";

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

const URL_A = "https://acme.example/policy";
const BODY_A =
  "Our refund policy: refunds are accepted within 14 days of purchase for unused items in their original packaging. After that, store credit only.";
const URL_B = "https://acme.example/shipping";
const BODY_B = "Standard shipping takes 5 business days within the continental United States.";

const GROUNDED_ANSWER = `Refunds are accepted within 14 days of purchase [1].\n\n[1]: ${URL_A}`;

/** A workspace with a session-log root inside it. */
function workspace(): { cwd: string; sessions: string } {
  const cwd = dirs.make();
  return { cwd, sessions: join(cwd, ".crewhaus", "sessions") };
}

async function provable(
  cwd: string,
  level: Parameters<typeof config>[0],
  deps: Partial<Parameters<typeof wireEvaluation>[1]> = {},
  patch: Parameters<typeof config>[1] = {},
) {
  const gates = await wireEvaluation(
    {
      specName: "support-bot",
      primaryModel: "claude-sonnet-4-6",
      provability: config(level, patch),
    },
    { cwd, now, ...deps },
  );
  if (gates.provability === undefined) throw new Error("expected a provability gate");
  return { gates, gate: gates.provability };
}

/**
 * The run's own record of the `ProofCheck` call that answered `output`: the
 * gate accepts a stored artifact only beside the call that filed it (a file
 * in the workspace alone proves nothing — the model's file tools can write
 * one).
 */
const proofCheckRan = (output: string) =>
  callMessages("toolu_proof1", "ProofCheck", { checker: "builtin", ...MEETINGS }, output);

describe("the RunProvability shape", () => {
  test("level, onFail, maxRetries, threshold, render and escalateTo come straight from the IR", async () => {
    const { cwd } = workspace();
    const { gate } = await provable(
      cwd,
      "checked",
      { footerTarget: "reply" },
      { onFail: "escalate", escalateTo: "strong", maxRetries: 3, threshold: 0.5, render: "json" },
    );
    expect(gate).toMatchObject({
      level: "checked",
      onFail: "escalate",
      escalateTo: "strong",
      maxRetries: 3,
      threshold: 0.5,
      render: "json",
      footerTarget: "reply",
    });
    expect(typeof gate.verify).toBe("function");
    expect(typeof gate.nudge).toBe("function");
    expect(typeof gate.persist).toBe("function");
  });

  test("no escalateTo, no footerTarget, no renderBundle under render: none — absent, not undefined", async () => {
    const { cwd } = workspace();
    const { gate } = await provable(cwd, "cited", {}, { render: "none" });
    expect("escalateTo" in gate).toBe(false);
    expect("footerTarget" in gate).toBe(false);
    expect("renderBundle" in gate).toBe(false);
    expect("onBundle" in gate).toBe(false);
  });

  test("every name the spec schema admits wires: one the proofs store refuses files under its mapped directory", async () => {
    // `support bot`, `team:support` and `..` compile warning-free (the spec
    // schema allows spaces, ':' and dots); provability's store does not.
    for (const specName of ["support bot", "team:support", ".."]) {
      const { cwd } = workspace();
      const gates = await wireEvaluation(
        { specName, primaryModel: "m", provability: config("proven") },
        { cwd, now },
      );
      const dir = proofsDirName(specName);
      expect(dir).not.toBe(specName);
      const proofCheck = gates.tools.find((t) => t.name === "ProofCheck") as RegisteredTool;
      const raw = (await proofCheck.execute({ checker: "builtin", ...MEETINGS })) as string;
      const out = JSON.parse(raw) as { ok: boolean; id: string };
      expect(out.ok).toBe(true);
      // The tool files under the mapped directory, and the gate looks there.
      expect(existsSync(join(proofsRoot(cwd, dir), "artifacts", `${out.id}.json`))).toBe(true);
      const bundle = await gates.provability?.verify(
        turnOf(`${MEETINGS.claim.slice(0, -1)} [1].\n\n[1]: proof:${out.id}`, {
          messages: proofCheckRan(raw),
        }),
      );
      expect(bundle?.verdict).toBe("pass");
      const path = await gates.provability?.persist?.(bundle as ProofBundle, {
        sessionId: SESSION,
        turnNumber: 1,
      });
      expect(path).toBe(join(proofsRoot(cwd, dir), SESSION, "turn-1.json"));
    }
  });

  test("a malformed level is refused at wiring", async () => {
    const { cwd } = workspace();
    const bad = { ...config("cited"), level: "certain" } as unknown as ReturnType<typeof config>;
    await expect(
      wireEvaluation({ specName: "bot", primaryModel: "m", provability: bad }, { cwd }),
    ).rejects.toBeInstanceOf(EvaluationServiceError);
  });
});

describe("grounded — evidence from the session log and the transcript", () => {
  test("a claim grounded in a body the SESSION LOG recorded passes", async () => {
    const { cwd, sessions } = workspace();
    await writeLog(sessions, SESSION, [
      userLine("what is the refund window?"),
      ...callLines("toolu_1", "WebFetch", { url: URL_A }, fetched(URL_A, BODY_A)),
    ]);
    const { gate } = await provable(cwd, "grounded", { sessionRootDir: sessions });
    const bundle = await gate.verify(turnOf(GROUNDED_ANSWER, { sessionId: SESSION }));
    expect(bundle.verdict).toBe("pass");
    expect(bundle.sources).toBe(1);
    expect(bundle.claims[0]?.bindings[0]).toMatchObject({
      ok: true,
      rung: "grounded",
      origin: URL_A,
    });
  });

  test("the same body only in the TRANSCRIPT grounds too (a run with no log)", async () => {
    const { cwd } = workspace();
    const { gate } = await provable(cwd, "grounded");
    const messages = [
      user("what is the refund window?"),
      ...callMessages("toolu_1", "WebFetch", { url: URL_A }, fetched(URL_A, BODY_A)),
    ];
    expect((await gate.verify(turnOf(GROUNDED_ANSWER, { messages }))).verdict).toBe("pass");
  });

  test("the fabricated citation (design scenario A): a URL never fetched, then a body that says otherwise", async () => {
    const { cwd, sessions } = workspace();
    const { gate } = await provable(cwd, "grounded", { sessionRootDir: sessions });
    const thirty = `Refunds are accepted within 30 days of purchase [1].\n\n[1]: ${URL_A}`;
    const unfetched = await gate.verify(turnOf(thirty, { sessionId: SESSION }));
    expect(unfetched.verdict).toBe("fail");
    expect(unfetched.claims[0]?.bindings[0]?.reason).toBe("not_fetched");
    await writeLog(sessions, SESSION, [
      userLine("what is the refund window?"),
      ...callLines("toolu_1", "WebFetch", { url: URL_A }, fetched(URL_A, BODY_A)),
    ]);
    const misquoted = await gate.verify(turnOf(thirty, { sessionId: SESSION }));
    expect(misquoted.verdict).toBe("fail");
    expect(misquoted.claims[0]?.bindings[0]?.reason).toBe("not_found_in_source");
    // The retry nudge is provability's: the model's own sentence and the
    // reason, never the fetched body.
    const nudge = gate.nudge(misquoted);
    expect(nudge).toContain("Refunds are accepted within 30 days of purchase");
    expect(nudge).not.toContain("original packaging");
  });

  test("an unreadable log keeps what was read before the tear (fail closed, never a throw)", async () => {
    const { cwd, sessions } = workspace();
    await writeLog(sessions, SESSION, [
      userLine("q"),
      ...callLines("toolu_1", "WebFetch", { url: URL_A }, fetched(URL_A, BODY_A)),
    ]);
    const path = join(sessions, `${SESSION}.jsonl`);
    const { appendFileSync } = await import("node:fs");
    appendFileSync(path, '{"torn": ');
    const { gate } = await provable(cwd, "grounded", { sessionRootDir: sessions });
    const bundle = await gate.verify(turnOf(GROUNDED_ANSWER, { sessionId: SESSION }));
    expect(bundle.verdict).toBe("pass");
  });
});

describe("scope: turn", () => {
  const priorTurn: Message[] = [
    user("tell me about refunds"),
    ...callMessages("toolu_old", "WebFetch", { url: URL_A }, fetched(URL_A, BODY_A)),
    assistant("Refunds are accepted within 14 days."),
  ];

  test("evidence from an EARLIER turn does not count under scope: turn — and does under session", async () => {
    const { cwd } = workspace();
    const messages = [...priorTurn, user("and the refund window again?")];
    const turnScoped = await provable(cwd, "grounded", {}, { scope: "turn" });
    const failed = await turnScoped.gate.verify(turnOf(GROUNDED_ANSWER, { messages }));
    expect(failed.verdict).toBe("fail");
    expect(failed.claims[0]?.bindings[0]?.reason).toBe("not_fetched");
    const sessionScoped = await provable(cwd, "grounded");
    expect((await sessionScoped.gate.verify(turnOf(GROUNDED_ANSWER, { messages }))).verdict).toBe(
      "pass",
    );
  });

  test("the log is scoped the same way: a fetch before the last real user message is out", async () => {
    const { cwd, sessions } = workspace();
    await writeLog(sessions, SESSION, [
      userLine("tell me about refunds"),
      ...callLines("toolu_old", "WebFetch", { url: URL_A }, fetched(URL_A, BODY_A)),
      userLine("and the refund window again?"),
      ...callLines("toolu_new", "WebFetch", { url: URL_B }, fetched(URL_B, BODY_B)),
    ]);
    const { gate } = await provable(
      cwd,
      "grounded",
      { sessionRootDir: sessions },
      { scope: "turn" },
    );
    const both = `Refunds are accepted within 14 days of purchase [1]. Standard shipping takes 5 business days [2].\n\n[1]: ${URL_A}\n[2]: ${URL_B}`;
    const bundle = await gate.verify(turnOf(both, { sessionId: SESSION }));
    expect(bundle.claims.map((c) => c.status)).toEqual(["unmet", "met"]);
    expect(bundle.claims[0]?.bindings[0]?.reason).toBe("not_fetched");
  });

  test("a runtime-injected (synthetic) user message does not start a turn: the first attempt's fetch still counts on the retry", async () => {
    const { cwd } = workspace();
    const nudge = user("[provability failed …] cite the evidence");
    const messages: Message[] = [
      user("what is the refund window?"),
      ...callMessages("toolu_1", "WebFetch", { url: URL_A }, fetched(URL_A, BODY_A)),
      assistant("about a month"),
      nudge,
    ];
    const { gate } = await provable(cwd, "grounded", {}, { scope: "turn" });
    const synthetic = new Set<Message>([nudge]);
    const retried = await gate.verify(
      turnOf(GROUNDED_ANSWER, { messages, isSynthetic: (m) => synthetic.has(m), retryIndex: 1 }),
    );
    expect(retried.verdict).toBe("pass");
    expect(retried.retryIndex).toBe(1);
    // Without the marker the nudge reads as a new human turn, and the fetch is out.
    const unmarked = await gate.verify(turnOf(GROUNDED_ANSWER, { messages }));
    expect(unmarked.verdict).toBe("fail");
  });
});

describe("checked — replay through the catalog", () => {
  const SUM_ANSWER = "The sum is 42 [1].\n\n[1]: tool:toolu_sum";
  const sumCall = (name = "SumFake", content = "The sum is 42.") => [
    user("what is 2 + 40?"),
    ...callMessages("toolu_sum", name, { a: 2, b: 40 }, content),
  ];

  test("a pure tool is re-run with the logged input and the digests match: replayed: true", async () => {
    const { cwd } = workspace();
    let runs = 0;
    const tool = sumTool("SumFake", (a, b) => {
      runs += 1;
      return `The sum is ${a + b}.`;
    });
    const { gate } = await provable(cwd, "checked", { catalog: [tool] });
    const bundle = await gate.verify(turnOf(SUM_ANSWER, { messages: sumCall() }));
    expect(bundle.verdict).toBe("pass");
    expect(bundle.claims[0]?.bindings[0]).toMatchObject({
      ok: true,
      rung: "checked",
      replayed: true,
    });
    expect(runs).toBe(1);
  });

  test("a recorded result the tool does not reproduce is replay_mismatch", async () => {
    const { cwd } = workspace();
    const lying = sumTool("SumFake", () => "The sum is 43.");
    const { gate } = await provable(cwd, "checked", {
      catalog: { get: (n) => (n === "SumFake" ? lying : undefined) },
    });
    const bundle = await gate.verify(turnOf(SUM_ANSWER, { messages: sumCall() }));
    expect(bundle.verdict).toBe("fail");
    expect(bundle.claims[0]?.bindings[0]).toMatchObject({
      reason: "replay_mismatch",
      replayed: true,
    });
  });

  test("an impure tool is never re-run: the binding stands with replayed: false", async () => {
    const { cwd } = workspace();
    let runs = 0;
    const { gate } = await provable(cwd, "checked", {
      catalog: [
        impureSumTool(() => {
          runs += 1;
        }),
      ],
    });
    const bundle = await gate.verify(
      turnOf("The sum is 42 [1].\n\n[1]: tool:toolu_sum", { messages: sumCall("ImpureSum") }),
    );
    expect(bundle.verdict).toBe("pass");
    expect(bundle.claims[0]?.bindings[0]?.replayed).toBe(false);
    expect(runs).toBe(0);
  });

  test("no catalog wired: no replay, honestly recorded", async () => {
    const { cwd } = workspace();
    const { gate } = await provable(cwd, "checked");
    const bundle = await gate.verify(turnOf(SUM_ANSWER, { messages: sumCall() }));
    expect(bundle.verdict).toBe("pass");
    expect(bundle.claims[0]?.bindings[0]?.replayed).toBe(false);
  });

  // The claim QUOTES the id, so the value check reads it as text whatever its
  // characters. Left bare, a UUID is checked by accident: claim-ledger reads a
  // figure out of most ids, and the ~1 in 6 that yields none falls to word
  // coverage, where the claim's own framing ("new order") is not in the result
  // — the verdict then tracked the random id and the claim failed before replay
  // was reached. The fixed ids pin both kinds every run (the first two yield no
  // figure, the third yields five); the counter proves replay is what ran.
  test("a tool that does not reproduce (the real, unseeded Uuid) is never replay_mismatch: replayed: false", async () => {
    let runs = 0;
    const counted: RegisteredTool = {
      ...uuid,
      execute: (input, ctx) => {
        runs += 1;
        return uuid.execute(input, ctx);
      },
    };
    const logged = (await uuid.execute(uuid.inputSchema.parse({}))) as string;
    const fresh = (JSON.parse(logged) as { uuids: string[] }).uuids[0] as string;
    const ids = [
      fresh,
      "dff824f4-b95d-4c6d-9eb9-6bf879011788",
      "80b54fa7-1f0b-4be1-a8e0-42c8fddd15bf",
      "12345678-1234-4123-8123-123456789012",
    ];
    for (const id of ids) {
      runs = 0;
      const { cwd } = workspace();
      const { gate } = await provable(
        cwd,
        "checked",
        { catalog: [counted] },
        { execution: { allow: ["uuid"] } },
      );
      const bundle = await gate.verify(
        turnOf(`The new order id is "${id}" [1].\n\n[1]: tool:toolu_uuid`, {
          messages: [
            user("make an order id"),
            ...callMessages("toolu_uuid", "Uuid", {}, logged.replace(fresh, id)),
          ],
        }),
      );
      expect({ id, verdict: bundle.verdict }).toEqual({ id, verdict: "pass" });
      expect(bundle.claims[0]?.bindings[0]).toMatchObject({ ok: true, replayed: false });
      // Replayed, disagreed with the log, rechecked, and disagreed with itself.
      expect({ id, runs }).toEqual({ id, runs: 2 });
    }
  });

  test("execution.replay: false skips the re-run even for a pure tool", async () => {
    const { cwd } = workspace();
    let runs = 0;
    const tool = sumTool("SumFake", (a, b) => {
      runs += 1;
      return `The sum is ${a + b}.`;
    });
    const { gate } = await provable(
      cwd,
      "checked",
      { catalog: [tool] },
      { execution: { replay: false } },
    );
    const bundle = await gate.verify(turnOf(SUM_ANSWER, { messages: sumCall() }));
    expect(bundle.claims[0]?.bindings[0]?.replayed).toBe(false);
    expect(runs).toBe(0);
  });
});

describe("the waiver judge (provability.judge)", () => {
  const PARAPHRASE = `Customers may return unused goods for money back within 14 days [1].\n\n[1]: ${URL_A}`;
  const messages = [
    user("refund window?"),
    ...callMessages("toolu_1", "WebFetch", { url: URL_A }, fetched(URL_A, BODY_A)),
  ];

  test("absent: a paraphrase miss stays unmet and no model is called", async () => {
    const { cwd } = workspace();
    const { gate } = await provable(cwd, "grounded");
    const { bus, events } = recordingBus();
    const bundle = await gate.verify(turnOf(PARAPHRASE, { messages, bus }));
    expect(bundle.verdict).toBe("fail");
    expect(bundle.claims[0]?.bindings[0]?.reason).toBe("not_found_in_source");
    expect(events.filter((e) => e.kind === "model_request")).toEqual([]);
  });

  test("set: one categorical call on the turn's bus, metered as role judge, waives that binding and is recorded on the bundle", async () => {
    const { cwd } = workspace();
    const { adapter, requests } = scriptedJudge(() => ({
      label: "supported",
      rationale: "it says so",
    }));
    const { gate } = await provable(
      cwd,
      "grounded",
      { judgeAdapter: adapter },
      { judge: { model: "claude-haiku-4-5", params: { temperature: 0.9, maxTokens: 300 } } },
    );
    const { bus, events } = recordingBus();
    const bundle = await gate.verify(turnOf(PARAPHRASE, { messages, bus }));
    expect(bundle.verdict).toBe("pass");
    expect(bundle.judgeWaived).toBe(1);
    expect(bundle.claims[0]?.bindings[0]).toMatchObject({ ok: true, judgeWaived: true });
    expect(bundle.judgeModel).toBe("claude-haiku-4-5");
    expect(typeof bundle.spentUsdMicros).toBe("number");
    const requested = events.filter((e) => e.kind === "model_request");
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ role: "judge", model: "claude-haiku-4-5" });
    expect(events.filter((e) => e.kind === "model_response")).toHaveLength(1);
    // Temperature pinned to 0 over the profile's own pin; max_tokens honoured.
    expect(requests[0]).toMatchObject({ temperature: 0, maxTokens: 300, tool: "submit_label" });
    // Both untrusted pieces ride sentinel-wrapped blocks.
    const prompt = requests[0]?.user ?? "";
    const sentinel = /<<<UNTRUSTED_([0-9a-f]+)>>>/.exec(prompt)?.[1];
    expect(sentinel).toBeDefined();
    const blocks = prompt.split(`<<<UNTRUSTED_${sentinel}>>>`).slice(1).join("\n");
    expect(blocks).toContain("Customers may return unused goods");
    expect(blocks).toContain(URL_A);
  });

  test("a 'no' (or an abstention) leaves the binding unmet", async () => {
    const { cwd } = workspace();
    for (const answer of [
      { label: "not_supported", rationale: "different" },
      { label: "supported", rationale: "can't tell", abstain: true },
    ]) {
      const { adapter } = scriptedJudge(() => answer);
      const { gate } = await provable(
        cwd,
        "grounded",
        { judgeAdapter: adapter },
        { judge: { model: "claude-haiku-4-5" } },
      );
      const bundle = await gate.verify(turnOf(PARAPHRASE, { messages }));
      expect(bundle.verdict).toBe("fail");
      expect(bundle.judgeWaived).toBe(0);
    }
  });

  test("past budget.judge_share the waiver is skipped, not guessed: no model call, the miss stands", async () => {
    const { cwd } = workspace();
    const { adapter, requests } = scriptedJudge(() => ({ label: "supported", rationale: "x" }));
    const { gate } = await provable(
      cwd,
      "grounded",
      { judgeAdapter: adapter },
      { judge: { model: "claude-haiku-4-5" } },
    );
    const { bus, events } = recordingBus();
    const bundle = await gate.verify(
      turnOf(PARAPHRASE, { messages, bus, judgeShareExhausted: () => true }),
    );
    expect(bundle.verdict).toBe("fail");
    expect(bundle.claims[0]?.bindings[0]?.reason).toBe("not_found_in_source");
    expect(bundle.judgeWaived).toBe(0);
    expect(requests).toEqual([]);
    expect(events.filter((e) => e.kind === "model_request")).toEqual([]);
    // The share is read live: spent by the judge's own first call, it stops the next.
    const two = `${PARAPHRASE.split("\n\n")[0]} Unused goods can come back for a refund inside 14 days [1].\n\n[1]: ${URL_A}`;
    const live = await gate.verify(
      turnOf(two, { messages, judgeShareExhausted: () => requests.length >= 1 }),
    );
    expect(live.claims).toHaveLength(2);
    expect(requests).toHaveLength(1);
    expect(live.judgeWaived).toBe(1);
  });

  test("a claim the body states outright never reaches the judge", async () => {
    const { cwd } = workspace();
    const { adapter, requests } = scriptedJudge(() => ({ label: "supported", rationale: "x" }));
    const { gate } = await provable(
      cwd,
      "grounded",
      { judgeAdapter: adapter },
      { judge: { model: "claude-haiku-4-5" } },
    );
    expect((await gate.verify(turnOf(GROUNDED_ANSWER, { messages }))).verdict).toBe("pass");
    expect(requests).toEqual([]);
  });
});

describe("sources.resolve: head", () => {
  test("one HEAD per URL per session (cached across turns); a 404 is unresolved", async () => {
    const { cwd } = workspace();
    const asked: string[] = [];
    const { gate } = await provable(
      cwd,
      "cited",
      {
        resolveHead: async (url) => {
          asked.push(url);
          return url.endsWith("/gone") ? 404 : 200;
        },
      },
      { sources: { resolve: "head" } },
    );
    const answer = `Refunds take 14 days [1]. Shipping takes 5 days [2].\n\n[1]: ${URL_A}\n[2]: https://acme.example/gone`;
    const first = await gate.verify(turnOf(answer, { sessionId: SESSION }));
    expect(first.claims.map((c) => c.bindings[0]?.reason ?? "ok")).toEqual(["ok", "unresolved"]);
    await gate.verify(turnOf(answer, { sessionId: SESSION }));
    expect(asked).toEqual([URL_A, "https://acme.example/gone"]);
    // Another session asks again.
    await gate.verify(turnOf(answer, { sessionId: "sess_00000000000000dd" }));
    expect(asked).toHaveLength(4);
  });

  test("the default guarded HEAD: one request per URL per session even across wirings (the per-turn channel wiring)", async () => {
    const { cwd } = workspace();
    const seen: string[] = [];
    _setDnsLookup(async () => ({ address: "93.184.216.34", family: 4 }));
    _setRawFetch(async (req) => {
      seen.push(`${req.method} ${req.url}`);
      return new Response(null, { status: 200 });
    });
    try {
      const url = "https://shared-cache.example/policy";
      const answer = `Refunds take 14 days [1].\n\n[1]: ${url}`;
      for (let turn = 0; turn < 2; turn += 1) {
        const { gate } = await provable(cwd, "cited", {}, { sources: { resolve: "head" } });
        expect(
          (await gate.verify(turnOf(answer, { sessionId: "sess_00000000000000ee" }))).verdict,
        ).toBe("pass");
      }
      expect(seen).toEqual([`HEAD ${url}`]);
    } finally {
      _setRawFetch(undefined);
      _setDnsLookup(undefined);
    }
  });

  test("a transient failure is not the page's answer: the gate's retry asks again and passes", async () => {
    const { cwd } = workspace();
    let calls = 0;
    const { gate } = await provable(
      cwd,
      "cited",
      {
        resolveHead: async () => {
          calls += 1;
          if (calls === 1) throw new Error("ETIMEDOUT (transient)");
          return 200;
        },
      },
      { sources: { resolve: "head" } },
    );
    const answer = `Refunds take 14 days [1].\n\n[1]: ${URL_A}`;
    const first = await gate.verify(turnOf(answer, { sessionId: SESSION }));
    expect(first.claims[0]?.bindings[0]?.reason).toBe("unresolved");
    const retry = await gate.verify(turnOf(answer, { sessionId: SESSION, retryIndex: 1 }));
    expect(retry.verdict).toBe("pass");
    expect(calls).toBe(2);
  });

  test("a HEAD still pending at the verifier's deadline is stopped, so the retry pass never overlaps it", async () => {
    const { cwd } = workspace();
    let inFlight = 0;
    let maxInFlight = 0;
    const signals: AbortSignal[] = [];
    // A tarpit: answers nothing until the request is aborted.
    const tarpit = (_url: string, signal?: AbortSignal): Promise<number | undefined> =>
      new Promise((resolve) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (signal === undefined) return;
        signals.push(signal);
        signal.addEventListener(
          "abort",
          () => {
            inFlight -= 1;
            resolve(undefined);
          },
          { once: true },
        );
      });
    const { gate } = await provable(
      cwd,
      "cited",
      { resolveHead: tarpit, headDeadlineMs: 100 },
      { sources: { resolve: "head" } },
    );
    const urls = Array.from({ length: 12 }, (_, i) => `https://tarpit${i}.example/page`);
    const answer = `${urls.map((_, i) => `Fact number ${i} holds [${i + 1}].`).join(" ")}\n\n${urls
      .map((url, i) => `[${i + 1}]: ${url}`)
      .join("\n")}`;
    const first = await gate.verify(turnOf(answer, { sessionId: SESSION }));
    expect(first.claims.every((c) => c.bindings[0]?.reason === "unresolved")).toBe(true);
    const sent = maxInFlight;
    expect(sent).toBeGreaterThan(0);
    // Every request the first pass sent was told to stop at its deadline.
    expect(signals.length).toBe(sent);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(inFlight).toBe(0);
    // The retry pass starts with nothing of the first still running.
    await gate.verify(turnOf(answer, { sessionId: SESSION, retryIndex: 1 }));
    expect(maxInFlight).toBe(sent);
    expect(inFlight).toBe(0);
  });

  test("each HEAD sent is recorded on the run's audit sink as an egress_decision (sink provability.resolve)", async () => {
    const { cwd } = workspace();
    const appended: Array<{ kind: string; payload: unknown }> = [];
    const sink = {
      append: async (entry: { kind: "egress_decision"; payload: unknown }) => {
        appended.push(entry);
      },
    };
    const { gate } = await provable(
      cwd,
      "cited",
      { resolveHead: async (url) => (url.includes("gone") ? 404 : 200) },
      { sources: { resolve: "head" } },
    );
    const answer = `Refunds take 14 days [1]. Shipping takes 5 days [2].\n\n[1]: ${URL_A}?ref=SECRET\n[2]: https://cdn.example/gone`;
    const session = "sess_00000000000000ab";
    await gate.verify(turnOf(answer, { sessionId: session, egressAuditSink: sink }));
    // A cached answer sends nothing, so it records nothing.
    await gate.verify(turnOf(answer, { sessionId: session, egressAuditSink: sink }));
    expect(appended).toEqual([
      {
        kind: "egress_decision",
        payload: {
          sinkId: "provability.resolve",
          sinkScope: "external-dynamic",
          method: "HEAD",
          host: "acme.example",
          verdict: "pass",
          status: 200,
        },
      },
      {
        kind: "egress_decision",
        payload: {
          sinkId: "provability.resolve",
          sinkScope: "external-dynamic",
          method: "HEAD",
          host: "cdn.example",
          verdict: "pass",
          status: 404,
        },
      },
    ]);
    expect(JSON.stringify(appended)).not.toContain("SECRET");
    // A sink that fails costs the answer nothing.
    const broken = {
      append: async () => {
        throw new Error("audit disk full");
      },
    };
    const again = await gate.verify(
      turnOf(answer, { sessionId: "sess_00000000000000ac", egressAuditSink: broken }),
    );
    expect(again.claims.map((c) => c.bindings[0]?.reason ?? "ok")).toEqual(["ok", "unresolved"]);
  });

  test("resolve: off sends nothing", async () => {
    const { cwd } = workspace();
    let asked = 0;
    const { gate } = await provable(cwd, "cited", {
      resolveHead: async () => {
        asked += 1;
        return 200;
      },
    });
    expect((await gate.verify(turnOf(GROUNDED_ANSWER))).verdict).toBe("pass");
    expect(asked).toBe(0);
  });
});

describe("persist + render", () => {
  test("the bundle lands under .crewhaus/proofs/<spec>/<session>/turn-<n>.json, 0600, and the footer names it relative to the workspace", async () => {
    const { cwd } = workspace();
    const { gate } = await provable(cwd, "grounded");
    const messages = [
      user("q"),
      ...callMessages("toolu_1", "WebFetch", { url: URL_A }, fetched(URL_A, BODY_A)),
    ];
    const bundle = await gate.verify(turnOf(GROUNDED_ANSWER, { messages, sessionId: SESSION }));
    const path = await gate.persist?.(bundle, { sessionId: SESSION, turnNumber: 7 });
    expect(path).toBe(join(proofsRoot(cwd, "support-bot"), SESSION, "turn-7.json"));
    expect(statSync(path as string).mode & 0o777).toBe(0o600);
    expect((JSON.parse(readFileSync(path as string, "utf8")) as ProofBundle).bundleHash).toBe(
      bundle.bundleHash,
    );
    const footer = gate.renderBundle?.(bundle, path);
    expect(footer).toBe(
      `── provability · grounded ✓ · 1/1 claim · 1 source · 0 assumptions · .crewhaus${sep}proofs${sep}support-bot${sep}${SESSION}${sep}turn-7.json`,
    );
    // A run with no session files under no-session/.
    const noSession = await gate.persist?.(bundle, { turnNumber: 1 });
    expect(noSession).toBe(join(proofsRoot(cwd, "support-bot"), "no-session", "turn-1.json"));
  });

  test("render: json prints the bundle; a path outside the workspace stays absolute", async () => {
    const { cwd } = workspace();
    const { gate } = await provable(cwd, "cited", {}, { render: "json" });
    const bundle = await gate.verify(turnOf(GROUNDED_ANSWER));
    expect(JSON.parse(gate.renderBundle?.(bundle) ?? "")).toEqual(bundle);
    expect(displayPath("/elsewhere/turn-1.json", cwd)).toBe("/elsewhere/turn-1.json");
    expect(displayPath(join(cwd, "a", "b.json"), cwd)).toBe(join("a", "b.json"));
  });

  test("onBundle is passed through", async () => {
    const { cwd } = workspace();
    const seen: ProofBundle[] = [];
    const { gate } = await provable(cwd, "cited", { onBundle: (b) => seen.push(b) });
    expect(gate.onBundle).toBeDefined();
    const bundle = await gate.verify(turnOf(GROUNDED_ANSWER));
    gate.onBundle?.(bundle);
    expect(seen).toEqual([bundle]);
  });

  test("the bundle carries the injected clock", async () => {
    const { cwd } = workspace();
    const { gate } = await provable(cwd, "cited");
    expect((await gate.verify(turnOf(GROUNDED_ANSWER))).createdAt).toBe(NOW.toISOString());
  });
});

describe("the proof tools", () => {
  const names = (tools: ReadonlyArray<RegisteredTool>) => tools.map((t) => t.name);

  test("per level: ProvabilityPreflight always; ProofCheckers + ProofCheck at proven or with spec-chosen checkers", async () => {
    const { cwd } = workspace();
    for (const level of ["cited", "grounded", "checked"] as const) {
      const { gates } = await provable(cwd, level);
      expect(names(gates.tools)).toEqual(["ProvabilityPreflight"]);
      // All three are bound at every level, to replace a listed builtin.
      expect(names(gates.proofTools)).toEqual([
        "ProofCheckers",
        "ProofCheck",
        "ProvabilityPreflight",
      ]);
      expect(gates.proofTools).toContain(gates.tools[0] as RegisteredTool);
    }
    expect(names((await provable(cwd, "proven")).gates.tools)).toEqual([
      "ProofCheckers",
      "ProofCheck",
      "ProvabilityPreflight",
    ]);
    const lean = await provable(cwd, "checked", {}, { formal: { checkers: ["builtin", "lean4"] } });
    expect(names(lean.gates.tools)).toEqual([
      "ProofCheckers",
      "ProofCheck",
      "ProvabilityPreflight",
    ]);
  });

  test("ProofCheck files where the gate looks: the artifact root is shared, so a proof: citation is met", async () => {
    const { cwd } = workspace();
    const { gates, gate } = await provable(cwd, "proven");
    const proofCheck = gates.tools.find((t) => t.name === "ProofCheck") as RegisteredTool;
    const raw = (await proofCheck.execute({ checker: "builtin", ...MEETINGS })) as string;
    const out = JSON.parse(raw) as { ok: boolean; id: string };
    expect(out.ok).toBe(true);
    expect(existsSync(join(proofsRoot(cwd, "support-bot"), "artifacts", `${out.id}.json`))).toBe(
      true,
    );
    const bundle = await gate.verify(
      turnOf(`${MEETINGS.claim.slice(0, -1)} [1].\n\n[1]: proof:${out.id}`, {
        messages: proofCheckRan(raw),
      }),
    );
    expect(bundle.verdict).toBe("pass");
    expect(bundle.claims[0]?.bindings[0]).toMatchObject({
      ok: true,
      rung: "proven",
      checker: "builtin",
    });
  });

  test("an accepted artifact rewritten after the check is never served as proven (design §6.4, acceptance C)", async () => {
    const { cwd } = workspace();
    const { gates, gate } = await provable(cwd, "proven");
    const proofCheck = gates.tools.find((t) => t.name === "ProofCheck") as RegisteredTool;
    const input = {
      checker: "builtin",
      claim: "Two plus two is four.",
      statement: "2 + 2 = 4",
      proof: "eval",
    };
    const raw = (await proofCheck.execute(input)) as string;
    const out = JSON.parse(raw) as { ok: boolean; id: string };
    expect(out.ok).toBe(true);
    // The file is in the workspace: rewritten to a claim and a statement the
    // builtin rejects (meeting 1 ends at 10.5, meeting 2 starts at 10), the
    // id and the verdict kept.
    const file = join(proofsRoot(cwd, "support-bot"), "artifacts", `${out.id}.json`);
    const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(
      file,
      JSON.stringify({
        ...stored,
        claim: MEETINGS.claim,
        statement:
          "let s = [9, 10, 13], e = [10.5, 12, 14] in forall i in 0..2: forall j in 0..2: i = j or e[i] <= s[j] or e[j] <= s[i]",
      }),
    );
    const bundle = await gate.verify(
      turnOf(`${MEETINGS.claim.slice(0, -1)} [1].\n\n[1]: proof:${out.id}`, {
        messages: callMessages("toolu_proof1", "ProofCheck", input, raw),
      }),
    );
    expect(bundle.verdict).toBe("fail");
    expect(bundle.claims[0]?.best).not.toBe("proven");
    expect(bundle.claims[0]?.bindings[0]).toMatchObject({ ok: false, reason: "proof_missing" });
    expect(bundle.claims[0]?.bindings[0]?.detail).toContain("not the one ProofCheck checked");
  });

  test("a ProofCheck the spec listed below proven is replaced by the bound one, so its proof: citation is met", async () => {
    // `tools: [proofCheck]` + `provability: checked` with the default checkers:
    // the level adds no ProofCheck, but the listed builtin files under
    // .crewhaus/proofs/default/ — where this gate never looks.
    const { cwd } = workspace();
    const { gates, gate } = await provable(cwd, "checked");
    const listed = mergeGateTools([builtinProofCheck], gates);
    expect(names(listed)).toEqual(["ProofCheck", "ProvabilityPreflight"]);
    expect(listed[0]).not.toBe(builtinProofCheck);
    const raw = (await (listed[0] as RegisteredTool).execute({
      checker: "builtin",
      ...MEETINGS,
    })) as string;
    const out = JSON.parse(raw) as { ok: boolean; id: string };
    expect(out.ok).toBe(true);
    expect(existsSync(join(proofsRoot(cwd, "support-bot"), "artifacts", `${out.id}.json`))).toBe(
      true,
    );
    const bundle = await gate.verify(
      turnOf(`${MEETINGS.claim.slice(0, -1)} [1].\n\n[1]: proof:${out.id}`, {
        messages: proofCheckRan(raw),
      }),
    );
    expect(bundle.verdict).toBe("pass");
    expect(bundle.claims[0]?.bindings[0]).toMatchObject({ ok: true, rung: "proven" });
  });

  test("ProvabilityPreflight grades a draft against the gate's evidence (the run's log, scoped the same way)", async () => {
    const { cwd, sessions } = workspace();
    await writeLog(sessions, SESSION, [
      userLine("refund window?"),
      ...callLines("toolu_1", "WebFetch", { url: URL_A }, fetched(URL_A, BODY_A)),
    ]);
    const { gates } = await provable(cwd, "grounded", { sessionRootDir: sessions });
    const preflight = gates.tools.find((t) => t.name === "ProvabilityPreflight") as RegisteredTool;
    const ctx: ToolExecuteContext = { bridge: { runContext: { sessionId: SESSION } } };
    const pass = JSON.parse((await preflight.execute({ draft: GROUNDED_ANSWER }, ctx)) as string);
    expect(pass.verdict).toBe("pass");
    const fail = JSON.parse(
      (await preflight.execute({ draft: GROUNDED_ANSWER.replace("14", "30") }, ctx)) as string,
    );
    expect(fail.verdict).toBe("fail");
    // No session reachable from the call: nothing counts as fetched.
    const blind = JSON.parse((await preflight.execute({ draft: GROUNDED_ANSWER })) as string);
    expect(blind.verdict).toBe("fail");
  });

  test("the preflight reads the run's own session root from the bridge when the wiring named none", async () => {
    const { cwd } = workspace();
    const elsewhere = join(cwd, "logs");
    await writeLog(elsewhere, SESSION, [
      userLine("refund window?"),
      ...callLines("toolu_1", "WebFetch", { url: URL_A }, fetched(URL_A, BODY_A)),
    ]);
    const { gates } = await provable(cwd, "grounded");
    const preflight = gates.tools.find((t) => t.name === "ProvabilityPreflight") as RegisteredTool;
    const ctx: ToolExecuteContext = {
      bridge: { runContext: { sessionId: SESSION }, sessionRootDir: elsewhere },
    };
    expect(
      JSON.parse((await preflight.execute({ draft: GROUNDED_ANSWER }, ctx)) as string).verdict,
    ).toBe("pass");
  });
});

describe("tenancy", () => {
  test("inside withTenant, bundles and artifacts go under the tenant's root; nothing under the workspace", async () => {
    const { cwd } = workspace();
    const tenants = dirs.make();
    const acme = buildTenant("acme", { tenantsRoot: tenants });
    const { gates, gate } = await provable(cwd, "proven");
    const tenantProofs = join(acme.sessionRoot, "..", "proofs", "support-bot");
    const answerFor = (id: string) => `${MEETINGS.claim.slice(0, -1)} [1].\n\n[1]: proof:${id}`;
    const { id, path } = (await withTenant(acme, async () => {
      const proofCheck = gates.tools.find((t) => t.name === "ProofCheck") as RegisteredTool;
      const raw = (await proofCheck.execute({ checker: "builtin", ...MEETINGS })) as string;
      const out = JSON.parse(raw) as { id: string };
      const bundle = await gate.verify(turnOf(answerFor(out.id), { messages: proofCheckRan(raw) }));
      expect(bundle.verdict).toBe("pass");
      const persisted = (await gate.persist?.(bundle, {
        sessionId: SESSION,
        turnNumber: 1,
      })) as string;
      // The footer goes to the tenant's client: the path is shown from the
      // tenant's own root, never the server's layout above it.
      expect(gate.renderBundle?.(bundle, persisted)).toEndWith(
        ` · ${join("proofs", "support-bot", SESSION, "turn-1.json")}`,
      );
      expect(gate.renderBundle?.(bundle, persisted)).not.toContain(tenants);
      // So do the run's live surfaces — the trace event a runs.subscribe
      // stream carries, a halt's detail — by the same rule.
      expect(gate.displayPath?.(persisted)).toBe(
        join("proofs", "support-bot", SESSION, "turn-1.json"),
      );
      return { id: out.id, path: persisted };
    })) as { id: string; path: string };
    expect(path.startsWith(tenantProofs)).toBe(true);
    // Outside a tenant scope, relative to the workspace.
    expect(gate.displayPath?.(join(cwd, ".crewhaus", "proofs", "x.json"))).toBe(
      join(".crewhaus", "proofs", "x.json"),
    );
    expect(existsSync(join(tenantProofs, "artifacts", `${id}.json`))).toBe(true);
    expect(existsSync(join(cwd, ".crewhaus", "proofs"))).toBe(false);
    // Outside the tenant the same citation finds nothing: another root.
    const outside = await gate.verify(turnOf(answerFor(id)));
    expect(outside.verdict).toBe("fail");
    expect(outside.claims[0]?.bindings[0]?.reason).toBe("proof_missing");
  });

  test("a page the runtime spilled under the tenant's toolResultRoot is graded whole, in the gate and the preflight", async () => {
    const { cwd } = workspace();
    const acme = buildTenant("acme", { tenantsRoot: dirs.make() });
    // The claim is on line 151 of the page: past the 100-line preview the
    // runtime logs, so only the spilled file holds it.
    const lines = Array.from(
      { length: 300 },
      (_, i) => `Line ${i}: shipping and handling notes for the warehouse team.`,
    );
    lines[150] = "Refunds: Acme accepts refund requests within 14 days of purchase.";
    const page = fetched(URL_A, lines.join("\n"));
    const stored = await storeAndPreview(
      { toolUseId: "toolu_big", content: page, isError: false },
      { runId: "run_1", toolUseId: "toolu_big", rootDir: acme.toolResultRoot },
    );
    expect(stored.persisted).toBe(true);
    const preview = stored.previewContent as string;
    expect(preview).not.toContain("within 14 days");
    const answer = `Acme accepts refund requests within 14 days of purchase [1].\n\n[1]: ${URL_A}`;
    const { gates, gate } = await provable(cwd, "grounded");
    const messages = callMessages("toolu_big", "WebFetch", { url: URL_A }, preview);
    const inside = await withTenant(acme, () => gate.verify(turnOf(answer, { messages })));
    expect(inside.verdict).toBe("pass");
    // The preflight reads the tenant's session log the same way.
    await writeLog(acme.sessionRoot, SESSION, [
      userLine("refund window?"),
      ...callLines("toolu_big", "WebFetch", { url: URL_A }, preview),
    ]);
    const preflight = gates.tools.find((t) => t.name === "ProvabilityPreflight") as RegisteredTool;
    const ctx: ToolExecuteContext = { bridge: { runContext: { sessionId: SESSION } } };
    const drafted = (await withTenant(acme, () =>
      preflight.execute({ draft: answer }, ctx),
    )) as string;
    expect(JSON.parse(drafted).verdict).toBe("pass");
    // Outside the tenant the spill root is the workspace's: only the preview counts.
    const outside = await gate.verify(turnOf(answer, { messages }));
    expect(outside.verdict).toBe("fail");
  });

  test("a fixed session root outside the tenant's root fails closed (the gate then serves unverified)", async () => {
    const { cwd, sessions } = workspace();
    const tenants = dirs.make();
    const acme = buildTenant("acme", { tenantsRoot: tenants });
    const { gate } = await provable(cwd, "grounded", { sessionRootDir: sessions });
    await expect(
      withTenant(acme, () => gate.verify(turnOf(GROUNDED_ANSWER, { sessionId: SESSION }))),
    ).rejects.toBeInstanceOf(TenancyError);
  });
});

describe("evaluation + provability together", () => {
  test("both gates and the tools from one call", async () => {
    const { cwd } = workspace();
    const gates = await wireEvaluation(
      {
        specName: "support-bot",
        primaryModel: "m",
        evaluation: { grader: { type: "contains", value: "[1]" }, onFail: "retry", maxRetries: 1 },
        provability: config("grounded"),
      },
      { cwd },
    );
    expect(Object.keys(gates).sort()).toEqual(["evaluation", "proofTools", "provability", "tools"]);
    expect(gates.evaluation?.graderType).toBe("contains");
    expect(gates.provability?.level).toBe("grounded");
    expect(gates.tools.map((t) => t.name)).toEqual(["ProvabilityPreflight"]);
    expect(gates.proofTools.map((t) => t.name)).toEqual([
      "ProofCheckers",
      "ProofCheck",
      "ProvabilityPreflight",
    ]);
  });
});
