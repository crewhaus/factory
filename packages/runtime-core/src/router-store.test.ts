/**
 * 0.6.0 PR 10 — the router + routing-store integration over the LIVE
 * `runChatLoop` path (plan §4.4, §7.9, §7.10, §7.11, §6.3):
 *  - profiled arms record under the PROFILE NAME, every line carrying the
 *    `v:2` provenance (`pv` / `sc` / `h` / `pf`);
 *  - a scoped pool keys `<scope>/<band>` and the learned policy backs off to
 *    the unscoped band arm while the scoped one is cold;
 *  - the floor (acceptance item 7): fast's judged LCB under the strong arm's
 *    mean → `reason: "floor-blocked"` verbatim; after the stub improves fast
 *    is exploitable; `route freeze` pins the policyVersion and stops learning;
 *  - eval-seeded priors skip warm-up and change `policyVersion`; a stale
 *    priors file is ignored (cold warm-up, unchanged version);
 *  - a candidate whose per-candidate breaker opened is ineligible for the
 *    rest of the turn (`breaker-open`), so the escalation lands elsewhere;
 *  - a candidate with `fallbacks` serves through its own chain and the served
 *    MEMBER is what `model_response` and pricing see (`lastServed`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import { priorsFingerprint } from "@crewhaus/model-plan";
import { FLOOR_BLOCKED_ROUTE_REASON } from "@crewhaus/model-router";
import { openScoreboard, writeRouteFreeze } from "@crewhaus/routing-store";
import { createRunContext } from "@crewhaus/run-context";
import type { ModelResponseEvent, ModelRouteEvent, TraceEvent } from "@crewhaus/trace-event-bus";
import { isFloorBlockedRoute } from "./alert-watchdog";
import { runChatLoop } from "./index";

const ROOTS: string[] = [];
/** A fresh `.crewhaus`-shaped root: sessions under it, so `routing/` sits beside them. */
function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "crewhaus-pr10-"));
  ROOTS.push(root);
  mkdirSync(join(root, "sessions"), { recursive: true });
  process.env["CREWHAUS_SESSION_DIR"] = join(root, "sessions");
  return root;
}
afterEach(() => {
  process.env["CREWHAUS_SESSION_DIR"] = undefined;
});
afterEach(() => {
  for (const r of ROOTS.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function* okEvents(text: string): AsyncIterable<StreamEvent> {
  yield { kind: "message_start", usage: { input: 100, output: 0 } };
  yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
  yield { kind: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
  yield { kind: "content_block_stop", index: 0 };
  yield { kind: "message_delta", stopReason: "end_turn", usage: { input: 100, output: 10 } };
  yield { kind: "message_stop" };
}

type Stub = ProviderAdapter & { requests: ProviderRequest[] };
function okAdapter(text: string, providerId: ProviderId = "anthropic"): Stub {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    providerId,
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
      requests.push(req);
      return okEvents(text);
    },
  };
}
/** Fails with a `continue`-recoverable error while `down()`. */
function failingAdapter(down: () => boolean, text = "recovered"): Stub {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
      requests.push(req);
      return (async function* () {
        if (down()) {
          const err = new Error("scripted outage") as Error & { error: { type: string } };
          err.error = { type: "max_output_tokens" };
          throw err;
        }
        yield* okEvents(text);
      })();
    },
  };
}

const HAIKU = "claude-haiku-4-5";
const OPUS = "claude-opus-4-8";
const SONNET = "claude-sonnet-4-6";
const PROFILED = [
  { model: HAIKU, tags: ["cheap"], profile: "fast" },
  { model: OPUS, tags: ["strong"], profile: "strong" },
];

function watch() {
  const runContext = createRunContext();
  const seen: TraceEvent[] = [];
  runContext.eventBus.subscribe((e) => seen.push(e));
  return {
    runContext,
    seen,
    routes: () => seen.filter((e): e is ModelRouteEvent => e.kind === "model_route"),
    responses: () => seen.filter((e): e is ModelResponseEvent => e.kind === "model_response"),
  };
}

function armLines(root: string): Record<string, unknown>[] {
  return readFileSync(join(root, "routing", "arms.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const NOW = () => 1_700_000_000_000;

/** Seed `n` judged observations on an arm (reward r, quality q). */
function seed(
  sb: ReturnType<typeof openScoreboard>,
  key: string,
  arm: string,
  n: number,
  reward: number,
  quality: number,
): void {
  for (let i = 0; i < n; i++)
    sb.record(key, arm, reward, { success: true, latencyMs: 100, quality });
}

describe("arm identity and v:2 provenance (§7.9)", () => {
  test("a profiled candidate records under its PROFILE name with pv / h / pf; an unprofiled one under the model string with pv / h", async () => {
    const root = freshRoot();
    const { runContext, routes } = watch();
    await runChatLoop({
      model: SONNET,
      instructions: "test",
      sessionName: "helpdesk",
      _adapter: okAdapter("primary"),
      modelPool: { candidates: PROFILED, policy: "heuristic" },
      _poolAdapters: new Map([
        [HAIKU, okAdapter("cheap")],
        [OPUS, okAdapter("strong")],
      ]),
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hello" }],
    });
    const route = routes()[0];
    expect(route).toMatchObject({ model: OPUS, profile: "strong", routeKey: "hard" });
    const [line] = armLines(root);
    expect(line).toMatchObject({
      v: 2,
      k: "hard",
      m: "strong",
      s: 1,
      pv: route?.policyVersion,
      h: "helpdesk",
    });
    expect(typeof line?.["pf"]).toBe("string");
    expect("sc" in (line ?? {})).toBe(false); // unscoped pool → no scope stamp

    // The same run with bare candidates: arm = model string, no lineage stamp.
    const root2 = freshRoot();
    await runChatLoop({
      model: SONNET,
      instructions: "test",
      sessionName: "helpdesk",
      _adapter: okAdapter("primary"),
      modelPool: {
        candidates: [
          { model: HAIKU, tags: ["cheap"] },
          { model: OPUS, tags: ["strong"] },
        ],
        policy: "heuristic",
      },
      _poolAdapters: new Map([
        [HAIKU, okAdapter("cheap")],
        [OPUS, okAdapter("strong")],
      ]),
      runContext: createRunContext(),
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hello" }],
    });
    const [bare] = armLines(root2);
    expect(bare).toMatchObject({ v: 2, k: "hard", m: OPUS, h: "helpdesk" });
    expect("pf" in (bare ?? {})).toBe(false);
  });

  test("reset_on_profile_change: a profile edit under the same arm id stamps a NEW lineage, so the old lines are skipped on load", async () => {
    const root = freshRoot();
    const run = async (maxTokens: number): Promise<void> => {
      await runChatLoop({
        model: SONNET,
        instructions: "test",
        _adapter: okAdapter("primary"),
        modelPool: {
          candidates: [
            { model: HAIKU, tags: ["cheap"], profile: "fast" },
            { model: OPUS, tags: ["strong"], profile: "strong", maxTokens },
          ],
          policy: "heuristic",
        },
        _poolAdapters: new Map([
          [HAIKU, okAdapter("cheap")],
          [OPUS, okAdapter("strong")],
        ]),
        runContext: createRunContext(),
        singleTurn: true,
        seedMessages: [{ role: "user", content: "hello" }],
      });
    };
    await run(1000);
    await run(1000);
    await run(2000); // the profile changed under arm id `strong`
    const lines = armLines(root).filter((l) => l["m"] === "strong");
    expect(lines).toHaveLength(3);
    const pfs = lines.map((l) => l["pf"]);
    expect(pfs[0]).toBe(pfs[1]);
    expect(pfs[2]).not.toBe(pfs[0]);
    // A store opened under the NEW lineage (what the third run's runtime did)
    // folds only the third line; under the old one only the first two.
    expect(
      openScoreboard(root, { lineage: { strong: pfs[2] as string } }).score("hard", "strong")?.n,
    ).toBe(1);
    expect(
      openScoreboard(root, { lineage: { strong: pfs[0] as string } }).score("hard", "strong")?.n,
    ).toBe(2);
    // `resetOnProfileChange: false` keeps everything.
    expect(
      openScoreboard(root, {
        lineage: { strong: pfs[2] as string },
        resetOnProfileChange: false,
      }).score("hard", "strong")?.n,
    ).toBe(3);
  });
});

describe("scoped route keys (§7.9)", () => {
  test("a scoped pool keys <scope>/<band>, stamps sc on the line, and the shadow-free store reads back under that key", async () => {
    const root = freshRoot();
    const { runContext, routes } = watch();
    await runChatLoop({
      model: SONNET,
      instructions: "test",
      sessionName: "flow",
      _adapter: okAdapter("primary"),
      modelPool: { candidates: PROFILED, policy: "heuristic", scope: "triage" },
      _poolAdapters: new Map([
        [HAIKU, okAdapter("cheap")],
        [OPUS, okAdapter("strong")],
      ]),
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hello" }],
    });
    expect(routes()[0]).toMatchObject({ routeKey: "triage/hard", scope: "triage", model: OPUS });
    expect(armLines(root)[0]).toMatchObject({ k: "triage/hard", m: "strong", sc: "triage" });
    expect(openScoreboard(root).score("triage/hard", "strong")?.n).toBe(1);
  });

  test("learned: a cold scoped arm backs off to the warmed unscoped band arm (exploits, records under the scoped key)", async () => {
    const root = freshRoot();
    const sb = openScoreboard(root, { now: NOW });
    // Pre-scope history: the unscoped `hard` arms have cleared warm-up and
    // say the cheap arm is best.
    seed(sb, "hard", "fast", 30, 0.9, 0.9);
    seed(sb, "hard", "strong", 30, 0.4, 0.9);
    const { runContext, routes } = watch();
    await runChatLoop({
      model: SONNET,
      instructions: "test",
      _adapter: okAdapter("primary"),
      modelPool: { candidates: PROFILED, policy: "learned", scope: "triage" },
      _poolAdapters: new Map([
        [HAIKU, okAdapter("cheap")],
        [OPUS, okAdapter("strong")],
      ]),
      _scoreboard: sb,
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hello" }],
    });
    const route = routes()[0];
    expect(route).toMatchObject({
      routeKey: "triage/hard",
      model: HAIKU,
      policy: "learned",
      backedOffTo: "hard",
    });
    expect(route?.explored).toBeUndefined(); // exploited, not explored
    expect(route?.reason).toContain("best arm");
    // Recorded under the SCOPED key; the unscoped arm is untouched.
    expect(sb.score("triage/hard", "fast")?.n).toBe(1);
    expect(sb.score("hard", "fast")?.n).toBe(30);
  });
});

describe("the floor and route freeze (§7.10, §10.1 — acceptance item 7)", () => {
  const POOL = {
    candidates: PROFILED,
    policy: "learned" as const,
    reward: { floor: { arm: "strong", confidence: 0.9, tolerance: 0.02 } },
  };
  const adapters = () =>
    new Map([
      [HAIKU, okAdapter("cheap")],
      [OPUS, okAdapter("strong")],
    ]);

  test("fast's judged LCB (mean 0.85, n=30 → ≈0.71) sits under strong's mean 0.86 − 0.02 → strong serves, reason 'floor-blocked' verbatim", async () => {
    const root = freshRoot();
    const sb = openScoreboard(root, { now: NOW });
    // fast has the better REWARD (cheaper) — without the floor it would be exploited.
    seed(sb, "hard", "fast", 30, 0.9, 0.85);
    seed(sb, "hard", "strong", 30, 0.5, 0.86);
    const { runContext, routes } = watch();
    const text = await runChatLoop({
      model: SONNET,
      instructions: "test",
      _adapter: okAdapter("primary"),
      modelPool: POOL,
      _poolAdapters: adapters(),
      _scoreboard: sb,
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hello" }],
    });
    expect(text).toBe("strong");
    const route = routes()[0];
    expect(route).toMatchObject({
      model: OPUS,
      policy: "learned",
      reason: FLOOR_BLOCKED_ROUTE_REASON,
      floor: { arm: "strong", status: "blocked", blocked: ["fast"] },
    });
    expect(route?.reason).toBe("floor-blocked");
    // What the alert watchdog / SLO monitor (PR 18) key floor_block_rate on.
    expect(isFloorBlockedRoute(route as ModelRouteEvent)).toBe(true);
    // The persisted line carries the same reason verbatim.
    const persisted = readFileSync(join(root, "sessions", `${runContext.sessionId}.jsonl`), "utf8")
      .split("\n")
      .filter((l) => l.includes('"model_route"'))
      .map((l) => JSON.parse(l) as { payload: { reason: string; floor?: unknown } });
    expect(persisted[0]?.payload.reason).toBe("floor-blocked");
    expect(persisted[0]?.payload.floor).toEqual({
      arm: "strong",
      status: "blocked",
      blocked: ["fast"],
    });
  });

  test("after the stub improves (mean 0.95 over 60 samples) fast is exploitable again", async () => {
    const root = freshRoot();
    const sb = openScoreboard(root, { now: NOW });
    seed(sb, "hard", "fast", 60, 0.9, 0.95);
    seed(sb, "hard", "strong", 30, 0.5, 0.86);
    const { runContext, routes } = watch();
    const text = await runChatLoop({
      model: SONNET,
      instructions: "test",
      _adapter: okAdapter("primary"),
      modelPool: POOL,
      _poolAdapters: adapters(),
      _scoreboard: sb,
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hello" }],
    });
    expect(text).toBe("cheap");
    expect(routes()[0]).toMatchObject({
      model: HAIKU,
      policy: "learned",
      floor: { arm: "strong", status: "ok" },
    });
    expect(routes()[0]?.reason).toContain("best arm");
  });

  test("route freeze pins the policyVersion: decisions report the frozen version and no observation is recorded", async () => {
    const root = freshRoot();
    const sb = openScoreboard(root, { now: NOW });
    seed(sb, "hard", "fast", 60, 0.9, 0.95);
    seed(sb, "hard", "strong", 30, 0.5, 0.86);
    // Learn what the live policyVersion is first.
    const before = watch();
    await runChatLoop({
      model: SONNET,
      instructions: "test",
      _adapter: okAdapter("primary"),
      modelPool: POOL,
      _poolAdapters: adapters(),
      _scoreboard: sb,
      runContext: before.runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hello" }],
    });
    const livePv = before.routes()[0]?.policyVersion;
    expect(livePv).toMatch(/^pool-/);
    expect(sb.score("hard", "fast")?.n).toBe(61);

    writeRouteFreeze(root, { policyVersion: "pool-frozen-0001", reason: "incident", now: NOW });
    const { runContext, routes } = watch();
    const text = await runChatLoop({
      model: SONNET,
      instructions: "test",
      _adapter: okAdapter("primary"),
      modelPool: POOL,
      _poolAdapters: adapters(),
      _scoreboard: sb,
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hello" }],
    });
    expect(text).toBe("cheap"); // routes off the frozen history
    expect(routes()[0]?.policyVersion).toBe("pool-frozen-0001");
    expect(routes()[0]?.policyVersion).not.toBe(livePv);
    // Nothing new was folded — the arm is exactly where the freeze found it.
    expect(sb.score("hard", "fast")?.n).toBe(61);
    expect(armLines(root)).toHaveLength(91);
  });
});

describe("eval-seeded priors (§7.11 N2)", () => {
  const POOL = { candidates: PROFILED, policy: "learned" as const };
  const adapters = () =>
    new Map([
      [HAIKU, okAdapter("cheap")],
      [OPUS, okAdapter("strong")],
    ]);
  const run = async (root: string, priors: "eval" | undefined) => {
    const sb = openScoreboard(root, { now: NOW });
    const { runContext, routes } = watch();
    await runChatLoop({
      model: SONNET,
      instructions: "test",
      _adapter: okAdapter("primary"),
      modelPool: { ...POOL, ...(priors !== undefined ? { reward: { priors } } : {}) },
      _poolAdapters: adapters(),
      _scoreboard: sb,
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hello" }],
    });
    return routes()[0];
  };

  test("a matching priors.json seeds the arms: warm-up is skipped and policyVersion changes", async () => {
    const cold = await run(freshRoot(), undefined);
    expect(cold?.explored).toBe(true); // an empty scoreboard explores first

    const root = freshRoot();
    mkdirSync(join(root, "routing"), { recursive: true });
    writeFileSync(
      join(root, "routing", "priors.json"),
      JSON.stringify({
        version: 1,
        fingerprint: priorsFingerprint(POOL.candidates),
        arms: [
          { routeKey: "hard", arm: "fast", n: 10, meanReward: 0.3 },
          { routeKey: "hard", arm: "strong", n: 10, meanReward: 0.8 },
        ],
      }),
    );
    const seeded = await run(root, "eval");
    expect(seeded).toMatchObject({ model: OPUS, policy: "learned" });
    expect(seeded?.explored).toBeUndefined(); // exploited on the prior, no warm-up
    expect(seeded?.reason).toContain("best arm meanReward=0.800 (n=10)");
    expect(seeded?.policyVersion).not.toBe(cold?.policyVersion);
    // Declaring `priors: eval` without a file changes nothing but a warning.
    const noFile = await run(freshRoot(), "eval");
    expect(noFile?.explored).toBe(true);
  });

  test("a priors file for a different roster is ignored: cold warm-up, unchanged policyVersion", async () => {
    const root = freshRoot();
    mkdirSync(join(root, "routing"), { recursive: true });
    writeFileSync(
      join(root, "routing", "priors.json"),
      JSON.stringify({
        version: 1,
        fingerprint: priorsFingerprint([{ model: "somebody/else", tags: [] }]),
        arms: [{ routeKey: "hard", arm: "strong", n: 10, meanReward: 0.8 }],
      }),
    );
    const stale = await run(root, "eval");
    expect(stale?.explored).toBe(true);
    const noFile = await run(freshRoot(), "eval");
    expect(stale?.policyVersion).toBe(noFile?.policyVersion);
  });
});

describe("per-candidate breakers and chains (§4.4)", () => {
  test("a candidate whose breaker opened is ineligible for the rest of the turn: the escalation lands on the eligible arm", async () => {
    const root = freshRoot();
    const strong = failingAdapter(() => true);
    const cheap = okAdapter("cheap rescued the turn");
    const { runContext, routes } = watch();
    const text = await runChatLoop({
      model: SONNET,
      instructions: "test",
      _adapter: okAdapter("primary"),
      modelPool: {
        candidates: [
          { model: HAIKU, tags: ["cheap"], profile: "fast" },
          // Trips on the first failure.
          {
            model: OPUS,
            tags: ["strong"],
            profile: "strong",
            circuitBreaker: { failureThreshold: 1 },
          },
        ],
        policy: "heuristic",
      },
      _poolAdapters: new Map<string, ProviderAdapter>([
        [HAIKU, cheap],
        [OPUS, strong],
      ]),
      _scoreboard: openScoreboard(root, { now: NOW }),
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hello" }],
    });
    expect(text).toBe("cheap rescued the turn");
    const [first, second] = routes();
    expect(first).toMatchObject({ model: OPUS, policy: "heuristic" }); // hard turn → strong
    expect(strong.requests).toHaveLength(1);
    // The retry: strong's breaker is open → excluded (`breaker-open`), cheap serves.
    expect(second?.model).toBe(HAIKU);
    expect(second?.eligible).toEqual(["fast"]);
    expect(second?.reason).toContain("strong ineligible (breaker-open)");
    expect(cheap.requests).toHaveLength(1);
  });

  test("a candidate with fallbacks serves through its own chain: the served MEMBER is on model_response, the ARM stays the profile", async () => {
    const root = freshRoot();
    const opus = failingAdapter(() => true); // the profile's primary is down
    const sonnet = okAdapter("sonnet served for strong");
    const { runContext, routes, responses } = watch();
    const text = await runChatLoop({
      model: HAIKU,
      instructions: "test",
      _adapter: okAdapter("primary"),
      modelPool: {
        candidates: [
          { model: HAIKU, tags: ["cheap"], profile: "fast" },
          {
            model: OPUS,
            tags: ["strong"],
            profile: "strong",
            fallbacks: [SONNET],
            circuitBreaker: { failureThreshold: 1 },
          },
        ],
        policy: "heuristic",
      },
      _poolAdapters: new Map<string, ProviderAdapter>([
        [HAIKU, okAdapter("cheap")],
        [OPUS, opus],
        [SONNET, sonnet],
      ]),
      _scoreboard: openScoreboard(root, { now: NOW }),
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hello" }],
    });
    expect(text).toBe("sonnet served for strong");
    // Two routes: the failed OPUS member, then the chain's failover to SONNET
    // on the retry (the chain member's breaker tripped, the CANDIDATE stays
    // eligible because a member can still serve).
    expect(routes().map((r) => r.model)).toEqual([OPUS, OPUS]);
    expect(routes()[1]?.profile).toBe("strong");
    expect(opus.requests).toHaveLength(1);
    expect(sonnet.requests).toHaveLength(1);
    // Attribution names the member that served, never the profile's primary
    // (`specModel` is omitted because the member's spec string IS its wire id).
    const resp = responses()[0];
    expect(resp?.model).toBe(SONNET);
    expect(resp?.specModel).toBeUndefined();
    expect(resp?.provider).toBe("anthropic");
    // …while the scoreboard arm is still the profile.
    const lines = armLines(root);
    expect(lines.map((l) => l["m"])).toEqual(["strong", "strong"]);
    expect(lines[0]?.["s"]).toBe(0);
    expect(lines[1]?.["s"]).toBe(1);
  });
});
