/**
 * `crewhaus plugins grants|grant|revoke` (#522) against a temp Hangar root: each write
 * is one workspace receipt and one grant row; a comma list grants every item; a refusal
 * (an origin the plugin does not ask for, a stale `--expect`, a revoke with no grant)
 * writes neither; and the placeholder and path param a plugin name fills accept exactly
 * the manifest name grammar.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATH_PARAMS, PLUGIN_NAME_RE, TWIN_PLACEHOLDERS } from "@crewhaus/control-contract";
import { foldStates } from "@crewhaus/control-records";
import { workspaceCommandsLedger } from "@crewhaus/control-service";
import { pluginGrantsLedger, readPluginGrants } from "@crewhaus/hangar-server";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import { PLUGIN_NAME_PATTERN } from "@crewhaus/plugin-sdk";
import { parseListFlag, runPluginGrants } from "./plugins-grant-cmd";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setUp() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plugins-grant-cmd-")));
  roots.push(root);
  const registryRoot = join(root, "registry");
  const hangarRoot = join(root, "hangar");
  const pluginsDir = join(root, "plugins");
  const harness = join(root, "harness");
  mkdirSync(harness, { recursive: true });
  const row = openHangarRegistry({ root: registryRoot, env: {} }).upsert({
    dir: harness,
    specName: "concierge",
    target: "cli",
  });
  mkdirSync(join(pluginsDir, "notes-pane"), { recursive: true });
  writeFileSync(
    join(pluginsDir, "notes-pane", "plugin.json"),
    JSON.stringify({
      name: "notes-pane",
      version: "1.0.0",
      panes: [
        { id: "board", title: "Board", file: "board.html" },
        { id: "graph", title: "Graph", file: "graph.html" },
      ],
      permissions: { net: ["fetch:https://api.notes.test/**"], tools: ["Read"] },
      integration: { events: ["run", "decision"] },
    }),
  );
  const opts = { env: { CREWHAUS_REGISTRY_ROOT: registryRoot, CREWHAUS_HANGAR_ROOT: hangarRoot } };
  const run = (
    action: "grants" | "grant" | "revoke",
    positional: string[],
    flags: Record<string, string | boolean> = {},
  ) => runPluginGrants(action, { positional, flags }, pluginsDir, opts);
  const receipts = (kind: string) => {
    const fold = foldStates(workspaceCommandsLedger(hangarRoot));
    return fold.ok ? [...fold.objects.values()].filter((o) => o.record["kind"] === kind).length : 0;
  };
  const rows = () => {
    const fold = foldStates(pluginGrantsLedger(hangarRoot));
    return fold.ok ? fold.records : 0;
  };
  return { hangarRoot, harness, id: row.id, run, receipts, rows };
}

describe("crewhaus plugins grant", () => {
  test("one receipt and one row; a comma list grants every item; harness by id or by dir", async () => {
    const { hangarRoot, harness, id, run, receipts, rows } = setUp();
    const done = await run("grant", ["notes-pane"], {
      harness: harness,
      panes: "board,graph",
      events: "run,decision",
    });
    expect(done.exitCode).toBe(0);
    expect(done.lines[0]).toBe("granted notes-pane (generation 1)");
    expect(receipts("plugins.grant")).toBe(1);
    expect(rows()).toBe(1);
    const read = readPluginGrants(hangarRoot);
    const row = read.ok ? read.grants.get("notes-pane")?.row : undefined;
    expect(row?.harnesses).toEqual([id]);
    expect(row?.panes).toEqual(["board", "graph"]);
    expect(row?.events).toEqual(["run", "decision"]);
    expect(row?.by).toMatch(/^local:/);
  });

  test("an origin the plugin does not ask for is refused: no receipt, no row", async () => {
    const { id, run, receipts, rows } = setUp();
    const done = await run("grant", ["notes-pane"], { harness: id, net: "https://evil.test" });
    expect(done.exitCode).toBe(1);
    expect(done.lines[0]).toContain('does not ask for the origin "https://evil.test"');
    expect(receipts("plugins.grant")).toBe(0);
    expect(rows()).toBe(0);
  });

  test("a stale --expect names the current generation and appends no row", async () => {
    const { id, run, rows } = setUp();
    expect((await run("grant", ["notes-pane"], { harness: id })).exitCode).toBe(0);
    const again = await run("grant", ["notes-pane"], { harness: id, panes: "board" });
    expect(again.exitCode).toBe(1);
    expect(again.lines[0]).toContain("--expect 1");
    const wrong = await run("grant", ["notes-pane"], { harness: id, expect: "4" });
    expect(wrong.exitCode).toBe(1);
    expect(rows()).toBe(1);
    const right = await run("grant", ["notes-pane"], { harness: id, panes: "board", expect: "1" });
    expect(right.lines[0]).toBe("granted notes-pane (generation 2)");
  });

  test("an empty item, an unknown harness and an unknown event family are refused by name", async () => {
    const { id, run, rows } = setUp();
    expect((await run("grant", ["notes-pane"], { panes: "board,,graph" })).lines[0]).toContain(
      "has an empty item",
    );
    expect((await run("grant", ["notes-pane"], { harness: "/no/such/dir" })).lines[0]).toContain(
      '"/no/such/dir"',
    );
    expect(
      (await run("grant", ["notes-pane"], { harness: id, events: "runs" })).lines[0],
    ).toContain('"runs" is not one of');
    expect(rows()).toBe(0);
  });

  test("grants shows the state word, asks and served; revoke serves nothing; a second revoke is refused", async () => {
    const { id, run, receipts, rows } = setUp();
    const waiting = run("grants", []);
    expect((await waiting).lines[0]).toBe("notes-pane 1.0.0  Waiting for your OK");
    await run("grant", ["notes-pane"], { harness: id, panes: "board" });
    const allowed = (await run("grants", ["notes-pane"])).lines;
    expect(allowed[0]).toBe("notes-pane 1.0.0  Allowed (generation 1)");
    expect(allowed[2]).toContain(`served: harnesses ${id}; panes board;`);
    const revoked = await run("revoke", ["notes-pane"]);
    expect(revoked.exitCode).toBe(0);
    expect(receipts("plugins.revoke")).toBe(1);
    expect((await run("grants", ["notes-pane"])).lines[2]).toContain(
      "served: harnesses none; panes none;",
    );
    const before = rows();
    const again = await run("revoke", ["notes-pane"]);
    expect(again.exitCode).toBe(1);
    expect(again.lines[0]).toBe("notes-pane has no live grant to remove");
    expect(receipts("plugins.revoke")).toBe(1);
    expect(rows()).toBe(before);
  });

  test("a plugin that is not installed names the install verb", async () => {
    const { run } = setUp();
    expect((await run("revoke", ["nothing-here"])).lines[0]).toContain(
      "crewhaus plugins install nothing-here",
    );
  });
});

describe("parseListFlag", () => {
  test("absent is none; items are trimmed and de-duplicated; an empty item is refused", () => {
    expect(parseListFlag("panes", undefined)).toEqual({ ok: true, items: [] });
    expect(parseListFlag("panes", "a, b,a")).toEqual({ ok: true, items: ["a", "b"] });
    expect(parseListFlag("panes", "a,")).toMatchObject({ ok: false });
    expect(parseListFlag("panes", true)).toMatchObject({ ok: false });
  });
});

describe("the plugin name grammar is one grammar", () => {
  const SAMPLES = [
    "abc",
    "notes-pane",
    `a${"b".repeat(62)}c`,
    "ab",
    "Notes",
    "notes-",
    "1ab",
    "a_b",
    "a/b",
  ];

  test("{plugin}, PATH_PARAMS.plugin and the contract's copy accept exactly what plugin-sdk does", () => {
    expect(PLUGIN_NAME_RE.source).toBe(PLUGIN_NAME_PATTERN.source);
    for (const name of SAMPLES) {
      const want = PLUGIN_NAME_PATTERN.test(name);
      expect(`${name}: ${TWIN_PLACEHOLDERS["{plugin}"].test(name)}`).toBe(`${name}: ${want}`);
      expect(`${name}: ${PATH_PARAMS.plugin([name])}`).toBe(`${name}: ${want}`);
    }
  });
});
