/**
 * Behavioral-equivalence pin for the PR 10 refactor: the wiring compiled
 * bundles and `crewhaus run` used to build inline (target-cli's
 * `renderMemory` codegen + apps/cli's `runRun` block) versus the wiring
 * `wireMemory` now constructs from the same IR memory block.
 *
 * "Legacy" below is a faithful replica of the pre-PR-10 emitted wiring —
 * the exact createMemoryStore/createMemoryTools/seam construction the old
 * codegen templated — driven against its own store root. The wired side
 * runs the composition root. Pinned equivalences:
 *
 *   1. Registered-tool parity: every legacy tool is registered with
 *      identical flags. The ONE sanctioned delta is `MemoryForget` — built
 *      in PR 6 (design §3.4), registered for the first time by the
 *      composition root (neither legacy path ever registered it).
 *   2. Recall equivalence: same facts, same query → same ordered lines.
 *   3. Capture round-trip: the same session transcript captures the same
 *      fact texts with the same tags; the wired path ADDITIONALLY stamps
 *      `provenance {sessionId, evidence}` (the §2.4 upgrade the interpreter
 *      already had — compiled bundles gain it by sharing the root).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MemoryConfig,
  captureFacts,
  createMemoryStore,
  deriveMemoryDecision,
  summarizeDurableFacts,
  turnsFromEvents,
} from "@crewhaus/memory-store";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { createMemoryTools } from "@crewhaus/tool-memory";
import { type MemorySeam, memoryFragmentFromIr, wireMemory } from "./index";

const SESSION_ID = "sess_00000000000000aa";

/** The memory block a spec like `memory: {autoRecall: true, autoCapture:
 *  true, recallK: 4}` lowers into — the same object both wirings consume. */
const IR_MEMORY = { autoRecall: true, autoCapture: true, recallK: 4 } as const;

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "memory-service-equiv-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

type LegacyWired = {
  tools: RegisteredTool[];
  memory: MemorySeam;
  store: ReturnType<typeof createMemoryStore>;
};

/**
 * The pre-PR-10 wiring, verbatim from target-cli's renderMemory template
 * (registration + recall seam + capture seam) — the codegen used
 * `summarizeDurableFacts` (no provenance); the interpreter had already
 * upgraded to the evidence-carrying variant. The replica keeps the codegen
 * form since compiled bundles are what the refactor rewires.
 */
function legacyWiring(cwd: string, specName: string): LegacyWired {
  const memConfig: MemoryConfig = IR_MEMORY;
  const store = createMemoryStore({ specName, rootDir: join(cwd, ".crewhaus", "memories") });
  const bundle = createMemoryTools({ specName, store });
  const tools = [bundle.remember, bundle.recall];
  const decision = deriveMemoryDecision(memConfig, Number.MAX_SAFE_INTEGER);
  const memory: MemorySeam = {
    autoRecall: true,
    recallK: decision.recallK,
    recall: async (query, k) => (await store.recall(query, k)).map((r) => r.entry.text),
    autoCapture: true,
    onCapture: async (completedTurns, sessionId) => {
      if (!deriveMemoryDecision(memConfig, completedTurns).capture) return;
      const file = join(cwd, ".crewhaus", "sessions", `${sessionId}.jsonl`);
      let events: Array<{ kind?: string; payload?: unknown }> = [];
      try {
        events = readFileSync(file, "utf-8")
          .split("\n")
          .filter((l) => l.trim() !== "")
          .map((l) => {
            try {
              return JSON.parse(l) as { kind?: string; payload?: unknown };
            } catch {
              return undefined;
            }
          })
          .filter((e): e is { kind?: string; payload?: unknown } => e !== undefined);
      } catch {
        /* no transcript */
      }
      const facts = summarizeDurableFacts(turnsFromEvents(events));
      await captureFacts(store, facts, ["auto-capture", sessionId]);
    },
  };
  return { tools, memory, store };
}

function writeTranscript(cwd: string): void {
  const events = [
    { kind: "user_message", payload: { content: "Which delimiter do EU CSV files use?" } },
    { kind: "tool_result", payload: { toolUseId: "tu_equiv_1", isError: false } },
    {
      kind: "assistant_message",
      payload: { content: "EU CSV files conventionally use semicolons as delimiters." },
    },
    { kind: "user_message", payload: { content: "And the encoding?" } },
    {
      kind: "assistant_message",
      payload: { content: "Windows-1252 is still common; prefer UTF-8." },
    },
  ];
  const dir = join(cwd, ".crewhaus", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${SESSION_ID}.jsonl`),
    `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
}

const SEED_FACTS: ReadonlyArray<{ text: string; tags: string[] }> = [
  { text: "the user prefers semicolon-delimited CSV exports", tags: ["preference"] },
  { text: "deploys go through the staging gate first", tags: ["process"] },
  { text: "the primary locale is de-AT", tags: ["preference", "locale"] },
];

describe("equivalence: legacy inline wiring vs wireMemory", () => {
  test("registered-tool parity — identical flags; MemoryForget is the one sanctioned addition", async () => {
    const legacy = legacyWiring(join(tmp, "legacy"), "equiv-spec");
    const registered: RegisteredTool[] = [];
    await wireMemory(memoryFragmentFromIr({ name: "equiv-spec", memory: IR_MEMORY }), {
      catalog: { register: (t) => registered.push(t) },
      cwd: join(tmp, "wired"),
      homeDir: join(tmp, "home"),
    });

    const flagsOf = (t: RegisteredTool) => ({
      name: t.name,
      readOnly: t.readOnly,
      destructive: t.destructive,
      requireJustification: t.requireJustification,
      scope: t.scope,
      concurrencySafe: t.concurrencySafe,
      requiresSandbox: t.requiresSandbox,
      classifyOutput: t.classifyOutput,
    });
    const wiredByName = new Map(registered.map((t) => [t.name, t]));
    // Every legacy tool is present with byte-identical flags.
    for (const legacyTool of legacy.tools) {
      const wiredTool = wiredByName.get(legacyTool.name);
      expect(wiredTool).toBeDefined();
      expect(flagsOf(wiredTool as RegisteredTool)).toEqual(flagsOf(legacyTool));
      expect((wiredTool as RegisteredTool).description).toBe(legacyTool.description);
    }
    // The delta is EXACTLY MemoryForget (destructive + justification-gated).
    const extra = registered.filter((t) => !legacy.tools.some((l) => l.name === t.name));
    expect(extra.map((t) => t.name)).toEqual(["MemoryForget"]);
    expect(extra[0]?.destructive).toBe(true);
    expect(extra[0]?.requireJustification).toBe(true);
  });

  test("recall equivalence — same facts, same query, same ordered lines", async () => {
    const legacy = legacyWiring(join(tmp, "legacy"), "equiv-spec");
    const wired = await wireMemory(
      memoryFragmentFromIr({ name: "equiv-spec", memory: IR_MEMORY }),
      {
        catalog: { register: () => undefined },
        cwd: join(tmp, "wired"),
        homeDir: join(tmp, "home"),
      },
    );
    for (const fact of SEED_FACTS) {
      await legacy.store.remember(fact.text, fact.tags);
      await wired.stores.memory?.remember(fact.text, fact.tags);
    }
    for (const query of ["CSV exports", "staging deploys", "locale preference", "nothing here"]) {
      const legacyLines = await legacy.memory.recall?.(query, IR_MEMORY.recallK);
      const wiredLines = await wired.options.memory?.recall?.(query, IR_MEMORY.recallK);
      expect(wiredLines).toEqual(legacyLines as readonly string[]);
    }
    expect(wired.options.memory?.autoRecall).toBe(legacy.memory.autoRecall);
    expect(wired.options.memory?.recallK).toBe(legacy.memory.recallK);
  });

  test("capture round-trip — same transcript, same fact texts + tags; wired adds provenance", async () => {
    const legacyCwd = join(tmp, "legacy");
    const wiredCwd = join(tmp, "wired");
    writeTranscript(legacyCwd);
    writeTranscript(wiredCwd);

    const legacy = legacyWiring(legacyCwd, "equiv-spec");
    const wired = await wireMemory(
      memoryFragmentFromIr({ name: "equiv-spec", memory: IR_MEMORY }),
      {
        catalog: { register: () => undefined },
        cwd: wiredCwd,
        homeDir: join(tmp, "home"),
      },
    );

    await legacy.memory.onCapture?.(2, SESSION_ID);
    await wired.options.memory?.onCapture?.(2, SESSION_ID);

    const legacyItems = await legacy.store.list();
    const wiredItems = (await wired.stores.memory?.list()) ?? [];
    expect(wiredItems.map((i) => i.entry.text)).toEqual(legacyItems.map((i) => i.entry.text));
    expect(wiredItems.map((i) => [...i.entry.tags])).toEqual(
      legacyItems.map((i) => [...i.entry.tags]),
    );
    // The documented upgrade: proof-linked provenance on the wired path.
    expect(wiredItems[0]?.entry.provenance?.sessionId).toBe(SESSION_ID);
    expect(wiredItems[0]?.entry.provenance?.evidence).toEqual(["tu_equiv_1"]);
    expect(legacyItems[0]?.entry.provenance).toBeUndefined();

    // Idempotence parity: a second capture writes nothing on either side.
    await legacy.memory.onCapture?.(2, SESSION_ID);
    await wired.options.memory?.onCapture?.(2, SESSION_ID);
    expect(await legacy.store.size()).toBe(legacyItems.length);
    expect(await wired.stores.memory?.size()).toBe(wiredItems.length);
  });

  test("threshold gate parity — below autoCaptureThreshold neither side captures", async () => {
    const irMemory = { ...IR_MEMORY, autoCaptureThreshold: 5 };
    const legacyCwd = join(tmp, "legacy");
    const wiredCwd = join(tmp, "wired");
    writeTranscript(legacyCwd);
    writeTranscript(wiredCwd);
    const legacy = (() => {
      // Re-run the replica with the threshold config.
      const store = createMemoryStore({
        specName: "equiv-th",
        rootDir: join(legacyCwd, ".crewhaus", "memories"),
      });
      return {
        store,
        onCapture: async (completedTurns: number) => {
          if (!deriveMemoryDecision(irMemory, completedTurns).capture) return;
          await store.remember("should not happen");
        },
      };
    })();
    const wired = await wireMemory(
      { specName: "equiv-th", memory: irMemory },
      {
        catalog: { register: () => undefined },
        cwd: wiredCwd,
        homeDir: join(tmp, "home"),
      },
    );
    await legacy.onCapture(4);
    await wired.options.memory?.onCapture?.(4, SESSION_ID);
    expect(await legacy.store.size()).toBe(0);
    expect(await wired.stores.memory?.size()).toBe(0);
  });
});
