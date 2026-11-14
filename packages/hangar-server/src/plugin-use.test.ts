/**
 * Using a granted plugin in one harness (#522): `PUT /api/h/:id/builders/plugins/:name`
 * is dry-run-first and typed-confirm, writes the `{name, tools}` form only, refuses a
 * tool the live grant does not serve, writes only on a harness the grant covers, and
 * answers a stale revision with the spec write's own 412.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFixtureHarness } from "./fixture";
import { SERVED_NOTHING, grantPlugin } from "./plugin-grants";
import { withPluginEntry } from "./plugin-use";
import { type PluginRow, readPluginInventory } from "./plugins";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-11-14T00:00:00.000Z");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const done of cleanups.splice(0)) await done();
});

async function setUp(
  opts: { grant?: boolean; target?: string; spec?: string; grantOn?: "first" | "all" } = {},
) {
  const scratch = mkdtempSync(join(tmpdir(), "plugin-use-"));
  const pluginsDir = join(scratch, "plugins");
  mkdirSync(join(pluginsDir, "notes-pane"), { recursive: true });
  writeFileSync(
    join(pluginsDir, "notes-pane", "plugin.json"),
    JSON.stringify({
      name: "notes-pane",
      version: "1.0.0",
      permissions: { tools: ["Read", "Bash"] },
      integration: {},
    }),
  );
  const t: TestServer = bootTestServer({ now: () => NOW, pluginsDir });
  cleanups.push(async () => {
    await t.stop();
    rmSync(scratch, { recursive: true, force: true });
  });
  const dir = join(t.harnessesRoot, "user");
  makeFixtureHarness(dir, {
    specName: "user",
    ...(opts.target !== undefined ? { target: opts.target } : {}),
    ...(opts.spec !== undefined ? { specExtra: opts.spec } : {}),
  });
  const added = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
  const id = (added.body["entry"] as { id: string }).id;
  const otherDir = join(t.harnessesRoot, "other");
  makeFixtureHarness(otherDir, { specName: "other" });
  const addedOther = await t.api("/api/harnesses", {
    method: "POST",
    body: JSON.stringify({ dir: otherDir }),
  });
  const otherId = (addedOther.body["entry"] as { id: string }).id;
  if (opts.grant !== false) {
    const row = readPluginInventory(pluginsDir).plugins[0] as PluginRow;
    const done = await grantPlugin(t.hangarRoot, {
      row,
      grant: {
        ...SERVED_NOTHING,
        harnesses: opts.grantOn === "all" ? "all" : [id],
        tools: ["Read"],
      },
      by: "local:test",
      cmd: "cmd_test",
    });
    if (!done.ok) throw new Error("no grant");
  }
  const spec = () => readFileSync(join(dir, "crewhaus.yaml"), "utf8");
  const otherSpec = () => readFileSync(join(otherDir, "crewhaus.yaml"), "utf8");
  const putOn = (harness: string, body: Record<string, unknown>) =>
    t.api(`/api/h/${harness}/builders/plugins/notes-pane`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  const put = (body: Record<string, unknown>) => putOn(id, body);
  const putOther = (body: Record<string, unknown>) => putOn(otherId, body);
  return { t, id, otherId, dir, spec, otherSpec, put, putOther };
}

describe("using a granted plugin in a harness", () => {
  test("a dry run answers the diff, the name to type and the revision, and writes nothing", async () => {
    const { spec, put } = await setUp();
    const before = spec();
    const dry = await put({ tools: ["Read"] });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ ok: true, dryRun: true, confirmName: "user" });
    expect(String(dry.body["diff"])).toContain("notes-pane");
    expect(typeof dry.body["rev"]).toBe("string");
    expect(spec()).toBe(before);
  }, 20_000);

  test("a wrong typed name writes nothing", async () => {
    const { spec, put } = await setUp();
    const before = spec();
    const dry = await put({ tools: ["Read"] });
    const wrong = await put({
      tools: ["Read"],
      dryRun: false,
      confirmName: "someone-else",
      expectedRev: dry.body["rev"],
    });
    expect(wrong.status).toBe(409);
    expect(spec()).toBe(before);
  }, 20_000);

  test("a tool the grant does not serve is refused by name", async () => {
    const { spec, put } = await setUp();
    const before = spec();
    const res = await put({ tools: ["Bash"] });
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain('host tool "Bash"');
    expect(spec()).toBe(before);
  }, 20_000);

  test("the commit writes the object form, and tools: [] when none is chosen", async () => {
    const { spec, put } = await setUp();
    const dry = await put({});
    const wrote = await put({ dryRun: false, confirmName: "user", expectedRev: dry.body["rev"] });
    expect(wrote.status).toBe(200);
    const text = spec();
    expect(text).toContain("name: notes-pane");
    expect(text).toContain("tools: []");
  }, 20_000);

  test("a stale revision answers the spec write's 412 and writes nothing", async () => {
    const { spec, put, dir } = await setUp();
    const dry = await put({ tools: ["Read"] });
    writeFileSync(join(dir, "crewhaus.yaml"), `${spec()}# edited elsewhere\n`);
    const before = spec();
    const stale = await put({
      tools: ["Read"],
      dryRun: false,
      confirmName: "user",
      expectedRev: dry.body["rev"],
    });
    expect(stale.status).toBe(412);
    expect(stale.body["current"]).toBeDefined();
    expect(spec()).toBe(before);
  }, 20_000);

  test("no live grant, and a shape that loads no plugins, are refused with why", async () => {
    const ungranted = await setUp({ grant: false });
    const res = await ungranted.put({ tools: [] });
    expect(res.status).toBe(409);
    expect(String(res.body["error"])).toBe(
      `"notes-pane" is not allowed on this harness: allow it in Settings › Plugins first (crewhaus plugins grant notes-pane --harness ${ungranted.id})`,
    );
    const workflow = await setUp({ target: "workflow" });
    const shaped = await workflow.put({ tools: [] });
    expect(shaped.status).toBe(409);
    expect(String(shaped.body["error"])).toContain("only cli and channel");
  }, 40_000);
});

describe("the grant decides which harnesses a plugin may be used in", () => {
  test("a grant on one harness refuses another, on the dry run and the write", async () => {
    const { otherId, otherSpec, putOther } = await setUp({ grantOn: "first" });
    const before = otherSpec();
    const message = `"notes-pane" is not allowed on this harness: allow it in Settings › Plugins first (crewhaus plugins grant notes-pane --harness ${otherId})`;
    const dry = await putOther({ tools: ["Read"] });
    expect(dry.status).toBe(409);
    expect(String(dry.body["error"])).toBe(message);
    expect(dry.body["diff"]).toBeUndefined();
    const wrote = await putOther({
      tools: ["Read"],
      dryRun: false,
      confirmName: "other",
      expectedRev: "any",
    });
    expect(wrote.status).toBe(409);
    expect(String(wrote.body["error"])).toBe(message);
    expect(otherSpec()).toBe(before);
  }, 20_000);

  test("the same grant answers the diff on the harness it names", async () => {
    const { put } = await setUp({ grantOn: "first" });
    const dry = await put({ tools: ["Read"] });
    expect(dry.status).toBe(200);
    expect(String(dry.body["diff"])).toContain("notes-pane");
  }, 20_000);

  test("a grant on every harness allows any of them", async () => {
    const { otherSpec, putOther } = await setUp({ grantOn: "all" });
    const dry = await putOther({ tools: ["Read"] });
    expect(dry.status).toBe(200);
    expect(String(dry.body["diff"])).toContain("notes-pane");
    const wrote = await putOther({
      tools: ["Read"],
      dryRun: false,
      confirmName: "other",
      expectedRev: dry.body["rev"],
    });
    expect(wrote.status).toBe(200);
    expect(otherSpec()).toContain("name: notes-pane");
  }, 20_000);
});

describe("withPluginEntry", () => {
  test("replaces every entry for the plugin at the first one's place, or appends", () => {
    const entry = { name: "p", tools: ["Read"] };
    expect(withPluginEntry(["a", "p", "b", { name: "p", tools: [] }], entry)).toEqual([
      "a",
      entry,
      "b",
    ]);
    expect(withPluginEntry(["a"], entry)).toEqual(["a", entry]);
  });
});
