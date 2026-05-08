/**
 * Catalog R7 `checkpoint-store` — durable, branchable graph-run state.
 *
 * One subdirectory per graph run at `<rootDir>/<graphRunId>/`, with one
 * JSON file per checkpoint (`<checkpointId>.json`) plus a `_meta.json`
 * pointer that names the current head and the parent run+checkpoint
 * (when branched). The format mirrors `event-log`'s "schema version
 * stamped on every record" convention so future migrations can fan out
 * on `version`.
 *
 * Branching: `branch(parentRunId, checkpointId)` creates a NEW
 * `graphRunId` whose `_meta.json` points to `parentRunId` +
 * `checkpointId` and whose head is a fresh COPY of the requested
 * checkpoint. Reads on the new run still work even if the parent run is
 * later deleted — checkpoint files are duplicated, not aliased — so
 * long-lived branches are independent.
 *
 * Path-traversal defense: every public method validates ids against
 * stable regexes (`grun_<16hex>`, `ckpt_<16hex>`); anything else throws
 * `RuntimeError` before the filesystem is touched, mirroring
 * `session-store`'s pattern.
 *
 * Pluggable adapter: callers can substitute a different
 * `CheckpointStoreAdapter` (SQLite, Postgres, S3) and the
 * `createCheckpointStore({ adapter })` factory wires it through. The
 * default adapter is the file-backed implementation in this module.
 *
 * Layer R7. Pairs with `graph-engine` (R11) and `branch-history` (R7).
 */
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CrewhausError, RuntimeError } from "@crewhaus/errors";

export const DEFAULT_ROOT_DIR = ".crewhaus/graphs";

const GRAPH_RUN_ID_RE = /^grun_[0-9a-f]{16}$/;
const CHECKPOINT_ID_RE = /^ckpt_[0-9a-f]{16}$/;

export type GraphRunId = string;
export type CheckpointId = string;

export type Checkpoint = {
  readonly version: 1;
  readonly id: CheckpointId;
  readonly graphRunId: GraphRunId;
  readonly nodeName: string;
  readonly state: unknown;
  /** Parent within the same graph run — `undefined` for the entry node. */
  readonly parentCheckpointId?: CheckpointId;
  readonly createdAt: string;
};

export type BranchInfo = {
  readonly graphRunId: GraphRunId;
  readonly checkpointId: CheckpointId;
};

export type GraphRunMeta = {
  readonly version: 1;
  readonly graphRunId: GraphRunId;
  /** Most recently saved checkpoint id; absent on a freshly-branched run with no new commits. */
  head?: CheckpointId;
  readonly createdAt: string;
  /** Set when this run was branched from a sibling. */
  readonly branchedFrom?: BranchInfo;
};

export type ListOptions = {
  /** Cap the number of returned checkpoints (insertion order, oldest first). */
  readonly limit?: number;
  /** Skip checkpoints created before this ISO timestamp. */
  readonly since?: string;
};

export interface CheckpointStoreAdapter {
  save(c: Checkpoint): Promise<void>;
  load(graphRunId: GraphRunId, checkpointId: CheckpointId): Promise<Checkpoint | undefined>;
  list(graphRunId: GraphRunId, opts: ListOptions): Promise<ReadonlyArray<Checkpoint>>;
  loadMeta(graphRunId: GraphRunId): Promise<GraphRunMeta | undefined>;
  saveMeta(meta: GraphRunMeta): Promise<void>;
  /** Delete the entire graph run (best-effort; idempotent). */
  drop(graphRunId: GraphRunId): Promise<void>;
}

export interface CheckpointStore {
  /** Persist a new checkpoint and update the graph run's head. */
  save(opts: {
    graphRunId: GraphRunId;
    nodeName: string;
    state: unknown;
    parentCheckpointId?: CheckpointId;
  }): Promise<Checkpoint>;
  /** Load a specific checkpoint, or the head when `checkpointId` is omitted. */
  load(graphRunId: GraphRunId, checkpointId?: CheckpointId): Promise<Checkpoint | undefined>;
  /** Walk the run's checkpoints in insertion order. */
  list(graphRunId: GraphRunId, opts?: ListOptions): Promise<ReadonlyArray<Checkpoint>>;
  /**
   * Materialise a NEW graph run that starts from `checkpointId` of
   * `graphRunId`. The head of the new run is a fresh copy of the source
   * checkpoint and the `_meta.json` records `branchedFrom: { graphRunId,
   * checkpointId }` for time-travel auditing.
   */
  branch(
    graphRunId: GraphRunId,
    checkpointId: CheckpointId,
  ): Promise<{ newGraphRunId: GraphRunId; head: Checkpoint }>;
  /** Read the `_meta.json` for `graphRunId`. */
  meta(graphRunId: GraphRunId): Promise<GraphRunMeta | undefined>;
  /** Delete a graph run's directory tree. Idempotent. */
  drop(graphRunId: GraphRunId): Promise<void>;
}

export class CheckpointStoreError extends CrewhausError {
  override readonly name = "CheckpointStoreError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export function newGraphRunId(): GraphRunId {
  return `grun_${randomBytes(8).toString("hex")}`;
}

export function newCheckpointId(): CheckpointId {
  return `ckpt_${randomBytes(8).toString("hex")}`;
}

function validateGraphRunId(id: string): void {
  if (!GRAPH_RUN_ID_RE.test(id)) {
    throw new RuntimeError(`checkpoint-store: invalid graphRunId "${id}" — expected grun_<16 hex>`);
  }
}

function validateCheckpointId(id: string): void {
  if (!CHECKPOINT_ID_RE.test(id)) {
    throw new RuntimeError(
      `checkpoint-store: invalid checkpointId "${id}" — expected ckpt_<16 hex>`,
    );
  }
}

// ---------------------------------------------------------------------------
// File-backed adapter — default implementation.
// ---------------------------------------------------------------------------

class FileSystemAdapter implements CheckpointStoreAdapter {
  constructor(private readonly rootDir: string) {
    mkdirSync(this.rootDir, { recursive: true });
  }

  private dir(graphRunId: GraphRunId): string {
    validateGraphRunId(graphRunId);
    return join(this.rootDir, graphRunId);
  }

  private metaPath(graphRunId: GraphRunId): string {
    return join(this.dir(graphRunId), "_meta.json");
  }

  private checkpointPath(graphRunId: GraphRunId, checkpointId: CheckpointId): string {
    validateCheckpointId(checkpointId);
    return join(this.dir(graphRunId), `${checkpointId}.json`);
  }

  async save(c: Checkpoint): Promise<void> {
    const dir = this.dir(c.graphRunId);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.checkpointPath(c.graphRunId, c.id)}.tmp.${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 });
    // Atomic rename so concurrent reads never see a half-written file.
    const final = this.checkpointPath(c.graphRunId, c.id);
    renameSync(tmp, final);
  }

  async load(graphRunId: GraphRunId, checkpointId: CheckpointId): Promise<Checkpoint | undefined> {
    const path = this.checkpointPath(graphRunId, checkpointId);
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as Checkpoint;
  }

  async list(graphRunId: GraphRunId, opts: ListOptions): Promise<ReadonlyArray<Checkpoint>> {
    const dir = this.dir(graphRunId);
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter((f) => f.startsWith("ckpt_") && f.endsWith(".json"));
    // Order by mtime ascending — file-backed adapter has no other notion of insertion order.
    const withStat = files.map((f) => {
      const full = join(dir, f);
      return { name: f, mtimeMs: statSync(full).mtimeMs, full };
    });
    withStat.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const out: Checkpoint[] = [];
    const sinceTs = opts.since !== undefined ? Date.parse(opts.since) : Number.NEGATIVE_INFINITY;
    for (const { full } of withStat) {
      const c = JSON.parse(readFileSync(full, "utf8")) as Checkpoint;
      if (Date.parse(c.createdAt) < sinceTs) continue;
      out.push(c);
      if (opts.limit !== undefined && out.length >= opts.limit) break;
    }
    return out;
  }

  async loadMeta(graphRunId: GraphRunId): Promise<GraphRunMeta | undefined> {
    const path = this.metaPath(graphRunId);
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as GraphRunMeta;
  }

  async saveMeta(meta: GraphRunMeta): Promise<void> {
    const dir = this.dir(meta.graphRunId);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.metaPath(meta.graphRunId)}.tmp.${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600 });
    renameSync(tmp, this.metaPath(meta.graphRunId));
  }

  async drop(graphRunId: GraphRunId): Promise<void> {
    const dir = this.dir(graphRunId);
    if (!existsSync(dir)) return;
    rmSync(dir, { recursive: true, force: true });
  }
}

export type CreateCheckpointStoreOptions = {
  readonly rootDir?: string;
  readonly adapter?: CheckpointStoreAdapter;
  readonly now?: () => Date;
};

export function createCheckpointStore(opts: CreateCheckpointStoreOptions = {}): CheckpointStore {
  const rootDir = opts.rootDir ?? DEFAULT_ROOT_DIR;
  const adapter = opts.adapter ?? new FileSystemAdapter(rootDir);
  const now = opts.now ?? ((): Date => new Date());

  async function ensureMeta(graphRunId: GraphRunId): Promise<GraphRunMeta> {
    const existing = await adapter.loadMeta(graphRunId);
    if (existing !== undefined) return existing;
    const meta: GraphRunMeta = {
      version: 1,
      graphRunId,
      createdAt: now().toISOString(),
    };
    await adapter.saveMeta(meta);
    return meta;
  }

  return {
    async save(req): Promise<Checkpoint> {
      validateGraphRunId(req.graphRunId);
      if (req.parentCheckpointId !== undefined) validateCheckpointId(req.parentCheckpointId);
      if (typeof req.nodeName !== "string" || req.nodeName.length === 0) {
        throw new CheckpointStoreError("nodeName must be a non-empty string");
      }
      const id = newCheckpointId();
      const cp: Checkpoint = {
        version: 1,
        id,
        graphRunId: req.graphRunId,
        nodeName: req.nodeName,
        state: req.state,
        ...(req.parentCheckpointId !== undefined
          ? { parentCheckpointId: req.parentCheckpointId }
          : {}),
        createdAt: now().toISOString(),
      };
      await adapter.save(cp);
      const prevMeta = await ensureMeta(req.graphRunId);
      const meta: GraphRunMeta = { ...prevMeta, head: id };
      await adapter.saveMeta(meta);
      return cp;
    },
    async load(graphRunId, checkpointId): Promise<Checkpoint | undefined> {
      validateGraphRunId(graphRunId);
      let id = checkpointId;
      if (id === undefined) {
        const meta = await adapter.loadMeta(graphRunId);
        if (meta?.head === undefined) return undefined;
        id = meta.head;
      }
      validateCheckpointId(id);
      return adapter.load(graphRunId, id);
    },
    async list(graphRunId, listOpts = {}): Promise<ReadonlyArray<Checkpoint>> {
      validateGraphRunId(graphRunId);
      return adapter.list(graphRunId, listOpts);
    },
    async branch(
      graphRunId,
      checkpointId,
    ): Promise<{
      newGraphRunId: GraphRunId;
      head: Checkpoint;
    }> {
      validateGraphRunId(graphRunId);
      validateCheckpointId(checkpointId);
      const source = await adapter.load(graphRunId, checkpointId);
      if (source === undefined) {
        throw new CheckpointStoreError(
          `checkpoint ${checkpointId} not found in graph run ${graphRunId}`,
        );
      }
      const branchedRunId = newGraphRunId();
      const newHead: Checkpoint = {
        version: 1,
        id: newCheckpointId(),
        graphRunId: branchedRunId,
        nodeName: source.nodeName,
        state: source.state,
        createdAt: now().toISOString(),
      };
      await adapter.save(newHead);
      const meta: GraphRunMeta = {
        version: 1,
        graphRunId: branchedRunId,
        head: newHead.id,
        createdAt: newHead.createdAt,
        branchedFrom: { graphRunId, checkpointId },
      };
      await adapter.saveMeta(meta);
      return { newGraphRunId: branchedRunId, head: newHead };
    },
    async meta(graphRunId): Promise<GraphRunMeta | undefined> {
      validateGraphRunId(graphRunId);
      return adapter.loadMeta(graphRunId);
    },
    async drop(graphRunId): Promise<void> {
      validateGraphRunId(graphRunId);
      await adapter.drop(graphRunId);
    },
  };
}
