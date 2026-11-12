import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore } from "@crewhaus/memory-store";
import {
  IDENTITY_REDACTOR,
  KNOWLEDGE_MARKER_RELPATH,
  MAX_SHARED_MEMORY_TEXT,
  type Redactor,
  applyPull,
  applyPush,
  buildKnowledgeRedactor,
  formatPushReport,
  fragmentContentHash,
  harnessOptedIn,
  harnessSpecName,
  looksLikeSecret,
  maskKnowledgeSecrets,
  memoryContentHash,
  planPull,
  planPush,
  readHarnessFactStates,
  readHarnessFacts,
  readHarnessMemories,
  readRetractions,
  readSharedFragments,
  readSharedMemories,
  splitProvenanceHeader,
  validateSharedMemory,
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
    writeFileSync(join(cliDir, "crewhaus.yaml"), "name: concierge\nshape: cli\n");
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
    await applyPull(cliDir, pullPlan, NOW, { specName: harnessSpecName(cliDir) });

    // It lands in the harness's own spec store, not a side file.
    expect(existsSync(join(cliDir, ".crewhaus", "memories", "shared.jsonl"))).toBe(false);
    const specFile = join(cliDir, ".crewhaus", "memories", "concierge.jsonl");
    const pulled = JSON.parse(readFileSync(specFile, "utf-8").trim());
    expect(pulled.text).toBe("prod lesson");
    expect(pulled.tags).toContain("shared:bot");
    // A valid fact id the store's own rule accepts, derived from the content hash.
    const hash = memoryContentHash("prod lesson", ["ops"]);
    expect(pulled.id).toBe(`mem_${hash.slice(0, 16)}`);
    expect(pulled.provenance.origin).toEqual({ kind: "sync", harness: "bot", contentHash: hash });
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

// ---------------------------------------------------------------------------
// F1 — the REAL knowledge redactor must mask OR drop every credential family.
// Prior tests used IDENTITY_REDACTOR / a "LEAK" stub — false confidence. These
// feed real secret shapes through buildKnowledgeRedactor. Every secret-shaped
// fixture is assembled at RUNTIME from parts so no literal secret is in source
// (GitHub push-protection).
// ---------------------------------------------------------------------------
describe("buildKnowledgeRedactor — real-secret round-trip (F1)", () => {
  // Identity PII pass: exercise the credential layer in isolation. The real CLI
  // layers @crewhaus/pii-redactor on top, which can only redact MORE.
  const redactor = buildKnowledgeRedactor(async (text) => text);

  // --- runtime-assembled secret fixtures (no literal secrets in source) ---
  const A = "A".repeat(16);
  const awsSecretKey = `wJalr${"X".repeat(20)}bPxRfi${"C/K"}Y${"z".repeat(5)}`; // exactly 40 base64 chars incl. `/`
  const awsAccessKeyId = `AKIA${"IOSFODNN7EXAMPLE".slice(0, 16)}`;
  const stripeLive = `sk${"_"}live${"_"}${"4eC39HqLyjWDarjtT1zdp7dc"}`;
  const stripeTest = `sk${"_"}test${"_"}${A}${A}`;
  const genericSk = `sk${"-"}${"proj"}${A}${A}`;
  const githubToken = `ghp${"_"}${A}${A}`;
  const slackToken = `xoxb${"-"}${"123456789012"}${"-"}${A}`;
  const jwt = `eyJ${"abcdefghij"}.${"klmnopqrst"}.${"uvwxyz0123"}`;
  const pemBody = `${"MIIEvQIBADANBgkqhkiG9w0BAQEFAASC"}${"BKcwggSjAgEAAoIBAQ".repeat(3)}`;
  const pemKey = `-----BEGIN RSA PRIVATE KEY-----\n${pemBody}\n-----END RSA PRIVATE KEY-----`;

  const cases: Array<{ name: string; secret: string }> = [
    { name: "AWS secret access key", secret: awsSecretKey },
    { name: "AWS access key id", secret: awsAccessKeyId },
    { name: "Stripe sk_live", secret: stripeLive },
    { name: "Stripe sk_test", secret: stripeTest },
    { name: "generic sk-", secret: genericSk },
    { name: "GitHub token", secret: githubToken },
    { name: "Slack xoxb", secret: slackToken },
    { name: "JWT", secret: jwt },
    { name: "PEM private key", secret: pemKey },
  ];

  for (const { name, secret } of cases) {
    test(`${name} is masked or dropped — never shared verbatim`, async () => {
      const text = `here is my credential: ${secret} — please remember it`;
      const outcome = await redactor(text);

      // Kept path: the secret MUST have been masked out and nothing
      // secret-shaped may survive (else it leaks with secretRemains=false).
      if (!outcome.secretRemains) {
        expect(outcome.text).not.toContain(secret);
        expect(looksLikeSecret(outcome.text)).toBe(false);
      }

      // Definitive guarantee: push the secret-carrying memory through the REAL
      // planPush path and assert the verbatim secret NEVER lands in the shared
      // artifacts — whether it was masked (kept) or dropped.
      const plan = await planPush({
        harness: "bot",
        memories: [{ text, tags: [] }],
        prompts: [],
        existingMemoryHashes: new Set(),
        existingFragmentHashes: new Set(),
        redact: redactor,
        now: () => new Date("2026-07-02T00:00:00.000Z"),
      });
      expect(JSON.stringify(plan.memories)).not.toContain(secret);
    });
  }

  test("PEM block is masked WHOLE (body + footer gone, not just the header)", async () => {
    const outcome = await redactor(`key:\n${pemKey}\n`);
    expect(outcome.text).not.toContain(pemBody);
    expect(outcome.text).not.toContain("-----END RSA PRIVATE KEY-----");
  });

  test("a memory carrying a real secret is DROPPED by planPush, not shared", async () => {
    const plan = await planPush({
      harness: "bot",
      memories: [
        { text: "safe lesson about retries", tags: [] },
        { text: `prod key ${awsSecretKey} keep it`, tags: [] },
        { text: `bearer ${A}${A}${A} for the API`, tags: [] },
      ],
      prompts: [],
      existingMemoryHashes: new Set(),
      existingFragmentHashes: new Set(),
      redact: redactor,
      now: () => new Date("2026-07-02T00:00:00.000Z"),
    });
    // Only the safe lesson survives; neither secret appears anywhere.
    const serialized = JSON.stringify(plan.memories);
    expect(serialized).not.toContain(awsSecretKey);
    expect(plan.memories.every((m) => !looksLikeSecret(m.text))).toBe(true);
  });

  test("ordinary prose is NOT flagged as a secret (no false drop)", async () => {
    const outcome = await redactor(
      "The optimizer converged after twelve iterations and improved the citation grader.",
    );
    expect(outcome.secretRemains).toBe(false);
    expect(outcome.text).toContain("optimizer converged");
  });

  test("maskKnowledgeSecrets keeps the Bearer scheme word, masks the token", () => {
    const masked = maskKnowledgeSecrets(`Authorization: Bearer ${A}${A}${A}`);
    expect(masked).toContain("Bearer ***");
    expect(masked).not.toContain(`${A}${A}${A}`);
  });
});

// ---------------------------------------------------------------------------
// F6 — pulled shared entries are validated; poisoned records are rejected.
// ---------------------------------------------------------------------------
describe("shared-store validation on pull (F6)", () => {
  test("validateSharedMemory rejects a lying contentHash", () => {
    const v = validateSharedMemory({
      contentHash: "0".repeat(64), // does not match text+tags
      text: "malicious payload masquerading as a trusted hash",
      tags: ["ops"],
      provenance: { harness: "attacker", pushedAt: "t" },
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("contentHash");
  });

  test("validateSharedMemory accepts a record whose hash matches", () => {
    const text = "a genuine lesson";
    const tags = ["ops", "recall"];
    const v = validateSharedMemory({
      contentHash: memoryContentHash(text, tags),
      text,
      tags,
      provenance: { harness: "bot", pushedAt: "t" },
    });
    expect(v.ok).toBe(true);
  });

  test("validateSharedMemory rejects oversized text", () => {
    const text = "x".repeat(MAX_SHARED_MEMORY_TEXT + 1);
    const v = validateSharedMemory({
      contentHash: memoryContentHash(text, []),
      text,
      tags: [],
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("exceeds");
  });

  test("validateSharedMemory rejects non-string tags", () => {
    const v = validateSharedMemory({
      contentHash: "abc",
      text: "hi",
      tags: [1, 2, 3],
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("tags");
  });

  test("readSharedMemories skips a poisoned line, loads the valid one", () => {
    const shared = join(root, ".crewhaus-shared");
    mkdirSync(shared, { recursive: true });
    const good = { text: "real lesson", tags: ["a"] };
    const goodRec = {
      contentHash: memoryContentHash(good.text, good.tags),
      text: good.text,
      tags: good.tags,
      provenance: { harness: "bot", pushedAt: "t" },
    };
    const poisoned = {
      contentHash: "deadbeef".repeat(8), // forged
      text: "poison masquerading under a forged hash",
      tags: ["x"],
      provenance: { harness: "attacker", pushedAt: "t" },
    };
    writeFileSync(
      join(shared, "memories.jsonl"),
      `${JSON.stringify(goodRec)}\n${JSON.stringify(poisoned)}\n`,
    );
    const loaded = readSharedMemories(shared);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.text).toBe("real lesson");
  });

  test("readSharedFragments rejects a fragment file renamed to a forged hash", () => {
    const shared = join(root, ".crewhaus-shared");
    const dir = join(shared, "prompts");
    mkdirSync(dir, { recursive: true });
    const body = "# a shared lesson\nprefer explicit tool names\n";
    // Valid fragment: filename IS the body hash, with a provenance header.
    const realHash = fragmentContentHash(body);
    writeFileSync(
      join(dir, `${realHash}.md`),
      withProvenanceHeader(body, { harness: "bot", pushedAt: "t" }),
    );
    // Poisoned fragment: a DIFFERENT body written under a filename claiming the
    // real hash (a rename attack to slip past dedupe).
    writeFileSync(
      join(dir, `${"c".repeat(64)}.md`),
      withProvenanceHeader("malicious body", { harness: "attacker", pushedAt: "t" }),
    );
    const frags = readSharedFragments(shared, "prompt");
    expect(frags).toHaveLength(1);
    expect(frags[0]?.contentHash).toBe(realHash);
    expect(frags[0]?.contents).toContain("a shared lesson");
  });
});

describe("knowledge sync integrity", () => {
  const NOW = () => new Date("2026-07-02T00:00:00.000Z");

  async function push(harnessDir: string, shared: string, harness: string) {
    const states = await readHarnessFactStates(harnessDir);
    const plan = await planPush({
      harness,
      memories: states.live,
      prompts: [],
      existingMemoryHashes: new Set(readSharedMemories(shared).map((m) => m.contentHash)),
      existingFragmentHashes: new Set(),
      redact: IDENTITY_REDACTOR,
      now: NOW,
      deadFacts: states.dead,
      sharedMemories: readSharedMemories(shared),
      existingRetractions: readRetractions(shared),
    });
    applyPush(shared, plan, NOW);
    return plan;
  }

  async function pull(harnessDir: string, shared: string) {
    const plan = planPull({
      sharedMemories: readSharedMemories(shared),
      sharedFragments: [],
      harnessMemoryHashes: new Set(),
      harnessFragmentHashes: new Set(),
    });
    return applyPull(harnessDir, plan, NOW, {
      specName: harnessSpecName(harnessDir),
      retractions: readRetractions(shared),
    });
  }

  function harness(name: string, spec?: string): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    if (spec !== undefined) writeFileSync(join(dir, "crewhaus.yaml"), `name: ${spec}\n`);
    return dir;
  }

  test("superseded, expired and personal facts are not pushed; live ones carry their origin", async () => {
    const bot = harness("bot", "bot");
    const now = { t: Date.parse("2026-07-01T00:00:00.000Z") };
    const store = createMemoryStore({
      specName: "bot",
      rootDir: join(bot, ".crewhaus", "memories"),
      now: () => new Date(now.t),
    });
    const kept = await store.remember("deploys run at 9am", ["ops"]);
    const wrong = await store.remember("the office is on floor 3");
    await store.supersede(wrong.id, "the office is on floor 4", { reason: "moved" });
    await store.remember("a token that lapses", [], { ttlMs: 10 });
    const personal = await store.remember("Dana prefers tea");
    await store.annotate(personal.id, { category: "person" });
    now.t += 1000;
    const facts = await readHarnessFacts(bot);
    expect(facts.map((f) => f.text).sort()).toEqual([
      "deploys run at 9am",
      "the office is on floor 4",
    ]);
    const shared = join(root, ".crewhaus-shared");
    await push(bot, shared, "bot");
    const lines = readSharedMemories(shared);
    expect(lines.map((m) => m.text).sort()).toEqual([
      "deploys run at 9am",
      "the office is on floor 4",
    ]);
    expect(lines.find((m) => m.text === "deploys run at 9am")?.origin).toEqual({
      harness: "bot",
      fact: kept.id,
    });
  });

  test("a pulled fact gets mem_<16 hex> in <spec>.jsonl, and recall finds it; a second pull adds nothing", async () => {
    const bot = harness("bot", "bot");
    const cli = harness("cli", "concierge");
    await createMemoryStore({
      specName: "bot",
      rootDir: join(bot, ".crewhaus", "memories"),
    }).remember("the release train leaves on Thursdays", ["ops"]);
    const shared = join(root, ".crewhaus-shared");
    await push(bot, shared, "bot");
    const first = await pull(cli, shared);
    expect(first.added).toHaveLength(1);
    expect(first.added[0]).toMatch(/^mem_[0-9a-f]{16}$/);
    const store = createMemoryStore({
      specName: "concierge",
      rootDir: join(cli, ".crewhaus", "memories"),
    });
    expect((await store.recall("release train", 5)).map((r) => r.entry.id)).toEqual([
      first.added[0] as string,
    ]);
    const second = await pull(cli, shared);
    expect(second.added).toEqual([]);
    expect(await store.size()).toBe(1);
  });

  test("a retraction tombstones the pulled copy, and only the sharer's copy", async () => {
    const bot = harness("bot", "bot");
    const cli = harness("cli", "concierge");
    const botStore = createMemoryStore({
      specName: "bot",
      rootDir: join(bot, ".crewhaus", "memories"),
    });
    const wrong = await botStore.remember("the office is on floor 3");
    const shared = join(root, ".crewhaus-shared");
    await push(bot, shared, "bot");
    await pull(cli, shared);
    const cliStore = createMemoryStore({
      specName: "concierge",
      rootDir: join(cli, ".crewhaus", "memories"),
    });
    expect(await cliStore.size()).toBe(1);

    await botStore.supersede(wrong.id, "the office is on floor 4", { reason: "moved" });
    const plan = await push(bot, shared, "bot");
    expect(plan.retractions.map((r) => r.reason)).toEqual(["superseded"]);
    // A re-run retracts nothing twice.
    expect((await push(bot, shared, "bot")).retractions).toEqual([]);
    expect(readRetractions(shared)).toHaveLength(1);

    const outcome = await pull(cli, shared);
    expect(outcome.retracted).toHaveLength(1);
    const items = await cliStore.list();
    expect(items.filter((i) => i.status === "live").map((i) => i.entry.text)).toEqual([
      "the office is on floor 4",
    ]);
    expect(readFileSync(cliStore.path(), "utf-8")).toContain("retracted by bot");
  });

  test("a fact corrected and then compacted away is still retracted, once", async () => {
    const bot = harness("bot", "bot");
    const botStore = createMemoryStore({
      specName: "bot",
      rootDir: join(bot, ".crewhaus", "memories"),
    });
    const wrong = await botStore.remember("the office is on floor 3");
    const shared = join(root, ".crewhaus-shared");
    await push(bot, shared, "bot");
    await botStore.supersede(wrong.id, "the office is on floor 4", { reason: "moved" });
    expect((await botStore.compact()).archived).toBe(2);
    expect(readFileSync(botStore.path(), "utf-8")).not.toContain("floor 3");
    const plan = await push(bot, shared, "bot");
    expect(plan.retractions.map((r) => [r.contentHash, r.reason])).toEqual([
      [memoryContentHash("the office is on floor 3", []), "superseded"],
    ]);
    expect((await push(bot, shared, "bot")).retractions).toEqual([]);
  });

  test("a pulled fact a person forgot stays forgotten after a compaction", async () => {
    const bot = harness("bot", "bot");
    const cli = harness("cli", "concierge");
    await createMemoryStore({
      specName: "bot",
      rootDir: join(bot, ".crewhaus", "memories"),
    }).remember("the office is on floor 3");
    const shared = join(root, ".crewhaus-shared");
    await push(bot, shared, "bot");
    const [id] = (await pull(cli, shared)).added;
    const cliStore = createMemoryStore({
      specName: "concierge",
      rootDir: join(cli, ".crewhaus", "memories"),
    });
    await cliStore.forget(id as string, { reason: "wrong" });
    await cliStore.compact();
    expect((await pull(cli, shared)).added).toEqual([]);
    expect(await cliStore.size()).toBe(0);
  });

  test("a pulled fact a person corrected stays corrected after a compaction", async () => {
    const bot = harness("bot", "bot");
    const cli = harness("cli", "concierge");
    await createMemoryStore({
      specName: "bot",
      rootDir: join(bot, ".crewhaus", "memories"),
    }).remember("the office is on floor 3");
    const shared = join(root, ".crewhaus-shared");
    await push(bot, shared, "bot");
    const [id] = (await pull(cli, shared)).added;
    const cliStore = createMemoryStore({
      specName: "concierge",
      rootDir: join(cli, ".crewhaus", "memories"),
    });
    await cliStore.supersede(id as string, "the office is on floor 4", { reason: "moved" });
    await cliStore.compact();
    expect((await pull(cli, shared)).added).toEqual([]);
    const live = (await cliStore.list()).filter((i) => i.status === "live");
    expect(live.map((i) => i.entry.text)).toEqual(["the office is on floor 4"]);
  });

  test("a retraction from another harness leaves the pulled copy alone; a malformed line is skipped", async () => {
    const bot = harness("bot", "bot");
    const cli = harness("cli", "concierge");
    await createMemoryStore({
      specName: "bot",
      rootDir: join(bot, ".crewhaus", "memories"),
    }).remember("a shared fact");
    const shared = join(root, ".crewhaus-shared");
    await push(bot, shared, "bot");
    await pull(cli, shared);
    const hash = readSharedMemories(shared)[0]?.contentHash as string;
    writeFileSync(
      join(shared, "retractions.jsonl"),
      `${JSON.stringify({ contentHash: hash, harness: "intruder", at: "t", reason: "superseded" })}\n{not json\n${JSON.stringify({ contentHash: "zz", harness: "bot", at: "t", reason: "superseded" })}\n`,
    );
    expect(readRetractions(shared)).toHaveLength(1);
    expect((await pull(cli, shared)).retracted).toEqual([]);
    expect(
      await createMemoryStore({
        specName: "concierge",
        rootDir: join(cli, ".crewhaus", "memories"),
      }).size(),
    ).toBe(1);
  });

  test("the pull refuses without a spec name, writing nothing", async () => {
    const bot = harness("bot", "bot");
    const cli = harness("cli");
    await createMemoryStore({
      specName: "bot",
      rootDir: join(bot, ".crewhaus", "memories"),
    }).remember("x");
    const shared = join(root, ".crewhaus-shared");
    await push(bot, shared, "bot");
    expect(harnessSpecName(cli)).toBeUndefined();
    await expect(pull(cli, shared)).rejects.toThrow(
      "Pull needs this harness's crewhaus.yaml to know which memory store to fill.",
    );
    expect(existsSync(join(cli, ".crewhaus"))).toBe(false);
  });

  test("harnessSpecName reads the top-level name tolerantly", () => {
    const dir = harness("h");
    const cases: Array<[string, string | undefined]> = [
      ["name: support-bot\n", "support-bot"],
      ['name: "quoted"\n', "quoted"],
      ["name: spaced # comment\n", "spaced"],
      ["shape: cli\n  name: nested\n", undefined],
      ["name: ../evil\n", undefined],
      ["name:\n", undefined],
    ];
    for (const [text, want] of cases) {
      writeFileSync(join(dir, "crewhaus.yaml"), text);
      expect(harnessSpecName(dir)).toBe(want);
    }
  });

  test("validateSharedMemory carries a well-typed origin and drops an ill-typed one", () => {
    const base = { text: "t", tags: [], provenance: { harness: "a", pushedAt: "x" } };
    const rec = { ...base, contentHash: memoryContentHash("t", []) };
    const good = validateSharedMemory({ ...rec, origin: { harness: "a", fact: "mem_1" } });
    expect(good.ok && good.memory.origin).toEqual({ harness: "a", fact: "mem_1" });
    const bad = validateSharedMemory({ ...rec, origin: { harness: 7 } });
    expect(bad.ok).toBe(true);
    expect(bad.ok && bad.memory.origin).toBeUndefined();
  });
});
