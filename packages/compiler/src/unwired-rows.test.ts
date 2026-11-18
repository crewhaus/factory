/**
 * Accepted-but-unwired rows may name a nested path and carry `since` (#514).
 * `specDeclares` is fed hand-built values, because several of the forms it must
 * read do not parse: it is the walk that is under test.
 */
import { describe, expect, test } from "bun:test";
import { type Spec, parseSpec } from "@crewhaus/spec";
import { CORPUS_TODAY } from "./__fixtures__/delta-090/regenerate";
import { ABSENT_CORPUS } from "./absent-corpus";
import {
  CF_WORKER_GATED_ROOTS,
  type CompileWarning,
  assertCfWorkerSafetyEnforced,
  cfWorkerUnwiredBlockWarnings,
  collectCompileWarnings,
  compile,
  lower,
  lowerWithWarnings,
  specDeclares,
  unwiredRows,
  unwiredWarnings,
} from "./index";

const spec = (fields: Record<string, unknown>): Spec => fields as unknown as Spec;

describe("specDeclares — a dotted path", () => {
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>, boolean]> = [
    ["the leaf is set", { compaction: { curate: true } }, true],
    ["the leaf is set, with a sibling", { compaction: { curate: true, threshold: 0.5 } }, true],
    ["the leaf is false", { compaction: { curate: false } }, false],
    ["the block is false", { compaction: false }, false],
    ["the block is null", { compaction: null }, false],
    ["the block is a scalar", { compaction: "on" }, false],
    ["the block is an array", { compaction: [{ curate: true }] }, false],
    ["the block is switched off", { compaction: { enabled: false, curate: true } }, false],
    ["the leaf is an empty object", { compaction: { curate: {} } }, false],
    ["the leaf is an empty array", { compaction: { curate: [] } }, false],
    ["the leaf is absent", { compaction: {} }, false],
    ["the block is absent", {}, false],
    ["the block is switched on", { compaction: { enabled: true, curate: true } }, true],
    ["a falsy value that is not false", { compaction: { curate: 0 } }, true],
  ];
  for (const [what, fields, expected] of cases) {
    test(`compaction.curate when ${what}: ${expected}`, () => {
      expect(specDeclares(spec(fields), "compaction.curate")).toBe(expected);
    });
  }

  test("each sibling is read on its own", () => {
    const value = spec({ compaction: { threshold: 0.5 } });
    expect(specDeclares(value, "compaction.threshold")).toBe(true);
    expect(specDeclares(value, "compaction.curate")).toBe(false);
  });

  test("it walks more than one level, and an opt-out at any level stops it", () => {
    expect(specDeclares(spec({ a: { b: { c: 1 } } }), "a.b.c")).toBe(true);
    expect(specDeclares(spec({ a: { b: { enabled: false, c: 1 } } }), "a.b.c")).toBe(false);
    expect(specDeclares(spec({ a: { enabled: false, b: { c: 1 } } }), "a.b.c")).toBe(false);
    expect(specDeclares(spec({ a: { b: false } }), "a.b.c")).toBe(false);
  });

  test("a provability block at level off declares nothing beneath it", () => {
    const threshold = "provability.threshold";
    expect(specDeclares(spec({ provability: { level: "off", threshold: 0.5 } }), threshold)).toBe(
      false,
    );
    expect(specDeclares(spec({ provability: "off" }), threshold)).toBe(false);
    expect(specDeclares(spec({ provability: "grounded" }), threshold)).toBe(false);
    expect(
      specDeclares(spec({ provability: { level: "grounded", threshold: 0.5 } }), threshold),
    ).toBe(true);
  });
});

describe("specDeclares — a top-level key reads as it always did", () => {
  const cases: ReadonlyArray<readonly [string, string, Record<string, unknown>, boolean]> = [
    ["continuity: false", "continuity", { continuity: false }, false],
    ["continuity set", "continuity", { continuity: { enabled: true } }, true],
    ["continuity switched off", "continuity", { continuity: { enabled: false } }, false],
    ["mcp_servers: {}", "mcp_servers", { mcp_servers: {} }, false],
    ["mcp_servers set", "mcp_servers", { mcp_servers: { a: {} } }, true],
    ["tools: []", "tools", { tools: [] }, false],
    ["tools set", "tools", { tools: ["read"] }, true],
    ["a scalar", "goal", { goal: "g" }, true],
    ["absent", "continuity", {}, false],
    ["provability: off", "provability", { provability: "off" }, false],
    [
      "provability at level off",
      "provability",
      { provability: { level: "off", threshold: 1 } },
      false,
    ],
    ["provability: grounded", "provability", { provability: "grounded" }, true],
    ["provability at a level", "provability", { provability: { level: "cited" } }, true],
  ];
  for (const [what, path, fields, expected] of cases) {
    test(`${what}: ${expected}`, () => {
      expect(specDeclares(spec(fields), path)).toBe(expected);
    });
  }
});

describe("unwiredRows", () => {
  test("a shape's rows come back; every row with since is a 0.9.0 row, and no older row has one", () => {
    expect(unwiredRows("crew").map((row) => row.path)).toContain("provability");
    const targets = Object.keys(ABSENT_CORPUS) as Spec["target"][];
    expect(targets.length).toBe(14);
    const rows = targets.flatMap((target) => [
      ...unwiredRows(target),
      ...unwiredRows(target, { emitAs: "cf-worker" }),
    ]);
    const stamped = rows.filter((row) => "since" in row);
    expect(stamped.length).toBeGreaterThan(0);
    for (const row of stamped) expect(row.since, row.path).toBe("0.9.0");
    // The rows 0.8.x already printed carry none: since marks what this release added.
    const older = rows.filter((row) => !("since" in row)).map((row) => row.path);
    expect(older).toContain("provability");
    expect(older).toContain("watchme");
    expect(older.filter((path) => path.startsWith("compaction"))).toEqual([]);
  });

  test("a shape with no rows answers empty", () => {
    expect(unwiredRows("cli")).toEqual([]);
  });

  test("a Cloudflare Worker build adds the cli edge's compaction rows; workflow and graph keep their own", () => {
    const edge = (target: Spec["target"]) =>
      unwiredRows(target, { emitAs: "cf-worker" }).map((row) => row.path);
    expect(edge("cli").filter((path) => path.startsWith("compaction"))).toEqual(COMPACTION_PATHS);
    expect(edge("workflow").filter((path) => path.startsWith("compaction"))).toEqual([]);
    expect(edge("graph").filter((path) => path.startsWith("compaction"))).toEqual([]);
    expect(edge("channel")).toEqual([]);
    for (const target of ["cli", "workflow", "graph"] as const) {
      for (const row of unwiredRows(target, { emitAs: "cf-worker" })) {
        expect(row.since, row.path).toBe("0.9.0");
        expect(row.message, row.path).toContain("the cf-worker edge does not wire it");
      }
    }
  });

  test("the rows are copies: changing one leaves the table as it was", () => {
    const first = unwiredRows("crew") as Array<{ path: string; message: string }>;
    const before = unwiredRows("crew");
    (first[0] as { path: string }).path = "changed";
    first.push({ path: "added", message: "m" });
    expect(unwiredRows("crew")).toEqual(before);
    expect(unwiredRows("crew").map((row) => row.path)).not.toContain("changed");
  });

  test("the table's warnings still reach collectCompileWarnings", () => {
    const warnings = collectCompileWarnings(
      spec({ target: "crew", provability: { level: "grounded" } }),
    );
    expect(warnings.filter((w) => w.path === "provability").map((w) => w.code)).toEqual([
      "accepted-but-unwired",
    ]);
    expect(
      collectCompileWarnings(spec({ target: "crew", provability: "off" })).map((w) => w.path),
    ).not.toContain("provability");
  });
});

describe("unwiredWarnings", () => {
  const ROW = { path: "compaction.curate", message: "m", since: "0.9.0" } as const;

  test("a nested row warns at its path, and the warning has no since field", () => {
    const warnings = unwiredWarnings(spec({ compaction: { curate: true } }), [ROW]);
    expect(warnings).toEqual([
      { code: "accepted-but-unwired", path: "compaction.curate", message: "m" },
    ]);
  });

  test("no warning when the key is absent or opted out", () => {
    expect(unwiredWarnings(spec({ compaction: {} }), [ROW])).toEqual([]);
    expect(unwiredWarnings(spec({ compaction: { curate: false } }), [ROW])).toEqual([]);
    expect(unwiredWarnings(spec({}), [ROW])).toEqual([]);
  });
});

const COMPACTION_PATHS = [
  "compaction.model",
  "compaction.threshold",
  "compaction.snip_keep_head",
  "compaction.snip_keep_tail",
  "compaction.curate",
  "compaction.dedupeThreshold",
  "compaction.relevanceTopK",
];

/** A value for each sub-key that parses and is not an opt-out. */
const COMPACTION_VALUES: Readonly<Record<string, string>> = {
  model: "claude-haiku-4-5",
  threshold: "0.7",
  snip_keep_head: "2",
  snip_keep_tail: "9",
  curate: "true",
  dedupeThreshold: "0.8",
  relevanceTopK: "3",
};

const IGNORING_COMPACTION: ReadonlyArray<Spec["target"]> = [
  "workflow",
  "graph",
  "pipeline",
  "crew",
  "research",
  "batch",
  "voice",
  "browser",
  "onchain",
  "onchain-game",
];

describe("compaction: a shape that does not read it says so, field by field", () => {
  for (const target of IGNORING_COMPACTION) {
    for (const [sub, value] of Object.entries(COMPACTION_VALUES)) {
      test(`${target}: compaction.${sub}`, () => {
        const yaml = `${ABSENT_CORPUS[target]}compaction:\n  ${sub}: ${value}\n`;
        const rows = unwiredRows(target).filter((row) => row.path === `compaction.${sub}`);
        expect(rows.map((row) => row.since)).toEqual(["0.9.0"]);
        const warnings = compile(yaml, { readme: false, today: CORPUS_TODAY }).warnings.filter(
          (w) => w.path.startsWith("compaction"),
        );
        expect(warnings).toEqual([
          { code: "accepted-but-unwired", path: `compaction.${sub}`, message: rows[0]?.message },
        ]);
      });
    }
  }

  for (const target of ["cli", "channel", "managed"] as const) {
    test(`${target} reads the block: no row, no warning`, () => {
      expect(unwiredRows(target).filter((row) => row.path.startsWith("compaction"))).toEqual([]);
      const block = Object.entries(COMPACTION_VALUES)
        .map(([sub, value]) => `  ${sub}: ${value}`)
        .join("\n");
      const yaml = `${ABSENT_CORPUS[target]}compaction:\n${block}\n`;
      // Only the note that the embedding threshold has nothing to tune: no embedder is passed.
      expect(
        compile(yaml, { readme: false, today: CORPUS_TODAY }).warnings.map((w) => [w.code, w.path]),
      ).toEqual([["compaction-curate-knobs-unused", "compaction.dedupeThreshold"]]);
    });
  }

  test("an empty block warns nothing", () => {
    for (const target of IGNORING_COMPACTION) {
      const yaml = `${ABSENT_CORPUS[target]}compaction: {}\n`;
      const warnings = compile(yaml, { readme: false, today: CORPUS_TODAY }).warnings;
      expect(warnings.filter((w) => w.path.startsWith("compaction"))).toEqual([]);
    }
  });

  test("each row's reason is true of its shape", () => {
    const detail = (target: Spec["target"]): string =>
      unwiredRows(target).find((row) => row.path === "compaction.threshold")?.message ?? "";
    for (const target of [
      "workflow",
      "graph",
      "pipeline",
      "crew",
      "research",
      "batch",
      "browser",
    ] as const) {
      expect(detail(target)).toContain(`the ${target} loop compacts with the runtime's defaults`);
    }
    expect(detail("voice")).toContain("the realtime voice loop does not compact");
    expect(detail("onchain")).toContain("the onchain daemon runs no agent loop yet");
    expect(detail("onchain-game")).toContain("the onchain-game daemon runs no agent loop yet");
  });
});

describe("compaction on a Cloudflare Worker build", () => {
  const edgeWarnings = (target: Spec["target"], block: string): CompileWarning[] => {
    const spec = parseSpec(`${ABSENT_CORPUS[target]}${block}`);
    const lowered = lowerWithWarnings(spec, { today: CORPUS_TODAY });
    return [
      ...collectCompileWarnings(spec),
      ...lowered.warnings,
      ...cfWorkerUnwiredBlockWarnings(lowered.ir),
    ];
  };

  test("a cli spec warns at the declared sub-key", () => {
    const warnings = edgeWarnings("cli", "compaction: {threshold: 0.7}\n");
    expect(warnings.map((w) => [w.code, w.path])).toEqual([
      ["accepted-but-unwired", "compaction.threshold"],
    ]);
    const row = unwiredRows("cli", { emitAs: "cf-worker" }).find(
      (r) => r.path === "compaction.threshold",
    );
    expect(warnings[0]?.message).toBe(row?.message);
  });

  test("a compaction model, by name or profile params, is one row", () => {
    const warnings = edgeWarnings("cli", "compaction: {model: claude-haiku-4-5, curate: true}\n");
    expect(warnings.map((w) => w.path)).toEqual(["compaction.model", "compaction.curate"]);
    expect(edgeWarnings("cli", "compaction: {curate: false}\n")).toEqual([]);
  });

  test("a workflow spec through the whole edge path warns at that path exactly once", () => {
    const warnings = edgeWarnings("workflow", "compaction: {threshold: 0.7}\n");
    expect(warnings.filter((w) => w.path === "compaction.threshold")).toHaveLength(1);
  });
});

describe("the other settings a Cloudflare Worker build of a cli spec does not read", () => {
  const edgeWarnings = (target: Spec["target"], block: string): CompileWarning[] => {
    const spec = parseSpec(`${ABSENT_CORPUS[target]}${block}`);
    const lowered = lowerWithWarnings(spec, { today: CORPUS_TODAY });
    return [
      ...collectCompileWarnings(spec),
      ...lowered.warnings,
      ...cfWorkerUnwiredBlockWarnings(lowered.ir),
    ];
  };

  test("a safety setting is never a row: the edge gate enforces it or refuses the build", () => {
    const gated = (path: string): boolean =>
      CF_WORKER_GATED_ROOTS.some((root) => {
        const segs = root.split(".");
        const parts = path.split(/[.[\]]/).filter((p) => p !== "");
        return segs.every((seg, i) => seg === "*" || seg === parts[i]);
      });
    for (const target of ["cli", "workflow", "graph"] as const) {
      const rows = unwiredRows(target, { emitAs: "cf-worker" }).map((r) => r.path);
      expect(rows.length, target).toBeGreaterThan(0);
      expect(rows.filter(gated), target).toEqual([]);
    }
    expect(gated("steps[0].model_pool")).toBe(true);
    expect(gated("security.justification")).toBe(true);
    for (const block of [
      "security: {justification: {judge: claude}}\n",
      "security: {egressMatcher: semantic}\n",
    ]) {
      const spec = parseSpec(`${ABSENT_CORPUS.cli}${block}`);
      expect(() => assertCfWorkerSafetyEnforced(spec, lower(spec)), block).toThrow(
        "cf-worker target cannot enforce",
      );
    }
  });

  test("observability warns per sub-block it does not read, and never for trace", () => {
    const warnings = edgeWarnings(
      "cli",
      "observability: {slo: {error_rate: 0.05}, metrics: {enabled: true}, trace: {level: off}}\n",
    );
    expect(warnings.map((w) => [w.code, w.path])).toEqual([
      ["accepted-but-unwired", "observability.slo"],
      ["accepted-but-unwired", "observability.metrics"],
    ]);
    expect(edgeWarnings("cli", "observability: {trace: {level: off}}\n")).toEqual([]);
    const rows = unwiredRows("cli", { emitAs: "cf-worker" }).map((r) => r.path);
    expect(rows.filter((p) => p.startsWith("observability"))).toEqual([
      "observability.slo",
      "observability.metrics",
      "observability.cost",
      "observability.alerts",
      "observability.incidents",
      "observability.otel",
    ]);
  });

  test("failure_taxonomy warns on every edge shape, once", () => {
    const block = "failure_taxonomy: [{class: net, pattern: ETIMEDOUT, recovery: retry}]\n";
    for (const target of ["cli", "workflow", "graph"] as const) {
      const warnings = edgeWarnings(target, block).filter((w) => w.path === "failure_taxonomy");
      expect(
        warnings.map((w) => w.code),
        target,
      ).toEqual(["accepted-but-unwired"]);
      expect(warnings[0]?.message, target).toContain("no recovery engine");
    }
  });
});

describe("failure_taxonomy on a shape that runs no recovery engine", () => {
  const block = "failure_taxonomy: [{class: net, pattern: ETIMEDOUT, recovery: retry}]\n";
  for (const target of ["voice", "onchain", "onchain-game"] as const) {
    test(`${target} warns, with since`, () => {
      const row = unwiredRows(target).find((r) => r.path === "failure_taxonomy");
      expect(row?.since).toBe("0.9.0");
      const warnings = compile(`${ABSENT_CORPUS[target]}${block}`, {
        readme: false,
        today: CORPUS_TODAY,
      }).warnings.filter((w) => w.path === "failure_taxonomy");
      expect(warnings).toEqual([
        { code: "accepted-but-unwired", path: "failure_taxonomy", message: row?.message },
      ]);
    });
  }
});

describe("permissions.ask_mode on pipeline", () => {
  const yaml = `${ABSENT_CORPUS.pipeline}permissions:\n  ask_mode: deny\n`;

  test("has no unused-setting row: the eval entry reads it", () => {
    expect(unwiredRows("pipeline").filter((r) => r.path.startsWith("permissions"))).toEqual([]);
  });

  test("an eval-harness build renders it, and the only warning is the informational note", () => {
    const built = compile(yaml, { readme: false, today: CORPUS_TODAY, evalEntry: true });
    const agent = built.files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agent).toContain('askMode: "deny"');
    const without = compile(ABSENT_CORPUS.pipeline, {
      readme: false,
      today: CORPUS_TODAY,
      evalEntry: true,
    });
    expect(without.files.find((f) => f.path === "agent.ts")?.content).not.toContain(
      'askMode: "deny"',
    );
    expect(built.warnings.map((w) => [w.code, w.path])).toEqual([
      ["ask-mode-eval-entry-only", "permissions.ask_mode"],
    ]);
  });
});
