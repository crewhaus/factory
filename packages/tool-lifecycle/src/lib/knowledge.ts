/**
 * `KnowledgeSync`'s half: accounting for what a shared store contains that
 * could not be used, and wiring the redactor this build can honestly offer.
 *
 * The rules all belong to `@crewhaus/harness-lifecycle`: what a valid shared
 * memory is (`validateSharedMemory`, including the re-hash that defeats
 * dedupe-poisoning), what a credential looks like (`maskKnowledgeSecrets` /
 * `looksLikeSecret`), what to push (`planPush`) and what to pull
 * (`planPull`). None of it is restated here.
 *
 * Two things are added.
 *
 * FIRST, SKIPS ARE COUNTED. The package's readers drop an invalid shared
 * record with a warning to stderr and return the rest, which is right for a
 * CLI and wrong for a tool: a caller handed `{"memories": 12}` has no way to
 * know that 40 more were rejected as forged. A shared store is untrusted
 * input — the count of what it offered and could not be used is part of the
 * answer, not noise.
 *
 * SECOND, THE REDACTION GAP IS NAMED. Production wires
 * `buildKnowledgeRedactor` around `@crewhaus/pii-redactor`. That package is
 * not a dependency here, so this build runs the credential half — masking,
 * and the strict post-mask rescan that DROPS anything still secret-shaped —
 * with an identity PII pass. Names, emails and phone numbers are therefore
 * NOT redacted, and a push says so and requires the caller to acknowledge it
 * rather than quietly shipping a weaker guarantee under the same name.
 */
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import {
  type Redactor,
  type SharedFragment,
  type SharedMemory,
  buildKnowledgeRedactor,
  fragmentContentHash,
  memoryContentHash,
  readSharedFragments,
  validateSharedMemory,
} from "@crewhaus/harness-lifecycle";
import { type Loaded, fail } from "./result";

export const NO_PII_PASS_REASON =
  "@crewhaus/pii-redactor is not a dependency of @crewhaus/tool-lifecycle, so the PII pass of the " +
  "knowledge redactor is an identity function here: credential-shaped tokens ARE masked and any " +
  "artifact still secret-shaped afterwards is dropped, but names, emails, addresses and phone " +
  "numbers are NOT removed. Pass allowWithoutPiiRedaction to push on those terms.";

/**
 * The redactor this build can supply: the package's own credential masking
 * and its strict post-mask rescan, with an identity PII pass.
 *
 * `IDENTITY_REDACTOR` from the package is deliberately NOT used — it never
 * flags anything, so a memory holding an API key would be pushed verbatim.
 */
export function makeRedactor(): Redactor {
  return buildKnowledgeRedactor(async (text) => text);
}

// ---------------------------------------------------------------------------
// shared store, with the rejects counted
// ---------------------------------------------------------------------------

/**
 * The shared store's on-disk layout, as `applyPush` / `readSharedFragments`
 * write and read it. Mirrored once here so the audit, the containment check
 * and the post-push verification all name the same file rather than each
 * spelling the rule out again.
 */
export const SHARED_MEMORIES_RELPATH = "memories.jsonl";
export const SHARED_MANIFEST_RELPATH = "manifest.jsonl";
const SHARED_FRAGMENT_DIR = { grader: "graders", prompt: "prompts" } as const;
const SHARED_FRAGMENT_EXT = { grader: ".yaml", prompt: ".md" } as const;

export function sharedFragmentRelPath(frag: {
  readonly kind: "grader" | "prompt";
  readonly contentHash: string;
}): string {
  return `${SHARED_FRAGMENT_DIR[frag.kind]}/${frag.contentHash}${SHARED_FRAGMENT_EXT[frag.kind]}`;
}

export type Rejected = { readonly at: string; readonly reason: string };

export type SharedMemoryAudit = {
  readonly memories: ReadonlyArray<SharedMemory>;
  readonly rejected: ReadonlyArray<Rejected>;
  readonly linesSeen: number;
};

/**
 * Read the shared `memories.jsonl` through the package's own validator, and
 * keep the rejects instead of dropping them.
 *
 * A missing file is an empty store and says so; an unreadable one is a
 * failure and says THAT — a shared store that cannot be read is not a shared
 * store with nothing in it.
 */
export function auditSharedMemories(sharedDirAbs: string): Loaded<SharedMemoryAudit> {
  const file = path.join(sharedDirAbs, SHARED_MEMORIES_RELPATH);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: true, value: { memories: [], rejected: [], linesSeen: 0 } };
    return fail(
      "unreadable",
      `the shared memories file could not be read (${code ?? "unknown error"})`,
    );
  }
  const memories: SharedMemory[] = [];
  const rejected: Rejected[] = [];
  let linesSeen = 0;
  let lineNo = 0;
  for (const line of raw.split("\n")) {
    lineNo += 1;
    if (line.trim() === "") continue;
    linesSeen += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      rejected.push({ at: `memories.jsonl:${lineNo}`, reason: "not valid JSON" });
      continue;
    }
    const verdict = validateSharedMemory(parsed);
    if (verdict.ok) memories.push(verdict.memory);
    else rejected.push({ at: `memories.jsonl:${lineNo}`, reason: verdict.reason });
  }
  return { ok: true, value: { memories, rejected, linesSeen } };
}

export type SharedFragmentAudit = {
  readonly fragments: ReadonlyArray<SharedFragment>;
  readonly rejected: ReadonlyArray<Rejected>;
};

/**
 * Fragments of one kind, with the files the package's validation refused.
 *
 * The valid set comes from `readSharedFragments`, so the accept/reject rule
 * stays in one place; what is derived here is only WHICH candidate files did
 * not survive it. Re-deriving the rule to explain each rejection would be a
 * second copy of it, and the second copy is the one that goes stale.
 */
export function auditSharedFragments(
  sharedDirAbs: string,
  kind: "grader" | "prompt",
): Loaded<SharedFragmentAudit> {
  const dir = path.join(sharedDirAbs, SHARED_FRAGMENT_DIR[kind]);
  const ext = SHARED_FRAGMENT_EXT[kind];
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: true, value: { fragments: [], rejected: [] } };
    return fail(
      "unreadable",
      `the shared ${kind} directory could not be listed (${code ?? "unknown error"})`,
    );
  }
  let fragments: SharedFragment[];
  try {
    fragments = readSharedFragments(sharedDirAbs, kind);
  } catch (err) {
    return fail(
      "unreadable",
      `the shared ${kind} fragments could not be read: ${(err as Error).message}`,
    );
  }
  const accepted = new Set(fragments.map((f) => f.filename));
  const rejected = names
    .filter((n) => n.endsWith(ext) && !accepted.has(n))
    .map((n) => ({
      at: `${SHARED_FRAGMENT_DIR[kind]}/${n}`,
      reason:
        "refused by @crewhaus/harness-lifecycle's fragment validation — the filename's claimed content hash does not match the body's, or the body is over the size cap",
    }));
  return { ok: true, value: { fragments, rejected } };
}

// ---------------------------------------------------------------------------
// harness side
// ---------------------------------------------------------------------------

/**
 * The tag `applyPull` appends to every memory it lands
 * (`shared:<source harness>`).
 *
 * It matters because the content hash covers text AND tags: a memory pulled
 * from the shared store lands with one more tag than the record it came from,
 * so hashing what is on disk does NOT reproduce the shared record's hash. The
 * CLI computes the harness's hashes without accounting for it
 * (`apps/cli/src/index.ts`, the `knowledge pull` branch), which is why a
 * second pull re-imports everything and `shared.jsonl` grows on every run.
 *
 * `harnessMemoryHashes` below closes that by hashing a landed memory BOTH
 * ways. The hashing rule itself is still the package's `memoryContentHash`;
 * what is mirrored here is only the tag `applyPull` writes, and
 * `index.test.ts` pins it — a second pull must bring in nothing.
 */
export const SHARED_TAG_PREFIX = "shared:";

/**
 * Every content hash the harness already holds, counting a pulled memory
 * under its shared hash as well as its local one.
 *
 * The undo is EXACTLY `applyPull`'s do: it appends ONE provenance tag to the
 * end of the record's tags, so exactly one trailing tag is taken back off.
 * Stripping every `shared:`-prefixed tag instead — which is what this did —
 * is a different function, and it is wrong for the record that already
 * carried provenance of its own (one harness pulled a memory and pushed it
 * on, so the shared record's own tags include a `shared:` tag). For that
 * record neither form reproduced the shared hash, so the FIRST pull reported
 * `verified: false` with the memory listed as missing although it had landed
 * perfectly, and every later pull re-imported it — the unbounded growth this
 * mirror exists to prevent, reintroduced by the mirror.
 */
export function harnessMemoryHashes(
  memories: ReadonlyArray<{ readonly text: string; readonly tags: ReadonlyArray<string> }>,
): Set<string> {
  const hashes = new Set<string>();
  for (const memory of memories) {
    hashes.add(memoryContentHash(memory.text, memory.tags));
    const last = memory.tags[memory.tags.length - 1];
    if (last?.startsWith(SHARED_TAG_PREFIX) === true) {
      hashes.add(memoryContentHash(memory.text, memory.tags.slice(0, -1)));
    }
  }
  return hashes;
}

/**
 * Where `applyPull` lands each artifact inside a harness.
 *
 * Mirrored, not re-derived: the package chooses these paths and does not
 * export them, and a tool that cannot name them can neither contain the
 * writes (a symlink at one of them sends the file out of the workspace) nor
 * check that they arrived. `index.test.ts` pins every one of them against a
 * real pull, so a rename upstream fails a test here rather than silently
 * turning the checks into no-ops.
 */
export const PULLED_MEMORIES_RELPATH = ".crewhaus/memories/shared.jsonl";
const PULLED_PROMPT_RELDIR = ".crewhaus/prompts";
export const PULLED_GRADER_PREFIX = "graders.shared-";
export const PULLED_GRADER_SUFFIX = ".yaml";

export function pulledFragmentRelPath(frag: {
  readonly kind: "grader" | "prompt";
  readonly contentHash: string;
}): string {
  const short = frag.contentHash.slice(0, 12);
  return frag.kind === "prompt"
    ? `${PULLED_PROMPT_RELDIR}/shared-${short}.md`
    : `${PULLED_GRADER_PREFIX}${short}${PULLED_GRADER_SUFFIX}`;
}

/**
 * Content hashes of the grader fragments a previous pull already landed.
 *
 * `readHarnessGraders` looks only at `graders.yaml` / `.crewhaus/graders.yaml`
 * — by design, those are the harness's OWN grader files — so a fragment
 * `applyPull` wrote to `graders.shared-<hash>.yaml` is invisible to it, and
 * every later pull counted that fragment as new and reported pulling it
 * again. Matched by the filename shape and hashed with the package's own
 * `fragmentContentHash`, so the accept rule stays the package's; only the
 * landing name is mirrored.
 */
export function landedSharedGraderHashes(harnessDirAbs: string): Loaded<Set<string>> {
  let names: string[];
  try {
    names = readdirSync(harnessDirAbs).sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return fail(
      "unreadable",
      `the harness directory could not be listed (${code ?? "unknown error"})`,
    );
  }
  const hashes = new Set<string>();
  for (const name of names) {
    if (!name.startsWith(PULLED_GRADER_PREFIX) || !name.endsWith(PULLED_GRADER_SUFFIX)) continue;
    let contents: string;
    try {
      contents = readFileSync(path.join(harnessDirAbs, name), "utf8");
    } catch (err) {
      // An unreadable landed fragment is not an absent one: reporting it as
      // absent would make the next pull re-import it and call it new.
      return fail(
        "unreadable",
        `the pulled grader fragment ${name} could not be read (${(err as NodeJS.ErrnoException).code ?? "unknown error"})`,
      );
    }
    hashes.add(fragmentContentHash(contents));
  }
  return { ok: true, value: hashes };
}

export type HarnessMemoryAudit = {
  readonly dirPresent: boolean;
  readonly files: number;
  readonly linesSeen: number;
};

/**
 * How many lines the harness's memory files hold, so a store whose lines are
 * mostly unparseable is not reported as a store with few memories. The parsed
 * count comes from the package's `readHarnessMemories`; the difference
 * between the two is the interesting number.
 */
export function auditHarnessMemoryFiles(harnessDirAbs: string): Loaded<HarnessMemoryAudit> {
  const dir = path.join(harnessDirAbs, ".crewhaus", "memories");
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      return { ok: true, value: { dirPresent: false, files: 0, linesSeen: 0 } };
    return fail(
      "unreadable",
      `the harness memories directory could not be listed (${code ?? "unknown error"})`,
    );
  }
  let files = 0;
  let linesSeen = 0;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    files += 1;
    let raw: string;
    try {
      raw = readFileSync(path.join(dir, name), "utf8");
    } catch (err) {
      return fail(
        "unreadable",
        `the harness memory file ${name} could not be read (${(err as NodeJS.ErrnoException).code ?? "unknown error"})`,
      );
    }
    for (const line of raw.split("\n")) if (line.trim() !== "") linesSeen += 1;
  }
  return { ok: true, value: { dirPresent: true, files, linesSeen } };
}
