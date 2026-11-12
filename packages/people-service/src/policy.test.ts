/**
 * Who may do what with a profile, over every people permission, and the one answer a
 * stranger gets: the same, byte for byte, as for a profile that does not exist.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { PERMISSIONS, mintId } from "@crewhaus/control-contract";
import type { IndexRow } from "@crewhaus/people/vault";
import { NOT_FOUND } from "./admin";
import { PERSON_PERMISSIONS, authorizePerson, authorizeSpace } from "./policy";
import { fixture, ok, removeTempDirs } from "./test-helpers";

afterAll(removeTempDirs);

const OWNER = mintId("prn");
const KEEPER = mintId("prn");
const VIEWER = mintId("prn");
const STRANGER = mintId("prn");
/** Owns the Home, and so every workspace role, but none of this profile. */
const HOME_OWNER = mintId("prn");

const row = (extra: Partial<IndexRow> = {}): IndexRow => ({
  person: mintId("psn"),
  kind: "personal",
  owner: OWNER,
  viewers: [VIEWER],
  rev: 1,
  state: "active",
  ...extra,
});

const PEOPLE = PERMISSIONS.filter((p) => p.startsWith("people."));

const allowed = (entry: IndexRow, who: string): string[] =>
  PEOPLE.filter((p) => authorizePerson(entry, who, p).allow);

describe("authorizePerson", () => {
  test("the owner holds every profile permission; the space permission is the space's", () => {
    expect(allowed(row(), OWNER)).toEqual([...PERSON_PERMISSIONS]);
    expect(PEOPLE.filter((p) => !(PERSON_PERMISSIONS as readonly string[]).includes(p))).toEqual([
      "people.space.use",
    ]);
  });

  test("a custodian holds all but what the basis withholds", () => {
    const contract = row({ custodian: KEEPER, basisKind: "contract" });
    expect(allowed(contract, KEEPER)).toEqual(
      PERSON_PERMISSIONS.filter((p) => p !== "people.export"),
    );
    expect(authorizePerson(contract, KEEPER, "people.export")).toEqual({ allow: false });
    expect(allowed(row({ custodian: KEEPER, basisKind: "consent" }), KEEPER)).not.toContain(
      "people.export",
    );
    expect(allowed(row({ custodian: KEEPER, basisKind: "custodian" }), KEEPER)).toEqual([
      ...PERSON_PERMISSIONS,
    ]);
    // A row whose basis it cannot name withholds export and erasure.
    expect(allowed(row({ custodian: KEEPER }), KEEPER)).toEqual(
      PERSON_PERMISSIONS.filter((p) => p !== "people.export" && p !== "people.erase"),
    );
  });

  test("a named viewer reads, and only reads", () => {
    expect(allowed(row(), VIEWER)).toEqual(["people.person.read"]);
  });

  test("a stranger and a Home owner who is not the profile's owner hold nothing", () => {
    expect(allowed(row(), STRANGER)).toEqual([]);
    expect(allowed(row(), HOME_OWNER)).toEqual([]);
    expect(authorizePerson(row(), OWNER, "h.read").allow).toBe(false);
  });

  test("only the space's owner may add a profile", () => {
    expect(authorizeSpace({ owner: OWNER }, OWNER, "people.space.use")).toBe(true);
    expect(authorizeSpace({ owner: OWNER }, STRANGER, "people.space.use")).toBe(false);
    expect(authorizeSpace({ owner: OWNER }, OWNER, "people.person.read")).toBe(false);
  });
});

describe("through the admin", () => {
  test("a stranger's refusal equals the absent profile's, byte for byte, for every verb", async () => {
    const { admin, as } = await fixture();
    const psn = ok(await admin.createPerson({ kind: "personal", label: "Sam" })).person;
    const pcl = ok(await admin.addClaim(psn, { area: "comm", value: "Short updates." })).claim;
    const stranger = as(STRANGER);
    const absent = mintId("psn");
    const absentNote = mintId("pcl");
    const pairs: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
      ["show", () => stranger.getPerson(psn), () => stranger.getPerson(absent)],
      ["notes", () => stranger.listClaims(psn), () => stranger.listClaims(absent)],
      ["review", () => stranger.reviewList(psn), () => stranger.reviewList(absent)],
      [
        "update",
        () => stranger.updatePerson(psn, {}, 1),
        () => stranger.updatePerson(absent, {}, 1),
      ],
      [
        "note",
        () => stranger.addClaim(psn, { area: "comm", value: "x" }),
        () => stranger.addClaim(absent, { area: "comm", value: "x" }),
      ],
      [
        "edit",
        () => stranger.reviseClaim(pcl, { value: "x" }, 1),
        () => stranger.reviseClaim(absentNote, { value: "x" }, 1),
      ],
      [
        "keep",
        () => stranger.reviewClaim(pcl, { verdict: "keep" }),
        () => stranger.reviewClaim(absentNote, { verdict: "keep" }),
      ],
      ["preview", () => stranger.previewExport(psn), () => stranger.previewExport(absent)],
      ["export", () => stranger.writeExport(psn), () => stranger.writeExport(absent)],
      ["activity", () => stranger.activity(psn), () => stranger.activity(absent)],
      ["plan", () => stranger.planErasure(psn), () => stranger.planErasure(absent)],
      [
        "erase",
        () => stranger.runErasure(psn, { nonce: "1.a", confirm: "Sam" }),
        () => stranger.runErasure(absent, { nonce: "1.a", confirm: "Sam" }),
      ],
    ];
    for (const [name, real, missing] of pairs) {
      const a = JSON.stringify(await real());
      const b = JSON.stringify(await missing());
      expect(`${name}: ${a}`).toBe(`${name}: ${b}`);
      expect(a).toBe(JSON.stringify(NOT_FOUND));
    }
    expect(ok(await stranger.listPersons())).toEqual([]);
  });

  test("a viewer the owner names sees the profile in the list and reads it, and nothing more", async () => {
    const { admin, as } = await fixture();
    const psn = ok(await admin.createPerson({ kind: "personal", label: "Sam" })).person;
    ok(await admin.updatePerson(psn, { viewers: [VIEWER] }, 1));
    const viewer = as(VIEWER);
    expect(ok(await viewer.listPersons()).map((r) => [r.person, r.role])).toEqual([
      [psn, "viewer"],
    ]);
    expect(ok(await viewer.getPerson(psn)).label).toBe("Sam");
    expect(await viewer.addClaim(psn, { area: "comm", value: "x" })).toEqual(NOT_FOUND);
    expect(await viewer.previewExport(psn)).toEqual(NOT_FOUND);
  });
});
