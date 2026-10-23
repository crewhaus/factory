/**
 * Where bundles and proof artifacts live (design §5.3, §6.4):
 *
 *   <cwd>/.crewhaus/proofs/<spec>/<sessionId>/turn-<n>.json   one bundle per graded pass
 *   <cwd>/.crewhaus/proofs/<spec>/<sessionId>/turn-<n>.<k>.json  …the k-th pass of a turn
 *   <cwd>/.crewhaus/proofs/<spec>/artifacts/<prf_id>.json      one artifact per ProofCheck
 *
 * Files mode 0600 and directories 0700, written to a randomly named temp and renamed into place
 * through `@crewhaus/tool-safety/fs` — never through a link planted at the
 * name (the C070 discipline the continuity store follows). Every name that
 * reaches a path is validated first: a spec name, a session id, a turn
 * number and a proof id each have one shape, and a tampered one is refused
 * before any path is built from it (the citation-tracker sha256 precedent).
 * Bundles carry no TTL — they are the audit artifact; `prune` manages size.
 */
import { lstatSync, mkdirSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureDirContained, openForRead, writeFileSafe } from "@crewhaus/tool-safety/fs";
import { isProofArtifact, isProofId } from "./artifact";
import { ProvabilityError } from "./evidence";
import type { ProofArtifact, ProofArtifactStore, ProofBundle } from "./types";

/** continuity-store's spec-name rule: letters, digits, `_ - .`, and not dots alone. */
const SPEC_NAME_REGEX = /^[a-zA-Z0-9_\-.]+$/;
const SESSION_ID_REGEX = /^sess_[0-9a-f]{16}$/;
/** The directory bundles of a run with no session go under. */
export const NO_SESSION = "no-session";
/** `turn-<n>.json`, the first pass of a turn; `turn-<n>.<k>.json`, its k-th. */
const TURN_FILE = /^turn-(\d{1,9})(?:\.(\d{1,4}))?\.json$/;
/** The most passes one turn's bundles are kept under (retries, and turns a resumed session numbers again). */
const MAX_PASSES = 1_000;
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
  /** Which pass of the turn: 1 for `turn-<n>.json`, k for `turn-<n>.<k>.json`. (0.8.0 additive, fix pass.) */
  readonly pass: number;
  readonly path: string;
  readonly mtimeMs: number;
};

export interface BundleStore {
  /** The proofs root this store writes under. */
  readonly rootDir: string;
  /**
   * Persist a bundle as `<root>/<sessionId|no-session>/turn-<n>.json` — or,
   * when a pass of that turn is already stored (a retry, a turn a resumed
   * session numbers again), the next free `turn-<n>.<k>.json` — and return
   * the path written. A stored bundle is never replaced: the `bundleHash`
   * each pass's audit record and trace line carry names a bundle that is
   * still there (design §5.3), and `provability audit` can read the
   * failing pass a retry fixed.
   */
  put(
    bundle: ProofBundle,
    at: { readonly sessionId?: string; readonly turnNumber: number },
  ): Promise<string>;
  /** One pass of a turn — by default its last, the turn's standing bundle — or `undefined`. */
  get(
    sessionId: string | undefined,
    turnNumber: number,
    pass?: number,
  ): Promise<ProofBundle | undefined>;
  /** Each turn's last pass, newest first; `allPasses` lists every pass. */
  list(opts?: { readonly allPasses?: boolean }): Promise<ReadonlyArray<BundleListing>>;
  /** Delete bundles (every pass) last written before `now - olderThanMs`; returns how many. */
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

/** A turn's pass `k` as its file name under the session directory. */
function passFile(turnNumber: number, pass: number): string {
  return pass === 1 ? `turn-${turnNumber}.json` : `turn-${turnNumber}.${pass}.json`;
}

/** The pass numbers stored for one turn in `dir`, read off the names (links included: a read refuses those). */
function passesOf(dir: string, turnNumber: number): number[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: number[] = [];
  for (const name of names) {
    const m = TURN_FILE.exec(name);
    if (m === null || Number(m[1]) !== turnNumber) continue;
    out.push(m[2] === undefined ? 1 : Number(m[2]));
  }
  return out;
}

/**
 * The bundle store over a proofs root (`proofsRoot(cwd, specName)`).
 * Tenant fencing is the caller's: on managed, pass the tenant's root.
 */
export function createBundleStore(opts: { readonly rootDir: string }): BundleStore {
  const rootDir = resolve(opts.rootDir);
  const relOf = (sessionId: string | undefined, turnNumber: number, pass = 1): string => {
    assertTurn(turnNumber);
    if (!Number.isInteger(pass) || pass < 1 || pass > MAX_PASSES) {
      throw new ProvabilityError(
        "config",
        `provability: invalid pass ${String(pass)} — expected 1 to ${MAX_PASSES}`,
      );
    }
    return `${sessionDir(sessionId)}/${passFile(turnNumber, pass)}`;
  };
  const list = async (
    listOpts: { readonly allPasses?: boolean } = {},
  ): Promise<BundleListing[]> => {
    const out: BundleListing[] = [];
    for (const session of entries(rootDir, "dir")) {
      if (session !== NO_SESSION && !SESSION_ID_REGEX.test(session)) continue;
      const dir = join(rootDir, session);
      const last = new Map<number, BundleListing>();
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
        const listing: BundleListing = {
          sessionId: session,
          turnNumber: Number(turn[1]),
          pass: turn[2] === undefined ? 1 : Number(turn[2]),
          path,
          mtimeMs,
        };
        if (listOpts.allPasses === true) {
          out.push(listing);
          continue;
        }
        const prior = last.get(listing.turnNumber);
        if (prior === undefined || listing.pass > prior.pass) last.set(listing.turnNumber, listing);
      }
      out.push(...last.values());
    }
    return out.sort(
      (a, b) =>
        b.mtimeMs - a.mtimeMs ||
        b.turnNumber - a.turnNumber ||
        b.pass - a.pass ||
        a.sessionId.localeCompare(b.sessionId),
    );
  };
  return {
    rootDir,
    async put(bundle, at) {
      relOf(at.sessionId, at.turnNumber);
      const session = sessionDir(at.sessionId);
      mkdirSync(rootDir, { recursive: true, mode: 0o700 });
      // The session directory is as private as the root and the files.
      const dir = ensureDirContained(rootDir, session, { mode: 0o700 });
      if (!dir.ok) {
        throw new ProvabilityError(
          "runtime",
          `provability: refusing to write under ${session}: ${dir.reason} (code ${dir.code})`,
        );
      }
      const data = `${JSON.stringify(bundle, null, 2)}\n`;
      for (let pass = 1; pass <= MAX_PASSES; pass++) {
        const rel = relOf(at.sessionId, at.turnNumber, pass);
        const written = writeFileSafe(rootDir, rel, data, {
          overwrite: false,
          createParents: true,
          mode: 0o600,
        });
        if (written.ok) return join(rootDir, rel);
        // Taken by an earlier pass: the next name. Anything else — a link
        // planted at the name, a directory there — is refused, not stepped over.
        if (written.code !== "exists") {
          throw new ProvabilityError(
            "runtime",
            `provability: refusing to write ${rel}: ${written.reason} (code ${written.code})`,
          );
        }
      }
      throw new ProvabilityError(
        "runtime",
        `provability: ${session} already holds ${MAX_PASSES} passes of turn ${at.turnNumber}`,
      );
    },
    async get(sessionId, turnNumber, pass) {
      let which = pass;
      if (which === undefined) {
        relOf(sessionId, turnNumber);
        const stored = passesOf(join(rootDir, sessionDir(sessionId)), turnNumber);
        which = stored.length > 0 ? Math.max(...stored) : 1;
      }
      const rel = relOf(sessionId, turnNumber, which);
      const value = await readJson(rootDir, rel);
      if (value === undefined) return undefined;
      if (!isBundle(value)) {
        throw new ProvabilityError("runtime", `provability: ${rel} is not a proof bundle`);
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
      for (const listing of await list({ allPasses: true })) {
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
