/**
 * Plugin grants (#522): the ledger, the standing a review computes from it, and what
 * Home serves. Every test writes manifests into a temp plugins directory and grants
 * into a temp Hangar root, and reads both back as Home does.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENT_TAXONOMY, isId } from "@crewhaus/control-contract";
import type { PluginGrantSet } from "@crewhaus/control-contract";
import { foldStates } from "@crewhaus/control-records";
import { findSpecPath } from "@crewhaus/harness-supervisor";
import { PLUGIN_INTEGRATION_EVENT_FAMILIES } from "@crewhaus/plugin-sdk";
import { MAX_TEXT_BYTES } from "./constants";
import {
  type GrantableHarness,
  SERVED_NOTHING,
  asksOf,
  grantPlugin,
  grantProblem,
  liveGrantOf,
  pluginGrantsLedger,
  pluginReviewOf,
  readPluginGrants,
  revokePlugin,
  servedOf,
  servedPlugins,
  standingFrom,
  stillLoadedBy,
  waitingOn,
} from "./plugin-grants";
import { type PluginRow, readPluginInventory } from "./plugins";

let root: string;
let pluginsDir: string;
let hangarRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plugin-grants-"));
  pluginsDir = join(root, "plugins");
  hangarRoot = join(root, "hangar");
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(hangarRoot, { recursive: true });
});
const locked: string[] = [];
afterEach(() => {
  // A test may leave a file or directory with no permissions; give them back before removing.
  for (const left of locked.splice(0)) chmodSync(left, 0o755);
  rmSync(root, { recursive: true, force: true });
});

const HRN_A = "hrn_00000000000000a1";
const HRN_B = "hrn_00000000000000b2";

/** Version 1 of `notes-pane`: one pane, one origin, two host tools, an integration section. */
const V1 = {
  name: "notes-pane",
  version: "1.0.0",
  entrypointDigest: "a".repeat(64),
  onTraceEvent: true,
  panes: [{ id: "board", title: "Board", file: "board.html" }],
  permissions: {
    fs: ["read:/h/**"],
    net: ["fetch:https://api.notes.test/**"],
    tools: ["Read", "Bash"],
    secrets: ["NOTES_API_KEY"],
  },
  integration: { protocol: "crewhaus.hangar.v1", events: ["run"], data: { reads: ["costs"] } },
};

function install(manifest: Record<string, unknown>): PluginRow {
  const dir = join(pluginsDir, String(manifest["name"]));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
  return row(String(manifest["name"]));
}

function row(name: string): PluginRow {
  const grants = readPluginGrants(hangarRoot);
  if (!grants.ok) throw new Error(grants.reason);
  const found = readPluginInventory(pluginsDir, standingFrom(grants.grants)).plugins.find(
    (p) => p.name === name,
  );
  if (found === undefined) throw new Error(`no plugin ${name}`);
  return found;
}

function grants() {
  const read = readPluginGrants(hangarRoot);
  if (!read.ok) throw new Error(read.reason);
  return read.grants;
}

const FULL = {
  harnesses: [HRN_A],
  panes: ["board"],
  events: ["run"],
  reads: ["costs", "run.trace"],
  net: ["https://api.notes.test"],
  tools: ["Read"],
};

const grant = (r: PluginRow, g: Partial<typeof FULL> & { expect?: number } = {}) =>
  grantPlugin(hangarRoot, {
    row: r,
    grant: { ...FULL, ...g },
    by: "prn_00000000000000000000000001",
    cmd: "cmd_00000000000000000000000001",
  });

function ledgerRows(): Record<string, unknown>[] {
  if (!foldStates(pluginGrantsLedger(hangarRoot)).ok) return [];
  const rows: Record<string, unknown>[] = [];
  const dir = join(hangarRoot, "plugins", "grants");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    const text = readFileSync(join(dir, file), "utf8");
    for (const line of text.split("\n").filter((l) => l !== "")) rows.push(JSON.parse(line));
  }
  return rows;
}

describe("what a manifest asks for", () => {
  test("panes, events, reads (with run.trace for an observer), origins, tools and harnesses", () => {
    const r = install(V1);
    expect(
      asksOf(r, [
        { id: HRN_A, dir: "/h/one" },
        { id: HRN_B, dir: "/elsewhere" },
      ]),
    ).toEqual({
      harnesses: [HRN_A],
      panes: ["board"],
      events: ["run"],
      reads: ["costs", "run.trace"],
      net: ["https://api.notes.test"],
      tools: ["Read", "Bash"],
    });
  });

  test("the inventory row carries tools, env names, integration, digest and signature", () => {
    const r = install({
      ...V1,
      signature: { algorithm: "ed25519", publicKeyB64: "x", sigB64: "y" },
    });
    expect(r.permissions.tools).toEqual(["Read", "Bash"]);
    expect(r.envNames).toEqual(["NOTES_API_KEY"]);
    expect(r.integration).toEqual({ events: ["run"], reads: ["costs"] });
    expect(r.entrypointDigest).toBe("a".repeat(64));
    expect(r.signed).toBe(true);
    expect(r.grant).toEqual({ state: "waiting", legacy: false });
  });

  test("a malformed integration section is a problem on the row, not a crash, and is never granted", () => {
    const r = install({ ...V1, integration: { events: ["nope"] } });
    expect(r.integration).toBeNull();
    expect(r.problems.join(" ")).toContain('`integration.events` entry "nope"');
    expect(grantProblem(r, { ...FULL }, new Set([HRN_A]))).toContain("cannot be granted");
  });
});

describe("the ledger", () => {
  test("no ledger reads as no grants, and the read creates nothing", () => {
    expect(readPluginGrants(hangarRoot)).toEqual({ ok: true, grants: new Map() });
    expect(readdirSync(hangarRoot)).toEqual([]);
  });

  test("a grant writes one content-free row under plugins/grants, with its own lock and claims", async () => {
    const r = install(V1);
    const done = await grant(r);
    expect(done.ok).toBe(true);
    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    const first = rows[0] as Record<string, unknown>;
    expect(isId("pgt", first["id"] as string)).toBe(true);
    expect(first).toMatchObject({
      v: 1,
      state: "granted",
      plugin: "notes-pane",
      version: "1.0.0",
      entrypointDigest: "a".repeat(64),
      harnesses: [HRN_A],
      panes: ["board"],
      asked: {
        panes: ["board"],
        events: ["run"],
        reads: ["costs", "run.trace"],
        net: ["https://api.notes.test"],
        tools: ["Read", "Bash"],
      },
      by: "prn_00000000000000000000000001",
      cmd: "cmd_00000000000000000000000001",
      gen: 1,
    });
    // Content-free: no path and no manifest text.
    expect(JSON.stringify(first)).not.toContain(pluginsDir);
    expect(JSON.stringify(first)).not.toContain("Board");
    // Its own claims beside its records (the lock file is gone once the write ends).
    expect(readdirSync(join(hangarRoot, "plugins")).sort()).toEqual(["claims", "grants"]);
    expect(readdirSync(join(hangarRoot, "plugins", "claims"))).toEqual(["gen"]);
  });

  test("a re-grant keeps the object and moves its generation; a stale expect appends nothing", async () => {
    const r = install(V1);
    const first = await grant(r);
    if (!first.ok) throw new Error("no grant");
    expect(liveGrantOf(grants(), "notes-pane")?.gen).toBe(1);
    // Without expect there must be no live grant.
    expect(await grant(r, { panes: [] })).toMatchObject({ ok: false, code: "stale", gen: 1 });
    expect(await grant(r, { panes: [], expect: 7 })).toMatchObject({ ok: false, code: "stale" });
    expect(ledgerRows()).toHaveLength(1);
    const second = await grant(r, { panes: [], expect: 1 });
    expect(second).toMatchObject({ ok: true, id: first.id, gen: 2 });
    expect(ledgerRows()).toHaveLength(2);
  });

  test("a revoke ends the object; the next grant mints a new pgt_, and the old one stays", async () => {
    const r = install(V1);
    const first = await grant(r);
    if (!first.ok) throw new Error("no grant");
    expect(
      await revokePlugin(hangarRoot, { plugin: "notes-pane", by: "x", cmd: "y" }),
    ).toMatchObject({ ok: true, id: first.id });
    expect(grants().get("notes-pane")?.state).toBe("revoked");
    expect(liveGrantOf(grants(), "notes-pane")).toBeUndefined();
    expect(row("notes-pane").grant.state).toBe("revoked");
    // Nothing to revoke now: a refusal, never a row.
    const rows = ledgerRows().length;
    expect(await revokePlugin(hangarRoot, { plugin: "notes-pane", by: "x", cmd: "y" })).toEqual({
      ok: false,
      code: "no-live-grant",
    });
    expect(ledgerRows()).toHaveLength(rows);
    const again = await grant(r);
    if (!again.ok) throw new Error("no grant");
    expect(again.id).not.toBe(first.id);
    expect(isId("pgt", again.id)).toBe(true);
    expect(liveGrantOf(grants(), "notes-pane")?.id).toBe(again.id);
  });
});

describe("what is served", () => {
  test("nothing without a grant, nothing after a revoke", async () => {
    const r = install(V1);
    expect(servedOf(undefined, asksOf(r))).toEqual(SERVED_NOTHING);
    await grant(r);
    await revokePlugin(hangarRoot, { plugin: "notes-pane", by: "x", cmd: "y" });
    expect(servedPlugins(readPluginInventory(pluginsDir), grants())[0]?.served).toEqual(
      SERVED_NOTHING,
    );
  });

  test("a version that asks for more is told apart, and keeps only the old grant's intersection", async () => {
    await grant(install(V1));
    const v2 = install({
      ...V1,
      version: "2.0.0",
      entrypointDigest: "b".repeat(64),
      panes: [...V1.panes, { id: "graph", title: "Graph", file: "graph.html" }],
      permissions: { ...V1.permissions, net: [...V1.permissions.net, "fetch:https://cdn.test/**"] },
    });
    expect(v2.grant.state).toBe("asks-for-more");
    const served = servedOf(liveGrantOf(grants(), "notes-pane"), asksOf(v2));
    expect(served.panes).toEqual(["board"]);
    expect(served.net).toEqual(["https://api.notes.test"]);
  });

  test("a version that asks for less narrows at once, and stays allowed", async () => {
    await grant(install(V1));
    const v2 = install({
      ...V1,
      version: "2.0.0",
      permissions: { ...V1.permissions, net: [], tools: ["Bash"] },
    });
    expect(v2.grant.state).toBe("allowed");
    const served = servedOf(liveGrantOf(grants(), "notes-pane"), asksOf(v2));
    expect(served.net).toEqual([]);
    expect(served.tools).toEqual([]);
    expect(served.panes).toEqual(["board"]);
  });

  test("a choice the owner declined is not 'asks for more' while the version stands", async () => {
    await grant(install(V1), { panes: [], net: [] });
    expect(row("notes-pane").grant.state).toBe("allowed");
  });
});

describe("the owner's review", () => {
  test("a legacy manifest waits, prefilled with what it could see, serving nothing", () => {
    const { integration: _i, ...legacy } = V1;
    const r = install(legacy);
    const review = pluginReviewOf(r, undefined, [{ id: HRN_A, dir: "/h/one" }], () => true);
    expect(review).toMatchObject({
      state: "waiting",
      legacy: true,
      granted: null,
      gen: null,
      served: SERVED_NOTHING,
      envNames: ["NOTES_API_KEY"],
      verb: "crewhaus plugins grants notes-pane",
    });
    expect(review.asks.harnesses).toEqual([HRN_A]);
    expect(review.asks.reads).toEqual(["run.trace"]);
  });

  test("harness ids fold to those the caller can see; all stays all", async () => {
    const r = install(V1);
    await grant(r, { harnesses: [HRN_A, HRN_B] });
    const review = pluginReviewOf(
      row("notes-pane"),
      grants().get("notes-pane"),
      [],
      (id) => id === HRN_B,
    );
    expect(review.granted?.harnesses).toEqual([HRN_B]);
    expect(review.served.harnesses).toEqual([HRN_B]);
    expect(review.gen).toBe(1);
    await grant(r, { harnesses: "all" as never, expect: 1 });
    const all = pluginReviewOf(row("notes-pane"), grants().get("notes-pane"), [], () => false);
    expect(all.granted?.harnesses).toBe("all");
  });
});

describe("a grant names only what the plugin asks for", () => {
  test("each kind of value it does not ask for is refused by name; an unknown harness too", () => {
    const r = install(V1);
    const known = new Set([HRN_A]);
    expect(grantProblem(r, FULL, known)).toBeUndefined();
    const cases: Array<[Partial<typeof FULL>, string]> = [
      [{ panes: ["graph"] }, 'the pane "graph"'],
      [{ events: ["deployment"] }, 'the event family "deployment"'],
      [{ reads: ["decisions"] }, 'the read "decisions"'],
      [{ net: ["https://evil.test"] }, 'the origin "https://evil.test"'],
      [{ tools: ["Write"] }, 'the host tool "Write"'],
      [{ harnesses: [HRN_B] }, `no harness "${HRN_B}" is registered`],
    ];
    for (const [over, why] of cases) {
      expect(grantProblem(r, { ...FULL, ...over }, known)).toContain(why);
    }
  });
});

test("every event family a plugin may ask for is a family in the contract", () => {
  const families = new Set(Object.values(EVENT_TAXONOMY).map((entry) => entry.family));
  for (const family of PLUGIN_INTEGRATION_EVENT_FAMILIES) expect(families.has(family)).toBe(true);
});

/** A harness directory under the temp root, with a crewhaus.yaml when `spec` is given. */
function harnessDir(id: string, spec?: string): GrantableHarness {
  const dir = join(root, "harnesses", id);
  mkdirSync(dir, { recursive: true });
  if (spec !== undefined) writeFileSync(join(dir, "crewhaus.yaml"), spec);
  return { id, dir };
}

/** A spec of one shape whose `plugins:` list is the YAML given. */
const specWith = (plugins: string, target = "cli") =>
  `name: probe\ntarget: ${target}\nagent:\n  model: x\nplugins: ${plugins}\n`;

/** What Home serves: harnesses and host tools, nothing else. */
const servedSet = (
  harnesses: readonly string[] | "all",
  tools: readonly string[],
): PluginGrantSet => ({ ...SERVED_NOTHING, harnesses, tools }) as PluginGrantSet;

/** A plugin that asks for the host tools given, and nothing else. */
const toolsPlugin = (tools: readonly string[]) =>
  install({ name: "probe-tools", version: "1.0.0", permissions: { tools } });

describe("the harnesses whose crewhaus.yaml still loads a plugin", () => {
  test("an entry outside what is served names its harness with every tool it hands", () => {
    const r = toolsPlugin(["Bash"]);
    const a = harnessDir(HRN_A, specWith('[{name: probe-tools, tools: ["Bash"]}]'));
    expect(stillLoadedBy(r, SERVED_NOTHING, [a], hangarRoot)).toEqual([
      { id: HRN_A, tools: ["Bash"] },
    ]);
    // The control case: served on A with Bash names nothing.
    expect(stillLoadedBy(r, servedSet([HRN_A], ["Bash"]), [a], hangarRoot)).toEqual([]);
    expect(stillLoadedBy(r, servedSet([HRN_B], ["Bash"]), [a], hangarRoot)).toEqual([
      { id: HRN_A, tools: ["Bash"] },
    ]);
    expect(stillLoadedBy(r, servedSet([HRN_A], []), [a], hangarRoot)).toEqual([
      { id: HRN_A, tools: ["Bash"] },
    ]);
    expect(stillLoadedBy(r, servedSet("all", ["Bash"]), [a], hangarRoot)).toEqual([]);
  });

  test("a bare name hands every host tool the manifest asks for", () => {
    const r = toolsPlugin(["Read", "Bash"]);
    const a = harnessDir(HRN_A, specWith("[probe-tools]"));
    expect(stillLoadedBy(r, servedSet([HRN_A], ["Read"]), [a], hangarRoot)).toEqual([
      { id: HRN_A, tools: ["Bash", "Read"] },
    ]);
  });

  test("a listed tool the manifest does not ask for is not counted, and the first entry decides", () => {
    const r = toolsPlugin(["Bash"]);
    const a = harnessDir(HRN_A, specWith('[{name: probe-tools, tools: ["Bash", "Nope"]}]'));
    expect(stillLoadedBy(r, servedSet([HRN_A], ["Bash"]), [a], hangarRoot)).toEqual([]);
    const b = harnessDir(HRN_B, specWith("[{name: probe-tools, tools: []}, probe-tools]"));
    expect(stillLoadedBy(r, servedSet([HRN_B], []), [b], hangarRoot)).toEqual([]);
  });

  test("only a cli or channel spec, among the harnesses given, is named", () => {
    const r = toolsPlugin(["Bash"]);
    const workflow = harnessDir("hrn_00000000000000c3", specWith("[probe-tools]", "workflow"));
    const none = harnessDir("hrn_00000000000000d4");
    const channel = harnessDir("hrn_00000000000000f6", specWith("[probe-tools]", "channel"));
    harnessDir(HRN_A, specWith("[probe-tools]"));
    expect(stillLoadedBy(r, SERVED_NOTHING, [workflow, none, channel], hangarRoot)).toEqual([
      { id: "hrn_00000000000000f6", tools: ["Bash"] },
    ]);
  });

  test("a spec file that resolves outside its harness is not read and names it with no tool list", () => {
    if (process.platform === "win32") return; // the fixture plants a POSIX link
    const r = toolsPlugin(["Bash"]);
    const outside = join(root, "outside.yaml");
    writeFileSync(outside, specWith("[probe-tools]", "workflow"));
    const linked = harnessDir("hrn_00000000000000e5");
    symlinkSync(outside, join(linked.dir, "crewhaus.yaml"));
    // Even a workflow target behind the link is not read: the harness cannot tell.
    expect(stillLoadedBy(r, servedSet("all", ["Bash"]), [linked], hangarRoot)).toEqual([
      { id: "hrn_00000000000000e5", tools: null },
    ]);
  });

  test("the shape and the entries come from the parsed spec, as the compiler reads them", () => {
    const r = toolsPlugin(["Bash"]);
    const entry = '[{name: probe-tools, tools: ["Bash"]}]';
    const specs: Record<string, string> = {
      quotedTargetKey: `name: probe\n"target": cli\nagent:\n  model: x\nplugins: ${entry}\n`,
      foldedTarget: `name: probe\ntarget: >-\n  cli\nagent:\n  model: x\nplugins: ${entry}\n`,
      taggedTarget: `name: probe\ntarget: !!str cli\nagent:\n  model: x\nplugins: ${entry}\n`,
      escapedName: specWith('[{name: "\\x70robe-tools", tools: ["Bash"]}]'),
    };
    const ids = Object.keys(specs).map((_, i) => `hrn_0000000000000${i}a${i}`);
    const given = Object.values(specs).map((spec, i) => harnessDir(ids[i] ?? "", spec));
    expect(stillLoadedBy(r, SERVED_NOTHING, given, hangarRoot)).toEqual(
      ids.map((id) => ({ id, tools: ["Bash"] })),
    );
  });

  test("a spec past the read cap cannot tell, wherever its entry sits", () => {
    const r = toolsPlugin(["Bash"]);
    const pad = `# ${"x".repeat(78)}\n`.repeat(Math.ceil(MAX_TEXT_BYTES / 80) + 1);
    const big = harnessDir(
      HRN_A,
      `name: probe\ntarget: cli\nagent:\n  model: x\n${pad}plugins: [{name: probe-tools, tools: ["Bash"]}]\n`,
    );
    const workflow = harnessDir(
      HRN_B,
      `name: probe\ntarget: workflow\n${pad}plugins: [probe-tools]\n`,
    );
    expect(stillLoadedBy(r, SERVED_NOTHING, [big, workflow], hangarRoot)).toEqual([
      { id: HRN_A, tools: null },
    ]);
  });

  test("a harness that builds from crewhaus.yml is read there", () => {
    const r = toolsPlugin(["Bash"]);
    const a = harnessDir(HRN_A);
    writeFileSync(join(a.dir, "crewhaus.yml"), specWith('[{name: probe-tools, tools: ["Bash"]}]'));
    expect(findSpecPath(a.dir)).toBe(join(a.dir, "crewhaus.yml"));
    expect(stillLoadedBy(r, SERVED_NOTHING, [a], hangarRoot)).toEqual([
      { id: HRN_A, tools: ["Bash"] },
    ]);
  });

  test("a spec file that is there but cannot be read names its harness with no tool list", () => {
    const r = toolsPlugin(["Bash"]);
    const dirSpec = harnessDir(HRN_B);
    mkdirSync(join(dirSpec.dir, "crewhaus.yaml"));
    const given = [dirSpec];
    const expected = [{ id: HRN_B, tools: null }];
    // chmod 000 does not stop a read on Windows or for root.
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const a = harnessDir(HRN_A, specWith('[{name: probe-tools, tools: ["Bash"]}]'));
      const spec = join(a.dir, "crewhaus.yaml");
      chmodSync(spec, 0o000);
      locked.push(spec);
      given.unshift(a);
      expected.unshift({ id: HRN_A, tools: null });
    }
    expect(stillLoadedBy(r, servedSet("all", ["Bash"]), given, hangarRoot)).toEqual(expected);
  });

  test("a spec that mentions the plugin but cannot be read whole names its harness with no tool list", () => {
    const r = toolsPlugin(["Bash"]);
    const broken = harnessDir(HRN_A, "name: probe\ntarget: cli\nplugins: [probe-tools\n  : :\n");
    const silent = harnessDir(HRN_B, "name: probe\ntarget: cli\nplugins: [other\n  : :\n");
    const odd = harnessDir(
      "hrn_00000000000000c3",
      specWith('[{name: probe-tools, tools: "Bash"}]'),
    );
    expect(stillLoadedBy(r, servedSet("all", ["Bash"]), [broken, silent, odd], hangarRoot)).toEqual(
      [
        { id: HRN_A, tools: null },
        { id: "hrn_00000000000000c3", tools: null },
      ],
    );
  });
});

describe("the plugins waiting for the owner's OK on a harness", () => {
  /** A plugin whose filesystem ask covers the harnesses under `root/harnesses/<glob>`. */
  const seeing = (name: string, glob: string, extra: Record<string, unknown>) =>
    install({
      name,
      version: "1.0.0",
      permissions: { fs: [`read:${join(root, "harnesses")}/${glob}`] },
      ...extra,
    });

  test("only a plugin with a tab or an observer, asking for this harness, and not served here", async () => {
    const a = harnessDir(HRN_A, specWith("[]"));
    const b = harnessDir(HRN_B, specWith("[]"));
    const paned = seeing("paned", "**", {
      panes: [{ id: "board", title: "Board", file: "board.html" }],
    });
    seeing("observer", "**", { onTraceEvent: true });
    seeing("paneless", "**", {});
    seeing("only-a", `${HRN_A}/**`, {
      panes: [{ id: "board", title: "Board", file: "board.html" }],
    });
    const inventory = () => readPluginInventory(pluginsDir, standingFrom(grants()));
    const now = () => servedPlugins(inventory(), grants());
    expect(waitingOn(inventory(), now(), b).sort()).toEqual(["observer", "paned"]);
    expect(waitingOn(inventory(), now(), a).sort()).toEqual(["observer", "only-a", "paned"]);
    // A grant on A leaves it waiting on B, and not on A.
    await grantPlugin(hangarRoot, {
      row: paned,
      grant: { ...SERVED_NOTHING, harnesses: [HRN_A], panes: ["board"] },
      by: "prn_00000000000000000000000001",
      cmd: "cmd_00000000000000000000000001",
    });
    expect(waitingOn(inventory(), now(), b)).toContain("paned");
    expect(waitingOn(inventory(), now(), a)).not.toContain("paned");
    // A revoked grant waits again.
    await revokePlugin(hangarRoot, {
      plugin: "paned",
      by: "prn_00000000000000000000000001",
      cmd: "cmd_00000000000000000000000002",
    });
    expect(waitingOn(inventory(), now(), a)).toContain("paned");
  });
});

describe("a grant or revoke with loadedBy answers who still loads the plugin", () => {
  test("a revoke names each given harness that loads it; without loadedBy the field is absent", async () => {
    const r = toolsPlugin(["Bash"]);
    const a = harnessDir(HRN_A, specWith('[{name: probe-tools, tools: ["Bash"]}]'));
    const by = { by: "prn_00000000000000000000000001", cmd: "cmd_00000000000000000000000001" };
    const granted = await grantPlugin(hangarRoot, {
      row: r,
      grant: { ...SERVED_NOTHING, harnesses: [HRN_A], tools: ["Bash"] },
      loadedBy: { row: r, harnesses: [a] },
      ...by,
    });
    expect(granted.ok && granted.stillLoadedBy).toEqual([]);
    const narrowed = await grantPlugin(hangarRoot, {
      row: r,
      grant: { ...SERVED_NOTHING, harnesses: [HRN_A], tools: [], expect: 1 },
      loadedBy: { row: r, harnesses: [a] },
      ...by,
    });
    expect(narrowed.ok && narrowed.stillLoadedBy).toEqual([{ id: HRN_A, tools: ["Bash"] }]);
    const revoked = await revokePlugin(hangarRoot, {
      plugin: "probe-tools",
      loadedBy: { row: r, harnesses: [a] },
      ...by,
    });
    expect(revoked.ok && revoked.stillLoadedBy).toEqual([{ id: HRN_A, tools: ["Bash"] }]);
    const plain = await grantPlugin(hangarRoot, {
      row: r,
      grant: { ...SERVED_NOTHING, harnesses: [], tools: [] },
      ...by,
    });
    expect(plain.ok).toBe(true);
    expect("stillLoadedBy" in plain).toBe(false);
  });
});
