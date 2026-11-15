/**
 * Plugin grants through the API (#522): the owner's review, a grant and a revoke, each
 * write one receipt and one ledger row; refusals before acceptance write neither; only
 * the owner grants; and a review writes nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldStates } from "@crewhaus/control-records";
import { workspaceCommandsLedger } from "@crewhaus/control-service";
import { isCredentialKey } from "@crewhaus/spec-patch";
import { type V1Home, v1Home } from "../__test__/v1-home";
import { SERVED_NOTHING, pluginGrantsLedger } from "../plugin-grants";
import { readPluginInventory } from "../plugins";
import { type LoadedByContext, stillLoadedFor } from "./plugins";

let home: V1Home;
let scratch: string;
let pluginsDir: string;
let a: { id: string; dir: string };
let b: { id: string; dir: string };

const MANIFEST = {
  name: "notes-pane",
  version: "1.0.0",
  panes: [{ id: "board", title: "Board", file: "board.html" }],
  permissions: {
    net: ["fetch:https://api.notes.test/**"],
    tools: ["Read"],
    secrets: ["NOTES_API_KEY"],
  },
  integration: { protocol: "crewhaus.hangar.v1", events: ["run"] },
};

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "v1-plugins-"));
  pluginsDir = join(scratch, "plugins");
  mkdirSync(join(pluginsDir, "notes-pane"), { recursive: true });
  writeFileSync(join(pluginsDir, "notes-pane", "plugin.json"), JSON.stringify(MANIFEST));
  writeFileSync(join(pluginsDir, "notes-pane", "board.html"), "<p>board</p>");
  home = await v1Home({ pluginsDir });
  a = await home.harness("granted-a");
  b = await home.harness("granted-b");
}, 60_000);

afterAll(async () => {
  await home?.t.stop();
  rmSync(scratch, { recursive: true, force: true });
});

const P = "/api/v1/plugins/notes-pane";

function receipts(kind: string): Record<string, unknown>[] {
  const fold = foldStates(workspaceCommandsLedger(home.t.hangarRoot));
  if (!fold.ok) return [];
  return [...fold.objects.values()]
    .map((object) => object.record as Record<string, unknown>)
    .filter((row) => row["kind"] === kind);
}

function grantRows(): number {
  const fold = foldStates(pluginGrantsLedger(home.t.hangarRoot));
  return fold.ok ? fold.records : 0;
}

function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      out.push(path);
      if (entry.isDirectory()) walk(path);
    }
  };
  walk("");
  // A signed-in call records when its credential was last used, under access/: that is
  // the sign-in layer's, not the read's.
  return out.filter((path) => !path.startsWith("access/")).sort();
}

const grantBody = (over: Record<string, unknown> = {}) => ({
  harnesses: [a.id],
  panes: ["board"],
  events: ["run"],
  reads: [],
  net: [],
  tools: ["Read"],
  ...over,
});

describe("plugins through the API", () => {
  test("a review before any grant: waiting, nothing served, env names shown as names", async () => {
    const before = tree(home.t.hangarRoot);
    const res = await home.call("GET", `${P}/review`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      plugin: "notes-pane",
      version: "1.0.0",
      state: "waiting",
      legacy: false,
      granted: null,
      gen: null,
      verb: "crewhaus plugins grants notes-pane",
    });
    // Through the dispatch masker: a NAME is not a secret, so it is shown.
    expect(res.body["envNames"]).toEqual(["NOTES_API_KEY"]);
    expect((res.body["served"] as { panes: string[] }).panes).toEqual([]);
    expect((res.body["asks"] as { net: string[] }).net).toEqual(["https://api.notes.test"]);
    expect(tree(home.t.hangarRoot)).toEqual(before);
  });

  test("the review carries every field Settings › Plugins reads, with its type", async () => {
    const body = (await home.call("GET", `${P}/review`)).body;
    const types: Record<string, string> = {
      plugin: "string",
      version: "string",
      signed: "boolean",
      state: "string",
      legacy: "boolean",
      asks: "object",
      served: "object",
      envNames: "object",
      verb: "string",
    };
    for (const [field, type] of Object.entries(types)) {
      expect(`${field}: ${typeof body[field]}`).toBe(`${field}: ${type}`);
    }
    expect("gen" in body && "granted" in body && "crewhausRange" in body).toBe(true);
    for (const group of ["harnesses", "panes", "events", "reads", "net", "tools"]) {
      expect(Array.isArray((body["asks"] as Record<string, unknown>)[group])).toBe(true);
      expect(Array.isArray((body["served"] as Record<string, unknown>)[group])).toBe(true);
    }
  });

  test("an unknown plugin answers 404 with the install verb", async () => {
    const res = await home.call("GET", "/api/v1/plugins/not-installed/review");
    expect(res.status).toBe(404);
    expect((res.body["error"] as { verb: string }).verb).toBe(
      "crewhaus plugins install not-installed",
    );
  });

  test("a grant naming an origin the plugin does not ask for is refused: no receipt, no row", async () => {
    const res = await home.call("PUT", `${P}/grant`, {
      body: grantBody({ net: ["https://evil.test"] }),
    });
    expect(res.status).toBe(400);
    expect((res.body["error"] as { message: string }).message).toContain(
      'does not ask for the origin "https://evil.test"',
    );
    expect(receipts("plugins.grant")).toEqual([]);
    expect(grantRows()).toBe(0);
  });

  test("an unknown harness is refused by name", async () => {
    const res = await home.call("PUT", `${P}/grant`, {
      body: grantBody({ harnesses: ["hrn_ffffffffffffffff"] }),
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("hrn_ffffffffffffffff");
    expect(grantRows()).toBe(0);
  });

  test("a maintainer and a service are refused the grant", async () => {
    const maintainer = await home.member("mia", "maintainer");
    const service = await home.service("bot", [a.id], { permissions: ["h.read"] });
    for (const secret of [maintainer.secret, service.secret]) {
      const res = await home.call("PUT", `${P}/grant`, { body: grantBody(), secret });
      expect(res.status).toBe(403);
    }
    expect(grantRows()).toBe(0);
  });

  test("the owner's grant writes one receipt and one row, and serves its pane on A only", async () => {
    const res = await home.call("PUT", `${P}/grant`, { body: grantBody() });
    expect(res.status).toBe(200);
    expect((res.body["receipt"] as { state: string }).state).toBe("succeeded");
    expect((res.body["grant"] as { gen: number }).gen).toBe(1);
    expect(receipts("plugins.grant")).toHaveLength(1);
    expect(grantRows()).toBe(1);
    const review = await home.call("GET", `${P}/review`);
    expect(review.body).toMatchObject({ state: "allowed", gen: 1 });
    expect((review.body["served"] as { harnesses: string[] }).harnesses).toEqual([a.id]);
    const onA = await home.call("GET", `/api/h/${a.id}/panes`);
    expect((onA.body["panes"] as Array<{ id: string }>).map((p) => p.id)).toEqual(["board"]);
    const onB = await home.call("GET", `/api/h/${b.id}/panes`);
    expect(onB.body["panes"]).toEqual([]);
  });

  test("a stale generation answers 412 with the current one, and appends nothing", async () => {
    const rows = grantRows();
    const noExpect = await home.call("PUT", `${P}/grant`, { body: grantBody() });
    expect(noExpect.status).toBe(412);
    expect((noExpect.body["error"] as { current: { gen: number } }).current.gen).toBe(1);
    const wrong = await home.call("PUT", `${P}/grant`, { body: grantBody({ expect: 9 }) });
    expect(wrong.status).toBe(412);
    expect(grantRows()).toBe(rows);
    const right = await home.call("PUT", `${P}/grant`, {
      body: grantBody({ harnesses: [a.id, b.id], expect: 1 }),
    });
    expect(right.status).toBe(200);
    expect((right.body["grant"] as { gen: number }).gen).toBe(2);
  });

  test("a revoke serves nothing; a second revoke is a refusal, not a receipt", async () => {
    const res = await home.call("POST", `${P}/revoke`, { body: {} });
    expect(res.status).toBe(200);
    const review = await home.call("GET", `${P}/review`);
    expect(review.body).toMatchObject({ state: "revoked", gen: null, granted: null });
    expect((await home.call("GET", `/api/h/${a.id}/panes`)).body["panes"]).toEqual([]);
    const receiptsBefore = receipts("plugins.revoke").length;
    const again = await home.call("POST", `${P}/revoke`, { body: {} });
    expect(again.status).toBe(409);
    expect(receipts("plugins.revoke")).toHaveLength(receiptsBefore);
  });
});

describe("a grant or revoke names each harness whose crewhaus.yaml still loads the plugin", () => {
  let lhome: V1Home;
  let lscratch: string;
  let lplugins: string;
  let la: { id: string; dir: string };
  let lb: { id: string; dir: string };
  const L = "/api/v1/plugins/tool-lens";
  const NAMES = ["tool-lens", "paneless-probe", "only-a-probe"];
  const board = [{ id: "board", title: "Board", file: "board.html" }];

  const install = (name: string, manifest: Record<string, unknown>) => {
    mkdirSync(join(lplugins, name), { recursive: true });
    writeFileSync(
      join(lplugins, name, "plugin.json"),
      JSON.stringify({ name, version: "1.0.0", ...manifest }),
    );
    writeFileSync(join(lplugins, name, "board.html"), "<p>board</p>");
  };

  beforeAll(async () => {
    lscratch = mkdtempSync(join(tmpdir(), "v1-plugins-loaded-"));
    lplugins = join(lscratch, "plugins");
    mkdirSync(lplugins, { recursive: true });
    lhome = await v1Home({ pluginsDir: lplugins });
    la = await lhome.harness("loaded-a");
    lb = await lhome.harness("loaded-b");
    // The harness root exists only once Home has booted; the inventory is read per request.
    const everyHarness = `read:${lhome.t.harnessesRoot}/**`;
    install("tool-lens", { panes: board, permissions: { fs: [everyHarness], tools: ["Bash"] } });
    install("paneless-probe", { permissions: { fs: [everyHarness], tools: ["Bash"] } });
    install("only-a-probe", { panes: board, permissions: { fs: [`read:${la.dir}/**`] } });
  }, 60_000);

  afterAll(async () => {
    await lhome?.t.stop();
    rmSync(lscratch, { recursive: true, force: true });
  });

  const body = (over: Record<string, unknown>) => ({
    harnesses: [la.id],
    panes: [],
    events: [],
    reads: [],
    net: [],
    tools: ["Bash"],
    ...over,
  });
  const waiting = async (id: string) =>
    (await lhome.call("GET", `/api/h/${id}/panes`)).body["waiting"] as string[];

  test("a harness-scoped caller learns no plugin name from the panes route", async () => {
    const bot = await lhome.service("bot", [lb.id], { permissions: ["h.read"] });
    expect((await lhome.call("GET", "/api/plugins", { secret: bot.secret })).status).toBe(403);
    const res = await lhome.call("GET", `/api/h/${lb.id}/panes`, { secret: bot.secret });
    expect(res.status).toBe(200);
    expect(res.body["waiting"]).toEqual([]);
    const text = JSON.stringify(res.body);
    for (const name of NAMES) expect(text.includes(name)).toBe(false);
    // The owner's list for B: the count the token gets counts it, and nothing else.
    const owners = await waiting(lb.id);
    expect(owners).toEqual(["tool-lens"]);
    expect(res.body["waitingCount"]).toBe(owners.length);
  });

  test("a plugin with no tab or observer, or that does not ask for this harness, is not waiting here", async () => {
    const onB = await waiting(lb.id);
    expect(onB.includes("paneless-probe")).toBe(false);
    expect(onB.includes("only-a-probe")).toBe(false);
    expect(await waiting(la.id)).toContain("only-a-probe");
  });

  test("a grant on A leaves the plugin waiting on B, and not on A", async () => {
    const res = await lhome.call("PUT", `${L}/grant`, { body: body({ panes: ["board"] }) });
    expect(res.status).toBe(200);
    expect(res.body["stillLoadedBy"]).toEqual([]);
    expect(await waiting(lb.id)).toContain("tool-lens");
    expect(await waiting(la.id)).not.toContain("tool-lens");
  });

  test("a revoke names the harness that loads it, with the host tools its entry hands it", async () => {
    const put = (extra: Record<string, unknown>) =>
      lhome.call("PUT", `/api/h/${la.id}/builders/plugins/tool-lens`, {
        body: { tools: ["Bash"], ...extra },
      });
    const dry = await put({});
    expect(dry.status).toBe(200);
    const wrote = await put({
      dryRun: false,
      confirmName: dry.body["confirmName"],
      expectedRev: dry.body["rev"],
    });
    expect(wrote.status).toBe(200);
    const revoked = await lhome.call("POST", `${L}/revoke`, { body: {} });
    expect(revoked.status).toBe(200);
    expect(revoked.body["stillLoadedBy"]).toEqual([{ id: la.id, tools: ["Bash"] }]);
  });

  test("a grant that leaves out the harness, or its host tool, names the harness", async () => {
    const onB = await lhome.call("PUT", `${L}/grant`, { body: body({ harnesses: [lb.id] }) });
    expect(onB.status).toBe(200);
    expect(onB.body["stillLoadedBy"]).toEqual([{ id: la.id, tools: ["Bash"] }]);
    const gen = (onB.body["grant"] as { gen: number }).gen;
    const noTool = await lhome.call("PUT", `${L}/grant`, {
      body: body({ tools: [], expect: gen }),
    });
    expect(noTool.status).toBe(200);
    expect(noTool.body["stillLoadedBy"]).toEqual([{ id: la.id, tools: ["Bash"] }]);
    const covered = await lhome.call("PUT", `${L}/grant`, {
      body: body({ expect: (noTool.body["grant"] as { gen: number }).gen }),
    });
    expect(covered.status).toBe(200);
    expect(covered.body["stillLoadedBy"]).toEqual([]);
  });

  test("a harness the caller cannot read is never read or named", () => {
    const row = readPluginInventory(lplugins).plugins.find((p) => p.name === "tool-lens");
    if (row === undefined) throw new Error("no tool-lens");
    const ctx = (canRead: (id: string) => boolean): LoadedByContext => ({
      deps: {
        registry: { list: () => [{ id: la.id, dir: la.dir }] } as never,
        hangarRoot: lhome.t.hangarRoot,
      },
      access: { canRead },
    });
    expect(
      stillLoadedFor(
        ctx((id) => id !== la.id),
        row,
        SERVED_NOTHING,
      ),
    ).toEqual([]);
    expect(
      stillLoadedFor(
        ctx(() => true),
        row,
        SERVED_NOTHING,
      ),
    ).toEqual([{ id: la.id, tools: ["Bash"] }]);
  });

  test("the new answer fields are not credential names, so the masker shows them", () => {
    expect(isCredentialKey("stillLoadedBy")).toBe(false);
    expect(isCredentialKey("waitingCount")).toBe(false);
    expect(isCredentialKey("credentialNames")).toBe(false);
  });
});
