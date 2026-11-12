/**
 * Export, `crewhaus.people.v1`: the preview's fingerprint is the written file's, sensitive
 * notes stay out unless asked for, a credential-shaped value is masked and counted, and an
 * existing file is never replaced without force.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "@crewhaus/people/vault";
import { fixture, ok, removeTempDirs } from "./test-helpers";

afterAll(removeTempDirs);

async function profile() {
  const f = await fixture();
  const psn = ok(await f.admin.createPerson({ kind: "personal", label: "Sam" })).person;
  ok(
    await f.admin.addClaim(psn, {
      area: "comm",
      value: "Prefers short updates.",
      purposes: ["communication"],
    }),
  );
  const secret = ok(
    await f.admin.addClaim(psn, { area: "money", value: "Has debt.", sensitivity: "sensitive" }),
  );
  ok(await f.admin.reviewClaim(secret.claim, { verdict: "keep" }));
  const plain = ok(await f.admin.addClaim(psn, { area: "comm", value: "Likes email." }));
  ok(await f.admin.reviewClaim(plain.claim, { verdict: "reject" }));
  const hidden = ok(
    await f.admin.addClaim(psn, {
      area: "money",
      value: "Owes a friend.",
      sensitivity: "sensitive",
    }),
  );
  ok(await f.admin.reviewClaim(hidden.claim, { verdict: "reject" }));
  return { ...f, psn };
}

describe("export", () => {
  test("the preview's sha256 is the written file's, and repeats while nothing changes", async () => {
    const { admin, psn, hangarRoot } = await profile();
    const preview = ok(await admin.previewExport(psn));
    expect(ok(await admin.previewExport(psn)).text).toBe(preview.text);
    const out = join(hangarRoot, "..", "sam.json");
    const written = ok(await admin.writeExport(psn, {}, { path: out }));
    const bytes = readFileSync(out);
    expect(await sha256Hex(new Uint8Array(bytes))).toBe(preview.preview.sha256);
    expect(written.preview.sha256).toBe(preview.preview.sha256);
    expect(bytes.length).toBe(preview.preview.bytes);
    if (process.platform !== "win32") expect(statSync(out).mode & 0o777).toBe(0o600);
    // Writing an export records it, and the next preview is still the same file.
    expect(ok(await admin.previewExport(psn)).preview.sha256).toBe(preview.preview.sha256);
  });

  test("sensitive notes and rejected sensitive notes are out by default, and in when asked", async () => {
    const { admin, psn } = await profile();
    const plain = ok(await admin.previewExport(psn));
    const doc = JSON.parse(plain.text) as {
      format: string;
      notes: { value: string }[];
      rejected: { value: string; state: string }[];
    };
    expect(doc.format).toBe("crewhaus.people.v1");
    expect(doc.notes.map((n) => n.value)).toEqual(["Prefers short updates."]);
    expect(doc.rejected).toEqual([
      expect.objectContaining({ value: "Likes email.", state: "rejected" }),
    ]);
    expect(plain.preview.counts).toEqual({ notes: 1, rejected: 1, masked: 0, leftOut: 2 });
    const all = JSON.parse(
      ok(await admin.previewExport(psn, { includeSensitive: true })).text,
    ) as typeof doc;
    expect(all.notes.map((n) => n.value).sort()).toEqual(["Has debt.", "Prefers short updates."]);
    expect(all.rejected.map((n) => n.value).sort()).toEqual(["Likes email.", "Owes a friend."]);
    const none = ok(await admin.previewExport(psn, { includeRejected: false }));
    expect(JSON.parse(none.text).rejected).toEqual([]);
    const area = ok(await admin.previewExport(psn, { areas: ["money"], includeSensitive: true }));
    expect(area.preview.counts.notes).toBe(1);
    const purpose = ok(await admin.previewExport(psn, { purposes: ["communication"] }));
    expect(JSON.parse(purpose.text).notes.map((n: { value: string }) => n.value)).toEqual([
      "Prefers short updates.",
    ]);
  });

  test("a token-shaped value is masked in the file and counted in the preview", async () => {
    const { admin, psn } = await profile();
    const token = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
    ok(await admin.addClaim(psn, { area: "work", value: `Uses ${token} for the bot.` }));
    const built = ok(await admin.previewExport(psn));
    expect(built.text.includes(token)).toBe(false);
    expect(built.text).toContain("Uses *** for the bot.");
    expect(built.preview.counts.masked).toBe(1);
  });

  test("an existing file is refused without force, and nothing is recorded", async () => {
    const { admin, psn, hangarRoot, vault, receiptsNow } = await profile();
    const out = join(hangarRoot, "..", "taken.json");
    writeFileSync(out, "mine\n");
    const before = receiptsNow().length;
    const refused = await admin.writeExport(psn, {}, { path: out });
    expect(refused).toEqual(
      expect.objectContaining({ ok: false, code: "conflict", reason: "exists" }),
    );
    expect(readFileSync(out, "utf8")).toBe("mine\n");
    expect(vault.readExports(psn)).toEqual([]);
    expect(receiptsNow().length).toBe(before);
    ok(await admin.writeExport(psn, {}, { path: out, force: true }));
    expect(readFileSync(out, "utf8").startsWith("{")).toBe(true);
    expect(vault.readExports(psn)).toHaveLength(1);
  });

  test("a summary is written beside the file", async () => {
    const { admin, psn, hangarRoot } = await profile();
    const out = join(hangarRoot, "..", "with-summary.json");
    ok(await admin.writeExport(psn, { summary: true }, { path: out }));
    expect(existsSync(`${out}.txt`)).toBe(true);
    expect(readFileSync(`${out}.txt`, "utf8")).toContain("- [comm] Prefers short updates.");
  });
});
