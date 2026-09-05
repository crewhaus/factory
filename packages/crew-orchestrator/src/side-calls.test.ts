/**
 * 0.6.0 PR 9d — a crew ROLE is a single-turn host: its pool's `strategy`
 * side calls (guide / shadow / committee) are wired at every activation by
 * `composeSideCalls` and spread at both role call sites. Driven end to end
 * over `Crew().run` with scripted adapters: a committee role's primary
 * adapter never streams — the members and the judge decide the role's text.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@crewhaus/adapter-anthropic";
import { Crew, type CrewEvent, type RoleDefinition, composeSideCalls } from "./index.js";

const HAIKU = "claude-haiku-4-5";
const OPUS = "claude-opus-4-8";

function textAdapter(text: string): ProviderAdapter & { calls: () => number } {
  let n = 0;
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    calls: () => n,
    stream(_req: ProviderRequest): AsyncIterable<StreamEvent> {
      n += 1;
      return (async function* () {
        yield { kind: "message_start", usage: { input: 10, output: 0 } };
        yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
        yield { kind: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "end_turn", usage: { input: 10, output: 5 } };
        yield { kind: "message_stop" };
      })();
    },
  };
}

/** A selection judge that picks the response containing `needle`. */
function selectJudge(needle: string): ProviderAdapter {
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
      const userMsg = req.messages.find((m) => m.role === "user");
      const userText =
        typeof userMsg?.content === "string"
          ? userMsg.content
          : (userMsg?.content
              ?.filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text)
              .join("\n") ?? "");
      const m = [
        ...userText.matchAll(/Response (\d+) <<<UNTRUSTED_[0-9a-f]+>>>\n([\s\S]*?)\n<<<END_/g),
      ];
      const hit = m.find((x) => (x[2] ?? "").includes(needle));
      const verdict = { winner: hit?.[1] ?? "1", rationale: "picked" };
      return (async function* () {
        yield { kind: "message_start", usage: { input: 20, output: 0 } };
        yield {
          kind: "content_block_start",
          index: 0,
          block: { type: "tool_use", id: "tu", name: "submit_selection", input: {} },
        };
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(verdict) },
        };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "tool_use", usage: { input: 20, output: 5 } };
        yield { kind: "message_stop" };
      })();
    },
  };
}

async function collect(iter: AsyncIterable<CrewEvent>): Promise<CrewEvent[]> {
  const out: CrewEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

const COMMITTEE_POOL: NonNullable<RoleDefinition["modelPool"]> = {
  candidates: [
    { model: HAIKU, tags: ["cheap"] },
    { model: OPUS, tags: ["strong"] },
  ],
  policy: "heuristic",
  strategy: { committee: { members: ["cheap", "strong"], judge: OPUS } },
};

describe("composeSideCalls (0.6.0 PR 9d)", () => {
  test("spread-return-{} without a side-call strategy; a committee yields the closure over the role-scoped pool", () => {
    expect(composeSideCalls({ model: "m", instructions: "i" }, {}, "solo", "c")).toEqual({});
    expect(
      composeSideCalls(
        { model: "m", instructions: "i", modelPool: { ...COMMITTEE_POOL, strategy: undefined } },
        {},
        "solo",
        "c",
      ),
    ).toEqual({});
    const wired = composeSideCalls(
      { model: "m", instructions: "i", modelPool: COMMITTEE_POOL },
      { _judgeAdapter: selectJudge("x") },
      "solo",
      "c",
    );
    expect(Object.keys(wired)).toEqual(["sideCalls"]);
    expect(wired.sideCalls?.committee?.members.map((m) => m.modelString)).toEqual([HAIKU, OPUS]);
    expect(wired.sideCalls?.committee?.judge).toBe(OPUS);
  });

  test("end to end: a committee role's text is the judged member's; the role's primary adapter never streams", async () => {
    const root = mkdtempSync(join(tmpdir(), "crewhaus-crew-committee-"));
    try {
      const primary = textAdapter("primary must not serve");
      const cheap = textAdapter("cheap member");
      const strong = textAdapter("strong member, because");
      const crew = Crew()
        .setName("committee-solo")
        .addRole("solo", {
          model: "claude-sonnet-4-6",
          instructions: "Solo.",
          modelPool: COMMITTEE_POOL,
        })
        .setEntry("solo")
        .compile();
      const events = await collect(
        crew.run("decide", {
          sessionRootDir: root,
          _adapter: primary,
          _poolAdapters: new Map([
            [HAIKU, cheap],
            [OPUS, strong],
          ]),
          _judgeAdapter: selectJudge("because"),
          maxActivations: 1,
        }),
      );
      const done = events[events.length - 1];
      expect(done?.kind).toBe("crew_done");
      if (done?.kind !== "crew_done") throw new Error("crew_done missing");
      expect(done.finalOutput).toBe("strong member, because");
      expect(primary.calls()).toBe(0);
      expect(cheap.calls()).toBe(1);
      expect(strong.calls()).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
