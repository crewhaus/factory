/**
 * Erasing a person's data from the shared knowledge store, driven only by the erasure door.
 *
 * {@link eraseShared} rewrites `memories.jsonl` without the named lines (a temporary file and
 * a rename) and appends one `erased` retraction per line it removed, so every harness that
 * pulled a copy drops it at its next pull. The retraction names the content hash and the
 * harness that shared it, never the text. It acts only on a grant whose scope is this store
 * and names every hash, and a re-run removes and appends nothing.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { type ErasureGrant, erasureTargets } from "@crewhaus/control-contract/knowledge";
import { appendContained, openForReadSync, writeFileSafe } from "@crewhaus/tool-safety/fs";
import {
  KnowledgeSyncError,
  type Retraction,
  SHARED_RETRACTIONS_FILE,
  memoryContentHash,
  readRetractions,
} from "./knowledge-sync";

const MEMORIES_FILE = "memories.jsonl";
const SHARED_MAX_BYTES = 512 * 1024 * 1024;
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;

export type SharedErasure = {
  /** Lines removed from the shared store. */
  readonly removed: number;
  /** Retractions appended for the copies already pulled. */
  readonly retracted: number;
};

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** Whether the retractions file ends in the middle of a line. */
function endsTorn(root: string): boolean {
  const read = openForReadSync(root, SHARED_RETRACTIONS_FILE, {
    maxBytes: SHARED_MAX_BYTES,
    followLeafSymlink: false,
  });
  return read.ok && read.bytes.length > 0 && read.bytes[read.bytes.length - 1] !== 0x0a;
}

/**
 * One shared line: the hash of what it says, and who shared it. A hash the line states is
 * never taken on its word: only what the line says can name it.
 */
function readLine(line: string): { readonly hashes: readonly string[]; readonly harness: string } {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { hashes: [], harness: "unknown" };
  }
  if (typeof rec !== "object" || rec === null) return { hashes: [], harness: "unknown" };
  const tags = Array.isArray(rec["tags"])
    ? rec["tags"].filter((t): t is string => typeof t === "string")
    : [];
  const provenance = rec["provenance"] as { harness?: unknown } | null | undefined;
  return {
    hashes: typeof rec["text"] === "string" ? [memoryContentHash(rec["text"], tags)] : [],
    harness: typeof provenance?.harness === "string" ? provenance.harness : "unknown",
  };
}

/**
 * Remove the lines of these content hashes from the shared store and retract the copies
 * pulled from it. Throws {@link KnowledgeSyncError}, changing nothing, for a grant of another
 * store or root, a hash the grant does not name, or a store file that is not a plain file.
 */
export async function eraseShared(
  sharedDir: string,
  contentHashes: readonly string[],
  grant: ErasureGrant,
  now: () => Date = () => new Date(),
): Promise<SharedErasure> {
  const root = resolve(sharedDir);
  const targets = erasureTargets(grant, {
    store: "shared",
    sameRoot: (given) => sameDir(given, root),
  });
  if (targets === undefined) {
    throw new KnowledgeSyncError("this erasure does not cover the shared store");
  }
  for (const hash of contentHashes) {
    if (!CONTENT_HASH_RE.test(hash) || !targets.has(hash)) {
      throw new KnowledgeSyncError("this erasure does not name every shared memory it was given");
    }
  }
  if (contentHashes.length === 0) return { removed: 0, retracted: 0 };
  const wanted = new Set(contentHashes);
  const read = openForReadSync(root, MEMORIES_FILE, {
    maxBytes: SHARED_MAX_BYTES,
    followLeafSymlink: false,
  });
  if (!read.ok) {
    if (read.code === "not-found") return { removed: 0, retracted: 0 };
    throw new KnowledgeSyncError(`refusing to read the shared memories: ${read.reason}`);
  }
  if (read.truncated) {
    throw new KnowledgeSyncError(
      `the shared memories are larger than ${SHARED_MAX_BYTES} bytes, so they were not rewritten`,
    );
  }
  const kept: string[] = [];
  const gone: { readonly hash: string; readonly harness: string }[] = [];
  for (const line of read.text.split("\n")) {
    if (line.trim() === "") continue;
    const { hashes, harness } = readLine(line);
    const hit = hashes.filter((hash) => wanted.has(hash));
    if (hit.length === 0) {
      kept.push(line);
      continue;
    }
    for (const hash of new Set(hit)) gone.push({ hash, harness });
  }
  if (gone.length === 0) return { removed: 0, retracted: 0 };
  // Retractions first: a crash before the rewrite leaves the lines for the re-run, which
  // appends none twice.
  const retracted = new Set(
    readRetractions(root)
      .filter((r) => r.reason === "erased")
      .map((r) => `${r.harness}\n${r.contentHash}`),
  );
  const fresh: Retraction[] = [];
  for (const { hash, harness } of gone) {
    const entry = `${harness}\n${hash}`;
    if (retracted.has(entry)) continue;
    retracted.add(entry);
    fresh.push({ contentHash: hash, harness, at: now().toISOString(), reason: "erased" });
  }
  if (fresh.length > 0) {
    const appended = appendContained(
      root,
      SHARED_RETRACTIONS_FILE,
      // A line of its own, whatever an earlier write left at the end of the file.
      `${endsTorn(root) ? "\n" : ""}${fresh.map((r) => `${JSON.stringify(r)}\n`).join("")}`,
      { mode: 0o600 },
    );
    if (!appended.ok) {
      throw new KnowledgeSyncError(`refusing to retract the shared memories: ${appended.reason}`);
    }
  }
  const written = writeFileSafe(
    root,
    MEMORIES_FILE,
    kept.length > 0 ? `${kept.join("\n")}\n` : "",
    { overwrite: true, mode: 0o600 },
  );
  if (!written.ok) {
    throw new KnowledgeSyncError(`refusing to rewrite the shared memories: ${written.reason}`);
  }
  return { removed: gone.length, retracted: fresh.length };
}
