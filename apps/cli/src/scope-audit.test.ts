import { describe, expect, test } from "bun:test";
import { OUTWARD_TOOL_NAMES } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolIoCapability } from "@crewhaus/tool-catalog";
import { fetch as fetchTool } from "@crewhaus/tool-fetch";
import { imageGenerate } from "@crewhaus/tool-image-generation";
import { webFetch, webSearch } from "@crewhaus/tool-web";
import { auditSpecToolNames, auditToolScopes, collectToolNames } from "./scope-audit";

// auditToolScopes reads `.name`, `.scope`, and `.ioCapability`; construct
// minimal doubles so the test can express the exact triples under audit —
// including the dangerous "outward name forced internal" case that no
// built-in fixture can produce (every built-in outward tool is external).
function mkTool(
  name: string,
  scope: "internal" | "external",
  ioCapability?: ToolIoCapability,
): RegisteredTool {
  return { name, scope, ...(ioCapability ? { ioCapability } : {}) } as unknown as RegisteredTool;
}

describe("auditToolScopes — FR-002 strict scope gate", () => {
  test("flags an outward-named tool left at scope:'internal' (the red path)", () => {
    const findings = auditToolScopes([mkTool("Fetch", "internal")]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.toolName).toBe("Fetch");
    expect(findings[0]?.reason).toContain('scope is "internal"');
    expect(findings[0]?.reason).toContain('expected "external"');
  });

  test("flags a namespaced MCP tool forced internal (prefix rule)", () => {
    const findings = auditToolScopes([mkTool("mcp__slack__send", "internal")]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.toolName).toBe("mcp__slack__send");
  });

  test("does NOT flag an outward tool that is correctly external", () => {
    expect(auditToolScopes([mkTool("Fetch", "external")])).toHaveLength(0);
  });

  test("does NOT flag a pure-compute internal tool", () => {
    expect(auditToolScopes([mkTool("read", "internal")])).toHaveLength(0);
  });

  test("reports every mis-scoped tool, leaving correct ones unflagged", () => {
    const findings = auditToolScopes([
      mkTool("Fetch", "internal"), // flagged
      mkTool("WebSearch", "external"), // ok
      mkTool("SendMessage", "internal"), // flagged
      mkTool("read", "internal"), // ok (internal compute)
    ]);
    expect(findings.map((f) => f.toolName).sort()).toEqual(["Fetch", "SendMessage"]);
  });

  test("an empty tool set produces no findings", () => {
    expect(auditToolScopes([])).toHaveLength(0);
  });

  // FR-002 mechanism-2 residual: the capability-driven path. These are the
  // cases the prior name-only audit could NOT reach — a custom buildTool tool
  // with a NOVEL name that opens a socket / spawns a process. Now that the
  // tool declares `ioCapability`, the audit binds scope:"external" to it.
  test("flags a NOVEL-named custom tool that declares ioCapability:'network' but is internal", () => {
    const findings = auditToolScopes([mkTool("SomeCustomSocketTool", "internal", "network")]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.toolName).toBe("SomeCustomSocketTool");
    expect(findings[0]?.reason).toContain('ioCapability "network"');
    expect(findings[0]?.reason).toContain('scope is "internal"');
  });

  test("flags a NOVEL-named custom tool that declares ioCapability:'process' but is internal", () => {
    const findings = auditToolScopes([mkTool("RunDaemon", "internal", "process")]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toContain('ioCapability "process"');
  });

  test("does NOT flag an io-capable custom tool that correctly set scope:'external'", () => {
    expect(auditToolScopes([mkTool("SomeCustomSocketTool", "external", "network")])).toHaveLength(
      0,
    );
  });

  test("the capability path fires even for a name the outward-name heuristic would miss", () => {
    // Proves the gate is no longer a no-op for user-authored tools: the name
    // is not in OUTWARD_TOOL_NAMES and is not mcp__-prefixed, yet it is flagged.
    const findings = auditToolScopes([mkTool("totally_internal_looking", "internal", "network")]);
    expect(findings).toHaveLength(1);
  });

  test("a tool with NEITHER capability nor outward name is not flagged (documented residual)", () => {
    // The irreducible limit of a static annotation check: a tool that touches
    // the network but declares neither its capability nor an outward name is
    // invisible to the audit. Pinned so the boundary is explicit, not implied.
    expect(auditToolScopes([mkTool("opaque", "internal")])).toHaveLength(0);
  });
});

describe("auditSpecToolNames — FR-002 compile --strict spec-level gate", () => {
  // Resolver doubles standing in for the offline built-in tool map.
  const resolveNone = (_name: string): RegisteredTool | undefined => undefined;

  test("flags an unresolved mcp__ sink referenced by a spec (the live red path)", () => {
    // This is the exact case the adversarial review proved exited 0: a spec
    // referencing an MCP tool the offline map cannot resolve. --strict now
    // refuses it because the sink's external scope is unverifiable offline.
    const findings = auditSpecToolNames(["mcp__evil__exfiltrate"], resolveNone);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.toolName).toBe("mcp__evil__exfiltrate");
    expect(findings[0]?.reason).toContain("unverifiable offline");
  });

  test("flags an unresolved outward-by-name built-in (e.g. SendMessage) referenced in a spec", () => {
    const findings = auditSpecToolNames(["SendMessage"], resolveNone);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.toolName).toBe("SendMessage");
  });

  test("does NOT flag an unknown NON-outward custom name (offline gate has nothing to assert)", () => {
    // Documented boundary: a name the offline map doesn't know and whose name
    // carries no outward signal is left to the live doctor audit / runtime.
    expect(auditSpecToolNames(["SomeCustomSocketTool"], resolveNone)).toHaveLength(0);
    expect(auditSpecToolNames(["read", "bash"], resolveNone)).toHaveLength(0);
  });

  test("defers to the per-tool audit for RESOLVED names (external built-in passes)", () => {
    const resolve = (name: string) =>
      name === "fetch" ? mkTool("Fetch", "external", "network") : undefined;
    expect(auditSpecToolNames(["fetch"], resolve)).toHaveLength(0);
  });

  test("flags a resolved built-in that an override forced back to internal", () => {
    const resolve = (name: string) =>
      name === "fetch" ? mkTool("Fetch", "internal", "network") : undefined;
    const findings = auditSpecToolNames(["fetch"], resolve);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.toolName).toBe("Fetch");
  });

  test("mixes resolved-clean, resolved-dirty, and unresolved-outward names correctly", () => {
    const resolve = (name: string): RegisteredTool | undefined => {
      if (name === "fetch") return mkTool("Fetch", "external", "network"); // clean
      if (name === "webFetch") return mkTool("WebFetch", "internal", "network"); // dirty
      if (name === "read") return mkTool("read", "internal"); // clean internal
      return undefined; // mcp__x__y → unresolved outward
    };
    const findings = auditSpecToolNames(["fetch", "webFetch", "read", "mcp__x__y"], resolve);
    expect(findings.map((f) => f.toolName).sort()).toEqual(["WebFetch", "mcp__x__y"]);
  });
});

describe("collectToolNames — variant-agnostic IR tool extraction", () => {
  test("collects top-level ir.tools", () => {
    const ir = { target: "cli", tools: ["fetch", "read"] };
    expect(collectToolNames(ir).sort()).toEqual(["fetch", "read"]);
  });

  test("collects nested tools (steps / sub-agents) and dedups", () => {
    const ir = {
      target: "workflow",
      tools: ["fetch"],
      steps: [{ tools: ["read", "fetch"] }, { tools: ["bash"] }],
      subAgents: [{ tools: ["webSearch"] }],
    };
    expect(collectToolNames(ir).sort()).toEqual(["bash", "fetch", "read", "webSearch"]);
  });

  test("ignores non-string entries and non-tools keys", () => {
    const ir = { tools: ["fetch", 42, null], notTools: ["ignored"] };
    expect(collectToolNames(ir)).toEqual(["fetch"]);
  });

  test("returns empty for a toolless IR", () => {
    expect(collectToolNames({ target: "cli", agent: {} })).toEqual([]);
  });
});

// FR-002 minor gap #3 — pin the loadToolMap key ↔ RegisteredTool.name ↔
// scope ↔ ioCapability alignment for the offline-resolvable outward built-ins.
// collectToolNames yields camelCase KEYS (fetch/webFetch/webSearch/
// imageGenerate); the audit keys on the PascalCase .name PROPERTY. The strict
// resolve path only lines up because loadToolMap resolves key→RegisteredTool
// first. This test asserts the source-of-truth: each outward built-in's .name
// is in OUTWARD_TOOL_NAMES AND it ships scope:"external" AND it declares
// ioCapability — so a future refactor that breaks any leg fails here rather
// than silently making the strict audit match nothing.
describe("FR-002 invariant — outward built-ins are correctly self-describing", () => {
  // Imported from the real packages (the same modules loadToolMap() imports),
  // keyed by the camelCase loadToolMap key they are registered under.
  const outwardBuiltins: Record<string, RegisteredTool> = {
    fetch: fetchTool,
    webFetch,
    webSearch,
    imageGenerate,
  };

  test.each(Object.entries(outwardBuiltins))(
    "loadToolMap key %s resolves to an external, io-capable, outward-named tool",
    (_key, tool) => {
      expect(OUTWARD_TOOL_NAMES.has(tool.name)).toBe(true);
      expect(tool.scope).toBe("external");
      expect(tool.ioCapability).toBe("network");
    },
  );

  test("each resolved outward built-in passes auditToolScopes (no finding)", () => {
    expect(auditToolScopes(Object.values(outwardBuiltins))).toHaveLength(0);
  });
});
