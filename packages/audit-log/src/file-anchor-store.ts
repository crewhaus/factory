/**
 * File-backed {@link AnchorStore} — append-only anchors under a directory.
 *
 * Layout: one JSONL file per `logId` under `dir`, named
 * `<sanitized-logId>-<sha256(logId)[0..16]>.jsonl` (the hash suffix keeps
 * distinct logIds collision-free after sanitization strips path separators).
 * Every accepted `putAnchor` APPENDS one self-describing line —
 * `{ logId, seq, hash, ts }` — and never rewrites earlier lines, so the file
 * itself is a history of every tail the writer published. `getAnchor`
 * returns the highest-`seq` line (ties: the latest write wins), which keeps
 * the witnessed tip monotonic exactly like {@link InMemoryAnchorStore};
 * a stale/replayed lower-`seq` put is skipped without a write.
 *
 * A corrupt or hand-edited anchor file makes `getAnchor` THROW rather than
 * silently drop witnessed anchors — dropping the highest-seq line would
 * quietly weaken `verify`'s truncation detection. `verify` treats a throwing
 * `getAnchor` as "anchor unavailable" (`externalAnchorChecked: false`), so
 * corruption degrades to a reported limitation, never a fabricated pass.
 *
 * THREAT MODEL — this store is only as tamper-resistant as its directory.
 * Point `dir` somewhere the audit writer's uid CANNOT rewrite (a separate
 * volume/mount, another user's append-only directory, or a WORM-backed
 * filesystem) to close the same-uid lockstep gap described in `index.ts`.
 * A `dir` on the same volume as the audit log, writable by the same uid,
 * adds durability across processes but NO additional tamper-resistance.
 *
 * Files are created 0o600 and the directory 0o700, mirroring the audit
 * log's owner-only posture.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CrewhausError, RuntimeError } from "@crewhaus/errors";
import type { AnchorRecord, AnchorStore } from "./index";

export class FileAnchorStoreError extends CrewhausError {
  override readonly name = "FileAnchorStoreError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type FileAnchorStoreOptions = {
  /** Optional clock for the informational `ts` field on each anchor line. */
  readonly now?: () => number;
};

/** One persisted line of an anchor file (the `AnchorRecord` plus provenance). */
type AnchorLine = {
  readonly logId: string;
  readonly seq: number;
  readonly hash: string;
  readonly ts: number;
};

/**
 * Derive the per-logId anchor filename. Sanitization removes every character
 * that could act as a path separator or traversal token, so an adversarial
 * `logId` cannot redirect the write outside `dir`; the sha256 suffix keeps
 * two logIds that sanitize identically (e.g. `/a/b` vs `_a_b`) apart.
 */
function anchorFileName(logId: string): string {
  const digest = createHash("sha256").update(logId).digest("hex").slice(0, 16);
  const sanitized = logId
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^[_.]+/, "")
    .slice(-64);
  return sanitized === "" ? `${digest}.jsonl` : `${sanitized}-${digest}.jsonl`;
}

export class FileAnchorStore implements AnchorStore {
  private readonly dir: string;
  private readonly now: () => number;

  constructor(dir: string, opts: FileAnchorStoreOptions = {}) {
    if (typeof dir !== "string" || dir === "") {
      throw new FileAnchorStoreError("dir is required");
    }
    this.dir = dir;
    this.now = opts.now ?? ((): number => Date.now());
  }

  private fileFor(logId: string): string {
    return join(this.dir, anchorFileName(logId));
  }

  async putAnchor(logId: string, anchor: AnchorRecord): Promise<void> {
    if (typeof anchor.seq !== "number" || !Number.isFinite(anchor.seq)) {
      throw new FileAnchorStoreError(`putAnchor: seq must be a finite number (got ${anchor.seq})`);
    }
    if (typeof anchor.hash !== "string" || anchor.hash === "") {
      throw new FileAnchorStoreError("putAnchor: hash is required");
    }
    // Monotonic: never let a stale/replayed put regress the witnessed tip.
    // (An equal-seq put IS appended — getAnchor's ties-take-latest keeps the
    // in-memory store's overwrite-on-equal semantics.)
    const tip = await this.getAnchor(logId);
    if (tip !== undefined && anchor.seq < tip.seq) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const line: AnchorLine = { logId, seq: anchor.seq, hash: anchor.hash, ts: this.now() };
    appendFileSync(this.fileFor(logId), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  }

  async getAnchor(logId: string): Promise<AnchorRecord | undefined> {
    const file = this.fileFor(logId);
    if (!existsSync(file)) return undefined;
    const lines = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    let best: AnchorRecord | undefined;
    let lineNumber = 0;
    for (const raw of lines) {
      lineNumber += 1;
      let parsed: Partial<AnchorLine>;
      try {
        parsed = JSON.parse(raw) as Partial<AnchorLine>;
      } catch (err) {
        throw new RuntimeError(
          `file-anchor-store: malformed JSON on line ${lineNumber} of ${file}`,
          err,
        );
      }
      if (
        typeof parsed.seq !== "number" ||
        typeof parsed.hash !== "string" ||
        parsed.logId !== logId
      ) {
        throw new RuntimeError(
          `file-anchor-store: invalid anchor on line ${lineNumber} of ${file} — expected { logId: "${logId}", seq, hash }`,
        );
      }
      // >= so an equal-seq line written later wins, matching InMemoryAnchorStore.
      if (best === undefined || parsed.seq >= best.seq) {
        best = { seq: parsed.seq, hash: parsed.hash };
      }
    }
    return best;
  }
}
