/**
 * "Watch me" (design/watch-me.md §4.6) — the spec→IR lowering of the
 * `watchme:` block on its three carrier shapes:
 *   - spread-return-{} discipline: watchme-less specs carry NO watchme key
 *     (byte-identical bundles);
 *   - defaults fully resolved at lower time (incl. the optional `judge:`
 *     sub-block's model/sample_rate/budget_usd);
 *   - the managed shape's honest `accepted-but-unwired` compile warning
 *     (cli/channel are wired and must NOT warn).
 */
import { describe, expect, test } from "bun:test";
import type { IrChannelV0, IrManagedV0, IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import { compile, lower } from "./index";

const cliYaml = (extra: string): string =>
  ["name: c", "target: cli", "agent:", "  model: m", "  instructions: i", extra].join("\n");

const channelYaml = (extra: string): string =>
  [
    "name: ch",
    "target: channel",
    "agent: { model: m, instructions: i }",
    "channels: { slack: { botToken: $SLACK_BOT_TOKEN, signingSecret: $SLACK_SIGNING_SECRET } }",
    "routing: { sessionKey: thread }",
    extra,
  ].join("\n");

const managedYaml = (extra: string): string =>
  [
    "name: mg",
    "target: managed",
    "agent: { model: m, instructions: i }",
    "tenants:",
    "  - id: t1",
    "    budget: { maxInputTokens: 1, maxOutputTokens: 1 }",
    extra,
  ].join("\n");

const cli = (extra: string): IrV0 => {
  const ir = lower(parseSpec(cliYaml(extra)));
  if (ir.target !== "cli") throw new Error("unexpected target");
  return ir;
};

const channel = (extra: string): IrChannelV0 => {
  const ir = lower(parseSpec(channelYaml(extra)));
  if (ir.target !== "channel") throw new Error("unexpected target");
  return ir;
};

const managed = (extra: string): IrManagedV0 => {
  const ir = lower(parseSpec(managedYaml(extra)));
  if (ir.target !== "managed") throw new Error("unexpected target");
  return ir;
};

const ALL_DEFAULTS = {
  enabled: true,
  capture: "full",
  judgeModel: "claude-haiku-4-5",
  judgeSampleRate: 0.15,
  judgeBudgetUsd: 0,
  scope: "harness",
  share: false,
};

describe("watchme lowering — spread-return-{} (byte-identical when absent)", () => {
  test("a watchme-less spec carries NO watchme key on any carrier shape", () => {
    for (const ir of [
      cli("permissions: { mode: auto }"),
      channel("permissions: { mode: auto }"),
      managed("permissions: { mode: auto }"),
    ]) {
      expect(ir.watchme).toBeUndefined();
      expect("watchme" in ir).toBe(false);
    }
  });

  test("a watchme-less spec compiles byte-identically to itself with zero warnings", () => {
    const yaml = cliYaml("permissions: { mode: auto }");
    const a = compile(yaml);
    const b = compile(yaml);
    expect(a.warnings).toEqual([]);
    expect(a.files).toEqual(b.files);
  });
});

describe("watchme lowering — defaults resolved at lower time (§4.6)", () => {
  test("a bare `watchme: {}` lowers fully populated on every carrier shape", () => {
    expect(cli("watchme: {}").watchme).toEqual(ALL_DEFAULTS);
    expect(channel("watchme: {}").watchme).toEqual(ALL_DEFAULTS);
    expect(managed("watchme: {}").watchme).toEqual(ALL_DEFAULTS);
  });

  test("absent judge and a bare `judge: {}` resolve to the same judge defaults", () => {
    expect(cli("watchme:\n  judge: {}").watchme).toEqual(ALL_DEFAULTS);
  });

  test("a full block lowers verbatim (snake_case → camelCase judge knobs)", () => {
    const ir = cli(
      [
        "watchme:",
        "  enabled: false",
        "  capture: mirrors",
        "  judge:",
        "    model: claude-sonnet-4-6",
        "    sample_rate: 0.5",
        "    budget_usd: 2",
        "  scope: user",
        "  share: true",
      ].join("\n"),
    );
    expect(ir.watchme).toEqual({
      enabled: false,
      capture: "mirrors",
      judgeModel: "claude-sonnet-4-6",
      judgeSampleRate: 0.5,
      judgeBudgetUsd: 2,
      scope: "user",
      share: true,
    });
  });
});

describe("watchme compile warnings — managed is accepted-but-unwired, cli/channel are wired", () => {
  test("managed emits the accepted-but-unwired warning when watchme is declared", () => {
    const result = compile(managedYaml("watchme: {}"));
    expect(result.warnings).toEqual([
      {
        code: "accepted-but-unwired",
        path: "watchme",
        message:
          "watchme is accepted on the managed shape but its emitter does not wire it yet — the managed daemon does not stamp CREWHAUS_WATCHME, so capture stays off until its loop wiring lands (design/watch-me.md §6.3)",
      },
    ]);
  });

  test("managed does NOT warn without watchme, or with the explicit enabled: false opt-out", () => {
    expect(compile(managedYaml("permissions: { mode: auto }")).warnings).toEqual([]);
    expect(compile(managedYaml("watchme:\n  enabled: false")).warnings).toEqual([]);
  });

  test("cli and channel never warn for watchme (wired shapes)", () => {
    expect(compile(cliYaml("watchme: {}")).warnings).toEqual([]);
    expect(compile(channelYaml("watchme: {}")).warnings).toEqual([]);
  });
});
