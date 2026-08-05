/**
 * 0.5.0 — Thredz emit-wired on the crew shape, with the per-role fan-out.
 *
 * The rule that drives the whole design: ONE Thredz API key owns at most one
 * `individual` (private) wiki space, and `thredz-mcp` reads exactly one key per
 * process. So per-role private memory is per-role keys is per-role SERVER
 * PROCESSES. These tests pin that chain end to end.
 */
import { describe, expect, test } from "bun:test";
import type { IrCrewV0, IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import { compile, lower } from "./index";

const crewSpec = (
  thredz: string,
  roles = "  researcher: { instructions: gather }\n  editor: { instructions: write }",
) => `
name: rd
target: crew
model: claude-sonnet-4-6
entry: researcher
roles:
${roles}
memory: { enabled: true }
${thredz}
`;

function lowerCrew(yaml: string): IrCrewV0 {
  const ir: IrV0 = lower(parseSpec(yaml));
  if (ir.target !== "crew") throw new Error("expected a crew IR");
  return ir;
}

const FANOUT = `thredz:
  api_key: $THREDZ_SHARED
  visibility: private
  roles:
    researcher: { api_key: $K_RESEARCHER, space: researcher-notes }
    editor: { api_key: $K_EDITOR, space: editor-notes }`;

describe("crew thredz fan-out — lowering", () => {
  test("each role gets its OWN server, key and space", () => {
    const ir = lowerCrew(crewSpec(FANOUT));
    const byName = Object.fromEntries(ir.roles.map((r) => [r.name, r]));

    expect(byName.researcher?.thredzServer).toBe("thredz-researcher");
    expect(byName.researcher?.thredz?.space).toBe("researcher-notes");
    expect(byName.researcher?.thredz?.apiKey).toEqual({ kind: "env", name: "K_RESEARCHER" });

    expect(byName.editor?.thredzServer).toBe("thredz-editor");
    expect(byName.editor?.thredz?.space).toBe("editor-notes");
    expect(byName.editor?.thredz?.apiKey).toEqual({ kind: "env", name: "K_EDITOR" });
  });

  test("a role with NO override rides the crew-wide server — one brain, one process", () => {
    const ir = lowerCrew(
      crewSpec(
        FANOUT,
        "  researcher: { instructions: gather }\n  editor: { instructions: write }\n  archivist: { instructions: file }",
      ),
    );
    const archivist = ir.roles.find((r) => r.name === "archivist");
    expect(archivist?.thredzServer).toBe("thredz");
    expect(archivist?.thredz?.apiKey).toEqual({ kind: "env", name: "THREDZ_SHARED" });
    // …and it shares that one server with nobody else here, but crucially the
    // crew-wide entry exists exactly once regardless of how many inherit it.
    expect(Object.keys(ir.mcp_servers).filter((n) => n === "thredz")).toHaveLength(1);
  });

  test("one synthesized mcp_servers entry per DISTINCT server, and none for a server nobody rides", () => {
    // Both roles override here, so NOTHING inherits the crew-wide config —
    // and the bare "thredz" server is therefore not synthesized at all, even
    // though `thredz.api_key` is set. Spawning an npx child no role talks to
    // would be a pure waste of a process.
    const ir = lowerCrew(crewSpec(FANOUT));
    expect(Object.keys(ir.mcp_servers).sort()).toEqual(["thredz-editor", "thredz-researcher"]);
    const researcher = ir.mcp_servers["thredz-researcher"];
    if (researcher?.transport !== "stdio") throw new Error("expected stdio");
    expect(researcher.env.THREDZ_DEFAULT_SPACE).toEqual({
      kind: "literal",
      value: "researcher-notes",
    });
  });

  test("an override INHERITS crew-wide fields it does not restate", () => {
    const ir = lowerCrew(`
name: rd
target: crew
model: claude-sonnet-4-6
entry: researcher
roles:
  researcher: { instructions: gather }
memory: { enabled: true }
thredz:
  api_key: $SHARED
  visibility: shared
  roles:
    researcher: { space: notes }
`);
    const role = ir.roles[0];
    // visibility inherited; api_key inherited; space is the role's own.
    expect(role?.thredz?.visibility).toBe("shared");
    expect(role?.thredz?.apiKey).toEqual({ kind: "env", name: "SHARED" });
    expect(role?.thredz?.space).toBe("notes");
  });

  test("memory.backend flips to thredz on the crew", () => {
    expect(lowerCrew(crewSpec(FANOUT)).memory?.backend).toBe("thredz");
  });

  test("the goal mirror is forced OFF when there is no crew-wide connection", () => {
    // The continuity store is spec-scoped and SHARED. Mirroring one crew plan
    // into N private spaces has no correct semantics, so a pure fan-out crew
    // loses the mirror rather than failing to compile.
    const ir = lowerCrew(
      crewSpec(`thredz:
  roles:
    researcher: { api_key: $A, space: a }
    editor: { api_key: $B, space: b }`),
    );
    for (const role of ir.roles) expect(role.thredz?.goals).toBe(false);
    expect(ir.thredz).toBeUndefined();
  });

  test("the legacy single block still lowers unchanged — every role shares it", () => {
    const ir = lowerCrew(crewSpec("thredz:\n  api_key: $THREDZ_API_KEY\n  space: company"));
    expect(Object.keys(ir.mcp_servers)).toEqual(["thredz"]);
    for (const role of ir.roles) {
      expect(role.thredzServer).toBe("thredz");
      expect(role.thredz?.space).toBe("company");
    }
  });
});

describe("crew thredz fan-out — emitted bundle", () => {
  const daemon = (yaml: string): string =>
    compile(yaml).files.find((f) => f.path === "daemon.ts")?.content ?? "";

  test("spawns one server per distinct config and connects each by NAME", () => {
    const out = daemon(crewSpec(FANOUT));
    expect(out).toContain('mcpHost.addServer("thredz-researcher"');
    expect(out).toContain('mcpHost.addServer("thredz-editor"');
    expect(out).toContain('serverName: "thredz-researcher"');
    expect(out).toContain('serverName: "thredz-editor"');
  });

  test("each role gets its OWN ToolCatalog — the collision guard is per-catalog", () => {
    const out = daemon(crewSpec(FANOUT));
    expect(out).toContain("const __thredzCat_thredz_researcher = new ToolCatalog()");
    expect(out).toContain("const __thredzCat_thredz_editor = new ToolCatalog()");
    // …and each role's tools come from its own catalog.
    expect(out).toContain('"researcher": [...__thredzCat_thredz_researcher.list()');
    expect(out).toContain('"editor": [...__thredzCat_thredz_editor.list()');
  });

  test("thredz servers are EXCLUDED from the namespaced registerMcpServer pass", () => {
    // Namespacing them too would register the whole vocabulary a second time
    // as `thredz__wiki_write`, on top of the bare aliases.
    const out = daemon(crewSpec(FANOUT));
    expect(out).not.toContain('registerMcpServer(mcpHost, "thredz"');
    expect(out).not.toContain('registerMcpServer(mcpHost, "thredz-researcher"');
  });

  test("the stale 'ignored on crew' note is gone", () => {
    expect(daemon(crewSpec(FANOUT))).not.toContain("ignored on crew");
  });

  test("the crew-wide fabric drops the WIKI when roles carry their own", () => {
    // Otherwise a role's tool array carries the ten LOCAL wiki twins beside the
    // ten aliased ones, and duplicate names in the advertised array are a 400.
    const out = daemon(crewSpec(FANOUT));
    const wireMemoryCall = out.slice(out.indexOf("await wireMemory("));
    const fragment = wireMemoryCall.slice(0, wireMemoryCall.indexOf("}, {"));
    expect(fragment).not.toContain('"wiki"');
  });

  test("the shared host is disconnected even with no user MCP servers", () => {
    const out = daemon(crewSpec(FANOUT));
    expect(out).toContain("const mcpHost = new McpHost()");
    expect(out).toContain("await mcpHost.disconnectAll()");
  });

  test("a crew with no thredz at all emits no thredz machinery", () => {
    const out = daemon(crewSpec(""));
    expect(out).not.toContain("connectThredz");
    expect(out).not.toContain("thredz-mcp@");
  });
});
