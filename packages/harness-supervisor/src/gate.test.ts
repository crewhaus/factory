import { describe, expect, test } from "bun:test";
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
