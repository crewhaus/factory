/**
 * The Harnesses list groups by Group, Owner or Purpose. Owner and purpose come from
 * `harnesses.list`, merged into the registry's rows by id; a row with neither groups
 * under "No owner" and "No purpose". The command menu shows an owner only on a harness
 * row that has one.
 */
import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { omniRows } from "../assets/js/omnibox.js";
import {
  groupByOf,
  groupHarnesses,
  mergeOverviews,
  railGroupsModel,
  // @ts-expect-error — hand-written browser JS, typed as text for the embed map
} from "../assets/js/views/library-group.js";

const REGISTRY = [
  { id: "hrn_000000000000000a", specName: "support", groups: ["ops"] },
  { id: "hrn_000000000000000b", specName: "triage", groups: [] },
  { id: "hrn_000000000000000c", specName: "scratch", groups: [] },
];

// `harnesses.list` serves `owner` from the harness's approver projection (the v1
// harnesses handler's overview row), because `harness.json` has no owner: a harness with
// no projection has no `owner` field, and groups under "No owner".
const OVERVIEWS = [
  { id: "hrn_000000000000000a", owner: "prn_a", ownerLabel: "Ana" },
  { id: "hrn_000000000000000b", purpose: "Sort incoming tickets." },
  { id: "hrn_000000000000000c" },
];

type Bucket = { key: string; heading: string; rows: { id: string }[] };
const ids = (b: Bucket) => b.rows.map((r) => r.id);

describe("grouping the Harnesses list", () => {
  const merged = mergeOverviews(REGISTRY, OVERVIEWS);

  test("by owner: the owner's heading holds its harness, the rest are under No owner", () => {
    const buckets = groupHarnesses(merged, "owner") as Bucket[];
    expect(buckets.map((b) => b.heading)).toEqual(["Ana", "No owner"]);
    expect(buckets[0]?.key).toBe("prn_a");
    expect(ids(buckets[0] as Bucket)).toEqual(["hrn_000000000000000a"]);
    expect(ids(buckets[1] as Bucket)).toEqual(["hrn_000000000000000b", "hrn_000000000000000c"]);
  });

  test("by purpose: the declared purpose holds its harness, the rest are under No purpose", () => {
    const buckets = groupHarnesses(merged, "purpose") as Bucket[];
    expect(buckets.map((b) => b.heading)).toEqual(["Sort incoming tickets.", "No purpose"]);
    expect(ids(buckets[0] as Bucket)).toEqual(["hrn_000000000000000b"]);
    expect(ids(buckets[1] as Bucket)).toEqual(["hrn_000000000000000a", "hrn_000000000000000c"]);
  });

  test("by group: the registry's groups, and No group last", () => {
    const buckets = groupHarnesses(merged, "group") as Bucket[];
    expect(buckets.map((b) => b.heading)).toEqual(["ops", "No group"]);
  });

  test("the address chooses the grouping; anything else is by group", () => {
    expect(groupByOf({ query: { by: "owner" } })).toBe("owner");
    expect(groupByOf({ query: { by: "purpose" } })).toBe("purpose");
    expect(groupByOf({ query: { by: "nonsense" } })).toBe("group");
    expect(groupByOf(undefined)).toBe("group");
  });

  test("an owner with no display name heads its group by its id", () => {
    const buckets = groupHarnesses(
      mergeOverviews(REGISTRY.slice(0, 1), [{ id: "hrn_000000000000000a", owner: "prn_a" }]),
      "owner",
    ) as Bucket[];
    expect(buckets.map((b) => b.heading)).toEqual(["prn_a"]);
  });
});

describe("the command menu's harness rows", () => {
  test("only a harness with an owner shows one", () => {
    const rows = omniRows({
      entries: [
        {
          kind: "harness",
          id: "hrn_000000000000000a",
          title: "support",
          owner: "Ana",
          source: "support",
        },
        { kind: "harness", id: "hrn_000000000000000b", title: "triage", source: "triage" },
        { kind: "harness", id: "hrn_000000000000000c", title: "scratch", source: "scratch" },
      ],
      actions: [],
    }) as { owner: string | null }[];
    expect(rows.map((r) => r.owner)).toEqual(["Ana", null, null]);
  });
});

describe("owners or purposes that could not be read", () => {
  test("a failed read groups nothing under 'No owner' and says why", () => {
    for (const answer of [{ ok: false, status: 503 }, null]) {
      const model = railGroupsModel(REGISTRY, answer, "owner");
      expect(model.failed).toBe(true);
      expect(model.note).toBe("Owners couldn't be read. Showing all harnesses.");
      expect(model.buckets).toBeUndefined();
    }
    expect(railGroupsModel(REGISTRY, { ok: false }, "purpose").note).toBe(
      "Purposes couldn't be read. Showing all harnesses.",
    );
  });

  test("a whole read groups the rows; one read in part says so", () => {
    const whole = railGroupsModel(REGISTRY, { ok: true, body: { items: OVERVIEWS } }, "owner");
    expect(whole.failed).toBeUndefined();
    expect(whole.note).toBeUndefined();
    expect(whole.buckets.map((b: Bucket) => b.heading)).toEqual(["Ana", "No owner"]);
    const part = railGroupsModel(
      REGISTRY,
      { ok: true, body: { items: OVERVIEWS, truncated: { reason: "page_limit" } } },
      "owner",
    );
    expect(part.note).toBe("Owners of some harnesses weren't read.");
  });
});
