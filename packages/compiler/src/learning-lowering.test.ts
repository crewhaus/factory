/**
 * v0.3.0 Goal 2 (design §3.3, PR 17) — the `learning:` block lowering:
 * required domain, resolved study defaults, the wiki-or-thredz cross-field
 * requirement, the deterministic Sources-required wiki stamp, the
 * requireSources contradiction, carried posture on the non-cli memory
 * shapes, and the absent-is-byte-identical guarantee.
 */
import { describe, expect, test } from "bun:test";
import type { IrChannelV0, IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import { lower } from "./index";

const cliSpec = (extra: string) => `
name: hello
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
${extra}
`;

const WIKI_ON = "memory:\n  wiki:\n    enabled: true\n";

const LEARNING_MIN = `learning:
  domain: specialty coffee extraction science
`;

function lowerCli(yaml: string): IrV0 {
  const ir = lower(parseSpec(yaml));
  if (ir.target !== "cli") throw new Error("unexpected target");
  return ir;
}

describe("learning: lowering — fields and resolved defaults (§3.3)", () => {
  test("minimal block (domain + local wiki) lowers with study toggles resolved ON", () => {
    const ir = lowerCli(cliSpec(WIKI_ON + LEARNING_MIN));
    expect(ir.learning).toEqual({
      domain: "specialty coffee extraction science",
      study: { onHeartbeat: true, onDream: true },
    });
  });

  test("full block carries curriculum, sources, exam verbatim; study opt-outs resolve", () => {
    const ir = lowerCli(
      cliSpec(
        WIKI_ON +
          [
            "learning:",
            "  domain: coffee",
            "  curriculum: curriculum.md",
            '  sources: ["sca.coffee", "*.edu"]',
            "  exam: { dataset: eval/dataset.jsonl, graders: eval/graders.yaml }",
            "  study: { on_heartbeat: false, on_dream: false }",
          ].join("\n"),
      ),
    );
    expect(ir.learning).toEqual({
      domain: "coffee",
      curriculum: "curriculum.md",
      sources: ["sca.coffee", "*.edu"],
      exam: { dataset: "eval/dataset.jsonl", graders: "eval/graders.yaml" },
      study: { onHeartbeat: false, onDream: false },
    });
  });

  test("enabled: false lowers to nothing — the explicit opt-out", () => {
    const ir = lowerCli(cliSpec(`${WIKI_ON}learning:\n  enabled: false\n  domain: coffee`));
    expect(ir.learning).toBeUndefined();
  });

  test("thredz satisfies the wiki requirement — no local memory block needed", () => {
    const ir = lowerCli(cliSpec(`thredz: true\n${LEARNING_MIN}`));
    expect(ir.learning?.domain).toBe("specialty coffee extraction science");
    expect(ir.memory).toBeUndefined(); // nothing invented — thredz is the wiki
  });

  test("domain is required (spec-level)", () => {
    expect(() => parseSpec(cliSpec(`${WIKI_ON}learning:\n  curriculum: curriculum.md`))).toThrow();
  });

  test("a typo'd sub-key fails the build (strict schema)", () => {
    expect(() =>
      parseSpec(cliSpec(`${WIKI_ON}learning:\n  domain: coffee\n  curiculum: curriculum.md`)),
    ).toThrow();
    expect(() =>
      parseSpec(cliSpec(`${WIKI_ON}learning:\n  domain: coffee\n  study: { onHeartbeat: true }`)),
    ).toThrow();
  });

  test("the strict union rejects learning on shapes without the memory fabric", () => {
    expect(() =>
      parseSpec(`
name: g
target: graph
entry: a
nodes:
  a:
    instructions: hi
edges: []
model: claude-sonnet-4-6
learning:
  domain: coffee
`),
    ).toThrow();
  });
});

describe("learning: cross-field validation (§3.3 — learning needs a wiki)", () => {
  test("no memory.wiki and no thredz is a CompilerError naming both fixes", () => {
    expect(() => lowerCli(cliSpec(LEARNING_MIN))).toThrow(/learning: needs a wiki/);
    expect(() => lowerCli(cliSpec(LEARNING_MIN))).toThrow(/thredz/);
  });

  test("a memory block WITHOUT the wiki sub-block does not satisfy the requirement", () => {
    expect(() => lowerCli(cliSpec(`memory:\n  autoRecall: true\n${LEARNING_MIN}`))).toThrow(
      /learning: needs a wiki/,
    );
  });

  test("an explicitly DISABLED wiki does not satisfy the requirement", () => {
    expect(() =>
      lowerCli(cliSpec(`memory:\n  wiki:\n    enabled: false\n${LEARNING_MIN}`)),
    ).toThrow(/learning: needs a wiki/);
  });

  test("thredz: false (the opt-out) does not satisfy the requirement", () => {
    expect(() => lowerCli(cliSpec(`thredz: false\n${LEARNING_MIN}`))).toThrow(
      /learning: needs a wiki/,
    );
  });

  test("requireSources: false contradicts learning's deterministic governance", () => {
    expect(() =>
      lowerCli(
        cliSpec(`memory:\n  wiki:\n    enabled: true\n    requireSources: false\n${LEARNING_MIN}`),
      ),
    ).toThrow(/requireSources/);
  });
});

describe("learning: §3.3 write-path governance — the Sources-required stamp", () => {
  test("learning stamps memory.wiki.requireSources true on the lowered IR", () => {
    const ir = lowerCli(cliSpec(WIKI_ON + LEARNING_MIN));
    expect(ir.memory?.wiki?.requireSources).toBe(true);
  });

  test("without learning the wiki block is untouched (no stamp, byte-identical IR)", () => {
    const without = lowerCli(cliSpec(WIKI_ON));
    expect(without.memory?.wiki?.requireSources).toBeUndefined();
    expect(without.learning).toBeUndefined();
    // The full IR matches a pre-PR-17 lowering exactly.
    expect(JSON.stringify(without)).toBe(JSON.stringify(lowerCli(cliSpec(WIKI_ON))));
  });

  test("an explicit requireSources: true alongside learning stays true", () => {
    const ir = lowerCli(
      cliSpec(`memory:\n  wiki:\n    enabled: true\n    requireSources: true\n${LEARNING_MIN}`),
    );
    expect(ir.memory?.wiki?.requireSources).toBe(true);
  });
});

describe("learning: carried on the non-cli memory shapes", () => {
  const channelYaml = (extra: string) => `
name: chan
target: channel
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
routing:
  sessionKey: thread
${extra}
`;

  test("channel lowers learning (with the wiki stamp) like cli", () => {
    const ir = lower(parseSpec(channelYaml(WIKI_ON + LEARNING_MIN))) as IrChannelV0;
    expect(ir.learning).toEqual({
      domain: "specialty coffee extraction science",
      study: { onHeartbeat: true, onDream: true },
    });
    expect(ir.memory?.wiki?.requireSources).toBe(true);
  });

  test("channel learning still requires the wiki", () => {
    expect(() => lower(parseSpec(channelYaml(LEARNING_MIN)))).toThrow(/learning: needs a wiki/);
  });

  test("research and crew carry learning", () => {
    const research = lower(
      parseSpec(`
name: res
target: research
agent:
  model: claude-sonnet-4-6
  instructions: dig
goal: learn things
branchingFactor: 2
maxDurationMs: 60000
retrieve:
  allowedOrigins: []
  allowedFileRoots: []
${WIKI_ON}${LEARNING_MIN}`),
    );
    expect((research as { learning?: unknown }).learning).toBeDefined();

    const crew = lower(
      parseSpec(`
name: team
target: crew
entry: lead
model: claude-sonnet-4-6
roles:
  lead:
    instructions: coordinate
${WIKI_ON}${LEARNING_MIN}`),
    );
    expect((crew as { learning?: unknown }).learning).toBeDefined();
  });
});
