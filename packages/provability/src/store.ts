/**
 * Where bundles and proof artifacts live (design §5.3, §6.4):
 *
 *   <cwd>/.crewhaus/proofs/<spec>/<sessionId>/turn-<n>.json   one bundle per graded turn
 *   <cwd>/.crewhaus/proofs/<spec>/artifacts/<prf_id>.json      one artifact per ProofCheck
 *
 * Mode 0600, written to a randomly named temp and renamed into place
 * through `@crewhaus/tool-safety/fs` — never through a link planted at the
 * name (the C070 discipline the continuity store follows). Every name that
 * reaches a path is validated first: a spec name, a session id, a turn
 * number and a proof id each have one shape, and a tampered one is refused
 * before any path is built from it (the citation-tracker sha256 precedent).
 * Bundles carry no TTL — they are the audit artifact; `prune` manages size.
 */
import { lstatSync, mkdirSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { openForRead, writeFileSafe } from "@crewhaus/tool-safety/fs";
import { isProofArtifact, isProofId } from "./artifact";
import { ProvabilityError } from "./evidence";
import type { ProofArtifact, ProofArtifactStore, ProofBundle } from "./types";

/** continuity-store's spec-name rule: letters, digits, `_ - .`, and not dots alone. */
const SPEC_NAME_REGEX = /^[a-zA-Z0-9_\-.]+$/;
const SESSION_ID_REGEX = /^sess_[0-9a-f]{16}$/;
/** The directory bundles of a run with no session go under. */
export const NO_SESSION = "no-session";
const TURN_FILE = /^turn-(\d{1,9})\.json$/;
/** Largest bundle or artifact read back. */
const MAX_READ_BYTES = 16 * 1024 * 1024;

function assertSpecName(specName: string): void {
  if (!SPEC_NAME_REGEX.test(specName) || /^\.+$/.test(specName)) {
    throw new ProvabilityError(
      "config",
      `provability: invalid spec name "${specName}" — must match [a-zA-Z0-9_\\-.]+ and not be dots only`,
    );
  }
}

/** `<cwd>/.crewhaus/proofs/<specName>`: one spec's bundles and artifacts. */
export function proofsRoot(cwd: string, specName: string): string {
  assertSpecName(specName);
  return join(resolve(cwd), ".crewhaus", "proofs", specName);
}

function sessionDir(sessionId: string | undefined): string {
  const dir = sessionId ?? NO_SESSION;
  if (dir !== NO_SESSION && !SESSION_ID_REGEX.test(dir)) {
    throw new ProvabilityError(
      "config",
      `provability: invalid sessionId "${dir}" — expected sess_<16 hex> or "${NO_SESSION}"`,
    );
  }
  return dir;
}

function assertTurn(turnNumber: number): void {
  if (!Number.isInteger(turnNumber) || turnNumber < 0 || turnNumber > 999_999_999) {
    throw new ProvabilityError(
      "config",
      `provability: invalid turn number ${String(turnNumber)} — expected a non-negative integer`,
    );
  }
}

/** Write `data` to `rel` under `root` atomically, mode 0600, never through a link. */
function writeAtomic(root: string, rel: string, data: string, overwrite: boolean): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const written = writeFileSafe(root, rel, data, {
    overwrite,
    createParents: true,
    mode: 0o600,
  });
  if (!written.ok) {
    throw new ProvabilityError(
      "runtime",
      `provability: refusing to write ${rel}: ${written.reason} (code ${written.code})`,
    );
  }
}

/** The JSON at `rel` under `root`, or `undefined` when nothing is there. */
async function readJson(root: string, rel: string): Promise<unknown> {
  const read = await openForRead(root, rel, { maxBytes: MAX_READ_BYTES, followLeafSymlink: false });
  if (!read.ok) {
    if (read.code === "not-found") return undefined;
    throw new ProvabilityError(
      "runtime",
      `provability: refusing to read ${rel}: ${read.reason} (code ${read.code})`,
    );
  }
  if (read.truncated) {
    throw new ProvabilityError(
      "runtime",
      `provability: ${rel} is larger than ${MAX_READ_BYTES} bytes`,
    );
  }
  try {
    return JSON.parse(read.text) as unknown;
  } catch (err) {
    throw new ProvabilityError("runtime", `provability: ${rel} is not valid JSON`, err);
  }
}

/** Entries of a directory that are real directories / regular files (no links followed). */
function entries(dir: string, kind: "dir" | "file"): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => {
    try {
      const stat = lstatSync(join(dir, name));
      return kind === "dir" ? stat.isDirectory() : stat.isFile();
    } catch {
      return false;
    }
  });
}

export type BundleListing = {
  readonly sessionId: string;
  readonly turnNumber: number;
  readonly path: string;
  readonly mtimeMs: number;
};

export interface BundleStore {
  /** The proofs root this store writes under. */
  readonly rootDir: string;
  /** Persist a bundle as `<root>/<sessionId|no-session>/turn-<n>.json`; returns the path. A
   *  later pass of the same turn (a retry) replaces the earlier one. */
  put(
    bundle: ProofBundle,
    at: { readonly sessionId?: string; readonly turnNumber: number },
  ): Promise<string>;
  /** The bundle persisted for a turn, or `undefined`. */
  get(sessionId: string | undefined, turnNumber: number): Promise<ProofBundle | undefined>;
  /** Every persisted bundle, newest first. */
  list(): Promise<ReadonlyArray<BundleListing>>;
  /** Delete bundles last written before `now - olderThanMs`; returns how many. */
  prune(olderThanMs: number, now?: Date): Promise<number>;
}

function isBundle(value: unknown): value is ProofBundle {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["version"] === 1 &&
    typeof v["level"] === "string" &&
    typeof v["verdict"] === "string" &&
    Array.isArray(v["claims"]) &&
    typeof v["bundleHash"] === "string"
  );
}

/**
 * The bundle store over a proofs root (`proofsRoot(cwd, specName)`).
 * Tenant fencing is the caller's: on managed, pass the tenant's root.
 */
export function createBundleStore(opts: { readonly rootDir: string }): BundleStore {
  const rootDir = resolve(opts.rootDir);
  const relOf = (sessionId: string | undefined, turnNumber: number): string => {
    assertTurn(turnNumber);
    return `${sessionDir(sessionId)}/turn-${turnNumber}.json`;
  };
  const list = async (): Promise<BundleListing[]> => {
    const out: BundleListing[] = [];
    for (const session of entries(rootDir, "dir")) {
      if (session !== NO_SESSION && !SESSION_ID_REGEX.test(session)) continue;
      const dir = join(rootDir, session);
      for (const file of entries(dir, "file")) {
        const turn = TURN_FILE.exec(file);
        if (turn === null) continue;
        const path = join(dir, file);
        let mtimeMs: number;
        try {
          mtimeMs = lstatSync(path).mtimeMs;
        } catch {
          continue;
        }
        out.push({ sessionId: session, turnNumber: Number(turn[1]), path, mtimeMs });
      }
    }
    return out.sort(
      (a, b) =>
        b.mtimeMs - a.mtimeMs ||
        b.turnNumber - a.turnNumber ||
        a.sessionId.localeCompare(b.sessionId),
    );
  };
  return {
    rootDir,
    async put(bundle, at) {
      const rel = relOf(at.sessionId, at.turnNumber);
      writeAtomic(rootDir, rel, `${JSON.stringify(bundle, null, 2)}\n`, true);
      return join(rootDir, rel);
    },
    async get(sessionId, turnNumber) {
      const value = await readJson(rootDir, relOf(sessionId, turnNumber));
      if (value === undefined) return undefined;
      if (!isBundle(value)) {
        throw new ProvabilityError(
          "runtime",
          `provability: ${relOf(sessionId, turnNumber)} is not a proof bundle`,
        );
      }
      return value;
    },
    list,
    async prune(olderThanMs, now = new Date()) {
      if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
        throw new ProvabilityError(
          "config",
          `provability: prune needs a non-negative age, got ${String(olderThanMs)}`,
        );
      }
      const cutoff = now.getTime() - olderThanMs;
      let removed = 0;
      const touched = new Set<string>();
      for (const listing of await list()) {
        if (listing.mtimeMs >= cutoff) continue;
        try {
          unlinkSync(listing.path);
          removed += 1;
          touched.add(join(rootDir, listing.sessionId));
        } catch {
          // Gone already, or not ours to remove: leave it.
        }
      }
      for (const dir of touched) {
        try {
          rmdirSync(dir); // only succeeds when empty
        } catch {
          // Still holds bundles (or something else): keep it.
        }
      }
      return removed;
    },
  };
}

const ARTIFACTS_DIR = "artifacts";

/**
 * Proof artifacts under `<rootDir>/artifacts/<id>.json`, where `rootDir` is
 * the proofs root (`proofsRoot(cwd, specName)`). An id is checked against
 * `prf_<16 hex>` BEFORE it is put into a path: `get` answers `undefined` for
 * any other string (a `proof:../../x` citation reads nothing), and `put`
 * refuses one. Artifacts are immutable: `put` never replaces an existing id
 * — a later check is a new artifact, so the one a bundle cited stays the
 * one it was graded against.
 */
export function createFileArtifactStore(opts: { readonly rootDir: string }): ProofArtifactStore & {
  readonly rootDir: string;
} {
  const rootDir = resolve(opts.rootDir);
  const get = async (id: string): Promise<ProofArtifact | undefined> => {
    if (!isProofId(id)) return undefined;
    const value = await readJson(rootDir, `${ARTIFACTS_DIR}/${id}.json`);
    if (value === undefined) return undefined;
    if (!isProofArtifact(value)) {
      throw new ProvabilityError("runtime", `provability: artifact ${id} is malformed`);
    }
    return value;
  };
  return {
    rootDir,
    get,
    async put(artifact) {
      if (!isProofId(artifact.id)) {
        throw new ProvabilityError(
          "config",
          `provability: invalid proof id "${String(artifact.id).slice(0, 40)}" — expected prf_<16 hex>`,
        );
      }
      if (!isProofArtifact(artifact as unknown)) {
        throw new ProvabilityError("config", `provability: artifact ${artifact.id} is malformed`);
      }
      writeAtomic(
        rootDir,
        `${ARTIFACTS_DIR}/${artifact.id}.json`,
        `${JSON.stringify(artifact, null, 2)}\n`,
        false,
      );
    },
    async list() {
      const out: ProofArtifact[] = [];
      for (const file of entries(join(rootDir, ARTIFACTS_DIR), "file")) {
        const id = file.endsWith(".json") ? file.slice(0, -5) : "";
        if (!isProofId(id)) continue;
        try {
          const artifact = await get(id);
          if (artifact !== undefined) out.push(artifact);
        } catch {
          // A malformed artifact is not listed; `get` reports it by id.
        }
      }
      return out.sort((a, b) => b.checkedAt.localeCompare(a.checkedAt) || a.id.localeCompare(b.id));
    },
  };
}
