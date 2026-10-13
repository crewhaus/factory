/**
 * 0.7.1 (C040) — a recall tool that sends text to an embedder outside the
 * process says so.
 *
 * With `memory.wiki.embedder` set, `Recall` posts the query and every live
 * memory's text to the embedder, and `wiki_recall`, `wiki_semantic_search`
 * and `wiki_related` post the query and article bodies. 0.7.0 built all four
 * `scope: "internal"` with no `ioCapability`, so the egress classifier never
 * saw the query and `compile --strict` never counted them.
 *
 * The flags are checked two ways: as declarations through the real wiring,
 * and by behaviour — every wired tool is run against a recording embedder,
 * and the set of tools that called it must equal the set that declares the
 * network. A future tool that starts embedding without saying so fails here.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditToolScopes } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { type EmbedderLike, type WireMemoryDeps, wireMemory } from "./index";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "memory-embedder-egress-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const EMBEDDER_TOOLS = ["Recall", "wiki_recall", "wiki_semantic_search", "wiki_related"];

/** A structural embedder that records every text it is sent. It says nothing
 *  about its provider, so it must count as one that leaves the process. */
function recordingEmbedder(): EmbedderLike & { readonly sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    async embed(texts: ReadonlyArray<string>): Promise<number[][]> {
      sent.push(...texts);
      return texts.map((t) => [(t.length % 7) + 1, 1, t.includes("coffee") ? 1 : 0]);
    },
  };
}

function wireDeps(overrides: Partial<WireMemoryDeps> = {}): WireMemoryDeps {
  return {
    catalog: { register() {} },
    cwd: tmp,
    homeDir: join(tmp, "home"),
    log: () => {},
    ...overrides,
  };
}

const FRAGMENT = { specName: "egress", memory: { wiki: { enabled: true } } } as const;

describe("embedder-backed recall tools declare the network (C040)", () => {
  test("with an embedder that leaves the process: the four ranking tools are external/network and still readOnly", async () => {
    const wired = await wireMemory(FRAGMENT, wireDeps({ embedder: recordingEmbedder() }));
    const external = wired.tools.filter((t) => t.scope === "external").map((t) => t.name);
    expect(external.sort()).toEqual([...EMBEDDER_TOOLS].sort());
    for (const name of EMBEDDER_TOOLS) {
      const tool = wired.tools.find((t) => t.name === name);
      expect({
        name,
        scope: tool?.scope,
        io: tool?.ioCapability,
        readOnly: tool?.readOnly,
      }).toEqual({ name, scope: "external", io: "network", readOnly: true });
    }
    // Declared consistently: nothing for the strict audit to flag.
    expect(auditToolScopes(wired.tools)).toEqual([]);
  });

  test("with no embedder, and with the in-process mock embedder, every tool stays internal", async () => {
    const plain = await wireMemory(FRAGMENT, wireDeps());
    const mock = await wireMemory(
      { specName: "egress-mock", memory: { wiki: { enabled: true, embedder: "mock/test" } } },
      wireDeps(),
    );
    for (const wired of [plain, mock]) {
      expect(wired.tools.length).toBe(13);
      expect(wired.tools.filter((t) => t.scope !== "internal").map((t) => t.name)).toEqual([]);
      expect(wired.tools.filter((t) => t.ioCapability !== undefined).map((t) => t.name)).toEqual(
        [],
      );
    }
  });

  test("an embedder spec string that names an HTTP provider makes the tools external", async () => {
    const wired = await wireMemory(
      {
        specName: "egress-local",
        memory: { wiki: { enabled: true, embedder: "local/nomic@http://127.0.0.1:9" } },
      },
      wireDeps(),
    );
    const external = wired.tools.filter((t) => t.ioCapability === "network").map((t) => t.name);
    expect(external.sort()).toEqual([...EMBEDDER_TOOLS].sort());
  });

  test("the tools that call the embedder are exactly the tools that declare the network", async () => {
    const seed = recordingEmbedder();
    const seeded = await wireMemory(FRAGMENT, wireDeps({ embedder: seed }));
    const byName = (tools: readonly RegisteredTool[], name: string): RegisteredTool => {
      const tool = tools.find((t) => t.name === name);
      if (tool === undefined) throw new Error(`${name} not wired`);
      return tool;
    };
    await byName(seeded.tools, "Remember").execute({ text: "my coffee order is a flat white" });
    await byName(seeded.tools, "wiki_write").execute({
      slug: "coffee",
      title: "Coffee",
      body: "coffee extraction notes",
      tags: ["drinks"],
    });
    await byName(seeded.tools, "wiki_write").execute({
      slug: "tea",
      title: "Tea",
      body: "tea steeping notes",
      tags: ["drinks"],
    });

    const inputs: Record<string, unknown> = {
      Remember: { text: "the office closes at six" },
      Recall: { query: "coffee" },
      MemoryForget: { query: "zzz-matches-nothing" },
      wiki_recall: { query: "coffee" },
      wiki_semantic_search: { query: "coffee", minScore: 0 },
      wiki_search: { query: "coffee" },
      wiki_get: { slug: "coffee" },
      wiki_write: { slug: "milk", title: "Milk", body: "milk notes" },
      wiki_list: { query: "coffee" },
      wiki_related: { slug: "coffee" },
      wiki_set_signals: { slug: "coffee", verified: true },
      wiki_stats: {},
      log_knowledge_gap: { topic: "espresso" },
    };
    expect(Object.keys(inputs).sort()).toEqual(seeded.tools.map((t) => t.name).sort());

    // Each tool runs on a freshly wired process (cold embedding caches), the
    // way a new session meets it.
    const called: string[] = [];
    for (const name of Object.keys(inputs)) {
      const embedder = recordingEmbedder();
      const wired = await wireMemory(FRAGMENT, wireDeps({ embedder }));
      await byName(wired.tools, name).execute(inputs[name]);
      if (embedder.sent.length > 0) called.push(name);
    }
    const declared = seeded.tools.filter((t) => t.ioCapability === "network").map((t) => t.name);
    expect(called.sort()).toEqual([...EMBEDDER_TOOLS].sort());
    expect(declared.sort()).toEqual(called.sort());
  });
});
