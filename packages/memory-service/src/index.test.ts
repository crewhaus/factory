/**
 * The composition-root wiring matrix (design §10, PR 10): fragment →
 * stores → tools → seams for every feature combination, plus scope/tenant
 * passthrough, the reserved thredz backend, default-skill merge precedence,
 * and the provenance-stamping capture path.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HandoffInput, RunChatLoopOptions } from "@crewhaus/runtime-core";
import { buildTenant } from "@crewhaus/tenancy";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  type ContinuitySeam,
  DREAM_BOOT_CATCHUP_NOTE,
  type MemorySeam,
  MemoryServiceError,
  type MemoryWiringFragment,
  type WireMemoryDeps,
  createDreamJanitorStep,
  memoryFragmentFromIr,
  runDreamBootCatchUp,
  wireContinuity,
  wireDream,
  wireMemory,
  wireWiki,
} from "./index";

const SESSION_ID = "sess_0123456789abcdef";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "memory-service-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function collectingCatalog(): { registered: RegisteredTool[]; register(t: RegisteredTool): void } {
  const registered: RegisteredTool[] = [];
  return {
    registered,
    register(t: RegisteredTool) {
      registered.push(t);
    },
  };
}

function deps(overrides: Partial<WireMemoryDeps> = {}) {
  const catalog = collectingCatalog();
  const base: WireMemoryDeps = {
    catalog,
    cwd: tmp,
    homeDir: join(tmp, "home"), // isolate from the real ~/.crewhaus
    ...overrides,
  };
  return { deps: base, catalog };
}

function names(tools: readonly RegisteredTool[]): string[] {
  return tools.map((t) => t.name);
}

/** Write a minimal session event log the capture path can read. */
function writeSessionLog(dir: string, sessionId: string): void {
  const events = [
    { kind: "user_message", payload: { content: "What is the CSV delimiter for EU locales?" } },
    { kind: "tool_result", payload: { toolUseId: "tu_proof_1", isError: false } },
    { kind: "tool_result", payload: { toolUseId: "tu_bad", isError: true } },
    {
      kind: "assistant_message",
      payload: { content: "EU locales conventionally use semicolon-delimited CSV." },
    },
  ];
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
}

const MEMORY_TOOLS = ["Remember", "Recall", "MemoryForget"];
const CONTINUITY_TOOLS = [
  "FocusRead",
  "FocusWrite",
  "PlanRead",
  "PlanUpdate",
  "PlanComplete",
  "GoalWrite",
  "GoalUpdate",
  "GoalList",
  "MemoryClear",
];
const WIKI_TOOLS = [
  "wiki_recall",
  "wiki_semantic_search",
  "wiki_search",
  "wiki_get",
  "wiki_write",
  "wiki_list",
  "wiki_related",
  "wiki_set_signals",
  "wiki_stats",
  "log_knowledge_gap",
];

describe("wireMemory — the matrix", () => {
  test("none: an empty fragment wires nothing", async () => {
    const { deps: d, catalog } = deps();
    const wired = await wireMemory({ specName: "matrix-none" }, d);
    expect(catalog.registered).toEqual([]);
    expect(wired.tools).toEqual([]);
    expect(wired.stores).toEqual({});
    expect(Object.keys(wired.options)).toEqual([]);
    // Nothing on disk either — absence stays absent.
    expect(existsSync(join(tmp, ".crewhaus"))).toBe(false);
  });

  test("memory: {enabled: false} wires nothing (the legacy gate)", async () => {
    const { deps: d, catalog } = deps();
    const wired = await wireMemory(
      { specName: "matrix-off", memory: { enabled: false, autoRecall: true } },
      d,
    );
    expect(catalog.registered).toEqual([]);
    expect(Object.keys(wired.options)).toEqual([]);
    expect(wired.stores.memory).toBeUndefined();
  });

  test("memory only: Remember/Recall/MemoryForget with the pinned flags + the memory seam", async () => {
    const { deps: d, catalog } = deps();
    const wired = await wireMemory(
      { specName: "matrix-mem", memory: { autoRecall: true, recallK: 3, autoCapture: true } },
      d,
    );
    expect(names(catalog.registered)).toEqual(MEMORY_TOOLS);
    expect(names(wired.tools)).toEqual(MEMORY_TOOLS);
    const byName = new Map(wired.tools.map((t) => [t.name, t]));
    expect(byName.get("Remember")?.destructive).toBe(true);
    expect(byName.get("Recall")?.readOnly).toBe(true);
    expect(byName.get("MemoryForget")?.destructive).toBe(true);
    expect(byName.get("MemoryForget")?.requireJustification).toBe(true);

    expect(wired.stores.memory).toBeDefined();
    expect(wired.options.memory?.autoRecall).toBe(true);
    expect(wired.options.memory?.recallK).toBe(3);
    expect(wired.options.memory?.autoCapture).toBe(true);
    expect(wired.options.continuity).toBeUndefined();
    expect(wired.options.skills).toBeUndefined();
    expect(wired.options.slashCommands).toBeUndefined();
  });

  test("a bare memory block yields an empty seam object (parity with both legacy paths)", async () => {
    const { deps: d } = deps();
    const wired = await wireMemory({ specName: "matrix-bare", memory: {} }, d);
    expect(wired.options.memory).toEqual({});
  });

  test("+continuity: the nine plan tools, the continuity seam, skills and commands", async () => {
    const { deps: d, catalog } = deps();
    const wired = await wireMemory(
      { specName: "matrix-cont", memory: {}, continuity: { enabled: true } },
      d,
    );
    expect(names(catalog.registered)).toEqual([...MEMORY_TOOLS, ...CONTINUITY_TOOLS]);
    expect(wired.stores.continuity).toBeDefined();
    expect(wired.options.continuity?.ledger).toBe(true);
    expect(wired.options.continuity?.onHandoff).toBeDefined();
    // Skills: the builtin continuity skill reaches the seam.
    expect(wired.options.skills?.map((s) => s.name)).toContain("continuity");
    // Commands: continuity set + /forget (memory is on); no /dream, /study,
    // /reflect, /exam until their engines land (PR 14/17).
    const commandNames = [...(wired.options.slashCommands?.keys() ?? [])].sort();
    expect(commandNames).toEqual(
      ["plan", "focus", "next", "handoff", "clear-plan", "clear-focus", "forget"].sort(),
    );
  });

  test("continuity without memory: no /forget (MemoryForget is not registered)", async () => {
    const { deps: d, catalog } = deps();
    const wired = await wireMemory({ specName: "matrix-cont-only", continuity: {} }, d);
    expect(names(catalog.registered)).toEqual(CONTINUITY_TOOLS);
    expect(wired.options.memory).toBeUndefined();
    const commandNames = [...(wired.options.slashCommands?.keys() ?? [])];
    expect(commandNames).not.toContain("forget");
    expect(commandNames).toContain("plan");
  });

  test("continuity plan:false keeps only the focus pair + MemoryClear", async () => {
    const { deps: d, catalog } = deps();
    await wireMemory({ specName: "matrix-nofplan", continuity: { plan: false } }, d);
    expect(names(catalog.registered)).toEqual(["FocusRead", "FocusWrite", "MemoryClear"]);
  });

  test("+wiki: the ten thredz-vocabulary tools", async () => {
    const { deps: d, catalog } = deps();
    const wired = await wireMemory(
      { specName: "matrix-wiki", memory: { wiki: { enabled: true } } },
      d,
    );
    expect(names(catalog.registered)).toEqual([...MEMORY_TOOLS, ...WIKI_TOOLS]);
    expect(wired.stores.wiki).toBeDefined();
  });

  test("all: memory + continuity + wiki, in registration order", async () => {
    const { deps: d, catalog } = deps();
    const wired = await wireMemory(
      {
        specName: "matrix-all",
        memory: { autoRecall: true, wiki: { enabled: true } },
        continuity: {},
      },
      d,
    );
    expect(names(catalog.registered)).toEqual([
      ...MEMORY_TOOLS,
      ...CONTINUITY_TOOLS,
      ...WIKI_TOOLS,
    ]);
    expect(wired.stores.memory).toBeDefined();
    expect(wired.stores.continuity).toBeDefined();
    expect(wired.stores.wiki).toBeDefined();
    expect(Object.keys(wired.options).sort()).toEqual(
      ["continuity", "memory", "skills", "slashCommands"].sort(),
    );
  });
});

describe("wireMemory — seams behavior", () => {
  test("recall seam round-trips facts from the store", async () => {
    const { deps: d } = deps();
    const wired = await wireMemory(
      { specName: "seam-recall", memory: { autoRecall: true, recallK: 5 } },
      d,
    );
    await wired.stores.memory?.remember("the deploy password hint is stored in vault");
    const lines = await wired.options.memory?.recall?.("deploy vault", 5);
    expect(lines).toEqual(["the deploy password hint is stored in vault"]);
  });

  test("onCapture stamps provenance {sessionId, evidence} from the session log (§2.4)", async () => {
    const { deps: d } = deps();
    writeSessionLog(join(tmp, ".crewhaus", "sessions"), SESSION_ID);
    const wired = await wireMemory({ specName: "seam-capture", memory: { autoCapture: true } }, d);
    await wired.options.memory?.onCapture?.(1, SESSION_ID);
    const items = await wired.stores.memory?.list();
    expect(items?.length).toBe(1);
    const entry = items?.[0]?.entry;
    expect(entry?.text).toBe("EU locales conventionally use semicolon-delimited CSV.");
    expect(entry?.tags).toEqual(["auto-capture", SESSION_ID]);
    expect(entry?.provenance?.sessionId).toBe(SESSION_ID);
    // Only the SUCCESSFUL tool result is evidence — tu_bad (isError) is not.
    expect(entry?.provenance?.evidence).toEqual(["tu_proof_1"]);
  });

  test("onCapture honours the threshold and ttlMs", async () => {
    const { deps: d } = deps();
    writeSessionLog(join(tmp, ".crewhaus", "sessions"), SESSION_ID);
    const wired = await wireMemory(
      {
        specName: "seam-ttl",
        memory: { autoCapture: true, autoCaptureThreshold: 3, ttlMs: 60_000 },
      },
      d,
    );
    await wired.options.memory?.onCapture?.(2, SESSION_ID); // below threshold
    expect(await wired.stores.memory?.size()).toBe(0);
    await wired.options.memory?.onCapture?.(3, SESSION_ID);
    const items = await wired.stores.memory?.list();
    expect(items?.length).toBe(1);
    expect(items?.[0]?.entry.expiresAt).toBeDefined();
  });

  test("continuity seam: loadPlan renders focus + active plan + goals; handoff writes handoff.md", async () => {
    const { deps: d } = deps();
    const wired = await wireMemory({ specName: "seam-cont", continuity: {} }, d);
    const store = wired.stores.continuity;
    if (store === undefined) throw new Error("continuity store expected");
    expect(await wired.options.continuity?.loadPlan()).toBeNull();

    await store.writeFocus("ship the CSV export");
    await store.createPlan({ title: "CSV export", steps: ["write parser", "add tests"] });
    await store.writeGoal({ title: "export adoption", target: 10, current: 2 });
    const tail = await wired.options.continuity?.loadPlan();
    expect(tail).toContain("focus: ship the CSV export");
    expect(tail).toContain("plan-0001 — CSV export");
    expect(tail).toContain("1. [open] write parser");
    expect(tail).toContain("goal-0001 [open] export adoption (2/10)");
    // onPlanDirty re-renders the same content from the store.
    expect(await wired.options.continuity?.onPlanDirty?.()).toBe(tail as string);

    await wired.options.continuity?.onHandoff?.({
      plan: tail ?? null,
      ledger: [],
      sessionId: SESSION_ID,
      stopReason: "complete",
    });
    const handoffPath = join(tmp, ".crewhaus", "state", "seam-cont", "handoff.md");
    expect(existsSync(handoffPath)).toBe(true);
    expect(readFileSync(handoffPath, "utf8")).toContain(SESSION_ID);
  });

  test("continuity ledger/handoff flags thread through (§2.1)", async () => {
    const { deps: d } = deps();
    const wired = await wireMemory(
      { specName: "seam-flags", continuity: { ledger: false, handoff: false } },
      d,
    );
    expect(wired.options.continuity?.ledger).toBe(false);
    expect(wired.options.continuity?.onHandoff).toBeUndefined();
  });

  test("wiki gaps land in the plan store as [gap] goals when continuity is on (§3.2)", async () => {
    const { deps: d, catalog } = deps();
    const wired = await wireMemory(
      { specName: "seam-gap", memory: { wiki: {} }, continuity: {} },
      d,
    );
    const logGap = catalog.registered.find((t) => t.name === "log_knowledge_gap");
    const result = await logGap?.execute({ topic: "EU CSV quirks", priority: "high" });
    expect(String(result)).toContain("goal-0001");
    const goals = await wired.stores.continuity?.listGoals();
    expect(goals?.map((g) => g.title)).toEqual(["[gap] EU CSV quirks"]);
  });

  test("wiki gaps fall back to the wiki itself without continuity", async () => {
    const { deps: d, catalog } = deps();
    const wired = await wireMemory({ specName: "seam-gap-solo", memory: { wiki: {} } }, d);
    const logGap = catalog.registered.find((t) => t.name === "log_knowledge_gap");
    const result = await logGap?.execute({ topic: "EU CSV quirks" });
    expect(String(result)).toContain("gap-eu-csv-quirks");
    expect(await wired.stores.wiki?.get("gap-eu-csv-quirks")).not.toBeNull();
  });

  test("wiki embedder factory string enables hybrid recall + semantic search", async () => {
    const { deps: d, catalog } = deps();
    const wired = await wireMemory(
      { specName: "seam-embed", memory: { wiki: { embedder: "mock/deterministic" } } },
      d,
    );
    expect(wired.stores.wiki?.semanticSearch).toBeDefined();
    // The same embedder upgrades the FACT store to hybrid recall (§3.4):
    // hybrid RRF scores are reciprocal-rank sums, far below BM25's scale.
    await wired.stores.memory?.remember("semicolons delimit EU csv files");
    const results = await wired.stores.memory?.recall("semicolons", 1);
    expect(results?.length).toBe(1);
    expect((results?.[0]?.score ?? 1) < 0.2).toBe(true);
    const semantic = catalog.registered.find((t) => t.name === "wiki_semantic_search");
    const out = await semantic?.execute({ query: "delimiters" });
    expect(String(out)).not.toContain("no embedder configured");
  });

  test("wiki requireSources gates wiki_write deterministically (§3.3)", async () => {
    const { deps: d, catalog } = deps();
    await wireMemory({ specName: "seam-sources", memory: { wiki: { requireSources: true } } }, d);
    const write = catalog.registered.find((t) => t.name === "wiki_write");
    const rejected = await write?.execute({ slug: "a", title: "A", body: "no citations here" });
    expect(String(rejected)).toContain("## Sources");
  });
});

describe("wireMemory — scope, tenancy, backend (§2.7, §4)", () => {
  test("continuity scope session nests the store under sessions/<id>", async () => {
    const { deps: d } = deps({ sessionScope: SESSION_ID });
    const wired = await wireMemory({ specName: "scope-sess", continuity: { scope: "session" } }, d);
    expect(wired.stores.continuity?.dir()).toBe(
      join(tmp, ".crewhaus", "state", "scope-sess", "sessions", SESSION_ID),
    );
  });

  test("scope session without deps.sessionScope fails fast", async () => {
    const { deps: d } = deps();
    await expect(
      wireMemory({ specName: "scope-missing", continuity: { scope: "session" } }, d),
    ).rejects.toThrow(MemoryServiceError);
  });

  test("tenant re-roots every store under the tenant directory", async () => {
    const tenant = buildTenant("acme", { tenantsRoot: join(tmp, "tenants") });
    const tenantRoot = join(tmp, "tenants", "acme");
    const { deps: d } = deps({ tenant });
    const wired = await wireMemory(
      {
        specName: "tenant-spec",
        memory: { wiki: {} },
        continuity: {},
      },
      d,
    );
    expect(wired.stores.continuity?.dir()).toBe(join(tenantRoot, "state", "tenant-spec"));
    expect(wired.stores.wiki?.path()).toBe(join(tenantRoot, "wiki", "tenant-spec"));
    expect(wired.stores.memory?.path()).toBe(join(tenantRoot, "memories", "tenant-spec.jsonl"));
    // Writes land inside the fence.
    await wired.stores.memory?.remember("tenant-fenced fact");
    expect(existsSync(join(tenantRoot, "memories", "tenant-spec.jsonl"))).toBe(true);
  });

  test('backend "thredz" is reserved: loud not-implemented error, nothing wired', async () => {
    const { deps: d, catalog } = deps();
    await expect(
      wireMemory({ specName: "thredz-spec", memory: { backend: "thredz" } }, d),
    ).rejects.toThrow(/backend "thredz" is reserved but not implemented yet/);
    expect(catalog.registered).toEqual([]);
  });

  test('backend "file" is the implemented default', async () => {
    const { deps: d } = deps();
    const wired = await wireMemory({ specName: "file-spec", memory: { backend: "file" } }, d);
    expect(wired.stores.memory).toBeDefined();
  });

  test("a missing specName fails fast", async () => {
    const { deps: d } = deps();
    await expect(wireMemory({ specName: "" }, d)).rejects.toThrow(MemoryServiceError);
  });
});

describe("wireMemory — default-skills merge precedence (§2.6)", () => {
  test("a project skill with the builtin's name overrides it in the seam", async () => {
    const skillDir = join(tmp, ".crewhaus", "skills", "continuity");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: continuity\ndescription: project override of the builtin\n---\nProject body wins.\n",
    );
    const { deps: d } = deps();
    const wired = await wireMemory({ specName: "skill-override", continuity: {} }, d);
    const continuity = wired.options.skills?.filter((s) => s.name === "continuity");
    expect(continuity?.length).toBe(1);
    expect(continuity?.[0]?.description).toBe("project override of the builtin");
    expect(continuity?.[0]?.filePath).toBe(join(skillDir, "SKILL.md"));
  });

  test("a project command with a builtin's name overrides it; extras pass through", async () => {
    const cmdDir = join(tmp, ".crewhaus", "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(join(cmdDir, "plan.md"), "Project plan command body.\n");
    writeFileSync(join(cmdDir, "deploy.md"), "A user command unrelated to memory.\n");
    const { deps: d } = deps();
    const wired = await wireMemory({ specName: "cmd-override", continuity: {} }, d);
    const commands = wired.options.slashCommands;
    expect(commands?.get("plan")?.body).toContain("Project plan command body.");
    // Non-builtin user commands are never filtered by the feature gate.
    expect(commands?.has("deploy")).toBe(true);
    // Builtin commands whose engines are not wired stay excluded even
    // though they exist in the builtin dir.
    expect(commands?.has("dream")).toBe(false);
    expect(commands?.has("study")).toBe(false);
  });
});

describe("granular entry points", () => {
  test("wireContinuity alone returns store + tools + seam and null when absent", async () => {
    const { deps: d } = deps();
    expect(wireContinuity({ specName: "gran-none" }, d)).toBeNull();
    expect(wireContinuity({ specName: "gran-off", continuity: { enabled: false } }, d)).toBeNull();
    const wired = wireContinuity({ specName: "gran-cont", continuity: {} }, d);
    expect(names(wired?.tools ?? [])).toEqual(CONTINUITY_TOOLS);
    expect(wired?.continuity.ledger).toBe(true);
  });

  test("wireWiki alone returns store + tools and null when absent/disabled", async () => {
    const { deps: d } = deps();
    expect(wireWiki({ specName: "gran-nowiki", memory: {} }, d)).toBeNull();
    expect(
      wireWiki({ specName: "gran-wikioff", memory: { wiki: { enabled: false } } }, d),
    ).toBeNull();
    expect(
      wireWiki({ specName: "gran-memoff", memory: { enabled: false, wiki: {} } }, d),
    ).toBeNull();
    const wired = wireWiki({ specName: "gran-wiki", memory: { wiki: {} } }, d);
    expect(names(wired?.tools ?? [])).toEqual(WIKI_TOOLS);
  });
});

describe("fragment construction — memoryFragmentFromIr", () => {
  test("carries only declared fields, exactly as renderMemory read the IR", () => {
    expect(memoryFragmentFromIr({ name: "spec-a" })).toEqual({ specName: "spec-a" });
    expect(memoryFragmentFromIr({ name: "spec-b", memory: {} })).toEqual({
      specName: "spec-b",
      memory: {},
    });
    expect(
      memoryFragmentFromIr({
        name: "spec-c",
        memory: { enabled: true, autoRecall: true, recallK: 4, autoCapture: true },
      }),
    ).toEqual({
      specName: "spec-c",
      memory: { enabled: true, autoRecall: true, recallK: 4, autoCapture: true },
    });
  });

  test("the fragment is JSON-serializable and round-trips", () => {
    const fragment = memoryFragmentFromIr({
      name: "spec-d",
      memory: { autoRecall: true, autoCaptureThreshold: 2 },
    });
    expect(JSON.parse(JSON.stringify(fragment))).toEqual(fragment);
  });
});

describe("runtime-core assignability pin", () => {
  test("wired.options spreads into RunChatLoopOptions (compile-time pin)", async () => {
    const { deps: d } = deps();
    const wired = await wireMemory(
      { specName: "pin-spec", memory: { autoRecall: true }, continuity: {} },
      d,
    );
    // The load-bearing assertion is the ASSIGNMENT typechecking: the seam
    // types this package exports must stay assignable to runtime-core's.
    const opts: RunChatLoopOptions = {
      model: "claude-sonnet-4-6",
      instructions: "pin",
      ...wired.options,
    };
    const memorySeam: RunChatLoopOptions["memory"] = wired.options.memory as MemorySeam;
    const continuitySeam: RunChatLoopOptions["continuity"] = wired.options
      .continuity as ContinuitySeam;
    const handoffInput: HandoffInput = {
      plan: null,
      ledger: [],
      sessionId: SESSION_ID,
      stopReason: "complete",
    };
    await wired.options.continuity?.onHandoff?.(handoffInput);
    expect(opts.memory).toBe(memorySeam);
    expect(opts.continuity).toBe(continuitySeam);
  });
});

describe("event seam", () => {
  test("plan and wiki mutations flow through one injected appendEvent", async () => {
    const events: Array<{ kind: string }> = [];
    const { deps: d, catalog } = deps({
      appendEvent: (e) => {
        events.push({ kind: e.kind });
      },
    });
    await wireMemory({ specName: "events", memory: { wiki: {} }, continuity: {} }, d);
    const planUpdate = catalog.registered.find((t) => t.name === "PlanUpdate");
    await planUpdate?.execute({ action: "create", title: "Event plan" });
    const wikiWrite = catalog.registered.find((t) => t.name === "wiki_write");
    await wikiWrite?.execute({ slug: "e", title: "E", body: "body" });
    expect(events.map((e) => e.kind)).toEqual(["plan_update", "wiki_write"]);
  });
});

describe("status lines (interpreter parity)", () => {
  test("deps.log receives the wired lines; absent log stays silent", async () => {
    const lines: string[] = [];
    const { deps: d } = deps({ log: (l) => lines.push(l) });
    await wireMemory(
      { specName: "log-spec", memory: { autoRecall: true, wiki: {} }, continuity: {} },
      d,
    );
    expect(lines.some((l) => l.includes("[memory] Remember/Recall/MemoryForget wired"))).toBe(true);
    expect(lines.some((l) => l.includes("[memory] continuity on"))).toBe(true);
    expect(lines.some((l) => l.includes("[memory] wiki on"))).toBe(true);
  });
});

describe("PR 11 — fragment extensions (backend/ttlMs/wiki + continuity)", () => {
  test("memoryFragmentFromIr carries the §9 memory extensions field-by-field", () => {
    expect(
      memoryFragmentFromIr({
        name: "spec-e",
        memory: {
          backend: "file",
          ttlMs: 7_776_000_000,
          autoRecall: true,
          wiki: {
            enabled: true,
            recallK: 6,
            embedder: "mock/deterministic",
            autoRecall: true,
            requireSources: true,
          },
        },
      }),
    ).toEqual({
      specName: "spec-e",
      memory: {
        backend: "file",
        ttlMs: 7_776_000_000,
        autoRecall: true,
        wiki: {
          enabled: true,
          recallK: 6,
          embedder: "mock/deterministic",
          autoRecall: true,
          requireSources: true,
        },
      },
    });
  });

  test("memoryFragmentFromIr carries the resolved IrContinuity (presence = enabled)", () => {
    expect(
      memoryFragmentFromIr({
        name: "spec-f",
        continuity: {
          plan: true,
          proof: "ladder",
          ledger: true,
          handoff: true,
          scope: "spec",
          focusMaxChars: 2048,
        },
      }),
    ).toEqual({
      specName: "spec-f",
      continuity: {
        plan: true,
        proof: "ladder",
        ledger: true,
        handoff: true,
        scope: "spec",
        focusMaxChars: 2048,
      },
    });
    expect(memoryFragmentFromIr({ name: "spec-g" })).toEqual({ specName: "spec-g" });
  });
});

describe("PR 11 — wiki auto-recall fusion (§3.4/§9)", () => {
  test("wiki.autoRecall fuses top-recallK wiki hits into the memory seam", async () => {
    const { deps: d, catalog } = deps();
    const wired = await wireMemory(
      {
        specName: "wiki-fuse",
        memory: { autoRecall: true, wiki: { enabled: true, autoRecall: true, recallK: 2 } },
      },
      d,
    );
    const wikiWrite = catalog.registered.find((t) => t.name === "wiki_write");
    await wikiWrite?.execute({
      slug: "csv-delimiters",
      title: "CSV delimiter conventions",
      body: "EU locales conventionally use semicolon-delimited CSV.",
    });
    const seam = wired.options.memory;
    expect(seam?.autoRecall).toBe(true);
    const lines = await seam?.recall?.("csv delimiter conventions", 5);
    expect(lines?.some((l) => l.startsWith("[wiki:csv-delimiters]"))).toBe(true);
    expect(lines?.some((l) => l.includes("semicolon-delimited"))).toBe(true);
  });

  test("wiki.autoRecall turns the seam on even when the fact store's is off", async () => {
    const { deps: d } = deps();
    const wired = await wireMemory(
      { specName: "wiki-only-recall", memory: { wiki: { enabled: true, autoRecall: true } } },
      d,
    );
    expect(wired.options.memory?.autoRecall).toBe(true);
    expect(wired.options.memory?.recall).toBeDefined();
  });

  test("without wiki.autoRecall the seam is untouched (fact recall only)", async () => {
    const { deps: d } = deps();
    const wired = await wireMemory(
      { specName: "wiki-no-fuse", memory: { autoRecall: true, wiki: { enabled: true } } },
      d,
    );
    const lines = await wired.options.memory?.recall?.("anything", 3);
    expect(lines?.every((l) => !l.startsWith("[wiki:"))).toBe(true);
  });
});

describe("PR 11 — continuity.proof carried-but-degraded (§2.4)", () => {
  test('proof "require"/"off" log the degrade note; "ladder"/absent stay silent', async () => {
    for (const [proof, expectNote] of [
      ["require", true],
      ["off", true],
      ["ladder", false],
      [undefined, false],
    ] as const) {
      const lines: string[] = [];
      const { deps: d } = deps({ log: (l) => lines.push(l) });
      await wireMemory(
        {
          specName: `proof-${proof ?? "absent"}`,
          continuity: proof !== undefined ? { proof } : {},
        },
        d,
      );
      expect(lines.some((l) => l.includes("carried but not enforced yet"))).toBe(expectNote);
    }
  });
});

describe("PR 11 — deps.sessionRootDir override (§7.2 eval isolation)", () => {
  test("the capture path reads transcripts from the overridden session root", async () => {
    const sessionRoot = join(tmp, "custom-sessions");
    writeSessionLog(sessionRoot, SESSION_ID);
    const { deps: d } = deps({ sessionRootDir: sessionRoot });
    const wired = await wireMemory(
      { specName: "session-root-override", memory: { autoCapture: true } },
      d,
    );
    await wired.options.memory?.onCapture?.(3, SESSION_ID);
    const factsPath = join(tmp, ".crewhaus", "memories", "session-root-override.jsonl");
    expect(existsSync(factsPath)).toBe(true);
    expect(readFileSync(factsPath, "utf-8")).toContain("semicolon-delimited");
  });
});

// Fragment shape sanity: the type is what PR 11's IR lowering targets.
const _fragmentShape: MemoryWiringFragment = {
  specName: "shape",
  memory: {
    enabled: true,
    backend: "file",
    ttlMs: 1000,
    autoCapture: true,
    autoCaptureThreshold: 2,
    autoRecall: true,
    recallK: 5,
    wiki: { enabled: true, embedder: "mock/deterministic", requireSources: true },
  },
  continuity: {
    enabled: true,
    plan: true,
    ledger: true,
    handoff: true,
    scope: "spec",
    focusMaxChars: 4096,
  },
};
void _fragmentShape;

// ---------------------------------------------------------------------------
// PR 14 — dream (design §6)
// ---------------------------------------------------------------------------

describe("PR 14 — dream fragment threading", () => {
  test("memoryFragmentFromIr carries the dream block (declared fields only)", () => {
    const fragment = memoryFragmentFromIr({
      name: "dreamer",
      memory: {
        autoRecall: true,
        dream: { everyMs: 86_400_000, mode: "full", budgetUsd: 0.5 },
      },
    });
    expect(fragment.memory?.dream).toEqual({
      everyMs: 86_400_000,
      mode: "full",
      budgetUsd: 0.5,
    });
    // JSON-serializable — emitters stringify it into bundles.
    expect(JSON.parse(JSON.stringify(fragment))).toEqual(fragment);
    const without = memoryFragmentFromIr({ name: "plain", memory: { autoRecall: true } });
    expect(without.memory !== undefined && "dream" in without.memory).toBe(false);
  });
});

describe("PR 14 — /dream + dream skill join the gated set when configured", () => {
  const DREAM_FRAGMENT: MemoryWiringFragment = {
    specName: "dreamer",
    memory: { dream: { everyMs: 86_400_000, mode: "full", budgetUsd: 0.5 } },
    continuity: {},
  };

  test("dream configured → /dream command and dream skill are wired", async () => {
    const { deps: d } = deps();
    const wired = await wireMemory(DREAM_FRAGMENT, d);
    expect(wired.options.slashCommands?.has("dream")).toBe(true);
    expect(wired.options.skills?.some((s) => s.name === "dream")).toBe(true);
    // The learning-loop set stays out (PR 17).
    expect(wired.options.slashCommands?.has("study")).toBe(false);
    expect(wired.options.skills?.some((s) => s.name === "learning-loop")).toBe(false);
  });

  test("no dream block → /dream and the dream skill stay excluded", async () => {
    const { deps: d } = deps();
    const wired = await wireMemory({ specName: "plain", memory: {}, continuity: {} }, d);
    expect(wired.options.slashCommands?.has("dream")).toBe(false);
    expect(wired.options.skills?.some((s) => s.name === "dream")).toBe(false);
  });
});

describe("PR 14 — wireDream / runDreamBootCatchUp / createDreamJanitorStep", () => {
  const NOW = new Date("2026-07-13T19:04:12.000Z");
  const DAY = 86_400_000;
  const DREAM_FRAGMENT: MemoryWiringFragment = {
    specName: "dreamer",
    memory: { dream: { everyMs: DAY } },
    continuity: {},
  };

  test("wireDream constructs an engine rooted under <cwd>/.crewhaus; null without dream", () => {
    const wired = wireDream(DREAM_FRAGMENT, { cwd: tmp, now: () => NOW });
    expect(wired).not.toBeNull();
    expect(wired?.engine.stateDir()).toBe(join(tmp, ".crewhaus", "dream", "dreamer"));
    expect(wired?.engine.config).toEqual({ everyMs: DAY, mode: "full", budgetUsd: 0 });
    expect(wireDream({ specName: "plain", memory: {} }, { cwd: tmp })).toBeNull();
    expect(
      wireDream(
        { specName: "off", memory: { enabled: false, dream: { everyMs: DAY } } },
        { cwd: tmp },
      ),
    ).toBeNull();
  });

  test("boot catch-up: overdue → phase 1 + the exact §6.3 note; then quiet", async () => {
    const first = await runDreamBootCatchUp(DREAM_FRAGMENT, { cwd: tmp, now: () => NOW });
    expect(first).toBe(DREAM_BOOT_CATCHUP_NOTE);
    expect(first).toBe(
      "[dream] overdue — deterministic pass done; run 'crewhaus dream' for full consolidation",
    );
    // State was written; the same boot within the cadence is silent.
    const second = await runDreamBootCatchUp(DREAM_FRAGMENT, { cwd: tmp, now: () => NOW });
    expect(second).toBeNull();
    // No dream block → always null.
    expect(await runDreamBootCatchUp({ specName: "plain" }, { cwd: tmp })).toBeNull();
  });

  test("boot catch-up NEVER runs the model phase (§6.3: zero unattended spend)", async () => {
    let modelCalls = 0;
    const note = await runDreamBootCatchUp(
      {
        specName: "dreamer",
        memory: { dream: { everyMs: DAY, mode: "full", budgetUsd: 5 } },
      },
      {
        cwd: tmp,
        now: () => NOW,
        modelPhase: {
          model: "claude-haiku-4-5",
          run: async () => {
            modelCalls += 1;
            return {};
          },
        },
      },
    );
    expect(note).toBe(DREAM_BOOT_CATCHUP_NOTE);
    expect(modelCalls).toBe(0);
  });

  test("janitor step: due-checked, runs once, then skips; null without dream", async () => {
    const step = createDreamJanitorStep(DREAM_FRAGMENT, { cwd: tmp, now: () => NOW, env: {} });
    expect(step).not.toBeNull();
    expect(step?.name).toBe("dream_consolidation");
    const first = await step?.run();
    expect(first?.status).toBe("ok");
    const second = await step?.run();
    expect(second?.status).toBe("skipped");
    expect(createDreamJanitorStep({ specName: "plain" }, { cwd: tmp, env: {} })).toBeNull();
  });

  test("janitor step (managed): enumerates tenants per run, deterministic only", async () => {
    const tenantsRoot = join(tmp, "tenants");
    mkdirSync(join(tenantsRoot, "acme", "sessions"), { recursive: true });
    mkdirSync(join(tenantsRoot, "globex", "sessions"), { recursive: true });
    let modelCalls = 0;
    const step = createDreamJanitorStep(
      { specName: "dreamer", memory: { dream: { everyMs: DAY, mode: "full", budgetUsd: 5 } } },
      {
        cwd: tmp,
        tenantsRootDir: tenantsRoot,
        env: {},
        now: () => NOW,
        modelPhase: {
          model: "claude-haiku-4-5",
          run: async () => {
            modelCalls += 1;
            return {};
          },
        },
      },
    );
    const outcome = await step?.run();
    expect(outcome?.status).toBe("ok");
    expect(outcome?.detail).toContain("2/2 tenant(s)");
    // The model phase never runs from a multi-tenant janitor.
    expect(modelCalls).toBe(0);
    // Per-tenant state landed under each tenant root.
    expect(existsSync(join(tenantsRoot, "acme", "dream", "dreamer", "state.json"))).toBe(true);
    expect(existsSync(join(tenantsRoot, "globex", "dream", "dreamer", "state.json"))).toBe(true);
    // Second tick: nothing due.
    const second = await step?.run();
    expect(second?.status).toBe("skipped");
  });

  test("CREWHAUS_DREAM=0 disables the composed step", async () => {
    const step = createDreamJanitorStep(DREAM_FRAGMENT, {
      cwd: tmp,
      env: { CREWHAUS_DREAM: "0" },
      now: () => NOW,
    });
    const outcome = await step?.run();
    expect(outcome?.status).toBe("skipped");
    expect(outcome?.detail).toBe("CREWHAUS_DREAM=0");
  });
});
