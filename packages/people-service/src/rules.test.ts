/**
 * The rules a profile obeys, each refusal asserted by its reason: sensitive notes need the
 * owner's keep, special ones are only stated, a profile about someone else needs a basis
 * and holds no special note yet, a rejected note stays out until reopened, and a kind
 * never changes.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mintId } from "@crewhaus/control-contract";
import type { PeopleAdmin } from "./admin";
import { fixture, ok, removeTempDirs } from "./test-helpers";

afterAll(removeTempDirs);

async function me(admin: PeopleAdmin): Promise<string> {
  return ok(await admin.createPerson({ kind: "personal", label: "Sam" })).person;
}

describe("sensitivity", () => {
  test("an inferred special note is refused, and nothing is written", async () => {
    const { admin } = await fixture();
    const psn = await me(admin);
    const answer = await admin.addClaim(psn, {
      area: "health",
      type: "health",
      value: "Has a migraine condition.",
      acquisition: "inferred",
    });
    expect(answer).toEqual(
      expect.objectContaining({ ok: false, code: "invalid", reason: "special-needs-stated" }),
    );
    expect(ok(await admin.listClaims(psn))).toEqual([]);
  });

  test("a stated special note is proposed until the owner keeps it", async () => {
    const { admin } = await fixture();
    const psn = await me(admin);
    const added = ok(
      await admin.addClaim(psn, { area: "health", type: "health", value: "Gets migraines." }),
    );
    expect(added.state).toBe("proposed");
    const [note] = ok(await admin.listClaims(psn));
    expect(note?.sensitivity).toBe("special");
    expect(ok(await admin.reviewList(psn)).map((n) => n.id)).toEqual([added.claim]);
    ok(await admin.reviewClaim(added.claim, { verdict: "keep" }));
    const [kept] = ok(await admin.listClaims(psn));
    expect(kept).toEqual(
      expect.objectContaining({ state: "active", confirmedBy: "owner", rev: 2 }),
    );
    expect(ok(await admin.reviewList(psn))).toEqual([]);
  });

  test("a health note declared ordinary is refused", async () => {
    const { admin } = await fixture();
    const psn = await me(admin);
    for (const type of ["health", "worldview"] as const) {
      const answer = await admin.addClaim(psn, {
        area: "health",
        type,
        value: "x",
        sensitivity: "ordinary",
      });
      expect(answer).toEqual(
        expect.objectContaining({
          ok: false,
          reason: "sensitivity",
          message: `A ${type} note is special by nature; it can't be kept as ordinary.`,
        }),
      );
    }
  });

  test("a sensitive note is never active without keep, even when its words change", async () => {
    const { admin } = await fixture();
    const psn = await me(admin);
    const added = ok(
      await admin.addClaim(psn, {
        area: "money",
        value: "Is saving for a house.",
        sensitivity: "sensitive",
      }),
    );
    expect(added.state).toBe("proposed");
    // The owner's own edit of a proposed note leaves it waiting for keep.
    const revised = ok(await admin.reviseClaim(added.claim, { value: "Is saving for a flat." }, 1));
    expect(revised).toEqual({ rev: 2, state: "proposed" });
    expect(ok(await admin.reviewList(psn)).map((n) => n.value)).toEqual(["Is saving for a flat."]);
    const ordinary = ok(
      await admin.addClaim(psn, { area: "money", value: "Likes round numbers." }),
    );
    expect(ordinary.state).toBe("active");
  });

  test("an off-limits area takes no note", async () => {
    const { admin } = await fixture();
    const psn = await me(admin);
    ok(await admin.updatePerson(psn, { offLimits: ["family"] }, 1));
    expect(await admin.addClaim(psn, { area: "family", value: "Has two sisters." })).toEqual(
      expect.objectContaining({ ok: false, reason: "off-limits" }),
    );
    ok(await admin.updatePerson(psn, { allow: ["family"] }, 2));
    expect(ok(await admin.addClaim(psn, { area: "family", value: "Has two sisters." })).state).toBe(
      "active",
    );
  });

  test("lengths, areas and purposes are held to their limits", async () => {
    const { admin } = await fixture();
    const psn = await me(admin);
    const cases: [Parameters<PeopleAdmin["addClaim"]>[1], string][] = [
      [{ area: "comm", value: "x".repeat(501) }, "value"],
      [{ area: "comm", value: "x", situation: "y".repeat(201) }, "situation"],
      [{ area: "Comm", value: "x" }, "area"],
      [{ area: "comm", value: "x", purposes: ["persuasion" as never] }, "purpose"],
    ];
    for (const [input, reason] of cases) {
      expect(await admin.addClaim(psn, input)).toEqual(
        expect.objectContaining({ ok: false, reason }),
      );
    }
    expect(ok(await admin.addClaim(psn, { area: "comm", value: "x".repeat(500) })).state).toBe(
      "active",
    );
  });
});

describe("someone else", () => {
  test("a personal profile about someone else needs a basis", async () => {
    const { admin } = await fixture();
    expect(
      await admin.createPerson({ kind: "personal", label: "Mum", describes: "someone-else" }),
    ).toEqual(expect.objectContaining({ ok: false, reason: "basis-required" }));
    const made = ok(
      await admin.createPerson({
        kind: "personal",
        label: "Mum",
        describes: "someone-else",
        basis: "custodian",
      }),
    );
    const view = ok(await admin.getPerson(made.person));
    expect(view).toEqual(
      expect.objectContaining({ describes: "someone-else", basis: "custodian", role: "custodian" }),
    );
  });

  test("a special note about someone else is refused with the consent reason", async () => {
    const { admin } = await fixture();
    const psn = ok(
      await admin.createPerson({
        kind: "personal",
        label: "Mum",
        describes: "someone-else",
        basis: "consent",
      }),
    ).person;
    expect(
      await admin.addClaim(psn, { area: "health", type: "health", value: "Diabetic." }),
    ).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "needs-consent",
        message:
          "A special note about someone else needs their recorded agreement, which can't be recorded yet.",
      }),
    );
    expect(ok(await admin.addClaim(psn, { area: "comm", value: "Prefers calls." })).state).toBe(
      "active",
    );
  });
});

describe("rejected notes", () => {
  test("a rejected value is refused in another spelling, naming reopen, until it is reopened", async () => {
    const { admin } = await fixture();
    const psn = await me(admin);
    const first = ok(await admin.addClaim(psn, { area: "comm", value: "Prefers email." }));
    ok(await admin.reviewClaim(first.claim, { verdict: "reject" }));
    const again = await admin.addClaim(psn, { area: "comm", value: "  PREFERS   email. " });
    expect(again).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "rejected-before",
        message: `You rejected this note before. To use it again: \`crewhaus people review ${first.claim} --as reopen\`.`,
      }),
    );
    // The same words in another area are another note.
    expect(ok(await admin.addClaim(psn, { area: "work", value: "Prefers email." })).state).toBe(
      "active",
    );
    ok(await admin.reviewClaim(first.claim, { verdict: "reopen" }));
    expect(ok(await admin.addClaim(psn, { area: "comm", value: "prefers email." })).state).toBe(
      "active",
    );
  });

  test("review moves follow the note's lifecycle", async () => {
    const { admin } = await fixture();
    const psn = await me(admin);
    const a = ok(
      await admin.addClaim(psn, { area: "comm", value: "A", purposes: ["drafting", "scheduling"] }),
    );
    const b = ok(await admin.addClaim(psn, { area: "comm", value: "B" }));
    expect(await admin.reviewClaim(a.claim, { verdict: "reopen" })).toEqual(
      expect.objectContaining({ ok: false, reason: "transition" }),
    );
    expect(
      await admin.reviewClaim(a.claim, { verdict: "narrow", purposes: ["communication"] }),
    ).toEqual(expect.objectContaining({ ok: false, reason: "narrow" }));
    ok(await admin.reviewClaim(a.claim, { verdict: "narrow", purposes: ["drafting"] }));
    ok(await admin.reviewClaim(a.claim, { verdict: "merge", into: b.claim }));
    const notes = ok(await admin.listClaims(psn));
    expect(notes.map((n) => n.id)).toEqual([b.claim]);
    expect(await admin.reviewClaim(a.claim, { verdict: "keep" })).toEqual(
      expect.objectContaining({ ok: false, reason: "transition" }),
    );
  });

  test("a stale edit is refused with the note as it stands", async () => {
    const { admin } = await fixture();
    const psn = await me(admin);
    const a = ok(await admin.addClaim(psn, { area: "comm", value: "one" }));
    ok(await admin.reviseClaim(a.claim, { value: "two" }, 1));
    const stale = await admin.reviseClaim(a.claim, { value: "three" }, 1);
    expect(stale).toEqual(
      expect.objectContaining({ ok: false, code: "conflict", reason: "stale_claim_revision" }),
    );
    expect(!stale.ok && (stale.current as { value: string; rev: number })).toEqual(
      expect.objectContaining({ value: "two", rev: 2 }),
    );
  });
});

describe("kinds", () => {
  test("a made-up persona's kind never changes", async () => {
    const { admin } = await fixture();
    const psn = ok(await admin.createPerson({ kind: "synthetic", label: "Pat" })).person;
    expect(await admin.updatePerson(psn, { kind: "personal" } as never, 1)).toEqual(
      expect.objectContaining({ ok: false, reason: "kind-fixed" }),
    );
    expect(ok(await admin.getPerson(psn))).toEqual(
      expect.objectContaining({ kind: "synthetic", synthetic: true }),
    );
    expect(await admin.createPerson({ kind: "synthetic", label: "Pat", basis: "survey" })).toEqual(
      expect.objectContaining({ ok: false, reason: "kind-fields" }),
    );
  });

  test("a group profile needs who, a basis and how much its people vary", async () => {
    const { admin } = await fixture();
    expect(
      await admin.createPerson({ kind: "audience", label: "Users", who: "Our users" }),
    ).toEqual(expect.objectContaining({ ok: false, reason: "basis-required" }));
    expect(
      await admin.createPerson({
        kind: "audience",
        label: "Users",
        who: "Our users",
        basis: "survey",
      }),
    ).toEqual(expect.objectContaining({ ok: false, reason: "variation" }));
    expect(
      await admin.createPerson({
        kind: "audience",
        label: "Users",
        basis: "survey",
        variation: "mixed",
      }),
    ).toEqual(expect.objectContaining({ ok: false, reason: "who" }));
    const made = ok(
      await admin.createPerson({
        kind: "audience",
        label: "Users",
        who: "Our users",
        basis: "survey",
        variation: "mixed",
        size: 40,
      }),
    );
    expect(ok(await admin.getPerson(made.person)).audience).toEqual({
      who: "Our users",
      basis: "survey",
      variation: "mixed",
      size: 40,
    });
  });

  test("only the person who set profiles up can add one here", async () => {
    const { as } = await fixture();
    expect(await as(mintId("prn")).createPerson({ kind: "personal", label: "x" })).toEqual(
      expect.objectContaining({ ok: false, code: "forbidden", reason: "space" }),
    );
  });
});
