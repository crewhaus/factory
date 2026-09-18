/**
 * `crewhaus tools categories | show | search` — the navigation half of the
 * tools namespace. Every function under test is pure and takes its tool map
 * and category resolver as arguments, so these run against a fixture rather
 * than the real builtin set (which `tool-registry.test.ts` covers).
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  type ToolLike,
  buildCategoryRows,
  buildToolDetail,
  formatCategoryLines,
  formatSearchLines,
  formatToolDetailLines,
  inputFieldNames,
  nearestToolKeys,
  searchTools,
} from "./tools-cli";

const FIXTURE_CATEGORIES = {
  disk: { title: "Touch files on disk", tools: ["readIt", "writeIt"] },
  net: { title: "Reach the network", tools: ["fetchIt"] },
  everything: { title: "All of it", includes: ["disk", "net"] },
} as const;

function resolveFixture(name: string): ReadonlyArray<string> {
  const def = FIXTURE_CATEGORIES[name as keyof typeof FIXTURE_CATEGORIES];
  if (def === undefined) return [];
  if ("tools" in def) return [...def.tools];
  return def.includes.flatMap((c) => resolveFixture(c)).sort();
}

function catsFor(key: string): ReadonlyArray<string> {
  return Object.keys(FIXTURE_CATEGORIES).filter((c) => resolveFixture(c).includes(key));
}

const TOOL_MAP: Record<string, ToolLike> = {
  readIt: {
    name: "ReadIt",
    description: "Read a slice of a file from the workspace",
    readOnly: true,
    destructive: false,
    scope: "internal",
    requiresSandbox: false,
    concurrencySafe: true,
    inputSchema: z.object({ path: z.string(), offset: z.number().optional() }),
  },
  writeIt: {
    name: "WriteIt",
    description: "Write bytes to a file, replacing what is there",
    readOnly: false,
    destructive: true,
    scope: "internal",
    requiresSandbox: false,
    requireJustification: true,
    inputSchema: z.object({ path: z.string(), content: z.string() }),
  },
  fetchIt: {
    name: "FetchIt",
    description: "Make an HTTP request to an allow-listed origin",
    readOnly: true,
    destructive: false,
    scope: "external",
    ioCapability: "network",
    requiresSandbox: false,
    jsonSchema: { type: "object", properties: { url: {}, method: {} } },
  },
};

describe("buildCategoryRows", () => {
  test("a leaf reports its own tools", () => {
    const rows = buildCategoryRows(FIXTURE_CATEGORIES, resolveFixture);
    const disk = rows.find((r) => r.name === "disk");
    expect(disk?.kind).toBe("leaf");
    expect(disk?.selector).toBe("all-disk");
    expect(disk?.tools).toEqual(["readIt", "writeIt"]);
  });

  test("a roll-up resolves transitively and names its parts", () => {
    const rows = buildCategoryRows(FIXTURE_CATEGORIES, resolveFixture);
    const all = rows.find((r) => r.name === "everything");
    expect(all?.kind).toBe("roll-up");
    expect(all?.tools).toEqual(["fetchIt", "readIt", "writeIt"]);
    expect(all?.includes).toEqual(["disk", "net"]);
  });

  test("leaves come before roll-ups", () => {
    const kinds = buildCategoryRows(FIXTURE_CATEGORIES, resolveFixture).map((r) => r.kind);
    expect(kinds).toEqual(["leaf", "leaf", "roll-up"]);
  });
});

describe("formatCategoryLines", () => {
  const lines = formatCategoryLines(buildCategoryRows(FIXTURE_CATEGORIES, resolveFixture));
  const text = lines.join("\n");

  test("shows the selector and the count", () => {
    expect(text).toContain("all-disk  (2)");
  });

  test("lists a leaf's tools so the reader need not run a second command", () => {
    expect(text).toContain("readIt, writeIt");
  });

  test("shows a roll-up as the sum of its parts", () => {
    expect(text).toContain("all-disk + all-net");
  });

  test("ends with a usage line showing the exclusion syntax", () => {
    expect(text).toContain("tools: [all-fs, -write]");
  });
});

describe("buildToolDetail", () => {
  test("projects flags, categories, and input fields", () => {
    const d = buildToolDetail("writeIt", TOOL_MAP, catsFor);
    expect(d?.name).toBe("WriteIt");
    expect(d?.destructive).toBe(true);
    expect(d?.requireJustification).toBe(true);
    expect(d?.categories).toEqual(["disk", "everything"]);
    expect(d?.inputFields).toEqual(["content", "path"]);
  });

  test("defaults the optional flags rather than leaving them undefined", () => {
    const d = buildToolDetail("fetchIt", TOOL_MAP, catsFor);
    expect(d?.requireJustification).toBe(false);
    expect(d?.concurrencySafe).toBe(false);
  });

  test("an unknown key returns undefined so the caller can suggest", () => {
    expect(buildToolDetail("nope", TOOL_MAP, catsFor)).toBeUndefined();
  });
});

describe("inputFieldNames", () => {
  test("reads a Zod object's shape", () => {
    expect(inputFieldNames(TOOL_MAP.readIt as ToolLike)).toEqual(["offset", "path"]);
  });

  test("prefers an authoritative JSON Schema when the tool carries one", () => {
    expect(inputFieldNames(TOOL_MAP.fetchIt as ToolLike)).toEqual(["method", "url"]);
  });

  test("degrades to an empty list rather than throwing on an exotic schema", () => {
    expect(inputFieldNames({ ...(TOOL_MAP.readIt as ToolLike), inputSchema: z.string() })).toEqual(
      [],
    );
    expect(inputFieldNames({ ...(TOOL_MAP.readIt as ToolLike), inputSchema: undefined })).toEqual(
      [],
    );
  });
});

describe("formatToolDetailLines", () => {
  const text = formatToolDetailLines(
    buildToolDetail("fetchIt", TOOL_MAP, catsFor) as NonNullable<
      ReturnType<typeof buildToolDetail>
    >,
  ).join("\n");

  test("names the external scope and io capability", () => {
    expect(text).toContain("external");
    expect(text).toContain("io:network");
  });

  test("shows the categories as selectors", () => {
    expect(text).toContain("all-net");
  });

  test("ends with a copy-pasteable enable line", () => {
    expect(text).toContain("tools: [fetchIt]");
  });
});

describe("searchTools", () => {
  test("an exact key match outranks a description match", () => {
    const hits = searchTools("writeIt", TOOL_MAP, catsFor);
    expect(hits[0]?.key).toBe("writeIt");
  });

  test("matches the description when the name does not", () => {
    const hits = searchTools("allow-listed", TOOL_MAP, catsFor);
    expect(hits.map((h) => h.key)).toEqual(["fetchIt"]);
    expect(hits[0]?.matchedOn).toContain("description");
  });

  test("a category name finds its members", () => {
    const hits = searchTools("disk", TOOL_MAP, catsFor);
    expect(hits.map((h) => h.key).sort()).toEqual(["readIt", "writeIt"]);
  });

  test("is case-insensitive", () => {
    expect(searchTools("WRITEIT", TOOL_MAP, catsFor)[0]?.key).toBe("writeIt");
  });

  test("a prefix beats a substring", () => {
    const hits = searchTools("read", TOOL_MAP, catsFor);
    expect(hits[0]?.key).toBe("readIt");
  });

  test("no match returns an empty list, not an error", () => {
    expect(searchTools("zzzz", TOOL_MAP, catsFor)).toEqual([]);
  });

  test("an empty query returns nothing rather than everything", () => {
    expect(searchTools("   ", TOOL_MAP, catsFor)).toEqual([]);
  });

  test("ties break on key so output is stable across runs", () => {
    const hits = searchTools("it", TOOL_MAP, catsFor);
    expect(searchTools("it", TOOL_MAP, catsFor)).toEqual(hits);
    // Equal scores must come out alphabetically. Group by score and check
    // each group, rather than the whole list — scores legitimately differ.
    const byScore = new Map<number, string[]>();
    for (const h of hits) byScore.set(h.score, [...(byScore.get(h.score) ?? []), h.key]);
    for (const group of byScore.values()) {
      expect(group).toEqual([...group].sort());
    }
    expect(hits.length).toBeGreaterThan(1);
  });
});

describe("formatSearchLines", () => {
  test("a miss points at the categories command", () => {
    expect(formatSearchLines("zzz", []).join("\n")).toContain("crewhaus tools categories");
  });

  test("a hit shows why it matched", () => {
    const hits = searchTools("allow-listed", TOOL_MAP, catsFor);
    expect(formatSearchLines("allow-listed", hits).join("\n")).toContain("[description]");
  });
});

describe("nearestToolKeys", () => {
  test("suggests a near-miss for a typo", () => {
    expect(nearestToolKeys("writ", Object.keys(TOOL_MAP))).toContain("writeIt");
  });

  test("returns nothing for a wholly unrelated string", () => {
    expect(nearestToolKeys("qqqq", Object.keys(TOOL_MAP))).toEqual([]);
  });

  test("respects the limit", () => {
    expect(nearestToolKeys("it", Object.keys(TOOL_MAP), 2).length).toBeLessThanOrEqual(2);
  });
});
