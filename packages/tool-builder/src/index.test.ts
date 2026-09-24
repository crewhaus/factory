import { describe, expect, test } from "bun:test";
import type { RegisteredTool, ToolDefinition, ToolIoCapability } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { OUTWARD_TOOL_NAMES, auditToolScopes, buildTool, isOutwardName } from "./index";

const echoSchema = z.object({ message: z.string() });
type EchoInput = z.infer<typeof echoSchema>;

const echoDef: ToolDefinition<EchoInput> = {
  name: "Echo",
  description: "Echoes the message",
  inputSchema: echoSchema,
  execute: async (input) => input.message,
};

describe("buildTool — fail-closed defaults", () => {
  test("concurrencySafe defaults to false", () => {
    const tool = buildTool(echoDef);
    expect(tool.concurrencySafe).toBe(false);
  });

  test("readOnly defaults to false", () => {
    const tool = buildTool(echoDef);
    expect(tool.readOnly).toBe(false);
  });

  test("destructive defaults to false", () => {
    const tool = buildTool(echoDef);
    expect(tool.destructive).toBe(false);
  });

  test("explicit true flags are preserved", () => {
    const tool = buildTool({
      ...echoDef,
      concurrencySafe: true,
      readOnly: true,
      destructive: true,
    });
    expect(tool.concurrencySafe).toBe(true);
    expect(tool.readOnly).toBe(true);
    expect(tool.destructive).toBe(true);
  });

  test("explicit false flags are preserved", () => {
    const tool = buildTool({
      ...echoDef,
      concurrencySafe: false,
      readOnly: false,
      destructive: false,
    });
    expect(tool.concurrencySafe).toBe(false);
    expect(tool.readOnly).toBe(false);
    expect(tool.destructive).toBe(false);
  });

  test("requiresSandbox defaults to false (fail-closed)", () => {
    const tool = buildTool(echoDef);
    expect(tool.requiresSandbox).toBe(false);
  });

  test("requiresSandbox=true is preserved", () => {
    const tool = buildTool({ ...echoDef, requiresSandbox: true });
    expect(tool.requiresSandbox).toBe(true);
  });

  test("classifyOutput defaults to true", () => {
    const tool = buildTool(echoDef);
    expect(tool.classifyOutput).toBe(true);
  });

  test("classifyOutput=false is preserved", () => {
    const tool = buildTool({ ...echoDef, classifyOutput: false });
    expect(tool.classifyOutput).toBe(false);
  });

  test("scope defaults to 'internal' (Pillar 3 sink-side, fail-closed)", () => {
    const tool = buildTool(echoDef);
    expect(tool.scope).toBe("internal");
  });

  test("scope='external' is preserved", () => {
    const tool = buildTool({ ...echoDef, scope: "external" });
    expect(tool.scope).toBe("external");
  });

  test("requireJustification defaults to false (Pillar 3 intent gate, fail-closed)", () => {
    const tool = buildTool(echoDef);
    expect(tool.requireJustification).toBe(false);
  });

  test("requireJustification=true is preserved", () => {
    const tool = buildTool({ ...echoDef, requireJustification: true });
    expect(tool.requireJustification).toBe(true);
  });

  // FR-002 — io-capability passthrough. Like jsonSchema, the field is omitted
  // entirely when the definition does not set it (additive; no behavior change
  // for the ~all tools that don't declare it).
  test("ioCapability is omitted when not set on the definition", () => {
    const tool = buildTool(echoDef);
    expect(tool.ioCapability).toBeUndefined();
    expect("ioCapability" in tool).toBe(false);
  });

  test("ioCapability:'network' is passed through verbatim", () => {
    const tool = buildTool({ ...echoDef, name: "CustomSocket", ioCapability: "network" });
    expect(tool.ioCapability).toBe("network");
  });

  test("ioCapability:'process' is passed through verbatim", () => {
    const tool = buildTool({ ...echoDef, name: "RunDaemon", ioCapability: "process" });
    expect(tool.ioCapability).toBe("process");
  });

  test("ioCapability does NOT itself flip the scope default (scope stays its own decision)", () => {
    // ioCapability is the *fact*; scope is the *policy*. buildTool does not
    // infer scope from ioCapability — the compile-time audit is what couples
    // them. A custom io-capable tool that forgets scope still defaults to
    // "internal" here (fail-closed), which is exactly what --strict then flags.
    const tool = buildTool({ ...echoDef, name: "CustomSocket", ioCapability: "network" });
    expect(tool.scope).toBe("internal");
  });
});

describe("buildTool — FR-002 outward-name scope inference (defense-in-depth)", () => {
  test("an outward-name tool with no explicit scope infers 'external' (Fetch)", () => {
    const tool = buildTool({ ...echoDef, name: "Fetch" });
    expect(tool.scope).toBe("external");
  });

  test.each(["WebFetch", "WebSearch", "SendMessage", "EvmSendTransaction", "ImageGenerate"])(
    "outward built-in %s infers 'external' when scope is unspecified",
    (name) => {
      const tool = buildTool({ ...echoDef, name });
      expect(tool.scope).toBe("external");
    },
  );

  test("a namespaced MCP tool (mcp__server__tool) infers 'external' via the prefix rule", () => {
    const tool = buildTool({ ...echoDef, name: "mcp__slack__send" });
    expect(tool.scope).toBe("external");
  });

  test("a pure-compute name (Echo) still defaults to 'internal'", () => {
    const tool = buildTool({ ...echoDef, name: "Echo" });
    expect(tool.scope).toBe("internal");
  });

  test("an explicit scope:'internal' on an outward NAME is preserved (def.scope wins)", () => {
    // The override path the FR's red gate covers: an author can still force a
    // known-outward tool back to internal, and the audit (compile --strict /
    // doctor) is what flags that as the footgun.
    const tool = buildTool({ ...echoDef, name: "Fetch", scope: "internal" });
    expect(tool.scope).toBe("internal");
  });

  test("an explicit scope:'external' on a non-outward name is preserved", () => {
    const tool = buildTool({ ...echoDef, name: "CustomSocket", scope: "external" });
    expect(tool.scope).toBe("external");
  });
});

describe("isOutwardName / OUTWARD_TOOL_NAMES", () => {
  test("returns true for every name in the outward set", () => {
    for (const name of OUTWARD_TOOL_NAMES) {
      expect(isOutwardName(name)).toBe(true);
    }
  });

  test("returns true for any mcp__-prefixed name", () => {
    expect(isOutwardName("mcp__github__create_issue")).toBe(true);
    expect(isOutwardName("mcp__")).toBe(true);
  });

  test("returns false for internal/compute tool names", () => {
    expect(isOutwardName("Echo")).toBe(false);
    expect(isOutwardName("read")).toBe(false);
    expect(isOutwardName("bash")).toBe(false);
    // a name that merely contains 'mcp' but isn't prefixed is not outward
    expect(isOutwardName("dumpcp")).toBe(false);
  });
});

describe("buildTool — identity fields", () => {
  test("name and description are passed through", () => {
    const tool = buildTool(echoDef);
    expect(tool.name).toBe("Echo");
    expect(tool.description).toBe("Echoes the message");
  });

  test("inputSchema is passed through", () => {
    const tool = buildTool(echoDef);
    expect(tool.inputSchema).toBe(echoSchema);
  });
});

describe("buildTool — jsonSchema passthrough", () => {
  test("jsonSchema is omitted when not set on the definition", () => {
    const tool = buildTool(echoDef);
    expect(tool.jsonSchema).toBeUndefined();
    expect("jsonSchema" in tool).toBe(false);
  });

  test("jsonSchema is preserved verbatim when present", () => {
    const raw = {
      type: "object" as const,
      properties: { message: { type: "string" as const } },
      required: ["message"],
    };
    const tool = buildTool({ ...echoDef, jsonSchema: raw });
    expect(tool.jsonSchema).toBe(raw);
  });
});

describe("auditToolScopes — FR-002 pure scope gate", () => {
  // auditToolScopes reads `.name`, `.scope`, and `.ioCapability` only; minimal
  // doubles let us express the exact triples under audit — including the
  // dangerous "outward name / io-capable but forced internal" cases that the
  // fail-closed buildTool default plus an explicit scope override can produce.
  function mkTool(
    name: string,
    scope: "internal" | "external",
    ioCapability?: ToolIoCapability,
  ): RegisteredTool {
    return { name, scope, ...(ioCapability ? { ioCapability } : {}) } as unknown as RegisteredTool;
  }

  test("flags a network tool left scope:'internal' (capability path, novel name)", () => {
    const findings = auditToolScopes([mkTool("SomeCustomSocketTool", "internal", "network")]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.toolName).toBe("SomeCustomSocketTool");
    expect(findings[0]?.reason).toContain('ioCapability "network"');
    expect(findings[0]?.reason).toContain('scope is "internal"');
  });

  test("flags a process tool left scope:'internal' (capability path)", () => {
    const findings = auditToolScopes([mkTool("RunDaemon", "internal", "process")]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toContain('ioCapability "process"');
  });

  test("flags an outward-named tool forced internal (name backstop)", () => {
    const findings = auditToolScopes([mkTool("Fetch", "internal")]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.toolName).toBe("Fetch");
    expect(findings[0]?.reason).toContain('expected "external"');
  });

  test("flags a namespaced MCP tool forced internal (mcp__ prefix)", () => {
    expect(auditToolScopes([mkTool("mcp__slack__send", "internal")])).toHaveLength(1);
  });

  test("passes a correctly-annotated set (external io-capable + external outward + internal compute)", () => {
    const clean = auditToolScopes([
      mkTool("SomeCustomSocketTool", "external", "network"),
      mkTool("Fetch", "external"),
      mkTool("read", "internal"),
    ]);
    expect(clean).toHaveLength(0);
  });

  test("reports every mis-scoped tool, leaving correct ones unflagged", () => {
    const findings = auditToolScopes([
      mkTool("Fetch", "internal"), // flagged (outward name)
      mkTool("WebSearch", "external"), // ok
      mkTool("SendMessage", "internal"), // flagged (outward name)
      mkTool("read", "internal"), // ok (internal compute)
    ]);
    expect(findings.map((f) => f.toolName).sort()).toEqual(["Fetch", "SendMessage"]);
  });

  test("an empty tool set produces no findings", () => {
    expect(auditToolScopes([])).toHaveLength(0);
  });

  test("a tool with NEITHER capability nor outward name is not flagged (documented residual)", () => {
    expect(auditToolScopes([mkTool("opaque", "internal")])).toHaveLength(0);
  });
});

describe("buildTool — execute delegation", () => {
  test("registered execute calls original def.execute", async () => {
    const tool = buildTool(echoDef);
    const result = await tool.execute({ message: "hello" });
    expect(result).toBe("hello");
  });

  test("execute propagates errors from def.execute", async () => {
    const failDef: ToolDefinition<EchoInput> = {
      ...echoDef,
      execute: async () => {
        throw new Error("boom");
      },
    };
    const tool = buildTool(failDef);
    expect(tool.execute({ message: "x" })).rejects.toThrow("boom");
  });
});

describe("buildTool — operativeArgs (0.7.1)", () => {
  const exec = async () => "ok";
  const nested = z.object({
    path: z.string().optional(),
    content: z.string(),
    argv: z.array(z.string()),
    target: z.object({ url: z.string() }).strict(),
    requests: z.array(z.object({ url: z.string(), method: z.enum(["GET", "POST"]) })),
    issue: z.number().int(),
    mode: z.union([z.literal("fast"), z.literal("slow")]),
    refined: z.string().refine((s) => s.length > 0),
  });

  test("passes a valid declaration through, frozen", () => {
    const tool = buildTool({
      name: "Nested",
      description: "d",
      inputSchema: nested,
      execute: exec,
      operativeArgs: [
        { field: "path", kind: "path", default: "." },
        { field: "argv", kind: "command" },
        { field: "target.url", kind: "url" },
        { field: "requests.url", kind: "url" },
        { field: "issue", kind: "id" },
        { field: "mode", kind: "text" },
        { field: "refined", kind: "text" },
      ],
    });
    expect(tool.operativeArgs?.map((a) => a.field)).toEqual([
      "path",
      "argv",
      "target.url",
      "requests.url",
      "issue",
      "mode",
      "refined",
    ]);
    expect(tool.operativeArgs?.[0]).toEqual({ field: "path", kind: "path", default: "." });
    expect(Object.isFrozen(tool.operativeArgs)).toBe(true);
  });

  test("omitted on the definition ⇒ omitted on the tool", () => {
    expect("operativeArgs" in buildTool(echoDef)).toBe(false);
  });

  test("a field the schema does not have throws at build time, naming what is there", () => {
    expect(() =>
      buildTool({ ...echoDef, operativeArgs: [{ field: "file_path", kind: "path" }] }),
    ).toThrow(
      /tool "Echo": operativeArgs \[0\]: the input schema has no field "file_path" \(it has: message\)/,
    );
  });

  test("an unknown nested field throws too", () => {
    expect(() =>
      buildTool({
        name: "Nested",
        description: "d",
        inputSchema: nested,
        execute: exec,
        operativeArgs: [{ field: "target.host", kind: "url" }],
      }),
    ).toThrow(/has no field "target.host"/);
  });

  test("descending into a string throws", () => {
    expect(() =>
      buildTool({ ...echoDef, operativeArgs: [{ field: "message.inner", kind: "text" }] }),
    ).toThrow(/"message" is not an object/);
  });

  test("a non-string field is refused unless the kind is id", () => {
    const def = {
      name: "Nested",
      description: "d",
      inputSchema: nested,
      execute: exec,
    };
    expect(() => buildTool({ ...def, operativeArgs: [{ field: "issue", kind: "text" }] })).toThrow(
      /"issue" is a number; only kind "id"/,
    );
    expect(() =>
      buildTool({
        name: "Obj",
        description: "d",
        inputSchema: z.object({ target: z.object({ url: z.string() }) }),
        execute: exec,
        operativeArgs: [{ field: "target", kind: "url" }],
      }),
    ).toThrow(/is a object, not a string/);
  });

  test("an unknown kind, an empty segment and a duplicate field are refused", () => {
    expect(() =>
      buildTool({
        ...echoDef,
        operativeArgs: [{ field: "message", kind: "glob" as unknown as "text" }],
      }),
    ).toThrow(/kind "glob" is not one of path, url, command, recipient, text, id/);
    expect(() =>
      buildTool({ ...echoDef, operativeArgs: [{ field: "message.", kind: "text" }] }),
    ).toThrow(/empty segment/);
    expect(() =>
      buildTool({
        ...echoDef,
        operativeArgs: [
          { field: "message", kind: "text" },
          { field: "message", kind: "text" },
        ],
      }),
    ).toThrow(/names "message" twice/);
  });

  test("an empty declaration is kept: the tool says no argument scopes it", () => {
    const tool = buildTool({ ...echoDef, operativeArgs: [] });
    expect(tool.operativeArgs).toEqual([]);
  });

  describe("within — one field qualified by another", () => {
    const repoSchema = z.object({
      owner: z.string(),
      repo: z.string(),
      chainId: z.number().int(),
      tags: z.array(z.string()),
      path: z.string(),
      nested: z.object({ org: z.string() }),
    });
    const def = { name: "Repo", description: "d", inputSchema: repoSchema, execute: exec };

    test("a recipient, text or id field can name a top-level string or number", () => {
      const tool = buildTool({
        ...def,
        operativeArgs: [
          { field: "repo", kind: "recipient", within: "owner" },
          { field: "owner", kind: "id", within: "chainId" },
        ],
      });
      expect(tool.operativeArgs?.[0]).toEqual({
        field: "repo",
        kind: "recipient",
        within: "owner",
      });
    });

    test("each way a qualifier can be wrong is refused, saying why", () => {
      const bad =
        (within: string, kind: "recipient" | "path" = "recipient") =>
        () =>
          buildTool({
            ...def,
            operativeArgs: [{ field: kind === "path" ? "path" : "repo", kind, within }],
          });
      expect(() =>
        buildTool({ ...def, operativeArgs: [{ field: "owner", kind: "url", within: "repo" }] }),
      ).toThrow(/a "url" value cannot be qualified/);
      expect(bad("owner", "path")).not.toThrow();
      expect(bad("missing")).toThrow(/has no top-level field "missing"/);
      expect(bad("tags")).toThrow(/field "tags" is a list/);
      expect(bad("nested")).toThrow(/field "nested" is not a string or a number/);
      expect(bad("nested.org")).toThrow(/must name one top-level input field/);
      expect(bad("repo")).toThrow(/names "repo" itself/);
    });
  });

  test("an opaque schema (an MCP tool's z.unknown()) accepts any field", () => {
    const tool = buildTool({
      name: "Opaque",
      description: "d",
      inputSchema: z.unknown(),
      execute: exec,
      operativeArgs: [{ field: "anything.at.all", kind: "text" }],
    });
    expect(tool.operativeArgs).toHaveLength(1);
  });
});

describe("buildTool — the documented defaults (security-7#11)", () => {
  test("an unannotated tool is neither read-only nor destructive, which auto mode allows", () => {
    // The docstring says so; this pins the facts it describes.
    const tool = buildTool(echoDef);
    expect({
      readOnly: tool.readOnly,
      destructive: tool.destructive,
      requiresSandbox: tool.requiresSandbox,
      requireJustification: tool.requireJustification,
      scope: tool.scope,
      classifyOutput: tool.classifyOutput,
    }).toEqual({
      readOnly: false,
      destructive: false,
      requiresSandbox: false,
      requireJustification: false,
      scope: "internal",
      classifyOutput: true,
    });
  });
});
