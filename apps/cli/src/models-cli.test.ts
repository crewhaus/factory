/**
 * 0.6.0 §8.2 / §9.1 — `crewhaus models list | explain | audit | propose`.
 *
 * The load-bearing assertions are the exit-code ladder (a retired model must
 * fail; a fetched feed must never be able to flip an exit code) and the
 * audition's power floor (below n=30 the verb REFUSES rather than proposing
 * on noise) — acceptance items 11 and 12 of §1's scenario.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { PricingTable, SunsetTable } from "@crewhaus/cost-tracker";
import { DEFAULT_PRICING } from "@crewhaus/cost-tracker";
import { parseSpec } from "@crewhaus/spec";
import { enumerateModelSlots } from "./model-slots";
import {
  ModelsCliError,
  SHAPE_MODEL_MATRIX,
  auditModelSlots,
  auditionReadiness,
  buildProfileRows,
  buildSunsetProposal,
  describeStrategy,
  formatModelsAudit,
  formatModelsExplain,
  formatModelsList,
  modelsAuditExitCode,
  parseModelsArgs,
} from "./models-cli";

const HYBRID = `
name: hybrid
target: cli
models:
  fast:
    model: claude-haiku-4-5
    tags: [cheap]
    temperature: 0.2
  strong:
    model: claude-opus-5
    tags: [strong]
agent:
  model: $fast
  instructions: hi
  model_pool:
    candidates:
      - { model: $fast,   tags: [cheap] }
      - { model: $strong, tags: [strong] }
    policy: heuristic
    strategy:
      cascade: { draft: cheap, escalate_to: strong }
      max_escalations: 1
`;

/** A spec whose only model is one the sunset table retired long ago. */
const RETIRED = `
name: retired
target: cli
agent:
  model: claude-3-5-haiku-20241022
  instructions: hi
`;

const ir = (yaml: string) => lower(parseSpec(yaml));
const slotsOf = (yaml: string) => enumerateModelSlots(ir(yaml));

/** A one-entry sunset table with a date we control. */
function sunsets(retiresOn: string, source?: "builtin" | "feed"): SunsetTable {
  return {
    anthropic: [
      {
        modelIdPrefix: "claude-3-5-haiku",
        retiresOn,
        replacement: "claude-haiku-4-5",
        ...(source !== undefined ? { source } : {}),
      },
    ],
  };
}

describe("parseModelsArgs", () => {
  test("defaults --fail-on to pricing and takes a spec positional", () => {
    expect(parseModelsArgs(["audit", "spec.yaml"])).toEqual({
      sub: "audit",
      spec: "spec.yaml",
      failOn: "pricing",
    });
  });

  test("rejects an unknown --fail-on level and a malformed --today", () => {
    expect(() => parseModelsArgs(["audit", "--fail-on", "everything"])).toThrow(ModelsCliError);
    expect(() => parseModelsArgs(["audit", "--today", "yesterday"])).toThrow(/YYYY-MM-DD/);
  });

  test("requires a subcommand", () => {
    expect(() => parseModelsArgs(["--json"])).toThrow(/expected a subcommand/);
  });
});

describe("models list / explain", () => {
  test("list renders one row per profile with the settings it pins", () => {
    const rows = buildProfileRows(ir(HYBRID));
    expect(rows.map((r) => r.name)).toEqual(["fast", "strong"]);
    expect(rows[0]?.pinned).toContain("temperature=0.2");
    expect(formatModelsList(ir(HYBRID))).toContain("claude-opus-5");
  });

  test("list points a registry-less spec at `init --hybrid` instead of printing an empty table", () => {
    const text = formatModelsList(
      ir("name: bare\ntarget: cli\nagent:\n  model: claude-opus-5\n  instructions: hi\n"),
    );
    expect(text).toContain("No `models:` registry");
    expect(text).toContain("init --hybrid");
  });

  test("explain prints the strategy as one sentence and this shape's §11.3 row", () => {
    const text = formatModelsExplain(ir(HYBRID), slotsOf(HYBRID));
    expect(text).toContain("shape: cli");
    expect(text).toContain("agent.model");
    expect(text).toContain("← $fast");
    expect(text).toContain("drafting on `cheap` and escalating to `strong`");
    // §11.3: committee is NOT carried on the REPL shapes, and explain says so.
    expect(text).toContain("per-shape support (cli)");
    expect(text).toContain("committee");
    expect(text).toContain("REPL");
  });

  test("explain describes the REAL directive seam (PR 9b parses at typed input, not in the router)", () => {
    const text = formatModelsExplain(ir(HYBRID), slotsOf(HYBRID));
    expect(text).toContain("typed input seams");
    expect(text).toContain("never inside the router");
  });

  test("the §11.3 matrix covers all fourteen shapes", () => {
    expect(Object.keys(SHAPE_MODEL_MATRIX).sort()).toEqual(
      [
        "batch",
        "browser",
        "channel",
        "cli",
        "crew",
        "eval",
        "graph",
        "managed",
        "onchain",
        "onchain-game",
        "pipeline",
        "research",
        "voice",
        "workflow",
      ].sort(),
    );
  });

  test("describeStrategy is honest about a pool-less spec and about quality_source", () => {
    expect(describeStrategy(undefined)).toContain("No `model_pool`");
    expect(
      describeStrategy({ policy: "learned", candidates: [{ model: "m", tags: [] }] }),
    ).toContain("Quality does NOT reach the reward");
  });
});

describe("models audit", () => {
  test("a pricing miss is a hard failure — a $0-billed arm understates every budget", () => {
    const emptyPricing = { ...DEFAULT_PRICING, providers: {} } as unknown as PricingTable;
    const findings = auditModelSlots(slotsOf(HYBRID), { pricing: emptyPricing, sunsets: {} });
    const pricingFails = findings.filter((f) => f.kind === "pricing" && f.severity === "fail");
    expect(pricingFails.length).toBeGreaterThan(0);
    expect(modelsAuditExitCode(findings, "pricing")).toBe(1);
    expect(modelsAuditExitCode(findings, "none")).toBe(0);
  });

  test("a RETIRED compiled-in sunset fails at the default level (acceptance item 12)", () => {
    const findings = auditModelSlots(slotsOf(RETIRED), {
      sunsets: sunsets("2026-01-01"),
      today: new Date("2026-06-01T00:00:00Z"),
    });
    const sunset = findings.find((f) => f.kind === "sunset");
    expect(sunset?.retired).toBe(true);
    expect(sunset?.severity).toBe("fail");
    expect(sunset?.replacement).toBe("claude-haiku-4-5");
    expect(modelsAuditExitCode(findings, "pricing")).toBe(1);
    expect(formatModelsAudit(findings, "pricing")).toContain("RETIRED");
  });

  test("--today pins the clock: the same slot passes before the date and fails after it", () => {
    const before = auditModelSlots(slotsOf(RETIRED), {
      sunsets: sunsets("2026-10-01"),
      today: new Date("2026-09-30T00:00:00Z"),
    });
    expect(before.find((f) => f.kind === "sunset")?.retired).toBe(false);
    expect(modelsAuditExitCode(before, "pricing")).toBe(0);
    // An ANNOUNCED sunset only fails at the stricter level.
    expect(modelsAuditExitCode(before, "sunset")).toBe(1);

    const after = auditModelSlots(slotsOf(RETIRED), {
      sunsets: sunsets("2026-10-01"),
      today: new Date("2026-10-02T00:00:00Z"),
    });
    expect(after.find((f) => f.kind === "sunset")?.retired).toBe(true);
    expect(modelsAuditExitCode(after, "pricing")).toBe(1);
  });

  test("a FEED-sourced sunset is advisory at every level — a fetched feed cannot flip an exit code", () => {
    const findings = auditModelSlots(slotsOf(RETIRED), {
      sunsets: sunsets("2026-01-01", "feed"),
      today: new Date("2026-06-01T00:00:00Z"),
    });
    const sunset = findings.find((f) => f.kind === "sunset");
    expect(sunset?.retired).toBe(true);
    expect(sunset?.severity).toBe("warn");
    expect(modelsAuditExitCode(findings, "pricing")).toBe(0);
    expect(modelsAuditExitCode(findings, "sunset")).toBe(0);
  });

  test("an unsatisfiable `requires` fails; a satisfiable one passes", () => {
    // The compiler already refuses this at lower time (PR 7), so the slot is
    // constructed directly. The audit is the OFFLINE, post-compile twin: a
    // `pricing sync` can install a capability table that a bundle compiled
    // last month no longer satisfies, and nothing else would notice.
    const impossible = auditModelSlots(
      [
        {
          label: "agent.model",
          model: "claude-haiku-4-5",
          kind: "primary",
          requires: { contextWindowGte: 100_000_000 },
          swappable: true,
        },
      ],
      { sunsets: {} },
    );
    const cap = impossible.find((f) => f.kind === "capability");
    expect(cap?.severity).toBe("fail");
    expect(modelsAuditExitCode(impossible, "pricing")).toBe(1);

    const satisfiable = auditModelSlots(
      [
        {
          label: "agent.model",
          model: "claude-haiku-4-5",
          kind: "primary",
          requires: { tool_use: true },
          swappable: true,
        },
      ],
      { sunsets: {} },
    );
    expect(satisfiable.find((f) => f.kind === "capability")?.severity).toBe("pass");
    expect(modelsAuditExitCode(satisfiable, "pricing")).toBe(0);
  });

  test("a dropped parameter is a failure — the pinned value never reaches the wire", () => {
    const findings = auditModelSlots(slotsOf(HYBRID), {
      sunsets: {},
      project: () => ({
        model: "claude-haiku-4-5",
        maxTokens: 4096,
        dropped: ["temperature"],
        notes: ["Claude 5 rejects temperature alongside thinking"],
      }),
    });
    const params = findings.find((f) => f.kind === "params");
    expect(params?.severity).toBe("fail");
    expect(params?.detail).toContain("DROPS temperature");
    expect(modelsAuditExitCode(findings, "pricing")).toBe(1);
  });

  test("a provider that cannot project offline WARNS rather than passing", () => {
    const findings = auditModelSlots(slotsOf(HYBRID), { sunsets: {}, project: () => undefined });
    const params = findings.find((f) => f.kind === "params");
    expect(params?.severity).toBe("warn");
    expect(modelsAuditExitCode(findings, "pricing")).toBe(0);
  });

  test("an off-table provider warns about unknown capabilities instead of failing", () => {
    const local = `
name: local
target: cli
agent:
  model: local/llama-3@http://127.0.0.1:11434/v1
  instructions: hi
`;
    const findings = auditModelSlots(slotsOf(local), { sunsets: {} });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warn");
    expect(modelsAuditExitCode(findings, "sunset")).toBe(0);
  });
});

describe("models audit --propose (the sunset loop)", () => {
  test("emits the replacement patch for a retired, spec-addressable slot", () => {
    const findings = auditModelSlots(slotsOf(RETIRED), {
      sunsets: sunsets("2026-01-01"),
      today: new Date("2026-06-01T00:00:00Z"),
    });
    const proposal = buildSunsetProposal(findings, () => new Date("2026-06-02T00:00:00Z"));
    expect(proposal.patches).toHaveLength(1);
    expect(proposal.patches[0]?.patch).toEqual({
      op: "replace",
      path: ["agent", "model"],
      value: "claude-haiku-4-5",
    });
    expect(proposal.unaddressable).toHaveLength(0);
  });

  test("a retired ROSTER member is reported as unaddressable, never silently patched", () => {
    const rosterRetired = `
name: roster
target: cli
agent:
  model: claude-opus-5
  instructions: hi
  model_pool:
    candidates:
      - { model: claude-3-5-haiku-20241022, tags: [cheap] }
      - { model: claude-opus-5, tags: [strong] }
`;
    const findings = auditModelSlots(slotsOf(rosterRetired), {
      sunsets: sunsets("2026-01-01"),
      today: new Date("2026-06-01T00:00:00Z"),
    });
    const proposal = buildSunsetProposal(findings);
    expect(proposal.patches).toHaveLength(0);
    expect(proposal.unaddressable[0]?.reason).toContain("human-owned");
  });

  test("a clean spec proposes nothing", () => {
    const findings = auditModelSlots(slotsOf(HYBRID), { sunsets: {} });
    const proposal = buildSunsetProposal(findings);
    expect(proposal.patches).toHaveLength(0);
    expect(proposal.unaddressable).toHaveLength(0);
  });
});

describe("audition readiness (the n>=30 power floor)", () => {
  const arm = (model: string, n: number, meanReward: number, varReward = 0.01) => ({
    routeKey: "hard",
    model,
    n,
    meanReward,
    varReward,
  });
  const lane = (model: string, n: number, meanReward: number, varReward = 0.01) => ({
    ...arm(model, n, meanReward, varReward),
    routeKey: "shadow:hard",
  });

  test("REFUSES below the floor, naming the count (acceptance item 11)", () => {
    const verdict = auditionReadiness(
      { shadowArms: [lane("cand", 12, 0.9)], liveArms: [arm("primary", 100, 0.5)] },
      { shadowArm: "cand", primaryArm: "primary", minN: 30 },
    );
    expect(verdict.ready).toBe(false);
    expect(verdict.reason).toContain("12 observation(s)");
    expect(verdict.reason).toContain("power floor is 30");
  });

  test("REFUSES when the incumbent itself is under-measured", () => {
    const verdict = auditionReadiness(
      { shadowArms: [lane("cand", 100, 0.9)], liveArms: [arm("primary", 5, 0.5)] },
      { shadowArm: "cand", primaryArm: "primary", minN: 30 },
    );
    expect(verdict.ready).toBe(false);
    expect(verdict.reason).toContain("Both sides must clear it");
  });

  test("ready when the shadow's lower bound clears the incumbent's mean", () => {
    const verdict = auditionReadiness(
      { shadowArms: [lane("cand", 200, 0.9, 0.01)], liveArms: [arm("primary", 200, 0.5)] },
      { shadowArm: "cand", primaryArm: "primary", minN: 30 },
    );
    expect(verdict.ready).toBe(true);
    expect(verdict.shadowLowerBound).toBeGreaterThan(0.5);
  });

  test("NOT ready on a lead the interval does not separate", () => {
    const verdict = auditionReadiness(
      { shadowArms: [lane("cand", 40, 0.55, 0.25)], liveArms: [arm("primary", 40, 0.5)] },
      { shadowArm: "cand", primaryArm: "primary", minN: 30 },
    );
    expect(verdict.ready).toBe(false);
    expect(verdict.reason).toContain("keep auditioning");
  });

  /**
   * §7.10 "same-instrument is the rule". The incumbent's arm id ALWAYS
   * appears in the shadow lane (the lane records both sides of every graded
   * turn), so a flat arm list folded the incumbent's pairwise lane verdicts
   * into its absolute live mean. Splitting the two sides is what stops it.
   */
  test("the incumbent is folded from the LIVE bands only — lane rows never mix in", () => {
    const withLaneRows = auditionReadiness(
      {
        shadowArms: [lane("cand", 100, 0.9)],
        liveArms: [arm("primary", 100, 0.5)],
      },
      { shadowArm: "cand", primaryArm: "primary", minN: 30 },
    );
    // The primary's own lane rows (it lost the pairwise judging: quality 0)
    // are not part of `liveArms`, so they cannot drag its mean.
    expect(withLaneRows.primaryMean).toBe(0.5);
    expect(withLaneRows.primaryN).toBe(100);
  });
});

/**
 * §8.1 — the offline parameter projector loads three OPTIONAL adapters. The
 * CLI also ships as a compiled single binary, and `bun build --compile` only
 * embeds imports whose specifier it can see statically: an `import(name)`
 * whose specifier is a variable embeds nothing, so in the shipped binary
 * every one of those imports rejects, the `catch` swallows it, and `models
 * audit` degrades to "does not project its request parameters offline" for
 * every OpenAI / Gemini / Bedrock slot. The suite runs from source, so only a
 * check on the SOURCE can see the difference — this is it.
 */
describe("the optional adapter imports are statically analysable (compiled-binary safety)", () => {
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");

  test("each adapter is imported through a literal specifier", () => {
    for (const pkg of [
      "@crewhaus/adapter-openai",
      "@crewhaus/adapter-gemini",
      "@crewhaus/adapter-bedrock",
    ]) {
      expect(source.includes(`return import("${pkg}");`)).toBe(true);
    }
  });

  test("no adapter is imported through a VARIABLE specifier", () => {
    // Booleans, not the 22k-line source, so a failure prints a verdict.
    expect(source.includes("await import(name as any)")).toBe(false);
    expect(/await import\(\s*[A-Za-z_$]/.test(source)).toBe(false);
  });

  test("and each one is declared, so an installed CLI can resolve it", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8"),
    ) as { optionalDependencies?: Record<string, string> };
    for (const pkg of [
      "@crewhaus/adapter-openai",
      "@crewhaus/adapter-gemini",
      "@crewhaus/adapter-bedrock",
    ]) {
      expect(manifest.optionalDependencies?.[pkg]).toBeDefined();
    }
  });
});
