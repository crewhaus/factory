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
  test("emits a single agent.ts file (T1 bundle structure)", () => {
    const bundle = emitBrowserDriver(baseIr);
    expect(bundle.files).toHaveLength(1);
    expect(bundle.files[0]?.path).toBe("agent.ts");
  });

  test("agent.ts wires driver + screenshot + mouse-keyboard + vision-grounding", () => {
    const code = emitBrowserDriver(baseIr).files[0]?.content ?? "";
    expect(code).toContain("@crewhaus/computer-use-driver");
    expect(code).toContain("@crewhaus/tool-screen-capture");
    expect(code).toContain("@crewhaus/tool-mouse-keyboard");
    expect(code).toContain("@crewhaus/tool-vision-grounding");
    expect(code).toContain("createScreenshotTool");
    expect(code).toContain("createAllMouseKeyboardTools");
    expect(code).toContain("createFindElementTool");
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
