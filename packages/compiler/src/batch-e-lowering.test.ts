/**
 * Loop contract 0.4 (Batch E) — lowering semantics for the keystone spec
 * surface:
 *
 *   - G46: with `memory:` present, `autoRecall`/`autoCapture` RESOLVE to true
 *     (mildly breaking) and are stamped into the IR as explicit booleans;
 *   - G21: `autoRecall`'s string form + `refreshEvery` resolve into
 *     `recallMode` (carried only when "per-turn") + `refreshEvery`;
 *     `refreshEvery` alongside `autoRecall: false` is a loud contradiction;
 *   - G77: `sessionRecall` is carried only when opted in;
 *   - G22: the `knowledge:` block resolves the pipeline retrieve/indexing
 *     defaults and discriminates its sources by kind.
 */
import { describe, expect, test } from "bun:test";
import { CompilerError } from "@crewhaus/errors";
import type { IrKnowledge, IrMemory } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import { lower } from "./index";

type CliSlice = {
  readonly target: string;
  readonly memory?: IrMemory;
  readonly knowledge?: IrKnowledge;
};

const CLI = `name: c
target: cli
agent:
  model: m
  instructions: i
`;

function lowerCli(lines: string): CliSlice {
  const ir = lower(parseSpec(`${CLI}${lines}\n`));
  if (ir.target !== "cli") throw new Error("expected cli");
  return ir as CliSlice;
}

describe("Batch E (G46) — memory auto-recall/capture default-on resolution", () => {
  test("a bare memory block resolves autoCapture + autoRecall to true", () => {
    const ir = lowerCli("memory:\n  enabled: true\ncontinuity: false");
    expect(ir.memory?.autoCapture).toBe(true);
    expect(ir.memory?.autoRecall).toBe(true);
    // session-start is the implicit default → recallMode NOT carried.
    expect(ir.memory && "recallMode" in ir.memory).toBe(false);
  });

  test("explicit opt-outs are honoured", () => {
    const ir = lowerCli("memory:\n  autoRecall: false\n  autoCapture: false\ncontinuity: false");
    expect(ir.memory?.autoRecall).toBe(false);
    expect(ir.memory?.autoCapture).toBe(false);
  });

  test("no memory block ⇒ no memory key (byte-identical to pre-0.4)", () => {
    const ir = lowerCli("continuity: false");
    expect(ir.memory).toBeUndefined();
  });
});

describe("Batch E (G21) — per-turn recall cadence resolution", () => {
  test('autoRecall "session-start" resolves to on with no recallMode carried', () => {
    const ir = lowerCli('memory:\n  autoRecall: "session-start"\ncontinuity: false');
    expect(ir.memory?.autoRecall).toBe(true);
    expect(ir.memory && "recallMode" in ir.memory).toBe(false);
  });

  test('autoRecall "per-turn" resolves recallMode: per-turn', () => {
    const ir = lowerCli('memory:\n  autoRecall: "per-turn"\ncontinuity: false');
    expect(ir.memory?.autoRecall).toBe(true);
    expect(ir.memory?.recallMode).toBe("per-turn");
    // refreshEvery not declared ⇒ absent (runtime defaults to 1).
    expect(ir.memory && "refreshEvery" in ir.memory).toBe(false);
  });

  test("refreshEvery implies per-turn cadence even when autoRecall omitted", () => {
    const ir = lowerCli("memory:\n  refreshEvery: 5\ncontinuity: false");
    expect(ir.memory?.autoRecall).toBe(true);
    expect(ir.memory?.recallMode).toBe("per-turn");
    expect(ir.memory?.refreshEvery).toBe(5);
  });

  test("refreshEvery alongside autoRecall: false is a loud contradiction", () => {
    expect(() => lowerCli("memory:\n  autoRecall: false\n  refreshEvery: 3")).toThrow(
      CompilerError,
    );
    expect(() => lowerCli("memory:\n  autoRecall: false\n  refreshEvery: 3")).toThrow(
      /refreshEvery/,
    );
  });
});

describe("Batch E (G77) — session-summary recall ranker", () => {
  test("sessionRecall carried only when opted in", () => {
    const on = lowerCli("memory:\n  sessionRecall: true\ncontinuity: false");
    expect(on.memory?.sessionRecall).toBe(true);
    const off = lowerCli("memory:\n  enabled: true\ncontinuity: false");
    expect(off.memory && "sessionRecall" in off.memory).toBe(false);
  });
});

describe("Batch E (G22) — knowledge block lowering", () => {
  test("resolves pipeline defaults + discriminates sources by kind", () => {
    const ir = lowerCli(
      [
        "knowledge:",
        "  sources:",
        "    - path: ./docs",
        "    - glob: '**/*.md'",
        "    - url: https://example.com/guide",
      ].join("\n"),
    );
    expect(ir.knowledge).toEqual({
      vectorBackend: "in-memory",
      defaultK: 5,
      chunkSize: 400,
      chunkOverlap: 0,
      sources: [
        { kind: "path", path: "./docs" },
        { kind: "glob", glob: "**/*.md" },
        { kind: "url", url: "https://example.com/guide" },
      ],
    });
  });

  test("carries declared embedder + overrides the resolved knobs", () => {
    const ir = lowerCli(
      [
        "knowledge:",
        "  embedder: builtin:hash",
        "  vector_backend: lance",
        "  default_k: 8",
        "  chunk:",
        "    size: 512",
        "    overlap: 64",
        "  sources:",
        "    - path: ./kb",
      ].join("\n"),
    );
    expect(ir.knowledge).toEqual({
      embedder: "builtin:hash",
      vectorBackend: "lance",
      defaultK: 8,
      chunkSize: 512,
      chunkOverlap: 64,
      sources: [{ kind: "path", path: "./kb" }],
    });
  });

  test("no knowledge block ⇒ no knowledge key", () => {
    const ir = lowerCli("continuity: false");
    expect(ir.knowledge).toBeUndefined();
  });

  test("knowledge lowers on channel + managed too", () => {
    const channel = lower(
      parseSpec(
        [
          "name: c",
          "target: channel",
          "agent:",
          "  model: m",
          "  instructions: i",
          "channels:",
          "  slack:",
          "    botToken: $T",
          "    signingSecret: $S",
          "routing:",
          "  sessionKey: thread",
          "knowledge:",
          "  sources:",
          "    - path: ./docs",
        ].join("\n"),
      ),
    );
    if (channel.target !== "channel") throw new Error("expected channel");
    expect(channel.knowledge?.sources).toEqual([{ kind: "path", path: "./docs" }]);

    const managed = lower(
      parseSpec(
        [
          "name: m",
          "target: managed",
          "agent:",
          "  model: m",
          "  instructions: i",
          "tenants:",
          "  - id: t1",
          "    budget: { maxInputTokens: 1, maxOutputTokens: 1 }",
          "knowledge:",
          "  sources:",
          "    - glob: '**/*.txt'",
        ].join("\n"),
      ),
    );
    if (managed.target !== "managed") throw new Error("expected managed");
    expect(managed.knowledge?.sources).toEqual([{ kind: "glob", glob: "**/*.txt" }]);
  });
});
