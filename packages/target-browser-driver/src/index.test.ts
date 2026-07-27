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

describe("emitBrowserDriver — failureTaxonomy field (item 23)", () => {
  test("threads failureTaxonomy into the runChatLoop call", () => {
    const ir: IrBrowserV0 = {
      ...baseIr,
      failureTaxonomy: [
        { class: "rate_limited", pattern: "/429|rate.?limit/i", recovery: "retry" },
        { class: "tool_timeout", pattern: "ETIMEDOUT", recovery: "continue", hint: "slow tool" },
      ],
    };
    const c = emitBrowserDriver(ir).files[0]?.content ?? "";
    expect(c).toContain("failureTaxonomy:");
    expect(c).toContain('"recovery":"retry"');
    expect(c).toContain('"pattern":"ETIMEDOUT"');
  });

  test("omits failureTaxonomy when the IR leaves it unset or empty", () => {
    expect(emitBrowserDriver(baseIr).files[0]?.content ?? "").not.toContain("failureTaxonomy:");
    const empty: IrBrowserV0 = { ...baseIr, failureTaxonomy: [] };
    expect(emitBrowserDriver(empty).files[0]?.content ?? "").not.toContain("failureTaxonomy:");
  });
});

describe("emitBrowserDriver — agent.max_tokens (loop contract 0.4)", () => {
  test("declared agent.maxTokens replaces the pinned 4096 in the runChatLoop call", () => {
    const ir: IrBrowserV0 = { ...baseIr, agent: { ...baseIr.agent, maxTokens: 16384 } };
    const code = emitBrowserDriver(ir).files[0]?.content ?? "";
    expect(code).toContain("maxTokens: 16384,");
    expect(code).not.toContain("maxTokens: 4096,");
  });

  test("absent maxTokens keeps the pre-existing 4096 default (bundle bytes unchanged)", () => {
    const code = emitBrowserDriver(baseIr).files[0]?.content ?? "";
    expect(code).toContain("maxTokens: 4096,");
  });
});

describe("emitBrowserDriver — budget field (item 27, Batch A)", () => {
  test("threads budget into the runChatLoop call (degrade ladder model quoted)", () => {
    const ir: IrBrowserV0 = {
      ...baseIr,
      budget: { usdMicros: 2_500_000, onExceed: { kind: "degrade", model: "claude-haiku-4-5" } },
    };
    const code = emitBrowserDriver(ir).files[0]?.content ?? "";
    expect(code).toContain("budget: ");
    expect(code).toContain('"usdMicros":2500000');
    expect(code).toContain('"model":"claude-haiku-4-5"');
  });

  test("omits budget when the IR leaves it unset", () => {
    const code = emitBrowserDriver(baseIr).files[0]?.content ?? "";
    expect(code).not.toContain("budget:");
  });
});

describe("emitBrowserDriver — limits ceilings (loop contract 0.4, Batch A)", () => {
  test("threads every declared limits knob into the runChatLoop call 1:1", () => {
    const ir: IrBrowserV0 = {
      ...baseIr,
      limits: {
        maxToolIterations: 40,
        maxConcurrentTools: 2,
        contextLimit: 120_000,
        deadlineMs: 90_000,
        turnTimeoutMs: 60_000,
        modelCallTimeoutMs: 30_000,
        loopDetection: { window: 6, threshold: 3, escalation: "abort" },
      },
    };
    const code = emitBrowserDriver(ir).files[0]?.content ?? "";
    expect(code).toContain("maxToolIterations: 40,");
    expect(code).toContain("maxConcurrentTools: 2,");
    expect(code).toContain("contextLimit: 120000,");
    expect(code).toContain("deadlineMs: 90000,");
    expect(code).toContain("turnTimeoutMs: 60000,");
    expect(code).toContain("modelCallTimeoutMs: 30000,");
    expect(code).toContain('loopDetection: {"window":6,"threshold":3,"escalation":"abort"}');
  });

  test("partial limits emit only the declared knobs (runtime defaults stay authoritative)", () => {
    const ir: IrBrowserV0 = {
      ...baseIr,
      limits: { deadlineMs: 45_000, turnTimeoutMs: 30_000 },
    };
    const code = emitBrowserDriver(ir).files[0]?.content ?? "";
    expect(code).toContain("deadlineMs: 45000,");
    expect(code).toContain("turnTimeoutMs: 30000,");
    expect(code).not.toContain("maxToolIterations:");
    expect(code).not.toContain("modelCallTimeoutMs:");
    expect(code).not.toContain("loopDetection:");
  });

  test("omits every limits knob when the IR leaves limits unset", () => {
    const code = emitBrowserDriver(baseIr).files[0]?.content ?? "";
    expect(code).not.toContain("deadlineMs:");
    expect(code).not.toContain("turnTimeoutMs:");
    expect(code).not.toContain("modelCallTimeoutMs:");
    expect(code).not.toContain("maxToolIterations:");
    expect(code).not.toContain("loopDetection:");
  });
});

describe("emitBrowserDriver — REPL / --resume session mode (G51, ITEM 3)", () => {
  test("parses --prompt, --resume and --continue", () => {
    const code = emitBrowserDriver(baseIr).files[0]?.content ?? "";
    expect(code).toContain('valueOf("--prompt")');
    expect(code).toContain('valueOf("--resume")');
    expect(code).toContain('args.includes("--continue")');
  });

  test("validates the --resume sessionId shape and rejects --resume + --continue together", () => {
    const code = emitBrowserDriver(baseIr).files[0]?.content ?? "";
    expect(code).toContain("const SESSION_ID_REGEX = /^sess_[0-9a-f]{16}$/;");
    expect(code).toContain("SESSION_ID_REGEX.test(resumeId)");
    expect(code).toContain("--resume and --continue are mutually exclusive");
  });

  test("--continue resolves the most-recent session for this spec name via the session store", () => {
    const code = emitBrowserDriver(baseIr).files[0]?.content ?? "";
    expect(code).toContain('import { createSessionStore } from "@crewhaus/session-store";');
    expect(code).toContain("const sessionStore = createSessionStore();");
    expect(code).toContain("await sessionStore.list()");
    expect(code).toContain("sessions.find((s) => s.name === SPEC_NAME)");
    expect(code).toContain("resume = { sessionId: match.id };");
  });

  test("an interactive TTY with no --prompt drops into the persistent driver REPL", () => {
    const code = emitBrowserDriver(baseIr).files[0]?.content ?? "";
    // REPL detection + the driver stays connected across turns (single
    // runChatLoop call, no per-turn disconnect).
    expect(code).toContain("const repl = argPrompt === undefined && process.stdin.isTTY === true;");
    // REPL lets runChatLoop own stdin (singleTurn omitted); one-shot seeds it.
    expect(code).toContain("installSigintHandler: true,");
    expect(code).toContain("singleTurn: true,");
    expect(code).toContain('seedMessages: [{ role: "user", content: oneShotPrompt }],');
  });

  test("the resume path threads resume into runChatLoop and reseats the run context", () => {
    const code = emitBrowserDriver(baseIr).files[0]?.content ?? "";
    expect(code).toContain(
      "resume !== undefined ? createRunContext({ sessionId: resume.sessionId }) : createRunContext();",
    );
    expect(code).toContain("...(resume !== undefined ? { resume } : {}),");
  });

  test("ITEM 7 — the resumed run is wrapped in withIdempotency (at-least-once safety)", () => {
    const code = emitBrowserDriver(baseIr).files[0]?.content ?? "";
    expect(code).toContain(
      'import { createInMemoryIdempotencyStore, idempotencyKey, withIdempotency } from "@crewhaus/idempotency-keys";',
    );
    expect(code).toContain("const guarded = withIdempotency<undefined, string>(() => drive(), {");
    expect(code).toContain(
      "idempotencyKey(`${SPEC_NAME}:${resume.sessionId}:${oneShotPrompt}`, 0)",
    );
    // A fresh (non-resumed) run bypasses the idempotency wrapper.
    expect(code).toContain("finalText = await drive();");
  });

  test("limits + budget + max_tokens still ride each turn's runChatLoop options", () => {
    const ir: IrBrowserV0 = {
      ...baseIr,
      agent: { ...baseIr.agent, maxTokens: 8192 },
      budget: { usdMicros: 1_000_000, onExceed: { kind: "abort" } },
      limits: { turnTimeoutMs: 60_000 },
    };
    const code = emitBrowserDriver(ir).files[0]?.content ?? "";
    // The shared runOptions object carries them, so both REPL and one-shot turns
    // inherit the ceilings.
    expect(code).toContain("const runOptions = {");
    expect(code).toContain("maxTokens: 8192,");
    expect(code).toContain('"usdMicros":1000000');
    expect(code).toContain("turnTimeoutMs: 60000,");
  });
});

describe("emitBrowserDriver — spec hooks (loop contract 0.4, Batch A)", () => {
  test("declared hooks emit the HookDef import, SPEC_HOOKS const, and the runChatLoop field", () => {
    const ir: IrBrowserV0 = {
      ...baseIr,
      hooks: [
        { event: "pre-tool", matcher: "Click", command: "./guard.sh", timeoutMs: 5000 },
        { event: "stop", command: "./notify.sh" },
      ],
    };
    const code = emitBrowserDriver(ir).files[0]?.content ?? "";
    expect(code).toContain('import type { HookDef } from "@crewhaus/hooks-engine";');
    expect(code).toContain("const SPEC_HOOKS: ReadonlyArray<HookDef> = ");
    expect(code).toContain('"event":"pre-tool"');
    expect(code).toContain('"command":"./guard.sh"');
    expect(code).toContain("hooks: SPEC_HOOKS,");
    // Declaration order is semantics — pre-tool must serialize before stop.
    expect(code.indexOf('"event":"pre-tool"')).toBeLessThan(code.indexOf('"event":"stop"'));
  });

  test("omits all hooks plumbing when the IR leaves hooks unset or empty", () => {
    for (const ir of [baseIr, { ...baseIr, hooks: [] } satisfies IrBrowserV0]) {
      const code = emitBrowserDriver(ir).files[0]?.content ?? "";
      expect(code).not.toContain("@crewhaus/hooks-engine");
      expect(code).not.toContain("SPEC_HOOKS");
      expect(code).not.toContain("hooks:");
    }
  });
});

describe("emitBrowserDriver — headless ask parking (loop contract 0.4, G11)", () => {
  test("the one-shot turn carries askMode + approvals plus the store boot", () => {
    const code = emitBrowserDriver(baseIr).files[0]?.content ?? "";
    expect(code).toContain(
      'import { createPendingApprovalStore, resolveSessionRootDir } from "@crewhaus/runtime-core";',
    );
    // Rooted where the run's session files land (tenant root included), not cwd.
    expect(code).toContain("const __approvalRoot = resolveSessionRootDir(undefined);");
    expect(code).toContain("const __approvals = createPendingApprovalStore(");
    expect(code).toContain("__approvalRoot !== undefined ? { rootDir: __approvalRoot } : {},");
    // BOTH halves are required — runtime-core parks only on
    // `approvals !== undefined && askMode === "pause"`.
    expect(code).toContain('askMode: "pause",');
    expect(code).toContain('approvals: { store: __approvals, surface: "browser" },');
  });

  test("emitted even with NO permissions: block — the case where every unmatched tool asks", () => {
    const code = emitBrowserDriver(baseIr).files[0]?.content ?? "";
    expect(code).not.toContain("permissionMode");
    expect(code).not.toContain("permissionRules");
    expect(code).toContain('askMode: "pause",');
    expect(code).toContain("approvals: { store: __approvals");
  });

  test('ask_mode: deny emits askMode: "deny" and STILL wires the store', () => {
    const ir: IrBrowserV0 = { ...baseIr, permissions: { rules: [], askMode: "deny" } };
    const code = emitBrowserDriver(ir).files[0]?.content ?? "";
    expect(code).toContain('askMode: "deny",');
    expect(code).not.toContain('askMode: "pause",');
    // runtime-core tells "(no approvals store wired)" from a deliberate deny by
    // testing `approvals === undefined`, so withholding the store here would
    // blame absent plumbing for an operator's choice.
    expect(code).toContain('approvals: { store: __approvals, surface: "browser" },');
  });

  test("the REPL branch gets neither field — an interactive ask has stdin to prompt on", () => {
    const code = emitBrowserDriver(baseIr).files[0]?.content ?? "";
    // Exactly one call site carries them...
    expect(code.split("askMode:").length - 1).toBe(1);
    expect(code.split("approvals:").length - 1).toBe(1);
    // ...and it is the one-shot literal, not the REPL branch above it nor the
    // shared runOptions object that branch spreads.
    const runOptionsIdx = code.indexOf("const runOptions = {");
    const replIdx = code.indexOf("installSigintHandler: true,");
    const oneShotIdx = code.indexOf("singleTurn: true,");
    expect(runOptionsIdx).toBeGreaterThan(-1);
    expect(replIdx).toBeGreaterThan(runOptionsIdx);
    expect(oneShotIdx).toBeGreaterThan(replIdx);
    expect(code.slice(runOptionsIdx, oneShotIdx)).not.toContain("askMode:");
    expect(code.slice(runOptionsIdx, oneShotIdx)).not.toContain("approvals:");
  });
});
