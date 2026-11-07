import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import { createMemoryStore } from "@crewhaus/memory-store";
import { createSessionStore } from "@crewhaus/session-store";
import { createWikiStore } from "@crewhaus/wiki-store";
import { loadConsoleGrammar } from "../console-routes";
import { MARKUP_PAYLOAD, digestFleet, digestTree, seedFleet } from "../seed/fleet";
import { childEnv, crewhausArgv, parsePrintedUrl, sandboxEnv } from "../system";

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hangar-e2e-seed-"));
  dirs.push(dir);
  return dir;
}

describe("seedFleet", () => {
  test("one harness per shape the console knows, each registered", async () => {
    const grammar = await loadConsoleGrammar();
    const fleet = await seedFleet(tempDir(), { seed: "s", now: NOW });
    expect(fleet.harnesses.map((harness) => harness.target)).toEqual([...grammar.shapeTargets]);
    const rows = openHangarRegistry({ root: fleet.registryRoot, env: fleet.env }).list();
    expect(rows.map((row) => row.id).sort()).toEqual(
      fleet.harnesses.map((harness) => harness.id).sort(),
    );
  }, 20_000); // writes fourteen harnesses through the real stores

  test("seeding twice at one path gives the same bytes", async () => {
    const dir = tempDir();
    const first = digestFleet(await seedFleet(dir, { seed: "s", now: NOW, shapes: ["cli"] }));
    rmSync(dir, { recursive: true, force: true });
    const second = digestFleet(await seedFleet(dir, { seed: "s", now: NOW, shapes: ["cli"] }));
    expect(first["cli"]).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toEqual(first);
  });

  test("another seed or another time gives other bytes", async () => {
    const dir = tempDir();
    const base = digestFleet(await seedFleet(dir, { seed: "s", now: NOW, shapes: ["cli"] }));
    rmSync(dir, { recursive: true, force: true });
    const reseeded = digestFleet(await seedFleet(dir, { seed: "t", now: NOW, shapes: ["cli"] }));
    rmSync(dir, { recursive: true, force: true });
    const later = digestFleet(await seedFleet(dir, { seed: "s", now: NOW + 1, shapes: ["cli"] }));
    expect(reseeded["cli"]).not.toBe(base["cli"]);
    expect(later["cli"]).not.toBe(base["cli"]);
  });

  test("the stores read back what was seeded", async () => {
    const fleet = await seedFleet(tempDir(), { seed: "s", now: NOW, shapes: ["cli"] });
    const [harness] = fleet.harnesses;
    if (harness === undefined) throw new Error("no harness");
    const crewhaus = join(harness.dir, ".crewhaus");
    const session = await createSessionStore({ rootDir: join(crewhaus, "sessions") }).get(
      harness.sessionIds[0] ?? "",
    );
    expect(session?.createdAt).toBe(new Date(NOW).toISOString());
    expect(session?.target).toBe("cli");
    const article = await createWikiStore({
      specName: harness.specName,
      rootDir: join(crewhaus, "wiki"),
    }).get(harness.wikiSlug);
    expect(article?.title).toBe("Getting started");
    const memories = await createMemoryStore({
      specName: harness.specName,
      rootDir: join(crewhaus, "memories"),
    }).list();
    expect(memories).toHaveLength(1);
    expect(memories[0]?.status).toBe("live");
  });

  test("a run id and a session id are the shapes the console's routes accept", async () => {
    const fleet = await seedFleet(tempDir(), { seed: "s", now: NOW, shapes: ["cli"] });
    expect(fleet.harnesses[0]?.runId).toMatch(/^run_[0-9a-f]{16}$/);
    expect(fleet.harnesses[0]?.sessionIds[0]).toMatch(/^sess_[0-9a-f]{16}$/);
  });

  test("the server's environment is spelled out, and holds nothing of this process's", async () => {
    const sentinel = "HANGAR_E2E_SEED_SENTINEL";
    process.env[sentinel] = "1";
    try {
      const dir = tempDir();
      const fleet = await seedFleet(dir, { seed: "s", now: NOW, shapes: ["cli"] });
      expect(Object.keys(fleet.env).sort()).toEqual([
        "CREWHAUS_REGISTRY_ROOT",
        "CREWHAUS_WATCHME_ROOT",
        "HOME",
        "PATH",
      ]);
      expect(fleet.env["HOME"]).toBe(dir);
    } finally {
      Reflect.deleteProperty(process.env, sentinel);
    }
  });

  describe("with markup: true", () => {
    test("every outside field holds the payload, and the plain seed holds none", async () => {
      const fleet = await seedFleet(tempDir(), {
        seed: "s",
        now: NOW,
        shapes: ["cli"],
        markup: true,
      });
      const [harness] = fleet.harnesses;
      if (harness === undefined) throw new Error("no harness");
      const crewhaus = join(harness.dir, ".crewhaus");
      const planted: Array<[string, string]> = [
        ["session name", join("sessions", `${harness.sessionIds[0]}.json`)],
        ["session log", join("sessions", `${harness.sessionIds[0]}.jsonl`)],
        ["wiki", join("wiki", harness.specName, "articles", `${harness.wikiSlug}.md`)],
        ["memory", join("memories", `${harness.specName}.jsonl`)],
        ["feedback", join("feedback", "seed.jsonl")],
        ["run log", join("run", "logs", `${harness.runId}.log`)],
        ["focus", join("state", "focus.md")],
        ["goals", join("state", "goals.yaml")],
      ];
      for (const [what, relative] of planted) {
        // JSON-encoded fields escape the quotes, so look for what survives that.
        const text = readFileSync(join(crewhaus, relative), "utf8");
        expect({
          what,
          script: text.includes("__e2eSentinel=2</script>"),
          link: text.includes("](javascript:"),
        }).toEqual({ what, script: true, link: true });
      }
      const articlePath = join("wiki", harness.specName, "articles", `${harness.wikiSlug}.md`);
      expect(readFileSync(join(crewhaus, articlePath), "utf8")).toContain(MARKUP_PAYLOAD);

      const plain = await seedFleet(tempDir(), { seed: "s", now: NOW, shapes: ["cli"] });
      const plainCrewhaus = join(plain.harnesses[0]?.dir ?? "", ".crewhaus");
      expect(readFileSync(join(plainCrewhaus, articlePath), "utf8")).not.toContain("__e2eSentinel");
    });
  });
});

describe("digestTree", () => {
  test("changes with a byte, a new file and a new name", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a"), "one");
    const base = digestTree(dir);
    expect(digestTree(dir)).toBe(base);
    writeFileSync(join(dir, "a"), "two");
    const changed = digestTree(dir);
    expect(changed).not.toBe(base);
    writeFileSync(join(dir, "b"), "");
    const added = digestTree(dir);
    expect(added).not.toBe(changed);
    rmSync(join(dir, "b"));
    writeFileSync(join(dir, "c"), "");
    expect(digestTree(dir)).not.toBe(added);
  });
});

describe("the system half", () => {
  test("crewhausArgv runs the CLI from source, or the binary CREWHAUS_E2E_BIN names", () => {
    const fromSource = crewhausArgv({});
    expect(fromSource[0]).toBe(process.execPath);
    expect(fromSource[1]).toEndWith(join("apps", "cli", "src", "index.ts"));
    expect(crewhausArgv({ CREWHAUS_E2E_BIN: "/opt/crewhaus" })).toEqual(["/opt/crewhaus"]);
    expect(crewhausArgv({ CREWHAUS_E2E_BIN: "" })).toEqual(fromSource);
  });

  test("a child's environment keeps registration on and sessions where the console reads them", () => {
    const env = childEnv("/sandbox", "http://127.0.0.1:1");
    expect(env["HOME"]).toBe("/sandbox");
    expect(env["ANTHROPIC_BASE_URL"]).toBe("http://127.0.0.1:1");
    expect(env["CREWHAUS_NO_REGISTRY"]).toBeUndefined();
    expect(env["CREWHAUS_SESSION_DIR"]).toBeUndefined();
    expect(env["CREWHAUS_REGISTRY_ROOT"]).toBe(sandboxEnv("/sandbox")["CREWHAUS_REGISTRY_ROOT"]);
  });

  test("the printed URL becomes an address a session can sign in from", () => {
    const printed = "Hangar is up\n  http://127.0.0.1:43210/#t=abc123\nmore\n";
    expect(parsePrintedUrl(printed)).toEqual({
      url: "http://127.0.0.1:43210",
      port: 43210,
      token: "abc123",
      bootPath: "/#t=abc123",
    });
    expect(parsePrintedUrl("still starting")).toBeUndefined();
    expect(parsePrintedUrl("http://0.0.0.0:43210/#t=abc123")).toBeUndefined();
  });
});
