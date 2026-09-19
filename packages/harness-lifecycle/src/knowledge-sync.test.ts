import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  looksLikeSecret,
  maskKnowledgeSecrets,
  memoryContentHash,
  planPull,
  planPush,
  readHarnessMemories,
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
