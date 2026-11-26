import { describe, expect, test } from "bun:test";
import { isCredentialKey } from "@crewhaus/spec-patch";
import { SESSION_ID_PATTERN } from "./ids.js";
import { mintId, parseRef } from "./index.js";
import {
  ERASURE_STORES,
  type ErasureGrant,
  type ErasureScope,
  KNOWLEDGE_ID_MAX_LENGTH,
  KNOWLEDGE_ID_PATTERN,
  KNOWLEDGE_LIFECYCLES,
  KNOWLEDGE_STORES,
  type KnowledgeIdParts,
  type KnowledgeItem,
  type KnowledgeRunUsage,
  type KnowledgeStore,
  RECORD_STORE_OF,
  erasureTargets,
  formatKnowledgeId,
  knowledgeStoreOf,
  parseKnowledgeId,
  qualifiedKnowledgeId,
  unversionedKnowledgeId,
} from "./knowledge.js";
import { SEARCH_KINDS, type SearchPage } from "./search.js";

const HRN = "hrn_0123456789abcdef";
const SESS = "sess_0123456789abcdef";
const HEX16 = "0123456789abcdef";

/** One id per store and local-id form, as the store that mints it spells it. */
const LOCAL_IDS: readonly (readonly [KnowledgeStore, string])[] = [
  ["facts", `mem_${HEX16}`],
  ["wiki", "billing-faq"],
  ["wiki", "0a"],
  ["plans", "plan-0001"],
  ["goals", "goal-0012"],
  ["focus", "focus"],
  ["requirements", "REQ-001"],
  ["requirements", "REQ-1204"],
  ["sessions", SESS],
  ["lessons", `l${HEX16}`],
  ["suggestions", "w.support-assistant"],
  ["suggestions", `d.${HEX16}`],
  ["datasets", "golden_v2.1"],
  ["documents", "a1b2c3d4e5f6"],
  ["records", "665f1c2e9b1d4a0012abcdef"],
  ["tasks", "665f1c2e9b1d4a0012abcdef"],
  ["goals", "665f1c2e9b1d4a0012abcdef"],
  ["shared", `h${HEX16}`],
];

const PARTITIONS: readonly (string | undefined)[] = [
  undefined,
  `s.${SESS}`,
  "t.acme_1",
  "c",
  "c.research-notes",
  "r.writer",
  "r.writer.research-notes",
];

const VERSIONS: readonly (number | string | undefined)[] = [
  undefined,
  0,
  7,
  123_456_789,
  "a1b2c3d4",
  "0123456789abcdef",
  "00000007",
];

describe("the item id", () => {
  test("every store's ids round-trip with every partition and version form", () => {
    let seen = 0;
    for (const [store, localId] of LOCAL_IDS) {
      for (const partition of PARTITIONS) {
        for (const version of VERSIONS) {
          const parts: KnowledgeIdParts = {
            store,
            spec: "support.bot-2",
            ...(partition !== undefined ? { partition } : {}),
            localId,
            ...(version !== undefined ? { version } : {}),
          };
          const id = formatKnowledgeId(parts);
          if (id === undefined) throw new Error(`refused: ${JSON.stringify(parts)}`);
          expect(parseKnowledgeId(id)).toEqual(parts);
          const qualified = qualifiedKnowledgeId(HRN, id);
          expect(qualified).toBe(`${HRN}/knowledge/${id}`);
          expect(parseRef(qualified)).toEqual({ scope: HRN, kind: "knowledge", id });
          seen += 1;
        }
      }
    }
    expect(seen).toBe(LOCAL_IDS.length * PARTITIONS.length * VERSIONS.length);
    expect(new Set(LOCAL_IDS.map(([store]) => store))).toEqual(new Set(KNOWLEDGE_STORES));
  });

  test("an item of no one spec, and an id without its version", () => {
    const id = formatKnowledgeId({ store: "documents", spec: "-", localId: "a1b2c3d4e5f6" });
    expect(id).toBe("documents~-~-~a1b2c3d4e5f6");
    expect(unversionedKnowledgeId(`${id}@3`)).toBe(id as string);
    expect(unversionedKnowledgeId(id as string)).toBe(id as string);
  });

  const good: KnowledgeIdParts = { store: "facts", spec: "bot", localId: `mem_${HEX16}` };
  const bad: readonly (readonly [string, Partial<Record<keyof KnowledgeIdParts, unknown>>])[] = [
    ["an unknown store", { store: "secrets" }],
    ["a singular store", { store: "fact" }],
    ["an empty spec", { spec: "" }],
    ["a spec with a space", { spec: "a b" }],
    ["a spec with a separator", { spec: "a~b" }],
    ["a spec past 128 characters", { spec: "a".repeat(129) }],
    ["an empty partition", { partition: "" }],
    ["a session partition that is not a session", { partition: "s.sess_xyz" }],
    ["a tenant that is not one", { partition: "t.-acme" }],
    ["a partition of no kind", { partition: "x.1" }],
    ["a role with a dot too many", { partition: "r.a.b.c" }],
    ["another store's id", { localId: "billing-faq" }],
    ["an upper-case fact id", { localId: `mem_${HEX16.toUpperCase()}` }],
    ["an id with a path", { localId: `../mem_${HEX16}` }],
    ["a negative version", { version: -1 }],
    ["a fractional version", { version: 1.5 }],
    ["a version with a leading zero", { version: "007" }],
    ["a version that is not hex", { version: "nothexhex" }],
    ["a revision too long", { version: "a".repeat(17) }],
  ];
  for (const [name, part] of bad) {
    test(`refused: ${name}`, () => {
      const parts = { ...good, ...part } as KnowledgeIdParts;
      expect(formatKnowledgeId(parts)).toBeUndefined();
      const text = `${parts.store}~${parts.spec}~${parts.partition ?? "-"}~${parts.localId}${parts.version !== undefined ? `@${parts.version}` : ""}`;
      expect(parseKnowledgeId(text)).toBeUndefined();
    });
  }

  test("refused: what is not text, whitespace, and a missing segment", () => {
    const id = formatKnowledgeId(good) as string;
    for (const value of [undefined, 7, null, "", `${id} `, `${id}\n`, `\n${id}`, "facts~bot~-"]) {
      expect(parseKnowledgeId(value)).toBeUndefined();
    }
    expect(parseKnowledgeId(id)).toEqual(good);
  });

  test("an id at the cap is addressable and one past it is not", () => {
    const at = (n: number) => ({
      store: "wiki" as const,
      spec: "s".repeat(64),
      localId: "a".repeat(n - "wiki~~-~".length - 64),
    });
    const id = formatKnowledgeId(at(KNOWLEDGE_ID_MAX_LENGTH));
    expect(id?.length).toBe(KNOWLEDGE_ID_MAX_LENGTH);
    expect(qualifiedKnowledgeId(HRN, id as string)?.length).toBe(200);
    expect("error" in parseRef(qualifiedKnowledgeId(HRN, id as string))).toBe(false);
    expect(formatKnowledgeId(at(KNOWLEDGE_ID_MAX_LENGTH + 1))).toBeUndefined();
    expect(qualifiedKnowledgeId(HRN, `${id}a`)).toBeUndefined();
    expect(parseRef(`${HRN}/knowledge/${id}a`)).toEqual({ error: "too-long" });
  });

  test("a qualified id needs a harness id", () => {
    const id = formatKnowledgeId(good) as string;
    expect(qualifiedKnowledgeId("home", id)).toBeUndefined();
    expect(qualifiedKnowledgeId("hrn_short", id)).toBeUndefined();
    expect(qualifiedKnowledgeId(mintId("prn"), id)).toBeUndefined();
  });

  test("the session shape it spells is the ids module's", () => {
    expect(KNOWLEDGE_ID_PATTERN).toContain(`~${SESSION_ID_PATTERN}`);
    expect(KNOWLEDGE_ID_PATTERN).toContain(`s\\.${SESSION_ID_PATTERN}`);
  });
});

describe("store words", () => {
  test("a run record's word and an item id's store map both ways", () => {
    const words = Object.entries(RECORD_STORE_OF);
    expect(words).toHaveLength(7);
    for (const [store, word] of words) {
      expect(knowledgeStoreOf(word)).toBe(store as KnowledgeStore);
      expect(KNOWLEDGE_STORES).toContain(store as KnowledgeStore);
    }
    expect(knowledgeStoreOf("facts")).toBeUndefined();
    expect(knowledgeStoreOf("toString")).toBeUndefined();
    expect(knowledgeStoreOf(undefined)).toBeUndefined();
  });

  test("a search finds every store and the objects around a harness", () => {
    for (const store of KNOWLEDGE_STORES) expect(SEARCH_KINDS).toContain(store);
    expect(SEARCH_KINDS).toContain("work");
    expect(SEARCH_KINDS).toContain("criterion");
    expect(new Set(KNOWLEDGE_LIFECYCLES).size).toBe(7);
  });
});

describe("a grant names its targets per store and root", () => {
  const scope = (over: Partial<ErasureScope>): ErasureScope => ({
    store: "memory",
    root: "/h/.crewhaus/memories",
    spec: "bot",
    targets: [`mem_${HEX16}`],
    ...over,
  });
  const grant = (...scopes: ErasureScope[]): ErasureGrant => ({
    nonce: "n",
    digest: "d",
    scopes,
  });
  const at = (root: string) => (given: string) => given === root;

  test("only a scope of the same store, spec and root answers", () => {
    const g = grant(
      scope({}),
      scope({ spec: "other", targets: ["mem_ffffffffffffffff"] }),
      scope({ store: "wiki", targets: ["faq"] }),
    );
    const ask = (store: ErasureScope["store"], spec: string | undefined, root: string) =>
      erasureTargets(g, {
        store,
        ...(spec !== undefined ? { spec } : {}),
        sameRoot: at(root),
      });
    expect([...(ask("memory", "bot", "/h/.crewhaus/memories") ?? [])]).toEqual([`mem_${HEX16}`]);
    expect(ask("memory", "bot", "/other/.crewhaus/memories")).toBeUndefined();
    expect(ask("memory", undefined, "/h/.crewhaus/memories")).toBeUndefined();
    expect(ask("continuity", "bot", "/h/.crewhaus/memories")).toBeUndefined();
    expect([...(ask("wiki", "bot", "/h/.crewhaus/memories") ?? [])]).toEqual(["faq"]);
  });

  test("two scopes of one store are read together", () => {
    const g = grant(scope({}), scope({ targets: ["mem_ffffffffffffffff"] }));
    const targets = erasureTargets(g, {
      store: "memory",
      spec: "bot",
      sameRoot: at("/h/.crewhaus/memories"),
    });
    expect(targets?.size).toBe(2);
    expect(new Set(ERASURE_STORES).size).toBe(ERASURE_STORES.length);
  });
});

// ---------------------------------------------------------------------------
// Field names
// ---------------------------------------------------------------------------

/** Every key of a sample at any depth, the free-form keys of `facets` aside. */
function keysOf(value: unknown, path: string, out: string[]): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) keysOf(entry, `${path}[]`, out);
    return out;
  }
  if (typeof value !== "object" || value === null) return out;
  for (const [key, entry] of Object.entries(value)) {
    out.push(`${path}.${key}`);
    keysOf(entry, `${path}.${key}`, out);
  }
  return out;
}

const ITEM = {
  v: 1,
  id: "facts~bot~-~mem_0123456789abcdef",
  ref: {
    harness: HRN,
    store: "facts",
    backend: "local",
    spec: "bot",
    partition: "-",
    localId: `mem_${HEX16}`,
    version: 1,
  } satisfies Required<KnowledgeItem["ref"]>,
  title: "t",
  preview: "p",
  scope: { kind: "session", id: SESS } satisfies Required<KnowledgeItem["scope"]>,
  lifecycle: "live",
  status: "draft",
  version: 1,
  versions: 2,
  createdAt: "2026-10-30T00:00:00.000Z",
  updatedAt: "2026-10-30T00:00:00.000Z",
  expiresAt: "2026-10-30T00:00:00.000Z",
  author: {
    kind: "agent",
    actor: "sys:runtime",
    session: SESS,
    agentIdentity: "writer",
    via: "remember",
    cmd: "cmd_1",
  } satisfies Required<KnowledgeItem["author"]>,
  origin: {
    kind: "conversation",
    session: SESS,
    toolUseIds: ["tu_1"],
    sources: ["docs/a.md"],
    fromHarness: "bot",
  } satisfies Required<KnowledgeItem["origin"]>,
  evidence: {
    status: "available",
    evictsAt: "2026-11-30T00:00:00.000Z",
    evictedAt: "2026-11-30T00:00:00.000Z",
  } satisfies Required<KnowledgeItem["evidence"]>,
  confidence: 0.5,
  verified: true,
  supersedes: "mem_0",
  supersededBy: "mem_1",
  correctionOf: "mem_2",
  tags: ["a"],
  category: "person",
  usage: { runs: 1, lastUsedAt: "2026-10-30T00:00:00.000Z", recorded: true } satisfies Required<
    NonNullable<KnowledgeItem["usage"]>
  >,
  freshness: { asOf: "2026-10-30T00:00:00.000Z", stale: false },
  operations: [
    { op: "correct", supported: true, reason: "r", cliTwin: null, needs: "n" } satisfies Required<
      KnowledgeItem["operations"][number]
    >,
  ],
} satisfies Required<KnowledgeItem>;

const PAGE = {
  items: [
    {
      kind: "facts",
      ref: `${HRN}/knowledge/${ITEM.id}`,
      title: "t",
      snippet: { text: "s", highlights: [[0, 1]] } satisfies Required<
        NonNullable<SearchPage["items"][number]["snippet"]>
      >,
      source: {
        harness: HRN,
        harnessName: "bot",
        store: "facts",
        backend: "local",
      } satisfies Required<SearchPage["items"][number]["source"]>,
      updatedAt: "2026-10-30T00:00:00.000Z",
      freshness: { asOf: "2026-10-30T00:00:00.000Z", stale: false },
      owner: { kind: "member", name: "Ana" } satisfies Required<
        NonNullable<SearchPage["items"][number]["owner"]>
      >,
      href: "/#/i/x",
    } satisfies Required<SearchPage["items"][number]>,
  ],
  next: "c",
  total: 1,
  facets: { kind: {}, harness: {}, status: {} },
  coverage: { kinds: ["facts"], namesOnly: [], thredz: "off" },
  empty: { reason: "no-data", remedy: "r" } satisfies Required<NonNullable<SearchPage["empty"]>>,
} satisfies Required<SearchPage>;

const USE = {
  state: "used",
  items: [
    {
      item: "0".repeat(32),
      store: "facts",
      backend: "local",
      id: ITEM.id,
      version: 1,
      via: "recall",
      status: "included",
      at: "2026-10-30T00:00:00.000Z",
    },
  ],
} satisfies KnowledgeRunUsage;

const GRANT = {
  nonce: "n",
  digest: "d",
  scopes: [{ store: "memory", root: "/r", spec: "s", targets: ["t"] }],
} satisfies ErasureGrant;

describe("field names survive the masker", () => {
  test("every field of an item, a page, a run's usage and a grant", () => {
    const names = [
      ...keysOf(ITEM, "item", []),
      ...keysOf(PAGE, "page", []),
      ...keysOf(USE, "use", []),
      ...keysOf(GRANT, "grant", []),
      ...keysOf({ state: "not-recorded", reason: "evicted" }, "use", []),
      ...KNOWLEDGE_STORES,
      ...SEARCH_KINDS,
    ];
    const hits = names.filter((path) => isCredentialKey(path.split(".").pop() as string));
    expect(hits).toEqual([]);
    expect(names.length).toBeGreaterThanOrEqual(110);
  });

  test("the walk sees a planted defect", () => {
    const planted = keysOf({ a: [{ apiToken: "x" }] }, "planted", []);
    expect(planted.filter((p) => isCredentialKey(p.split(".").pop() as string))).toEqual([
      "planted.a[].apiToken",
    ]);
  });
});
