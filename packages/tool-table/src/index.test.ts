import { afterEach, beforeEach, describe, expect, test } from "bun:test";
/**
 * Every tool this package registers, against real files in a temporary
 * workspace — reading from disk is the point, so the tests read from disk.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TABLE_TOOLS,
  contactNormalize,
  dataDriftCheck,
  fixedWidthParse,
  recordLinkage,
  tableDiff,
  tableProfile,
  tableReshape,
  tableShard,
} from "./index";

const originalCwd = process.cwd();
let workspace: string;

// biome-ignore lint/suspicious/noExplicitAny: the executor supplies this context, and none of these tools read it.
const ctx = {} as any;

async function raw(tool: (typeof TABLE_TOOLS)[number], input: unknown): Promise<string> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`schema rejected the input: ${parsed.error.message}`);
  return tool.execute(parsed.data, ctx);
}

async function call<T = Record<string, unknown>>(
  tool: (typeof TABLE_TOOLS)[number],
  input: unknown,
): Promise<T> {
  return JSON.parse(await raw(tool, input)) as T;
}

const write = (name: string, body: string): void => writeFileSync(join(workspace, name), body);

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "crewhaus-table-"));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

describe("package-wide contract", () => {
  test("every tool is exported in TABLE_TOOLS", () => {
    expect(TABLE_TOOLS.length).toBe(8);
  });

  test("names are unique and PascalCase", () => {
    const names = TABLE_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TABLE_TOOLS) expect(t.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("every tool is read-only and internal — this package reads, it never writes", () => {
    for (const t of TABLE_TOOLS) {
      expect({ name: t.name, readOnly: t.readOnly }).toEqual({ name: t.name, readOnly: true });
      expect({ name: t.name, destructive: t.destructive }).toEqual({
        name: t.name,
        destructive: false,
      });
      expect({ name: t.name, scope: t.scope }).toEqual({ name: t.name, scope: "internal" });
      expect({ name: t.name, io: t.ioCapability }).toEqual({ name: t.name, io: undefined });
    }
  });

  test("every description says what it is for, and every schema is strict", () => {
    for (const t of TABLE_TOOLS) {
      expect(t.description).toContain("Use it");
      expect({ name: t.name, ok: t.inputSchema.safeParse(42).success }).toEqual({
        name: t.name,
        ok: false,
      });
    }
  });

  test("a path outside the workspace is refused by every tool that reads one", async () => {
    write("ok.csv", "a\n1\n");
    await expect(raw(tableProfile, { file: "../escape.csv" })).rejects.toThrow(
      /escapes the workspace/,
    );
    await expect(
      raw(tableDiff, { before: "../e.csv", after: "ok.csv", key: ["a"] }),
    ).rejects.toThrow(/escapes the workspace/);
  });
});

describe("TableProfile", () => {
  beforeEach(() => {
    write("a.csv", "id,name,qty\n1,Alice,10\n2,Bob,20\n3,Carol,\n3,Carol,\n");
  });

  test("answers the shape of a file in one call", async () => {
    const result = await call<{
      rows: number;
      duplicateRows: number;
      columns: Array<{ name: string; type: string; nulls: number }>;
    }>(tableProfile, { file: "a.csv" });
    expect(result.rows).toBe(4);
    expect(result.duplicateRows).toBe(1);
    expect(result.columns.find((c) => c.name === "qty")).toMatchObject({
      type: "integer",
      nulls: 2,
    });
  });

  test("a TSV is detected from its extension", async () => {
    write("b.tsv", "id\tname\n1\tAlice\n");
    const result = await call<{ columns: Array<{ name: string }> }>(tableProfile, {
      file: "b.tsv",
    });
    expect(result.columns.map((c) => c.name)).toEqual(["id", "name"]);
  });

  test("asking for a column that is not there lists the ones that are", async () => {
    expect(await raw(tableProfile, { file: "a.csv", columns: ["nope"] })).toContain(
      "id, name, qty",
    );
  });

  test("quoted fields with commas and newlines survive", async () => {
    write("q.csv", 'id,note\n1,"a, b\nsecond line"\n');
    const result = await call<{ rows: number }>(tableProfile, { file: "q.csv" });
    expect(result.rows).toBe(1);
  });
});

describe("TableDiff", () => {
  beforeEach(() => {
    write("before.csv", "id,qty\n1,10\n2,20\n3,30\n");
    write("after.csv", "id,qty\n1,11\n2,20\n4,40\n");
  });

  test("reports the four counts and the cell that changed", async () => {
    const result = await call<{
      counts: Record<string, number>;
      changed: Array<{ changes: Array<{ column: string; from: string; to: string }> }>;
    }>(tableDiff, { before: "before.csv", after: "after.csv", key: ["id"] });
    expect(result.counts).toEqual({ added: 1, removed: 1, changed: 1, unchanged: 1 });
    expect(result.changed[0]?.changes[0]).toEqual({ column: "qty", from: "10", to: "11" });
  });

  test("a duplicate key is surfaced", async () => {
    write("dup.csv", "id,qty\n1,10\n1,99\n");
    const result = await call<{ duplicateKeys: Array<{ key: string; count: number }> }>(tableDiff, {
      before: "dup.csv",
      after: "after.csv",
      key: ["id"],
    });
    expect(result.duplicateKeys[0]).toMatchObject({ count: 2 });
  });

  test("a key column that does not exist is an error", async () => {
    await expect(
      raw(tableDiff, { before: "before.csv", after: "after.csv", key: ["nope"] }),
    ).rejects.toThrow(/not in the before table/);
  });
});

describe("RecordLinkage", () => {
  beforeEach(() => {
    write("l.csv", "email,name\nA.B+work@Gmail.com,Dr Jane Smith\n");
    write("r.csv", "email,name\nab@gmail.com,Smith Jane\n");
  });

  test("normalization turns a near-miss into a match, with evidence", async () => {
    const result = await call<{
      counts: Record<string, number>;
      matched: Array<{ score: number; evidence: Array<{ field: string }> }>;
    }>(recordLinkage, {
      left: "l.csv",
      right: "r.csv",
      rules: [{ field: "name", compare: "fuzzy", weight: 1, normalize: "name" }],
    });
    expect(result.counts.matched).toBe(1);
    expect(result.matched[0]?.evidence[0]?.field).toBe("name");
  });

  test("without normalization the same pair does not match, which is honest", async () => {
    const result = await call<{ counts: Record<string, number> }>(recordLinkage, {
      left: "l.csv",
      right: "r.csv",
      rules: [{ field: "name", compare: "fuzzy", weight: 1 }],
    });
    expect(result.counts.matched).toBe(0);
  });

  test("a rule naming a column that is not in both files says which columns exist", async () => {
    const out = await raw(recordLinkage, {
      left: "l.csv",
      right: "r.csv",
      rules: [{ field: "phone", compare: "exact", weight: 1 }],
    });
    expect(out).toContain("email, name");
  });
});

describe("ContactNormalize", () => {
  test("canonicalizes and explains every fold", async () => {
    const result = await call<{
      contacts: Array<{ email: string; nameKey: string; notes: string[] }>;
    }>(contactNormalize, {
      contacts: [{ email: "A.B+work@Gmail.com", name: "Dr Jane Smith", company: "Acme Ltd." }],
    });
    expect(result.contacts[0]).toMatchObject({ email: "ab@gmail.com", nameKey: "jane smith" });
    expect(result.contacts[0]?.notes.length).toBeGreaterThan(0);
  });
});

describe("TableReshape", () => {
  test("wide to long melts the columns not named as identifiers", async () => {
    write("w.csv", "region,jan,feb\nN,10,20\nS,30,\n");
    const result = await call<{ rowCount: number; melted: string[] }>(tableReshape, {
      file: "w.csv",
      direction: "long",
      idColumns: ["region"],
    });
    expect(result.melted).toEqual(["jan", "feb"]);
    expect(result.rowCount).toBe(3);
  });

  test("long to wide reports a collision rather than picking a winner", async () => {
    write("g.csv", "region,month,v\nN,jan,10\nN,jan,99\nN,feb,20\n");
    const result = await call<{ collisions: Array<{ variable: string; count: number }> }>(
      tableReshape,
      {
        file: "g.csv",
        direction: "wide",
        idColumns: ["region"],
        variableColumn: "month",
        valueColumn: "v",
      },
    );
    expect(result.collisions[0]).toMatchObject({ variable: "jan", count: 2 });
  });

  test("reshaping to wide without the two required columns says which are missing", async () => {
    write("g.csv", "a,b\n1,2\n");
    expect(
      await raw(tableReshape, { file: "g.csv", direction: "wide", idColumns: ["a"] }),
    ).toContain("variableColumn and valueColumn");
  });
});

describe("TableShard", () => {
  test("splits by row count with the header on every shard", async () => {
    write("a.csv", "a,b\n1,x\n2,y\n3,z\n");
    const result = await call<{ shardCount: number; bodies: string[] }>(tableShard, {
      file: "a.csv",
      maxRows: 2,
    });
    expect(result.shardCount).toBe(2);
    for (const body of result.bodies) expect(body.startsWith("a,b\n")).toBe(true);
  });

  test("planOnly leaves the contents out", async () => {
    write("a.csv", "a\n1\n2\n");
    const result = await call<{ bodies?: string[]; shards: unknown[] }>(tableShard, {
      file: "a.csv",
      maxRows: 1,
      planOnly: true,
    });
    expect(result.bodies).toBeUndefined();
    expect(result.shards).toHaveLength(2);
  });

  test("bodies are withheld when they would be the whole file again", async () => {
    // Returning them past a few megabytes is not a result, it is the file.
    //
    // The threshold is on BYTES, so the fixture buys them with a few wide rows
    // rather than many narrow ones: 1,200 rows of ~10KB clears the 8MiB limit
    // with the same margin 120,000 rows of ~100 bytes did, while giving the
    // CSV reader 1,200 row arrays to allocate instead of 120,000. The old
    // shape spent 6.9s on that allocation and blew bun's 5s default budget on
    // a CI runner — a test that declares no deadline still has one.
    const WIDE = "y".repeat(9_990);
    write(
      "big.csv",
      `a,b\n${Array.from({ length: 1_200 }, (_, i) => `${i},${WIDE}`).join("\n")}\n`,
    );
    const result = await call<{ bodies?: string[]; totalBytes: number; note?: string }>(
      tableShard,
      {
        file: "big.csv",
        maxRows: 500,
      },
    );
    expect(result.bodies).toBeUndefined();
    expect(result.totalBytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(result.note).toContain("return limit");
    // The limit is 8MiB of REAL bytes, so this test genuinely builds, writes,
    // reads, parses and shards about 12MB however the fixture is shaped —
    // ~24MB live as UTF-16, several copies at once. That is cheap on a
    // developer's machine and expensive on a two-core runner sharing memory
    // with 220 other suites: 199ms here, 6.4s there. Narrowing the fixture
    // from 120,000 rows to 1,200 cut the allocation COUNT and the local time,
    // which is why this test lost its budget in the first place — but the byte
    // volume is what the runner charges for, and no fixture shape avoids it
    // while still crossing a real 8MiB threshold. So it declares one.
  }, 30_000);

  test("no bound at all is rejected by the schema", () => {
    expect(tableShard.inputSchema.safeParse({ file: "a.csv" }).success).toBe(false);
  });
});

describe("FixedWidthParse", () => {
  test("parses a positional layout and reports short lines", async () => {
    write("f.txt", "ALICE     0010NY\nSHORT\n");
    const result = await call<{
      rows: Array<Record<string, string>>;
      shortLines: Array<{ line: number }>;
    }>(fixedWidthParse, {
      file: "f.txt",
      fields: [
        { name: "name", start: 1, length: 10 },
        { name: "qty", start: 11, length: 4 },
        { name: "st", start: 15, length: 2 },
      ],
    });
    expect(result.rows[0]).toEqual({ name: "ALICE", qty: "0010", st: "NY" });
    expect(result.shortLines).toEqual([{ line: 2, length: 5 }]);
  });

  test("a zero start position is rejected by the schema, since positions are 1-based", () => {
    expect(
      fixedWidthParse.inputSchema.safeParse({
        file: "f.txt",
        fields: [{ name: "a", start: 0, length: 1 }],
      }).success,
    ).toBe(false);
  });
});

describe("DataDriftCheck", () => {
  /** A column of 0.0 .. 99.9, and a status column with a stable mix. */
  const baselineCsv = (): string => {
    const lines = ["amount,status"];
    for (let i = 0; i < 400; i++) {
      lines.push(`${(i / 4).toFixed(2)},${["open", "open", "closed", "pending"][i % 4]}`);
    }
    return `${lines.join("\n")}\n`;
  };
  /** The same shape, moved up by 200 and with a category nobody has seen. */
  const todayCsv = (): string => {
    const lines = ["amount,status"];
    for (let i = 0; i < 400; i++) {
      lines.push(`${(200 + i / 4).toFixed(2)},${["open", "refunded", "closed", "pending"][i % 4]}`);
    }
    return `${lines.join("\n")}\n`;
  };

  beforeEach(async () => {
    write("baseline.csv", baselineCsv());
    write("today.csv", todayCsv());
    write(
      "baseline.profile.json",
      await raw(tableProfile, { file: "baseline.csv", driftProfile: {} }),
    );
  });

  test("a stored profile is a working baseline: the shift, the new category, the row ratio", async () => {
    const result = await call<{
      rows: { ratio: number };
      columns: Array<{
        column: string;
        psi: { value: number; band: string; outOfRange: { above: number } } | null;
        newCategories: string[] | null;
        chiSquare: { p: number } | null;
      }>;
    }>(dataDriftCheck, {
      referenceProfile: "baseline.profile.json",
      file: "today.csv",
      epsilon: 1e-3,
    });
    expect(result.rows.ratio).toBe(1);
    const amount = result.columns.find((c) => c.column === "amount");
    expect(amount?.psi?.band).toBe("significant");
    // Everything today sits above the baseline's largest bin edge.
    expect(amount?.psi?.outOfRange.above).toBe(400);
    const status = result.columns.find((c) => c.column === "status");
    expect(status?.newCategories).toEqual(["refunded"]);
    expect(status?.chiSquare?.p).toBeLessThan(0.001);
  });

  test("a baseline profiled WITHOUT driftProfile is refused, and the refusal says how to fix it", async () => {
    write("plain.profile.json", await raw(tableProfile, { file: "baseline.csv" }));
    const out = await raw(dataDriftCheck, {
      referenceProfile: "plain.profile.json",
      file: "today.csv",
      epsilon: 1e-3,
    });
    expect(out).toContain("no bin edges");
    expect(out).toContain("driftProfile");
    // And it explains WHY the plausible fallback is not taken.
    expect(out).toContain("reads near zero");
  });

  test("epsilon is required, because it decides the verdict", () => {
    expect(
      dataDriftCheck.inputSchema.safeParse({
        referenceProfile: "baseline.profile.json",
        file: "today.csv",
      }).success,
    ).toBe(false);
    expect(
      dataDriftCheck.inputSchema.safeParse({
        referenceProfile: "baseline.profile.json",
        file: "today.csv",
        epsilon: 0,
      }).success,
    ).toBe(false);
    expect(
      dataDriftCheck.inputSchema.safeParse({
        referenceProfile: "baseline.profile.json",
        file: "today.csv",
        epsilon: 1,
      }).success,
    ).toBe(false);
  });

  test("the same data reads significant, moderate or stable depending on epsilon alone", async () => {
    // One decile of the baseline is missing today. Nothing else differs.
    write("short.csv", baselineCsv().split("\n").slice(0, 361).join("\n"));
    const bands: string[] = [];
    for (const epsilon of [1e-3, 1e-2, 0.05]) {
      const result = await call<{
        columns: Array<{ column: string; psi: { band: string } | null }>;
      }>(dataDriftCheck, { referenceProfile: "baseline.profile.json", file: "short.csv", epsilon });
      bands.push(result.columns.find((c) => c.column === "amount")?.psi?.band ?? "none");
    }
    expect(bands).toEqual(["significant", "moderate", "stable"]);
  });

  test("exactly one reference must be given", () => {
    const both = dataDriftCheck.inputSchema.safeParse({
      referenceProfile: "baseline.profile.json",
      referenceFile: "baseline.csv",
      file: "today.csv",
      epsilon: 1e-3,
    });
    expect(both.success).toBe(false);
    const neither = dataDriftCheck.inputSchema.safeParse({ file: "today.csv", epsilon: 1e-3 });
    expect(neither.success).toBe(false);
  });

  test("a reference FILE is profiled on the spot, with the same result", async () => {
    const fromFile = await call<{
      columns: Array<{ column: string; psi: { value: number } | null }>;
    }>(dataDriftCheck, { referenceFile: "baseline.csv", file: "today.csv", epsilon: 1e-3 });
    const fromProfile = await call<{
      columns: Array<{ column: string; psi: { value: number } | null }>;
    }>(dataDriftCheck, {
      referenceProfile: "baseline.profile.json",
      file: "today.csv",
      epsilon: 1e-3,
    });
    const psi = (r: { columns: Array<{ column: string; psi: { value: number } | null }> }) =>
      r.columns.find((c) => c.column === "amount")?.psi?.value;
    expect(psi(fromFile)).toBe(psi(fromProfile) as number);
  });

  test("a file that is not JSON is named as such rather than crashing", async () => {
    const out = await raw(dataDriftCheck, {
      referenceProfile: "baseline.csv",
      file: "today.csv",
      epsilon: 1e-3,
    });
    expect(out).toContain("is not JSON");
    expect(out).toContain("referenceFile");
  });

  test("a hand-edited baseline with broken bin edges is refused by column name", async () => {
    const profile = JSON.parse(await raw(tableProfile, { file: "baseline.csv", driftProfile: {} }));
    profile.columns[0].drift.edges = [0, 5, 5, 10];
    write("bent.profile.json", JSON.stringify(profile));
    const out = await raw(dataDriftCheck, {
      referenceProfile: "bent.profile.json",
      file: "today.csv",
      epsilon: 1e-3,
    });
    expect(out).toContain("not strictly increasing");
    expect(out).toContain("amount");
  });

  test("a baseline missing the fields the comparison indexes into is refused", async () => {
    write("half.profile.json", JSON.stringify({ rows: 3, columns: [] }));
    expect(
      await raw(dataDriftCheck, {
        referenceProfile: "half.profile.json",
        file: "today.csv",
        epsilon: 1e-3,
      }),
    ).toContain("carries no drift capture");

    write(
      "old.profile.json",
      JSON.stringify({ rows: 3, columns: [], driftCapture: { version: 9 } }),
    );
    expect(
      await raw(dataDriftCheck, {
        referenceProfile: "old.profile.json",
        file: "today.csv",
        epsilon: 1e-3,
      }),
    ).toContain("version 9");
  });

  test("capture settings cannot be overridden against a stored profile", async () => {
    // A stored profile already fixes its bins, cap, sample size and seed;
    // honouring an override would compare today's data under settings the
    // baseline was never taken under.
    expect(
      await raw(dataDriftCheck, {
        referenceProfile: "baseline.profile.json",
        file: "today.csv",
        epsilon: 1e-3,
        capture: { bins: 4 },
      }),
    ).toContain("capture applies only to referenceFile");
    expect(
      await raw(dataDriftCheck, {
        referenceProfile: "baseline.profile.json",
        file: "today.csv",
        epsilon: 1e-3,
        nullTokens: ["NIL"],
      }),
    ).toContain("nullTokens applies only to referenceFile");
  });

  test("failOn turns the measurements into a verdict, and without it ok means nothing was checked", async () => {
    const gated = await call<{ gate: { ok: boolean; failures: string[] } }>(dataDriftCheck, {
      referenceProfile: "baseline.profile.json",
      file: "today.csv",
      epsilon: 1e-3,
      failOn: { psi: 0.25, newCategories: 0 },
    });
    expect(gated.gate.ok).toBe(false);
    expect(gated.gate.failures.join(" ")).toContain("refunded");

    const ungated = await call<{ gate: { ok: boolean; configured: boolean; note: string } }>(
      dataDriftCheck,
      { referenceProfile: "baseline.profile.json", file: "today.csv", epsilon: 1e-3 },
    );
    expect(ungated.gate).toMatchObject({ ok: true, configured: false });
    expect(ungated.gate.note).toContain("not because nothing drifted");
  });

  test("an unchanged file passes its own gate", async () => {
    const result = await call<{
      gate: { ok: boolean };
      columns: Array<{ psi: { value: number } | null }>;
    }>(dataDriftCheck, {
      referenceProfile: "baseline.profile.json",
      file: "baseline.csv",
      epsilon: 1e-3,
      failOn: { psi: 0.1, newCategories: 0, rowCountRatio: 1.05, schemaDrift: true },
    });
    expect(result.gate.ok).toBe(true);
    expect(result.columns[0]?.psi?.value).toBe(0);
  });

  test("a column named in `columns` that exists nowhere is refused", async () => {
    expect(
      await raw(dataDriftCheck, {
        referenceProfile: "baseline.profile.json",
        file: "today.csv",
        epsilon: 1e-3,
        columns: ["ghost"],
      }),
    ).toContain("in neither the reference");
  });

  test("`columns` narrows the comparison and says the schema report narrowed with it", async () => {
    const result = await call<{ columns: Array<{ column: string }>; notes: string[] }>(
      dataDriftCheck,
      {
        referenceProfile: "baseline.profile.json",
        file: "today.csv",
        epsilon: 1e-3,
        columns: ["status"],
      },
    );
    expect(result.columns.map((c) => c.column)).toEqual(["status"]);
    expect(result.notes.join(" ")).toContain("schema report covers only those");
  });

  test("a dropped column is reported rather than silently uncompared", async () => {
    write("narrow.csv", "amount\n1.00\n2.00\n3.00\n");
    const result = await call<{ schema: { removed: string[] } }>(dataDriftCheck, {
      referenceProfile: "baseline.profile.json",
      file: "narrow.csv",
      epsilon: 1e-3,
    });
    expect(result.schema.removed).toEqual(["status"]);
  });

  test("a feed that stopped parsing does not take a configured gate through green", async () => {
    // The loudest break there is: `amount` starts arriving quoted with
    // thousands separators, so not one value parses. PSI is refused, and a
    // refused measurement used to leave the gate reporting ok with the note
    // "every configured threshold held".
    const lines = ["amount,status"];
    for (let i = 0; i < 400; i++) {
      lines.push(`"1,${(200 + i).toFixed(0)}.00",${["open", "open", "closed", "pending"][i % 4]}`);
    }
    write("broken.csv", `${lines.join("\n")}\n`);
    const result = await call<{
      gate: { ok: boolean; failures: string[]; unchecked: string[]; note: string };
    }>(dataDriftCheck, {
      referenceProfile: "baseline.profile.json",
      file: "broken.csv",
      epsilon: 1e-3,
      failOn: { psi: 0.25 },
    });
    expect(result.gate.ok).toBe(false);
    // The reason, not just the verdict — ok:false is also what a real breach
    // returns, and the two want opposite responses from whoever is paged.
    expect(result.gate.failures).toEqual([]);
    expect(result.gate.unchecked.join(" ")).toContain("amount");
    expect(result.gate.unchecked.join(" ")).toContain("no values that parse as numbers");
    expect(result.gate.note).toContain("never got to look");
  });

  test("a file past the row cap is refused, not answered from its first two million rows", async () => {
    // `parseCsv` stops at the cap and says so; ignoring that flag answers
    // about a prefix while claiming to answer about the file, and on a
    // date-sorted export the prefix is a different month.
    const parts = ["amount,status\n"];
    for (let i = 0; i < 2_000_001; i++) parts.push(`${i % 997}.5,open\n`);
    write("huge.csv", parts.join(""));
    await expect(
      raw(dataDriftCheck, {
        referenceProfile: "baseline.profile.json",
        file: "huge.csv",
        epsilon: 1e-3,
      }),
    ).rejects.toThrow(/more than 2000000 rows/);
  }, 20_000); // pays for writing and parsing an 8MB file to reach the cap

  test("both paths are contained", async () => {
    await expect(
      raw(dataDriftCheck, {
        referenceProfile: "../escape.json",
        file: "today.csv",
        epsilon: 1e-3,
      }),
    ).rejects.toThrow(/escapes the workspace/);
    await expect(
      raw(dataDriftCheck, {
        referenceProfile: "baseline.profile.json",
        file: "../escape.csv",
        epsilon: 1e-3,
      }),
    ).rejects.toThrow(/escapes the workspace/);
  });
});
