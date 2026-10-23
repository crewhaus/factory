/**
 * 0.8.0 (design §12 item 5) — `GET /api/runs/:id/proof`, driven through the
 * real HTTP surface against fixture harnesses, because the guards under test
 * (auth, the id shape, per-file containment, masking) live at the dispatch
 * site and in the reader, and a direct handler call would skip half of them.
 *
 * And its CLI twin. Every bundle row names "the exact command that does the
 * same thing in a terminal" — `crewhaus provability show --session <id>
 * --turn <n> --json` — and a twin that fails when pasted teaches an operator
 * the console's commands are decorative (cli-twins.test.ts says why). The CLI
 * is not imported (apps/cli depends on this package, not the other way
 * round); its SOURCE is read, the way cli-twins.test.ts's drift guard reads it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFixtureHarness } from "./fixture";
import {
  MANAGED_TENANTS_ROOT_DEFAULT,
  MAX_PROOF_BYTES,
  isProofRunId,
  isProofSpecDir,
  proofCliTwin,
  proofTenants,
  proofView,
} from "./proofs";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-10-22T00:00:00.000Z");
const SESS = "sess_00000000000000aa";
const OTHER_SESS = "sess_00000000000000bb";
const HASH = `sha256:${"ab".repeat(32)}`;
/** Opaque, under every shape rule's length, no prefix: only the env scrubber reaches it. */
const PLANTED = ["Qq1Rr2", "Ss3Tt4", "Uu5Vv6", "Ww7Xx8"].join("");

const servers: TestServer[] = [];
const scratch: string[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
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

/** A persisted bundle as the gate writes it (provability's `ProofBundle`). */
function bundle(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    level: "grounded",
    verdict: "pass",
    score: 1,
    threshold: 1,
    achieved: "grounded",
    claims: [
      {
        index: 0,
        text: "The refund window is 14 days.",
        line: 1,
        status: "met",
        best: "grounded",
        bindings: [
          {
            ref: "[1]",
            kind: "source",
            rung: "grounded",
            ok: true,
            origin: "https://acme.example/policy",
            sha256: HASH,
            excerpt: "Customers may request a refund within 14 days.",
          },
        ],
      },
    ],
    claimCount: 1,
    met: 1,
    unmet: 0,
    assumptions: 0,
    sources: 1,
    judgeWaived: 0,
    retryIndex: 0,
    createdAt: "2026-10-21T12:00:00.000Z",
    bundleHash: HASH,
    ...over,
  };
}

function writeBundle(
  dir: string,
  spec: string,
  session: string,
  turn: number,
  value: unknown,
): string {
  const at = join(dir, ".crewhaus", "proofs", spec, session);
  mkdirSync(at, { recursive: true });
  const path = join(at, `turn-${turn}.json`);
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

describe("GET /api/runs/:id/proof", () => {
  test("200: every bundle the run persisted, oldest turn first, with its CLI twin", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "support"), { specName: "support" });
    writeBundle(dir, "support", SESS, 2, bundle({ retryIndex: 1 }));
    writeBundle(dir, "support", SESS, 1, bundle());
    writeBundle(dir, "support", OTHER_SESS, 1, bundle({ verdict: "fail" }));
    // A second harness with no bundles for this run is searched and ignored.
    const quiet = makeFixtureHarness(join(t.harnessesRoot, "quiet"), { specName: "quiet" });
    const id = await register(t, dir);
    await register(t, quiet);

    const { status, body } = await t.api(`/api/runs/${SESS}/proof`);
    expect(status).toBe(200);
    expect(body["runId"]).toBe(SESS);
    expect(body["truncated"]).toBe(false);
    expect(body["skipped"]).toEqual([]);
    const rows = body["bundles"] as Array<Record<string, unknown>>;
    expect(rows.map((r) => r["turn"])).toEqual([1, 2]);
    expect(rows[0]).toMatchObject({
      harnessId: id,
      specName: "support",
      spec: "support",
      sessionId: SESS,
      path: `.crewhaus/proofs/support/${SESS}/turn-1.json`,
      cliTwin: proofCliTwin(dir, SESS, 1),
    });
    // The bundle as persisted: the digests survive the masker untouched.
    expect(rows[0]?.["bundle"]).toEqual(bundle());
    expect((rows[1]?.["bundle"] as Record<string, unknown>)["retryIndex"]).toBe(1);
  });

  test("?harness= narrows the search to one registry row", async () => {
    const t = boot();
    const a = makeFixtureHarness(join(t.harnessesRoot, "a"), { specName: "a" });
    const b = makeFixtureHarness(join(t.harnessesRoot, "b"), { specName: "b" });
    writeBundle(a, "a", SESS, 1, bundle());
    writeBundle(b, "b", SESS, 1, bundle({ verdict: "fail" }));
    const idA = await register(t, a);
    const idB = await register(t, b);

    const all = await t.api(`/api/runs/${SESS}/proof`);
    expect((all.body["bundles"] as unknown[]).length).toBe(2);
    const onlyB = await t.api(`/api/runs/${SESS}/proof?harness=${idB}`);
    expect(onlyB.status).toBe(200);
    const rows = onlyB.body["bundles"] as Array<Record<string, unknown>>;
    expect(rows.map((r) => r["harnessId"])).toEqual([idB]);
    expect(idA).not.toBe(idB);
  });

  test("404 when the run persisted nothing, or the scoped harness holds none", async () => {
    const t = boot();
    const a = makeFixtureHarness(join(t.harnessesRoot, "a"), { specName: "a" });
    const b = makeFixtureHarness(join(t.harnessesRoot, "b"), { specName: "b" });
    writeBundle(a, "a", SESS, 1, bundle());
    await register(t, a);
    const idB = await register(t, b);

    const none = await t.api(`/api/runs/${OTHER_SESS}/proof`);
    expect(none.status).toBe(404);
    expect(String(none.body["error"])).toContain(OTHER_SESS);
    expect((await t.api(`/api/runs/${SESS}/proof?harness=${idB}`)).status).toBe(404);
    // An unknown registry id is the registry's own 404; a malformed one a 400.
    expect((await t.api(`/api/runs/${SESS}/proof?harness=hrn_0000000000000000`)).status).toBe(404);
    expect((await t.api(`/api/runs/${SESS}/proof?harness=..%2Fx`)).status).toBe(400);
  });

  test("401 without the bearer token — the route is behind the same gate as every /api", async () => {
    const t = boot();
    const a = makeFixtureHarness(join(t.harnessesRoot, "a"), { specName: "a" });
    writeBundle(a, "a", SESS, 1, bundle());
    await register(t, a);
    const res = await t.fetchRaw(`/api/runs/${SESS}/proof`);
    expect(res.status).toBe(401);
    const wrong = await t.fetchRaw(`/api/runs/${SESS}/proof`, {
      headers: { authorization: "Bearer not-the-token" },
    });
    expect(wrong.status).toBe(401);
  });

  test("400 for anything but a session id — a traversal is refused before any path is built", async () => {
    const t = boot();
    for (const id of ["..%2F..%2Fetc", "sess_XYZ", "sess_00000000000000aa.json", "no-session"]) {
      const { status } = await t.api(`/api/runs/${id}/proof`);
      expect(status).toBe(400);
    }
    // `..` as its own segment is folded by URL parsing before it reaches the
    // server, so it lands on another (absent) route rather than this one.
    expect((await t.api("/api/runs/../proof")).status).not.toBe(200);
    expect((await t.api(`/api/runs/${SESS}/proof`, { method: "POST", body: "{}" })).status).toBe(
      405,
    );
  });

  test("a bundle name symlinked out of the harness is skipped, never read", async () => {
    const t = boot();
    const outside = mkdtempSync(join(tmpdir(), "proof-outside-"));
    scratch.push(outside);
    const secret = join(outside, "turn.json");
    writeFileSync(secret, `${JSON.stringify(bundle({ verdict: "fail", level: "proven" }))}\n`);
    const dir = makeFixtureHarness(join(t.harnessesRoot, "contained"), { specName: "contained" });
    writeBundle(dir, "contained", SESS, 1, bundle());
    symlinkSync(secret, join(dir, ".crewhaus", "proofs", "contained", SESS, "turn-2.json"));
    // A whole spec directory linked out of the harness is not entered either.
    mkdirSync(join(outside, "spec", SESS), { recursive: true });
    writeFileSync(join(outside, "spec", SESS, "turn-9.json"), JSON.stringify(bundle()));
    symlinkSync(join(outside, "spec"), join(dir, ".crewhaus", "proofs", "linked"));
    await register(t, dir);

    const { status, body } = await t.api(`/api/runs/${SESS}/proof`);
    expect(status).toBe(200);
    const rows = body["bundles"] as Array<Record<string, unknown>>;
    expect(rows.map((r) => r["turn"])).toEqual([1]);
    expect(JSON.stringify(body)).not.toContain('"proven"');
    expect(body["skipped"]).toEqual([
      {
        harnessId: rows[0]?.["harnessId"],
        path: `.crewhaus/proofs/contained/${SESS}/turn-2.json`,
        reason: "resolves outside the harness directory",
      },
    ]);
  });

  test("files that are not bundles are reported under skipped, with why", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "torn"), { specName: "torn" });
    writeBundle(dir, "torn", SESS, 1, '{"version": 1, "level": "gro');
    writeBundle(dir, "torn", SESS, 2, { version: 2, claims: [] });
    writeBundle(dir, "torn", SESS, 3, bundle());
    // Not a bundle name at all: ignored, not skipped.
    writeFileSync(join(dir, ".crewhaus", "proofs", "torn", SESS, "notes.txt"), "hi");
    await register(t, dir);

    const { status, body } = await t.api(`/api/runs/${SESS}/proof`);
    expect(status).toBe(200);
    expect((body["bundles"] as Array<Record<string, unknown>>).map((r) => r["turn"])).toEqual([3]);
    const skipped = body["skipped"] as Array<Record<string, unknown>>;
    expect(skipped.map((s) => [s["path"], s["reason"]])).toEqual([
      [`.crewhaus/proofs/torn/${SESS}/turn-1.json`, "not valid JSON"],
      [`.crewhaus/proofs/torn/${SESS}/turn-2.json`, "not a proof bundle"],
    ]);
  });

  test("only skipped files is still an answer (200), not a 404 that hides them", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "bad"), { specName: "bad" });
    writeBundle(dir, "bad", SESS, 1, "not json");
    await register(t, dir);
    const { status, body } = await t.api(`/api/runs/${SESS}/proof`);
    expect(status).toBe(200);
    expect(body["bundles"]).toEqual([]);
    expect((body["skipped"] as unknown[]).length).toBe(1);
  });

  test("claim text carrying a credential the harness holds comes back as its NAME", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "masked"), {
      specName: "masked",
      envLines: [`PLANTED_SECRET=${PLANTED}`],
    });
    const leaky = bundle();
    const claims = leaky["claims"] as Array<Record<string, unknown>>;
    (claims[0] as Record<string, unknown>)["text"] = `The admin password is ${PLANTED}.`;
    writeBundle(dir, "masked", SESS, 1, leaky);
    await register(t, dir);

    const { status, body } = await t.api(`/api/runs/${SESS}/proof`);
    expect(status).toBe(200);
    expect(JSON.stringify(body)).not.toContain(PLANTED);
    expect(JSON.stringify(body)).toContain("«PLANTED_SECRET»");
  });
});

/** A bundle as a managed turn files it: `<tenantsRoot>/<tenant>/proofs/<spec>/<session>/`. */
function writeTenantBundle(
  tenantsRoot: string,
  tenant: string,
  spec: string,
  session: string,
  turn: number,
  value: unknown,
): string {
  const at = join(tenantsRoot, tenant, "proofs", spec, session);
  mkdirSync(at, { recursive: true });
  const path = join(at, `turn-${turn}.json`);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

describe("GET /api/runs/:id/proof — spec directories and the managed shape", () => {
  test("a spec directory the store files under is found even when Hangar's id shape is stricter", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "dotted"), { specName: "dotted" });
    writeBundle(dir, ".agent", SESS, 1, bundle());
    writeBundle(dir, "-agent", SESS, 2, bundle());
    writeBundle(dir, "x".repeat(140), SESS, 3, bundle());
    await register(t, dir);
    const { status, body } = await t.api(`/api/runs/${SESS}/proof`);
    expect(status).toBe(200);
    const rows = body["bundles"] as Array<Record<string, unknown>>;
    expect(rows.map((r) => r["spec"])).toEqual([".agent", "-agent", "x".repeat(140)]);
  });

  test("a managed harness's tenants root inside the harness is searched, with a twin that finds it", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "fleet"), {
      specName: "fleet",
      target: "managed",
      envLines: ["CREWHAUS_TENANTS_ROOT=.crewhaus/tenants"],
    });
    writeTenantBundle(join(dir, ".crewhaus", "tenants"), "acme", "fleet", SESS, 1, bundle());
    // Another tenant, and a tenant directory linked out of the harness.
    writeTenantBundle(join(dir, ".crewhaus", "tenants"), "globex", "fleet", SESS, 2, bundle());
    const outside = mkdtempSync(join(tmpdir(), "proof-tenant-outside-"));
    scratch.push(outside);
    writeTenantBundle(outside, "evil", "fleet", SESS, 9, bundle({ level: "proven" }));
    symlinkSync(join(outside, "evil"), join(dir, ".crewhaus", "tenants", "evil"));
    const id = await register(t, dir);

    const { status, body } = await t.api(`/api/runs/${SESS}/proof`);
    expect(status).toBe(200);
    expect(body["tenantRootsNotRead"]).toBeUndefined();
    const rows = body["bundles"] as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r["tenant"], r["turn"]])).toEqual([
      ["acme", 1],
      ["globex", 2],
    ]);
    expect(rows[0]).toMatchObject({
      harnessId: id,
      spec: "fleet",
      path: `.crewhaus/tenants/acme/proofs/fleet/${SESS}/turn-1.json`,
      cliTwin: proofCliTwin(dir, SESS, 1, ".crewhaus/tenants"),
    });
    // Not masked: the tenants root is a directory, not a credential.
    expect(String(rows[0]?.["cliTwin"])).toContain("--tenants-root '.crewhaus/tenants' --json");
    expect(JSON.stringify(body)).not.toContain('"proven"');
  });

  test("a managed harness whose tenants root is outside it is named, not read — 404 says where", async () => {
    const t = boot();
    const outside = mkdtempSync(join(tmpdir(), "proof-tenants-"));
    scratch.push(outside);
    writeTenantBundle(outside, "acme", "fleet", SESS, 1, bundle());
    const dir = makeFixtureHarness(join(t.harnessesRoot, "fleet"), {
      specName: "fleet",
      target: "managed",
      envLines: [`CREWHAUS_TENANTS_ROOT=${outside}`],
    });
    const id = await register(t, dir);
    const none = await t.api(`/api/runs/${SESS}/proof`);
    expect(none.status).toBe(404);
    expect(String(none.body["error"])).toContain(
      "a managed harness files its bundles under its tenants root",
    );
    expect(String(none.body["error"])).toContain(`crewhaus provability show --session ${SESS}`);
    expect(JSON.stringify(none.body)).not.toContain('"bundle"');

    // With a bundle elsewhere the answer is a 200 that still names the unread root.
    const plain = makeFixtureHarness(join(t.harnessesRoot, "plain"), { specName: "plain" });
    writeBundle(plain, "plain", SESS, 1, bundle());
    await register(t, plain);
    const { status, body } = await t.api(`/api/runs/${SESS}/proof`);
    expect(status).toBe(200);
    expect(body["tenantRootsNotRead"]).toEqual([{ harnessId: id, root: outside }]);
  });

  test("proofTenants: managed only; the /tmp default and an escaping .env value are not readable", () => {
    const root = mkdtempSync(join(tmpdir(), "proof-tenants-unit-"));
    scratch.push(root);
    const dir = join(root, "h");
    mkdirSync(join(dir, "t"), { recursive: true });
    expect(proofTenants(dir, "cli")).toBeUndefined();
    expect(proofTenants(dir, "managed")).toEqual({
      readable: false,
      root: MANAGED_TENANTS_ROOT_DEFAULT,
    });
    writeFileSync(join(dir, ".env"), "CREWHAUS_TENANTS_ROOT=t\n");
    expect(proofTenants(dir, "managed")).toMatchObject({ readable: true, segments: ["t"] });
    // Inside but not created yet (no turn has run): searched, and empty.
    writeFileSync(join(dir, ".env"), "CREWHAUS_TENANTS_ROOT=.crewhaus/tenants\n");
    expect(proofTenants(dir, "managed")).toMatchObject({
      readable: true,
      segments: [".crewhaus", "tenants"],
    });
    writeFileSync(join(dir, ".env"), "CREWHAUS_TENANTS_ROOT=../elsewhere\n");
    expect(proofTenants(dir, "managed")).toMatchObject({ readable: false });
    expect(isProofSpecDir("support")).toBe(true);
    for (const bad of ["..", ".", "a b", "a/b", ""]) expect(isProofSpecDir(bad)).toBe(false);
  });
});

describe("proofView (unit)", () => {
  test("refuses a run id that is not a session id", () => {
    expect(isProofRunId(SESS)).toBe(true);
    expect(isProofRunId("../sess_00000000000000aa")).toBe(false);
    expect(() => proofView([], "../x")).toThrow(/invalid run id/);
  });

  test("a bundle over the cap is skipped, not truncated into a half-read document", () => {
    const root = mkdtempSync(join(tmpdir(), "proof-cap-"));
    scratch.push(root);
    const dir = join(root, "h");
    writeBundle(dir, "big", SESS, 1, " ".repeat(MAX_PROOF_BYTES + 1));
    const view = proofView([{ id: "hrn_1", dir, specName: "big" }], SESS);
    expect(view.bundles).toEqual([]);
    expect(view.skipped).toEqual([
      {
        harnessId: "hrn_1",
        path: `.crewhaus/proofs/big/${SESS}/turn-1.json`,
        reason: `larger than ${MAX_PROOF_BYTES} bytes`,
      },
    ]);
  });

  test("a harness with no .crewhaus/proofs contributes nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "proof-empty-"));
    scratch.push(root);
    expect(proofView([{ id: "hrn_1", dir: root, specName: "x" }], SESS)).toEqual({
      runId: SESS,
      bundles: [],
      skipped: [],
      truncated: false,
    });
  });
});

/** Repo paths, from this file: the CLI SOURCE is read, never imported. */
const CLI_SRC = join(
  import.meta.dir.replace(/([/\\])dist$/, "$1src"),
  "..",
  "..",
  "..",
  "apps",
  "cli",
  "src",
);

/** The flags `crewhaus provability` declares, read off `PROVABILITY_SCHEMA`'s source. */
function declaredProvabilityFlags(): readonly string[] {
  const source = readFileSync(join(CLI_SRC, "arg-schemas.ts"), "utf8");
  const start = source.indexOf("export const PROVABILITY_SCHEMA");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n};", start);
  const block = source.slice(start, end);
  return [...block.matchAll(/name: "([a-z-]+)"/g)].map((m) => m[1] as string);
}

describe("the proof route's CLI twin runs", () => {
  test("every flag the twin passes is one `crewhaus provability` declares", () => {
    const twin = proofCliTwin("/srv/my harnesses/poly", SESS, 7);
    expect(twin).toBe(
      `cd '/srv/my harnesses/poly' && crewhaus provability show --session ${SESS} --turn 7 --json`,
    );
    const tenantTwin = proofCliTwin("/srv/poly", SESS, 7, ".crewhaus/tenants");
    expect(tenantTwin).toBe(
      `cd '/srv/poly' && crewhaus provability show --session ${SESS} --turn 7 --tenants-root '.crewhaus/tenants' --json`,
    );
    const declared = declaredProvabilityFlags();
    for (const one of [twin, tenantTwin]) {
      const command = one.split("&&")[1]?.trim() ?? "";
      const tokens = command.split(/\s+/);
      expect(tokens.slice(0, 3)).toEqual(["crewhaus", "provability", "show"]);
      const flags = tokens.filter((tok) => tok.startsWith("--")).map((tok) => tok.slice(2));
      for (const flag of flags) expect(declared).toContain(flag);
    }
  });

  test("drift guard: the CLI dispatches `provability` and its module knows the `show` verb", () => {
    // A boolean, not `toContain`: a failure must not print the 1 MB entry file.
    const index = readFileSync(join(CLI_SRC, "index.ts"), "utf8");
    expect(index.includes('case "provability":')).toBe(true);
    const module = readFileSync(join(CLI_SRC, "provability-cli.ts"), "utf8");
    const actions = /export const PROVABILITY_ACTIONS = \[([^\]]*)\]/.exec(module)?.[1] ?? "";
    expect(actions).toContain('"show"');
  });
});
