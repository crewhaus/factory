import { describe, expect, test } from "bun:test";
import type { IrBrowserV0 } from "@crewhaus/ir";
import { TargetEmitError, emitBrowserDriver } from "./index.js";

const baseIr: IrBrowserV0 = {
  version: 0,
  name: "hello-browser",
  target: "browser",
  agent: { model: "claude-sonnet-4-6", instructions: "you click things" },
  driver: { backend: "chromium", viewport: { width: 1280, height: 720 } },
  groundingModel: "claude-sonnet-4-6",
  tools: [],
  toolConfigs: Object.freeze({}),
  mcp_servers: Object.freeze({}),
  permissions: { rules: [] },
  compaction: {},
};

describe("emitBrowserDriver", () => {
  test("emits agent.ts plus the generated README.md (T1 bundle structure, item 42)", () => {
    const bundle = emitBrowserDriver(baseIr);
    expect(bundle.files).toHaveLength(2);
    expect(bundle.files[0]?.path).toBe("agent.ts");
    expect(bundle.files[1]?.path).toBe("README.md");
  });

  test("readme: false restores the single-file bundle (item 42 opt-out)", () => {
    const bundle = emitBrowserDriver(baseIr, { readme: false });
    expect(bundle.files).toHaveLength(1);
    expect(bundle.files[0]?.path).toBe("agent.ts");
  });

  test("agent.ts wires driver + navigate + screenshot + mouse-keyboard + vision-grounding", () => {
    const code = emitBrowserDriver(baseIr).files[0]?.content ?? "";
    expect(code).toContain("@crewhaus/computer-use-driver");
    expect(code).toContain("@crewhaus/tool-navigate");
    expect(code).toContain("@crewhaus/tool-screen-capture");
    expect(code).toContain("@crewhaus/tool-mouse-keyboard");
    expect(code).toContain("@crewhaus/tool-vision-grounding");
    expect(code).toContain("createNavigateTool");
    expect(code).toContain("createScreenshotTool");
    expect(code).toContain("createAllMouseKeyboardTools");
    expect(code).toContain("createFindElementTool");
  });

  test("Navigate is listed first in the runtime tools array (bootstrap before others)", () => {
    const code = emitBrowserDriver(baseIr).files[0]?.content ?? "";
    // The emitted line declares the tools array. Navigate must appear before
    // Screenshot / Click / Type / Key / Scroll / FindElement so the agent has
    // an obvious entry point when no startUrl is set.
    const toolsLine = code.split("\n").find((l) => l.includes("const tools = ["));
    expect(toolsLine).toBeDefined();
    expect(toolsLine).toContain("navigateTool");
    const navIdx = toolsLine?.indexOf("navigateTool") ?? -1;
    const screenshotIdx = toolsLine?.indexOf("screenshotTool") ?? -1;
    expect(navIdx).toBeGreaterThanOrEqual(0);
    expect(screenshotIdx).toBeGreaterThan(navIdx);
  });

  test("startUrl, when set, triggers driver.goto() before runChatLoop", () => {
    const ir: IrBrowserV0 = {
      ...baseIr,
      driver: { ...baseIr.driver, startUrl: "http://localhost:3000/" },
    };
    const code = emitBrowserDriver(ir).files[0]?.content ?? "";
    expect(code).toContain('"http://localhost:3000/"');
    expect(code).toContain("driver.goto(SPEC_START_URL)");
    expect(code).toContain('"navigated"');
  });

  test("absent startUrl yields SPEC_START_URL = undefined", () => {
    const code = emitBrowserDriver(baseIr).files[0]?.content ?? "";
    expect(code).toContain("SPEC_START_URL = undefined");
  });

  test("hard-codes backend + viewport from the spec", () => {
    const code = emitBrowserDriver(baseIr).files[0]?.content ?? "";
    expect(code).toContain('SPEC_BACKEND: "host" | "chromium" | "remote" = "chromium"');
    expect(code).toContain("width: 1280, height: 720");
  });

  test("permission rules: spec yaml-source rules pass through (T8 floor)", () => {
    const ir: IrBrowserV0 = {
      ...baseIr,
      permissions: {
        mode: "default",
        rules: [
          { type: "alwaysAllow", pattern: "Click" },
          { type: "alwaysAllow", pattern: "FindElement" },
        ],
      },
    };
    const code = emitBrowserDriver(ir).files[0]?.content ?? "";
    expect(code).toContain('permissionMode: "default"');
    expect(code).toContain('pattern: "Click"');
    expect(code).toContain('pattern: "FindElement"');
    expect(code).toContain("BUILTIN_DEFAULT_RULES");
  });

  test("permission floor: NO alwaysAllow rules → no permissionRules block emitted (default mode denies destructive)", () => {
    const code = emitBrowserDriver(baseIr).files[0]?.content ?? "";
    expect(code).not.toContain("permissionMode");
    expect(code).not.toContain("permissionRules");
    expect(code).not.toContain("BUILTIN_DEFAULT_RULES");
  });

  test("daemon parses --prompt arg + falls back to stdin", () => {
    const code = emitBrowserDriver(baseIr).files[0]?.content ?? "";
    expect(code).toContain('"--prompt"');
    expect(code).toContain("readStdin");
  });

  test("daemon emits browser_start / navigated / browser_done JSON events", () => {
    const ir: IrBrowserV0 = {
      ...baseIr,
      driver: { ...baseIr.driver, startUrl: "http://localhost:3000/" },
    };
    const code = emitBrowserDriver(ir).files[0]?.content ?? "";
    expect(code).toContain('"browser_start"');
    expect(code).toContain('"navigated"');
    expect(code).toContain('"browser_done"');
  });

  test("TargetEmitError type is exported", () => {
    expect(TargetEmitError).toBeDefined();
  });
});

describe("emitBrowserDriver — tool wiring (parity with runRunBrowser)", () => {
  test("empty tools list emits no tool imports and no register block", () => {
    const code = emitBrowserDriver(baseIr).files[0]?.content ?? "";
    // defaultCatalog import is still present — the final tools array spreads
    // it, so the bundle still compiles when no spec tools are declared.
    expect(code).toContain('from "@crewhaus/tool-catalog"');
    // none of the built-in tool packages should appear
    expect(code).not.toContain("@crewhaus/tool-fs");
    expect(code).not.toContain("@crewhaus/tool-bash");
    expect(code).not.toContain("@crewhaus/tool-web");
    expect(code).not.toContain("@crewhaus/tool-fetch");
    expect(code).not.toContain("defaultCatalog.register(");
    // and the final tools array still has the catalog spread (regression
    // guard for the existing behavior)
    expect(code).toContain("...defaultCatalog.list()");
  });

  test("a single spec tool emits one import + one defaultCatalog.register call", () => {
    const ir: IrBrowserV0 = { ...baseIr, tools: ["read"] };
    const code = emitBrowserDriver(ir).files[0]?.content ?? "";
    expect(code).toContain('import { read } from "@crewhaus/tool-fs";');
    expect(code).toContain("defaultCatalog.register(read);");
    // and the spread is still in place — registrations land in the final
    // tools array via defaultCatalog.list()
    expect(code).toContain("...defaultCatalog.list()");
  });

  test("multiple tools from the same package are grouped into one import", () => {
    const ir: IrBrowserV0 = { ...baseIr, tools: ["read", "write", "edit"] };
    const code = emitBrowserDriver(ir).files[0]?.content ?? "";
    expect(code).toMatch(/import \{ edit, read, write \} from "@crewhaus\/tool-fs";/);
    expect(code).toContain("defaultCatalog.register(read);");
    expect(code).toContain("defaultCatalog.register(write);");
    expect(code).toContain("defaultCatalog.register(edit);");
  });

  test("tools across multiple packages each get their own grouped import", () => {
    const ir: IrBrowserV0 = { ...baseIr, tools: ["read", "bash", "todoWrite"] };
    const code = emitBrowserDriver(ir).files[0]?.content ?? "";
    expect(code).toContain('import { bash } from "@crewhaus/tool-bash";');
    expect(code).toContain('import { read } from "@crewhaus/tool-fs";');
    expect(code).toContain('import { todoWrite } from "@crewhaus/tool-todo";');
  });

  test("unknown tool throws TargetEmitError naming the offender + known names", () => {
    const ir: IrBrowserV0 = { ...baseIr, tools: ["unknownTool"] };
    expect(() => emitBrowserDriver(ir)).toThrow(TargetEmitError);
    try {
      emitBrowserDriver(ir);
    } catch (e) {
      expect(e).toBeInstanceOf(TargetEmitError);
      expect((e as Error).message).toContain('unknown tool "unknownTool"');
      expect((e as Error).message).toContain("known tools:");
      expect((e as Error).message).toContain("read");
    }
  });

  test("fetch with toolConfigs.fetch emits registerFetchConfig before the register call", () => {
    const ir: IrBrowserV0 = {
      ...baseIr,
      tools: ["fetch"],
      toolConfigs: { fetch: { allowed_origins: ["https://example.com"] } },
    };
    const code = emitBrowserDriver(ir).files[0]?.content ?? "";
    expect(code).toMatch(/import \{ fetch, registerFetchConfig \} from "@crewhaus\/tool-fetch";/);
    expect(code).toContain('registerFetchConfig({"allowed_origins":["https://example.com"]});');
    expect(code).toContain("defaultCatalog.register(fetch);");
    // init must come before the register call (so the tool sees its config
    // on first execute)
    const initIdx = code.indexOf("registerFetchConfig(");
    const registerIdx = code.indexOf("defaultCatalog.register(fetch);");
    expect(initIdx).toBeGreaterThan(-1);
    expect(registerIdx).toBeGreaterThan(initIdx);
  });

  test("webFetch with toolConfigs.webFetch emits registerWebFetchConfig", () => {
    const ir: IrBrowserV0 = {
      ...baseIr,
      tools: ["webFetch"],
      toolConfigs: { webFetch: { timeout_ms: 5000 } },
    };
    const code = emitBrowserDriver(ir).files[0]?.content ?? "";
    expect(code).toMatch(
      /import \{ registerWebFetchConfig, webFetch \} from "@crewhaus\/tool-web";/,
    );
    expect(code).toContain('registerWebFetchConfig({"timeout_ms":5000});');
    expect(code).toContain("defaultCatalog.register(webFetch);");
  });

  test("a tool with an initSymbol but no config does NOT emit an init call", () => {
    // fetch has an initSymbol but toolConfigs is empty — register should
    // still happen, but no registerFetchConfig() call.
    const ir: IrBrowserV0 = { ...baseIr, tools: ["fetch"] };
    const code = emitBrowserDriver(ir).files[0]?.content ?? "";
    expect(code).toContain('import { fetch } from "@crewhaus/tool-fetch";');
    expect(code).toContain("defaultCatalog.register(fetch);");
    expect(code).not.toContain("registerFetchConfig(");
  });

  test("tools without an initSymbol emit no init call regardless of toolConfigs", () => {
    // webSearch has no initSymbol; a config keyed on it should be ignored.
    const ir: IrBrowserV0 = {
      ...baseIr,
      tools: ["webSearch"],
      toolConfigs: { webSearch: { ignored: true } },
    };
    const code = emitBrowserDriver(ir).files[0]?.content ?? "";
    expect(code).toContain('import { webSearch } from "@crewhaus/tool-web";');
    expect(code).toContain("defaultCatalog.register(webSearch);");
    expect(code).not.toContain("registerWebFetchConfig(");
    expect(code).not.toContain("registerFetchConfig(");
  });

  test("tool registrations sit between imports and the SPEC_NAME constants", () => {
    const ir: IrBrowserV0 = { ...baseIr, tools: ["read"] };
    const code = emitBrowserDriver(ir).files[0]?.content ?? "";
    const importIdx = code.indexOf('import { read } from "@crewhaus/tool-fs";');
    const registerIdx = code.indexOf("defaultCatalog.register(read);");
    const specNameIdx = code.indexOf("const SPEC_NAME =");
    expect(importIdx).toBeGreaterThanOrEqual(0);
    expect(registerIdx).toBeGreaterThan(importIdx);
    expect(specNameIdx).toBeGreaterThan(registerIdx);
  });

  test("permission rules and spec tools coexist without stepping on each other", () => {
    const ir: IrBrowserV0 = {
      ...baseIr,
      tools: ["read"],
      permissions: {
        mode: "default",
        rules: [{ type: "alwaysAllow", pattern: "Click" }],
      },
    };
    const code = emitBrowserDriver(ir).files[0]?.content ?? "";
    expect(code).toContain('import { read } from "@crewhaus/tool-fs";');
    expect(code).toContain("defaultCatalog.register(read);");
    expect(code).toContain("BUILTIN_DEFAULT_RULES");
    expect(code).toContain('permissionMode: "default"');
    expect(code).toContain('pattern: "Click"');
  });
});

describe("emitBrowserDriver — single-turn parity (no mcp_servers, no compaction)", () => {
  test("mcp_servers in the IR is NOT wired (matches runRunBrowser's single-turn semantics)", () => {
    const ir: IrBrowserV0 = {
      ...baseIr,
      mcp_servers: {
        everything: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-everything"],
        },
      },
    };
    const code = emitBrowserDriver(ir).files[0]?.content ?? "";
    // No McpHost boot, no registerMcpServer, no disconnectAll cleanup.
    // If this ever needs to change, the run path (apps/cli runRunBrowser)
    // must change in lockstep.
    expect(code).not.toContain("@crewhaus/mcp-host");
    expect(code).not.toContain("@crewhaus/tool-mcp");
    expect(code).not.toContain("McpHost");
    expect(code).not.toContain("registerMcpServer");
    expect(code).not.toContain("disconnectAll");
  });

  test("compaction in the IR is NOT wired (matches runRunBrowser's single-turn semantics)", () => {
    const ir: IrBrowserV0 = {
      ...baseIr,
      compaction: { curate: true, dedupeThreshold: 0.9 },
    };
    const code = emitBrowserDriver(ir).files[0]?.content ?? "";
    expect(code).not.toContain("compaction");
    expect(code).not.toContain("curate");
    expect(code).not.toContain("@crewhaus/compaction-");
  });
});
