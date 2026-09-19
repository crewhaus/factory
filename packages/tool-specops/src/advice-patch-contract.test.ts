import { describe, expect, it } from "bun:test";
/**
 * THE CONTRACT BETWEEN THE ADVISOR AND THE APPLIER.
 *
 * `crewhaus advise`'s rules propose `SpecPatch`es. `SpecPatchApply` decides
 * which patches may be applied, from `OPTIMIZABLE_PATHS`. Nothing before this
 * file proved the two agree, and both failure directions are real:
 *
 *   1. A rule proposing a path the applier refuses would emit a suggestion an
 *      autonomous caller cannot use - worse than no suggestion, because it
 *      costs a round trip and a refusal to learn nothing. The advice package
 *      pre-validates through `patchOrAdvice`, so the visible symptom is not a
 *      refusal but SILENCE: the finding quietly arrives as advice text. A
 *      test that only asserted "a finding appeared" would pass through that.
 *      So these tests assert `suggestion.kind === "spec-patch"` and then feed
 *      the patch to the real tool.
 *
 *   2. A path drifting OUT of the allow-list, or a new rule landing with a
 *      path that was never in it. That cannot be caught by exercising the
 *      rules we already know about, so the second half of this file SCANS the
 *      advice source for every patch site and asserts the hit count first -
 *      a scanning guard that finds nothing must fail, not pass, which is
 *      exactly how two earlier drift guards in this repository went vacuous.
 *
 * Tests are given explicit budgets: CI runs these on a loaded two-core box
 * where a local 50ms is seconds.
 */
import { readFileSync } from "node:fs";
import {
  type AdviceFinding,
  type AdviceRule,
  type SessionEvents,
  buildAdviceContext,
  parseJsonlObjects,
  ruleCompactionThrash,
  ruleEscalationPrecision,
  ruleFailureTaxonomy,
  rulePoolPolicyUpgrade,
  rulePoolStaleExploitation,
  ruleTruncationPressure,
  runAdviceRules,
} from "@crewhaus/harness-advice/advise-rules";
import { parseSpec } from "@crewhaus/spec";
import {
  OPTIMIZABLE_PATHS,
  type SpecPatch,
  isOptimizable,
  specHasPath,
} from "@crewhaus/spec-patch";
import * as fx from "./fixtures";
import { specPatchApply } from "./index";

const BUDGET_MS = 30_000;

function session(sessionId: string, lines: ReadonlyArray<unknown>): SessionEvents {
  return { sessionId, objects: parseJsonlObjects(fx.jsonl(lines)) };
}

/** Run a patch through the REAL tool, exactly as a caller would. */
async function applyThroughTool(
  specYaml: string,
  patch: SpecPatch,
): Promise<Record<string, unknown>> {
  const out = String(
    await specPatchApply.execute({
      spec: specYaml,
      patches: [
        {
          path: [...patch.path],
          op: patch.op,
          ...(patch.value !== undefined ? { value: patch.value } : {}),
        },
      ],
    }),
  );
  return JSON.parse(out) as Record<string, unknown>;
}

type PatchCase = {
  readonly findingId: string;
  readonly rule: AdviceRule;
  readonly specYaml: string;
  readonly sessions: ReadonlyArray<SessionEvents>;
  readonly arms: ReadonlyArray<ReturnType<typeof fx.arm>>;
};

/**
 * One entry per rule that can propose a patch. The count is asserted against
 * the source scan below, so a rule added upstream cannot quietly skip this
 * table.
 */
const PATCH_CASES: ReadonlyArray<PatchCase> = [
  {
    findingId: "truncation-pressure",
    rule: ruleTruncationPressure,
    specYaml: fx.CLI_SPEC_YAML,
    sessions: [session("sess_a", fx.recoveryLines("MaxTokensError", "continue", 3))],
    arms: [],
  },
  {
    findingId: "compaction-thrash",
    rule: ruleCompactionThrash,
    specYaml: fx.CLI_SPEC_YAML,
    sessions: [session("sess_a", fx.compactionLines(4))],
    arms: [],
  },
  {
    findingId: "failure-taxonomy-learned",
    rule: ruleFailureTaxonomy,
    specYaml: fx.CLI_SPEC_YAML,
    sessions: [session("sess_a", fx.recoveryLines("OverloadedError", "retry", 4))],
    arms: [],
  },
  {
    findingId: "pool-policy-upgrade",
    rule: rulePoolPolicyUpgrade,
    specYaml: fx.POOL_SPEC_YAML,
    sessions: [],
    arms: fx.fullCoverageArms(30),
  },
  {
    findingId: "pool-stale-exploitation",
    rule: rulePoolStaleExploitation,
    specYaml: fx.LEARNED_POOL_SPEC_YAML,
    sessions: [],
    arms: fx.fullCoverageArms(30),
  },
  {
    findingId: "escalation-precision:code-goes-cheap",
    rule: ruleEscalationPrecision,
    specYaml: fx.RULED_SPEC_YAML,
    sessions: [session("sess_a", fx.noisyCascadeLines())],
    arms: [],
  },
];

function fire(c: PatchCase): AdviceFinding {
  const ctx = buildAdviceContext([...c.sessions], [], [...c.arms]);
  const spec = parseSpec(c.specYaml);
  const findings = c.rule(ctx, {
    spec,
    specHasPath: (p: readonly string[]) => specHasPath(c.specYaml, p),
  });
  const found = findings.find((f) => f.id === c.findingId);
  if (found === undefined) {
    throw new Error(
      `fixture no longer trips ${c.findingId} (got: ${findings.map((f) => f.id).join(", ") || "nothing"}) - the rule's thresholds moved, so this contract is being asserted against nothing`,
    );
  }
  return found;
}

describe("every rule that proposes a patch proposes one the applier accepts", () => {
  for (const c of PATCH_CASES) {
    it(
      `${c.findingId} emits a patch, and SpecPatchApply applies it`,
      async () => {
        const finding = fire(c);
        // The silent-degradation guard. `patchOrAdvice` swallows a patch the
        // whitelist refuses and returns advice text instead, so "the finding
        // appeared" proves nothing: this assertion is the one that fails when
        // the two lists disagree.
        expect({ id: finding.id, kind: finding.suggestion.kind }).toEqual({
          id: c.findingId,
          kind: "spec-patch",
        });
        if (finding.suggestion.kind !== "spec-patch") return;
        const patch = finding.suggestion.patch;
        console.log(
          `CONTRACT ${c.findingId} -> ${patch.op} ${patch.path.join(".")} = ${JSON.stringify(patch.value)}`,
        );

        // Both halves of the agreement, separately: the path the allow-list
        // admits, and the edit the CST + parseSpec round trip survives.
        expect({
          path: patch.path.join("."),
          optimizable: isOptimizable(patch.target, patch.path),
        }).toEqual({ path: patch.path.join("."), optimizable: true });

        const result = await applyThroughTool(c.specYaml, patch);
        expect({ id: c.findingId, ok: result["ok"], applied: result["applied"] }).toEqual({
          id: c.findingId,
          ok: true,
          applied: 1,
        });
        // The edit actually landed in the document, not merely "did not throw".
        const yaml = String(result["yaml"]);
        expect(specHasPath(yaml, patch.path)).toBe(true);
        expect(result["changed"]).toBe(true);
      },
      BUDGET_MS,
    );
  }

  it(
    "a whole advise pass over one harness yields only applyable patches",
    async () => {
      // Everything at once, through the top-level entry point a driver calls,
      // rather than rule by rule: a rule that only misbehaves in company shows
      // up here.
      const ctx = buildAdviceContext(
        [
          session("sess_a", [
            ...fx.recoveryLines("MaxTokensError", "continue", 3),
            ...fx.recoveryLines("OverloadedError", "retry", 4),
            ...fx.compactionLines(4),
            ...fx.noisyCascadeLines(),
          ]),
        ],
        [],
        fx.fullCoverageArms(30),
      );
      const spec = parseSpec(fx.RULED_SPEC_YAML);
      const findings = runAdviceRules(ctx, {
        spec,
        specHasPath: (p: readonly string[]) => specHasPath(fx.RULED_SPEC_YAML, p),
      });
      const patches = findings.flatMap((f) =>
        f.suggestion.kind === "spec-patch" ? [{ id: f.id, patch: f.suggestion.patch }] : [],
      );
      console.log(
        `ADVISE_PASS findings=${findings.length} patches=${patches.length} ids=${patches.map((p) => p.id).join(",")}`,
      );
      // A pass that produced no patches would satisfy "every patch applies"
      // vacuously. This fixture trips at least four patch-proposing rules.
      expect(patches.length).toBeGreaterThanOrEqual(4);
      const refused: string[] = [];
      for (const { id, patch } of patches) {
        const result = await applyThroughTool(fx.RULED_SPEC_YAML, patch);
        if (result["ok"] !== true) {
          refused.push(`${id}: ${JSON.stringify(result["refused"] ?? result["failedAt"])}`);
        }
      }
      expect(refused).toEqual([]);
    },
    BUDGET_MS,
  );
});

// ---------------------------------------------------------------------------
// the drift guard: every patch site in the advice source, not just the ones
// this file already knows about
// ---------------------------------------------------------------------------

/**
 * Patch sites in `advise-rules.ts` today. The number is asserted BEFORE the
 * paths are checked: a scan that matched nothing would otherwise report every
 * path as fine, which is how a guard becomes decorative.
 */
const EXPECTED_PATCH_SITES = 6;

const PATCH_SITE_RE = /path:\s*\[([^\]]*)\]/g;
const QUOTED_SEGMENT_RE = /^"([^"]*)"$/;

function scanPatchPaths(source: string): Array<{ line: number; path: string[] }> {
  const out: Array<{ line: number; path: string[] }> = [];
  source.split("\n").forEach((raw, i) => {
    const text = raw.trim();
    if (text.startsWith("*") || text.startsWith("//")) return; // prose, not code
    for (const m of text.matchAll(PATCH_SITE_RE)) {
      const inner = m[1] ?? "";
      const segments = inner
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "")
        .map((s) => {
          // A computed segment (`String(dominant.index)`) is a sequence index
          // at runtime; "0" stands in for it, which is what the wildcard in
          // the allow-list has to match anyway.
          const quoted = s.match(QUOTED_SEGMENT_RE);
          return quoted?.[1] ?? "0";
        });
      out.push({ line: i + 1, path: segments });
    }
  });
  return out;
}

describe("the advice source and the allow-list, scanned rather than remembered", () => {
  const sourcePath = Bun.resolveSync("@crewhaus/harness-advice/advise-rules", import.meta.dir);
  const source = readFileSync(sourcePath, "utf8");

  it("finds every patch site, and says how many", () => {
    const sites = scanPatchPaths(source);
    console.log(
      `SCAN ${sourcePath.split("/").slice(-2).join("/")} sites=${sites.length} ${sites.map((s) => s.path.join(".")).join(" | ")}`,
    );
    // Asserted first and exactly. Fewer means the scan broke (a path written
    // across lines, a renamed field) and every assertion below it went
    // vacuous; more means a new rule landed and belongs in PATCH_CASES.
    expect(sites.length).toBe(EXPECTED_PATCH_SITES);
    expect(sites.length).toBe(PATCH_CASES.length);
  });

  it("every scanned path is one the applier admits", () => {
    const sites = scanPatchPaths(source);
    expect(sites.length).toBe(EXPECTED_PATCH_SITES);
    // The rules default to `target: spec?.target ?? "cli"`, so cli is the
    // target every one of these paths must hold for.
    const rejected = sites
      .filter((s) => !isOptimizable("cli", s.path))
      .map((s) => `advise-rules.ts:${s.line} ${s.path.join(".")}`);
    expect(rejected).toEqual([]);
  });

  it("every scanned path is admitted on the pooled shape too", () => {
    const sites = scanPatchPaths(source);
    expect(sites.length).toBe(EXPECTED_PATCH_SITES);
    const spec = parseSpec(fx.RULED_SPEC_YAML);
    // A block patch carrying a refused leaf is checked by `validatePatch`
    // against a VALUE, which a static scan does not have; the path-level half
    // is what the scan can assert, and it is asserted against a real spec's
    // target rather than a hardcoded one.
    const problems = sites
      .filter((s) => !isOptimizable(spec.target, s.path))
      .map((s) => s.path.join("."));
    expect(problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the other direction: what the applier refuses, and how well it says so
// ---------------------------------------------------------------------------

describe("refusals name the rule that owns the path", () => {
  const cases: ReadonlyArray<{ path: string[]; reason: RegExp }> = [
    { path: ["agent", "model"], reason: /roster/i },
    { path: ["agent", "model_pool", "candidates"], reason: /roster/i },
    { path: ["permissions", "mode"], reason: /OPTIMIZABLE_PATHS/ },
    { path: ["agent", "model_pool", "learning", "seed"], reason: /seed|not optimizable/i },
  ];

  for (const c of cases) {
    it(`${c.path.join(".")} is refused with a reason`, async () => {
      const out = JSON.parse(
        String(
          await specPatchApply.execute({
            spec: fx.POOL_SPEC_YAML,
            patches: [{ path: c.path, op: "replace", value: "x" }],
          }),
        ),
      ) as Record<string, unknown>;
      const refused = out["refused"] as Array<Record<string, unknown>> | undefined;
      console.log(`REFUSAL ${c.path.join(".")} -> ${JSON.stringify(refused?.[0])}`);
      expect({ ok: out["ok"], applied: out["applied"], count: refused?.length }).toEqual({
        ok: false,
        applied: 0,
        count: 1,
      });
      const first = (refused ?? [])[0] as Record<string, unknown>;
      const prose = `${String(first["reason"])} ${String(first["humanOwned"] ?? "")}`;
      // The REASON, not merely a refusal: an assertion that only checked
      // ok:false would also pass on a crash or a parse failure.
      expect(prose).toMatch(c.reason);
    });
  }

  it("a REMOVE cannot unpin the seed a REPLACE is refused for changing", async () => {
    // The same edit, two spellings. `validatePatch`'s block guard asks what a
    // patch's VALUE would change and so returns at its first line for a remove
    // (whose value is undefined by definition), while `isOptimizable` only
    // refuses the seed's own PATH. Between the two, `remove` of the parent
    // block deleted the pinned seed and reported ok:true, applied:1 - the
    // routed eval's pin gone, and every later measured delta incomparable.
    const replaced = JSON.parse(
      String(
        await specPatchApply.execute({
          spec: fx.SEEDED_POOL_SPEC_YAML,
          patches: [
            {
              path: ["agent", "model_pool", "learning"],
              op: "replace",
              value: { explorationRate: 0.5 },
            },
          ],
        }),
      ),
    ) as Record<string, unknown>;
    const replaceReason = String(
      (replaced["refused"] as Array<Record<string, unknown>>)[0]?.["reason"],
    );
    expect(replaceReason).toMatch(/seed/i);

    const removed = JSON.parse(
      String(
        await specPatchApply.execute({
          spec: fx.SEEDED_POOL_SPEC_YAML,
          patches: [{ path: ["agent", "model_pool", "learning"], op: "remove" }],
        }),
      ),
    ) as Record<string, unknown>;
    const refused = removed["refused"] as Array<Record<string, unknown>> | undefined;
    console.log(`SEED_REMOVE ${JSON.stringify(refused?.[0])}`);
    expect({ ok: removed["ok"], applied: removed["applied"], count: refused?.length }).toEqual({
      ok: false,
      applied: 0,
      count: 1,
    });
    // The REASON, not just ok:false - a crash or an unparseable fixture would
    // satisfy the bare refusal too - and specifically the seed's reason, so a
    // future refusal for some other cause cannot stand in for this one.
    expect(String(refused?.[0]?.["reason"])).toMatch(
      /agent\.model_pool\.learning\.seed.*not optimizable/is,
    );
    // And the document is untouched: no `yaml` came back to write.
    expect(removed["yaml"]).toBeUndefined();
  });

  it("but a learning block that pins nothing is still removable", async () => {
    // The guard asks whether the leaf is THERE, never whether the path shape
    // looks like it might be: refusing a block that carries no seed would be a
    // guess, and guessing "no" is the same defect in the other direction.
    const out = JSON.parse(
      String(
        await specPatchApply.execute({
          spec: fx.UNSEEDED_POOL_SPEC_YAML,
          patches: [{ path: ["agent", "model_pool", "learning"], op: "remove" }],
        }),
      ),
    ) as Record<string, unknown>;
    console.log(`UNSEEDED_REMOVE ok=${String(out["ok"])} applied=${String(out["applied"])}`);
    // The fixture really does differ from the seeded one, or this test is
    // asserting the same document twice.
    expect(fx.UNSEEDED_POOL_SPEC_YAML).not.toBe(fx.SEEDED_POOL_SPEC_YAML);
    expect(fx.SEEDED_POOL_SPEC_YAML).toContain("seed:");
    expect(fx.UNSEEDED_POOL_SPEC_YAML).not.toContain("seed:");
    expect({ ok: out["ok"], applied: out["applied"] }).toEqual({ ok: true, applied: 1 });
  });

  it("the doctor fixer's own spec path is NOT on the optimizer surface", async () => {
    // `DoctorFix` writes `tool_config.<tool>.scope: external` through
    // applySpecPatch directly, deliberately NOT through this allow-list -
    // `tool_config` is not tunable and must not become tunable by a caller
    // routing a doctor fix through SpecPatchApply. Both halves are asserted so
    // that widening either one fails here.
    expect(isOptimizable("cli", ["tool_config", "Fetch", "scope"])).toBe(false);
    const out = JSON.parse(
      String(
        await specPatchApply.execute({
          spec: fx.CLI_SPEC_YAML,
          patches: [{ path: ["tool_config", "Fetch", "scope"], op: "add", value: "external" }],
        }),
      ),
    ) as Record<string, unknown>;
    expect(out["ok"]).toBe(false);
  });
});

describe("the same rule, a different shape", () => {
  it(
    "agent.max_tokens and compaction.curate are tunable on cli ONLY - elsewhere the same finding arrives as advice",
    () => {
      // Pinned, not incidental. A channel spec accepts both leaves (the schema
      // has them), the truncation and compaction rules propose them on every
      // target, and the allow-list admits them only for cli - so on the other
      // thirteen shapes those two findings silently lose their patch and
      // arrive as text. That is the allow-list's call to make, and this test
      // is here so that widening or narrowing it is a decision someone takes
      // deliberately rather than discovers.
      const targets = Object.keys(OPTIMIZABLE_PATHS) as Array<keyof typeof OPTIMIZABLE_PATHS>;
      const admits = targets.filter(
        (t) =>
          isOptimizable(t, ["agent", "max_tokens"]) && isOptimizable(t, ["compaction", "curate"]),
      );
      console.log(`CLI_ONLY_DIALS targets=${targets.length} admitting=${admits.join(",")}`);
      expect(admits).toEqual(["cli"]);

      const ctx = buildAdviceContext(
        [session("sess_a", fx.recoveryLines("MaxTokensError", "continue", 3))],
        [],
        [],
      );
      const channelFindings = ruleTruncationPressure(ctx, {
        spec: parseSpec(fx.CHANNEL_SPEC_YAML),
      });
      expect(channelFindings[0]?.suggestion.kind).toBe("advice");
      const cliFindings = ruleTruncationPressure(ctx, { spec: parseSpec(fx.CLI_SPEC_YAML) });
      expect(cliFindings[0]?.suggestion.kind).toBe("spec-patch");
    },
    BUDGET_MS,
  );
});
