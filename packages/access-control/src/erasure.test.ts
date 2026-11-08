/** Removing a member or unlinking an account leaves no name or subject behind. */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { accessPaths } from "./paths";
import { homeFixture, ok, projectionPath, removeTempDirs, treeOf } from "./test-helpers";

afterAll(removeTempDirs);

/** Every file under `access/` and every projection, as `path: text`. */
function everything(home: Awaited<ReturnType<typeof homeFixture>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rel, text] of Object.entries(treeOf(join(home.root, "access"))))
    out[`access/${rel}`] = text;
  for (const h of home.harnesses) {
    try {
      out[`${h.name}/approvers.json`] = readFileSync(projectionPath(h), "utf8");
    } catch {
      // Not governed: no file.
    }
  }
  return out;
}

function holding(files: Record<string, string>, needle: string): string[] {
  return Object.entries(files)
    .filter(([, text]) => text.includes(needle))
    .map(([path]) => path);
}

describe("revoke --member", () => {
  test("erases the name and every linked subject, keeps subjectRef and a tombstone", async () => {
    const home = await homeFixture({ harnesses: [[]] });
    const [h] = home.harnesses;
    if (h === undefined) throw new Error("no harness");
    const NAME = "Anastasia Quill";
    const SLACK = "slack:T0ERASE:U0ERASE";
    const GITHUB = "github:4242424242";
    const ana = ok(
      await home.access.grant(home.actor, {
        member: NAME,
        create: true,
        role: "operator",
        scope: `harness:${h.id}`,
      }),
    );
    ok(await home.access.link(home.actor, { subject: SLACK, member: NAME }));
    ok(await home.access.link(home.actor, { subject: GITHUB, member: NAME }));
    const before = everything(home);
    // The control: before removal, the scan finds the name, the subject and the principal.
    expect(holding(before, NAME)).toEqual(["access/subjects.json"]);
    expect(holding(before, SLACK).sort()).toEqual(["access/subjects.json", "h0/approvers.json"]);
    expect(holding(before, ana.principal).length).toBeGreaterThan(2);
    const removed = ok(await home.access.removeMember(home.actor, NAME));
    expect(removed.revoked).toEqual({ grants: 1, tokens: 0, links: 2 });
    const after = everything(home);
    expect(holding(after, NAME)).toEqual([]);
    expect(holding(after, SLACK)).toEqual([]);
    expect(holding(after, GITHUB)).toEqual([]);
    expect(holding(after, "T0ERASE")).toEqual([]);
    const links = readFileSync(join(home.root, accessPaths().ledgers.links), "utf8");
    expect(links).toContain('"subjectRef"');
    const snapshot = home.snapshot();
    expect(snapshot.principals.find((row) => row.id === ana.principal)?.state).toBe("removed");
    expect(
      snapshot.links
        .filter((row) => row.principal === ana.principal)
        .every((row) => row.state === "revoked"),
    ).toBe(true);
    expect(snapshot.grants.find((row) => row.principal === ana.principal)?.state).toBe("revoked");
    // The projection no longer lists them.
    expect(JSON.stringify(JSON.parse(after["h0/approvers.json"] as string))).not.toContain(
      ana.principal,
    );
  });

  test("a removed service loses its tokens", async () => {
    const home = await homeFixture();
    const ci = ok(
      await home.access.mintServiceToken(home.actor, {
        service: "ci-bot",
        permissions: ["home.read"],
        harnesses: [],
      }),
    );
    const done = ok(await home.access.removeMember(home.actor, "ci-bot"));
    expect(done.revoked.tokens).toBe(1);
    expect(home.snapshot().tokens.find((row) => row.principal === ci.principal)?.state).toBe(
      "revoked",
    );
    expect(holding(everything(home), "ci-bot")).toEqual([]);
  });
});

describe("unlink", () => {
  test("by subject or by id: the subject leaves every file, the link keeps its subjectRef", async () => {
    const home = await homeFixture({ harnesses: [[]] });
    const SLACK = "slack:T1UNLINK:U1UNLINK";
    const SECOND = "slack:T2UNLINK:U2UNLINK";
    ok(await home.access.link(home.actor, { subject: SLACK, member: home.owner }));
    const second = ok(await home.access.link(home.actor, { subject: SECOND, member: home.owner }));
    expect(holding(everything(home), SLACK).sort()).toEqual([
      "access/subjects.json",
      "h0/approvers.json",
    ]);
    ok(await home.access.unlink(home.actor, SLACK));
    ok(await home.access.unlink(home.actor, second.link.id));
    const after = everything(home);
    expect(holding(after, SLACK)).toEqual([]);
    expect(holding(after, SECOND)).toEqual([]);
    expect(
      home
        .snapshot()
        .links.filter((row) => row.provider === "slack")
        .map((row) => row.state),
    ).toEqual(["revoked", "revoked"]);
  });

  test("a subject already linked is refused naming who holds it; the owner's own local link stays", async () => {
    const home = await homeFixture();
    ok(await home.access.link(home.actor, { subject: "slack:T0:U0", member: "Ana", create: true }));
    const again = await home.access.link(home.actor, {
      subject: "slack:T0:U0",
      member: home.owner,
    });
    expect(again).toEqual(expect.objectContaining({ ok: false, code: "conflict" }));
    if (!again.ok) expect(again.reason).toContain("Ana");
    const local = home.snapshot().links.find((row) => row.provider === "local");
    const refused = await home.access.unlink(home.actor, local?.id as string);
    expect(refused).toEqual(expect.objectContaining({ ok: false, code: "home-owner" }));
  });

  test("a local subject is never linked here", async () => {
    const home = await homeFixture();
    const answer = await home.access.link(home.actor, {
      subject: "local:eve@laptop",
      member: home.owner,
    });
    expect(answer).toEqual(expect.objectContaining({ ok: false, code: "invalid" }));
  });
});
