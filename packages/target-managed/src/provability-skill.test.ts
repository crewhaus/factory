/**
 * 0.8.0 (design/0.8.0-provability-release.md §11) — the managed shape
 * registers the gate's `provability` skill only when the IR carries the
 * block. This shape discovers no skills of its own: with the memory fabric
 * owning the skill surface (continuity or learning on) the skill rides the
 * per-turn `wireMemory` deps; otherwise it IS the surface, one Skill tool over
 * it. A spec without the block emits the pre-0.8.0 bytes.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provabilitySkills, renderGateSkills } from "@crewhaus/evaluation-service";
import type { IrManagedV0 } from "@crewhaus/ir";
import { type MemoryWiringFragment, wireMemory } from "@crewhaus/memory-service";
import { emitManaged } from "./index";

const IR: IrManagedV0 = {
  version: 0,
  name: "hello-managed",
  target: "managed",
  agent: { model: "claude-sonnet-4-6", instructions: "You are a managed-daemon agent." },
  tenants: [{ id: "tenant-a", budget: { maxInputTokens: 100_000, maxOutputTokens: 20_000 } }],
  permissions: { rules: [] },
  compaction: {},
};

const PROVABILITY: NonNullable<IrManagedV0["provability"]> = {
  level: "grounded",
  onFail: "retry",
  maxRetries: 1,
  threshold: 1,
  scope: "session",
  assumptions: "allow",
  render: "footer",
  sources: { allow: [], deny: [], bibliographic: false, resolve: "off" },
  grounded: { coverage: 0.8, windowTokens: 60, independent: 1 },
  execution: { allow: ["evaluate"], replay: true, maxReplays: 20 },
  formal: { checkers: ["builtin", "smt"], forbid: ["sorry"], timeoutMs: 30_000 },
};

const CONTINUITY: NonNullable<IrManagedV0["continuity"]> = {
  plan: true,
  proof: "ladder",
  ledger: true,
  handoff: true,
  scope: "session",
};

// The expression itself is pinned in evaluation-service (renderGateSkills);
// these tests pin where the emitter splices it.
const SKILLS_CALL = renderGateSkills({ provability: PROVABILITY }).expr;

const LEARNING: NonNullable<IrManagedV0["learning"]> = {
  domain: "specialty coffee extraction science",
  study: { onHeartbeat: true, onDream: true },
};
const WIKI = { wiki: { enabled: true, requireSources: true } };

const agentOf = (ir: IrManagedV0): string =>
  emitManaged(ir).files.find((f) => f.path === "agent.ts")?.content ?? "";

describe("emitManaged — the provability skill (0.8.0 §11)", () => {
  test("no fabric: the gate's skill is the whole surface — one module-level Skill tool, one list", () => {
    const agent = agentOf({ ...IR, provability: PROVABILITY });
    expect(agent).toContain('import { provabilitySkills } from "@crewhaus/evaluation-service";');
    expect(agent).toContain('import { createSkillTool } from "@crewhaus/skills-registry";');
    // Guarded like every other registration site: a skill that failed soft
    // to [] must not leave a "No skills are currently available" Skill tool.
    expect(agent).toContain(
      `\nconst __gateSkills = ${SKILLS_CALL};\nif (__gateSkills.length > 0) defaultCatalog.register(createSkillTool(__gateSkills));`,
    );
    expect(agent).toContain("    tools: defaultCatalog.list(),\n    skills: __gateSkills,");
    // Registered once, after the gate's own tools.
    expect(agent.match(/createSkillTool\(/g)).toHaveLength(1);
    expect(agent.indexOf("registerGateTools(defaultCatalog, __gates);")).toBeLessThan(
      agent.indexOf("const __gateSkills ="),
    );
  });

  test("with continuity: the per-turn wireMemory takes it and its merged list is the run's", () => {
    const agent = agentOf({ ...IR, provability: PROVABILITY, continuity: CONTINUITY });
    expect(agent).toContain(`\nconst __gateSkills = ${SKILLS_CALL};`);
    // The fabric owns the Skill tool, so the module registers none of its own.
    expect(agent).not.toContain("defaultCatalog.register(createSkillTool(");
    expect(agent).toContain("\n    builtinSkills: __gateSkills,\n    tenant: args.tenant,");
    expect(agent).toContain("const __skills = __memWired.options.skills ?? __gateSkills;");
    expect(agent).toContain("if (__skills.length > 0) __memTools.push(createSkillTool(__skills));");
    expect(agent).toContain(
      "    tools: [...__memTools, ...defaultCatalog.list()],\n    skills: __skills,\n    ...__memWired.options,",
    );
    // One skills-registry import (the fabric's), not two.
    expect(agent.match(/from "@crewhaus\/skills-registry";/g)).toHaveLength(1);
  });

  test("memory without continuity: the fabric returns no skills, so the gate's list stands", async () => {
    const agent = agentOf({ ...IR, provability: PROVABILITY, memory: {} } as IrManagedV0);
    expect(agent).toContain("const __skills = __memWired.options.skills ?? __gateSkills;");
    // What that line resolves to at runtime: wireMemory leaves `skills` unset.
    const tmp = mkdtempSync(join(tmpdir(), "managed-gate-skill-"));
    try {
      const wired = await wireMemory(
        { specName: "hello-managed", memory: {} },
        {
          catalog: { register: () => {} },
          cwd: tmp,
          homeDir: join(tmp, "home"),
          builtinSkills: provabilitySkills(PROVABILITY),
        },
      );
      expect(wired.options.skills).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("learning without continuity: the fabric owns the surface, so the skill rides its deps", async () => {
    const agent = agentOf({
      ...IR,
      provability: PROVABILITY,
      memory: WIKI,
      learning: LEARNING,
    } as IrManagedV0);
    expect(agent).toContain(`\nconst __gateSkills = ${SKILLS_CALL};`);
    expect(agent).not.toContain("defaultCatalog.register(createSkillTool(");
    expect(agent).toContain("\n    builtinSkills: __gateSkills,\n    tenant: args.tenant,");
    expect(agent).toContain("const __skills = __memWired.options.skills ?? __gateSkills;");
    expect(agent).toContain("if (__skills.length > 0) __memTools.push(createSkillTool(__skills));");
    expect(agent).toContain("\n    skills: __skills,\n    ...__memWired.options,");
    // What that wiring returns: the learning skill and the gate's, one list
    // (the Skill tool's and the run's).
    const tmp = mkdtempSync(join(tmpdir(), "managed-gate-learning-"));
    try {
      const wired = await wireMemory(
        { specName: "hello-managed", memory: WIKI, learning: LEARNING } as MemoryWiringFragment,
        {
          catalog: { register: () => {} },
          cwd: tmp,
          homeDir: join(tmp, "home"),
          builtinSkills: provabilitySkills(PROVABILITY),
        },
      );
      expect((wired.options.skills ?? []).map((s) => s.name).sort()).toEqual([
        "learning-loop",
        "provability",
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("Bun.Transpiler parses every provability agent.ts variant", () => {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    for (const extra of [
      {},
      { continuity: CONTINUITY },
      { memory: {} },
      { memory: WIKI, learning: LEARNING },
    ]) {
      const agent = agentOf({ ...IR, provability: PROVABILITY, ...extra } as IrManagedV0);
      expect(() => transpiler.transformSync(agent)).not.toThrow();
    }
  });

  // Byte identity without the block is held by the compiler's pinned bundle
  // fixtures (packages/compiler/src/model-wiring-pin.test.ts,
  // continuity-byte-restore.test.ts), which compare against bytes captured
  // before 0.8.0. Here: nothing of the skill wiring appears.
  test("no block → no skill wiring (with or without the fabric)", () => {
    for (const extra of [
      {},
      { continuity: CONTINUITY },
      { memory: {} },
      { memory: WIKI, learning: LEARNING },
    ]) {
      const ir = { ...IR, ...extra } as IrManagedV0;
      for (const f of emitManaged(ir).files) {
        expect(f.content).not.toContain("provabilitySkills");
        expect(f.content).not.toContain("__gateSkills");
        expect(f.content).not.toContain("builtinSkills");
      }
    }
    // The fabric's own fallback is unchanged without the block.
    expect(agentOf({ ...IR, continuity: CONTINUITY })).toContain(
      "const __skills = __memWired.options.skills ?? [];",
    );
  });
});
