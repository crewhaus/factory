import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IDENTITY_REDACTOR,
  KNOWLEDGE_MARKER_RELPATH,
  type Redactor,
  applyPull,
  applyPush,
  formatPushReport,
  fragmentContentHash,
  harnessOptedIn,
  memoryContentHash,
  planPull,
  planPush,
  readHarnessMemories,
  readSharedFragments,
  readSharedMemories,
  splitProvenanceHeader,
  withProvenanceHeader,
} from "./knowledge-sync";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "crewhaus-knowledge-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seedMemory(harnessDir: string, entries: Array<{ text: string; tags?: string[] }>): void {
  const dir = join(harnessDir, ".crewhaus", "memories");
  mkdirSync(dir, { recursive: true });
  const lines = entries.map((e, i) =>
    JSON.stringify({ id: `mem_${i}`, text: e.text, tags: e.tags ?? [], createdAt: "t" }),
  );
  writeFileSync(join(dir, "spec.jsonl"), `${lines.join("\n")}\n`);
}

describe("memoryContentHash", () => {
  test("is tag-order independent + dedupes tags", () => {
    expect(memoryContentHash("hi", ["b", "a", "a"])).toBe(memoryContentHash("hi", ["a", "b"]));
  });
  test("differs on text", () => {
    expect(memoryContentHash("a", [])).not.toBe(memoryContentHash("b", []));
  });
});

describe("harnessOptedIn", () => {
  test("false with no marker", () => {
    expect(harnessOptedIn(root)).toBe(false);
  });
  test("true with { share: true }", () => {
    mkdirSync(join(root, ".crewhaus"), { recursive: true });
    writeFileSync(join(root, KNOWLEDGE_MARKER_RELPATH), JSON.stringify({ share: true }));
    expect(harnessOptedIn(root)).toBe(true);
  });
  test("false with { share: false }", () => {
    mkdirSync(join(root, ".crewhaus"), { recursive: true });
    writeFileSync(join(root, KNOWLEDGE_MARKER_RELPATH), JSON.stringify({ share: false }));
    expect(harnessOptedIn(root)).toBe(false);
  });
});

describe("readHarnessMemories", () => {
  test("reads text + tags, tolerates malformed lines", () => {
    const dir = join(root, ".crewhaus", "memories");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "spec.jsonl"),
      `${JSON.stringify({ text: "keep", tags: ["a"] })}\nnot json\n${JSON.stringify({ nope: 1 })}\n`,
    );
    const mems = readHarnessMemories(root);
    expect(mems).toEqual([{ text: "keep", tags: ["a"] }]);
  });
});

describe("provenance header round-trip", () => {
  test("split + with are inverses", () => {
    const prov = { harness: "bot", pushedAt: "2026-07-02T00:00:00Z" };
    const wrapped = withProvenanceHeader("body\nline2", prov);
    const { provenance, body } = splitProvenanceHeader(wrapped);
    expect(provenance).toEqual(prov);
    expect(body).toBe("body\nline2");
  });
  test("a fragment with no header returns the body verbatim", () => {
    expect(splitProvenanceHeader("plain body").body).toBe("plain body");
  });
});

describe("planPush", () => {
  const NOW = () => new Date("2026-07-02T00:00:00.000Z");

  test("dedupes against existing + within the push, tags provenance", async () => {
    const plan = await planPush({
      harness: "bot",
      memories: [
        { text: "lesson one", tags: ["x"] },
        { text: "lesson one", tags: ["x"] }, // dup within push
        { text: "lesson two", tags: [] },
      ],
      prompts: [],
      existingMemoryHashes: new Set([memoryContentHash("lesson two", [])]), // already shared
      existingFragmentHashes: new Set(),
      redact: IDENTITY_REDACTOR,
      now: NOW,
    });
    expect(plan.memories).toHaveLength(1);
    expect(plan.memories[0]?.text).toBe("lesson one");
    expect(plan.memories[0]?.provenance.harness).toBe("bot");
    expect(plan.skippedDuplicates).toBe(2);
  });

  test("drops a memory whose token survives redaction", async () => {
    // A redactor that flags any text containing the marker "LEAK".
    const redactor: Redactor = async (text) => ({
      text,
      secretRemains: text.includes("LEAK"),
    });
    const plan = await planPush({
      harness: "bot",
      memories: [
        { text: "safe lesson", tags: [] },
        { text: "token is LEAK", tags: [] },
      ],
      prompts: [],
      existingMemoryHashes: new Set(),
      existingFragmentHashes: new Set(),
      redact: redactor,
      now: NOW,
    });
    expect(plan.memories).toHaveLength(1);
    expect(plan.droppedSecrets).toHaveLength(1);
    expect(formatPushReport("bot", plan, false).join("\n")).toContain("token survived redaction");
  });

  test("pushes grader + prompt fragments", async () => {
    const plan = await planPush({
      harness: "bot",
      memories: [],
      graders: { filename: "graders.yaml", contents: "graders:\n  - id: x\n" },
      prompts: [{ filename: "lesson.md", contents: "# a lesson\n" }],
      existingMemoryHashes: new Set(),
      existingFragmentHashes: new Set(),
      redact: IDENTITY_REDACTOR,
      now: NOW,
    });
    expect(plan.fragments.map((f) => f.kind).sort()).toEqual(["grader", "prompt"]);
  });
});

describe("push → pull round-trip", () => {
  const NOW = () => new Date("2026-07-02T00:00:00.000Z");

  test("a pushed memory lands in the shared store and pulls into another harness", async () => {
    const shared = join(root, ".crewhaus-shared");
    const botDir = join(root, "bot");
    const cliDir = join(root, "cli");
    mkdirSync(botDir, { recursive: true });
    mkdirSync(cliDir, { recursive: true });
    seedMemory(botDir, [{ text: "prod lesson", tags: ["ops"] }]);

    // push from bot
    const pushPlan = await planPush({
      harness: "bot",
      memories: readHarnessMemories(botDir),
      prompts: [],
      existingMemoryHashes: new Set(readSharedMemories(shared).map((m) => m.contentHash)),
      existingFragmentHashes: new Set(),
      redact: IDENTITY_REDACTOR,
      now: NOW,
    });
    applyPush(shared, pushPlan, NOW);
    expect(readSharedMemories(shared)).toHaveLength(1);

    // pull into cli
    const pullPlan = planPull({
      sharedMemories: readSharedMemories(shared),
      sharedFragments: [],
      harnessMemoryHashes: new Set(),
      harnessFragmentHashes: new Set(),
    });
    expect(pullPlan.memories).toHaveLength(1);
    applyPull(cliDir, pullPlan, NOW);

    const sharedFile = join(cliDir, ".crewhaus", "memories", "shared.jsonl");
    expect(existsSync(sharedFile)).toBe(true);
    const pulled = JSON.parse(readFileSync(sharedFile, "utf-8").trim());
    expect(pulled.text).toBe("prod lesson");
    expect(pulled.tags).toContain("shared:bot");
    // a valid MemoryEntry shape for the memory-store to load
    expect(pulled.id).toMatch(/^mem_shared_/);
  });

  test("a second push of the same memory is a no-op (dedupe)", async () => {
    const shared = join(root, ".crewhaus-shared");
    const botDir = join(root, "bot");
    mkdirSync(botDir, { recursive: true });
    seedMemory(botDir, [{ text: "same", tags: [] }]);
    for (let i = 0; i < 2; i++) {
      const plan = await planPush({
        harness: "bot",
        memories: readHarnessMemories(botDir),
        prompts: [],
        existingMemoryHashes: new Set(readSharedMemories(shared).map((m) => m.contentHash)),
        existingFragmentHashes: new Set(),
        redact: IDENTITY_REDACTOR,
        now: NOW,
      });
      applyPush(shared, plan, NOW);
    }
    expect(readSharedMemories(shared)).toHaveLength(1);
  });

  test("pushed grader fragment round-trips with provenance", async () => {
    const shared = join(root, ".crewhaus-shared");
    const botDir = join(root, "bot");
    mkdirSync(botDir, { recursive: true });
    writeFileSync(join(botDir, "graders.yaml"), "graders:\n  - id: strict\n");
    const plan = await planPush({
      harness: "bot",
      memories: [],
      graders: {
        filename: "graders.yaml",
        contents: readFileSync(join(botDir, "graders.yaml"), "utf-8"),
      },
      prompts: [],
      existingMemoryHashes: new Set(),
      existingFragmentHashes: new Set(),
      redact: IDENTITY_REDACTOR,
      now: NOW,
    });
    applyPush(shared, plan, NOW);
    const frags = readSharedFragments(shared, "grader");
    expect(frags).toHaveLength(1);
    expect(frags[0]?.provenance.harness).toBe("bot");
    expect(frags[0]?.contents).toContain("id: strict");
  });
});

describe("fragmentContentHash", () => {
  test("is whitespace-trim stable", () => {
    expect(fragmentContentHash("body\n")).toBe(fragmentContentHash("  body  "));
  });
});
