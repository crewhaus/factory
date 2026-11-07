import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreflightItem, PreflightReport } from "@crewhaus/preflight";
import { buildReport } from "@crewhaus/preflight";
import { evaluateGate, formatGateRefusal, isUnforceable, runPreflightGate } from "./gate";

const item = (over: Partial<PreflightItem>): PreflightItem => ({
  id: "x.1",
  area: "ports",
  level: "blocking",
  message: "port 3000 is in use",
  ...over,
});

const report = (items: PreflightItem[]): PreflightReport => buildReport(items);

describe("evaluateGate", () => {
  test("a clean report allows the spawn", () => {
    const decision = evaluateGate(report([item({ level: "info", message: "ok" })]));
    expect(decision.allowed).toBe(true);
    expect(decision.refused).toEqual([]);
  });

  test("a blocking item refuses with the typed item, not a stack trace", () => {
    const decision = evaluateGate(report([item({})]));
    expect(decision.allowed).toBe(false);
    expect(decision.refused[0]?.message).toBe("port 3000 is in use");
  });

  test("a blocking item can be acknowledged individually by id", () => {
    const decision = evaluateGate(report([item({ id: "ports.3000" })]), {
      acknowledge: ["ports.3000"],
    });
    expect(decision.allowed).toBe(true);
    expect(decision.acknowledged.map((i) => i.id)).toEqual(["ports.3000"]);
  });

  test("acknowledging a DIFFERENT id does not clear the block", () => {
    const decision = evaluateGate(report([item({ id: "ports.3000" })]), {
      acknowledge: ["ports.9999"],
    });
    expect(decision.allowed).toBe(false);
  });

  test("force acknowledges every forceable item at once", () => {
    const decision = evaluateGate(report([item({ id: "a" }), item({ id: "b", area: "mcp" })]), {
      force: true,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.acknowledged).toHaveLength(2);
  });

  test("missing channel secrets can NEVER be forced (guaranteed exit 2)", () => {
    const channelItem = item({
      id: "channels.slack.SLACK_SIGNING_SECRET",
      area: "channels",
      message: "will not boot: SLACK_SIGNING_SECRET unset",
    });
    const decision = evaluateGate(report([channelItem]), {
      force: true,
      acknowledge: ["channels.slack.SLACK_SIGNING_SECRET"],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.unforceable.map((i) => i.id)).toEqual([channelItem.id]);
    expect(isUnforceable(channelItem)).toBe(true);
  });

  test("a channel item that is only a WARNING is not unforceable", () => {
    expect(isUnforceable(item({ area: "channels", level: "warn" }))).toBe(false);
  });
});

describe("runPreflightGate", () => {
  test("runs preflight against the env it is handed and applies the gate", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const decision = await runPreflightGate({
      harnessDir: "/h",
      env: { ANTHROPIC_API_KEY: "present" },
      ports: [{ port: 3000, source: "allocator" }],
      preflight: async (opts) => {
        seen.push(opts as unknown as Record<string, unknown>);
        return report([item({ id: "ports.3000" })]);
      },
    });
    expect(decision.allowed).toBe(false);
    expect(seen[0]?.["harnessDir"]).toBe("/h");
    expect((seen[0]?.["env"] as Record<string, string>)["ANTHROPIC_API_KEY"]).toBe("present");
    expect(seen[0]?.["ports"]).toEqual([{ port: 3000, source: "allocator" }]);
  });

  test("an acknowledgement clears one start and the next start asks again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chsup-gate-"));
    try {
      writeFileSync(
        join(dir, "crewhaus.yaml"),
        [
          "name: gate-home",
          "target: cli",
          "agent:",
          "  model: claude-sonnet-4-5",
          "  instructions: Help briefly.",
          "",
        ].join("\n"),
      );
      const id = "workspace.holds-home";
      const env = { HOME: dir, ANTHROPIC_API_KEY: "present" };

      const refused = await runPreflightGate({ harnessDir: dir, env });
      expect(refused.allowed).toBe(false);
      const finding = refused.refused.find((i) => i.id === id);
      expect(finding?.area).toBe("workspace");
      if (finding === undefined) throw new Error("unreachable");
      expect(isUnforceable(finding)).toBe(false);
      expect(refused.unforceable).toEqual([]);

      const acknowledged = await runPreflightGate({ harnessDir: dir, env, acknowledge: [id] });
      expect(acknowledged.allowed).toBe(true);
      expect(acknowledged.acknowledged.map((i) => i.id)).toEqual([id]);

      const forced = await runPreflightGate({ harnessDir: dir, env, force: true });
      expect(forced.allowed).toBe(true);
      expect(forced.acknowledged.map((i) => i.id)).toEqual([id]);

      const next = await runPreflightGate({ harnessDir: dir, env });
      expect(next.allowed).toBe(false);
      expect(next.refused.map((i) => i.id)).toContain(id);
      expect(next.acknowledged).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the report covers the directory the spawn runs in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chsup-gate-root-"));
    try {
      writeFileSync(
        join(dir, "crewhaus.yaml"),
        [
          "name: gate-root",
          "target: cli",
          "agent:",
          "  model: claude-sonnet-4-5",
          "  instructions: Help briefly.",
          "",
        ].join("\n"),
      );
      const row = join(dir, "harnesses", "bot");
      mkdirSync(row, { recursive: true });
      const env = { HOME: dir, ANTHROPIC_API_KEY: "present" };

      const decision = await runPreflightGate({ harnessDir: row, env });
      expect(decision.refused.map((i) => i.id)).toEqual(["workspace.holds-home"]);
      expect(decision.refused[0]?.message).toContain(`(${dir})`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("formatGateRefusal", () => {
  test("renders the item, its remediation, and the un-overridable note", () => {
    const decision = evaluateGate(
      report([
        item({
          id: "channels.slack",
          area: "channels",
          message: "will not boot: SLACK_SIGNING_SECRET unset",
          remediation: "crewhaus env set SLACK_SIGNING_SECRET",
        }),
        item({ id: "ports.3000" }),
      ]),
      { acknowledge: ["ports.3000"] },
    );
    const lines = formatGateRefusal(decision).join("\n");
    expect(lines).toContain("will not boot: SLACK_SIGNING_SECRET unset");
    expect(lines).toContain("crewhaus env set SLACK_SIGNING_SECRET");
    expect(lines).toContain("cannot be overridden");
    expect(lines).toContain("1 blocking item(s) acknowledged");
  });
});
