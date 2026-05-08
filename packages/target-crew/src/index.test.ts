import { describe, expect, test } from "bun:test";
import type { IrCrewV0 } from "@crewhaus/ir";
import { TargetEmitError, emitCrew } from "./index.js";

const baseRole = {
  tools: [],
  toolConfigs: Object.freeze({}),
  subAgents: [],
};

const minimalIr: IrCrewV0 = {
  version: 0,
  name: "hello-crew",
  target: "crew",
  entry: "researcher",
  roles: [
    {
      name: "researcher",
      model: "claude-sonnet-4-6",
      instructions: "You are the researcher.",
      ...baseRole,
    },
    {
      name: "writer",
      model: "claude-sonnet-4-6",
      instructions: "You are the writer.",
      ...baseRole,
    },
    {
      name: "critic",
      model: "claude-sonnet-4-6",
      instructions: "You are the critic.",
      ...baseRole,
    },
  ],
  mcp_servers: Object.freeze({}),
  permissions: { rules: [] },
  compaction: {},
};

describe("emitCrew", () => {
  test("emits orchestrator + daemon + per-role agent files (T1 bundle structure)", () => {
    const bundle = emitCrew(minimalIr);
    const paths = bundle.files.map((f) => f.path).sort();
    expect(paths).toEqual([
      "agent_critic.ts",
      "agent_researcher.ts",
      "agent_writer.ts",
      "daemon.ts",
      "orchestrator.ts",
    ]);
  });

  test("orchestrator wires every role + sets entry", () => {
    const bundle = emitCrew(minimalIr);
    const orchestrator = bundle.files.find((f) => f.path === "orchestrator.ts");
    expect(orchestrator).toBeDefined();
    const code = orchestrator?.content;
    expect(code).toContain("import { Crew");
    expect(code).toContain('from "./agent_researcher.js"');
    expect(code).toContain('from "./agent_writer.js"');
    expect(code).toContain('from "./agent_critic.js"');
    expect(code).toContain('.setEntry("researcher")');
  });

  test("daemon emits JSON events to stdout in a streaming loop", () => {
    const bundle = emitCrew(minimalIr);
    const daemon = bundle.files.find((f) => f.path === "daemon.ts");
    expect(daemon).toBeDefined();
    const code = daemon?.content;
    expect(code).toContain("for await (const ev of crew.run");
    expect(code).toContain("JSON.stringify(ev)");
    expect(code).toContain("readAllStdin");
  });

  test("per-role agent file exports a RoleDefinition wrapper with model + instructions", () => {
    const bundle = emitCrew(minimalIr);
    const writer = bundle.files.find((f) => f.path === "agent_writer.ts");
    expect(writer).toBeDefined();
    const code = writer?.content;
    expect(code).toContain("export const role:");
    expect(code).toContain('"writer"');
    expect(code).toContain("You are the writer.");
    expect(code).toContain('"claude-sonnet-4-6"');
  });

  test("rejects empty crew", () => {
    const ir: IrCrewV0 = {
      ...minimalIr,
      roles: [],
      entry: "x",
    };
    expect(() => emitCrew(ir)).toThrow(TargetEmitError);
  });

  test("rejects entry that doesn't match any role", () => {
    const ir: IrCrewV0 = {
      ...minimalIr,
      entry: "nope",
    };
    expect(() => emitCrew(ir)).toThrow(/entry "nope"/);
  });

  test("rejects unknown tool names", () => {
    const ir: IrCrewV0 = {
      ...minimalIr,
      roles: [
        {
          name: "r1",
          model: "m",
          instructions: "i",
          tools: ["nonexistent-tool"],
          toolConfigs: Object.freeze({}),
          subAgents: [],
        },
      ],
      entry: "r1",
    };
    expect(() => emitCrew(ir)).toThrow(/unknown tool "nonexistent-tool"/);
  });

  test('emits routing match table when routing.kind === "match"', () => {
    const ir: IrCrewV0 = {
      ...minimalIr,
      routing: {
        kind: "match",
        match: {
          researcher: [{ contains: "DONE", to: "writer" }],
          writer: [{ contains: "REVIEW", to: "critic" }],
        },
      },
    };
    const bundle = emitCrew(ir);
    const orch = bundle.files.find((f) => f.path === "orchestrator.ts");
    expect(orch).toBeDefined();
    expect(orch?.content).toContain("__routingTable");
    expect(orch?.content).toContain("setRouting");
    expect(orch?.content).toContain("DONE");
  });

  test("permissions block lands on the daemon's runOptions", () => {
    const ir: IrCrewV0 = {
      ...minimalIr,
      permissions: {
        mode: "default",
        rules: [
          { type: "alwaysAllow", pattern: "Handoff" },
          { type: "alwaysAllow", pattern: "SendMessage" },
        ],
      },
    };
    const bundle = emitCrew(ir);
    const daemon = bundle.files.find((f) => f.path === "daemon.ts");
    expect(daemon?.content).toContain("BUILTIN_DEFAULT_RULES");
    expect(daemon?.content).toContain("permissionMode");
    expect(daemon?.content).toContain("Handoff");
  });
});
