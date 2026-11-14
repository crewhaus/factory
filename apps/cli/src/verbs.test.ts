/**
 * The verb inventory (`verbs.ts`) is the CLI's dispatch, its help and its
 * parsers, read from the code rather than transcribed: every `case` label in
 * `index.ts` is a legacy row or a family module, every verb has a help line,
 * every family parser takes its flags from its own `CLI_FAMILY`, and
 * `apps/cli/verbs.json` is the inventory as generated.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_SRC, familyModuleFiles, loadFamilies, loadFamilyModules } from "./__test__/families";
import { usageText } from "./usage-text";
import {
  type CliFamily,
  type Inventory,
  LEGACY_VERBS,
  type LegacyVerb,
  NESTED_VERB_EXCEPTIONS,
  composeInventory,
  deprecationNotice,
  inventoryDocument,
  schemaNamed,
  validateInventory,
} from "./verbs";

const INDEX = readFileSync(join(CLI_SRC, "index.ts"), "utf8");

/** The legacy rows there were when the inventory was written. */
const LEGACY_COUNT = 78;

/** The top-level dispatch labels: `case "<verb>":` from `switch (subcommand) {` on. */
function dispatchVerbs(source: string): string[] {
  const start = source.indexOf("switch (subcommand) {");
  if (start === -1) return [];
  return [...source.slice(start).matchAll(/^ {2}case "([a-z][a-z0-9-]*)":/gm)].map(
    (m) => m[1] as string,
  );
}

/** Labels the inventory lacks, and verbs it has that the dispatch does not. */
function dispatchDrift(
  labels: readonly string[],
  inv: Inventory,
): { readonly undeclared: string[]; readonly undispatched: string[] } {
  const declared = new Set(inv.entries.map((e) => e.verb));
  const dispatched = new Set(labels);
  return {
    undeclared: [...dispatched].filter((v) => !declared.has(v)).sort(),
    undispatched: [...declared].filter((v) => !dispatched.has(v)).sort(),
  };
}

/** Verbs with no line in the usage text. A help line names the verb as a whole word. */
function missingHelp(inv: Inventory, usage: string): string[] {
  const lines = usage.split("\n");
  return inv.entries
    .map((e) => e.verb)
    .filter((verb) => !lines.some((line) => line === `  ${verb}` || line.startsWith(`  ${verb} `)));
}

/** The `case` block of one top-level verb in `index.ts`. */
function caseBlock(source: string, verb: string): string {
  const switchAt = source.indexOf("switch (subcommand) {");
  const at = source.indexOf(`\n  case "${verb}":`, switchAt);
  if (at === -1) return "";
  const rest = source.slice(at + 1);
  const next = rest.slice(1).search(/^ {2}(case "|default:)/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** Where a handler-checked verb's sub-verbs are spelled, beyond `index.ts`. */
const HANDLER_SOURCES: Readonly<Record<string, readonly string[]>> = {
  deploy: ["cloud-deploy.ts"],
  experiment: ["experiment.ts"],
  models: ["models-cli.ts"],
  provability: ["provability-cli.ts"],
  route: ["route.ts"],
};

const real = async (): Promise<Inventory> => composeInventory(await loadFamilies());
const legacyRow = (verb: string): LegacyVerb => {
  const row = LEGACY_VERBS.find((r) => r.verb === verb);
  if (row === undefined) throw new Error(`no legacy row for ${verb}`);
  return row;
};
const subKeys = (verb: string): string[] =>
  Object.keys(legacyRow(verb).sub ?? {}).filter((k) => k !== "");

describe("the inventory is the dispatch", () => {
  test("every dispatch label is a legacy row or a family, and nothing else is", async () => {
    const labels = dispatchVerbs(INDEX);
    expect(labels.length).toBeGreaterThanOrEqual(82);
    expect(dispatchDrift(labels, await real())).toEqual({ undeclared: [], undispatched: [] });
  });

  test("a case added to the dispatch, or one removed, is reported", async () => {
    const inv = await real();
    const added = INDEX.replace(
      "switch (subcommand) {",
      'switch (subcommand) {\n  case "frobnicate":',
    );
    expect(dispatchDrift(dispatchVerbs(added), inv).undeclared).toEqual(["frobnicate"]);
    const removed = INDEX.replace('\n  case "loadtest":', "\n  case_loadtest:");
    expect(dispatchDrift(dispatchVerbs(removed), inv).undispatched).toEqual(["loadtest"]);
  });

  test("a new verb is a family module, never another legacy row", async () => {
    const modules = await loadFamilyModules();
    const families = modules.map((m) => m.family.verb);
    const legacy = LEGACY_VERBS.map((r) => r.verb);
    expect(families.filter((v) => legacy.includes(v))).toEqual([]);
    const labels = dispatchVerbs(INDEX);
    for (const { file, family } of modules) {
      expect(`${family.verb}: ${labels.includes(family.verb)}`).toBe(`${family.verb}: true`);
      expect(file).toBe(`${family.verb}-cmd.ts`);
    }
    // A `-cmd.ts` module without CLI_FAMILY is fine only when its name is not
    // a dispatch label that would need one.
    for (const file of familyModuleFiles()) {
      const verb = file.slice(0, -"-cmd.ts".length);
      if (families.includes(verb)) continue;
      expect(`${file}: ${!labels.includes(verb) || legacy.includes(verb)}`).toBe(`${file}: true`);
    }
    expect(families.sort()).toEqual([
      "access",
      "api",
      "changes",
      "commands",
      "criteria",
      "daemon",
      "hangar",
      "harness",
      "login",
      "logout",
      "people",
    ]);
    expect(LEGACY_VERBS.length, "a new verb is a `<verb>-cmd.ts` module exporting CLI_FAMILY").toBe(
      LEGACY_COUNT,
    );
  });

  test("the legacy rows are sorted and frozen", () => {
    const verbs = LEGACY_VERBS.map((r) => r.verb);
    expect(verbs).toEqual([...verbs].sort());
    expect(Object.isFrozen(LEGACY_VERBS)).toBe(true);
    expect(Object.isFrozen(legacyRow("memory").sub)).toBe(true);
  });
});

describe("every verb has help", () => {
  test("the usage text has a line for every verb", async () => {
    expect(missingHelp(await real(), usageText())).toEqual([]);
  });

  test("a verb with no line is reported, and a longer verb does not stand in for it", () => {
    const inv: Inventory = {
      entries: [
        { kind: "legacy", verb: "model", since: "0.8.0" },
        { kind: "legacy", verb: "run", since: "0.8.0" },
        { kind: "legacy", verb: "eval", since: "0.8.0" },
        { kind: "legacy", verb: "dataset", since: "0.8.0" },
        { kind: "legacy", verb: "migrate", since: "0.8.0" },
        { kind: "legacy", verb: "undocumented", since: "0.8.0" },
      ],
    };
    const usage = [
      "  models list",
      "  runs resume <id>",
      "  eval-report diff",
      "  datasets list",
      "  migrate-all",
    ].join("\n");
    expect(missingHelp(inv, usage)).toEqual([
      "model",
      "run",
      "eval",
      "dataset",
      "migrate",
      "undocumented",
    ]);
    expect(missingHelp(inv, `${usage}\n  model right-size\n  run <spec>\n  eval\n`)).toEqual([
      "dataset",
      "migrate",
      "undocumented",
    ]);
  });

  test("each of the nine verbs that had no line has one now", () => {
    const usage = usageText();
    for (const line of [
      "  model right-size ",
      "  model-scan ",
      "  pricing sync|show ",
      "  egress review ",
      "  pii tune ",
      "  justification calibrate|preflight ",
      "  onchain tune|sentinel ",
      "  intents ",
      "  loadtest ",
    ]) {
      expect(`${line}: ${usage.split("\n").some((l) => l.startsWith(line))}`).toBe(`${line}: true`);
    }
  });
});

describe("every flag list answers --help", () => {
  test("every legacy schema name resolves to a schema that declares help", () => {
    let names = 0;
    for (const row of LEGACY_VERBS) {
      for (const name of [row.schema, ...Object.values(row.sub ?? {})]) {
        if (name === undefined || name === null) continue;
        const schema = schemaNamed(name);
        expect(`${row.verb} ${name}: ${schema !== undefined}`).toBe(`${row.verb} ${name}: true`);
        expect(schema?.flags.some((f) => f.name === "help")).toBe(true);
        names++;
      }
    }
    expect(names).toBeGreaterThanOrEqual(90);
  });

  test("every family sub-verb prints its usage on --help and -h, and touches nothing", async () => {
    const modules = await loadFamilyModules();
    let asked = 0;
    for (const { file, family } of modules) {
      const mod = (await import(join(CLI_SRC, file))) as Record<string, unknown>;
      const name = `run${family.verb[0]?.toUpperCase()}${family.verb.slice(1)}Command`;
      const run = mod[name] as (
        argv: readonly string[],
        opts: { env: Record<string, string> },
      ) => Promise<{ lines: readonly string[]; exitCode: number }>;
      expect(`${file} exports ${name}: ${typeof run}`).toBe(`${file} exports ${name}: function`);
      const usage = (await run(["--help"], { env: {} })).lines;
      for (const sub of Object.keys(family.sub)) {
        for (const flag of ["--help", "-h"]) {
          const scratch = mkdtempSync(join(tmpdir(), "verbs-help-"));
          try {
            const env = {
              CREWHAUS_REGISTRY_ROOT: join(scratch, "registry"),
              CREWHAUS_HANGAR_ROOT: join(scratch, "hangar"),
              CREWHAUS_WATCHME_ROOT: join(scratch, "watchme"),
              HOME: scratch,
            };
            const out = await run([sub, flag], { env });
            expect(`${family.verb} ${sub} ${flag}: ${out.exitCode}`).toBe(
              `${family.verb} ${sub} ${flag}: 0`,
            );
            expect(out.lines).toEqual(usage);
            expect(readdirSync(scratch)).toEqual([]);
            asked++;
          } finally {
            rmSync(scratch, { recursive: true, force: true });
          }
        }
      }
    }
    expect(asked).toBe(2 * (13 + 1 + 5 + 2 + 5 + 8 + 10 + 12 + 1 + 1 + 12));
  }, 30_000); // eleven modules' imports and a hundred and forty calls; slow on a loaded runner
});

describe("family parsers take their flags from CLI_FAMILY", () => {
  const CALL = /\bparse(?:VerbArgs|Args)\(\s*(?:"[^"]*"|[A-Za-z_]\w*),\s*[^,]+?,\s*/g;

  test("no parser call spells its flags inline, and each module's calls all pass CLI_FAMILY", async () => {
    const floors: Record<string, number> = { harness: 10, hangar: 5, daemon: 7, access: 10 };
    for (const { file, family } of await loadFamilyModules()) {
      const source = readFileSync(join(CLI_SRC, file), "utf8");
      let inline = 0;
      let fromFamily = 0;
      let calls = 0;
      for (const m of source.matchAll(CALL)) {
        const after = source.slice((m.index ?? 0) + m[0].length);
        calls++;
        if (after.startsWith("{")) inline++;
        else if (/^CLI_FAMILY\.sub(\.|\[)/.test(after)) fromFamily++;
      }
      expect(`${file} inline: ${inline}`).toBe(`${file} inline: 0`);
      expect(`${file} calls: ${fromFamily}`).toBe(`${file} calls: ${calls}`);
      expect(fromFamily).toBeGreaterThanOrEqual(floors[family.verb] ?? 1);
    }
  });

  test("the unknown-verb error lists exactly the family's sub-verbs, in order", async () => {
    for (const { file, family } of await loadFamilyModules()) {
      const mod = (await import(join(CLI_SRC, file))) as Record<string, unknown>;
      const run = mod[`run${family.verb[0]?.toUpperCase()}${family.verb.slice(1)}Command`] as (
        argv: readonly string[],
        opts: { env: Record<string, string> },
      ) => Promise<unknown>;
      const scratch = mkdtempSync(join(tmpdir(), "verbs-unknown-"));
      try {
        const env = {
          CREWHAUS_REGISTRY_ROOT: join(scratch, "registry"),
          CREWHAUS_HANGAR_ROOT: join(scratch, "hangar"),
          CREWHAUS_WATCHME_ROOT: join(scratch, "watchme"),
          CREWHAUS_NO_REGISTRY: "1",
          HOME: scratch,
        };
        let message = "";
        try {
          await run(["no-such-verb"], { env });
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        const keys = Object.keys(family.sub);
        const joined = family.verb === "access" ? keys.join(", ") : keys.join(" | ");
        expect(message).toContain(`(expected: ${joined})`);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  });

  test("daemon's verb list is its family's", async () => {
    const { CLI_FAMILY, DAEMON_VERBS } = await import("./daemon-cmd");
    expect([...DAEMON_VERBS]).toEqual(Object.keys(CLI_FAMILY.sub));
    expect(DAEMON_VERBS).toEqual([
      "start",
      "submit",
      "stop",
      "restart",
      "status",
      "logs",
      "wake",
      "drain",
      "pause",
      "resume",
      "disable",
      "enable",
    ]);
  });
});

describe("the shape rules", () => {
  test("the real inventory is sound", async () => {
    expect(validateInventory(await real())).toEqual([]);
  });

  test("each planted defect is refused with its reason", async () => {
    const families = await loadFamilies();
    const nested: CliFamily = {
      verb: "nested",
      since: "0.9.0",
      sub: { outer: { flags: {}, sub: { inner: { flags: {} } } } as never },
    };
    expect(validateInventory(composeInventory([...families, nested]))).toEqual([
      "nested outer: a sub-verb has no sub-verbs of its own (two levels only)",
    ]);
    const deprecated = {
      verb: "oldverb",
      since: "0.8.0",
      status: "deprecated",
      use: "newverb",
      sub: {},
    } as unknown as CliFamily;
    expect(validateInventory(composeInventory([...families, deprecated]))).toEqual([
      'oldverb: a deprecated verb names the release it goes away in ("removal")',
    ]);
    const clash: CliFamily = { verb: "memory", since: "0.9.0", sub: {} };
    expect(validateInventory(composeInventory([...families, clash]))).toEqual([
      '"memory" is declared twice (legacy and family)',
    ]);
    const badKey: CliFamily = { verb: "keyed", since: "0.9.0", sub: { Bad_Key: { flags: {} } } };
    expect(validateInventory(composeInventory([...families, badKey]))).toEqual([
      'keyed: sub-verb "Bad_Key" is not a sub-verb name',
    ]);
    const positional: Inventory = {
      entries: [{ kind: "legacy", verb: "orphan", since: "0.8.0", positionalFirst: true }],
    };
    expect(validateInventory(positional)).toEqual([
      "orphan: positionalFirst needs a schema for the verb's own positional",
    ]);
  });

  test("the one written exception to two levels is fleet run", () => {
    expect([...NESTED_VERB_EXCEPTIONS]).toEqual(["fleet run"]);
    const fleet: CliFamily = {
      verb: "fleet",
      since: "0.8.0",
      sub: { run: { flags: {}, sub: { any: { flags: {} } } } as never },
    };
    expect(validateInventory({ entries: [{ kind: "family", ...fleet }] })).toEqual([]);
  });

  test("the deprecation notice is one fixed sentence", () => {
    expect(deprecationNotice({ verb: "fleet", use: "harness list", removal: "0.11.0" })).toBe(
      "crewhaus fleet is deprecated; use crewhaus harness list. fleet goes away in 0.11.0.",
    );
    const planted = {
      kind: "legacy" as const,
      verb: "fleet",
      since: "0.8.0",
      status: "deprecated" as const,
      removal: "0.11.0",
      use: "harness list",
    };
    const doc = inventoryDocument({ entries: [planted] });
    expect(doc.verbs[0]).toEqual({
      verb: "fleet",
      kind: "legacy",
      since: "0.8.0",
      status: "deprecated",
      removal: "0.11.0",
      use: "harness list",
      sub: null,
      flags: null,
    });
    expect(validateInventory({ entries: [planted] })).toEqual([]);
  });
});

describe("legacy sub-verbs match the dispatch", () => {
  test("a dispatch-checked sub-verb is spelled in its verb's case block", () => {
    let checked = 0;
    for (const row of LEGACY_VERBS.filter((r) => r.subCheckedBy === "dispatch")) {
      const block = caseBlock(INDEX, row.verb);
      expect(`${row.verb}: ${block.length > 0}`).toBe(`${row.verb}: true`);
      for (const key of Object.keys(row.sub ?? {})) {
        const spelled =
          block.includes(`"${key}"`) || (key !== "" && new RegExp(`\\b${key}:`).test(block));
        expect(`${row.verb} "${key}": ${spelled}`).toBe(`${row.verb} "${key}": true`);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(80);
  });

  test("a handler-checked sub-verb is spelled where its handler is", () => {
    const handlers = LEGACY_VERBS.filter((r) => r.subCheckedBy === "handler");
    // Pinned: this check is weaker than the case-block one, so it cannot grow quietly.
    expect(handlers.map((r) => r.verb)).toEqual([
      "dataset",
      "datasets",
      "deploy",
      "eval-report",
      "experiment",
      "faq",
      "fewshot",
      "lessons",
      "memory",
      "models",
      "plugins",
      "provability",
      "redteam",
      "route",
      "sessions",
      "templates",
      "wiki",
    ]);
    for (const row of handlers) {
      const sources = [
        INDEX,
        ...(HANDLER_SOURCES[row.verb] ?? []).map((f) => readFileSync(join(CLI_SRC, f), "utf8")),
      ].join("\n");
      for (const key of Object.keys(row.sub ?? {})) {
        expect(`${row.verb} "${key}": ${sources.includes(`"${key}"`)}`).toBe(
          `${row.verb} "${key}": true`,
        );
      }
    }
    // Every row that declares sub-verbs says where they are checked.
    for (const row of LEGACY_VERBS) {
      expect(`${row.verb}: ${(row.sub === undefined) === (row.subCheckedBy === undefined)}`).toBe(
        `${row.verb}: true`,
      );
    }
  });

  test("the memory screens' verbs are the CLI's own lists, in order", () => {
    const memory = INDEX.match(/memory: unknown action [^\n]*supported: ([a-z, ]+)`/);
    expect(memory?.[1]?.split(", ")).toEqual(subKeys("memory"));
    const wiki = INDEX.match(/wiki: unknown action [^\n]*supported: ([a-z, ]+)`/);
    expect(wiki?.[1]?.split(", ")).toEqual(subKeys("wiki"));
    const state = INDEX.match(/state action must be one of ([a-z, ]+) \(got/);
    expect(state?.[1]?.split(", ")).toEqual(subKeys("state"));
    expect(INDEX).toContain('knowledge action must be "sync"');
    expect(subKeys("knowledge")).toEqual(["sync"]);
    expect(INDEX).toContain(
      'dreamFirst === "run" || dreamFirst === "status" || dreamFirst === "init"',
    );
    expect(subKeys("dream")).toEqual(["run", "status", "init"]);
    expect(INDEX).toContain('migrate action must be "memories"');
    expect(subKeys("migrate")).toEqual(["memories"]);
    const watchme = INDEX.match(/const allowed = \["", ([^\]]+)\];/);
    expect([...(watchme?.[1] ?? "").matchAll(/"([a-z]+)"/g)].map((m) => m[1])).toEqual(
      subKeys("watchme"),
    );
    const approvals = INDEX.match(
      /!isHelp &&\s+!\["", ([^\]]+)\]\.includes\(\s*action,?\s*\)\s*\)\s*\{\s*die\(\s*`approvals/,
    );
    expect(approvals?.[1]).toBeDefined();
    expect([...(approvals?.[1] ?? "").matchAll(/"([a-z-]+)"/g)].map((m) => m[1])).toEqual(
      subKeys("approvals"),
    );
  });
});

describe("apps/cli/verbs.json", () => {
  test("is the composed inventory, as generated", async () => {
    const onDisk = JSON.parse(readFileSync(join(CLI_SRC, "..", "verbs.json"), "utf8")) as unknown;
    expect(
      onDisk,
      "apps/cli/verbs.json is out of date: run bun scripts/generate-verbs-json.ts",
    ).toEqual(inventoryDocument(await real()) as unknown);
  });

  test("carries no CLI version, so a release does not change it", () => {
    const text = readFileSync(join(CLI_SRC, "..", "verbs.json"), "utf8");
    const doc = JSON.parse(text) as { version: unknown };
    expect(Object.keys(doc)).toEqual(["version", "verbs"]);
    expect(doc.version).toBe(1);
  });
});
