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
import { type V1Home, v1Home } from "../__test__/v1-home";
import { pluginGrantsLedger } from "../plugin-grants";

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
