import { describe, expect, test } from "bun:test";
import {
  type FixFs,
  formatFixPlan,
  planCrewhausDirs,
  planEnvStubs,
  planScaffoldSpec,
  planScopeFix,
} from "./doctor-fix";

/** In-memory FixFs so every fixer is tested without touching the disk. */
function memFs(seed: Record<string, string> = {}): {
  fs: FixFs;
  files: Map<string, string>;
  dirs: Set<string>;
} {
  const files = new Map<string, string>(Object.entries(seed));
  const dirs = new Set<string>();
  const fs: FixFs = {
    exists: (p) => files.has(p) || dirs.has(p),
    read: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`no such file ${p}`);
      return v;
    },
    write: (p, content) => files.set(p, content),
    mkdirp: (p) => dirs.add(p),
  };
  return { fs, files, dirs };
}

describe("planScaffoldSpec", () => {
  test("plans a scaffold when crewhaus.yaml is absent and applies it", () => {
    const { fs, files } = memFs();
    const action = planScaffoldSpec({ fs, specPath: "/w/crewhaus.yaml", specName: "w" });
    expect(action).toBeDefined();
    expect(action?.diff).toContain("+ name: w");
    action?.apply();
    expect(files.get("/w/crewhaus.yaml")).toContain("target: cli");
  });

  test("no-op when the spec already exists", () => {
    const { fs } = memFs({ "/w/crewhaus.yaml": "name: w\ntarget: cli\n" });
    expect(planScaffoldSpec({ fs, specPath: "/w/crewhaus.yaml", specName: "w" })).toBeUndefined();
  });
});

describe("planCrewhausDirs", () => {
  test("plans + applies a .crewhaus dir when absent", () => {
    const { fs, dirs } = memFs();
    const action = planCrewhausDirs({ fs, crewhausDir: "/w/.crewhaus" });
    expect(action).toBeDefined();
    action?.apply();
    expect(dirs.has("/w/.crewhaus")).toBe(true);
  });

  test("no-op when the dir already exists", () => {
    const { fs } = memFs();
    fs.mkdirp("/w/.crewhaus");
    expect(planCrewhausDirs({ fs, crewhausDir: "/w/.crewhaus" })).toBeUndefined();
  });
});

describe("planScopeFix", () => {
  const specYaml = `name: t
target: cli
agent:
  model: claude-opus-4-7
  instructions: hi
tools:
  - fetch
`;

  test("writes tool_config.<name>.scope: external via a CST spec-patch", () => {
    const { fs, files } = memFs({ "/w/crewhaus.yaml": specYaml });
    const action = planScopeFix({
      fs,
      specPath: "/w/crewhaus.yaml",
      specTarget: "cli",
      toolName: "fetch",
    });
    expect(action).toBeDefined();
    action?.apply();
    const written = files.get("/w/crewhaus.yaml") ?? "";
    // Comments/keys preserved; the scope key is added and re-validates via parseSpec.
    expect(written).toContain("scope: external");
    expect(written).toContain("tool_config");
    expect(written).toContain("instructions: hi");
  });

  test("skips mcp__* dynamic sinks (need human vetting, not a mechanical stamp)", () => {
    const { fs } = memFs({ "/w/crewhaus.yaml": specYaml });
    expect(
      planScopeFix({
        fs,
        specPath: "/w/crewhaus.yaml",
        specTarget: "cli",
        toolName: "mcp__evil__exfiltrate",
      }),
    ).toBeUndefined();
  });

  test("replaces an existing scope rather than throwing on a second run", () => {
    const withScope = `${specYaml}tool_config:
  fetch:
    scope: internal
`;
    const { fs, files } = memFs({ "/w/crewhaus.yaml": withScope });
    const action = planScopeFix({
      fs,
      specPath: "/w/crewhaus.yaml",
      specTarget: "cli",
      toolName: "fetch",
    });
    action?.apply();
    expect(files.get("/w/crewhaus.yaml")).toContain("scope: external");
  });
});

describe("planEnvStubs", () => {
  test("appends commented stubs to a new .env", () => {
    const { fs, files } = memFs();
    const action = planEnvStubs({ fs, envPath: "/w/.env", neededVars: ["OPENAI_API_KEY"] });
    expect(action).toBeDefined();
    action?.apply();
    const env = files.get("/w/.env") ?? "";
    expect(env).toContain("# OPENAI_API_KEY=");
    expect(env).toContain("crewhaus doctor --fix");
  });

  test("is idempotent — a var already present (set OR commented) is skipped", () => {
    const { fs } = memFs({ "/w/.env": "OPENAI_API_KEY=sk-live\n# GEMINI_API_KEY=\n" });
    // Both already present → nothing to add.
    expect(
      planEnvStubs({ fs, envPath: "/w/.env", neededVars: ["OPENAI_API_KEY", "GEMINI_API_KEY"] }),
    ).toBeUndefined();
  });

  test("appends only the missing vars, preserving existing content", () => {
    const { fs, files } = memFs({ "/w/.env": "OPENAI_API_KEY=sk-live" });
    const action = planEnvStubs({
      fs,
      envPath: "/w/.env",
      neededVars: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
    });
    action?.apply();
    const env = files.get("/w/.env") ?? "";
    expect(env).toContain("OPENAI_API_KEY=sk-live");
    expect(env).toContain("# ANTHROPIC_API_KEY=");
    expect(env).not.toContain("# OPENAI_API_KEY="); // already set — not re-stubbed
  });

  test("no-op for an empty needed set", () => {
    const { fs } = memFs();
    expect(planEnvStubs({ fs, envPath: "/w/.env", neededVars: [] })).toBeUndefined();
  });
});

describe("formatFixPlan", () => {
  test("dry-run wording lists actions and points at --fix", () => {
    const { fs } = memFs();
    const action = planScaffoldSpec({ fs, specPath: "/w/crewhaus.yaml", specName: "w" });
    const text = formatFixPlan(action ? [action] : [], false);
    expect(text).toContain("dry-run");
    expect(text).toContain("re-run with --fix");
  });

  test("applied wording says applied", () => {
    const { fs } = memFs();
    const action = planScaffoldSpec({ fs, specPath: "/w/crewhaus.yaml", specName: "w" });
    expect(formatFixPlan(action ? [action] : [], true)).toContain("applied 1 fix");
  });

  test("empty plan reports nothing to fix", () => {
    expect(formatFixPlan([], false)).toContain("nothing to fix");
    expect(formatFixPlan([], true)).toContain("nothing to fix");
  });
});
