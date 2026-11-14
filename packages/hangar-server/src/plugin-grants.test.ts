/**
 * Plugin grants (#522): the ledger, the standing a review computes from it, and what
 * Home serves. Every test writes manifests into a temp plugins directory and grants
 * into a temp Hangar root, and reads both back as Home does.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENT_TAXONOMY, isId } from "@crewhaus/control-contract";
import { foldStates } from "@crewhaus/control-records";
import { PLUGIN_INTEGRATION_EVENT_FAMILIES } from "@crewhaus/plugin-sdk";
import {
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
afterEach(() => rmSync(root, { recursive: true, force: true }));

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
