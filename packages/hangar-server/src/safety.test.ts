import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logLine, makeFixtureHarness } from "./fixture";
import { isSafePathSegment, resolveContained, resolveInside } from "./safety";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const ISO = new Date(NOW).toISOString();
const GOOD_SESSION = "sess_000000000000c1ea";
const SNEAKY_SESSION = "sess_00000000000005ea";

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});
function boot(): TestServer {
  const t = bootTestServer({ now: () => NOW });
  servers.push(t);
  return t;
}

async function register(t: TestServer, dir: string): Promise<string> {
  const { body } = await t.api("/api/harnesses", {
    method: "POST",
    body: JSON.stringify({ dir }),
  });
  return (body["entry"] as { id: string }).id;
}

describe("path-safety primitives", () => {
  test("isSafePathSegment rejects separators, dots, NUL, empties", () => {
    for (const bad of ["", ".", "..", "a/b", "a\\b", "a\0b", "..%2f", "..\\.."]) {
      // `..%2f` decodes to a slash-bearing segment upstream; encoded it is a
      // safe LITERAL name — the routing layer decodes before validating.
      if (bad === "..%2f") {
        expect(isSafePathSegment(bad)).toBe(true);
        continue;
      }
      expect(`${bad}:${isSafePathSegment(bad)}`).toBe(`${bad}:false`);
    }
    expect(isSafePathSegment("sess_0123456789abcdef")).toBe(true);
  });

  test("resolveInside refuses traversal and symlink escapes, allows in-tree reads", () => {
    const t = boot();
    const root = join(t.harnessesRoot, "safety-root");
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "sub", "ok.txt"), "fine");
    const outside = join(t.workspace, "outside.txt");
    writeFileSync(outside, "SENTINEL-OUTSIDE");

    expect(resolveInside(root, ["sub", "ok.txt"])).toBe(join(root, "sub", "ok.txt"));
    // Not-yet-existing paths still validate (probe-before-create).
    expect(resolveInside(root, ["sub", "new.txt"])).toBe(join(root, "sub", "new.txt"));
    expect(resolveInside(root, ["..", "outside.txt"])).toBeUndefined();
    expect(resolveInside(root, ["sub", "..", "..", "outside.txt"])).toBeUndefined();
    expect(resolveInside(root, ["sub/../../outside.txt"])).toBeUndefined();
    expect(resolveInside(root, ["a\0b"])).toBeUndefined();

    // A symlink INSIDE the tree pointing OUTSIDE must not resolve.
    symlinkSync(outside, join(root, "sub", "sneaky.txt"));
    expect(resolveInside(root, ["sub", "sneaky.txt"])).toBeUndefined();
    // A symlinked DIR escaping the root must not resolve through either.
    symlinkSync(t.workspace, join(root, "sub", "updir"));
    expect(resolveInside(root, ["sub", "updir", "outside.txt"])).toBeUndefined();

    expect(resolveContained(root, outside)).toBeUndefined();
    expect(resolveContained(root, "sub/ok.txt")).toBe(join(root, "sub", "ok.txt"));
  });
});

describe("traversal fuzzing over HTTP", () => {
  test("hostile ids and encoded traversals never read outside the harness dir", async () => {
    const t = boot();
    const outside = join(t.workspace, "secret-outside.md");
    writeFileSync(outside, "OUTSIDE-SECRET-BYTES");
    const dir = makeFixtureHarness(join(t.harnessesRoot, "fuzz"), {
      specName: "fuzz",
      wikiIndex: { "real-article": { title: "Real" } },
      wikiArticles: { "real-article": "# real body\n" },
      evalRuns: [
        {
          runId: "run_00000000000000aa",
          results: { passRate: 1 },
          samples: { s1: { grades: { pass: true }, meta: {}, transcript: [{ kind: "x" }] } },
        },
      ],
    });
    // Plant an escaping symlink where the wiki article resolver looks.
    symlinkSync(outside, join(dir, ".crewhaus", "wiki", "articles", "sneaky.md"));
    const id = await register(t, dir);

    const badIds = [
      "..",
      "%2e%2e",
      "..%2f..%2fetc",
      "hrn_zzzzzzzzzzzzzzzz",
      "hrn_0123456789abcdef0",
      "hrn_0123456789abcde",
      "hrn_0123456789ABCDEF",
      "sess_0000000000000000",
      encodeURIComponent("../../../etc/passwd"),
      "hrn_0123456789abcdef%2F..",
    ];
    for (const bad of badIds) {
      const res = await t.api(`/api/h/${bad}`);
      expect(`${bad}:${res.status}`).toMatch(/:(400|404)$/);
    }

    const badSubPaths = [
      `/api/h/${id}/sessions/${encodeURIComponent("../../.env")}`,
      `/api/h/${id}/sessions/sess_..%2f..%2f..%2fetc`,
      `/api/h/${id}/evals/${encodeURIComponent("../../secrets")}`,
      `/api/h/${id}/evals/run_00000000000000aa/${encodeURIComponent("../../../secret-outside.md")}`,
      // NB: a bare `%2e%2e` segment is dot-normalized away by the URL parser
      // BEFORE the request is sent — the server never sees it; the decoded
      // `..` path is covered by the resolveInside unit fuzz above.
      `/api/h/${id}/evals/run_00000000000000aa/...`,
      `/api/h/${id}/evals/run_00000000000000aa/..%2fsecret`,
      `/api/h/${id}/evals/run_00000000000000aa/.hidden`,
      `/api/h/${id}/memory/wiki/${encodeURIComponent("../../.env")}`,
      `/api/h/${id}/memory/wiki/..%2fsettings`,
      `/api/h/${id}/memory/wiki/.dotfile`,
      `/api/h/${id}/memory/${encodeURIComponent("../sessions")}`,
      `/api/h/${id}/memory/secrets`,
      `/api/h/${id}/memory/audit`,
    ];
    for (const path of badSubPaths) {
      const res = await t.api(path);
      expect(`${path}:${res.status}`).toMatch(/:(400|404)$/);
      expect(JSON.stringify(res.body)).not.toContain("OUTSIDE-SECRET-BYTES");
    }

    // The escaping symlink is unreachable even with a well-shaped slug.
    const sneaky = await t.api(`/api/h/${id}/memory/wiki/sneaky`);
    expect(sneaky.status).toBe(404);
    expect(JSON.stringify(sneaky.body)).not.toContain("OUTSIDE-SECRET-BYTES");

    // Sanity: the legitimate resources still resolve.
    expect((await t.api(`/api/h/${id}/memory/wiki/real-article`)).status).toBe(200);
    expect((await t.api(`/api/h/${id}/evals/run_00000000000000aa/s1`)).status).toBe(200);
  });

  test("planted symlinks in every read area stay unread (memory, sessions, costs, rollups)", async () => {
    const t = boot();
    const outside = join(t.workspace, "outside-store");
    mkdirSync(outside, { recursive: true });
    const secret = "OUTSIDE-SECRET-BYTES";
    // Files shaped like the ones each reader expects, so ONLY containment
    // stands between the reader and them.
    writeFileSync(join(outside, "leak.jsonl"), `${JSON.stringify({ leaked: secret })}\n`);
    writeFileSync(join(outside, "leak.md"), secret);
    writeFileSync(join(outside, "leak.json"), JSON.stringify({ leaked: secret }));

    const dir = makeFixtureHarness(join(t.harnessesRoot, "symlinked"), {
      specName: "symlinked",
      memories: { real: [{ id: "mem_0000000000000001", text: "clean", createdAt: ISO }] },
      focus: "clean focus\n",
      sessions: [{ id: GOOD_SESSION, updatedAt: ISO, log: [logLine("user_message", { c: 1 })] }],
    });
    const ch = join(dir, ".crewhaus");
    // memories/, state/plans/, dream/<spec>/, watchme/, sessions/ and
    // feedback/ each get an escaping entry with a plausible name.
    symlinkSync(join(outside, "leak.jsonl"), join(ch, "memories", "sneaky.jsonl"));
    mkdirSync(join(ch, "state", "plans"), { recursive: true });
    symlinkSync(join(outside, "leak.md"), join(ch, "state", "plans", "plan-sneaky.md"));
    mkdirSync(join(ch, "dream"), { recursive: true });
    symlinkSync(outside, join(ch, "dream", "sneaky"));
    mkdirSync(join(ch, "watchme"), { recursive: true });
    symlinkSync(join(outside, "leak.jsonl"), join(ch, "watchme", "observations.jsonl"));
    symlinkSync(join(outside, "leak.jsonl"), join(ch, "sessions", `${SNEAKY_SESSION}.jsonl`));
    mkdirSync(join(ch, "feedback"), { recursive: true });
    symlinkSync(join(outside, "leak.jsonl"), join(ch, "feedback", "sneaky.jsonl"));
    mkdirSync(join(ch, "sessions-index"), { recursive: true });
    symlinkSync(join(outside, "leak.json"), join(ch, "sessions-index", `${SNEAKY_SESSION}.json`));

    const id = await register(t, dir);
    const paths = [
      `/api/h/${id}`,
      `/api/h/${id}/memory/facts`,
      `/api/h/${id}/memory/state`,
      `/api/h/${id}/memory/dream`,
      `/api/h/${id}/memory/watchme`,
      `/api/h/${id}/sessions`,
      `/api/h/${id}/sessions/${SNEAKY_SESSION}`,
      `/api/h/${id}/sessions/${SNEAKY_SESSION}?raw=1`,
      `/api/h/${id}/costs`,
      "/api/costs",
      "/api/harnesses?hydrate=1",
    ];
    for (const path of paths) {
      const res = await t.fetchRaw(path, { headers: { authorization: `Bearer ${t.token}` } });
      const text = await res.text();
      expect(`${path}:${text.includes(secret)}`).toBe(`${path}:false`);
    }
    // The harness's own data is still served (containment, not paranoia).
    const facts = await t.api(`/api/h/${id}/memory/facts`);
    expect(JSON.stringify(facts.body)).toContain("clean");
    expect((await t.api(`/api/h/${id}/sessions/${GOOD_SESSION}`)).status).toBe(200);
  });
});
