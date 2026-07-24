/**
 * "Watch me" (design/watch-me.md §4.1/§4.2) — parse-level tests for the
 * `watchme:` block:
 *   - round-trip + zod-materialised defaults on the three carrier shapes
 *     (cli / channel / managed);
 *   - strict-union rejection everywhere else (workflow/graph/research/crew);
 *   - the ONE cross-field invariant: `watchme.share: true` vs a thredz
 *     OBJECT with an EXPLICIT `visibility: "private"` (shorthands and an
 *     absent thredz block are legal), APPENDED after every existing check.
 */
import { describe, expect, test } from "bun:test";
import { SpecParseError, parseSpec, parseSpecIssues } from "./index";

const cliWith = (block: string): string =>
  ["name: c", "target: cli", "agent:", "  model: m", "  instructions: i", block].join("\n");

const channelWith = (block: string): string =>
  [
    "name: ch",
    "target: channel",
    "agent: { model: m, instructions: i }",
    "channels: { slack: { botToken: $SLACK_BOT_TOKEN, signingSecret: $SLACK_SIGNING_SECRET } }",
    "routing: { sessionKey: thread }",
    block,
  ].join("\n");

const managedWith = (block: string): string =>
  [
    "name: mg",
    "target: managed",
    "agent: { model: m, instructions: i }",
    "tenants:",
    "  - id: t1",
    "    budget: { maxInputTokens: 1, maxOutputTokens: 1 }",
    block,
  ].join("\n");

const FULL_BLOCK = [
  "watchme:",
  "  enabled: true",
  "  capture: mirrors",
  "  judge:",
  "    model: claude-sonnet-4-6",
  "    sample_rate: 0.5",
  "    budget_usd: 2",
  "  scope: user",
  "  share: true",
].join("\n");

const FULL_EXPECTED = {
  enabled: true,
  capture: "mirrors",
  judge: { model: "claude-sonnet-4-6", sample_rate: 0.5, budget_usd: 2 },
  scope: "user",
  share: true,
};

const DEFAULTS_EXPECTED = { enabled: true, capture: "full", scope: "harness", share: false };

describe("watchme: block — carrier shapes round-trip (§4.1)", () => {
  test("cli carries the full block verbatim", () => {
    const spec = parseSpec(cliWith(FULL_BLOCK));
    if (spec.target !== "cli") throw new Error("unexpected target");
    expect(spec.watchme).toEqual(FULL_EXPECTED);
  });

  test("channel carries the full block verbatim", () => {
    const spec = parseSpec(channelWith(FULL_BLOCK));
    if (spec.target !== "channel") throw new Error("unexpected target");
    expect(spec.watchme).toEqual(FULL_EXPECTED);
  });

  test("managed carries the full block verbatim", () => {
    const spec = parseSpec(managedWith(FULL_BLOCK));
    if (spec.target !== "managed") throw new Error("unexpected target");
    expect(spec.watchme).toEqual(FULL_EXPECTED);
  });

  test("a bare `watchme: {}` materialises every default (judge stays absent)", () => {
    for (const yaml of [
      cliWith("watchme: {}"),
      channelWith("watchme: {}"),
      managedWith("watchme: {}"),
    ]) {
      const spec = parseSpec(yaml);
      if (spec.target !== "cli" && spec.target !== "channel" && spec.target !== "managed") {
        throw new Error("unexpected target");
      }
      expect(spec.watchme).toEqual(DEFAULTS_EXPECTED);
    }
  });

  test("a bare `judge: {}` materialises the judge defaults", () => {
    const spec = parseSpec(cliWith("watchme:\n  judge: {}"));
    if (spec.target !== "cli") throw new Error("unexpected target");
    expect(spec.watchme?.judge).toEqual({
      model: "claude-haiku-4-5",
      sample_rate: 0.15,
      budget_usd: 0,
    });
  });

  test("absent watchme leaves the field undefined", () => {
    const spec = parseSpec(cliWith("permissions:\n  mode: auto"));
    if (spec.target !== "cli") throw new Error("unexpected target");
    expect(spec.watchme).toBeUndefined();
  });

  test("rejects a typo'd watchme sub-key (strict)", () => {
    expect(() => parseSpec(cliWith("watchme:\n  captured: full"))).toThrow(SpecParseError);
    expect(() => parseSpec(cliWith("watchme:\n  judge:\n    sample: 1"))).toThrow(SpecParseError);
  });

  test("rejects out-of-range judge knobs", () => {
    expect(() => parseSpec(cliWith("watchme:\n  judge:\n    sample_rate: 1.5"))).toThrow(
      SpecParseError,
    );
    expect(() => parseSpec(cliWith("watchme:\n  judge:\n    budget_usd: -1"))).toThrow(
      SpecParseError,
    );
    expect(() => parseSpec(cliWith("watchme:\n  capture: partial"))).toThrow(SpecParseError);
  });
});

describe("watchme: block — strict-union rejection off the carrier shapes", () => {
  test("workflow rejects watchme", () => {
    expect(() =>
      parseSpec(
        [
          "name: wf",
          "target: workflow",
          "model: m",
          "steps:",
          "  - name: s",
          "    instructions: i",
          "watchme: {}",
        ].join("\n"),
      ),
    ).toThrow(SpecParseError);
  });

  test("graph rejects watchme", () => {
    expect(() =>
      parseSpec(
        [
          "name: g",
          "target: graph",
          "model: m",
          "entry: a",
          "nodes:",
          "  a:",
          "    instructions: hi",
          "edges: []",
          "watchme: {}",
        ].join("\n"),
      ),
    ).toThrow(SpecParseError);
  });

  test("research rejects watchme (named deferral, design/watch-me.md §13.1)", () => {
    expect(() =>
      parseSpec(
        [
          "name: re",
          "target: research",
          "agent:",
          "  model: m",
          "  instructions: i",
          "goal: learn",
          "watchme: {}",
        ].join("\n"),
      ),
    ).toThrow(SpecParseError);
  });

  test("crew rejects watchme (named deferral, design/watch-me.md §13.1)", () => {
    expect(() =>
      parseSpec(
        [
          "name: cr",
          "target: crew",
          "model: m",
          "entry: lead",
          "roles:",
          "  lead:",
          "    instructions: lead it",
          "watchme: {}",
        ].join("\n"),
      ),
    ).toThrow(SpecParseError);
  });
});

describe("watchme.share vs explicit thredz visibility: private (§4.2)", () => {
  const PRIVATE_THREDZ = "thredz:\n  api_key: $THREDZ_API_KEY\n  visibility: private";
  const SHARE_ON = "watchme:\n  share: true";
  const MESSAGE =
    "watchme.share publishes co-learning articles; thredz.visibility: private blocks cross-agent sharing — set visibility: shared or drop watchme.share";

  test("fires on an explicit private thredz object + share: true (cli)", () => {
    const issues = parseSpecIssues(cliWith(`${PRIVATE_THREDZ}\n${SHARE_ON}`));
    expect(issues).toEqual([{ path: ["watchme", "share"], message: MESSAGE, code: "custom" }]);
    expect(() => parseSpec(cliWith(`${PRIVATE_THREDZ}\n${SHARE_ON}`))).toThrow(MESSAGE);
  });

  test("fires on managed too (all three carriers share the invariant)", () => {
    const issues = parseSpecIssues(managedWith(`${PRIVATE_THREDZ}\n${SHARE_ON}`));
    expect(issues).toEqual([{ path: ["watchme", "share"], message: MESSAGE, code: "custom" }]);
  });

  test("visibility: shared produces NO issue", () => {
    expect(
      parseSpecIssues(
        cliWith(`thredz:\n  api_key: $THREDZ_API_KEY\n  visibility: shared\n${SHARE_ON}`),
      ),
    ).toEqual([]);
  });

  test("an object WITHOUT an explicit visibility produces NO issue (v1 checks explicit only)", () => {
    expect(parseSpecIssues(cliWith(`thredz:\n  api_key: $THREDZ_API_KEY\n${SHARE_ON}`))).toEqual(
      [],
    );
  });

  test("boolean/string thredz shorthands (default-private) produce NO issue", () => {
    expect(parseSpecIssues(cliWith(`thredz: true\n${SHARE_ON}`))).toEqual([]);
    expect(parseSpecIssues(cliWith(`thredz: $THREDZ_API_KEY\n${SHARE_ON}`))).toEqual([]);
  });

  test("absent thredz produces NO issue (publish degrades to the local wiki)", () => {
    expect(parseSpecIssues(cliWith(SHARE_ON))).toEqual([]);
  });

  test("share off (the default) produces NO issue even with explicit private thredz", () => {
    expect(parseSpecIssues(cliWith(`${PRIVATE_THREDZ}\nwatchme: {}`))).toEqual([]);
  });

  test("the invariant is APPENDED — existing issues keep their order ahead of it", () => {
    const issues = parseSpecIssues(
      cliWith(
        [
          "expose:",
          "  mcp:",
          "    transport: stdio",
          '    tools: "per-subagent"',
          PRIVATE_THREDZ,
          SHARE_ON,
        ].join("\n"),
      ),
    );
    expect(issues).toHaveLength(2);
    expect(issues[0]?.path).toEqual(["expose", "mcp", "tools"]);
    expect(issues[1]?.path).toEqual(["watchme", "share"]);
  });
});
