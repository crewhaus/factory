/**
 * 0.8.0 (design/0.8.0-provability-release.md §5.3, §12 item 5) — `GET
 * /api/runs/:id/proof`: the proof bundles a run's provability gate persisted.
 *
 * The gate files one bundle per graded turn at
 * `<harness>/.crewhaus/proofs/<spec>/<sessionId>/turn-<n>.json` (a retry
 * replaces the earlier pass of the same turn), and a gateway `runs.create`
 * answers with the `sessionId` those files are keyed by — so the route's `:id`
 * is that session id. The route is fleet-wide because a session id names its
 * harness only implicitly: every live registered harness is searched, each
 * contained against its OWN directory, and `?harness=<id>` narrows the search
 * to one registry row.
 *
 * The MANAGED shape files elsewhere: every managed turn runs under its
 * request's tenant, and the gate files that turn's bundle under
 * `<tenantsRoot>/<tenant>/proofs/<spec>/<sessionId>/` (tool-proof's
 * `defaultProofsRoot`) — and a managed harness is exactly the one whose
 * gateway answers with these session ids. Its tenants root is
 * `CREWHAUS_TENANTS_ROOT` from the harness's `.env` chain, else
 * target-managed's `/tmp/crewhaus-tenants`. Hangar reads nothing outside a
 * registered harness (the `CREWHAUS_SESSION_DIR` rule in `sessions.ts`), so a
 * tenants root INSIDE the harness directory is searched like
 * `.crewhaus/proofs`, and one outside it is named in the answer
 * (`tenantRootsNotRead`, and the 404's message) instead of answering a
 * silent "none".
 *
 * Read the way every Hangar read is (the inspect / evals precedent):
 *
 *   - SHAPE FIRST. `:id` must be `sess_<16 hex>`, a spec directory a name
 *     provability's store files under ({@link isProofSpecDir}) and a tenant
 *     a {@link SAFE_SEGMENT_RE} name before any path is built from it; a
 *     traversal (`..`, an encoded separator) is a 400, not a read.
 *   - CONTAINMENT PER FILE. `.crewhaus/proofs` and each spec directory are
 *     listed for NAMES, and every bundle file is re-resolved through
 *     `resolveInside` — a name in the listing can be a symlink out of the
 *     harness, and a link that leaves it is never read.
 *   - CAPPED, TORN-TOLERANT, NEVER MUTATING. A bundle over
 *     {@link MAX_PROOF_BYTES}, one that does not parse, or one that is not
 *     the bundle shape is reported under `skipped` with why; nothing here
 *     writes, prunes or rewrites a bundle (`crewhaus provability prune` is
 *     the one verb that deletes, and it is the CLI's).
 *   - MASKED ON THE WAY OUT, by the caller: claim text is the model's prose
 *     and an excerpt is a fetched body's words, so the server runs the
 *     harness's own scrubber and the key/shape masker over the payload.
 *
 * Each row carries its CLI twin — `crewhaus provability show --session <id>
 * --turn <n> --json`, run from the harness directory — whose stdout is that
 * row's `bundle` as persisted (the terminal is the operator's own, so the
 * CLI does not mask what the console does). `proof-route.test.ts` holds the
 * twin to the CLI's declared flags and dispatch.
 */
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { shellQuote } from "@crewhaus/harness-supervisor";
import { SAFE_SEGMENT_RE } from "./constants";
import { readHarnessEnvFiles } from "./env-file";
import { readTextCapped } from "./jsonl";
import { isSafePathSegment, resolveContained, resolveInside } from "./safety";

/** The session-id shape the proofs tree is keyed by (provability's store rule). */
const SESSION_ID_RE = /^sess_[0-9a-f]{16}$/;
/** A bundle file: `turn-<n>.json` (provability's store rule). */
const TURN_FILE_RE = /^turn-(\d{1,9})\.json$/;
/** Largest bundle read back. A bundle clips claim text at 400 characters and
 *  excerpts at 240, so even a long answer is far below this. */
export const MAX_PROOF_BYTES = 4 * 1024 * 1024;
/** Most bundles one response carries (a session's turns, across harnesses). */
export const MAX_PROOF_BUNDLES = 500;
/** Spec directories looked at per proofs directory. */
const MAX_SPEC_DIRS = 200;
/** Tenant directories looked at per managed harness. */
const MAX_TENANT_DIRS = 1_000;

/** True when `id` is the session id a run's bundles are filed under. */
export function isProofRunId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

/**
 * A spec directory provability's bundle store files under: `[A-Za-z0-9_.-]+`,
 * not dots only (its `proofsRoot` rule — a test in apps/cli holds the two
 * equal). Hangar's {@link SAFE_SEGMENT_RE} is stricter (no leading `-` or
 * `.`, 128 characters), and filtering by it hid bundles the gate legitimately
 * files for a spec named `-agent` or `.agent`. Containment is not this
 * check's job: every path is still resolved through `resolveInside`.
 */
export function isProofSpecDir(name: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(name) && !/^\.+$/.test(name) && isSafePathSegment(name);
}

/** The variable a managed daemon reads its tenants root from. */
export const TENANTS_ROOT_ENV = "CREWHAUS_TENANTS_ROOT";
/** target-managed's emitted `TENANTS_ROOT` default (the CLI's twin constant is held equal to it). */
export const MANAGED_TENANTS_ROOT_DEFAULT = "/tmp/crewhaus-tenants";

/** Where a managed harness's tenants root is, as the proof search sees it. */
export type ProofTenants =
  /** Inside the harness directory: searched. `segments` lead there from the harness dir. */
  | { readonly readable: true; readonly root: string; readonly segments: readonly string[] }
  /** Outside it (the `/tmp` default included): named, never read. */
  | { readonly readable: false; readonly root: string };

function realOf(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * A managed harness's tenants root: `CREWHAUS_TENANTS_ROOT` from its `.env`
 * chain (resolved against the harness directory, which the daemon runs
 * from), else {@link MANAGED_TENANTS_ROOT_DEFAULT}. Undefined for every other
 * target — only managed runs turns under a tenant.
 */
export function proofTenants(harnessDir: string, target: string): ProofTenants | undefined {
  if (target !== "managed") return undefined;
  const raw = readHarnessEnvFiles(harnessDir).vars[TENANTS_ROOT_ENV]?.trim();
  const root = resolve(
    harnessDir,
    raw !== undefined && raw !== "" ? raw : MANAGED_TENANTS_ROOT_DEFAULT,
  );
  const contained = resolveContained(harnessDir, root);
  if (contained === undefined) return { readable: false, root };
  // Real paths when both exist (a link inside the harness may lead there);
  // a root not created yet is inside by the containment check alone.
  const realDir = realOf(harnessDir);
  const realRoot = realOf(contained);
  const rel =
    realDir !== undefined && realRoot !== undefined
      ? relative(realDir, realRoot)
      : relative(resolve(harnessDir), contained);
  const segments = rel === "" ? [] : rel.split(sep);
  if (segments.some((seg) => seg === ".." || !isSafePathSegment(seg))) {
    return { readable: false, root };
  }
  return { readable: true, root, segments };
}

/** One live registered harness, as the fleet search reads it. */
export type ProofHarness = {
  readonly id: string;
  readonly dir: string;
  readonly specName: string;
  /** Present for a managed harness: where its tenants' bundles are ({@link proofTenants}). */
  readonly tenants?: ProofTenants;
};

export type ProofBundleRow = {
  readonly harnessId: string;
  /** The harness's spec name (registry row). */
  readonly specName: string;
  /** The proofs directory the bundle was filed under (`.crewhaus/proofs/<spec>`). */
  readonly spec: string;
  /** The managed tenant whose root holds the bundle; absent for `.crewhaus/proofs`. */
  readonly tenant?: string;
  readonly sessionId: string;
  readonly turn: number;
  /** Harness-relative: `.crewhaus/proofs/<spec>/<sessionId>/turn-<n>.json`
   *  (`<tenants>/<tenant>/proofs/<spec>/…` for a managed tenant's). */
  readonly path: string;
  readonly modifiedAt: string;
  /** The terminal command whose stdout is `bundle`. */
  readonly cliTwin: string;
  /** The persisted `ProofBundle`, as written. */
  readonly bundle: Record<string, unknown>;
};

export type ProofSkip = {
  readonly harnessId: string;
  readonly path: string;
  readonly reason: string;
};

export type ProofView = {
  readonly runId: string;
  /** Oldest turn first, then by harness and spec directory. */
  readonly bundles: readonly ProofBundleRow[];
  /** Files under the run's directory that are not readable bundles, and why. */
  readonly skipped: readonly ProofSkip[];
  /** True when {@link MAX_PROOF_BUNDLES} cut the list. */
  readonly truncated: boolean;
  /**
   * Managed harnesses whose tenants root lies outside the harness directory,
   * so their bundles were not searched. Present only when there is one — a
   * fleet with no managed harness gets the payload it always got.
   */
  readonly tenantRootsNotRead?: ReadonlyArray<{
    readonly harnessId: string;
    readonly root: string;
  }>;
};

/**
 * The persisted bundle's shape, as provability's store checks it on read: a
 * file that is not one is skipped, never served as if it were.
 */
function isBundle(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v["version"] === 1 &&
    typeof v["level"] === "string" &&
    typeof v["verdict"] === "string" &&
    Array.isArray(v["claims"]) &&
    typeof v["bundleHash"] === "string"
  );
}

/** Names in a directory, or none when it is unreadable. */
function namesIn(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The CLI twin for one bundle: run from the harness directory, it prints
 * `bundle`. A managed tenant's bundle names the tenants root it was read
 * under (harness-relative), so the twin finds it whatever the shell's env.
 */
export function proofCliTwin(
  harnessDir: string,
  sessionId: string,
  turn: number,
  tenantsRoot?: string,
): string {
  const tenants = tenantsRoot !== undefined ? ` --tenants-root ${shellQuote(tenantsRoot)}` : "";
  return `cd ${shellQuote(harnessDir)} && crewhaus provability show --session ${sessionId} --turn ${turn}${tenants} --json`;
}

/**
 * Every bundle `runId` persisted, across `harnesses`. `runId` must already
 * satisfy {@link isProofRunId} — the route checks it and answers 400 first.
 */
export function proofView(harnesses: readonly ProofHarness[], runId: string): ProofView {
  if (!isProofRunId(runId)) throw new Error(`invalid run id "${runId}"`);
  const bundles: ProofBundleRow[] = [];
  const skipped: ProofSkip[] = [];
  const notRead: Array<{ harnessId: string; root: string }> = [];
  let truncated = false;

  /** One proofs directory (`base` = harness-relative segments of it), one tenant or none. */
  const scan = (harness: ProofHarness, base: readonly string[], tenant?: string): void => {
    const proofsDir = resolveInside(harness.dir, base);
    if (proofsDir === undefined || !isDir(proofsDir)) return;
    const specs = namesIn(proofsDir).filter(isProofSpecDir);
    for (const spec of specs.slice(0, MAX_SPEC_DIRS)) {
      const runDir = resolveInside(harness.dir, [...base, spec, runId]);
      if (runDir === undefined || !isDir(runDir)) continue;
      for (const file of namesIn(runDir)) {
        const turn = TURN_FILE_RE.exec(file);
        if (turn === null) continue;
        const rel = [...base, spec, runId, file].join("/");
        const skip = (reason: string): void => {
          skipped.push({ harnessId: harness.id, path: rel, reason });
        };
        // Per FILE: the listing gave a name, and a name can be a link out.
        const path = resolveInside(harness.dir, [...base, spec, runId, file]);
        if (path === undefined) {
          skip("resolves outside the harness directory");
          continue;
        }
        let modifiedMs: number;
        try {
          const stat = lstatSync(path);
          if (!stat.isFile()) {
            skip("not a regular file");
            continue;
          }
          modifiedMs = stat.mtimeMs;
        } catch {
          continue; // raced away
        }
        const read = readTextCapped(path, MAX_PROOF_BYTES);
        if (read.truncated) {
          skip(`larger than ${MAX_PROOF_BYTES} bytes`);
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(read.text);
        } catch {
          skip("not valid JSON");
          continue;
        }
        if (!isBundle(parsed)) {
          skip("not a proof bundle");
          continue;
        }
        if (bundles.length >= MAX_PROOF_BUNDLES) {
          truncated = true;
          continue;
        }
        const turnNumber = Number(turn[1]);
        const tenantsRoot = tenant !== undefined ? base.slice(0, -2).join("/") || "." : undefined;
        bundles.push({
          harnessId: harness.id,
          specName: harness.specName,
          spec,
          ...(tenant !== undefined ? { tenant } : {}),
          sessionId: runId,
          turn: turnNumber,
          path: rel,
          modifiedAt: new Date(modifiedMs).toISOString(),
          cliTwin: proofCliTwin(harness.dir, runId, turnNumber, tenantsRoot),
          bundle: parsed,
        });
      }
    }
  };

  for (const harness of harnesses) {
    scan(harness, [".crewhaus", "proofs"]);
    const tenants = harness.tenants;
    if (tenants === undefined) continue;
    if (!tenants.readable) {
      notRead.push({ harnessId: harness.id, root: tenants.root });
      continue;
    }
    const rootDir = resolveInside(harness.dir, tenants.segments);
    if (rootDir === undefined || !isDir(rootDir)) continue;
    // A tenant is one segment of Hangar's conservative shape (tenancy's id
    // rule is narrower still), then resolved and contained like any read.
    const tenantNames = namesIn(rootDir).filter((name) => SAFE_SEGMENT_RE.test(name));
    for (const tenant of tenantNames.slice(0, MAX_TENANT_DIRS)) {
      scan(harness, [...tenants.segments, tenant, "proofs"], tenant);
    }
  }
  bundles.sort(
    (a, b) =>
      a.turn - b.turn ||
      a.harnessId.localeCompare(b.harnessId) ||
      a.spec.localeCompare(b.spec) ||
      (a.tenant ?? "").localeCompare(b.tenant ?? ""),
  );
  return {
    runId,
    bundles,
    skipped,
    truncated,
    ...(notRead.length > 0 ? { tenantRootsNotRead: notRead } : {}),
  };
}
