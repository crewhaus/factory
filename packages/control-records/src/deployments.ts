/**
 * Deployment records and the harness's portable identity, as files. A deployment record
 * says which build a harness runs: `prepared` when a compile writes it, `active` once a
 * person activates it, then `superseded`, `disabled` or `retired`, on control-contract's
 * `deployment` machine. Every row restates the whole record, because the fold keeps the
 * latest row whole and merges nothing.
 *
 * `harness.json` is the harness's own id, kept in the harness so it travels with it. It is
 * written only by the verbs that create or claim a harness (`init`, activation, `harness
 * adopt|fork`), never by a read.
 */
import { HARNESS_ID_RE } from "@crewhaus/control-contract";
import { ensureDirContained, writeFileSafe } from "@crewhaus/tool-safety/fs";
import { decodeStrict, parseObject, readRecordFile } from "./io";
import { type LedgerRecord, foldStates } from "./ledger";
import { type Ledger, controlPaths, harnessLedger } from "./paths";

/**
 * The deployment ledger of a harness, on the `deployment` machine, so every row's move is
 * checked.
 *
 * First consumers: compile's `prepared` row and activation.
 */
export function deploymentsLedger(harnessDir: string): Ledger {
  return harnessLedger(
    harnessDir,
    { file: controlPaths(harnessDir).deploymentsFile },
    { machine: "deployment" },
  );
}

const BOOKKEEPING = new Set(["claim", "gen"]);

/** A ledger row as a deployment record: the ledger's own fields left out. */
export function deploymentOf(row: LedgerRecord): LedgerRecord {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(row)) {
    if (!BOOKKEEPING.has(name)) out[name] = value;
  }
  return out;
}

export type DeploymentsRead =
  | { readonly state: "absent" }
  | { readonly state: "unreadable"; readonly reason: string }
  | {
      readonly state: "present";
      /** Every deployment, in the order the ledger first names it. */
      readonly records: readonly LedgerRecord[];
      /** The active deployment; with two, the later `activatedAt`. */
      readonly active?: LedgerRecord;
      /** What the fold could not reconcile, one sentence each. */
      readonly anomalies: readonly string[];
    };

function activatedAt(record: LedgerRecord): number {
  const parsed = Date.parse(String(record["activatedAt"]));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/**
 * The harness's deployment records, read-only: no lock, no repair, nothing created. Two
 * rows `active` at once (an activation that stopped between its two compare-and-sets)
 * answer the later `activatedAt` as `active` and report the other.
 *
 * First consumers: activation, the supervisor's build check, Home's deployments view.
 */
export function readDeployments(harnessDir: string): DeploymentsRead {
  const fold = foldStates(deploymentsLedger(harnessDir));
  if (!fold.ok) {
    return fold.code === "not-found"
      ? { state: "absent" }
      : { state: "unreadable", reason: fold.reason };
  }
  if (fold.records === 0 && fold.gaps.length === 0) return { state: "absent" };
  const records: LedgerRecord[] = [];
  const actives: LedgerRecord[] = [];
  for (const object of fold.objects.values()) {
    const record = deploymentOf(object.record);
    records.push(record);
    if (object.state === "active") actives.push(record);
  }
  const anomalies: string[] = [];
  for (const anomaly of fold.anomalies) {
    anomalies.push(
      `${anomaly.id}: a row moving ${anomaly.from ?? "nothing"} to ${anomaly.to ?? "nothing"} is not a move the deployment machine allows`,
    );
  }
  if (fold.gaps.length > 0) {
    anomalies.push(`${fold.gaps.length} line(s) of the deployment ledger cannot be read`);
  }
  let active: LedgerRecord | undefined;
  for (const candidate of actives) {
    if (active === undefined || activatedAt(candidate) >= activatedAt(active)) active = candidate;
  }
  for (const other of actives) {
    if (other !== active) {
      anomalies.push(
        `${String(other["id"])} is also active; ${String(active?.["id"])} was activated later`,
      );
    }
  }
  return {
    state: "present",
    records,
    ...(active !== undefined ? { active } : {}),
    anomalies,
  };
}

// ---------------------------------------------------------------------------
// harness.json
// ---------------------------------------------------------------------------

const IDENTITY_MAX_BYTES = 16 * 1024;

export type HarnessIdentity = {
  readonly v: 1;
  readonly id: string;
  readonly slug?: string;
  readonly createdAt: string;
  /** Fields later versions add, kept on rewrite. */
  readonly [field: string]: unknown;
};

export type HarnessIdentityRead =
  | { readonly state: "absent" }
  | { readonly state: "unreadable"; readonly reason: string }
  | { readonly state: "present"; readonly identity: HarnessIdentity };

/** A body as a harness identity, or the fault. Unknown fields are kept. */
export function parseHarnessIdentity(body: Record<string, unknown>): HarnessIdentity | string {
  if (body["v"] !== 1) return "its version is not 1";
  const id = body["id"];
  if (typeof id !== "string" || !HARNESS_ID_RE.test(id)) return "id is not a harness id";
  if (body["slug"] !== undefined && typeof body["slug"] !== "string") return "slug is not a string";
  if (typeof body["createdAt"] !== "string") return "createdAt is not a string";
  return body as HarnessIdentity;
}

/**
 * The harness's own id, read from `.crewhaus/run/control/harness.json`, contained to the
 * harness, a link at the leaf refused. Reads never write.
 *
 * First consumers: activation, the CLI's receipt target, the registry's adoption.
 */
export function readHarnessIdentity(harnessDir: string): HarnessIdentityRead {
  const rel = controlPaths(harnessDir).harnessIdentityFile;
  const read = readRecordFile(harnessDir, rel, IDENTITY_MAX_BYTES);
  if (!read.ok) {
    return read.code === "not-found"
      ? { state: "absent" }
      : { state: "unreadable", reason: read.reason };
  }
  const text = read.truncated ? undefined : decodeStrict(read.bytes);
  const body = text === undefined ? undefined : parseObject(text);
  if (body === undefined) return { state: "unreadable", reason: `${rel} is not a JSON object` };
  const parsed = parseHarnessIdentity(body);
  return typeof parsed === "string"
    ? { state: "unreadable", reason: `${rel}: ${parsed}` }
    : { state: "present", identity: parsed };
}

export type IdentityWrite =
  | { readonly ok: true; readonly identity: HarnessIdentity }
  | { readonly ok: false; readonly reason: string };

/**
 * Write `harness.json`: atomically, `0600`, synchronously (so `crewhaus init` can call
 * it). Fields an existing readable file holds that `next` does not name are kept. With
 * `ifAbsent`, an existing readable file is answered as it is and nothing is written.
 *
 * First consumers: `crewhaus init`, activation and `crewhaus harness adopt|fork`.
 */
export function writeHarnessIdentity(
  harnessDir: string,
  next: { readonly id: string; readonly slug?: string; readonly createdAt?: string },
  options: { readonly ifAbsent?: boolean; readonly now?: () => number } = {},
): IdentityWrite {
  if (!HARNESS_ID_RE.test(next.id)) return { ok: false, reason: "not a harness id" };
  const paths = controlPaths(harnessDir);
  const existing = readHarnessIdentity(harnessDir);
  if (options.ifAbsent === true && existing.state === "present") {
    return { ok: true, identity: existing.identity };
  }
  const kept = existing.state === "present" ? existing.identity : {};
  const now = options.now ?? (() => Date.now());
  const identity: HarnessIdentity = {
    ...kept,
    v: 1,
    id: next.id,
    ...(next.slug !== undefined ? { slug: next.slug } : {}),
    createdAt:
      next.createdAt ??
      (existing.state === "present" && existing.identity.id === next.id
        ? existing.identity.createdAt
        : new Date(now()).toISOString()),
  };
  const dir = ensureDirContained(harnessDir, paths.controlDir, { mode: 0o700 });
  if (!dir.ok) return { ok: false, reason: dir.reason };
  const written = writeFileSafe(
    harnessDir,
    paths.harnessIdentityFile,
    `${JSON.stringify(identity, null, 2)}\n`,
    { overwrite: true, mode: 0o600 },
  );
  return written.ok ? { ok: true, identity } : { ok: false, reason: written.reason };
}
