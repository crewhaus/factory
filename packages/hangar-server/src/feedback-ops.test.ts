/**
 * The growth loops' rules, each pinned by the failure it prevents:
 *
 *   - the distill WATERMARK travels with the unprocessed count ("N new
 *     ratings" without the timestamp it counts from is a guess);
 *   - reading ratings never evicts a transcript (raw JSONL, never a store
 *     `list()`), and free text is masked;
 *   - "Distill now" RUNS the verb — it does not pretend to toggle
 *     `autoDistill`, which the shipped runtime honours only from the CLI;
 *   - channel reactions carry their PRECONDITION: a `thread` sessionKey
 *     collects nothing, and the panel says so;
 *   - the advice feed is advisory, tiers each proposal, and refuses to write
 *     a human-owned path — routing it to `crewhaus propose` instead.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionKeyOf, tierFor } from "./feedback-ops";
import { feedbackRecord, logLine, makeFixtureHarness } from "./fixture";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const DAY = 86_400_000;

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});

function boot(): TestServer {
  const t = bootTestServer({ now: () => NOW });
  servers.push(t);
  return t;
}

async function register(t: TestServer, dir: string): Promise<string> {
  const { body } = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
  return (body["entry"] as { id: string }).id;
}

function write(dir: string, relative: readonly string[], body: string): void {
  const path = join(dir, ...relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

/** A harness with ratings in both sinks, a distill watermark, a few-shot
 *  pool, a generated FAQ skill, lessons, and an advice feed carrying one
 *  auto-tunable and one human-owned proposal. */
function loopHarness(t: TestServer, specExtra?: string): string {
  const dir = makeFixtureHarness(join(t.harnessesRoot, "loop"), {
    specName: "loop",
    sessions: [
      {
        id: "sess_00000000000000aa",
        updatedAt: iso(NOW - DAY),
        log: [
          logLine("user_message", { content: "hello" }, iso(NOW - DAY)),
          logLine(
            "user_feedback",
            feedbackRecord("sess_00000000000000aa", 1, "up", iso(NOW - DAY)),
            iso(NOW - DAY),
          ),
        ],
      },
    ],
    feedback: {
      web: [
        feedbackRecord("sess_00000000000000ab", 1, "down", iso(NOW - 3 * DAY)),
        feedbackRecord("sess_00000000000000ac", 2, "up", iso(NOW - 1 * DAY)),
      ],
    },
  });
  // A spec that ROUND-TRIPS through `@crewhaus/spec-patch`. The shared
  // fixture writes `instructions:` at the document root, which `parseSpec`
  // rejects for a cli target — so any handler that re-validates an edited
  // spec (advice apply, and every spec write) cannot be exercised against
  // the default fixture spec at all. This one nests it under `agent:`.
  write(
    dir,
    ["crewhaus.yaml"],
    [
      "name: loop",
      "target: cli",
      "agent:",
      "  model: anthropic/claude-sonnet-4",
      "  instructions: |",
      "    You are a fixture. Answer briefly.",
      ...(specExtra !== undefined ? [specExtra] : []),
      "",
    ].join("\n"),
  );
  write(
    dir,
    [".crewhaus", "feedback", ".distill-state.json"],
    `${JSON.stringify({
      schemaVersion: 1,
      lastProcessedTs: iso(NOW - 2 * DAY),
      processedCount: 1,
    })}\n`,
  );
  write(
    dir,
    [".crewhaus", "fewshot", "loop.jsonl"],
    `${JSON.stringify({
      input: "how do I deploy",
      expected_output: "run crewhaus deploy",
      metadata: { source: "harvested", user_rating: 1 },
    })}\n`,
  );
  write(dir, [".crewhaus", "skills", "faq", "SKILL.md"], "# FAQ\n- how do I deploy?\n");
  write(dir, ["LESSONS.md"], "# Lessons\n<!-- crewhaus:lessons -->\n- prefer short answers\n");
  write(dir, [".crewhaus", "preferences", "max.md"], "- answers in bullet points\n");
  write(
    dir,
    [".crewhaus", "advice", "suggestions.json"],
    `${JSON.stringify({
      generatedAt: iso(NOW - DAY),
      sessionIds: ["sess_00000000000000aa"],
      suggestions: [
        {
          findingId: "adv_instructions",
          severity: "warn",
          summary: "the agent repeats itself on follow-ups",
          patch: {
            target: "cli",
            path: ["agent", "instructions"],
            op: "replace",
            value: "You are a fixture. Answer briefly and never repeat yourself.",
            rationale: "observed repetition across 3 sessions",
          },
        },
        {
          findingId: "adv_model",
          severity: "info",
          summary: "a cheaper model would do",
          patch: {
            target: "cli",
            path: ["agent", "model"],
            op: "replace",
            value: "anthropic/claude-haiku-4",
            rationale: "the roster is human-owned",
          },
        },
      ],
    })}\n`,
  );
  return dir;
}

describe("pure feedback rules", () => {
  test("the optimizable tier is the same prefix rule the spec write path enforces", () => {
    expect(tierFor("cli", ["agent", "instructions"])).toBe("auto-tunable");
    // The model ROSTER is human-owned: learning tunes selection within the
    // declared set, never the set.
    expect(tierFor("cli", ["agent", "model"])).toBe("human-owned");
    expect(tierFor("cli", ["permissions", "allow"])).toBe("human-owned");
    expect(tierFor("not-a-target", ["agent", "instructions"])).toBe("human-owned");
  });

  test("the sessionKey scan is lenient — a spec a version ahead still renders", () => {
    expect(sessionKeyOf("channels:\n  slack:\n    sessionKey: thread\n")).toBe("thread");
    expect(sessionKeyOf('channels:\n  slack:\n    sessionKey: "user"  \n')).toBe("user");
    expect(sessionKeyOf("agent:\n  model: m\n")).toBeNull();
  });
});

describe("the ratings browser", () => {
  test("folds both sinks and reports the watermark beside the unprocessed count", async () => {
    const t = boot();
    const id = await register(t, loopHarness(t));
    const { status, body } = await t.api(`/api/h/${id}/feedback`);
    expect(status).toBe(200);
    const items = body["items"] as Array<{
      sessionId: string;
      turnNumber: number;
      unprocessed: boolean;
    }>;
    // Two bare records + one in-transcript rating.
    expect(items.length).toBe(3);
    expect(items.map((i) => i.sessionId)).toContain("sess_00000000000000aa");
    // Turn ordinals survive, so a rating can deep-link back to its turn.
    expect(items.every((i) => typeof i.turnNumber === "number")).toBe(true);

    const watermark = body["watermark"] as {
      present: boolean;
      lastProcessedTs: string;
      unprocessed: number;
    };
    expect(watermark.present).toBe(true);
    expect(watermark.lastProcessedTs).toBe(iso(NOW - 2 * DAY));
    // Only the two records newer than the watermark are unprocessed.
    expect(watermark.unprocessed).toBe(2);
    expect((body["balance"] as { total: number }).total).toBe(3);
  });

  test("reading the ratings never evicts a transcript", async () => {
    const t = boot();
    const dir = loopHarness(t);
    const transcript = join(dir, ".crewhaus", "sessions", "sess_00000000000000aa.jsonl");
    const before = readFileSync(transcript, "utf8");
    const id = await register(t, dir);
    await t.api(`/api/h/${id}/feedback`);
    await t.api(`/api/h/${id}/feedback`);
    expect(readFileSync(transcript, "utf8")).toBe(before);
  });

  test("free text in a rating is masked", async () => {
    const t = boot();
    const dir = loopHarness(t);
    const leaked = ["xox", "b-", "1234567890", "-abcdefghij"].join("");
    write(
      dir,
      [".crewhaus", "feedback", "leak.jsonl"],
      `${JSON.stringify({
        schemaVersion: 1,
        id: "fb_leak",
        sessionId: "sess_00000000000000ad",
        turnNumber: 1,
        modality: "comment",
        rating: {},
        comment: `the bot echoed ${leaked} back at me`,
        source: "ui",
        ts: iso(NOW),
      })}\n`,
    );
    const id = await register(t, dir);
    const { body } = await t.api(`/api/h/${id}/feedback`);
    const comments = (body["items"] as Array<{ comment: string }>).map((i) => i.comment).join(" ");
    expect(comments).not.toContain(leaked);
    expect(comments).toContain("***");
  });

  test("'Distill now' runs the verb and says it is not toggling autoDistill", async () => {
    const t = boot();
    const id = await register(t, loopHarness(t));
    const plain = await t.api(`/api/h/${id}/feedback/distill`, { method: "POST", body: "{}" });
    expect(plain.body["argv"]).toEqual(["distill"]);
    expect(plain.body["registers"]).toBe(false);
    expect(String(plain.body["runtimeNote"])).toContain("autoDistill");

    const promoted = await t.api(`/api/h/${id}/feedback/distill`, {
      method: "POST",
      body: JSON.stringify({ judge: true, register: true }),
    });
    expect(promoted.body["argv"]).toEqual(["distill", "--judge", "--register"]);
    expect(String(promoted.body["note"])).toContain("loop-ratings");
  });
});

describe("the growers", () => {
  test("the few-shot pool shows which file the spec actually injects", async () => {
    const t = boot();
    const id = await register(t, loopHarness(t));
    const { body } = await t.api(`/api/h/${id}/feedback/fewshot`);
    const entries = body["entries"] as Array<{ file: string; inUse: boolean; output: string }>;
    expect(entries.length).toBe(1);
    expect(entries[0]?.inUse).toBe(true);
    expect(body["poolForSpec"]).toBe("loop.jsonl");
  });

  test("harvest previews before it adds examples the agent will imitate", async () => {
    const t = boot();
    const id = await register(t, loopHarness(t));
    const preview = await t.api(`/api/h/${id}/feedback/fewshot`, { method: "POST", body: "{}" });
    expect(preview.body["preview"]).toBe(true);
    expect(preview.body["job"]).toBeUndefined();
    expect(preview.body["currentPoolSize"]).toBe(1);

    const run = await t.api(`/api/h/${id}/feedback/fewshot`, {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
    });
    expect(run.body["preview"]).toBe(false);
    expect(run.body["job"]).toBeDefined();
  });

  test("the generated FAQ skill and the lessons files are rendered, not hidden", async () => {
    const t = boot();
    const id = await register(t, loopHarness(t));
    const faq = await t.api(`/api/h/${id}/feedback/faq`);
    expect(faq.body["present"]).toBe(true);
    expect(String(faq.body["skill"])).toContain("how do I deploy?");

    const lessons = await t.api(`/api/h/${id}/feedback/lessons`);
    expect(String(lessons.body["lessons"])).toContain("prefer short answers");
    const prefs = lessons.body["preferences"] as Array<{ user: string; body: string }>;
    expect(prefs[0]?.user).toBe("max");
    expect(prefs[0]?.body).toContain("bullet points");
  });
});

describe("the advisory feed", () => {
  test("tiers each proposal so the cost of applying is visible before the click", async () => {
    const t = boot();
    const id = await register(t, loopHarness(t));
    const { body } = await t.api(`/api/h/${id}/feedback/advice`);
    expect(body["advisory"]).toBe(true);
    const proposals = body["proposals"] as Array<{ adviceId: string; tier: string }>;
    expect(proposals.find((p) => p.adviceId === "adv_instructions")?.tier).toBe("auto-tunable");
    expect(proposals.find((p) => p.adviceId === "adv_model")?.tier).toBe("human-owned");
  });

  test("applying previews first, then writes through the patch library", async () => {
    const t = boot();
    const dir = loopHarness(t);
    const id = await register(t, dir);
    const preview = await t.api(`/api/h/${id}/feedback/advice/adv_instructions/apply`, {
      method: "POST",
      body: "{}",
    });
    expect(preview.body["applied"]).toBe(false);
    expect((preview.body["diff"] as unknown[]).length).toBeGreaterThan(0);
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).not.toContain("never repeat yourself");

    const applied = await t.api(`/api/h/${id}/feedback/advice/adv_instructions/apply`, {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
    });
    expect(applied.body["applied"]).toBe(true);
    const after = readFileSync(join(dir, "crewhaus.yaml"), "utf8");
    expect(after).toContain("never repeat yourself");
    // Comment/key order preserved: this went through the CST, not a template.
    expect(after).toContain("name: loop");
  });

  test("a human-owned path is refused with the diff and the propose route named", async () => {
    const t = boot();
    const dir = loopHarness(t);
    const id = await register(t, dir);
    const before = readFileSync(join(dir, "crewhaus.yaml"), "utf8");
    const { status, body } = await t.api(`/api/h/${id}/feedback/advice/adv_model/apply`, {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
    });
    expect(status).toBe(409);
    const refusal = JSON.parse(String(body["error"])) as { route: string; diff: unknown[] };
    expect(refusal.route).toBe("crewhaus propose");
    expect(refusal.diff.length).toBeGreaterThan(0);
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(before);
  });

  test("a proposal that is no longer in the feed refuses without erroring", async () => {
    const t = boot();
    const id = await register(t, loopHarness(t));
    const { status, body } = await t.api(`/api/h/${id}/feedback/advice/adv_gone/apply`, {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
    });
    expect(status).toBe(200);
    expect(body["applied"]).toBe(false);
    expect(body["present"]).toBe(false);
  });
});

describe("channel reactions", () => {
  test("a thread sessionKey is reported as collecting NOTHING, with the reason", async () => {
    const t = boot();
    const dir = loopHarness(
      t,
      ["feedback:", "  capture: true", "channels:", "  slack:", "    sessionKey: thread"].join(
        "\n",
      ),
    );
    const id = await register(t, dir);
    const { body } = await t.api(`/api/h/${id}/feedback/reactions`);
    expect(body["declared"]).toBe(true);
    expect(body["sessionKeyMode"]).toBe("thread");
    expect(body["collecting"]).toBe(false);
    expect(String(body["caveat"])).toContain("collect NOTHING");
  });

  test("a channel sessionKey collects, and the caveat clears", async () => {
    const t = boot();
    const dir = loopHarness(
      t,
      ["feedback:", "  capture: true", "channels:", "  slack:", "    sessionKey: channel"].join(
        "\n",
      ),
    );
    const id = await register(t, dir);
    const { body } = await t.api(`/api/h/${id}/feedback/reactions`);
    expect(body["collecting"]).toBe(true);
    expect(body["caveat"]).toBeNull();
  });
});

describe("the fleet rollup", () => {
  test("answers who is distill-ready without opening a transcript", async () => {
    const t = boot();
    await register(t, loopHarness(t));
    const { status, body } = await t.api("/api/feedback");
    expect(status).toBe(200);
    const rows = body["harnesses"] as Array<{
      specName: string;
      total: number;
      unprocessed: number;
      watermarkTs: string;
    }>;
    const loop = rows.find((r) => r.specName === "loop") as (typeof rows)[number];
    // The sink half only — the in-transcript rating is counted on the
    // harness's own tab, and this screen says exactly that.
    expect(loop.total).toBe(2);
    expect(loop.unprocessed).toBe(1);
    expect(loop.watermarkTs).toBe(iso(NOW - 2 * DAY));
    expect(String(body["scope"])).toContain("transcripts are not opened");
  });
});
