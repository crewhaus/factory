/**
 * The request-scope rules, as units: an item about people is withheld at any depth unless
 * the caller may see it; outside a request nothing is visible and nothing is allowed; and
 * Home's own background work, under its own name, reads every harness and writes nothing.
 */
import { describe, expect, test } from "bun:test";
import {
  PEOPLE_TOO_DEEP,
  PEOPLE_WALK_DEPTH,
  contentVisibleToRequest,
  currentRequestAccess,
  requestAllows,
  systemAccess,
  visibleToRequest,
  withRequestAccess,
  withholdPeople,
} from "./access";

const PERSON = "home/person/psn_01jc0000000000000000000001";
const HARNESS = "hrn_0123456789abcdef";

/** A caller whose `peopleAllowed` says no, and one whose says yes. */
const denied = systemAccess("people-test").peopleAllowed;
const allowed = (_item: Readonly<Record<string, unknown>>): boolean => true;

/** `inner`, wrapped in `levels` objects: with `levels` = d - 1, `inner` sits at depth d. */
function wrap(inner: Record<string, unknown>, levels: number): Record<string, unknown> {
  let out = inner;
  for (let i = 0; i < levels; i += 1) out = { n: out };
  return out;
}

/** The value at `levels` steps down `n` from the top. */
function unwrap(body: unknown, levels: number): Record<string, unknown> {
  let at = body as Record<string, unknown>;
  for (let i = 0; i < levels; i += 1) at = at["n"] as Record<string, unknown>;
  return at;
}

describe("an item about people, at any depth", () => {
  test("a nested item is withheld from a caller who may not see it, and kept for one who may", () => {
    const other = { untouched: [{ y: 2 }] };
    const body = {
      harnesses: [{ id: "a", feedback: [{ sensitivity: "people", ref: PERSON }, { x: 1 }] }],
      other,
    };
    const out = withholdPeople(body, denied) as Record<string, unknown>;
    expect(out).toEqual({
      harnesses: [{ id: "a", feedback: [{ x: 1 }] }],
      other: { untouched: [{ y: 2 }] },
      hidden: ["people"],
    });
    // A part with nothing withheld is the same object, not a copy.
    expect(out["other"]).toBe(other);
    // The answer it was given is not changed.
    expect(body.harnesses[0]?.feedback).toHaveLength(2);

    const kept = withholdPeople(body, allowed);
    expect(kept).toBe(body);
    expect((kept as Record<string, unknown>)["hidden"]).toBeUndefined();
  });

  test("a withheld item's contents are not read, and a kept item's are", () => {
    const seen: unknown[] = [];
    const inner = { sensitivity: "people", ref: `${PERSON}-inner` };
    const outer = { sensitivity: "people", ref: PERSON, items: [inner] };
    const record = (item: Readonly<Record<string, unknown>>): boolean => {
      seen.push(item["ref"]);
      return false;
    };
    expect(withholdPeople({ items: [outer] }, record)).toEqual({ items: [], hidden: ["people"] });
    expect(seen).toEqual([PERSON]);
    seen.length = 0;
    const keepOuter = (item: Readonly<Record<string, unknown>>): boolean => {
      seen.push(item["ref"]);
      return item["ref"] === PERSON;
    };
    expect(withholdPeople({ items: [outer] }, keepOuter)).toEqual({
      items: [{ sensitivity: "people", ref: PERSON, items: [] }],
      hidden: ["people"],
    });
    expect(seen).toEqual([PERSON, `${PERSON}-inner`]);
  });

  test("an item at the deepest level checked is withheld", () => {
    expect(PEOPLE_WALK_DEPTH).toBe(16);
    // The list sits at depth 15, so its items sit at depth 16.
    const body = wrap({ items: [{ sensitivity: "people", ref: PERSON }, { keep: 1 }] }, 13);
    const out = withholdPeople(body, denied) as Record<string, unknown>;
    expect(unwrap(out, 13)["items"]).toEqual([{ keep: 1 }]);
    expect(out["hidden"]).toEqual(["people"]);
  });

  test("a part deeper than the filter walks is checked whole: sent when it holds no one, withheld when it does", () => {
    // `{}` at depth 17, and a 20-deep part: neither holds an item about people.
    const deepPlain = wrap({}, 16);
    expect(withholdPeople(deepPlain, denied)).toBe(deepPlain);
    const twenty = { rows: [{ id: "r1", input: wrap({ leaf: 1 }, 19) }], open: 2 };
    expect(withholdPeople(twenty, denied)).toBe(twenty);
    expect(withholdPeople(twenty, allowed)).toBe(twenty);
    // A string that merely quotes the mark is not an item.
    const quoted = wrap({ note: '"sensitivity":"people"' }, 18);
    expect(withholdPeople(quoted, denied)).toBe(quoted);

    // An item about people past the cap: that part is withheld whole, for every caller,
    // and the rest of the answer is sent.
    for (const who of [denied, allowed]) {
      const sibling = { keep: [{ x: 1 }] };
      const body = { sibling, deep: wrap({ items: [{ sensitivity: "people", ref: PERSON }] }, 16) };
      const out = withholdPeople(body, who) as Record<string, unknown>;
      // `deep` sits at depth 2, so the container at depth 17 is the one withheld.
      expect(unwrap(out["deep"], 14)["n"]).toBe(PEOPLE_TOO_DEEP);
      expect(out["sibling"]).toBe(sibling);
      expect(out["hidden"]).toEqual(["people"]);
      expect(JSON.stringify(out)).not.toContain(PERSON);
      // The answer it was given is not changed.
      expect(JSON.stringify(body)).toContain(PERSON);
    }
    // A part that cannot be serialized counts as holding one.
    const odd = withholdPeople({ deep: wrap({ big: 1n }, 17) }, allowed) as Record<string, unknown>;
    expect(unwrap(odd["deep"], 14)["n"]).toBe(PEOPLE_TOO_DEEP);
    expect(odd["hidden"]).toEqual(["people"]);
    // A marked item in the deepest list walked is decided by the caller, not withheld whole.
    const marked = wrap({ items: [{ sensitivity: "people", ref: PERSON }, { k: 1 }] }, 14);
    expect(unwrap(withholdPeople(marked, denied), 14)["items"]).toEqual([{ k: 1 }]);
  });

  test("an unmarked answer is returned unchanged, the same object", () => {
    const body = wrap({ items: [{ x: 1 }, { y: "two" }], open: 2 }, 13);
    expect(withholdPeople(body, denied)).toBe(body);
    const flat = { items: [{ x: 1 }], open: 2 };
    expect(withholdPeople(flat, denied)).toBe(flat);
  });

  test("hidden names people once, beside what the answer already hid", () => {
    const body = { hidden: ["content"], items: [{ sensitivity: "people", ref: PERSON }] };
    expect(withholdPeople(body, denied)).toEqual({ hidden: ["content", "people"], items: [] });
  });
});

describe("outside a request", () => {
  test("nothing is visible and nothing is allowed", async () => {
    const seen = await new Promise<Record<string, unknown>>((resolve) => {
      setTimeout(
        () =>
          resolve({
            access: currentRequestAccess(),
            allows: requestAllows("h.read", HARNESS),
            home: requestAllows("home.read"),
            visible: visibleToRequest(HARNESS),
            content: contentVisibleToRequest(HARNESS),
          }),
        0,
      );
    });
    expect(seen).toEqual({
      access: undefined,
      allows: false,
      home: false,
      visible: false,
      content: false,
    });
  });

  test("Home's own background work reads every harness under its own name and is refused every write", async () => {
    const access = systemAccess("test");
    const seen = await withRequestAccess(
      access,
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          setTimeout(
            () =>
              resolve({
                principal: currentRequestAccess()?.caller.principal,
                read: requestAllows("h.read", HARNESS),
                content: requestAllows("h.read.content", HARNESS),
                home: requestAllows("home.read"),
                visible: visibleToRequest(HARNESS),
                contentVisible: contentVisibleToRequest(HARNESS),
                control: requestAllows("h.control", HARNESS),
                manage: requestAllows("home.registry.manage"),
                secrets: requestAllows("h.secrets.write", HARNESS),
              }),
            0,
          );
        }),
    );
    expect(seen).toEqual({
      principal: "sys:test",
      read: true,
      content: true,
      home: true,
      visible: true,
      contentVisible: true,
      control: false,
      manage: false,
      secrets: false,
    });
    // Never Home's own key, which acts as the owner.
    expect(access.caller.actor).toEqual({ principal: "sys:test" });
    expect(access.caller.via).toBe("system");
    expect(access.peopleAllowed({ sensitivity: "people", ref: PERSON })).toBe(false);
    expect(access.authorize("h.control", { harness: HARNESS })).toEqual({
      allow: false,
      needs: "h.control",
      role: null,
    });
  });
});
