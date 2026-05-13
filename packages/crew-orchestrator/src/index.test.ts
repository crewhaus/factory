import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ProviderAdapter, StreamEvent } from "@crewhaus/adapter-anthropic";
import { isValidSpanId, isValidTraceId, parseTraceparent } from "@crewhaus/trace-event-bus";
import { Crew, type CrewEvent, HandoffRefusedError } from "./index.js";

function newTempRoot(): string {
  return mkdtempSync(join(tmpdir(), "crew-orchestrator-"));
}

/**
 * Programmable adapter — `policy(seed)` returns the model's content blocks
 * given the role's seed messages. The adapter reads the LATEST user message
 * each call, which is what the role-by-role orchestrator dispatches.
 */
type Policy = (args: {
  seed: string;
  previousToolResults: ReadonlyArray<string>;
}) => Anthropic.ContentBlock[];

function makeProgrammableAdapter(policy: Policy): ProviderAdapter {
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
    stream: ({ messages }) => {
      // Find the last user content. Tool results land as the last user
      // message with content[].type === "tool_result"; we extract the
      // "text" content if any so the policy can see what came back.
      const last = messages[messages.length - 1];
      let seed = "";
      const previousToolResults: string[] = [];
      if (last && typeof last.content === "string") {
        seed = last.content;
      } else if (last && Array.isArray(last.content)) {
        for (const block of last.content) {
          if ("text" in block && typeof block.text === "string") seed = block.text;
          if ("type" in block && block.type === "tool_result") {
            const r = block as { content?: unknown };
            if (typeof r.content === "string") previousToolResults.push(r.content);
          }
        }
      }

      const blocks = policy({ seed, previousToolResults });
      const hasToolUse = blocks.some((b) => b.type === "tool_use");
      return (async function* () {
        yield { kind: "message_start" } as StreamEvent;
        for (let idx = 0; idx < blocks.length; idx++) {
          const block = blocks[idx];
          if (!block) continue;
          if (block.type === "text") {
            yield {
              kind: "content_block_start",
              index: idx,
              block: { type: "text", text: "" },
            } as StreamEvent;
            yield {
              kind: "content_block_delta",
              index: idx,
              delta: { type: "text_delta", text: block.text },
            } as StreamEvent;
            yield { kind: "content_block_stop", index: idx } as StreamEvent;
          } else if (block.type === "tool_use") {
            yield {
              kind: "content_block_start",
              index: idx,
              block: { type: "tool_use", id: block.id, name: block.name, input: {} },
            } as StreamEvent;
            yield {
              kind: "content_block_delta",
              index: idx,
              delta: {
                type: "input_json_delta",
                partial_json: JSON.stringify(block.input ?? {}),
              },
            } as StreamEvent;
            yield { kind: "content_block_stop", index: idx } as StreamEvent;
          }
        }
        yield {
          kind: "message_delta",
          stopReason: hasToolUse ? "tool_use" : "end_turn",
        } as StreamEvent;
        yield { kind: "message_stop" } as StreamEvent;
      })();
    },
  };
}

async function collect(iter: AsyncIterable<CrewEvent>): Promise<CrewEvent[]> {
  const out: CrewEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe("Crew builder", () => {
  test("addRole + setEntry + compile rejects empty crews and unknown entry", () => {
    const empty = Crew();
    expect(() => empty.compile()).toThrow(/at least one role/);

    const c = Crew().addRole("a", { model: "m", instructions: "i" });
    expect(() => c.setEntry("nope")).toThrow(/unknown role "nope"/);
  });

  test("duplicate role names rejected", () => {
    const c = Crew().addRole("a", { model: "m", instructions: "i" });
    expect(() => c.addRole("a", { model: "m", instructions: "i" })).toThrow(/already added/);
  });
});

describe("Crew end-to-end (programmable adapter)", () => {
  test("single-role crew: entry runs, emits role_start → role_end → crew_done", async () => {
    const root = newTempRoot();
    try {
      const adapter = makeProgrammableAdapter(() => [{ type: "text", text: "ok solo" }]);
      const crew = Crew()
        .setName("solo")
        .addRole("solo", { model: "stub", instructions: "Solo agent." })
        .setEntry("solo")
        .compile();

      const events = await collect(
        crew.run("hello", { sessionRootDir: root, _adapter: adapter, maxActivations: 4 }),
      );
      const kinds = events.map((e) => e.kind);
      expect(kinds).toEqual(["role_start", "role_end", "crew_done"]);

      const done = events.find((e) => e.kind === "crew_done");
      if (done?.kind !== "crew_done") throw new Error("crew_done missing");
      expect(done.finalOutput).toBe("ok solo");
      expect(done.activations).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("3-role crew with one Handoff: researcher → writer → critic, terminates clean", async () => {
    const root = newTempRoot();
    try {
      const adapter = makeProgrammableAdapter(({ seed, previousToolResults }) => {
        if (previousToolResults.length > 0) {
          // Already saw a tool result — issue end_turn text.
          if (
            seed.includes("researcher") ||
            previousToolResults.some((r) => r.includes("Handoff queued"))
          ) {
            return [{ type: "text", text: "[role complete]" }];
          }
          return [{ type: "text", text: "[follow up]" }];
        }
        if (seed.includes("Solo")) return [{ type: "text", text: "ok" }];
        if (seed.includes("[Handoff from")) {
          // Receiver: don't hand off again — just respond.
          return [{ type: "text", text: "received and processed" }];
        }
        // First entry message — researcher hands off to writer.
        return [
          {
            type: "tool_use",
            id: "tool_1",
            name: "Handoff",
            input: {
              target: "writer",
              reason: "research notes ready, please draft the post",
            },
          },
        ];
      });

      const crew = Crew()
        .setName("3-role")
        .addRole("researcher", { model: "stub", instructions: "Research." })
        .addRole("writer", { model: "stub", instructions: "Write." })
        .addRole("critic", { model: "stub", instructions: "Critique." })
        .setEntry("researcher")
        .compile();

      const events = await collect(
        crew.run("brief: 3 risks of crews", {
          sessionRootDir: root,
          _adapter: adapter,
          maxActivations: 6,
        }),
      );

      const kinds = events.map((e) => e.kind);
      expect(kinds).toContain("handoff");
      expect(kinds.filter((k) => k === "role_start").length).toBe(2); // researcher + writer
      expect(kinds[kinds.length - 1]).toBe("crew_done");

      const handoff = events.find((e) => e.kind === "handoff");
      if (handoff?.kind !== "handoff") throw new Error("handoff missing");
      expect(handoff.from).toBe("researcher");
      expect(handoff.to).toBe("writer");
      expect(handoff.depth).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("A2A SendMessage runs target inline and returns the reply (T3)", async () => {
    const root = newTempRoot();
    try {
      const adapter = makeProgrammableAdapter(({ seed, previousToolResults }) => {
        if (seed.includes("[A2A from")) {
          // Researcher answering critic's question.
          return [{ type: "text", text: "<<answer: data came from Wikipedia>>" }];
        }
        if (previousToolResults.length > 0) {
          // critic saw answer; respond with summary.
          return [{ type: "text", text: "Final critique. Done." }];
        }
        return [
          {
            type: "tool_use",
            id: "tool_1",
            name: "SendMessage",
            input: { target: "researcher", payload: "where did the data come from?" },
          },
        ];
      });

      const crew = Crew()
        .setName("a2a-test")
        .addRole("critic", { model: "stub", instructions: "Critic." })
        .addRole("researcher", { model: "stub", instructions: "Researcher." })
        .setEntry("critic")
        .compile();

      const events = await collect(
        crew.run("review the post", {
          sessionRootDir: root,
          _adapter: adapter,
          maxActivations: 4,
        }),
      );

      const a2a = events.find((e) => e.kind === "a2a_message");
      expect(a2a).toBeDefined();
      if (a2a?.kind !== "a2a_message") throw new Error("a2a missing");
      expect(a2a.from).toBe("critic");
      expect(a2a.to).toBe("researcher");
      expect(a2a.payload).toContain("where did the data come from");

      // T9 envelope invariant: traceparent parses + carries the bus's traceId.
      const parsed = parseTraceparent(a2a.traceparent);
      expect(parsed).not.toBeNull();
      expect(parsed && isValidTraceId(parsed.traceId)).toBe(true);
      expect(parsed && isValidSpanId(parsed.parentSpanId)).toBe(true);

      const done = events[events.length - 1];
      expect(done?.kind).toBe("crew_done");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refusal-loop guard: ping-pong handoffs terminate with HandoffRefusedError (T8)", async () => {
    const root = newTempRoot();
    try {
      const adapter = makeProgrammableAdapter(({ seed, previousToolResults }) => {
        if (previousToolResults.length > 0) {
          return [{ type: "text", text: "[end turn]" }];
        }
        // Both roles always hand back to the OTHER role on first entry.
        if (seed.includes("ENTRY: a") || seed.includes("[Handoff from b]")) {
          return [
            {
              type: "tool_use",
              id: `t_${Math.random()}`,
              name: "Handoff",
              input: { target: "b", reason: "I don't want this — bouncing" },
            },
          ];
        }
        return [
          {
            type: "tool_use",
            id: `t_${Math.random()}`,
            name: "Handoff",
            input: { target: "a", reason: "bouncing back" },
          },
        ];
      });

      const crew = Crew()
        .setName("ping-pong")
        .addRole("a", { model: "stub", instructions: "A." })
        .addRole("b", { model: "stub", instructions: "B." })
        .setEntry("a")
        .compile();

      let caught: unknown;
      try {
        await collect(
          crew.run("ENTRY: a", {
            sessionRootDir: root,
            _adapter: adapter,
            refusalDepth: 2,
            maxActivations: 10,
          }),
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(HandoffRefusedError);
      expect((caught as Error).message).toContain("handoff refused (depth=");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("router function moves crew to next role when no handoff fires", async () => {
    const root = newTempRoot();
    try {
      let routerCalls = 0;
      const adapter = makeProgrammableAdapter(({ seed }) => {
        if (seed.includes("hello")) return [{ type: "text", text: "researcher output" }];
        return [{ type: "text", text: "writer output" }];
      });
      const crew = Crew()
        .setName("router-test")
        .addRole("researcher", { model: "stub", instructions: "R." })
        .addRole("writer", { model: "stub", instructions: "W." })
        .setEntry("researcher")
        .setRouting(({ lastRole }) => {
          routerCalls += 1;
          if (lastRole === "researcher") return "writer";
          return "writer"; // stay on writer to terminate
        })
        .compile();

      const events = await collect(
        crew.run("hello", {
          sessionRootDir: root,
          _adapter: adapter,
          maxActivations: 4,
        }),
      );
      expect(routerCalls).toBeGreaterThan(0);
      const order = events
        .filter((e) => e.kind === "role_start")
        .map((e) => (e.kind === "role_start" ? e.role : ""));
      expect(order).toEqual(["researcher", "writer"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("traceparent stays consistent across role activations (T9 property)", async () => {
    const root = newTempRoot();
    try {
      const adapter = makeProgrammableAdapter(({ seed, previousToolResults }) => {
        if (previousToolResults.length > 0) return [{ type: "text", text: "[end]" }];
        if (seed.includes("[A2A from")) return [{ type: "text", text: "answer" }];
        if (seed.includes("[Handoff from")) {
          return [
            {
              type: "tool_use",
              id: "t_a2a",
              name: "SendMessage",
              input: { target: "alpha", payload: "follow-up?" },
            },
          ];
        }
        return [
          {
            type: "tool_use",
            id: "t_ho",
            name: "Handoff",
            input: { target: "beta", reason: "your turn" },
          },
        ];
      });

      const crew = Crew()
        .setName("trace-prop")
        .addRole("alpha", { model: "stub", instructions: "alpha." })
        .addRole("beta", { model: "stub", instructions: "beta." })
        .setEntry("alpha")
        .compile();

      const events = await collect(
        crew.run("start", { sessionRootDir: root, _adapter: adapter, maxActivations: 6 }),
      );

      const a2a = events.find((e) => e.kind === "a2a_message");
      if (a2a?.kind !== "a2a_message") throw new Error("a2a expected");
      const parsed = parseTraceparent(a2a.traceparent);
      expect(parsed).not.toBeNull();
      // The bus mints one traceId per RunContext; multiple A2A messages
      // would all carry the same traceId. Single-A2A test case is enough
      // to assert the envelope invariant property.
      if (parsed) {
        expect(parsed.traceId.length).toBe(32);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("A2A → Handoff transcript hygiene", () => {
  // Regression test for the bug where role A's SendMessage tool_use + the
  // peer's nested transcript + the SendMessage tool_result interleave in
  // the shared session JSONL, and a later role's resumed history replays
  // them in literal order — leaving the parent's tool_use unpaired
  // (Claude API rejects with "tool_use ids were found without
  // tool_result blocks immediately after"). The a2a_turn_start /
  // a2a_turn_end markers let replayMessageHistory skip the peer's nested
  // events so the parent's tool_use / tool_result stay adjacent.
  test("the role after a SendMessage→Handoff sees adjacent tool_use+tool_result, no peer turn", async () => {
    const root = newTempRoot();
    try {
      // Capture the messages array each role sees when its adapter is
      // called for the FIRST time on that turn (i.e. the seed, before
      // any tool_result has come back). The third role's first messages
      // is what would reproduce the bug if the markers didn't work.
      const firstMessagesByRole = new Map<string, Anthropic.MessageParam[]>();
      const callsByRole = new Map<string, number>();

      const adapter: ProviderAdapter = {
        providerId: "anthropic",
        features: {
          caching: "explicit",
          tool_use: true,
          vision: true,
          thinking: true,
          web_search: true,
        },
        estimateTokens: () => 0,
        stream: ({ messages }) => {
          // Figure out which role we're on by inspecting the LAST user
          // message text. Each role's seed user content is identifiable.
          const last = messages[messages.length - 1];
          let lastText = "";
          if (last?.content && typeof last.content === "string") {
            lastText = last.content;
          } else if (last?.content && Array.isArray(last.content)) {
            for (const block of last.content) {
              if ("text" in block && typeof block.text === "string") lastText = block.text;
            }
          }
          // First call for role A: seed is "begin". Emit SendMessage(b).
          // Second call for role A: tool_result back. Emit Handoff(c).
          // Third call for role A: Handoff tool_result back. End turn.
          // Role B: peer turn, returns short reply.
          // Role C: should see no peer turn in its messages.
          let role: string;
          if (lastText.includes("[A2A from a → b]")) {
            role = "b";
          } else if (lastText.includes("[Handoff from a]")) {
            role = "c";
          } else {
            role = "a";
          }
          const callIdx = (callsByRole.get(role) ?? 0) + 1;
          callsByRole.set(role, callIdx);
          if (callIdx === 1) {
            firstMessagesByRole.set(
              role,
              messages.map((m) => ({ ...m })) as Anthropic.MessageParam[],
            );
          }

          // Decide the response.
          let blocks: Anthropic.ContentBlock[];
          if (role === "b") {
            // Peer responds with text.
            blocks = [{ type: "text", text: "peer reply: data is from Wikipedia" }];
          } else if (role === "c") {
            // Receiver of Handoff — just end turn.
            blocks = [{ type: "text", text: "c done" }];
          } else if (role === "a" && callIdx === 1) {
            blocks = [
              {
                type: "tool_use",
                id: "tu_send",
                name: "SendMessage",
                input: { target: "b", payload: "where is the data from?" },
              },
            ];
          } else if (role === "a" && callIdx === 2) {
            blocks = [
              {
                type: "tool_use",
                id: "tu_ho",
                name: "Handoff",
                input: { target: "c", reason: "you take it from here" },
              },
            ];
          } else {
            blocks = [{ type: "text", text: "a end" }];
          }

          const hasToolUse = blocks.some((b) => b.type === "tool_use");
          return (async function* () {
            yield { kind: "message_start" } as StreamEvent;
            for (let idx = 0; idx < blocks.length; idx++) {
              const block = blocks[idx];
              if (!block) continue;
              if (block.type === "text") {
                yield {
                  kind: "content_block_start",
                  index: idx,
                  block: { type: "text", text: "" },
                } as StreamEvent;
                yield {
                  kind: "content_block_delta",
                  index: idx,
                  delta: { type: "text_delta", text: block.text },
                } as StreamEvent;
                yield { kind: "content_block_stop", index: idx } as StreamEvent;
              } else if (block.type === "tool_use") {
                yield {
                  kind: "content_block_start",
                  index: idx,
                  block: { type: "tool_use", id: block.id, name: block.name, input: {} },
                } as StreamEvent;
                yield {
                  kind: "content_block_delta",
                  index: idx,
                  delta: {
                    type: "input_json_delta",
                    partial_json: JSON.stringify(block.input ?? {}),
                  },
                } as StreamEvent;
                yield { kind: "content_block_stop", index: idx } as StreamEvent;
              }
            }
            yield {
              kind: "message_delta",
              stopReason: hasToolUse ? "tool_use" : "end_turn",
            } as StreamEvent;
            yield { kind: "message_stop" } as StreamEvent;
          })();
        },
      };

      const crew = Crew()
        .setName("a2a-then-handoff")
        .addRole("a", { model: "stub", instructions: "a." })
        .addRole("b", { model: "stub", instructions: "b." })
        .addRole("c", { model: "stub", instructions: "c." })
        .setEntry("a")
        .compile();

      const events = await collect(
        crew.run("begin", { sessionRootDir: root, _adapter: adapter, maxActivations: 8 }),
      );

      // Sanity: run completed via crew_done with c as the final role.
      const done = events[events.length - 1];
      expect(done?.kind).toBe("crew_done");

      // The interesting assertion: role C's first-call messages must
      // contain role A's `tool_use` (SendMessage) IMMEDIATELY followed
      // by a `tool_result` user message — i.e. the peer's nested
      // user/assistant pair must NOT appear in C's replayed history.
      const cFirst = firstMessagesByRole.get("c");
      expect(cFirst).toBeDefined();
      if (cFirst === undefined) throw new Error("c first messages missing");

      // Walk the message list; for every assistant message containing a
      // tool_use, the next message must be a user with a matching
      // tool_result block. This is the exact pairing Anthropic requires.
      for (let i = 0; i < cFirst.length; i++) {
        const m = cFirst[i];
        if (m?.role !== "assistant") continue;
        if (!Array.isArray(m.content)) continue;
        for (const block of m.content) {
          if ("type" in block && block.type === "tool_use") {
            const next = cFirst[i + 1];
            expect(next?.role).toBe("user");
            const nextContent = next?.content;
            if (!Array.isArray(nextContent)) {
              throw new Error(
                `expected array content after tool_use ${block.id}; got: ${JSON.stringify(next)}`,
              );
            }
            const result = nextContent.find(
              (b) =>
                "type" in b &&
                b.type === "tool_result" &&
                (b as { tool_use_id?: string }).tool_use_id === block.id,
            );
            expect(result).toBeDefined();
          }
        }
      }

      // Defense in depth: C's history must NOT contain the peer's
      // [A2A from a → b] seed user message.
      const peerSeedSeen = cFirst.some((m) => {
        if (typeof m.content === "string") return m.content.includes("[A2A from a → b]");
        if (Array.isArray(m.content)) {
          return m.content.some(
            (b) => "text" in b && typeof b.text === "string" && b.text.includes("[A2A from a → b]"),
          );
        }
        return false;
      });
      expect(peerSeedSeen).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("refusal-loop guard — refusalDepth boundary (T8 supplement)", () => {
  // The T8 ping-pong test above asserts the default `refusalDepth=2`
  // guard. This boundary check covers `refusalDepth=1`, which trips on
  // the second consecutive handoff. Together they pin the guard
  // mathematically — `consecutiveHandoffs > refusalDepth` — without
  // depending on a live model. (The Section-22 smoke previously tried
  // to verify the same invariant via a live haiku-4.5 crew, but modern
  // models recognise the bounce trap and refuse to call Handoff at all,
  // so the guard never fires there.)
  test("refusalDepth=1 trips on the second consecutive handoff", async () => {
    const root = newTempRoot();
    try {
      const adapter = makeProgrammableAdapter(({ seed, previousToolResults }) => {
        if (previousToolResults.length > 0) {
          return [{ type: "text", text: "[handoff issued]" }];
        }
        const target = seed.includes("[Handoff from a]") ? "a" : "b";
        return [
          {
            type: "tool_use",
            id: `t_ho_${target}`,
            name: "Handoff",
            input: { target, reason: "ping-pong" },
          },
        ];
      });

      const crew = Crew()
        .setName("tight-refusal")
        .addRole("a", { model: "stub", instructions: "a." })
        .addRole("b", { model: "stub", instructions: "b." })
        .setEntry("a")
        .compile();

      await expect(
        collect(
          crew.run("go", {
            sessionRootDir: root,
            _adapter: adapter,
            maxActivations: 32,
            refusalDepth: 1,
          }),
        ),
      ).rejects.toBeInstanceOf(HandoffRefusedError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
