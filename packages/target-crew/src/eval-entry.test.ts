/**
 * Evals Wave 4, cluster S (D36 + NEW-shape-1) — the `evalEntry` emit option:
 * purely ADDITIVE `eval-entry.ts` (daemon/orchestrator/role files stay
 * byte-identical) that runs one crew turn through the compiled orchestrator
 * with the daemon's run options.
 */
import { describe, expect, test } from "bun:test";
import type { IrCrewV0 } from "@crewhaus/ir";
import { emitCrew } from "./index.js";

const baseRole = {
  tools: [],
  toolConfigs: Object.freeze({}),
  subAgents: [],
};

const MIN_IR: IrCrewV0 = {
  version: 0,
  name: "demo-crew",
  target: "crew",
  entry: "solo",
  roles: [
    { name: "solo", model: "claude-sonnet-4-6", instructions: "Answer briefly.", ...baseRole },
  ],
  mcp_servers: Object.freeze({}),
  permissions: { rules: [] },
  compaction: {},
};

describe("emitCrew — evalEntry off is byte-identical (back-compat pin)", () => {
  test("omitted, {} and evalEntry: false all emit the same files", () => {
    const files = (b: ReturnType<typeof emitCrew>) =>
      new Map(b.files.map((f) => [f.path, f.content]));
    const a = files(emitCrew(MIN_IR));
    const b = files(emitCrew(MIN_IR, {}));
    const c = files(emitCrew(MIN_IR, { evalEntry: false }));
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
    expect([...a.keys()].sort()).toEqual([...c.keys()].sort());
    expect(a.has("eval-entry.ts")).toBe(false);
    for (const [path, content] of a) {
      expect(b.get(path)).toBe(content);
      expect(c.get(path)).toBe(content);
    }
  });
});

describe("emitCrew — evalEntry variant (cluster S)", () => {
  test("adds eval-entry.ts WITHOUT touching the other files (additive)", () => {
    const plain = new Map(emitCrew(MIN_IR).files.map((f) => [f.path, f.content]));
    const withEntry = new Map(
      emitCrew(MIN_IR, { evalEntry: true }).files.map((f) => [f.path, f.content]),
    );
    expect(withEntry.has("eval-entry.ts")).toBe(true);
    for (const [path, content] of plain) {
      expect(withEntry.get(path)).toBe(content);
    }
  });

  test("eval-entry drives the REAL compiled orchestrator with the daemon's options", () => {
    const entry =
      emitCrew(MIN_IR, { evalEntry: true }).files.find((f) => f.path === "eval-entry.ts")
        ?.content ?? "";
    expect(entry).toContain('import { buildCrew } from "./orchestrator.js";');
    expect(entry).toContain("export async function runForEval(");
    expect(entry).toContain("const crew = buildCrew();");
    expect(entry).toContain('if (ev.kind === "crew_done") __final = ev.finalOutput;');
    // Per-sample seams: sessionId + sessionRootDir into the crew's own
    // session machinery, _adapter as the scripted-provider test seam.
    expect(entry).toContain("sessionId: __evalOpts.sessionId");
    expect(entry).toContain("sessionRootDir: __evalOpts.sessionRootDir");
    expect(entry).toContain("_adapter: __evalOpts._adapter");
  });

  test("daemon-level run options ride along (taxonomy example)", () => {
    const ir: IrCrewV0 = {
      ...MIN_IR,
      failureTaxonomy: [{ class: "rate_limited", pattern: "/429/", recovery: "retry" }],
    };
    const entry =
      emitCrew(ir, { evalEntry: true }).files.find((f) => f.path === "eval-entry.ts")?.content ??
      "";
    const daemon =
      emitCrew(ir, { evalEntry: true }).files.find((f) => f.path === "daemon.ts")?.content ?? "";
    expect(entry).toContain('"class":"rate_limited"');
    // Same rendered field as the daemon — the two option sets cannot drift.
    expect(daemon).toContain('"class":"rate_limited"');
  });

  test("eval-entry.ts is syntactically valid TypeScript", () => {
    const t = new Bun.Transpiler({ loader: "ts" });
    const entry =
      emitCrew(MIN_IR, { evalEntry: true }).files.find((f) => f.path === "eval-entry.ts")
        ?.content ?? "";
    expect(() => t.transformSync(entry)).not.toThrow();
  });
});
