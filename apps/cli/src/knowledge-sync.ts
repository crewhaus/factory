/**
 * Item 63 — cross-harness knowledge sync. `crewhaus knowledge sync
 * [--pull|--push]` moves three kinds of hard-won knowledge between a harness
 * and a fleet-level SHARED store, so a lesson the Slack bot learned reaches
 * the CLI concierge:
 *   - memories: `@crewhaus/memory-store` JSONL entries (facts the agent should
 *     remember across sessions);
 *   - graders: reusable `graders.yaml` fragments (a grader suite one harness
 *     hardened is worth sharing);
 *   - prompt fragments: few-shot examples / lessons (`.md` snippets).
 *
 * Factored out of the entry file `index.ts` (which runs a top-level argv
 * switch and so cannot be imported by a test without executing the CLI).
 * Side-effect-free on import, mirroring `state-backup.ts` / `retention.ts`:
 *   - the merge (dedupe-by-content-hash) + provenance tagging are pure;
 *   - the redactor is injected (a `Redactor` seam over `@crewhaus/pii-redactor`
 *     with an added token detector), so redaction is tested without the
 *     package; the real CLI wires the concrete redactor.
 *
 * SHARED STORE FORMAT — a fleet-level directory (default `.crewhaus-shared/`
 * under the fleet root, or `CREWHAUS_SHARED_DIR`):
 *
 *   .crewhaus-shared/
 *     memories.jsonl              one line per shared memory:
 *                                 { contentHash, text, tags, provenance }
 *     graders/<contentHash>.yaml  one shared grader fragment per file
 *     prompts/<contentHash>.md    one shared prompt fragment per file
 *     manifest.jsonl              append-only provenance log of every push
 *
 * DEDUPE — every artifact is keyed by the sha256 of its NORMALIZED content
 * (memory: text+sorted-tags; grader/prompt: the file bytes). A push adds an
 * artifact only when its hash is new to the shared store; a pull adds it to
 * the harness only when the harness lacks it. Re-running a sync is therefore a
 * no-op — the same determinism contract as `state-backup`'s feedback merge.
 *
 * PROVENANCE — each shared artifact records which harness pushed it and when,
 * so `sync` never loses attribution and a pulled memory can be traced home.
 *
 * REDACTION ON PUSH — text pushed OUT of a harness is run through the injected
 * redactor first (PII categories from pii-redactor PLUS a token detector for
 * credential-shaped strings). A memory whose text still holds a
 * credential-shaped token AFTER redaction is DROPPED with a warning, not
 * shared — leaking one into the shared store would poison every harness that
 * pulls it.
 *
 * OPT-IN — a harness participates only when it carries a
 * `.crewhaus/knowledge.json` marker (`{ "share": true }`). A harness that
 * hasn't opted in is skipped by a fleet-wide sync.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Thrown for operational failures. The CLI routes the message through
 *  `die()`; tests assert on `.message`. */
export class KnowledgeSyncError extends Error {
  override readonly name = "KnowledgeSyncError";
}

export const SHARED_DIR_DEFAULT = ".crewhaus-shared";
export const KNOWLEDGE_MARKER_RELPATH = ".crewhaus/knowledge.json";
const MEMORIES_RELPATH = ".crewhaus/memories";
const GRADERS_FILE_CANDIDATES = ["graders.yaml", ".crewhaus/graders.yaml"];
const PROMPTS_RELDIR = ".crewhaus/prompts";

// ---------------------------------------------------------------------------
// content hashing + normalization
// ---------------------------------------------------------------------------

/** sha256 hex of a normalized memory (text + sorted, deduped tags) — the
 *  dedupe key, independent of tag order or the memory's own id/timestamp. */
export function memoryContentHash(text: string, tags: ReadonlyArray<string>): string {
  const normTags = [...new Set(tags)].sort();
  return createHash("sha256")
    .update(`${text.trim()}\n${normTags.join(",")}`)
    .digest("hex");
}

/** sha256 hex of a file fragment's bytes (grader/prompt), trimmed. */
export function fragmentContentHash(bytes: string): string {
  return createHash("sha256").update(bytes.trim()).digest("hex");
}

// ---------------------------------------------------------------------------
// artifact types
// ---------------------------------------------------------------------------

export type Provenance = {
  /** The harness that pushed the artifact. */
  readonly harness: string;
  readonly pushedAt: string;
};

export type SharedMemory = {
  readonly contentHash: string;
  readonly text: string;
  readonly tags: ReadonlyArray<string>;
  readonly provenance: Provenance;
};

export type SharedFragment = {
  readonly contentHash: string;
  readonly kind: "grader" | "prompt";
  readonly filename: string;
  readonly contents: string;
  readonly provenance: Provenance;
};

// ---------------------------------------------------------------------------
// redaction seam
// ---------------------------------------------------------------------------

export type RedactionOutcome = {
  readonly text: string;
  /** True when a credential-shaped token remained AFTER redaction (drop it). */
  readonly secretRemains: boolean;
};

/** Redactor seam: redact a string for pushing to the shared store. Production
 *  wraps `@crewhaus/pii-redactor` + a token detector; tests inject a stub. */
export type Redactor = (text: string) => Promise<RedactionOutcome>;

/** A pass-through redactor (tests / --no-redact). Never flags tokens. */
export const IDENTITY_REDACTOR: Redactor = async (text) => ({ text, secretRemains: false });

// ---------------------------------------------------------------------------
// credential-shaped token detection (F1 — leak-proof knowledge push)
// ---------------------------------------------------------------------------

/**
 * Credential-shaped token detectors, used both to REDACT a token out of pushed
 * text and to CHECK (post-redaction) that nothing credential-shaped survived —
 * a memory whose text still holds a secret after redaction is DROPPED, never
 * shared (a leaked credential poisons every harness that pulls it).
 *
 * The prior custom set MISSED whole credential families — AWS secret access
 * keys (their `/`+`+` alphabet), Stripe `sk_live_…`/`sk_test_…` (the `_` after
 * the prefix), PEM private-key BODIES (only the header was caught), Slack
 * `xoxb-` tails — so those leaked verbatim into the shared store. This set is
 * the union of the battle-tested shapes shipped elsewhere in the repo
 * (`packages/ir|spec-patch/src/redact.ts` `TOKEN_SHAPE_RES`,
 * `apps/cli/src/dataset-mine.ts` `SECRET_KEY_DETECTOR`) PLUS the families they
 * predate.
 *
 * Every pattern is assembled from character-class parts / joined literals so
 * NO credential-shaped literal appears in this source (repo push-protection).
 */
const b62 = "[A-Za-z0-9]";
const b64 = "[A-Za-z0-9+/]"; // base64 alphabet incl. `+` and `/` (AWS secret keys)

/** The credential token shapes, each a global RegExp so `replace` masks every
 *  occurrence. Order matters only for the PEM block (masked whole, first). */
export const KNOWLEDGE_SECRET_DETECTORS: ReadonlyArray<{ kind: string; regex: RegExp }> = [
  // PEM blocks — mask the WHOLE block (header + body + footer), not just the
  // header. `[\s\S]` so it spans newlines; non-greedy so adjacent blocks split.
  {
    kind: "pem_block",
    regex: /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,
  },
  // JWT: three base64url segments separated by dots.
  {
    kind: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  // Stripe-style keys: (sk|pk|rk)_(live|test)_<tail> — the `_` after the prefix
  // is what broke the old `sk-`-only match.
  {
    kind: "stripe_key",
    regex: new RegExp(`\\b(?:sk|pk|rk)_(?:live|test)_${b62}{16,}\\b`, "g"),
  },
  // Generic provider secret keys: `sk-…` (OpenAI/Anthropic), allowing `_`/`-`.
  { kind: "sk_key", regex: /\bsk-[A-Za-z0-9_-]{16,}/g },
  // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_ + long tail.
  { kind: "github_token", regex: /\bgh[oprsu]_[A-Za-z0-9]{16,}/g },
  // Slack tokens: xox[baprs]-… (the whole dashed tail, not just the prefix).
  { kind: "slack_token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  // AWS access key id: AKIA + 12+ uppercase/digit chars.
  { kind: "aws_access_key_id", regex: /\bAKIA[A-Z0-9]{12,}/g },
  // AWS secret access key: a 40-char base64 blob (incl. `/` and `+`), matched
  // standalone (context-free) — the `/`+`+` alphabet is exactly what the old
  // base62 detector missed. Longer/shorter high-entropy blobs are caught by the
  // looksLikeSecret fallback (which DROPS rather than masks).
  { kind: "aws_secret_key", regex: new RegExp(`\\b${b64}{40}\\b`, "g") },
  // `Bearer <token>` — scheme word kept, token masked (mirrors repo BEARER_RE).
  { kind: "bearer", regex: /\b(bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/gi },
];

/**
 * A conservative "this looks like a secret" heuristic used as the STRICT
 * fallback: after redaction, if ANY of these fire on the surviving text the
 * artifact is DROPPED rather than shared. It combines the named detectors above
 * with a high-entropy long-token probe (32+ chars mixing letter+digit, or a
 * 40+-char base64 blob) so a novel credential shape the named set doesn't
 * recognize is still refused rather than leaked.
 */
const HIGH_ENTROPY_MIXED_RE =
  /\b(?=[A-Za-z0-9+/_-]*[A-Za-z])(?=[A-Za-z0-9+/_-]*[0-9])[A-Za-z0-9+/_-]{32,}\b/;
const LONG_BASE64_RE = new RegExp(`\\b${b64}{40,}\\b`);

/** True when `text` still contains something credential-shaped — used as the
 *  `secretRemains` verdict AFTER redaction so anything suspicious is dropped. */
export function looksLikeSecret(text: string): boolean {
  for (const d of KNOWLEDGE_SECRET_DETECTORS) {
    // Fresh lastIndex isn't a concern: `.test` on a `g` regex advances
    // lastIndex, so reset before each probe to keep this deterministic.
    d.regex.lastIndex = 0;
    if (d.regex.test(text)) return true;
  }
  return HIGH_ENTROPY_MIXED_RE.test(text) || LONG_BASE64_RE.test(text);
}

/**
 * Mask every credential-shaped token in `text` with `***`. PEM blocks are
 * masked whole. Pure + synchronous — the PII pass is layered on top by
 * {@link buildKnowledgeRedactor}.
 */
export function maskKnowledgeSecrets(text: string): string {
  let out = text;
  for (const d of KNOWLEDGE_SECRET_DETECTORS) {
    d.regex.lastIndex = 0;
    if (d.kind === "bearer") {
      // Group 1 is the scheme word "bearer" — keep it, mask only the token.
      out = out.replace(d.regex, (_m, scheme: string) => `${scheme} ***`);
    } else {
      out = out.replace(d.regex, "***");
    }
  }
  return out;
}

/** Primitive PII pass injected into {@link buildKnowledgeRedactor}: redact PII
 *  and return the cleaned text. Production wraps `@crewhaus/pii-redactor`;
 *  tests can inject an identity pass to exercise only the credential layer. */
export type PiiPass = (text: string) => Promise<string>;

/**
 * Build the production knowledge redactor: run a PII pass, then mask every
 * credential-shaped token, then re-scan the result with the STRICT
 * {@link looksLikeSecret} heuristic — anything that still looks like a secret
 * sets `secretRemains` so the caller DROPS the artifact rather than share a
 * leaked credential.
 *
 * The `piiPass` is injected so this is unit-testable without the redactor
 * package (the CLI wires the real `@crewhaus/pii-redactor` pass).
 */
export function buildKnowledgeRedactor(piiPass: PiiPass): Redactor {
  return async (text: string) => {
    const afterPii = await piiPass(text);
    const masked = maskKnowledgeSecrets(afterPii);
    return { text: masked, secretRemains: looksLikeSecret(masked) };
  };
}

// ---------------------------------------------------------------------------
// harness reads
// ---------------------------------------------------------------------------

/** Whether a harness has opted into knowledge sharing (marker file with
 *  `{ share: true }`). */
export function harnessOptedIn(harnessDir: string): boolean {
  const path = join(harnessDir, KNOWLEDGE_MARKER_RELPATH);
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { share?: unknown };
    return parsed.share === true;
  } catch {
    return false;
  }
}

type RawMemory = { text: string; tags: ReadonlyArray<string> };

/** Read every memory-store entry across a harness's `.crewhaus/memories/*.jsonl`. */
export function readHarnessMemories(harnessDir: string): RawMemory[] {
  const dir = join(harnessDir, MEMORIES_RELPATH);
  if (!existsSync(dir)) return [];
  const out: RawMemory[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(dir, f), "utf-8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const rec = JSON.parse(line) as { text?: unknown; tags?: unknown };
        if (typeof rec.text !== "string") continue;
        const tags = Array.isArray(rec.tags)
          ? rec.tags.filter((t): t is string => typeof t === "string")
          : [];
        out.push({ text: rec.text, tags });
      } catch {
        // tolerated
      }
    }
  }
  return out;
}

/** Read a harness's grader fragment (first of the candidate paths present). */
export function readHarnessGraders(
  harnessDir: string,
): { filename: string; contents: string } | undefined {
  for (const rel of GRADERS_FILE_CANDIDATES) {
    const path = join(harnessDir, rel);
    if (existsSync(path)) {
      return { filename: rel.split("/").pop() as string, contents: readFileSync(path, "utf-8") };
    }
  }
  return undefined;
}

/** Read a harness's prompt fragments (`.crewhaus/prompts/*.md`). */
export function readHarnessPrompts(
  harnessDir: string,
): Array<{ filename: string; contents: string }> {
  const dir = join(harnessDir, PROMPTS_RELDIR);
  if (!existsSync(dir)) return [];
  const out: Array<{ filename: string; contents: string }> = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md") && !f.endsWith(".txt")) continue;
    out.push({ filename: f, contents: readFileSync(join(dir, f), "utf-8") });
  }
  return out.sort((a, b) => a.filename.localeCompare(b.filename));
}

// ---------------------------------------------------------------------------
// shared-store reads
// ---------------------------------------------------------------------------

/** Upper bound on a shared memory's text length. A shared store is untrusted
 *  input on pull; an absurdly long "memory" is a poisoning / DoS vector, never
 *  a real lesson. 64 KiB is far above any genuine memory. */
export const MAX_SHARED_MEMORY_TEXT = 64 * 1024;

/**
 * Validate one parsed shared-memory record (F6). A pulled record is UNTRUSTED:
 * the file could have been hand-edited to poison the harness's dedupe (a lying
 * `contentHash` so a malicious `text` masquerades as an already-trusted entry)
 * or to bloat it (oversized text / malformed tags). Returns the record when it
 * is a well-formed {@link SharedMemory} whose stored `contentHash` MATCHES the
 * recomputed hash of its own text+tags; otherwise a `reason` for the skip.
 */
export function validateSharedMemory(
  rec: unknown,
): { ok: true; memory: SharedMemory } | { ok: false; reason: string } {
  if (rec === null || typeof rec !== "object") return { ok: false, reason: "not an object" };
  const r = rec as Record<string, unknown>;
  if (typeof r["contentHash"] !== "string")
    return { ok: false, reason: "contentHash not a string" };
  if (typeof r["text"] !== "string") return { ok: false, reason: "text not a string" };
  if (r["text"].length > MAX_SHARED_MEMORY_TEXT) {
    return { ok: false, reason: `text exceeds ${MAX_SHARED_MEMORY_TEXT} bytes` };
  }
  if (!Array.isArray(r["tags"]) || !r["tags"].every((t) => typeof t === "string")) {
    return { ok: false, reason: "tags is not a string[]" };
  }
  const tags = r["tags"] as string[];
  // Re-hash text+tags and reject a record whose stored hash lies — this is what
  // defeats dedupe-poisoning (a forged hash colliding with a trusted entry).
  const recomputed = memoryContentHash(r["text"], tags);
  if (recomputed !== r["contentHash"]) {
    return { ok: false, reason: "contentHash does not match recomputed hash of text+tags" };
  }
  const prov = r["provenance"];
  const provenance: Provenance =
    prov !== null &&
    typeof prov === "object" &&
    typeof (prov as Provenance).harness === "string" &&
    typeof (prov as Provenance).pushedAt === "string"
      ? (prov as Provenance)
      : { harness: "unknown", pushedAt: "unknown" };
  return {
    ok: true,
    memory: { contentHash: r["contentHash"], text: r["text"], tags, provenance },
  };
}

/** Read the shared memories.jsonl. Missing → []. Each record is validated as a
 *  proper {@link SharedMemory} with a matching content hash (F6); invalid
 *  records are SKIPPED with a warning to stderr, never loaded. */
export function readSharedMemories(sharedDir: string): SharedMemory[] {
  const path = join(sharedDir, "memories.jsonl");
  if (!existsSync(path)) return [];
  const out: SharedMemory[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // tolerated — a malformed JSON line
    }
    const v = validateSharedMemory(parsed);
    if (v.ok) {
      out.push(v.memory);
    } else {
      warnSkippedShared(`memory (${v.reason})`);
    }
  }
  return out;
}

/** Emit a skip warning for a rejected shared artifact. Isolated so tests can
 *  silence/observe it and the two readers share one message shape. */
function warnSkippedShared(what: string): void {
  process.stderr.write(`crewhaus: warning: skipped invalid shared ${what}\n`);
}

/** Read the shared fragments of a kind (`graders/` or `prompts/`). */
export function readSharedFragments(
  sharedDir: string,
  kind: "grader" | "prompt",
): SharedFragment[] {
  const dir = join(sharedDir, kind === "grader" ? "graders" : "prompts");
  if (!existsSync(dir)) return [];
  const out: SharedFragment[] = [];
  const ext = kind === "grader" ? ".yaml" : ".md";
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(ext)) continue;
    const contents = readFileSync(join(dir, f), "utf-8");
    // Strip the provenance header line if present; the body is the fragment.
    const { provenance, body } = splitProvenanceHeader(contents);
    // F6 — the filename IS the claimed content hash. RECOMPUTE it from the body
    // and reject a mismatch: a fragment file renamed to a trusted hash would
    // otherwise poison the harness's dedupe (pulled under a hash it thinks it
    // already vetted). Also bound the body size like memories.
    const claimedHash = f.slice(0, -ext.length);
    if (body.length > MAX_SHARED_MEMORY_TEXT) {
      warnSkippedShared(`${kind} fragment ${f} (exceeds ${MAX_SHARED_MEMORY_TEXT} bytes)`);
      continue;
    }
    if (fragmentContentHash(body) !== claimedHash) {
      warnSkippedShared(
        `${kind} fragment ${f} (filename hash does not match recomputed body hash)`,
      );
      continue;
    }
    out.push({
      contentHash: claimedHash,
      kind,
      filename: f,
      contents: body,
      provenance: provenance ?? { harness: "unknown", pushedAt: "unknown" },
    });
  }
  return out;
}

const PROVENANCE_HEADER_RE = /^#!\s*crewhaus-knowledge\s+(\{.*\})\s*$/;

/** A fragment file carries a first-line provenance comment
 *  `#! crewhaus-knowledge {json}`; split it from the body. */
export function splitProvenanceHeader(contents: string): {
  provenance?: Provenance;
  body: string;
} {
  const nl = contents.indexOf("\n");
  const firstLine = nl === -1 ? contents : contents.slice(0, nl);
  const m = PROVENANCE_HEADER_RE.exec(firstLine.trim());
  if (m === null) return { body: contents };
  try {
    const provenance = JSON.parse(m[1] as string) as Provenance;
    return { provenance, body: nl === -1 ? "" : contents.slice(nl + 1) };
  } catch {
    return { body: contents };
  }
}

/** Prepend a provenance header line to a fragment body. */
export function withProvenanceHeader(body: string, provenance: Provenance): string {
  return `#! crewhaus-knowledge ${JSON.stringify(provenance)}\n${body}`;
}

// ---------------------------------------------------------------------------
// push (harness → shared)
// ---------------------------------------------------------------------------

export type PushPlan = {
  readonly memories: ReadonlyArray<SharedMemory>;
  readonly fragments: ReadonlyArray<SharedFragment>;
  /** Memories dropped because a token survived redaction. */
  readonly droppedSecrets: ReadonlyArray<string>;
  /** Artifacts already present in the shared store (deduped away). */
  readonly skippedDuplicates: number;
};

/**
 * Plan a push: redact each harness memory, drop any whose text still carries a
 * credential-shaped token, hash the rest, and keep only artifacts whose
 * content hash is NEW to the shared store. Pure over the injected redactor +
 * the current shared hashes. Grader/prompt fragments are redacted too (a
 * lesson can quote a key).
 */
export async function planPush(opts: {
  readonly harness: string;
  readonly memories: ReadonlyArray<RawMemory>;
  readonly graders?: { filename: string; contents: string } | undefined;
  readonly prompts: ReadonlyArray<{ filename: string; contents: string }>;
  readonly existingMemoryHashes: ReadonlySet<string>;
  readonly existingFragmentHashes: ReadonlySet<string>;
  readonly redact: Redactor;
  readonly now: () => Date;
}): Promise<PushPlan> {
  const provenance: Provenance = { harness: opts.harness, pushedAt: opts.now().toISOString() };
  const memories: SharedMemory[] = [];
  const droppedSecrets: string[] = [];
  let skippedDuplicates = 0;
  const seenThisPush = new Set<string>();

  for (const m of opts.memories) {
    const outcome = await opts.redact(m.text);
    if (outcome.secretRemains) {
      droppedSecrets.push(m.text.slice(0, 60));
      continue;
    }
    const hash = memoryContentHash(outcome.text, m.tags);
    if (opts.existingMemoryHashes.has(hash) || seenThisPush.has(hash)) {
      skippedDuplicates += 1;
      continue;
    }
    seenThisPush.add(hash);
    memories.push({ contentHash: hash, text: outcome.text, tags: m.tags, provenance });
  }

  const fragments: SharedFragment[] = [];
  const pushFragment = async (
    kind: "grader" | "prompt",
    filename: string,
    contents: string,
  ): Promise<void> => {
    const outcome = await opts.redact(contents);
    if (outcome.secretRemains) {
      droppedSecrets.push(`${filename} (fragment)`);
      return;
    }
    const hash = fragmentContentHash(outcome.text);
    if (opts.existingFragmentHashes.has(hash) || seenThisPush.has(hash)) {
      skippedDuplicates += 1;
      return;
    }
    seenThisPush.add(hash);
    fragments.push({ contentHash: hash, kind, filename, contents: outcome.text, provenance });
  };
  if (opts.graders !== undefined) {
    await pushFragment("grader", opts.graders.filename, opts.graders.contents);
  }
  for (const p of opts.prompts) await pushFragment("prompt", p.filename, p.contents);

  return { memories, fragments, droppedSecrets, skippedDuplicates };
}

/** Write a push plan into the shared store (append memories, write fragment
 *  files, append the manifest log). Not called in --dry-run. */
export function applyPush(sharedDir: string, plan: PushPlan, now: () => Date): void {
  if (plan.memories.length === 0 && plan.fragments.length === 0) return;
  mkdirSync(sharedDir, { recursive: true });
  if (plan.memories.length > 0) {
    const path = join(sharedDir, "memories.jsonl");
    const lines = plan.memories.map((m) => JSON.stringify(m)).join("\n");
    appendLine(path, lines);
  }
  for (const frag of plan.fragments) {
    const dir = join(sharedDir, frag.kind === "grader" ? "graders" : "prompts");
    mkdirSync(dir, { recursive: true });
    const ext = frag.kind === "grader" ? ".yaml" : ".md";
    writeFileSync(
      join(dir, `${frag.contentHash}${ext}`),
      withProvenanceHeader(frag.contents, frag.provenance),
      { mode: 0o600 },
    );
  }
  appendLine(
    join(sharedDir, "manifest.jsonl"),
    JSON.stringify({
      action: "push",
      at: now().toISOString(),
      memories: plan.memories.map((m) => m.contentHash),
      fragments: plan.fragments.map((f) => `${f.kind}:${f.contentHash}`),
    }),
  );
}

function appendLine(path: string, line: string): void {
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const sep = existing === "" || existing.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${existing}${sep}${line}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// pull (shared → harness)
// ---------------------------------------------------------------------------

export type PullPlan = {
  /** Shared memories NOT already present in the harness. */
  readonly memories: ReadonlyArray<SharedMemory>;
  readonly fragments: ReadonlyArray<SharedFragment>;
  readonly skippedDuplicates: number;
};

/**
 * Plan a pull: shared artifacts whose content hash the harness does not
 * already have. Pure over the harness's existing hashes.
 */
export function planPull(opts: {
  readonly sharedMemories: ReadonlyArray<SharedMemory>;
  readonly sharedFragments: ReadonlyArray<SharedFragment>;
  readonly harnessMemoryHashes: ReadonlySet<string>;
  readonly harnessFragmentHashes: ReadonlySet<string>;
}): PullPlan {
  const memories = opts.sharedMemories.filter((m) => !opts.harnessMemoryHashes.has(m.contentHash));
  const fragments = opts.sharedFragments.filter(
    (f) => !opts.harnessFragmentHashes.has(f.contentHash),
  );
  const skippedDuplicates =
    opts.sharedMemories.length - memories.length + (opts.sharedFragments.length - fragments.length);
  return { memories, fragments, skippedDuplicates };
}

/** Write a pull plan into a harness: append memories to a shared-memories
 *  JSONL the memory-store already reads, and drop fragment files into
 *  `.crewhaus/prompts` / a `graders.shared.yaml`. Not called in --dry-run. */
export function applyPull(harnessDir: string, plan: PullPlan, now: () => Date): void {
  if (plan.memories.length > 0) {
    const dir = join(harnessDir, MEMORIES_RELPATH);
    mkdirSync(dir, { recursive: true });
    // Land in a dedicated shared file the memory-store loads alongside the
    // harness's own memories. Each entry is a valid MemoryEntry (id + text +
    // tags + createdAt), so recall() ranks them like local memories.
    const path = join(dir, "shared.jsonl");
    const stamp = now().toISOString();
    const lines = plan.memories.map((m) =>
      JSON.stringify({
        id: `mem_shared_${m.contentHash.slice(0, 16)}`,
        text: m.text,
        tags: [...m.tags, `shared:${m.provenance.harness}`],
        createdAt: stamp,
      }),
    );
    appendLine(path, lines.join("\n"));
  }
  for (const frag of plan.fragments) {
    if (frag.kind === "prompt") {
      const dir = join(harnessDir, PROMPTS_RELDIR);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `shared-${frag.contentHash.slice(0, 12)}.md`), frag.contents, {
        mode: 0o600,
      });
    } else {
      // grader fragments land beside the spec as graders.shared-*.yaml
      // (informational — a human folds them into graders.yaml; auto-merging
      // grader YAML is unsafe).
      writeFileSync(
        join(harnessDir, `graders.shared-${frag.contentHash.slice(0, 12)}.yaml`),
        frag.contents,
        { mode: 0o600 },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

export function formatPushReport(
  harness: string,
  plan: PushPlan,
  dryRun: boolean,
): ReadonlyArray<string> {
  const verb = dryRun ? "would push" : "pushed";
  const lines: string[] = [
    `${harness}: ${verb} ${plan.memories.length} memory(ies), ${plan.fragments.length} fragment(s)`,
  ];
  for (const s of plan.droppedSecrets) {
    lines.push(`  ⚠ dropped (token survived redaction): "${s}…"`);
  }
  if (plan.skippedDuplicates > 0) {
    lines.push(`  • ${plan.skippedDuplicates} already in the shared store (deduped)`);
  }
  return lines;
}

export function formatPullReport(
  harness: string,
  plan: PullPlan,
  dryRun: boolean,
): ReadonlyArray<string> {
  const verb = dryRun ? "would pull" : "pulled";
  const lines: string[] = [
    `${harness}: ${verb} ${plan.memories.length} memory(ies), ${plan.fragments.length} fragment(s)`,
  ];
  if (plan.skippedDuplicates > 0)
    lines.push(`  • ${plan.skippedDuplicates} already present (deduped)`);
  return lines;
}
