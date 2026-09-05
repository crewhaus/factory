/**
 * 0.6.0 §7.2 / §7.4 / §7.11 / §8.1 — the preRoute phase over the LIVE
 * `runChatLoop` path (plan §1 acceptance item 4):
 *
 *   - `/model strong` routes the turn with `policy: directive`, the request
 *     copy is stripped while the persisted transcript keeps the token, and
 *     the pin lands in session metadata;
 *   - the pin survives a channel-style resume-per-message, `/model auto`
 *     clears it (the acknowledgement is the reply — no model call);
 *   - a non-roster target is refused with the roster listed; with
 *     `directives` off (the default) the token is prose and the refusal is
 *     recorded;
 *   - a `/model …` string inside a synthetic user message (a grader
 *     rationale) never steers routing;
 *   - an image message routes to the vision-capable candidate with
 *     `policy: rule`, `ruleId` and `eligible[]` persisted — and the durable
 *     `model_route` line carries every field `route explain --json` needs to
 *     reproduce the decision from the session log alone;
 *   - `policy: classifier` serves the injected classifier's label with the
 *     verdict persisted, and falls back to heuristic with `classifier failed`;
 *   - the `pre-model` hook's `mutate.systemAppend` reaches the request.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  ProviderAdapter,
  ProviderFeatures,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import { openScoreboard } from "@crewhaus/routing-store";
import { createRunContext } from "@crewhaus/run-context";
import { createSessionStore } from "@crewhaus/session-store";
import { buildTool } from "@crewhaus/tool-builder";
import type { ModelDirectiveEvent, ModelRouteEvent, TraceEvent } from "@crewhaus/trace-event-bus";
import { z } from "zod";
import { type RunChatLoopOptions, type RunEvaluation, runChatLoop } from "./index";

const SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-directives-tests-"));
beforeAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = SESSION_ROOT;
});
afterAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = undefined;
  rmSync(SESSION_ROOT, { recursive: true, force: true });
});

const FULL: ProviderFeatures = {
  caching: "explicit",
  tool_use: true,
  vision: true,
  thinking: false,
  web_search: false,
};

const FAST = "claude-haiku-4-5";
const STRONG = "claude-opus-4-1";

function textAdapter(
  reply: string,
  features: ProviderFeatures = FULL,
): ProviderAdapter & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    providerId: "anthropic",
    features,
    estimateTokens: () => 0,
    stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
      requests.push(req);
      return (async function* () {
        yield { kind: "message_start", usage: { input: 100, output: 0 } };
        yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
        yield { kind: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "end_turn", usage: { input: 100, output: 10 } };
        yield { kind: "message_stop" };
      })();
    },
  };
}

/**
 * A tool-loop adapter: each call follows `script` (`tool` emits one `noop`
 * tool_use, `text` ends the turn), so one turn spans several model calls.
 */
function toolLoopAdapter(
  script: ReadonlyArray<"tool" | "text">,
  reply: string,
  features: ProviderFeatures = FULL,
): ProviderAdapter & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  let call = 0;
  return {
    requests,
    providerId: "anthropic",
    features,
    estimateTokens: () => 0,
    stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
      requests.push(req);
      const step = script[call] ?? "text";
      const id = `tu_${call}`;
      call += 1;
      return (async function* () {
        yield { kind: "message_start", usage: { input: 100, output: 0 } };
        if (step === "tool") {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "tool_use", id, name: "noop", input: {} },
          };
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "{}" },
          };
          yield { kind: "content_block_stop", index: 0 };
          yield {
            kind: "message_delta",
            stopReason: "tool_use",
            usage: { input: 100, output: 10 },
          };
        } else {
          yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: reply },
          };
          yield { kind: "content_block_stop", index: 0 };
          yield {
            kind: "message_delta",
            stopReason: "end_turn",
            usage: { input: 100, output: 10 },
          };
        }
        yield { kind: "message_stop" };
      })();
    },
  };
}

const noopTool = () =>
  buildTool({
    name: "noop",
    description: "does nothing",
    inputSchema: z.object({}),
    readOnly: true,
    execute: async () => "ok",
  });

/** Silence + collect the `[budget]` stderr lines a degrade prints. */
function captureStderr(): { lines: () => string[]; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  return {
    lines: () => chunks.join("").split("\n"),
    restore: () => {
      process.stderr.write = original;
    },
  };
}

type Pool = NonNullable<RunChatLoopOptions["modelPool"]>;
const CANDIDATES: Pool["candidates"] = [
  { model: FAST, tags: ["cheap"], profile: "fast" },
  { model: STRONG, tags: ["strong"], profile: "strong" },
];

type LoggedLine = { kind: string; payload?: Record<string, unknown> };
function sessionLines(sessionId: string): LoggedLine[] {
  const out: LoggedLine[] = [];
  for (const file of readdirSync(SESSION_ROOT).filter(
    (f) => f.startsWith(sessionId) && f.endsWith(".jsonl"),
  )) {
    for (const line of readFileSync(join(SESSION_ROOT, file), "utf-8").split("\n")) {
      if (line === "") continue;
      out.push(JSON.parse(line) as LoggedLine);
    }
  }
  return out;
}

async function singleTurn(
  fast: ProviderAdapter,
  strong: ProviderAdapter,
  pool: Partial<Pool>,
  seed: Anthropic.MessageParam[],
  extra: Partial<RunChatLoopOptions> = {},
) {
  const runContext = createRunContext(
    extra.resume !== undefined ? { sessionId: extra.resume.sessionId } : {},
  );
  const events: TraceEvent[] = [];
  runContext.eventBus.subscribe((e) => events.push(e));
  const text = await runChatLoop({
    model: "claude-sonnet-4-6",
    instructions: "test harness",
    _adapter: textAdapter("primary"),
    modelPool: { candidates: CANDIDATES, policy: "heuristic", ...pool },
    _poolAdapters: new Map<string, ProviderAdapter>([
      [FAST, fast],
      [STRONG, strong],
    ]),
    _scoreboard: openScoreboard(mkdtempSync(join(tmpdir(), "crewhaus-directives-sb-"))),
    runContext,
    singleTurn: true,
    seedMessages: seed,
    permissionMode: "bypass",
    installSigintHandler: false,
    spinner: false,
    stdout: () => {},
    settingsDir: null,
    ...extra,
  });
  const routes = events.filter((e): e is ModelRouteEvent => e.kind === "model_route");
  const directives = events.filter((e): e is ModelDirectiveEvent => e.kind === "model_directive");
  return { text, events, routes, directives, sessionId: runContext.sessionId };
}

const userText = (req: ProviderRequest | undefined): string => {
  const last = req?.messages[req.messages.length - 1];
  if (last === undefined) return "";
  if (typeof last.content === "string") return last.content;
  return (last.content as Anthropic.ContentBlockParam[])
    .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
    .map((b) => b.text)
    .join("\n");
};

const roles = (req: ProviderRequest | undefined): string[] =>
  req?.messages.map((m) => m.role) ?? [];
const allText = (req: ProviderRequest | undefined): string =>
  (req?.messages ?? [])
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : (m.content as Anthropic.ContentBlockParam[])
            .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
            .map((b) => b.text)
            .join("\n"),
    )
    .join("\n");

describe("directives — /model steering (§7.2.1)", () => {
  test("/model strong routes the turn with policy directive; the request copy is stripped, the transcript keeps the token, the pin is written", async () => {
    const fast = textAdapter("fast");
    const strong = textAdapter("strong");
    // An EASY turn (turnIndex 0 is hard by default → disable that) so the
    // heuristic would have picked the cheap arm without the directive.
    const r = await singleTurn(
      fast,
      strong,
      { directives: true, routing: { firstTurnToDefault: false } },
      [{ role: "user", content: "/model strong what is 2+2?" }],
    );
    expect(r.text).toBe("strong");
    expect(fast.requests).toHaveLength(0);
    expect(userText(strong.requests[0])).toBe("what is 2+2?");
    expect(r.routes[0]).toMatchObject({
      policy: "directive",
      model: STRONG,
      profile: "strong",
      hint: { source: "directive", forcedArm: "strong", evidence: "pin=strong" },
      eligible: ["fast", "strong"],
    });
    expect(r.directives).toEqual([
      expect.objectContaining({
        source: "seed",
        requested: "strong",
        resolved: "strong",
        accepted: true,
      }),
    ]);
    // The pin is in session metadata; the persisted transcript kept the token.
    const session = await createSessionStore({ rootDir: SESSION_ROOT }).get(r.sessionId);
    expect(session?.pin).toBe("strong");
    const lines = sessionLines(r.sessionId);
    const logged = lines.find((l) => l.kind === "user_message");
    expect(logged?.payload?.["content"]).toBe("/model strong what is 2+2?");
    expect(logged?.payload?.["directive"]).toBe(true);
    expect(lines.some((l) => l.kind === "model_directive")).toBe(true);
  });

  test("the pin survives a resume-per-message; /model auto clears it with no model call; routing is automatic again", async () => {
    const pool: Partial<Pool> = { directives: true, routing: { firstTurnToDefault: false } };
    const first = await singleTurn(textAdapter("fast"), textAdapter("strong"), pool, [
      { role: "user", content: "/model $strong hello" },
    ]);
    expect(first.routes[0]?.policy).toBe("directive");

    // Message 2 — a plain inbound text on the same session: still pinned.
    const fast2 = textAdapter("fast 2");
    const strong2 = textAdapter("strong 2");
    const second = await singleTurn(fast2, strong2, pool, [{ role: "user", content: "and 3+3?" }], {
      resume: { sessionId: first.sessionId },
    });
    expect(second.text).toBe("strong 2");
    expect(fast2.requests).toHaveLength(0);
    expect(second.routes[0]).toMatchObject({ policy: "directive", model: STRONG });
    // The replayed prefix is the REQUEST copy: the persisted line keeps the
    // token, the model never sees it — on this turn or any resumed one.
    expect(strong2.requests[0]?.messages[0]?.content).toBe("hello");
    expect(roles(strong2.requests[0])).toEqual(["user", "assistant", "user"]);
    expect(allText(strong2.requests[0])).not.toContain("/model");
    expect(second.directives).toEqual([
      expect.objectContaining({ source: "session", resolved: "strong", accepted: true }),
    ]);

    // Message 3 — `/model auto` alone: the acknowledgement is the reply.
    const fast3 = textAdapter("fast 3");
    const strong3 = textAdapter("strong 3");
    const third = await singleTurn(
      fast3,
      strong3,
      pool,
      [{ role: "user", content: "/model auto" }],
      {
        resume: { sessionId: first.sessionId },
      },
    );
    expect(third.text).toContain("model pin cleared");
    expect(fast3.requests).toHaveLength(0);
    expect(strong3.requests).toHaveLength(0);
    expect(third.routes).toHaveLength(0);
    expect(third.directives.map((d) => [d.source, d.requested, d.accepted])).toEqual([
      ["session", "strong", true],
      ["seed", "auto", true],
    ]);
    const session = await createSessionStore({ rootDir: SESSION_ROOT }).get(first.sessionId);
    expect(session?.pin).toBeUndefined();

    // Message 4 — automatic routing (easy turn → cheap).
    const fast4 = textAdapter("fast 4");
    const strong4 = textAdapter("strong 4");
    const fourth = await singleTurn(fast4, strong4, pool, [{ role: "user", content: "and 4+4?" }], {
      resume: { sessionId: first.sessionId },
    });
    expect(fourth.text).toBe("fast 4");
    expect(fourth.routes[0]).toMatchObject({ policy: "heuristic", hint: { source: "none" } });
    expect(fourth.directives).toHaveLength(0);
    // Message 3 (`/model auto` alone) ran no turn, so it has no assistant
    // reply: replaying it would put two user messages side by side with the
    // raw token in the model's context. It is persisted, but not replayed.
    expect(roles(fast4.requests[0])).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(allText(fast4.requests[0])).not.toContain("/model");
    expect(fast4.requests[0]?.messages[0]?.content).toBe("hello");
    expect(userText(fast4.requests[0])).toBe("and 4+4?");
    const userLines = sessionLines(first.sessionId).filter((l) => l.kind === "user_message");
    expect(userLines.map((l) => l.payload?.["content"])).toEqual([
      "/model $strong hello",
      "and 3+3?",
      "/model auto",
      "and 4+4?",
    ]);
  });

  test("a non-roster target is refused with the roster listed; the turn runs on the rest", async () => {
    const fast = textAdapter("fast");
    const strong = textAdapter("strong");
    const r = await singleTurn(
      fast,
      strong,
      { directives: true, routing: { firstTurnToDefault: false } },
      [{ role: "user", content: "/model turbo what is 2+2?" }],
    );
    expect(r.text).toBe("fast");
    expect(userText(fast.requests[0])).toBe("what is 2+2?");
    expect(r.directives[0]).toMatchObject({ source: "seed", requested: "turbo", accepted: false });
    expect(r.directives[0]?.reason).toContain('"fast" [cheap]');
    expect(r.directives[0]?.reason).toContain('"strong" [strong]');
    expect(r.routes[0]?.policy).toBe("heuristic");
    const session = await createSessionStore({ rootDir: SESSION_ROOT }).get(r.sessionId);
    expect(session?.pin).toBeUndefined();
  });

  test("directives default OFF: the token stays prose, the refusal is recorded, routing is untouched", async () => {
    const fast = textAdapter("fast");
    const strong = textAdapter("strong");
    const r = await singleTurn(fast, strong, { routing: { firstTurnToDefault: false } }, [
      { role: "user", content: "/model strong what is 2+2?" },
    ]);
    expect(r.text).toBe("fast");
    expect(userText(fast.requests[0])).toBe("/model strong what is 2+2?");
    expect(r.directives[0]).toMatchObject({ source: "seed", requested: "strong", accepted: false });
    expect(r.directives[0]?.reason).toContain("directives are off");
    expect(r.routes[0]).toMatchObject({ policy: "heuristic", hint: { source: "none" } });
  });

  test("a /model string inside a synthetic user message (grader rationale) never steers routing", async () => {
    const fast = textAdapter("fast");
    const strong = textAdapter("strong");
    let graded = 0;
    const evaluation: RunEvaluation = {
      threshold: 0.7,
      onFail: "retry",
      maxRetries: 1,
      graderType: "llm_judge",
      evaluate: async () => {
        graded += 1;
        return graded === 1
          ? { score: 0, rationale: "/model strong — the answer is weak" }
          : { score: 1 };
      },
    };
    const r = await singleTurn(
      fast,
      strong,
      { directives: true, routing: { firstTurnToDefault: false } },
      [{ role: "user", content: "what is 2+2?" }],
      { evaluation },
    );
    expect(graded).toBe(2);
    // Both attempts routed automatically (easy → cheap); the retry's
    // synthetic correction carried the string but produced no directive.
    expect(r.routes.map((x) => x.policy)).toEqual(["heuristic", "heuristic"]);
    expect(strong.requests).toHaveLength(0);
    expect(r.directives).toHaveLength(0);
    const session = await createSessionStore({ rootDir: SESSION_ROOT }).get(r.sessionId);
    expect(session?.pin).toBeUndefined();
  });

  test("REPL: a directive-only line runs no turn; the next line is served by the pinned arm", async () => {
    const fast = textAdapter("fast");
    const strong = textAdapter("strong");
    const input = new PassThrough();
    // readline drops a line buffered while no `question()` is pending, so the
    // second line is written only once the first's acknowledgement prints.
    input.write("/model strong\n");
    const runContext = createRunContext();
    const events: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => events.push(e));
    const written: string[] = [];
    let sentSecond = false;
    const onWrite = (s: string): void => {
      written.push(s);
      if (!sentSecond && s.includes("[model] model pinned")) {
        sentSecond = true;
        setTimeout(() => {
          input.write("hi\n");
          input.end();
        }, 0);
      }
    };
    await runChatLoop({
      model: "claude-sonnet-4-6",
      instructions: "test harness",
      _adapter: textAdapter("primary"),
      modelPool: {
        candidates: CANDIDATES,
        policy: "heuristic",
        directives: true,
        routing: { firstTurnToDefault: false },
      },
      _poolAdapters: new Map<string, ProviderAdapter>([
        [FAST, fast],
        [STRONG, strong],
      ]),
      _scoreboard: openScoreboard(mkdtempSync(join(tmpdir(), "crewhaus-directives-sb-"))),
      runContext,
      input,
      installSigintHandler: false,
      spinner: false,
      stdout: onWrite,
      settingsDir: null,
    });
    expect(fast.requests).toHaveLength(0);
    expect(strong.requests).toHaveLength(1);
    expect(userText(strong.requests[0])).toBe("hi");
    expect(written.join("")).toContain('[model] model pinned to "strong"');
    const routes = events.filter((e): e is ModelRouteEvent => e.kind === "model_route");
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ policy: "directive", model: STRONG });
    const directive = events.find((e): e is ModelDirectiveEvent => e.kind === "model_directive");
    expect(directive).toMatchObject({ source: "repl", requested: "strong", accepted: true });
    const lines = sessionLines(runContext.sessionId);
    const userLines = lines.filter((l) => l.kind === "user_message");
    expect(userLines[0]?.payload).toMatchObject({ content: "/model strong", directive: true });
    expect(userLines[1]?.payload).toMatchObject({ content: "hi" });
  });
});

describe("rules + eligibility — the durable route line (§7.2.2, §7.11, §8.1)", () => {
  test("an image message routes to the vision-capable candidate with policy rule, ruleId and eligible[] persisted", async () => {
    const blind = textAdapter("blind", { ...FULL, vision: false });
    const sighted = textAdapter("sighted");
    const r = await singleTurn(
      blind,
      sighted,
      {
        policy: "static",
        rules: [
          {
            id: "images-need-vision",
            when: { has_images: true },
            use: { requires: { vision: true } },
          },
          {
            id: "code-goes-strong",
            when: { message_matches: "(?i)\\brefactor\\b" },
            use: "strong",
          },
        ],
      },
      [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
            },
          ],
        },
      ],
    );
    expect(r.text).toBe("sighted");
    expect(blind.requests).toHaveLength(0);
    const route = r.routes[0];
    expect(route).toMatchObject({
      policy: "rule",
      model: STRONG,
      profile: "strong",
      ruleId: "images-need-vision",
      eligible: ["strong"],
      hint: {
        source: "rule",
        forcedArm: "strong",
        excludedArms: ["fast"],
        evidence: "ruleId=images-need-vision, requires=vision",
      },
    });
    expect(route?.reason).toContain("fast ineligible (requires:vision)");
    expect(route?.signals).toMatchObject({ hasImages: true, userTextChars: 13 });
    // Never the text itself — a hash at most.
    expect(JSON.stringify(route?.signals)).not.toContain("what is this");
    expect(typeof route?.signals?.textHash).toBe("string");

    // The persisted line carries every field `route explain --json` needs.
    const line = sessionLines(r.sessionId).find((l) => l.kind === "model_route");
    expect(line?.payload).toMatchObject({
      turnNumber: 1,
      routeKey: expect.any(String),
      model: STRONG,
      policy: "rule",
      ruleId: "images-need-vision",
      eligible: ["strong"],
      profile: "strong",
      hint: { source: "rule", forcedArm: "strong" },
      signals: { hasImages: true },
      explored: false,
    });
    expect(typeof line?.payload?.["policyVersion"]).toBe("string");
    expect(typeof line?.payload?.["toolsetFingerprint"]).toBe("string");
  });

  test("a text rule (message_matches → tag) forces its arm; the second call of the turn re-evaluates from the same human text", async () => {
    const fast = textAdapter("fast");
    const strong = textAdapter("strong");
    const r = await singleTurn(
      fast,
      strong,
      {
        policy: "static",
        rules: [
          {
            id: "code-goes-strong",
            when: { message_matches: "(?i)\\b(refactor|stack ?trace)\\b" },
            use: "strong",
          },
        ],
      },
      [{ role: "user", content: "please refactor this" }],
    );
    expect(r.text).toBe("strong");
    expect(r.routes[0]).toMatchObject({
      policy: "rule",
      ruleId: "code-goes-strong",
      hint: {
        source: "rule",
        forcedArm: "strong",
        evidence: "ruleId=code-goes-strong, use=strong",
      },
    });
  });

  test("a rule that does not match leaves the policy in charge; the hint records source none", async () => {
    const fast = textAdapter("fast");
    const strong = textAdapter("strong");
    const r = await singleTurn(
      fast,
      strong,
      {
        policy: "static",
        rules: [{ id: "images-need-vision", when: { has_images: true }, use: "strong" }],
      },
      [{ role: "user", content: "hello" }],
    );
    expect(r.text).toBe("fast");
    expect(r.routes[0]).toMatchObject({ policy: "static", hint: { source: "none" } });
    expect(r.routes[0]?.ruleId).toBeUndefined();
  });
});

describe("forced lane — the degrade rung passes the N1 check (§7.11, §7.12)", () => {
  test("a vision-less degrade rung under an image transcript gives way to the cheapest eligible roster arm", async () => {
    // Roster: sonnet (cheap) + opus (strong); the degrade rung is haiku, OFF
    // the roster and declared vision-less. First turn → opus (2250 micros)
    // breaches the 2000 cap after its tool_use call; the per-model-call gate
    // latches the degrade for call 2. The transcript carries an image, so
    // the rung would 400 — the forced lane serves the cheapest eligible
    // roster arm instead and the route line says why.
    const SONNET = "claude-sonnet-4-6";
    const cheap = textAdapter("sonnet");
    const strong = toolLoopAdapter(["tool", "text"], "opus");
    const rung = textAdapter("haiku", { ...FULL, vision: false });
    const runContext = createRunContext();
    const events: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => events.push(e));
    const stderr = captureStderr();
    let text: string;
    try {
      text = await runChatLoop({
        model: STRONG,
        instructions: "test harness",
        _adapter: strong,
        modelPool: {
          candidates: [
            { model: SONNET, tags: ["cheap"] },
            { model: STRONG, tags: ["strong"] },
          ],
          policy: "heuristic",
        },
        _poolAdapters: new Map<string, ProviderAdapter>([
          [SONNET, cheap],
          [STRONG, strong],
        ]),
        _scoreboard: openScoreboard(mkdtempSync(join(tmpdir(), "crewhaus-directives-sb-"))),
        _budgetDegradeAdapter: rung,
        budget: { usdMicros: 2000, onExceed: { kind: "degrade", model: FAST } },
        tools: [noopTool()],
        runContext,
        singleTurn: true,
        seedMessages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
              },
            ],
          },
        ],
        permissionMode: "bypass",
        installSigintHandler: false,
        spinner: false,
        stdout: () => {},
        settingsDir: null,
      });
    } finally {
      stderr.restore();
    }
    expect(text).toBe("sonnet");
    expect(strong.requests).toHaveLength(1);
    expect(cheap.requests).toHaveLength(1);
    expect(rung.requests).toHaveLength(0);
    const routes = events.filter((e): e is ModelRouteEvent => e.kind === "model_route");
    expect(routes.map((r) => [r.model, r.policy])).toEqual([
      [STRONG, "heuristic"],
      [SONNET, "forced"],
    ]);
    expect(routes[1]).toMatchObject({
      hint: {
        source: "forced",
        forcedArm: SONNET,
        evidence: `lane=budget, reason=budget_degrade, ineligible=${FAST}, served=${SONNET}`,
      },
    });
    expect(routes[1]?.reason).toContain("budget_degrade");
    expect(routes[1]?.reason).toContain(
      `forced budget arm "${FAST}" ineligible this turn (requires:vision); served ${SONNET} instead`,
    );
    expect(routes[1]?.reason).not.toContain("no-eligible-candidate");
    expect(stderr.lines().some((l) => l.includes(`restricting model_pool to ${FAST}`))).toBe(true);
  });
});

describe("classifier — policy: classifier (§7.2.3)", () => {
  const CLASSIFIER: Pool["classifier"] = {
    model: FAST,
    labels: { cheap: "simple lookup", strong: "multi-step reasoning" },
    maxTokens: 16,
  };

  test("the injected classifier's label is served (policy classifier) and the verdict is persisted", async () => {
    const fast = textAdapter("fast");
    const strong = textAdapter("strong");
    const seen: { userText: string; labels: readonly string[] }[] = [];
    // A HARD turn (first turn) — the heuristic would pick strong; the
    // classifier says cheap.
    const r = await singleTurn(
      fast,
      strong,
      { policy: "classifier", classifier: CLASSIFIER },
      [{ role: "user", content: "what time is it?" }],
      {
        routeClassifier: async ({ userText: text, labels }) => {
          seen.push({ userText: text, labels });
          return { label: "cheap", model: FAST, costUsdMicros: 7 };
        },
      },
    );
    expect(r.text).toBe("fast");
    expect(seen).toEqual([{ userText: "what time is it?", labels: ["cheap", "strong"] }]);
    expect(r.routes[0]).toMatchObject({
      policy: "classifier",
      model: FAST,
      classifierVerdict: { label: "cheap", model: FAST, costUsdMicros: 7 },
      hint: { source: "classifier", forcedArm: "fast", evidence: "label=cheap" },
    });
    const line = sessionLines(r.sessionId).find((l) => l.kind === "model_route");
    expect(line?.payload).toMatchObject({
      policy: "classifier",
      classifierVerdict: { label: "cheap" },
    });
  });

  test("the classifier runs ONCE per turn: a tool loop's inner model calls reuse the verdict, persisted on every route line", async () => {
    const fast = toolLoopAdapter(["tool", "text"], "fast");
    const strong = textAdapter("strong");
    let calls = 0;
    const r = await singleTurn(
      fast,
      strong,
      { policy: "classifier", classifier: CLASSIFIER },
      [{ role: "user", content: "what time is it?" }],
      {
        tools: [noopTool()],
        routeClassifier: async () => {
          calls += 1;
          return { label: "cheap", model: FAST, costUsdMicros: 7 };
        },
      },
    );
    expect(r.text).toBe("fast");
    expect(fast.requests).toHaveLength(2);
    expect(strong.requests).toHaveLength(0);
    expect(calls).toBe(1);
    expect(r.routes).toHaveLength(2);
    for (const route of r.routes) {
      expect(route).toMatchObject({
        policy: "classifier",
        model: FAST,
        classifierVerdict: { label: "cheap", model: FAST, costUsdMicros: 7 },
      });
    }
    const lines = sessionLines(r.sessionId).filter((l) => l.kind === "model_route");
    expect(lines).toHaveLength(2);
    expect(
      lines.every(
        (l) => (l.payload?.["classifierVerdict"] as { label?: string })?.label === "cheap",
      ),
    ).toBe(true);
  });

  test("a failing classifier falls back to heuristic with reason `classifier failed`", async () => {
    const fast = textAdapter("fast");
    const strong = textAdapter("strong");
    const r = await singleTurn(
      fast,
      strong,
      { policy: "classifier", classifier: CLASSIFIER },
      [{ role: "user", content: "what time is it?" }],
      {
        routeClassifier: async () => {
          throw new Error("boom");
        },
      },
    );
    expect(r.text).toBe("strong");
    expect(r.routes[0]?.policy).toBe("heuristic");
    expect(r.routes[0]?.reason).toContain("classifier failed: boom");
    expect(r.routes[0]?.classifierVerdict).toBeUndefined();
  });

  test("policy classifier without a wired classifier routes heuristically with the reason recorded", async () => {
    const r = await singleTurn(
      textAdapter("fast"),
      textAdapter("strong"),
      { policy: "classifier" },
      [{ role: "user", content: "hello" }],
    );
    expect(r.routes[0]?.policy).toBe("heuristic");
    expect(r.routes[0]?.reason).toContain("classifier failed: no classifier wired");
  });
});

describe("pre-model hook — mutate.systemAppend (§7.4)", () => {
  test("a hook's systemAppend is appended to the request's system prompt, after the prefix", async () => {
    const adapter = textAdapter("ok");
    const runContext = createRunContext();
    await runChatLoop({
      model: "claude-sonnet-4-6",
      instructions: "be helpful",
      _adapter: adapter,
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hi" }],
      hooks: [
        {
          event: "pre-model",
          matcher: "*",
          command: `printf '{"decision":"allow","mutate":{"systemAppend":"[hook] answer in one line"}}\\n'`,
        },
      ],
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
      settingsDir: null,
    });
    const system = adapter.requests[0]?.system ?? [];
    expect(system[0]?.text).toContain("be helpful");
    expect(system[system.length - 1]).toEqual({ type: "text", text: "[hook] answer in one line" });
  });
});
