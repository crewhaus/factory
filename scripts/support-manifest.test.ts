/**
 * The support manifest (`@crewhaus/ir/support`) is generated from the
 * compiler, so these tests hold the checked-in data to a fresh generation, the
 * probe list to the schemas, and the generator to its rules: a setting that
 * changes nothing and says nothing fails here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { INFORMATIONAL_COMPILE_WARNING_CODES } from "../apps/cli/src/compile-warnings";
import { ABSENT_CORPUS } from "../packages/compiler/src/absent-corpus";
import { CF_WORKER_ENFORCED_KEYS, compile, unwiredRows } from "../packages/compiler/src/index";
import {
  FEATURE_PROBES,
  type FeatureProbe,
  STRUCTURAL_KEYS,
  SUPPORT_RELEASE,
} from "../packages/compiler/src/support-probes";
import { COMPILER_FEATURE_KEYS } from "../packages/control-contract/src/areas/compiler-features.generated";
import { SHAPE_RUN_CONTROLS } from "../packages/control-contract/src/run-controls";
import { CURATE_WIRED_TARGETS } from "../packages/ir/src/loop";
import type { SupportCell, SupportManifest } from "../packages/ir/src/support";
import { SUPPORT_MANIFEST } from "../packages/ir/src/support.generated";
import { DELTA_090_KEYS } from "../packages/spec-patch/src/owner-keys";
import {
  type Outcome,
  SHAPES,
  codeOf,
  compilerFeatureKeys,
  coverageProblems,
  deriveCell,
  edgeAdmission,
  edgeGatedLeaves,
  enforcedRowFor,
  pathsOverlap,
  readCheckedIn,
  releasedNewerThan,
  safetySubKeys,
  schemaKeys,
  shapeCells,
  statusForCode,
  variantsOf,
} from "./gen-support-manifest";

const ROOT = dirname(import.meta.dir);
const CHECKED_IN = SUPPORT_MANIFEST;

describe("the checked-in manifest equals a fresh generation", () => {
  for (const shape of SHAPES) {
    test(`${shape}`, () => {
      const fresh = shapeCells(shape, { previous: CHECKED_IN });
      for (const variant of variantsOf(shape)) {
        const checked: Record<string, SupportCell> = {};
        const generated: Record<string, SupportCell> = {};
        for (const [feature, record] of Object.entries(CHECKED_IN.features)) {
          const cell = record.cells[variant];
          if (cell !== undefined) checked[feature] = cell;
        }
        for (const [feature, cells] of Object.entries(fresh)) {
          const cell = cells[variant];
          if (cell !== undefined) generated[feature] = cell;
        }
        expect(
          checked,
          `${variant}: run \`bun scripts/gen-support-manifest.ts\` and commit what it writes`,
        ).toEqual(generated);
      }
      // Slow by construction: it compiles every probe for this shape, twice.
    }, 120_000);
  }

  test("the JSON copy and the TypeScript data are the same data", () => {
    expect(readCheckedIn()).toEqual(JSON.parse(JSON.stringify(CHECKED_IN)));
  });

  test("the features, their kinds and paths match the probes, and the keys match the features", () => {
    expect(Object.keys(CHECKED_IN.features)).toEqual(FEATURE_PROBES.map((p) => p.feature));
    for (const probe of FEATURE_PROBES) {
      const record = CHECKED_IN.features[probe.feature];
      expect(record?.kind).toBe(probe.kind);
      expect(record?.at).toEqual(probe.at ?? [probe.feature]);
    }
    expect([...COMPILER_FEATURE_KEYS]).toEqual(compilerFeatureKeys(CHECKED_IN));
    expect(CHECKED_IN.shapes).toEqual([...SHAPES]);
    expect(CHECKED_IN.generatedBy).toBe(SUPPORT_RELEASE);
  });

  test("controls is control-contract's run-control table", () => {
    expect(CHECKED_IN.controls).toEqual(JSON.parse(JSON.stringify(SHAPE_RUN_CONTROLS)));
  });
});

describe("every setting has a probe", () => {
  const keys = schemaKeys();
  const delta = DELTA_090_KEYS.map((row) => [...row.pattern]);

  test("the probes cover every schema key, the structural list holds, and every 0.9.0 key is probed", () => {
    expect(coverageProblems(FEATURE_PROBES, STRUCTURAL_KEYS, keys, delta, safetySubKeys())).toEqual(
      [],
    );
    expect(keys.size).toBeGreaterThan(50);
  });

  test("every sub-key of a safety block has a probe of its own", () => {
    const safety = safetySubKeys();
    for (const path of [
      "permissions.mode",
      "permissions.rules",
      "permissions.ask_mode",
      "limits.turn_timeout_ms",
      "limits.model_call_timeout_ms",
      "limits.max_concurrent_tools",
      "limits.loop_detection.escalation",
      "budget.usd",
      "budget.judge_share",
      "security.egressMatcher",
      "security.justification.judge",
    ]) {
      expect(safety, path).toContain(path);
    }
    const probes = FEATURE_PROBES.filter((p) => p.feature !== "limits.turn_timeout_ms");
    expect(coverageProblems(probes, STRUCTURAL_KEYS, keys, delta, safety)).toEqual([
      "safety setting limits.turn_timeout_ms has no probe of its own",
    ]);
  });

  test("a schema key with no probe fails, naming it", () => {
    const planted = new Map(keys);
    planted.set("planted_key", { optional: ["cli"], required: [], defaulted: [] });
    expect(coverageProblems(FEATURE_PROBES, STRUCTURAL_KEYS, planted, delta)).toEqual([
      "planted_key has no probe",
    ]);
  });

  test("a structural entry for a key that is optional everywhere fails: the exemption list is checked", () => {
    const structural = [...STRUCTURAL_KEYS, { key: "budget", reason: "planted" }];
    const probes = FEATURE_PROBES.filter((p) => p.feature !== "budget");
    expect(coverageProblems(probes, structural, keys, delta)).toEqual([
      "structural key budget is optional on every schema: it needs a probe",
    ]);
  });

  test("a 0.9.0 key with no probe fails", () => {
    const probes = FEATURE_PROBES.filter((p) => p.feature !== "intent");
    const problems = coverageProblems(probes, [...STRUCTURAL_KEYS], keys, delta);
    expect(problems).toContain("0.9.0 key intent has no probe");
    expect(DELTA_090_KEYS.length).toBeGreaterThan(0);
  });

  test("each toolchain probe names a file that reads its key", () => {
    const toolchain = FEATURE_PROBES.filter((p) => p.kind === "toolchain");
    expect(toolchain.length).toBeGreaterThan(0);
    for (const probe of toolchain) {
      expect(probe.readBy, probe.feature).toBeDefined();
      const source = readFileSync(join(ROOT, probe.readBy as string), "utf8");
      const leaf = probe.feature.split(".").at(-1) as string;
      const camel = leaf.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
      expect(source.includes(leaf) || source.includes(camel), probe.feature).toBe(true);
    }
  });
});

describe("the generator's rules", () => {
  const compiled = (
    files: Record<string, string>,
    warnings: Array<{ code: string; path: string; message: string }> = [],
  ): Outcome => ({ kind: "compiled", files: new Map(Object.entries(files)), warnings });
  const probe = (kind: FeatureProbe["kind"] = "runtime"): FeatureProbe => ({
    feature: "planted",
    kind,
    snippet: { planted: true },
  });

  test("a setting that changes nothing and says nothing throws, naming the feature and the shape", () => {
    const same = compiled({ "agent.ts": "x" });
    expect(() => deriveCell(probe(), "voice", "planted", same, same)).toThrow(
      "planted on voice changes nothing and says nothing",
    );
  });

  test("a planted probe list with an inert snippet fails the generation", () => {
    const inert: FeatureProbe = {
      feature: "intent",
      kind: "runtime",
      snippet: { intent: { purpose: "Planted." } },
    };
    expect(() => shapeCells("voice", { probes: [inert] })).toThrow(
      "intent on voice changes nothing and says nothing",
    );
  });

  test("an authoring probe that changes bytes throws", () => {
    const changing: FeatureProbe = {
      feature: "budget",
      kind: "authoring",
      snippet: { budget: { usd: 5, on_exceed: { action: "stop" } } },
    };
    expect(() => shapeCells("cli", { probes: [changing] })).toThrow(
      "budget on cli is an authoring probe but changes the build",
    );
  });

  test("a change that is only a comment counts as no change", () => {
    const before = compiled({ "agent.ts": "run();\n" });
    const noted = compiled({
      "agent.ts": "// note: planted configured but ignored\nrun();\n",
      "wrangler.toml": "# planted\n",
    });
    expect(() => deriveCell(probe(), "voice", "planted", before, noted)).toThrow(
      "planted on voice changes nothing and says nothing",
    );
    const coded = compiled({ "agent.ts": "run(); // planted\n" });
    expect(deriveCell(probe(), "voice", "planted", before, coded)).toEqual({
      status: "wired",
      via: ["bundle"],
    });
    expect(codeOf("worker.js", "/**\n * doc\n */\nx();")).toBe("x();");
  });

  test("a cf-worker build that meets a setting by how it runs reads wired by construction", () => {
    const same = compiled({ "worker.js": "x" });
    expect(
      deriveCell(probe(), "cli@cf-worker", "planted", same, same, { constructed: true }),
    ).toEqual({ status: "wired", via: ["construction"] });
    // Without the allow-list's word, the same build is still a setting that does nothing.
    expect(() => deriveCell(probe(), "cli@cf-worker", "planted", same, same)).toThrow(
      "planted on cli@cf-worker changes nothing and says nothing",
    );
    expect(edgeAdmission({ limits: { max_concurrent_tools: 2 } })).toBe("construction");
    expect(edgeAdmission({ limits: { max_tool_iterations: 7 } })).toBe("config");
    expect(edgeAdmission({ limits: { loop_detection: { escalation: "justify" } } })).toBe(
      "refused",
    );
    expect(edgeAdmission({ budget: { usd: 5 } })).toBe("refused");
    expect(edgeAdmission({ steps: [{ model_pool: { candidates: [] } }] })).toBeUndefined();
    expect(
      edgeAdmission({ steps: [{ model_pool: { strategy: { cascade: { draft: "a" } } } }] }),
    ).toBe("refused");
    expect(edgeAdmission({ memory: { backend: "file" } })).toBeUndefined();
  });

  test("a key the shape's schema requires reads wired by structure", () => {
    const retrieve = FEATURE_PROBES.filter((p) => p.feature === "retrieve");
    expect(shapeCells("pipeline", { probes: retrieve })["retrieve"]?.["pipeline"]).toEqual({
      status: "wired",
      via: ["structure"],
      since: SUPPORT_RELEASE,
    });
    expect(CHECKED_IN.features["chains"]?.cells["onchain"]?.via).toEqual(["structure"]);
    expect(CHECKED_IN.features["routing"]?.cells["channel"]?.via).toEqual(["structure"]);
  });

  test("README.md and package.json changes do not count", () => {
    const before = compiled({ "README.md": "a", "package.json": "a", "agent.ts": "x" });
    const after = compiled({ "README.md": "b", "package.json": "b", "agent.ts": "x" });
    expect(() => deriveCell(probe(), "cli", "planted", before, after)).toThrow(
      "changes nothing and says nothing",
    );
    expect(deriveCell(probe("authoring"), "cli", "planted", before, after)).toEqual({
      status: "authoring",
    });
  });

  test("statuses: an informational code is degraded, accepted-but-unwired and the rest are unwired", () => {
    expect(statusForCode(INFORMATIONAL_COMPILE_WARNING_CODES[0] as string)).toBe("degraded");
    expect(statusForCode("accepted-but-unwired")).toBe("unwired");
    expect(statusForCode("model-plan-ignored-on-shape")).toBe("unwired");
    const base = compiled({ "agent.ts": "x" });
    const noted = compiled({ "agent.ts": "y" }, [
      { code: "channel-plugins-at-start", path: "plugins", message: "loads at start" },
    ]);
    expect(deriveCell(probe(), "channel", "plugins", base, noted)).toEqual({
      status: "degraded",
      code: "channel-plugins-at-start",
      reason: "loads at start",
    });
    const unwired = compiled({ "agent.ts": "x" }, [
      { code: "accepted-but-unwired", path: "watchme", message: "not here" },
    ]);
    expect(deriveCell(probe(), "managed", "watchme.capture", base, unwired)).toEqual({
      status: "unwired",
      code: "accepted-but-unwired",
      reason: "not here",
    });
  });

  test("a warning counts only at the setting's path, at a segment boundary", () => {
    expect(pathsOverlap("permissions", "permissions.ask_mode")).toBe(true);
    expect(pathsOverlap("steps[0].model_pool.strategy.cascade", "steps[0].model_pool")).toBe(true);
    expect(pathsOverlap("memory", "memory.wiki")).toBe(true);
    expect(pathsOverlap("memoryX", "memory")).toBe(false);
    expect(pathsOverlap("tools", "tool_config")).toBe(false);
  });

  test("a parse failure is rejected, and a compiler refusal is rejected with its message", () => {
    const base = compiled({ "agent.ts": "x" });
    const parse: Outcome = {
      kind: "rejected",
      reason: "eval harnesses do not accept this setting",
      parse: true,
    };
    expect(deriveCell(probe(), "eval", "planted", base, parse)).toEqual({
      status: "rejected",
      reason: "eval harnesses do not accept this setting",
    });
    // A real refusal from the compiler: a graph node no edge reaches.
    const cells = shapeCells("graph", {
      probes: [
        {
          feature: "planted",
          kind: "runtime",
          snippet: { nodes: { orphan: { instructions: "Nobody reaches me." } } },
        },
      ],
    });
    expect(cells["planted"]?.["graph"]?.status).toBe("rejected");
    expect(cells["planted"]?.["graph"]?.reason).toContain("unreachable");
  });

  test("since carries forward while a cell keeps its status, and a flipped cell gets this release", () => {
    const watchme = FEATURE_PROBES.filter((p) => p.feature === "watchme");
    const previous: SupportManifest = {
      ...CHECKED_IN,
      features: {
        watchme: {
          kind: "runtime",
          at: ["watchme"],
          cells: {
            cli: { status: "wired", since: "0.8.0", via: ["bundle"] },
            managed: { status: "wired", since: "0.8.0", via: ["bundle"] },
          },
        },
      },
    };
    const cli = shapeCells("cli", { probes: watchme, previous })["watchme"]?.["cli"];
    expect(cli).toEqual({ status: "wired", via: ["bundle"], since: "0.8.0" });
    const managed = shapeCells("managed", { probes: watchme, previous })["watchme"]?.["managed"];
    expect(managed?.status).toBe("unwired");
    expect(managed?.since).toBe(SUPPORT_RELEASE);
  });

  test("the CHANGELOG has shipped no release newer than SUPPORT_RELEASE", () => {
    const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    expect(
      releasedNewerThan(changelog, SUPPORT_RELEASE),
      "a release newer than SUPPORT_RELEASE shipped: bump it in packages/compiler/src/support-probes.ts to the next release line and regenerate",
    ).toEqual([]);
    expect(releasedNewerThan("## [0.9.1] - 2026-12-01\n", "0.9.0")).toEqual(["0.9.1"]);
    // The release that ships this line adds its own heading, and passes.
    expect(releasedNewerThan("## [0.9.0] - 2026-12-01\n## [Unreleased]\n", "0.9.0")).toEqual([]);
  });
});

describe("a Cloudflare Worker build agrees with the edge allow-list", () => {
  const cfShapes = CHECKED_IN.variants["cf-worker"];

  test("every gated setting reads refused, or enforced as the allow-list says", () => {
    let checked = 0;
    for (const probe of FEATURE_PROBES) {
      const record = CHECKED_IN.features[probe.feature];
      for (const shape of cfShapes) {
        const placement = probe.place?.(shape) ?? {
          path: probe.feature,
          snippet: probe.snippet,
          ...(probe.base !== undefined ? { base: probe.base } : {}),
        };
        const admission = edgeAdmission(placement.snippet);
        if (admission === undefined) continue;
        const cell = record?.cells[`${shape}@cf-worker`];
        const where = `${probe.feature} on ${shape}@cf-worker`;
        const baseRefused =
          placement.base !== undefined && edgeAdmission(placement.base) === "refused";
        if (admission === "refused" || baseRefused) {
          expect(cell?.status, where).toBe("rejected");
        } else if (admission === "construction") {
          expect(cell, where).toMatchObject({ status: "wired", via: ["construction"] });
        } else if (
          cell?.status !== "rejected" ||
          !/harnesses do not accept/.test(cell.reason ?? "")
        ) {
          // The worker reads it: the build differs.
          expect(cell?.status, where).toBe("wired");
          expect(cell?.via, where).toContain("bundle");
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(60);
  });

  test("every allow-list row is probed, and every construction row reads wired by construction", () => {
    for (const row of CF_WORKER_ENFORCED_KEYS) {
      const probes = FEATURE_PROBES.filter((probe) =>
        edgeGatedLeaves(probe.snippet).some((leaf) => enforcedRowFor(leaf) === row),
      );
      expect(probes.length, row.path).toBeGreaterThan(0);
      if (row.enforcedBy !== "construction") continue;
      for (const probe of probes) {
        for (const shape of cfShapes) {
          expect(
            CHECKED_IN.features[probe.feature]?.cells[`${shape}@cf-worker`]?.via,
            row.path,
          ).toEqual(["construction"]);
        }
      }
    }
  });

  test("cf_worker.public_chat takes effect only in a Worker build, and a local build says so", () => {
    const cells = CHECKED_IN.features["cf_worker.public_chat"]?.cells ?? {};
    for (const shape of cfShapes) {
      expect(cells[shape], shape).toMatchObject({
        status: "unwired",
        code: "accepted-but-unwired",
      });
      expect(cells[`${shape}@cf-worker`], shape).toMatchObject({
        status: "degraded",
        code: "edge-public-chat",
      });
      const local = compile(`${ABSENT_CORPUS[shape as "cli"]}cf_worker: { public_chat: true }\n`, {
        readme: false,
      });
      expect(
        local.warnings.filter((w) => w.path === "cf_worker.public_chat").map((w) => w.code),
      ).toEqual(["accepted-but-unwired"]);
    }
  });
});

describe("the 0.8.0 boundary, by name", () => {
  const cell = (feature: string, variant: string): string | undefined =>
    CHECKED_IN.features[feature]?.cells[variant]?.status;

  test("provability: wired on cli, channel, managed and research; not used on crew or a cli Worker", () => {
    for (const shape of ["cli", "channel", "managed", "research"]) {
      expect(cell("provability", shape), shape).toBe("wired");
    }
    expect(cell("provability", "crew")).toBe("unwired");
    expect(cell("provability", "cli@cf-worker")).toBe("unwired");
  });

  test("evaluation: not used on a cli Worker", () => {
    expect(cell("evaluation", "cli@cf-worker")).toBe("unwired");
  });

  test("watchme: not used on managed, wired on cli and channel", () => {
    expect(cell("watchme", "managed")).toBe("unwired");
    expect(cell("watchme", "cli")).toBe("wired");
    expect(cell("watchme", "channel")).toBe("wired");
  });

  test("compaction.curate is wired on exactly cli, channel and managed, as the loop view says", () => {
    const wired = SHAPES.filter((shape) => cell("compaction.curate", shape) === "wired");
    expect(wired).toEqual(["cli", "channel", "managed"]);
    expect([...CURATE_WIRED_TARGETS].sort()).toEqual([...wired].sort());
  });
});

describe("the rows the first generation demanded", () => {
  test("each 0.9.0 row is the cell its setting reads on its shape", () => {
    let checked = 0;
    for (const shape of SHAPES) {
      for (const row of unwiredRows(shape)) {
        if (row.since !== "0.9.0") continue;
        const record = CHECKED_IN.features[row.path];
        expect(record, `${shape}: ${row.path} has a feature`).toBeDefined();
        expect(record?.cells[shape], `${shape}: ${row.path}`).toEqual({
          status: "unwired",
          since: "0.9.0",
          code: "accepted-but-unwired",
          reason: row.message,
        });
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(70);
  });
});
