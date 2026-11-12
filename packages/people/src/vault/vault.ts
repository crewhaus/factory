/**
 * `openVault`: the people vault under `<hangarRoot>/people/`. It keeps records and keys;
 * the rules about what a profile may hold live in `@crewhaus/people-service`.
 *
 * ```
 * people/                        vault.json, policy.json, lock, erasures.jsonl
 *   keys/<spc>.v<n>.kek          file custody only
 *   spaces/<spc>/space.json      the space and its owner
 *   spaces/<spc>/index.json      one row per profile: ids, revision and state only
 *   spaces/<spc>/persons/<psn>/  key.json (the person key, wrapped by the space key),
 *                                person.sealed, claims/NNNNNN.sealed (one sealed line per
 *                                note revision), rejected.sealed, exports.jsonl,
 *                                activity/NNNNNN.jsonl
 * ```
 *
 * Every write is under the vault lock; reads take no lock and create nothing. Each
 * sealed record binds its kind, its person, its id and its revision, so a record moved
 * to another profile or replayed at another revision does not open. Deleting a person's
 * key makes everything sealed under it unreadable, and rotating the space key after an
 * erasure leaves a copy of the old wrapped key useless.
 */
import { mkdirSync } from "node:fs";
import {
  type CustodialBasis,
  type ErasureCounts,
  type ErasureResidue,
  type PersonKind,
  VAULT_CUSTODIES,
  type VaultCustody,
  canTransition,
  isId,
  mintId,
} from "@crewhaus/control-contract";
import {
  KEY_HEX_RE,
  type PersonKeys,
  type Sealed,
  aesKey,
  bytesOf,
  hexOf,
  hmacHex,
  keyCheck,
  nonceKey,
  open,
  openJson,
  personKeyAad,
  personKeys,
  randomKey,
  recordAad,
  sameText,
  seal,
  sealJson,
  sha256Hex,
} from "./crypto";
import { type Custodian, type SecretsPort, custodianFor, probeKeychain } from "./custody";
import {
  VaultError,
  appendLine,
  jsonLines,
  listNames,
  parseJson,
  readText,
  removeFile,
  removeTree,
  sizeOf,
  withVaultLock,
  writeText,
} from "./files";
import { type RootRefusal, rootRefusal } from "./root";

/** A claims or activity segment rolls over at this size. */
export const SEGMENT_BYTES = 1024 * 1024;
const SEGMENT_RE = /^\d{6}\.(?:sealed|jsonl)$/;
const SMALL_FILE = 64 * 1024;
const INDEX_FILE = 16 * 1024 * 1024;
const SEGMENT_READ = 2 * SEGMENT_BYTES;
/** How long an erasure's dry-run nonce stays good. */
export const ERASURE_NONCE_TTL_MS = 10 * 60 * 1000;

export type ErasureMark = {
  readonly per: string;
  readonly by: string;
  readonly at: string;
  /** The space key version the erasure rotates to; equal to the current one when it cannot. */
  readonly kekTarget: number;
  readonly inventoryDigest: string;
  readonly removed: ErasureCounts;
  readonly residue: readonly ErasureResidue[];
};

/** One profile in a space's index: ids, its revision and its state, never a word of it. */
export type IndexRow = {
  readonly person: string;
  readonly kind: PersonKind;
  readonly owner: string;
  readonly custodian?: string;
  readonly basisKind?: CustodialBasis;
  readonly viewers: readonly string[];
  readonly rev: number;
  readonly state: "active" | "erasing";
  /** Present while an erasure runs, so a run that stopped part way is finished. */
  readonly erasure?: ErasureMark;
};

export type VaultStatus =
  | { readonly state: "not-set-up" }
  | { readonly state: "unreadable"; readonly reason: string }
  | {
      readonly state: "locked";
      readonly reason: string;
      readonly custody: VaultCustody;
      readonly space: string;
      readonly kekVersion: number;
    }
  | {
      readonly state: "ready";
      readonly custody: VaultCustody;
      readonly space: string;
      readonly owner: string;
      readonly kekVersion: number;
      readonly backupDays?: number;
    };

/** A note revision as stored: the vault reads only its id and revision. */
export type ClaimRecord = { readonly id: string; readonly rev: number };

/** A note's id and revision, read from a segment line without opening it. */
export type ClaimLine = { readonly id: string; readonly rev: number };

export type RejectedEntry = { readonly fp: string; readonly claim: string };

export type ExportRow = {
  readonly v: 1;
  readonly pex: string;
  readonly at: string;
  readonly by: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly sha256: string;
};

export type ActivityRow = {
  readonly v: 1;
  readonly at: string;
  readonly actor: string;
  readonly event: string;
  readonly counts: Readonly<Record<string, number>>;
};

export type ErasureRow = {
  readonly v: 1;
  readonly per: string;
  readonly at: string;
  readonly by: string;
  readonly person: string;
  readonly inventoryDigest: string;
  readonly removed: ErasureCounts;
  readonly residue: readonly ErasureResidue[];
};

/** What a profile holds, by count, and a digest that changes whenever any of it does. */
export type Inventory = {
  readonly personRev: number;
  readonly notes: number;
  readonly revisions: number;
  readonly rejected: number;
  readonly exports: number;
  readonly digest: string;
};

export type RotationResult =
  | {
      readonly rotated: true;
      readonly kekVersion: number;
      /** It finished a rotation an earlier run started. */
      readonly resumed: boolean;
      /** `kept` under environment custody: the variable still holds the old key. */
      readonly oldKey: "destroyed" | "absent" | "kept";
    }
  | { readonly rotated: false; readonly reason: "space-key-not-rotated" };

export type ClaimConflict<C> = {
  readonly conflict: "stale_claim_revision";
  readonly current: C | undefined;
};

export type PersonConflict<P> = {
  readonly conflict: "stale_person_revision";
  readonly current: { readonly rev: number; readonly data: P };
};

/** A decrypt or a write, for tests that count work. */
export type VaultObservation =
  | {
      readonly op: "open";
      readonly record: "person" | "claim" | "rejected" | "person-key";
      readonly person: string;
    }
  | { readonly op: "write"; readonly file: string };

export type OpenVaultOptions = {
  /** The vault's directory: the CLI passes `<hangarRoot>/people`. */
  readonly root: string;
  /** The custody `setUp` uses when the caller names none. */
  readonly custody?: VaultCustody;
  /** Shaped like `Bun.secrets`; needed only for keychain custody. */
  readonly secrets?: SecretsPort;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Registered harness directories: a vault at or under one is refused. */
  readonly harnessDirs?: readonly string[];
  readonly now?: () => number;
  readonly platform?: NodeJS.Platform;
  /** Test tap: every decrypt and every write. */
  readonly observe?: (event: VaultObservation) => void;
  /** Test seam: called after each step of a rotation or an erasure; a throw stops it there. */
  readonly onStep?: (step: string) => void;
};

export type CreatePersonInput<P> = {
  readonly person?: string;
  readonly kind: PersonKind;
  readonly owner: string;
  readonly custodian?: string;
  readonly basisKind?: CustodialBasis;
  readonly viewers?: readonly string[];
  readonly data: P;
};

/** Every write, for use inside {@link Vault.write}, which holds the lock. */
export type VaultWriter = {
  createPerson<P>(
    input: CreatePersonInput<P>,
  ): Promise<{ readonly person: string; readonly rev: number }>;
  updatePerson<P>(
    person: string,
    data: P,
    options: { readonly expectRev: number; readonly viewers?: readonly string[] },
  ): Promise<{ readonly rev: number } | PersonConflict<P>>;
  appendClaimRevision<C extends ClaimRecord>(
    person: string,
    claim: C,
    options: { readonly expectRev: number },
  ): Promise<{ readonly rev: number; readonly claim: C } | ClaimConflict<C>>;
  writeRejected(person: string, entries: readonly RejectedEntry[]): Promise<void>;
  appendExport(person: string, row: Omit<ExportRow, "v">): void;
  appendActivity(person: string, row: Omit<ActivityRow, "v">): void;
  setBackupDays(days: number | undefined): void;
  rotateSpaceKey(options?: { readonly newKeyHex?: string }): Promise<RotationResult>;
  shredPerson(person: string): void;
  /** Mark a profile `erasing` with what the erasure will record. Idempotent. */
  markErasing(person: string, mark: ErasureMark): void;
  /** Run a marked erasure's steps, each idempotent, and drop the row last. */
  eraseMarked(person: string): Promise<{ readonly rotation: RotationResult | "skipped" }>;
};

export type Vault = {
  readonly ok: true;
  readonly root: string;
  status(): Promise<VaultStatus>;
  /** Whether the credential store answers. Reads one name; writes nothing. */
  probeKeychain(): Promise<boolean>;
  /** Create the vault and its key. Idempotent: a vault already there is left as it is. */
  setUp(input: {
    readonly custody?: VaultCustody;
    readonly owner: string;
    readonly backupDays?: number;
  }): Promise<{ readonly created: boolean; readonly status: VaultStatus }>;
  /** Run `fn` holding the lock, on a ready vault. */
  write<T>(fn: (writer: VaultWriter) => Promise<T>): Promise<T>;
  rows(): readonly IndexRow[];
  row(person: string): IndexRow | undefined;
  readPerson<P>(
    person: string,
  ): Promise<{ readonly row: IndexRow; readonly rev: number; readonly data: P }>;
  claimLines(person: string): readonly ClaimLine[];
  /** Every revision of every note, opened, in the order written. */
  readClaims<C extends ClaimRecord>(person: string): Promise<readonly C[]>;
  readRejected(person: string): Promise<readonly RejectedEntry[]>;
  fingerprint(person: string, area: string, value: string): Promise<string>;
  readExports(person: string): readonly ExportRow[];
  /** The latest `limit` activity rows, newest first, and whether more are older. */
  readActivity(
    person: string,
    limit: number,
  ): { readonly rows: readonly ActivityRow[]; readonly more: boolean };
  readErasures(): readonly ErasureRow[];
  inventory(person: string): Promise<Inventory>;
  erasureNonce(person: string, digest: string, expiresAt: number): Promise<string>;
  checkErasureNonce(
    person: string,
    digest: string,
    nonce: string,
  ): Promise<"ok" | "expired" | "changed">;
  /** The profile among `persons` that holds note `claim`, read from ids alone. */
  findClaim(claim: string, persons: readonly string[]): string | undefined;
  backupDays(): number | undefined;
  appendClaimRevision<C extends ClaimRecord>(
    person: string,
    claim: C,
    options: { readonly expectRev: number },
  ): Promise<{ readonly rev: number; readonly claim: C } | ClaimConflict<C>>;
  rotateSpaceKey(options?: { readonly newKeyHex?: string }): Promise<RotationResult>;
  shredPerson(person: string): Promise<void>;
};

type Meta = {
  readonly v: 1;
  readonly custody: VaultCustody;
  readonly home: string;
  readonly kekVersion: number;
  readonly kekCheck: string;
};

type SealedFile = Sealed & { readonly v: 1; readonly rev: number };
type KeyFile = Sealed & { readonly v: 1; readonly kekVersion: number };
type SealedLine = Sealed & { readonly v: 1; readonly id: string; readonly rev: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSealed = (value: Record<string, unknown>): boolean =>
  typeof value["iv"] === "string" && typeof value["ct"] === "string";

function asMeta(value: unknown): Meta | undefined {
  if (!isRecord(value) || value["v"] !== 1) return undefined;
  const custody = value["custody"];
  if (!(VAULT_CUSTODIES as readonly unknown[]).includes(custody)) return undefined;
  if (!isId("spc", value["home"])) return undefined;
  const version = value["kekVersion"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return undefined;
  if (typeof value["kekCheck"] !== "string") return undefined;
  return value as Meta;
}

function asRow(value: unknown): IndexRow | undefined {
  if (!isRecord(value)) return undefined;
  if (!isId("psn", value["person"]) || !isId("prn", value["owner"])) return undefined;
  if (!Array.isArray(value["viewers"]) || typeof value["rev"] !== "number") return undefined;
  if (value["state"] !== "active" && value["state"] !== "erasing") return undefined;
  return value as IndexRow;
}

/** Notes compare by meaning, not spelling: NFKC, lowercase, collapsed whitespace. */
export function normalizeNote(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

const segmentName = (n: number, ext: "sealed" | "jsonl"): string =>
  `${String(n).padStart(6, "0")}.${ext}`;

/**
 * Open the vault at `root`, or say why that directory cannot hold one. Opening reads
 * nothing and creates nothing.
 */
export function openVault(options: OpenVaultOptions): Vault | RootRefusal {
  const refusal = rootRefusal(options.root, options.harnessDirs ?? []);
  if (refusal !== undefined) return refusal;
  const root = options.root;
  const env = options.env ?? {};
  const now = options.now ?? (() => Date.now());
  const platform = options.platform ?? process.platform;
  const observe = options.observe ?? (() => undefined);
  const step = options.onStep ?? (() => undefined);

  const keks = new Map<number, Uint8Array>();
  const personKeyCache = new Map<string, { readonly version: number; readonly keys: PersonKeys }>();
  let custodian: Custodian | undefined;

  const custodianOf = (meta: Meta): Custodian => {
    if (custodian === undefined || custodian.kind !== meta.custody) {
      custodian = custodianFor(meta.custody, {
        root,
        space: meta.home,
        ...(options.secrets !== undefined ? { secrets: options.secrets } : {}),
        env,
        platform,
      });
    }
    return custodian;
  };

  const write = (rel: string, text: string, overwrite = true): void => {
    writeText(root, rel, text, overwrite);
    observe({ op: "write", file: rel });
  };
  const append = (rel: string, line: string): number => {
    const size = appendLine(root, rel, line);
    observe({ op: "write", file: rel });
    return size;
  };

  const readMeta = (): Meta | undefined => {
    const read = readText(root, "vault.json", SMALL_FILE);
    if (read.state === "absent") return undefined;
    const meta = asMeta(parseJson("vault.json", read.text));
    if (meta === undefined) throw new VaultError("unreadable", "vault.json is not a vault record");
    return meta;
  };

  const requireMeta = (): Meta => {
    const meta = readMeta();
    if (meta === undefined) {
      throw new VaultError("not-set-up", "Profiles aren't set up on this computer yet.");
    }
    return meta;
  };

  const backupDays = (): number | undefined => {
    const read = readText(root, "policy.json", SMALL_FILE);
    if (read.state === "absent") return undefined;
    const policy = parseJson("policy.json", read.text);
    const days = isRecord(policy) ? policy["backupDays"] : undefined;
    return typeof days === "number" && Number.isInteger(days) && days > 0 ? days : undefined;
  };

  const spaceDir = (meta: Meta): string => `spaces/${meta.home}`;
  const indexRel = (meta: Meta): string => `${spaceDir(meta)}/index.json`;
  const personDir = (meta: Meta, person: string): string => {
    if (!isId("psn", person)) throw new VaultError("invalid", "That is not a profile id.");
    return `${spaceDir(meta)}/persons/${person}`;
  };

  const readRows = (meta: Meta): IndexRow[] => {
    const read = readText(root, indexRel(meta), INDEX_FILE);
    if (read.state === "absent") return [];
    const index = parseJson(indexRel(meta), read.text);
    if (!isRecord(index) || index["v"] !== 1 || !Array.isArray(index["rows"])) {
      throw new VaultError("unreadable", `${indexRel(meta)} is not an index`);
    }
    const rows: IndexRow[] = [];
    for (const value of index["rows"]) {
      const row = asRow(value);
      if (row === undefined) throw new VaultError("unreadable", `${indexRel(meta)} has a bad row`);
      rows.push(row);
    }
    return rows;
  };

  const writeRows = (meta: Meta, rows: readonly IndexRow[]): void =>
    write(indexRel(meta), `${JSON.stringify({ v: 1, rows })}\n`);

  const requireRow = (meta: Meta, person: string): IndexRow => {
    personDir(meta, person);
    const row = readRows(meta).find((r) => r.person === person);
    if (row === undefined) throw new VaultError("not-found", "No profile with that id.");
    return row;
  };

  /** The space key at `version`, from custody. The current one must match the key check. */
  const kek = async (meta: Meta, version: number): Promise<Uint8Array> => {
    const cached = keks.get(version);
    if (cached !== undefined) return cached;
    const read = await custodianOf(meta).get(version);
    if (read.state !== "present") throw new VaultError("locked", read.reason);
    if (version === meta.kekVersion) {
      const check = await keyCheck(read.key, meta.home, version);
      if (!sameText(check, meta.kekCheck)) {
        throw new VaultError(
          "locked",
          `The key in ${meta.custody === "environment" ? "CREWHAUS_PEOPLE_SPACE_KEY" : meta.custody === "file" ? "the key file" : "the credential store"} does not open these profiles.`,
        );
      }
    }
    keks.set(version, read.key);
    return read.key;
  };

  const readKeyFile = (meta: Meta, person: string): KeyFile | undefined => {
    const rel = `${personDir(meta, person)}/key.json`;
    const read = readText(root, rel, SMALL_FILE);
    if (read.state === "absent") return undefined;
    const value = parseJson(rel, read.text);
    if (!isRecord(value) || value["v"] !== 1 || !isSealed(value)) {
      throw new VaultError("unreadable", `${rel} is not a wrapped key`);
    }
    const version = value["kekVersion"];
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      throw new VaultError("unreadable", `${rel} is not a wrapped key`);
    }
    return value as KeyFile;
  };

  const unwrapRaw = async (meta: Meta, person: string, file: KeyFile): Promise<Uint8Array> => {
    const key = await aesKey(await kek(meta, file.kekVersion));
    const raw = await open(key, file, personKeyAad(meta.home, person, file.kekVersion));
    observe({ op: "open", record: "person-key", person });
    if (raw === undefined || raw.length !== 32) {
      throw new VaultError(
        "tampered",
        `The key of profile ${person} does not open: it was changed, or it belongs to another profile or another space key.`,
      );
    }
    return raw;
  };

  const keysOf = async (meta: Meta, person: string): Promise<PersonKeys> => {
    const file = readKeyFile(meta, person);
    if (file === undefined) {
      personKeyCache.delete(person);
      throw new VaultError("not-found", `Profile ${person} has no key: it was erased.`);
    }
    const cached = personKeyCache.get(person);
    if (cached !== undefined && cached.version === file.kekVersion) return cached.keys;
    const keys = await personKeys(await unwrapRaw(meta, person, file));
    personKeyCache.set(person, { version: file.kekVersion, keys });
    return keys;
  };

  const wrap = async (
    meta: Meta,
    person: string,
    raw: Uint8Array,
    version: number,
    key: Uint8Array,
  ) => {
    const sealed = await seal(await aesKey(key), raw, personKeyAad(meta.home, person, version));
    write(
      `${personDir(meta, person)}/key.json`,
      `${JSON.stringify({ v: 1, kekVersion: version, ...sealed })}\n`,
    );
  };

  const tampered = (what: string, person: string): VaultError =>
    new VaultError(
      "tampered",
      `A sealed ${what} of profile ${person} does not open: it was changed, moved from another profile or replayed.`,
    );

  const readSealedFile = async <T>(
    meta: Meta,
    person: string,
    file: "person.sealed" | "rejected.sealed",
    kind: "person" | "rejected",
  ): Promise<{ readonly rev: number; readonly data: T } | undefined> => {
    const rel = `${personDir(meta, person)}/${file}`;
    const read = readText(root, rel, INDEX_FILE);
    if (read.state === "absent") return undefined;
    const value = parseJson(rel, read.text);
    if (
      !isRecord(value) ||
      value["v"] !== 1 ||
      !isSealed(value) ||
      typeof value["rev"] !== "number"
    ) {
      throw new VaultError("unreadable", `${rel} is not a sealed record`);
    }
    const sealed = value as SealedFile;
    const keys = await keysOf(meta, person);
    const data = await openJson(keys.records, sealed, recordAad(kind, person, person, sealed.rev));
    observe({ op: "open", record: kind, person });
    if (data === undefined) throw tampered(kind, person);
    return { rev: sealed.rev, data: data as T };
  };

  const segments = (meta: Meta, person: string, dir: "claims" | "activity"): string[] =>
    listNames(root, `${personDir(meta, person)}/${dir}`, SEGMENT_RE);

  const sealedLines = (meta: Meta, person: string): SealedLine[] => {
    const out: SealedLine[] = [];
    for (const name of segments(meta, person, "claims")) {
      const rel = `${personDir(meta, person)}/claims/${name}`;
      const read = readText(root, rel, SEGMENT_READ);
      if (read.state === "absent") continue;
      for (const value of jsonLines(read.text)) {
        if (
          isRecord(value) &&
          value["v"] === 1 &&
          isSealed(value) &&
          isId("pcl", value["id"]) &&
          typeof value["rev"] === "number"
        ) {
          out.push(value as SealedLine);
        }
      }
    }
    return out;
  };

  const openLine = async <C extends ClaimRecord>(
    person: string,
    keys: PersonKeys,
    line: SealedLine,
  ): Promise<C> => {
    const data = await openJson(keys.records, line, recordAad("claim", person, line.id, line.rev));
    observe({ op: "open", record: "claim", person });
    if (!isRecord(data) || data["id"] !== line.id || data["rev"] !== line.rev) {
      throw tampered("note", person);
    }
    return data as C;
  };

  const appendSegment = (meta: Meta, person: string, dir: "claims" | "activity", line: string) => {
    const ext = dir === "claims" ? "sealed" : "jsonl";
    const names = segments(meta, person, dir);
    const last = names.at(-1);
    let n = last === undefined ? 1 : Number(last.slice(0, 6));
    if (last !== undefined) {
      const size = sizeOf(root, `${personDir(meta, person)}/${dir}/${last}`) ?? 0;
      if (size + Buffer.byteLength(line) + 1 > SEGMENT_BYTES) n += 1;
    }
    append(`${personDir(meta, person)}/${dir}/${segmentName(n, ext)}`, line);
  };

  const readJsonl = (rel: string): unknown[] => {
    const read = readText(root, rel, INDEX_FILE);
    return read.state === "absent" ? [] : jsonLines(read.text);
  };

  const rejectedOf = async (
    meta: Meta,
    person: string,
  ): Promise<{ rev: number; entries: RejectedEntry[] }> => {
    const found = await readSealedFile<{ entries?: unknown }>(
      meta,
      person,
      "rejected.sealed",
      "rejected",
    );
    if (found === undefined) return { rev: 0, entries: [] };
    const entries = Array.isArray(found.data.entries) ? found.data.entries : [];
    return {
      rev: found.rev,
      entries: entries.filter(
        (e): e is RejectedEntry =>
          isRecord(e) && typeof e["fp"] === "string" && typeof e["claim"] === "string",
      ),
    };
  };

  const ready = async (): Promise<Meta> => {
    const meta = requireMeta();
    await kek(meta, meta.kekVersion);
    return meta;
  };

  // -------------------------------------------------------------------------
  // Rotation
  // -------------------------------------------------------------------------

  /** Destroy the version before the current one, once no person key needs it. */
  const finishRotation = async (meta: Meta): Promise<"destroyed" | "absent" | "kept"> => {
    if (meta.custody === "environment" || meta.kekVersion < 2) return "absent";
    const older = meta.kekVersion - 1;
    const read = await custodianOf(meta).get(older);
    if (read.state !== "present") return "absent";
    for (const row of readRows(meta)) {
      if (readKeyFile(meta, row.person)?.kekVersion === older) return "absent";
    }
    keks.delete(older);
    return custodianOf(meta).destroy(older);
  };

  const rotateLocked = async (newKeyHex?: string): Promise<RotationResult> => {
    const meta = requireMeta();
    const keeper = custodianOf(meta);
    const current = meta.kekVersion;
    const target = current + 1;
    const rows = readRows(meta);
    const atTarget = rows.filter((row) => readKeyFile(meta, row.person)?.kekVersion === target);
    let next: Uint8Array;
    let resumed = false;
    if (meta.custody === "environment") {
      if (newKeyHex === undefined) return { rotated: false, reason: "space-key-not-rotated" };
      const given = KEY_HEX_RE.test(newKeyHex.trim()) ? bytesOf(newKeyHex.trim()) : undefined;
      if (given === undefined) throw new VaultError("invalid", "A new key is 64 hex characters.");
      if (sameText(newKeyHex.trim(), hexOf(await kek(meta, current)))) {
        throw new VaultError("invalid", "The new key is the key in use now.");
      }
      const sample = atTarget[0];
      if (sample !== undefined) {
        const file = readKeyFile(meta, sample.person) as KeyFile;
        const raw = await open(
          await aesKey(given),
          file,
          personKeyAad(meta.home, sample.person, target),
        );
        if (raw === undefined) {
          throw new VaultError("invalid", "That is not the key the interrupted rotation used.");
        }
        resumed = true;
      }
      next = given;
      await keeper.put(target, next);
    } else {
      const pending = await keeper.get(target);
      if (pending.state === "unreachable") throw new VaultError("locked", pending.reason);
      if (pending.state === "present") {
        next = pending.key;
        resumed = true;
      } else {
        if (atTarget.length > 0) {
          throw new VaultError("locked", "A rotation stopped part way and its new key is gone.");
        }
        const cleaned = await finishRotation(meta);
        if (cleaned === "destroyed") {
          return { rotated: true, kekVersion: current, resumed: true, oldKey: "destroyed" };
        }
        next = randomKey();
        await keeper.put(target, next);
      }
    }
    keks.set(target, next);
    step("key-stored");
    for (const row of rows) {
      const file = readKeyFile(meta, row.person);
      // An erasure that already deleted this key has nothing to re-wrap.
      if (file === undefined || file.kekVersion === target) continue;
      const raw = await unwrapRaw(meta, row.person, file);
      await wrap(meta, row.person, raw, target, next);
      personKeyCache.delete(row.person);
      step("person-key-rewrapped");
    }
    step("person-keys-rewrapped");
    write(
      "vault.json",
      `${JSON.stringify({ ...meta, kekVersion: target, kekCheck: await keyCheck(next, meta.home, target) })}\n`,
    );
    step("version-set");
    keks.delete(current);
    const oldKey = await keeper.destroy(current);
    step("old-key-destroyed");
    return { rotated: true, kekVersion: target, resumed, oldKey };
  };

  // -------------------------------------------------------------------------
  // The writer
  // -------------------------------------------------------------------------

  const writer = (): VaultWriter => ({
    async createPerson(input) {
      const meta = requireMeta();
      const person = input.person ?? mintId("psn");
      const dir = personDir(meta, person);
      const rows = readRows(meta);
      if (
        rows.some((row) => row.person === person) ||
        sizeOf(root, `${dir}/key.json`) !== undefined
      ) {
        throw new VaultError("exists", "That profile id is taken.");
      }
      const raw = randomKey();
      await wrap(meta, person, raw, meta.kekVersion, await kek(meta, meta.kekVersion));
      const keys = await personKeys(raw);
      personKeyCache.set(person, { version: meta.kekVersion, keys });
      const sealed = await sealJson(
        keys.records,
        input.data,
        recordAad("person", person, person, 1),
      );
      write(`${dir}/person.sealed`, `${JSON.stringify({ v: 1, rev: 1, ...sealed })}\n`, false);
      const row: IndexRow = {
        person,
        kind: input.kind,
        owner: input.owner,
        ...(input.custodian !== undefined ? { custodian: input.custodian } : {}),
        ...(input.basisKind !== undefined ? { basisKind: input.basisKind } : {}),
        viewers: [...(input.viewers ?? [])],
        rev: 1,
        state: "active",
      };
      writeRows(meta, [...rows, row]);
      return { person, rev: 1 };
    },

    async updatePerson(person, data, opts) {
      const meta = requireMeta();
      const rows = readRows(meta);
      const row = rows.find((r) => r.person === person);
      if (row === undefined || row.state !== "active") {
        throw new VaultError("not-found", "No profile with that id.");
      }
      const found = await readSealedFile<typeof data>(meta, person, "person.sealed", "person");
      if (found === undefined) throw new VaultError("not-found", "No profile with that id.");
      if (row.rev !== opts.expectRev) {
        return { conflict: "stale_person_revision", current: { rev: row.rev, data: found.data } };
      }
      // A crash between the two writes leaves the file behind the index, never ahead of it.
      const rev = Math.max(row.rev, found.rev) + 1;
      const next: IndexRow = {
        ...row,
        rev,
        ...(opts.viewers !== undefined ? { viewers: [...opts.viewers] } : {}),
      };
      writeRows(
        meta,
        rows.map((r) => (r.person === person ? next : r)),
      );
      const keys = await keysOf(meta, person);
      const sealed = await sealJson(keys.records, data, recordAad("person", person, person, rev));
      write(
        `${personDir(meta, person)}/person.sealed`,
        `${JSON.stringify({ v: 1, rev, ...sealed })}\n`,
      );
      return { rev };
    },

    async appendClaimRevision(person, claim, opts) {
      const meta = requireMeta();
      const row = requireRow(meta, person);
      if (row.state !== "active") throw new VaultError("not-found", "No profile with that id.");
      if (!isId("pcl", claim.id)) throw new VaultError("invalid", "That is not a note id.");
      const lines = sealedLines(meta, person).filter((line) => line.id === claim.id);
      const latest = lines.reduce<SealedLine | undefined>(
        (best, line) => (best === undefined || line.rev > best.rev ? line : best),
        undefined,
      );
      const currentRev = latest?.rev ?? 0;
      const keys = await keysOf(meta, person);
      if (currentRev !== opts.expectRev) {
        const current =
          latest === undefined ? undefined : await openLine<typeof claim>(person, keys, latest);
        return { conflict: "stale_claim_revision", current };
      }
      const rev = currentRev + 1;
      const stored = { ...claim, rev };
      const sealed = await sealJson(
        keys.records,
        stored,
        recordAad("claim", person, claim.id, rev),
      );
      appendSegment(meta, person, "claims", JSON.stringify({ v: 1, id: claim.id, rev, ...sealed }));
      return { rev, claim: stored };
    },

    async writeRejected(person, entries) {
      const meta = requireMeta();
      requireRow(meta, person);
      const { rev } = await rejectedOf(meta, person);
      const keys = await keysOf(meta, person);
      const next = rev + 1;
      const sealed = await sealJson(
        keys.records,
        { entries },
        recordAad("rejected", person, person, next),
      );
      write(
        `${personDir(meta, person)}/rejected.sealed`,
        `${JSON.stringify({ v: 1, rev: next, ...sealed })}\n`,
      );
    },

    appendExport(person, row) {
      const meta = requireMeta();
      requireRow(meta, person);
      append(`${personDir(meta, person)}/exports.jsonl`, JSON.stringify({ v: 1, ...row }));
    },

    appendActivity(person, row) {
      const meta = requireMeta();
      requireRow(meta, person);
      appendSegment(meta, person, "activity", JSON.stringify({ v: 1, ...row }));
    },

    setBackupDays(days) {
      write(
        "policy.json",
        `${JSON.stringify({ v: 1, ...(days !== undefined ? { backupDays: days } : {}) })}\n`,
      );
    },

    rotateSpaceKey(opts) {
      return rotateLocked(opts?.newKeyHex);
    },

    shredPerson(person) {
      const meta = requireMeta();
      const dir = personDir(meta, person);
      removeFile(root, `${dir}/key.json`);
      personKeyCache.delete(person);
      removeTree(root, dir);
      writeRows(
        meta,
        readRows(meta).filter((row) => row.person !== person),
      );
    },

    markErasing(person, mark) {
      const meta = requireMeta();
      const rows = readRows(meta);
      const row = rows.find((r) => r.person === person);
      if (row === undefined) throw new VaultError("not-found", "No profile with that id.");
      if (row.state === "erasing") return;
      if (!canTransition("person", row.state, "erasing")) {
        throw new VaultError("invalid", "This profile cannot be erased from its state.");
      }
      writeRows(
        meta,
        rows.map((r) => (r.person === person ? { ...r, state: "erasing", erasure: mark } : r)),
      );
      step("marked");
    },

    async eraseMarked(person) {
      const meta = requireMeta();
      const row = requireRow(meta, person);
      const mark = row.erasure;
      if (row.state !== "erasing" || mark === undefined) {
        throw new VaultError("invalid", "This profile is not being erased.");
      }
      const dir = personDir(meta, person);
      removeFile(root, `${dir}/key.json`);
      personKeyCache.delete(person);
      step("key-deleted");
      removeTree(root, dir);
      step("records-deleted");
      let rotation: RotationResult | "skipped" = "skipped";
      const latest = requireMeta();
      if (latest.kekVersion < mark.kekTarget) {
        rotation = await rotateLocked();
      } else {
        await finishRotation(latest);
      }
      step("space-key-rotated");
      const recorded = readJsonl("erasures.jsonl").some(
        (value) => isRecord(value) && value["per"] === mark.per,
      );
      if (!recorded) {
        const entry: ErasureRow = {
          v: 1,
          per: mark.per,
          at: mark.at,
          by: mark.by,
          person,
          inventoryDigest: mark.inventoryDigest,
          removed: mark.removed,
          residue: mark.residue,
        };
        append("erasures.jsonl", JSON.stringify(entry));
      }
      step("recorded");
      if (!canTransition("person", "erasing", "erased")) {
        throw new VaultError("invalid", "An erasing profile cannot be closed.");
      }
      const after = requireMeta();
      writeRows(
        after,
        readRows(after).filter((r) => r.person !== person),
      );
      step("row-removed");
      return { rotation };
    },
  });

  const handle: Vault = {
    ok: true,
    root,

    async status() {
      let meta: Meta | undefined;
      try {
        meta = readMeta();
      } catch (err) {
        return { state: "unreadable", reason: err instanceof Error ? err.message : String(err) };
      }
      if (meta === undefined) return { state: "not-set-up" };
      try {
        await kek(meta, meta.kekVersion);
      } catch (err) {
        if (err instanceof VaultError && err.code === "locked") {
          return {
            state: "locked",
            reason: err.message,
            custody: meta.custody,
            space: meta.home,
            kekVersion: meta.kekVersion,
          };
        }
        return { state: "unreadable", reason: err instanceof Error ? err.message : String(err) };
      }
      try {
        const read = readText(root, `${spaceDir(meta)}/space.json`, SMALL_FILE);
        const space = read.state === "present" ? parseJson("space.json", read.text) : undefined;
        const owner = isRecord(space) ? space["owner"] : undefined;
        if (!isId("prn", owner))
          return { state: "unreadable", reason: "space.json names no owner" };
        const days = backupDays();
        return {
          state: "ready",
          custody: meta.custody,
          space: meta.home,
          owner: owner as string,
          kekVersion: meta.kekVersion,
          ...(days !== undefined ? { backupDays: days } : {}),
        };
      } catch (err) {
        return { state: "unreadable", reason: err instanceof Error ? err.message : String(err) };
      }
    },

    probeKeychain: () => probeKeychain(options.secrets),

    async setUp(input) {
      const existing = readMeta();
      if (existing !== undefined) return { created: false, status: await handle.status() };
      const custody = input.custody ?? options.custody;
      if (custody === undefined) {
        throw new VaultError(
          "invalid",
          "Choose where the profile key is kept: keychain, environment or file.",
        );
      }
      if (!isId("prn", input.owner))
        throw new VaultError("invalid", "The owner is not a principal.");
      if (custody === "keychain" && options.secrets === undefined) {
        throw new VaultError(
          "locked",
          "This computer's credential store can't be reached from here.",
        );
      }
      if (custody === "environment") {
        const probe = await custodianFor("environment", { root, space: "", env, platform }).get(1);
        if (probe.state !== "present") {
          throw new VaultError(
            "locked",
            `${probe.reason} Set it to 64 hex characters (for example from \`openssl rand -hex 32\`), then run this again.`,
          );
        }
      }
      mkdirSync(root, { recursive: true, mode: 0o700 });
      return withVaultLock(root, async () => {
        if (readMeta() !== undefined) return { created: false, status: await handle.status() };
        // A run that stopped before vault.json reuses its space and its key.
        const earlier = listNames(root, "spaces", /^spc_[0-9a-hjkmnp-tv-z]{26}$/);
        const space = earlier.length === 1 ? (earlier[0] as string) : mintId("spc");
        const keeper = custodianFor(custody, {
          root,
          space,
          ...(options.secrets !== undefined ? { secrets: options.secrets } : {}),
          env,
          platform,
        });
        const held = await keeper.get(1);
        if (held.state === "unreachable") throw new VaultError("locked", held.reason);
        let key: Uint8Array;
        if (held.state === "present") {
          key = held.key;
        } else {
          key = randomKey();
          await keeper.put(1, key);
        }
        write(
          `spaces/${space}/space.json`,
          `${JSON.stringify({ v: 1, space, kind: "home", owner: input.owner })}\n`,
        );
        if (sizeOf(root, `spaces/${space}/index.json`) === undefined) {
          write(`spaces/${space}/index.json`, `${JSON.stringify({ v: 1, rows: [] })}\n`);
        }
        write(
          "policy.json",
          `${JSON.stringify({ v: 1, ...(input.backupDays !== undefined ? { backupDays: input.backupDays } : {}) })}\n`,
        );
        const meta: Meta = {
          v: 1,
          custody,
          home: space,
          kekVersion: 1,
          kekCheck: await keyCheck(key, space, 1),
        };
        write("vault.json", `${JSON.stringify(meta)}\n`);
        custodian = keeper;
        keks.set(1, key);
        return { created: true, status: await handle.status() };
      });
    },

    async write(fn) {
      await ready();
      return withVaultLock(root, async () => {
        await ready();
        return fn(writer());
      });
    },

    rows() {
      const meta = readMeta();
      return meta === undefined ? [] : readRows(meta);
    },

    row(person) {
      const meta = readMeta();
      if (meta === undefined || !isId("psn", person)) return undefined;
      return readRows(meta).find((r) => r.person === person);
    },

    async readPerson<P>(person: string) {
      const meta = await ready();
      const row = requireRow(meta, person);
      const found = await readSealedFile<P>(meta, person, "person.sealed", "person");
      if (found === undefined) throw new VaultError("not-found", "No profile with that id.");
      return { row, rev: row.rev, data: found.data };
    },

    claimLines(person) {
      const meta = requireMeta();
      return sealedLines(meta, person).map((line) => ({ id: line.id, rev: line.rev }));
    },

    async readClaims<C extends ClaimRecord>(person: string) {
      const meta = await ready();
      requireRow(meta, person);
      const lines = sealedLines(meta, person);
      if (lines.length === 0) return [];
      const keys = await keysOf(meta, person);
      const out: C[] = [];
      for (const line of lines) out.push(await openLine<C>(person, keys, line));
      return out;
    },

    async readRejected(person) {
      const meta = await ready();
      requireRow(meta, person);
      return (await rejectedOf(meta, person)).entries;
    },

    async fingerprint(person, area, value) {
      const meta = await ready();
      const keys = await keysOf(meta, person);
      return hmacHex(keys.fp, `${area}\n${normalizeNote(value)}`);
    },

    readExports(person) {
      const meta = requireMeta();
      return readJsonl(`${personDir(meta, person)}/exports.jsonl`).filter(
        (value): value is ExportRow => isRecord(value) && typeof value["at"] === "string",
      );
    },

    readActivity(person, limit) {
      const meta = requireMeta();
      const rows: ActivityRow[] = [];
      let more = false;
      const names = segments(meta, person, "activity");
      for (let i = names.length - 1; i >= 0; i--) {
        const lines = readJsonl(`${personDir(meta, person)}/activity/${names[i]}`).filter(
          (value): value is ActivityRow =>
            isRecord(value) &&
            typeof value["at"] === "string" &&
            typeof value["event"] === "string",
        );
        for (let j = lines.length - 1; j >= 0; j--) {
          if (rows.length === limit) {
            more = true;
            break;
          }
          rows.push(lines[j] as ActivityRow);
        }
        if (more) break;
      }
      return { rows, more };
    },

    readErasures() {
      return readJsonl("erasures.jsonl").filter(
        (value): value is ErasureRow => isRecord(value) && typeof value["per"] === "string",
      );
    },

    async inventory(person) {
      const meta = await ready();
      const row = requireRow(meta, person);
      const lines = sealedLines(meta, person);
      const rejected = row.state === "active" ? (await rejectedOf(meta, person)).entries.length : 0;
      const exports = handle.readExports(person).length;
      const counts = {
        person,
        personRev: row.rev,
        notes: new Set(lines.map((line) => line.id)).size,
        revisions: lines.length,
        rejected,
        exports,
        last: lines.map((line) => `${line.id}:${line.rev}`).sort(),
      };
      return {
        personRev: counts.personRev,
        notes: counts.notes,
        revisions: counts.revisions,
        rejected,
        exports,
        digest: await sha256Hex(JSON.stringify(counts)),
      };
    },

    async erasureNonce(person, digest, expiresAt) {
      const meta = await ready();
      const key = await nonceKey(await kek(meta, meta.kekVersion));
      return `${expiresAt}.${await hmacHex(key, `${person}|${digest}|${expiresAt}`)}`;
    },

    async checkErasureNonce(person, digest, nonce) {
      const match = /^(\d{1,16})\.([0-9a-f]{64})$/.exec(nonce);
      if (match === null) return "changed";
      const expiresAt = Number(match[1]);
      if (now() > expiresAt) return "expired";
      const expected = await handle.erasureNonce(person, digest, expiresAt);
      return sameText(expected, nonce) ? "ok" : "changed";
    },

    findClaim(claim, persons) {
      if (!isId("pcl", claim)) return undefined;
      const meta = readMeta();
      if (meta === undefined) return undefined;
      return persons.find((person) => sealedLines(meta, person).some((line) => line.id === claim));
    },

    backupDays,

    appendClaimRevision: (person, claim, opts) =>
      handle.write((w) => w.appendClaimRevision(person, claim, opts)),

    rotateSpaceKey: (opts) => handle.write((w) => w.rotateSpaceKey(opts)),

    shredPerson: (person) => handle.write(async (w) => w.shredPerson(person)),
  };
  return handle;
}

/** Whether `value` is the refusal `openVault` answers for a root that cannot hold a vault. */
export function isRootRefusal(value: Vault | RootRefusal): value is RootRefusal {
  return value.ok === false;
}
