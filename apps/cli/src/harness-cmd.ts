/**
 * Hangar M1 — the `crewhaus harness` verb family: the CLI twin of the
 * machine-wide harness registry.
 *
 * Composes the three layers of the harness manager without duplicating any
 * of them:
 *   - `@crewhaus/harness-registry` — the registry FILE layer
 *     (`<registryRoot>/harnesses.json`): stable `hrn_` ids, groups, tags,
 *     pins, scan roots. All verbs here are thin drivers over its API.
 *   - `@crewhaus/harness-inventory` — discovery + per-harness inventory and
 *     health rollup (the `crewhaus fleet` core), joined onto registry rows
 *     for `list`/`show`.
 *   - `@crewhaus/preflight` — the typed will-it-boot checks behind
 *     `harness preflight`.
 *
 * Factored out of the entry file `index.ts` (which runs a top-level argv
 * switch and so cannot be imported by a test without executing the CLI).
 * Side-effect-free on import and directly unit-testable, mirroring
 * `route.ts` / `fleet.ts`: every function takes an injected environment
 * (`CREWHAUS_REGISTRY_ROOT` / `CREWHAUS_NO_REGISTRY` are read from it, not
 * from ambient `process.env`, when a caller supplies one) and returns lines
 * + an exit code instead of writing to stdout. Bad arguments throw plain
 * `Error`s; the entry file routes them through `die()` like `route` does.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readBaselines, readRunIndexLatest } from "@crewhaus/eval-report";
import {
  type BuildInventoryDeps,
  type EvalHealthReader,
  HARNESS_SPEC_FILENAME,
  type HarnessHealth,
  type HarnessInventory,
  type SpecHeader,
  buildHarnessHealth,
  buildHarnessInventory,
  discoverHarnesses,
  healthMark,
  readSpecHeader,
} from "@crewhaus/harness-inventory";
import {
  type HangarHarnessEntry,
  type HangarRegistry,
  openHangarRegistry,
} from "@crewhaus/harness-registry";
import { preflightHarness } from "@crewhaus/preflight";
import { createFileBackedRegistry } from "@crewhaus/spec-registry";

/** What a verb returns: lines for stdout + the process exit code. */
export type HarnessCommandResult = {
  readonly lines: readonly string[];
  readonly exitCode: 0 | 1;
};

export type HarnessCommandOptions = {
  /** Environment the registry (CREWHAUS_REGISTRY_ROOT / CREWHAUS_NO_REGISTRY
   *  / CREWHAUS_WATCHME_ROOT) and preflight consult. Injected by tests so
   *  they never touch the real `~/.crewhaus`; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Clock (epoch ms) for scan/registration stamps; injected by tests. */
  readonly now?: () => number;
};

const HARNESS_USAGE_LINES: readonly string[] = [
  "usage:",
  "  crewhaus harness list [--group <name>] [--json]   every registered harness, joined with",
  "                                                    the on-disk inventory",
  "  crewhaus harness show <dir|hrn_id> [--json]       one harness: registry entry + inventory",
  "                                                    row + health rollup",
  "  crewhaus harness add <dir>                        register a directory (origin: manual)",
  "  crewhaus harness remove <dir|hrn_id>              drop the registry row (the directory",
  "                                                    itself is never touched)",
  "  crewhaus harness relocate <hrn_id> <newDir>       point an entry at a moved directory",
  "                                                    (same id)",
  "  crewhaus harness group <name> [--add <dir|id>] [--remove <dir|id>] [--color <c>] [--order <n>]",
  "                                                    bare form creates the group; --add/--remove",
  "                                                    manage membership",
  "  crewhaus harness tag <dir|id> (--add <tag> | --remove <tag>)",
  "  crewhaus harness pin <dir|id> [--off]             pinned entries survive prune prompts",
  "  crewhaus harness scan [--root <dir>]              discover harnesses (dirs carrying a",
  "                                                    crewhaus.yaml) under the given root — or",
  "                                                    all configured scan roots — and upsert",
  "                                                    each (origin: scan)",
  "  crewhaus harness preflight <dir|id> [--json]      typed will-it-boot checks (credentials,",
  "                                                    channel env, MCP refs, ports, bundle",
  "                                                    freshness); exits 1 on blocking findings",
  "",
  "  The registry is one JSON file, <registry-root>/harnesses.json",
  "  (CREWHAUS_REGISTRY_ROOT, default ~/.crewhaus). CREWHAUS_NO_REGISTRY=1",
  "  turns every write into a no-op. run/compile/eval/dev self-register the",
  "  harnesses they touch (origin: run-hook), so `harness list` fills itself.",
];

// ---------------------------------------------------------------------------
// Tiny per-verb flag parsing (route.ts posture: throw plain Errors)
// ---------------------------------------------------------------------------

type VerbFlagSpec = Readonly<Record<string, "value" | "boolean">>;

type VerbArgs = {
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
};

function parseVerbArgs(verb: string, argv: readonly string[], spec: VerbFlagSpec): VerbArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const kind = spec[name];
      if (kind === undefined) {
        const known = Object.keys(spec).map((k) => `--${k}`);
        throw new Error(
          `harness ${verb}: unknown flag "${a}"${known.length > 0 ? ` (expected: ${known.join(", ")})` : ""}`,
        );
      }
      if (kind === "value") {
        const v = argv[i + 1];
        if (v === undefined) throw new Error(`harness ${verb}: ${a} requires a value`);
        flags.set(name, v);
        i++;
      } else {
        flags.set(name, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function strFlag(args: VerbArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function boolFlag(args: VerbArgs, name: string): boolean {
  return args.flags.get(name) === true;
}

function requirePositional(verb: string, args: VerbArgs, index: number, what: string): string {
  const v = args.positional[index];
  if (v === undefined) throw new Error(`harness ${verb}: a ${what} argument is required`);
  return v;
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

function openRegistry(opts: HarnessCommandOptions): HangarRegistry {
  return openHangarRegistry({
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
}

/** Look up a registry entry by absolute/relative dir or `hrn_` id, loudly. */
function requireEntry(reg: HangarRegistry, key: string): HangarHarnessEntry {
  const entry = reg.get(key);
  if (entry === undefined) {
    throw new Error(`no registered harness matches "${key}" — see \`crewhaus harness list\``);
  }
  return entry;
}

/** Lenient spec-header read for a registered dir: a missing directory or an
 *  unreadable/absent crewhaus.yaml degrades to undefined — the row still
 *  renders from the registry's own descriptive fields. */
function lenientHeader(dir: string): SpecHeader | undefined {
  try {
    return readSpecHeader(readFileSync(join(dir, HARNESS_SPEC_FILENAME), "utf-8"));
  } catch {
    return undefined;
  }
}

/** One line when registry writes are disabled, so a mutating verb that
 *  silently persisted nothing says so instead of lying. */
function disabledNote(reg: HangarRegistry): string[] {
  return reg.disabled
    ? ["note: CREWHAUS_NO_REGISTRY is set — registry writes are disabled, nothing was persisted"]
    : [];
}

function jsonLines(value: unknown): string[] {
  return JSON.stringify(value, null, 2).split("\n");
}

/**
 * The real reader seams for the inventory join — the same wiring `crewhaus
 * fleet` injects: the harness's own `.crewhaus/specs` registry manifest and
 * its `.crewhaus/evals/index.jsonl` (newest entry per runId).
 */
function inventoryDeps(): BuildInventoryDeps {
  return {
    readManifest: async (specName, registryRoot) => {
      try {
        const reg = createFileBackedRegistry({ rootDir: registryRoot });
        const manifest = await reg.manifest(specName);
        // An empty manifest (no versions, no pins) means "not registered".
        if (manifest.versions.length === 0 && Object.keys(manifest.pins).length === 0) {
          return undefined;
        }
        return manifest;
      } catch {
        return undefined;
      }
    },
    readEvalIndex: (evalsDir) =>
      readRunIndexLatest(evalsDir).map((e) => ({
        datasetName: e.datasetName,
        passRate: e.passRate,
        ts: e.ts,
      })),
  };
}

/** The baseline-comparison eval-health reader `fleet status` wires: healthy
 *  unless the newest run for a pinned (spec, dataset) baseline fell below
 *  the baseline run's pass rate. */
const readEvalHealth: EvalHealthReader = (evalsDir) => {
  const runs = readRunIndexLatest(evalsDir);
  if (runs.length === 0) return { healthy: true, note: "no runs recorded" };
  const baselines = readBaselines(evalsDir);
  const baselineList = Object.values(baselines);
  if (baselineList.length === 0) {
    return { healthy: true, note: `${runs.length} run(s), no baseline pinned` };
  }
  let regressed = false;
  const notes: string[] = [];
  for (const b of baselineList) {
    const forKey = runs
      .filter((r) => r.specName === b.specName && r.datasetName === b.datasetName)
      .sort((x, y) => (x.ts < y.ts ? -1 : 1));
    const latest = forKey[forKey.length - 1];
    const baselineRun = runs.find((r) => r.runId === b.runId);
    if (latest === undefined || baselineRun === undefined) continue;
    if (latest.passRate < baselineRun.passRate) {
      regressed = true;
      notes.push(
        `${b.datasetName} ${(latest.passRate * 100).toFixed(0)}% < baseline ${(baselineRun.passRate * 100).toFixed(0)}%`,
      );
    }
  }
  return regressed
    ? { healthy: false, note: `below baseline: ${notes.join("; ")}` }
    : { healthy: true, note: "all baselines held" };
};

// ---------------------------------------------------------------------------
// Rendering (fleet's bullet style, so the two views read as one family)
// ---------------------------------------------------------------------------

/** The registry half of a row: identity, provenance, user-managed fields. */
function entryLines(e: HangarHarnessEntry, header: SpecHeader | undefined): string[] {
  const lines: string[] = [`• ${e.specName}  (${e.dir})`];
  const shape = header?.target ?? e.target;
  const model = header?.model ?? "?";
  lines.push(`    shape=${shape} model=${model}`);
  const facts = [
    `id=${e.id}`,
    `origin=${e.origin}${e.originDetail !== "" ? `/${e.originDetail}` : ""}`,
  ];
  if (e.pinned) facts.push("pinned");
  if (e.groups.length > 0) facts.push(`groups: ${[...e.groups].join(", ")}`);
  if (e.tags.length > 0) facts.push(`tags: ${[...e.tags].join(", ")}`);
  lines.push(`    ${facts.join("  ")}`);
  if (e.missingSince !== null) {
    lines.push(`    ⚠ missing since ${e.missingSince} — relocate or remove`);
  }
  return lines;
}

/** The inventory half of a row, matching `fleet list`'s per-harness lines. */
function inventoryRowLines(inv: HarnessInventory): string[] {
  const lines: string[] = [];
  const ver = inv.registry.latestVersion ?? "unregistered";
  const pins = Object.entries(inv.registry.pins);
  const pinStr = pins.length === 0 ? "no pins" : pins.map(([e, v]) => `${e}→${v}`).join(", ");
  lines.push(`    registry=${ver}  pins: ${pinStr}`);
  if (inv.lastEval !== undefined) {
    lines.push(
      `    last eval: ${(inv.lastEval.passRate * 100).toFixed(1)}% pass (${inv.lastEval.datasetName}, ${inv.lastEval.ts})`,
    );
  } else {
    lines.push("    last eval: none recorded");
  }
  lines.push(`    sessions=${inv.sessionCount}  feedback=${inv.feedbackCount}`);
  if (inv.specUnreadable) lines.push("    ⚠ spec file unreadable");
  return lines;
}

/** The health rollup for `show`, matching `fleet status`'s flag line. */
function healthLines(h: HarnessHealth): string[] {
  const flags: string[] = [];
  flags.push(h.registered ? "registered" : "unregistered");
  flags.push(h.evalHealthy ? "eval:ok" : "eval:attention");
  if (h.openIncidents > 0) flags.push(`incidents:${h.openIncidents}`);
  if (h.hasAudit) flags.push("audit");
  const lines = [`    health ${healthMark(h)}: ${flags.join("  ")}`, `    eval: ${h.evalNote}`];
  if (h.pinnedEnvs.length > 0) lines.push(`    pinned envs: ${h.pinnedEnvs.join(", ")}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

function harnessList(reg: HangarRegistry, argv: readonly string[]): HarnessCommandResult {
  const args = parseVerbArgs("list", argv, { group: "value", json: "boolean" });
  const group = strFlag(args, "group");
  let entries = reg.list();
  if (group !== undefined) entries = entries.filter((e) => e.groups.includes(group));
  const rows = entries.map((entry) => ({ entry, header: lenientHeader(entry.dir) }));
  if (boolFlag(args, "json")) {
    return {
      lines: jsonLines(rows.map(({ entry, header }) => ({ ...entry, header: header ?? null }))),
      exitCode: 0,
    };
  }
  if (rows.length === 0) {
    const scoped = group !== undefined ? ` in group "${group}"` : "";
    return {
      lines: [
        `no harnesses registered${scoped} (registry ${reg.path}) — try \`crewhaus harness add <dir>\` or \`crewhaus harness scan --root <dir>\``,
      ],
      exitCode: 0,
    };
  }
  const scoped = group !== undefined ? ` in group "${group}"` : "";
  const lines: string[] = [
    `${rows.length} registered harness(es)${scoped} (registry ${reg.path}):`,
    "",
  ];
  for (const { entry, header } of rows) lines.push(...entryLines(entry, header));
  return { lines, exitCode: 0 };
}

async function harnessShow(
  reg: HangarRegistry,
  argv: readonly string[],
): Promise<HarnessCommandResult> {
  const args = parseVerbArgs("show", argv, { json: "boolean" });
  const key = requirePositional("show", args, 0, "<dir|hrn_id>");
  const entry = requireEntry(reg, key);
  const alive = entry.missingSince === null && existsSync(entry.dir);
  let inventory: HarnessInventory | undefined;
  let health: HarnessHealth | undefined;
  if (alive) {
    inventory = await buildHarnessInventory(
      { dir: entry.dir, specPath: join(entry.dir, HARNESS_SPEC_FILENAME) },
      inventoryDeps(),
    );
    health = await buildHarnessHealth(inventory, readEvalHealth);
  }
  if (boolFlag(args, "json")) {
    return {
      lines: jsonLines({ entry, inventory: inventory ?? null, health: health ?? null }),
      exitCode: 0,
    };
  }
  const lines = entryLines(entry, inventory?.header ?? lenientHeader(entry.dir));
  if (inventory !== undefined) lines.push(...inventoryRowLines(inventory));
  if (health !== undefined) lines.push(...healthLines(health));
  lines.push(`    registered ${entry.registeredAt}  last seen ${entry.lastSeen}`);
  if (entry.notes !== "") lines.push(`    notes: ${entry.notes}`);
  return { lines, exitCode: 0 };
}

function harnessAdd(reg: HangarRegistry, argv: readonly string[]): HarnessCommandResult {
  const args = parseVerbArgs("add", argv, {});
  const dir = resolve(requirePositional("add", args, 0, "<dir>"));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`harness add: no directory at ${dir}`);
  }
  const lines: string[] = [];
  const header = lenientHeader(dir);
  // Warn-not-fail on a missing/unreadable spec: registering a directory the
  // user is still scaffolding is legitimate; the list view keeps flagging it.
  if (header === undefined) {
    lines.push(
      `⚠ no readable ${HARNESS_SPEC_FILENAME} in ${dir} — registered anyway (the inventory join will show it as spec-less until one exists)`,
    );
  }
  const existing = reg.get(dir);
  const entry = reg.upsert({
    dir,
    ...(header?.name !== undefined ? { specName: header.name } : {}),
    ...(header?.target !== undefined ? { target: header.target } : {}),
    origin: "manual",
    originDetail: "harness add",
  });
  lines.push(
    `${existing === undefined ? "registered" : "refreshed"} ${entry.specName} (${entry.id}) at ${entry.dir}`,
  );
  lines.push(...disabledNote(reg));
  return { lines, exitCode: 0 };
}

function harnessRemove(reg: HangarRegistry, argv: readonly string[]): HarnessCommandResult {
  const args = parseVerbArgs("remove", argv, {});
  const key = requirePositional("remove", args, 0, "<dir|hrn_id>");
  const entry = requireEntry(reg, key);
  reg.remove(entry.id);
  return {
    lines: [
      `removed ${entry.specName} (${entry.id}) from the registry — the directory itself is untouched`,
      ...disabledNote(reg),
    ],
    exitCode: 0,
  };
}

function harnessRelocate(reg: HangarRegistry, argv: readonly string[]): HarnessCommandResult {
  const args = parseVerbArgs("relocate", argv, {});
  const key = requirePositional("relocate", args, 0, "<hrn_id>");
  const newDir = resolve(requirePositional("relocate", args, 1, "<newDir>"));
  const entry = requireEntry(reg, key);
  if (!existsSync(newDir) || !statSync(newDir).isDirectory()) {
    throw new Error(`harness relocate: no directory at ${newDir}`);
  }
  const from = entry.dir;
  // relocate() itself throws when newDir already belongs to another entry.
  const moved = reg.relocate(entry.id, newDir);
  if (moved === undefined) {
    throw new Error(`no registered harness matches "${key}" — see \`crewhaus harness list\``);
  }
  return {
    lines: [
      `relocated ${moved.specName} (${moved.id}): ${from} → ${moved.dir}`,
      ...disabledNote(reg),
    ],
    exitCode: 0,
  };
}

function harnessGroup(reg: HangarRegistry, argv: readonly string[]): HarnessCommandResult {
  const args = parseVerbArgs("group", argv, {
    add: "value",
    remove: "value",
    color: "value",
    order: "value",
  });
  const name = requirePositional("group", args, 0, "<name>");
  const addKey = strFlag(args, "add");
  const removeKey = strFlag(args, "remove");
  const color = strFlag(args, "color");
  const orderFlag = strFlag(args, "order");
  if (addKey !== undefined && removeKey !== undefined) {
    throw new Error("harness group: --add and --remove are mutually exclusive");
  }

  const lines: string[] = [];
  // The bare form creates; every other form ensures the definition exists
  // (idempotent by name) and applies --color when given.
  const before = reg.listGroups().find((g) => g.name === name);
  const def = reg.addGroup({ name, ...(color !== undefined ? { color } : {}) });
  if (before === undefined) {
    lines.push(
      `group ${def.name} created (order ${def.order}${def.color !== "" ? `, color ${def.color}` : ""})`,
    );
  } else if (color !== undefined && color !== before.color) {
    lines.push(`group ${name} recolored to ${color}`);
  }

  if (orderFlag !== undefined) {
    const n = Number.parseInt(orderFlag, 10);
    if (Number.isNaN(n) || n < 1 || String(n) !== orderFlag.trim()) {
      throw new Error(`harness group: --order must be a positive integer (got "${orderFlag}")`);
    }
    const names = reg
      .listGroups()
      .map((g) => g.name)
      .filter((g) => g !== name);
    const at = Math.min(n - 1, names.length);
    names.splice(at, 0, name);
    reg.reorderGroups(names);
    lines.push(`group ${name} moved to position ${at + 1}`);
  }

  if (addKey !== undefined) {
    const entry = requireEntry(reg, addKey);
    if (entry.groups.includes(name)) {
      lines.push(`${entry.specName} (${entry.id}) is already in group ${name}`);
    } else {
      reg.setGroups(entry.id, [...entry.groups, name]);
      lines.push(`added ${entry.specName} (${entry.id}) to group ${name}`);
    }
  }
  if (removeKey !== undefined) {
    const entry = requireEntry(reg, removeKey);
    if (!entry.groups.includes(name)) {
      lines.push(`${entry.specName} (${entry.id}) is not in group ${name}`);
    } else {
      reg.setGroups(
        entry.id,
        entry.groups.filter((g) => g !== name),
      );
      lines.push(`removed ${entry.specName} (${entry.id}) from group ${name}`);
    }
  }

  if (lines.length === 0) lines.push(`group ${name} unchanged (order ${def.order})`);
  lines.push(...disabledNote(reg));
  return { lines, exitCode: 0 };
}

function harnessTag(reg: HangarRegistry, argv: readonly string[]): HarnessCommandResult {
  const args = parseVerbArgs("tag", argv, { add: "value", remove: "value" });
  const key = requirePositional("tag", args, 0, "<dir|hrn_id>");
  const addTag = strFlag(args, "add");
  const removeTag = strFlag(args, "remove");
  if ((addTag === undefined) === (removeTag === undefined)) {
    throw new Error("harness tag: exactly one of --add <tag> or --remove <tag> is required");
  }
  const entry = requireEntry(reg, key);
  const lines: string[] = [];
  if (addTag !== undefined) {
    if (entry.tags.includes(addTag)) {
      lines.push(`${entry.specName} (${entry.id}) already carries tag ${addTag}`);
    } else {
      reg.setTags(entry.id, [...entry.tags, addTag]);
      lines.push(`tagged ${entry.specName} (${entry.id}) with ${addTag}`);
    }
  } else if (removeTag !== undefined) {
    if (!entry.tags.includes(removeTag)) {
      lines.push(`${entry.specName} (${entry.id}) does not carry tag ${removeTag}`);
    } else {
      reg.setTags(
        entry.id,
        entry.tags.filter((t) => t !== removeTag),
      );
      lines.push(`untagged ${entry.specName} (${entry.id}) — removed ${removeTag}`);
    }
  }
  lines.push(...disabledNote(reg));
  return { lines, exitCode: 0 };
}

function harnessPin(reg: HangarRegistry, argv: readonly string[]): HarnessCommandResult {
  const args = parseVerbArgs("pin", argv, { off: "boolean" });
  const key = requirePositional("pin", args, 0, "<dir|hrn_id>");
  const off = boolFlag(args, "off");
  const entry = requireEntry(reg, key);
  reg.setPinned(entry.id, !off);
  return {
    lines: [`${off ? "unpinned" : "pinned"} ${entry.specName} (${entry.id})`, ...disabledNote(reg)],
    exitCode: 0,
  };
}

function harnessScan(
  reg: HangarRegistry,
  argv: readonly string[],
  opts: HarnessCommandOptions,
): HarnessCommandResult {
  const args = parseVerbArgs("scan", argv, { root: "value" });
  const rootFlag = strFlag(args, "root");
  let roots: string[];
  if (rootFlag !== undefined) {
    const dir = resolve(rootFlag);
    // An explicitly scanned root becomes a configured scan root, so the next
    // bare `harness scan` covers it too.
    reg.addScanRoot({ dir });
    roots = [dir];
  } else {
    roots = reg.listScanRoots().map((r) => r.dir);
    if (roots.length === 0) {
      throw new Error(
        "harness scan: no scan roots configured — pass --root <dir> (it is remembered as a scan root for future scans)",
      );
    }
  }

  const nowIso = new Date((opts.now ?? Date.now)()).toISOString();
  const lines: string[] = [];
  let added = 0;
  let refreshed = 0;
  for (const root of roots) {
    let found: ReturnType<typeof discoverHarnesses>;
    try {
      found = discoverHarnesses(root);
    } catch (err) {
      // A vanished/unreadable root must not abort the other roots' scans.
      lines.push(`⚠ ${root}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const h of found) {
      const header = lenientHeader(h.dir);
      const existing = reg.get(h.dir);
      reg.upsert({
        dir: h.dir,
        ...(header?.name !== undefined ? { specName: header.name } : {}),
        ...(header?.target !== undefined ? { target: header.target } : {}),
        origin: "scan",
        originDetail: root,
      });
      if (existing === undefined) added += 1;
      else refreshed += 1;
    }
    reg.updateScanRoot(root, { lastScanAt: nowIso });
  }

  // list() freshly stamps missingSince, so vanished registered dirs under the
  // scanned roots are counted (never pruned — that is remove()'s job).
  const missing = reg
    .list()
    .filter(
      (e) => e.missingSince !== null && roots.some((r) => e.dir === r || e.dir.startsWith(`${r}/`)),
    ).length;
  lines.push(
    `scan: ${added} added, ${refreshed} refreshed, ${missing} missing (${roots.length} root(s))`,
  );
  lines.push(...disabledNote(reg));
  return { lines, exitCode: 0 };
}

async function harnessPreflight(
  reg: HangarRegistry,
  argv: readonly string[],
  opts: HarnessCommandOptions,
): Promise<HarnessCommandResult> {
  const args = parseVerbArgs("preflight", argv, { json: "boolean" });
  const key = requirePositional("preflight", args, 0, "<dir|hrn_id>");
  const entry = reg.get(key);
  let dir: string;
  let label: string;
  if (entry !== undefined) {
    dir = entry.dir;
    label = entry.specName;
  } else {
    // An unregistered directory is still preflightable — the checks read the
    // disk, not the registry.
    const asDir = resolve(key);
    if (!existsSync(asDir) || !statSync(asDir).isDirectory()) {
      throw new Error(`no registered harness (or directory) matches "${key}"`);
    }
    dir = asDir;
    label = asDir;
  }
  const report = await preflightHarness(dir, { env: opts.env ?? process.env });
  const exitCode: 0 | 1 = report.ok ? 0 : 1;
  if (boolFlag(args, "json")) return { lines: jsonLines(report), exitCode };
  const lines: string[] = [`preflight ${label} (${dir}):`, ""];
  for (const item of report.items) {
    const mark = item.level === "blocking" ? "✗" : item.level === "warn" ? "⚠" : "✓";
    lines.push(`${mark} ${item.message}`);
    if (item.level !== "info" && item.remediation !== undefined) {
      lines.push(`    fix: ${item.remediation}`);
    }
  }
  lines.push("");
  lines.push(
    report.ok
      ? `${report.items.length} check(s), no blocking findings — the harness should boot`
      : `${report.items.length} check(s), ${report.blocking.length} blocking — fix the ✗ items before spawning`,
  );
  return { lines, exitCode };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Run `crewhaus harness <verb> …`. Bad arguments throw plain `Error`s (the
 *  entry file routes them through `die()`); everything else returns lines +
 *  an exit code. */
export async function runHarnessCommand(
  argv: readonly string[],
  opts: HarnessCommandOptions = {},
): Promise<HarnessCommandResult> {
  const verb = argv[0] ?? "";
  if (verb === "" || verb === "--help" || verb === "-h") {
    return { lines: HARNESS_USAGE_LINES, exitCode: 0 };
  }
  const reg = openRegistry(opts);
  const rest = argv.slice(1);
  switch (verb) {
    case "list":
      return harnessList(reg, rest);
    case "show":
      return await harnessShow(reg, rest);
    case "add":
      return harnessAdd(reg, rest);
    case "remove":
      return harnessRemove(reg, rest);
    case "relocate":
      return harnessRelocate(reg, rest);
    case "group":
      return harnessGroup(reg, rest);
    case "tag":
      return harnessTag(reg, rest);
    case "pin":
      return harnessPin(reg, rest);
    case "scan":
      return harnessScan(reg, rest, opts);
    case "preflight":
      return await harnessPreflight(reg, rest, opts);
    default:
      throw new Error(
        `unknown harness verb "${verb}" (expected: list | show | add | remove | relocate | group | tag | pin | scan | preflight)`,
      );
  }
}
