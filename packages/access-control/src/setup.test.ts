/** The bootstrap migration, and the local actor it links. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_ACTOR_RE } from "@crewhaus/control-contract";
import { ensureAccessSetUp } from "./access";
import { authorize } from "./authorize";
import { localActorOf } from "./local-actor";
import { LEDGER_KINDS, accessPaths } from "./paths";
import { sha256Hex } from "./secrets";
import { loadAccessSnapshot } from "./snapshot";
import {
  BOOTSTRAP_TOKEN,
  LOCAL,
  fakeClock,
  filesUnder,
  ok,
  removeTempDirs,
  rowCount,
  tempDir,
  treeOf,
} from "./test-helpers";

afterAll(removeTempDirs);

function counts(root: string): Record<string, number> {
  return Object.fromEntries(
    LEDGER_KINDS.map((kind) => [kind, rowCount(root, accessPaths().ledgers[kind])]),
  );
}

function freshRoot(token: string | null = `${BOOTSTRAP_TOKEN}\n`): string {
  const root = join(tempDir(), "hangar");
  mkdirSync(root);
  if (token !== null) writeFileSync(join(root, "token"), token, { mode: 0o600 });
  return root;
}

describe("ensureAccessSetUp", () => {
  test("creates the owner, its home grant, a local link and the bootstrap's hash", async () => {
    const root = freshRoot();
    const clock = fakeClock();
    const done = ok(await ensureAccessSetUp(root, { localActor: LOCAL, now: clock.now }));
    expect(done.created).toEqual(["owner", "local-link", "bootstrap"]);
    expect(done.bootstrap).toBe("recorded");
    expect(done.localPrincipal).toBe(done.owner);
    const read = loadAccessSnapshot(root);
    if (read.state !== "present") throw new Error(read.state);
    const { snapshot } = read;
    expect(snapshot.owner).toBe(done.owner);
    expect(snapshot.epoch).toBe(1);
    expect(snapshot.principals).toHaveLength(1);
    expect(snapshot.grants).toEqual([
      expect.objectContaining({
        principal: done.owner,
        role: "owner",
        scope: "home",
        grantedBy: done.owner,
      }),
    ]);
    expect(snapshot.links).toEqual([
      expect.objectContaining({
        principal: done.owner,
        provider: "local",
        verifiedVia: "bootstrap",
      }),
    ]);
    expect(snapshot.tokens).toEqual([
      expect.objectContaining({
        principal: done.owner,
        kind: "bootstrap",
        sha256: await sha256Hex(BOOTSTRAP_TOKEN),
      }),
    ]);
    expect(snapshot.tokens[0]).not.toHaveProperty("prefixHint");
    expect(snapshot.subjects.links[snapshot.links[0]?.id as string]).toBe(LOCAL);
    expect(snapshot.subjects.principals[done.owner]).toEqual({ displayName: "max" });
  });

  test("is idempotent: a second call appends nothing and leaves the revision", async () => {
    const root = freshRoot();
    const clock = fakeClock();
    ok(await ensureAccessSetUp(root, { localActor: LOCAL, now: clock.now }));
    const before = counts(root);
    const tree = treeOf(join(root, "access"));
    clock.advance(1000);
    const again = ok(await ensureAccessSetUp(root, { localActor: LOCAL, now: clock.now }));
    expect(again.created).toEqual([]);
    expect(again.bootstrap).toBe("already-recorded");
    expect(counts(root)).toEqual(before);
    expect(before).toEqual({
      principals: 1,
      grants: 1,
      credentials: 1,
      invites: 0,
      links: 1,
      governed: 0,
    });
    expect(treeOf(join(root, "access"))).toEqual(tree);
  });

  test("is piecewise: with no token it records none and says so; once the token appears, only its row", async () => {
    const root = freshRoot(null);
    const clock = fakeClock();
    const first = ok(await ensureAccessSetUp(root, { localActor: LOCAL, now: clock.now }));
    expect(first.bootstrap).toBe("no-token");
    expect(first.created).toEqual(["owner", "local-link"]);
    const before = counts(root);
    writeFileSync(join(root, "token"), `${BOOTSTRAP_TOKEN}\n`);
    const second = ok(await ensureAccessSetUp(root, { localActor: LOCAL, now: clock.now }));
    expect(second.created).toEqual(["bootstrap"]);
    expect(counts(root)).toEqual({ ...before, credentials: 1 });
  });

  test("a token that is empty after trimming counts as none", async () => {
    const root = freshRoot("  \n");
    const done = ok(await ensureAccessSetUp(root, { localActor: LOCAL }));
    expect(done.bootstrap).toBe("empty-token");
    expect(rowCount(root, accessPaths().ledgers.credentials)).toBe(0);
  });

  test("the token file's bytes and mode are unchanged, and its hash is of the trimmed text", async () => {
    const root = freshRoot(`  ${BOOTSTRAP_TOKEN}\n\n`);
    const path = join(root, "token");
    const bytes = readFileSync(path);
    const mode = statSync(path).mode;
    ok(await ensureAccessSetUp(root, { localActor: LOCAL }));
    expect(readFileSync(path)).toEqual(bytes);
    if (process.platform !== "win32") expect(statSync(path).mode).toBe(mode);
    const read = loadAccessSnapshot(root);
    if (read.state !== "present") throw new Error(read.state);
    expect(read.snapshot.tokens[0]?.sha256).toBe(await sha256Hex(BOOTSTRAP_TOKEN));
  });

  test("an active bootstrap row already there is left alone when the token file changes", async () => {
    const root = freshRoot();
    ok(await ensureAccessSetUp(root, { localActor: LOCAL }));
    writeFileSync(join(root, "token"), `${"9".repeat(64)}\n`);
    const again = ok(await ensureAccessSetUp(root, { localActor: LOCAL }));
    expect(again.created).toEqual([]);
    expect(rowCount(root, accessPaths().ledgers.credentials)).toBe(1);
  });

  test("the owner holds every role permission, and decides on any harness", async () => {
    const root = freshRoot();
    const done = ok(await ensureAccessSetUp(root, { localActor: LOCAL }));
    const read = loadAccessSnapshot(root);
    const target = { scope: "harness" as const, harness: "hrn_00000000000000ff", groups: [] };
    const now = Date.now();
    expect(
      authorize(read, { principal: done.owner }, "h.decision.resolve", target, { now }).allow,
    ).toBe(true);
    expect(
      authorize(read, { principal: done.owner }, "home.access.manage", { scope: "home" }, { now })
        .allow,
    ).toBe(true);
  });

  test("another OS user is not linked, and nothing is appended for them", async () => {
    const root = freshRoot();
    ok(await ensureAccessSetUp(root, { localActor: LOCAL }));
    const before = counts(root);
    const other = ok(await ensureAccessSetUp(root, { localActor: "local:eve@laptop" }));
    expect(other.localPrincipal).toBeUndefined();
    expect(other.created).toEqual([]);
    expect(counts(root)).toEqual(before);
  });

  test("the same OS user under a renamed computer is linked again; another user still is not", async () => {
    const root = freshRoot();
    const first = ok(await ensureAccessSetUp(root, { localActor: "local:max@maxs-mbp.local" }));
    const renamed = ok(await ensureAccessSetUp(root, { localActor: "local:max@maxs-mbp" }));
    expect(renamed.localPrincipal).toBe(first.owner);
    expect(renamed.created).toEqual(["local-link"]);
    const read = loadAccessSnapshot(root);
    if (read.state !== "present") throw new Error("no records");
    const locals = read.snapshot.links.filter((link) => link.provider === "local");
    expect(locals.map((link) => link.principal)).toEqual([first.owner, first.owner]);
    expect(locals.every((link) => link.verifiedVia === "bootstrap")).toBe(true);
    // The readable subject is only in subjects.json; the row holds its keyed digest.
    expect(readFileSync(join(root, accessPaths().ledgers.links), "utf8")).not.toContain("maxs-mbp");
    expect(Object.values(read.snapshot.subjects.links).sort()).toEqual([
      "local:max@maxs-mbp",
      "local:max@maxs-mbp.local",
    ]);
    // Idempotent once linked.
    const before = counts(root);
    const again = ok(await ensureAccessSetUp(root, { localActor: "local:max@maxs-mbp" }));
    expect(again).toEqual(expect.objectContaining({ localPrincipal: first.owner, created: [] }));
    expect(counts(root)).toEqual(before);
    for (const other of ["local:eve@maxs-mbp", "local:maxi@maxs-mbp", "local:Max@elsewhere"]) {
      if (process.platform === "win32" && other === "local:Max@elsewhere") continue;
      const refused = ok(await ensureAccessSetUp(root, { localActor: other }));
      expect(refused.localPrincipal).toBeUndefined();
      expect(refused.created).toEqual([]);
    }
    expect(counts(root)).toEqual(before);
  });

  test("files are owner-only", async () => {
    if (process.platform === "win32") return; // Windows has no POSIX mode bits to check.
    const root = freshRoot();
    ok(await ensureAccessSetUp(root, { localActor: LOCAL }));
    expect(statSync(join(root, "access")).mode & 0o777).toBe(0o700);
    for (const rel of filesUnder(join(root, "access"))) {
      expect(`${rel} ${(statSync(join(root, "access", rel)).mode & 0o777).toString(8)}`).toBe(
        `${rel} 600`,
      );
    }
  });

  test("a raw local actor is refused before anything is created", async () => {
    const root = freshRoot();
    const done = await ensureAccessSetUp(root, { localActor: "max@laptop" });
    expect(done.ok).toBe(false);
    expect(filesUnder(root)).toEqual(["token"]);
  });
});

describe("loadAccessSnapshot over a Home nobody set up", () => {
  test("answers absent and leaves the tree byte-identical", () => {
    const root = freshRoot();
    const before = treeOf(root);
    expect(loadAccessSnapshot(root)).toEqual({ state: "absent" });
    expect(loadAccessSnapshot(join(root, "missing"))).toEqual({ state: "absent" });
    expect(treeOf(root)).toEqual(before);
  });

  test("a ledger line that cannot be read makes it unreadable, naming the file only", async () => {
    const root = freshRoot();
    ok(await ensureAccessSetUp(root, { localActor: LOCAL }));
    writeFileSync(join(root, accessPaths().ledgers.grants), "{not json SECRET-ISH}\n", {
      flag: "a",
    });
    const read = loadAccessSnapshot(root);
    if (read.state !== "unreadable") throw new Error(read.state);
    expect(read.reason).toContain("grants.jsonl");
    expect(read.reason).not.toContain("SECRET-ISH");
  });

  test("a row of the wrong shape, a bad subjects file or a bad revision makes it unreadable", async () => {
    for (const [rel, text] of [
      [accessPaths().ledgers.principals, `${JSON.stringify({ id: "prn_x", state: "active" })}\n`],
      [accessPaths().subjects, "[]"],
      [accessPaths().revision, '{"v":1,"epoch":-1,"at":"x"}'],
    ] as const) {
      const root = freshRoot();
      ok(await ensureAccessSetUp(root, { localActor: LOCAL }));
      writeFileSync(join(root, rel), text, { flag: rel.endsWith(".jsonl") ? "a" : "w" });
      const read = loadAccessSnapshot(root);
      expect(read.state).toBe("unreadable");
    }
  });
});

describe("localActorOf", () => {
  test("a plain identity", () => {
    expect(localActorOf({ username: "max", hostname: "Laptop.local" })).toBe(
      "local:max@laptop.local",
    );
  });

  test("a Windows user name with a space, and a host with an underscore", () => {
    const actor = localActorOf({ username: "Max Meier", hostname: "DESKTOP_01" });
    expect(actor).toBe("local:Max-Meier@desktop-01");
    expect(LOCAL_ACTOR_RE.test(actor)).toBe(true);
  });

  test("an over-long name and host are clamped to the grammar", () => {
    const actor = localActorOf({ username: "u".repeat(100), hostname: "h".repeat(300) });
    expect(LOCAL_ACTOR_RE.test(actor)).toBe(true);
    expect(actor).toBe(`local:${"u".repeat(64)}@${"h".repeat(253)}`);
  });

  test("characters outside each class become dashes, and empty parts get a name", () => {
    expect(localActorOf({ username: "zoë@home", hostname: "" })).toBe("local:zo--home@localhost");
    expect(localActorOf({ username: "", hostname: "box" })).toBe("local:user@box");
  });
});
