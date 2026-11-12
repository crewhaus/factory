/**
 * The admin: every act on a profile, with the rules (#521, module brief 329). Each write
 * is one command whose receipt is accepted before the vault changes, in Home's workspace
 * ledger, through the injected `receipts` port; each read writes nothing. A profile the
 * actor may not see and a profile that does not exist get the same answer, byte for byte.
 *
 * The receipts port is shaped like control-service's `commands.submit`, which the CLI
 * passes; this package never imports control-service or access-control. The caller
 * passes the acting principal.
 */
import { existsSync, lstatSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  AUDIENCE_BASES,
  AUDIENCE_VARIATIONS,
  AUDIENCE_WHO_MAX,
  type AudienceView,
  CUSTODIAL_BASES,
  type ClaimCreateRequest,
  type CommandReceipt,
  type CustodialBasis,
  type ErasureCounts,
  type ErasurePlanView,
  type ErasureResidue,
  type ErrorCode,
  type ExportPreview,
  type ExportRequest,
  NOTE_ACQUISITIONS,
  NOTE_AREA_RE,
  NOTE_CONFIDENCES,
  NOTE_SENSITIVITIES,
  NOTE_SITUATION_MAX,
  NOTE_TYPES,
  NOTE_VALUE_MAX,
  type NoteSensitivity,
  type NoteVerdict,
  PEOPLE_EXPORT_FORMAT,
  PEOPLE_PURPOSES,
  PERSON_LABEL_MAX,
  type PeoplePurpose,
  type PersonActivityEvent,
  type PersonActivityRow,
  type PersonClaimView,
  type PersonCreateRequest,
  type PersonKind,
  type PersonRow,
  type PersonView,
  type ReceiptEffect,
  type ReceiptVia,
  SPECIAL_NOTE_TYPES,
  type VaultCustody,
  type VaultStateView,
  canTransition,
  canonicalJson,
  isId,
  mintId,
} from "@crewhaus/control-contract";
import {
  ERASURE_NONCE_TTL_MS,
  type IndexRow,
  type Vault,
  VaultError,
  type VaultStatus,
  sha256Hex,
} from "@crewhaus/people/vault";
import { maskCredentialTokens } from "@crewhaus/spec-patch";
import { writeFileSafe } from "@crewhaus/tool-safety/fs";
import { authorizePerson, authorizeSpace, roleOn } from "./policy";

// ---------------------------------------------------------------------------
// The receipts port
// ---------------------------------------------------------------------------

export type ReceiptRequest = {
  readonly kind: string;
  /** `home/person/<psn>`; absent for a command about the vault itself. */
  readonly target?: string;
  readonly ledger: "workspace";
  readonly via: ReceiptVia;
  readonly body?: Readonly<Record<string, unknown>>;
  /** Body fields that carry a person's words: the fingerprint never hashes them. */
  readonly secretFields?: readonly string[];
};

export type ReceiptSettlement = {
  readonly state: "succeeded" | "failed" | "unknown" | "rejected" | "cancelled";
  readonly effects?: readonly ReceiptEffect[];
  readonly outcome?: { readonly code: ErrorCode; readonly message: string };
};

export type ReceiptAnswer<T> =
  | {
      readonly ok: true;
      readonly replayed: false;
      readonly receipt: CommandReceipt;
      readonly value: T | undefined;
    }
  | { readonly ok: true; readonly replayed: true; readonly receipt: CommandReceipt }
  | {
      readonly ok: false;
      readonly refusal: { readonly code: ErrorCode; readonly message: string };
    };

/** Write the `accepted` receipt, run `effect`, settle the receipt from what it answers. */
export type ReceiptsPort = <T>(
  request: ReceiptRequest,
  effect: (
    receipt: CommandReceipt,
  ) => Promise<{ readonly settle?: ReceiptSettlement; readonly value: T }>,
) => Promise<ReceiptAnswer<T>>;

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export type Refused = {
  readonly ok: false;
  readonly code: ErrorCode;
  /** A stable word for what was refused. */
  readonly reason: string;
  readonly message: string;
  /** The vault's own words, when a key or a file is the reason. */
  readonly detail?: string;
  /** The record as it stands, for a stale revision. */
  readonly current?: unknown;
};

export type Done<T> = { readonly ok: true; readonly value: T; readonly receipt?: CommandReceipt };

export type Answer<T> = Done<T> | Refused;

/** "Not allowed" and "no such profile" are this one answer. */
export const NOT_FOUND: Refused = Object.freeze({
  ok: false,
  code: "not_found",
  reason: "not-found",
  message: "No profile or note with that id.",
});

function refused(
  code: ErrorCode,
  reason: string,
  message: string,
  extra: { readonly detail?: string; readonly current?: unknown } = {},
): Refused {
  return { ok: false, code, reason, message, ...extra };
}

/** One sentence per outcome code, so a receipt never quotes a profile or a file. */
const OUTCOME: Partial<Record<ErrorCode, string>> = {
  not_found: "refused: what it names does not exist",
  invalid: "refused: the request was not valid",
  conflict: "refused: it changed since it was read",
  precondition_failed: "refused: a check before it ran did not pass",
  unavailable: "not done: the vault could not be reached",
  internal: "not done: it stopped with an error",
};

function fromVault(err: VaultError): Refused {
  switch (err.code) {
    case "not-set-up":
      return NOT_SET_UP;
    case "locked":
      return refused("unavailable", "locked", LOCKED_MESSAGE, { detail: err.message });
    case "not-found":
      return NOT_FOUND;
    case "invalid":
      return refused("invalid", "invalid", err.message);
    case "exists":
      return refused("conflict", "exists", err.message);
    default:
      return refused("internal", err.code, "The vault refused this.", { detail: err.message });
  }
}

const NOT_SET_UP: Refused = Object.freeze({
  ok: false,
  code: "precondition_failed",
  reason: "not-set-up",
  message: "Profiles aren't set up on this computer yet.",
});

const LOCKED_MESSAGE = "Profiles are locked. This computer can't reach the profile key.";

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** What `person.sealed` holds. */
export type PersonData = {
  readonly v: 1;
  readonly label: string;
  readonly kind: PersonKind;
  readonly describes?: "self" | "someone-else";
  readonly basis?: {
    readonly kind: CustodialBasis;
    readonly recordedAt: string;
    readonly recordedBy: string;
  };
  readonly audience?: AudienceView;
  readonly synthetic?: true;
  readonly offLimits: readonly string[];
  readonly viewers: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** A note revision as sealed: the whole note at that revision. */
export type StoredClaim = PersonClaimView;

export type PersonPatch = {
  readonly label?: string;
  /** Areas to put off-limits. */
  readonly offLimits?: readonly string[];
  /** Areas to allow again. */
  readonly allow?: readonly string[];
  readonly viewers?: readonly string[];
  readonly removeViewers?: readonly string[];
};

export type ReviewInput = {
  readonly verdict: NoteVerdict;
  readonly purposes?: readonly PeoplePurpose[];
  readonly into?: string;
};

export type ExportOptions = ExportRequest;

export type ExportBuilt = {
  readonly preview: ExportPreview;
  /** The file, exactly: UTF-8 JSON, keys sorted, ending in a newline. */
  readonly text: string;
  /** A readable account of the same notes. */
  readonly summary: string;
};

export type PeopleAdminOptions = {
  readonly vault: Vault;
  readonly receipts: ReceiptsPort;
  /** The acting principal, `prn_…`. */
  readonly actor: string;
  readonly via?: ReceiptVia;
  readonly now?: () => number;
};

const SENSITIVE: readonly NoteSensitivity[] = ["sensitive", "special"];
const EDITABLE_STATES = ["proposed", "active", "conflicted"] as const;
const CUSTODIAL: readonly string[] = CUSTODIAL_BASES;
const AUDIENCE: readonly string[] = AUDIENCE_BASES;
const NOTE_FIELDS = { area: "area", value: "value", situation: "situation" } as const;

const iso = (ms: number): string => new Date(ms).toISOString();
const dayOf = (ms: number): string => iso(ms).slice(0, 10);
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

function countsText(counts: Readonly<Record<string, number>>): string {
  return Object.entries(counts)
    .map(([name, n]) => `${name} ${n}`)
    .join(", ");
}

/** The current revision of each note, folded from every revision in the order written. */
export function currentNotes(revisions: readonly StoredClaim[]): StoredClaim[] {
  const latest = new Map<string, StoredClaim>();
  for (const claim of revisions) {
    const seen = latest.get(claim.id);
    if (seen === undefined || claim.rev > seen.rev) latest.set(claim.id, claim);
  }
  return [...latest.values()];
}

function textOk(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= max;
}

// ---------------------------------------------------------------------------
// The admin
// ---------------------------------------------------------------------------

export type PeopleAdmin = ReturnType<typeof createPeopleAdmin>;

export function createPeopleAdmin(options: PeopleAdminOptions) {
  const { vault, receipts, actor } = options;
  const via = options.via ?? "cli";
  const now = options.now ?? (() => Date.now());
  if (!isId("prn", actor)) throw new TypeError("people-service: the actor must be a principal id");

  type Ready = Extract<VaultStatus, { state: "ready" }>;

  const ready = async (): Promise<Ready | Refused> => {
    const status = await vault.status();
    switch (status.state) {
      case "ready":
        return status;
      case "not-set-up":
        return NOT_SET_UP;
      case "locked":
        return refused("unavailable", "locked", LOCKED_MESSAGE, { detail: status.reason });
      case "unreadable":
        return refused("unavailable", "unreadable", "The profiles can't be read.", {
          detail: status.reason,
        });
    }
  };

  /** The profile's row when the actor holds `permission` on it, else the not-found answer. */
  const rowFor = (person: string, permission: string): IndexRow | Refused => {
    if (!isId("psn", person)) return NOT_FOUND;
    const row = vault.row(person);
    if (row === undefined || !authorizePerson(row, actor, permission).allow) return NOT_FOUND;
    return row;
  };

  const erasing = (row: IndexRow): Refused =>
    refused(
      "conflict",
      "erasing",
      `This profile is being erased. Run \`crewhaus people erase ${row.person}\` to finish.`,
    );

  /** Guard the vault's own refusals into answers. */
  const guarded = async <T>(run: () => Promise<Answer<T>>): Promise<Answer<T>> => {
    try {
      return await run();
    } catch (err) {
      if (err instanceof VaultError) return fromVault(err);
      throw err;
    }
  };

  type Effected<T> = { readonly value: T; readonly effects?: readonly ReceiptEffect[] };

  /** One receipted command: accepted first, then the effect, then the settlement. */
  const command = async <T>(
    request: Omit<ReceiptRequest, "ledger" | "via">,
    effect: () => Promise<Effected<T> | Refused>,
  ): Promise<Answer<T>> => {
    const answer = await receipts<Effected<T> | Refused>(
      { ...request, ledger: "workspace", via },
      async () => {
        let out: Effected<T> | Refused;
        try {
          out = await effect();
        } catch (err) {
          if (!(err instanceof VaultError)) throw err;
          out = fromVault(err);
        }
        if ("ok" in out && out.ok === false) {
          return {
            settle: {
              state: out.code === "internal" || out.code === "unavailable" ? "failed" : "rejected",
              outcome: { code: out.code, message: OUTCOME[out.code] ?? "refused" },
            },
            value: out,
          };
        }
        const done = out as Effected<T>;
        return { settle: { state: "succeeded", effects: done.effects ?? [] }, value: done };
      },
    );
    if (!answer.ok) {
      return refused(
        answer.refusal.code,
        "receipt",
        "The command could not be recorded, so nothing was done.",
        {
          detail: answer.refusal.message,
        },
      );
    }
    if (answer.replayed || answer.value === undefined) {
      return refused("conflict", "replayed", "This command was already run.");
    }
    const value = answer.value;
    if ("ok" in value && value.ok === false) return value;
    return { ok: true, value: (value as Effected<T>).value, receipt: answer.receipt };
  };

  const target = (person: string): string => `home/person/${person}`;

  const activity = (event: PersonActivityEvent, counts: Readonly<Record<string, number>>) => ({
    at: iso(now()),
    actor,
    event,
    counts,
  });

  const viewOf = (row: IndexRow, data: PersonData): PersonView => ({
    person: row.person,
    kind: row.kind,
    label: data.label,
    role: roleOn(row, actor) ?? "viewer",
    state: row.state,
    rev: row.rev,
    owner: row.owner,
    ...(row.custodian !== undefined ? { custodian: row.custodian } : {}),
    ...(data.describes !== undefined ? { describes: data.describes } : {}),
    ...(data.basis !== undefined ? { basis: data.basis.kind } : {}),
    ...(data.audience !== undefined ? { audience: data.audience } : {}),
    ...(data.synthetic === true ? { synthetic: true as const } : {}),
    offLimits: [...data.offLimits],
    viewers: [...row.viewers],
  });

  const notesOf = async (person: string): Promise<StoredClaim[]> =>
    currentNotes(await vault.readClaims<StoredClaim>(person));

  /** The profile among the actor's own that holds note `claim`, with that row. */
  const noteRow = (claim: string, permission: string): IndexRow | Refused => {
    if (!isId("pcl", claim)) return NOT_FOUND;
    const mine = vault.rows().filter((row) => authorizePerson(row, actor, permission).allow);
    const person = vault.findClaim(
      claim,
      mine.map((row) => row.person),
    );
    const row = mine.find((r) => r.person === person);
    return row ?? NOT_FOUND;
  };

  const rejectedHit = async (person: string, area: string, value: string) => {
    const fp = await vault.fingerprint(person, area, value);
    const entry = (await vault.readRejected(person)).find((e) => e.fp === fp);
    return { fp, entry };
  };

  const rejectedRefusal = (claim: string): Refused =>
    refused(
      "precondition_failed",
      "rejected-before",
      `You rejected this note before. To use it again: \`crewhaus people review ${claim} --as reopen\`.`,
    );

  // -------------------------------------------------------------------------
  // The vault
  // -------------------------------------------------------------------------

  const vaultState = async (): Promise<Answer<VaultStateView>> => {
    const status = await vault.status();
    switch (status.state) {
      case "not-set-up":
        return { ok: true, value: { state: "not-set-up" } };
      case "unreadable":
        return { ok: true, value: { state: "locked", reason: status.reason } };
      case "locked":
        return {
          ok: true,
          value: {
            state: "locked",
            custody: status.custody,
            kekVersion: status.kekVersion,
            reason: status.reason,
          },
        };
      case "ready":
        return {
          ok: true,
          value: {
            state: "ready",
            custody: status.custody,
            kekVersion: status.kekVersion,
            ...(status.backupDays !== undefined ? { backupDays: status.backupDays } : {}),
          },
        };
    }
  };

  const setup = (input: {
    readonly custody: VaultCustody;
    readonly backupDays?: number;
  }): Promise<Answer<{ readonly created: boolean; readonly state: VaultStateView }>> =>
    guarded(async () => {
      if (
        input.backupDays !== undefined &&
        (!Number.isInteger(input.backupDays) || input.backupDays < 1 || input.backupDays > 3650)
      ) {
        return refused("invalid", "invalid", "Backup days is a whole number from 1 to 3650.");
      }
      const status = await vault.status();
      const body = {
        custody: input.custody,
        ...(input.backupDays !== undefined ? { backupDays: input.backupDays } : {}),
      };
      if (status.state === "ready" || status.state === "locked") {
        if (status.custody !== input.custody) {
          return refused(
            "conflict",
            "custody-fixed",
            `Profiles are already set up, with the key kept in ${status.custody} custody.`,
          );
        }
        const current = status.state === "ready" ? status.backupDays : undefined;
        if (input.backupDays === undefined || input.backupDays === current) {
          const state = await vaultState();
          return {
            ok: true,
            value: { created: false, state: (state as Done<VaultStateView>).value },
          };
        }
        if (status.state === "locked") {
          return refused("unavailable", "locked", LOCKED_MESSAGE, { detail: status.reason });
        }
        return command({ kind: "people.vault.setup", body }, async () => {
          await vault.write(async (w) => w.setBackupDays(input.backupDays));
          const state = await vaultState();
          return {
            value: { created: false, state: (state as Done<VaultStateView>).value },
            effects: [{ kind: "policy", status: "done" }],
          };
        });
      }
      if (status.state === "unreadable") {
        return refused("unavailable", "unreadable", "The profiles can't be read.", {
          detail: status.reason,
        });
      }
      return command({ kind: "people.vault.setup", body }, async () => {
        const made = await vault.setUp({
          custody: input.custody,
          owner: actor,
          ...(input.backupDays !== undefined ? { backupDays: input.backupDays } : {}),
        });
        const state = await vaultState();
        return {
          value: { created: made.created, state: (state as Done<VaultStateView>).value },
          effects: [{ kind: "vault", status: made.created ? "done" : "skipped" }],
        };
      });
    });

  const rotateKeys = (
    newKeyHex?: string,
  ): Promise<
    Answer<{ readonly kekVersion: number; readonly oldKey: string; readonly resumed: boolean }>
  > =>
    guarded(async () => {
      const status = await ready();
      if (!("state" in status)) return status;
      if (status.custody === "environment" && newKeyHex === undefined) {
        return refused(
          "precondition_failed",
          "space-key-not-rotated",
          "Under environment custody the new key comes from you: pipe 64 hex characters into `crewhaus people keys --rotate`.",
        );
      }
      return command({ kind: "people.vault.rotate", body: {} }, async () => {
        const rotated = await vault.write((w) =>
          w.rotateSpaceKey(newKeyHex !== undefined ? { newKeyHex } : {}),
        );
        if (!rotated.rotated) {
          return refused(
            "precondition_failed",
            "space-key-not-rotated",
            "The key was not rotated.",
          );
        }
        return {
          value: {
            kekVersion: rotated.kekVersion,
            oldKey: rotated.oldKey,
            resumed: rotated.resumed,
          },
          effects: [
            { kind: "space-key", status: "done", observed: `version ${rotated.kekVersion}` },
          ],
        };
      });
    });

  // -------------------------------------------------------------------------
  // Profiles
  // -------------------------------------------------------------------------

  const listPersons = (): Promise<Answer<readonly PersonRow[]>> =>
    guarded(async () => {
      const status = await ready();
      if (!("state" in status)) return status;
      const out: PersonRow[] = [];
      for (const row of vault.rows()) {
        const role = roleOn(row, actor);
        if (role === undefined) continue;
        if (row.state === "erasing") {
          out.push({
            person: row.person,
            kind: row.kind,
            label: "",
            role,
            state: row.state,
            rev: row.rev,
          });
          continue;
        }
        const { data } = await vault.readPerson<PersonData>(row.person);
        out.push({
          person: row.person,
          kind: row.kind,
          label: data.label,
          role,
          state: row.state,
          rev: row.rev,
        });
      }
      return { ok: true, value: out };
    });

  const createPerson = (input: PersonCreateRequest): Promise<Answer<{ readonly person: string }>> =>
    guarded(async () => {
      const status = await ready();
      if (!("state" in status)) return status;
      if (!authorizeSpace({ owner: status.owner }, actor, "people.space.use")) {
        return refused(
          "forbidden",
          "space",
          "Only the person who set up profiles here can add one.",
        );
      }
      const label = typeof input.label === "string" ? input.label.trim() : "";
      if (!textOk(label, PERSON_LABEL_MAX)) {
        return refused(
          "invalid",
          "label",
          `A profile needs a name of 1 to ${PERSON_LABEL_MAX} characters.`,
        );
      }
      const at = iso(now());
      let data: PersonData = {
        v: 1,
        label,
        kind: input.kind,
        offLimits: [],
        viewers: [],
        createdAt: at,
        updatedAt: at,
      };
      let custodian: string | undefined;
      let basisKind: CustodialBasis | undefined;
      switch (input.kind) {
        case "personal": {
          const describes = input.describes ?? "self";
          if (
            input.who !== undefined ||
            input.variation !== undefined ||
            input.size !== undefined
          ) {
            return refused(
              "invalid",
              "kind-fields",
              "Who, variation and size describe a group profile.",
            );
          }
          if (describes === "someone-else") {
            if (!oneOf(CUSTODIAL, input.basis)) {
              return refused(
                "invalid",
                "basis-required",
                "A profile about someone else needs a basis: custodian (you're their guardian or carer), consent (they asked you to and agreed) or contract (it's part of an agreement with them).",
              );
            }
            basisKind = input.basis as CustodialBasis;
            custodian = actor;
            data = {
              ...data,
              describes,
              basis: { kind: basisKind, recordedAt: at, recordedBy: actor },
            };
          } else if (describes === "self") {
            if (input.basis !== undefined) {
              return refused("invalid", "basis", "A profile about yourself takes no basis.");
            }
            data = { ...data, describes };
          } else {
            return refused(
              "invalid",
              "describes",
              "A personal profile describes self or someone-else.",
            );
          }
          break;
        }
        case "audience": {
          const who = typeof input.who === "string" ? input.who.trim() : "";
          if (!textOk(who, AUDIENCE_WHO_MAX)) {
            return refused("invalid", "who", "A group profile says who is in the group.");
          }
          if (!oneOf(AUDIENCE, input.basis)) {
            return refused(
              "invalid",
              "basis-required",
              "A group profile says how you know: survey, usage, interviews or assumption.",
            );
          }
          if (!oneOf(AUDIENCE_VARIATIONS, input.variation)) {
            return refused(
              "invalid",
              "variation",
              "A group profile says how much its people differ: uniform, mixed or unknown.",
            );
          }
          if (input.size !== undefined && (!Number.isInteger(input.size) || input.size < 1)) {
            return refused("invalid", "size", "A group's size is a whole number above zero.");
          }
          if (input.describes !== undefined) {
            return refused("invalid", "describes", "Only a personal profile describes someone.");
          }
          data = {
            ...data,
            audience: {
              who,
              basis: input.basis as AudienceView["basis"],
              variation: input.variation,
              ...(input.size !== undefined ? { size: input.size } : {}),
            },
          };
          break;
        }
        case "synthetic": {
          if (
            input.basis !== undefined ||
            input.who !== undefined ||
            input.describes !== undefined ||
            input.variation !== undefined ||
            input.size !== undefined
          ) {
            return refused("invalid", "kind-fields", "A made-up persona takes only a name.");
          }
          data = { ...data, synthetic: true };
          break;
        }
        default:
          return refused("invalid", "kind", "A profile's kind is personal, audience or synthetic.");
      }
      const person = mintId("psn");
      const body = { ...input };
      return command(
        {
          kind: "people.persons.create",
          target: target(person),
          body,
          secretFields: ["label", "who"],
        },
        async () => {
          await vault.write(async (w) => {
            await w.createPerson({
              person,
              kind: input.kind,
              owner: actor,
              ...(custodian !== undefined ? { custodian } : {}),
              ...(basisKind !== undefined ? { basisKind } : {}),
              data,
            });
            w.appendActivity(person, activity("person.created", {}));
          });
          return {
            value: { person },
            effects: [{ kind: "vault", ref: target(person), status: "done" }],
          };
        },
      );
    });

  const getPerson = (person: string): Promise<Answer<PersonView>> =>
    guarded(async () => {
      const status = await ready();
      if (!("state" in status)) return status;
      const row = rowFor(person, "people.person.read");
      if ("ok" in row) return row;
      if (row.state === "erasing") return erasing(row);
      const { data } = await vault.readPerson<PersonData>(person);
      return { ok: true, value: viewOf(row, data) };
    });

  const updatePerson = (
    person: string,
    patch: PersonPatch,
    expectRev: number,
  ): Promise<Answer<{ readonly rev: number }>> =>
    guarded(async () => {
      const status = await ready();
      if (!("state" in status)) return status;
      const row = rowFor(person, "people.person.write");
      if ("ok" in row) return row;
      if (row.state === "erasing") return erasing(row);
      if (Object.hasOwn(patch, "kind")) {
        return refused("invalid", "kind-fixed", "A profile's kind never changes.");
      }
      const areas = [...(patch.offLimits ?? []), ...(patch.allow ?? [])];
      if (areas.some((area) => !NOTE_AREA_RE.test(area))) {
        return refused("invalid", "area", "An area is a short lowercase word, like communication.");
      }
      const people = [...(patch.viewers ?? []), ...(patch.removeViewers ?? [])];
      if (people.some((p) => !isId("prn", p))) {
        return refused("invalid", "viewer", "A viewer is a member's id (prn_…).");
      }
      const label = patch.label?.trim();
      if (label !== undefined && !textOk(label, PERSON_LABEL_MAX)) {
        return refused(
          "invalid",
          "label",
          `A profile needs a name of 1 to ${PERSON_LABEL_MAX} characters.`,
        );
      }
      const { data } = await vault.readPerson<PersonData>(person);
      if (row.rev !== expectRev) {
        return refused(
          "conflict",
          "stale_person_revision",
          "This profile changed since you opened it.",
          {
            current: viewOf(row, data),
          },
        );
      }
      const offLimits = [...new Set([...data.offLimits, ...(patch.offLimits ?? [])])].filter(
        (area) => !(patch.allow ?? []).includes(area),
      );
      const viewers = [...new Set([...row.viewers, ...(patch.viewers ?? [])])].filter(
        (p) => !(patch.removeViewers ?? []).includes(p) && p !== row.owner,
      );
      const next: PersonData = {
        ...data,
        ...(label !== undefined ? { label } : {}),
        offLimits: offLimits.sort(),
        viewers,
        updatedAt: iso(now()),
      };
      const body = { expect: expectRev, ...patch };
      return command(
        {
          kind: "people.persons.update",
          target: target(person),
          body,
          secretFields: ["label", "offLimits", "allow"],
        },
        async () => {
          const out = await vault.write(async (w) => {
            const updated = await w.updatePerson(person, next, { expectRev, viewers });
            if ("conflict" in updated) return updated;
            w.appendActivity(
              person,
              activity("person.updated", {
                offLimits: next.offLimits.length,
                viewers: viewers.length,
              }),
            );
            return updated;
          });
          if ("conflict" in out) {
            return refused(
              "conflict",
              "stale_person_revision",
              "This profile changed since you opened it.",
            );
          }
          return {
            value: { rev: out.rev },
            effects: [{ kind: "vault", ref: target(person), status: "done" }],
          };
        },
      );
    });

  // -------------------------------------------------------------------------
  // Notes
  // -------------------------------------------------------------------------

  const listClaims = (person: string): Promise<Answer<readonly StoredClaim[]>> =>
    guarded(async () => {
      const status = await ready();
      if (!("state" in status)) return status;
      const row = rowFor(person, "people.person.read");
      if ("ok" in row) return row;
      if (row.state === "erasing") return erasing(row);
      const notes = (await notesOf(person)).filter((note) => note.state !== "superseded");
      return { ok: true, value: notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt)) };
    });

  const addClaim = (
    person: string,
    input: ClaimCreateRequest,
  ): Promise<Answer<{ readonly claim: string; readonly state: StoredClaim["state"] }>> =>
    guarded(async () => {
      const status = await ready();
      if (!("state" in status)) return status;
      const row = rowFor(person, "people.person.write");
      if ("ok" in row) return row;
      if (row.state === "erasing") return erasing(row);
      const value = typeof input.value === "string" ? input.value.trim() : "";
      if (!textOk(value, NOTE_VALUE_MAX)) {
        return refused("invalid", "value", `A note is 1 to ${NOTE_VALUE_MAX} characters.`);
      }
      const situation = input.situation?.trim();
      if (situation !== undefined && situation !== "" && !textOk(situation, NOTE_SITUATION_MAX)) {
        return refused(
          "invalid",
          "situation",
          `A situation is at most ${NOTE_SITUATION_MAX} characters.`,
        );
      }
      if (typeof input.area !== "string" || !NOTE_AREA_RE.test(input.area)) {
        return refused("invalid", "area", "An area is a short lowercase word, like communication.");
      }
      const type = input.type ?? "preference";
      if (!oneOf(NOTE_TYPES, type)) return refused("invalid", "type", "That is not a note type.");
      const purposes = input.purposes ?? PEOPLE_PURPOSES;
      if (purposes.length === 0 || !purposes.every((p) => oneOf(PEOPLE_PURPOSES, p))) {
        return refused("invalid", "purpose", `A purpose is one of: ${PEOPLE_PURPOSES.join(", ")}.`);
      }
      const acquisition = input.acquisition ?? "stated";
      if (!oneOf(NOTE_ACQUISITIONS, acquisition)) {
        return refused("invalid", "acquisition", "A note is stated, observed or inferred.");
      }
      const confidence = input.confidence ?? "high";
      if (!oneOf(NOTE_CONFIDENCES, confidence)) {
        return refused("invalid", "confidence", "Confidence is low, medium or high.");
      }
      if (input.reviewBy !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.reviewBy)) {
        return refused("invalid", "review-by", "A review date is written like 2026-12-31.");
      }
      const special = (SPECIAL_NOTE_TYPES as readonly string[]).includes(type);
      const declared = input.sensitivity;
      if (declared !== undefined && !oneOf(NOTE_SENSITIVITIES, declared)) {
        return refused(
          "invalid",
          "sensitivity",
          "Sensitivity is ordinary, personal, sensitive or special.",
        );
      }
      if (special && declared !== undefined && declared !== "special") {
        return refused(
          "invalid",
          "sensitivity",
          `A ${type} note is special by nature; it can't be kept as ${declared}.`,
        );
      }
      const sensitivity: NoteSensitivity = special ? "special" : (declared ?? "ordinary");
      if (sensitivity === "special" && acquisition !== "stated") {
        return refused(
          "invalid",
          "special-needs-stated",
          "Health, beliefs and other special notes are only ever stated by the person, never observed or inferred.",
        );
      }
      const { data } = await vault.readPerson<PersonData>(person);
      if (data.offLimits.includes(input.area)) {
        return refused(
          "precondition_failed",
          "off-limits",
          `The area ${input.area} is off-limits on this profile.`,
        );
      }
      if (sensitivity === "special" && data.describes === "someone-else") {
        return refused(
          "precondition_failed",
          "needs-consent",
          "A special note about someone else needs their recorded agreement, which can't be recorded yet.",
        );
      }
      const hit = await rejectedHit(person, input.area, value);
      if (hit.entry !== undefined) return rejectedRefusal(hit.entry.claim);
      const id = mintId("pcl");
      const at = iso(now());
      const state =
        SENSITIVE.includes(sensitivity) || acquisition !== "stated" ? "proposed" : "active";
      const claim: StoredClaim = {
        id,
        rev: 0,
        person,
        type,
        area: input.area,
        value,
        ...(situation !== undefined && situation !== "" ? { situation } : {}),
        source: { kind: row.custodian === actor ? "custodian" : "self" },
        acquisition,
        confidence,
        sensitivity,
        state,
        ...(input.reviewBy !== undefined ? { reviewBy: input.reviewBy } : {}),
        purposes: [...new Set(purposes)],
        createdBy: { actor, via },
        createdAt: at,
        at,
      };
      return command(
        {
          kind: "people.claims.create",
          target: target(person),
          body: { ...input },
          secretFields: Object.values(NOTE_FIELDS),
        },
        async () => {
          const out = await vault.write(async (w) => {
            const appended = await w.appendClaimRevision(person, claim, { expectRev: 0 });
            if ("conflict" in appended) return appended;
            w.appendActivity(person, activity("claim.created", { notes: 1 }));
            return appended;
          });
          if ("conflict" in out) return refused("conflict", "exists", "That note id is taken.");
          return {
            value: { claim: id, state },
            effects: [{ kind: "vault", ref: target(person), status: "done", observed: "notes 1" }],
          };
        },
      );
    });

  const reviseClaim = (
    claimId: string,
    input: { readonly value: string; readonly situation?: string },
    expectRev: number,
  ): Promise<Answer<{ readonly rev: number; readonly state: StoredClaim["state"] }>> =>
    guarded(async () => {
      const status = await ready();
      if (!("state" in status)) return status;
      const row = noteRow(claimId, "people.person.write");
      if ("ok" in row) return row;
      const person = row.person;
      const value = typeof input.value === "string" ? input.value.trim() : "";
      if (!textOk(value, NOTE_VALUE_MAX)) {
        return refused("invalid", "value", `A note is 1 to ${NOTE_VALUE_MAX} characters.`);
      }
      const situation = input.situation?.trim();
      if (situation !== undefined && situation !== "" && !textOk(situation, NOTE_SITUATION_MAX)) {
        return refused(
          "invalid",
          "situation",
          `A situation is at most ${NOTE_SITUATION_MAX} characters.`,
        );
      }
      const current = (await notesOf(person)).find((note) => note.id === claimId);
      if (current === undefined) return NOT_FOUND;
      if (current.rev !== expectRev) {
        return refused(
          "conflict",
          "stale_claim_revision",
          "This note changed since you opened it.",
          {
            current,
          },
        );
      }
      if (!(EDITABLE_STATES as readonly string[]).includes(current.state)) {
        return refused(
          "precondition_failed",
          "transition",
          "This note is no longer in use, so it can't be edited. Add a new one instead.",
        );
      }
      const hit = await rejectedHit(person, current.area, value);
      if (hit.entry !== undefined && hit.entry.claim !== claimId)
        return rejectedRefusal(hit.entry.claim);
      // The owner's (or custodian's) own edit keeps the note's state: a proposed note stays
      // proposed until kept, and a kept one stays kept, since the person wrote the new words.
      const state = current.state;
      const { situation: _old, ...rest } = current;
      const next: StoredClaim = {
        ...rest,
        value,
        ...(situation !== undefined && situation !== "" ? { situation } : {}),
        at: iso(now()),
      };
      return command(
        {
          kind: "people.claims.revise",
          target: target(person),
          body: { expect: expectRev, ...input },
          secretFields: ["value", "situation"],
        },
        async () => {
          const out = await vault.write(async (w) => {
            const appended = await w.appendClaimRevision(person, next, { expectRev });
            if ("conflict" in appended) return appended;
            w.appendActivity(person, activity("claim.revised", { notes: 1 }));
            return appended;
          });
          if ("conflict" in out) {
            return refused(
              "conflict",
              "stale_claim_revision",
              "This note changed since you opened it.",
              {
                current: out.current,
              },
            );
          }
          return {
            value: { rev: out.rev, state },
            effects: [{ kind: "vault", ref: target(person), status: "done", observed: "notes 1" }],
          };
        },
      );
    });

  const reviewClaim = (
    claimId: string,
    input: ReviewInput,
  ): Promise<Answer<{ readonly state: StoredClaim["state"]; readonly rev: number }>> =>
    guarded(async () => {
      const status = await ready();
      if (!("state" in status)) return status;
      const row = noteRow(claimId, "people.claim.review");
      if ("ok" in row) return row;
      const person = row.person;
      const notes = await notesOf(person);
      const current = notes.find((note) => note.id === claimId);
      if (current === undefined) return NOT_FOUND;
      const move = (to: StoredClaim["state"]): Refused | undefined =>
        canTransition("personClaim", current.state, to)
          ? undefined
          : refused(
              "precondition_failed",
              "transition",
              `A ${current.state} note can't be ${input.verdict === "keep" ? "kept" : `${input.verdict}ed`}.`,
            );
      let next: StoredClaim;
      let rejectedChange: "add" | "remove" | undefined;
      switch (input.verdict) {
        case "keep": {
          const bad = move("active");
          if (bad !== undefined) return bad;
          next = { ...current, state: "active", confirmedBy: "owner" };
          break;
        }
        case "reject": {
          const bad = move("rejected");
          if (bad !== undefined) return bad;
          const { confirmedBy: _c, ...rest } = current;
          next = { ...rest, state: "rejected" };
          rejectedChange = "add";
          break;
        }
        case "reopen": {
          const bad = move("proposed");
          if (bad !== undefined) return bad;
          next = { ...current, state: "proposed" };
          rejectedChange = "remove";
          break;
        }
        case "narrow": {
          const purposes = input.purposes ?? [];
          if (!(EDITABLE_STATES as readonly string[]).includes(current.state)) {
            return refused(
              "precondition_failed",
              "transition",
              `A ${current.state} note can't be narrowed.`,
            );
          }
          if (purposes.length === 0 || !purposes.every((p) => current.purposes.includes(p))) {
            return refused(
              "invalid",
              "narrow",
              "Narrowing keeps some of the note's own purposes; it never adds one.",
            );
          }
          next = { ...current, purposes: [...new Set(purposes)] };
          break;
        }
        case "merge": {
          const into = notes.find((note) => note.id === input.into);
          if (into === undefined || into.id === claimId) {
            return refused("invalid", "merge", "Merge into another note of the same profile.");
          }
          if (!(EDITABLE_STATES as readonly string[]).includes(into.state)) {
            return refused("precondition_failed", "merge", "That note is no longer in use.");
          }
          const bad = move("superseded");
          if (bad !== undefined) return bad;
          next = { ...current, state: "superseded", mergedInto: into.id };
          break;
        }
        default:
          return refused(
            "invalid",
            "verdict",
            "A review is keep, reject, reopen, narrow or merge.",
          );
      }
      next = { ...next, at: iso(now()) };
      const fp = await vault.fingerprint(person, current.area, current.value);
      return command(
        {
          kind: "people.claims.review",
          target: target(person),
          body: {
            verdict: input.verdict,
            ...(input.purposes !== undefined ? { purposes: input.purposes } : {}),
            ...(input.into !== undefined ? { into: input.into } : {}),
          },
        },
        async () => {
          const out = await vault.write(async (w) => {
            const appended = await w.appendClaimRevision(person, next, { expectRev: current.rev });
            if ("conflict" in appended) return appended;
            if (rejectedChange !== undefined) {
              const entries = await vault.readRejected(person);
              await w.writeRejected(
                person,
                rejectedChange === "add"
                  ? [...entries.filter((e) => e.fp !== fp), { fp, claim: claimId }]
                  : entries.filter((e) => e.claim !== claimId && e.fp !== fp),
              );
            }
            w.appendActivity(person, activity("claim.reviewed", { notes: 1 }));
            return appended;
          });
          if ("conflict" in out) {
            return refused(
              "conflict",
              "stale_claim_revision",
              "This note changed since you opened it.",
              {
                current: out.current,
              },
            );
          }
          return {
            value: { state: next.state, rev: out.rev },
            effects: [{ kind: "vault", ref: target(person), status: "done", observed: "notes 1" }],
          };
        },
      );
    });

  const reviewList = (person: string): Promise<Answer<readonly StoredClaim[]>> =>
    guarded(async () => {
      const listed = await listClaims(person);
      if (!listed.ok) return listed;
      return { ok: true, value: listed.value.filter((note) => note.state === "proposed") };
    });

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  const buildExport = async (person: string, opts: ExportOptions): Promise<ExportBuilt> => {
    const { data } = await vault.readPerson<PersonData>(person);
    const revisions = await vault.readClaims<StoredClaim>(person);
    const notes = currentNotes(revisions);
    const asOf = [data.updatedAt, ...revisions.map((r) => r.at)].sort().at(-1) as string;
    const areas = opts.areas;
    const purposes = opts.purposes;
    const includeSensitive = opts.includeSensitive === true;
    const includeRejected = opts.includeRejected !== false;
    let masked = 0;
    let leftOut = 0;
    const mask = (text: string): string => maskCredentialTokens(text);
    const shape = (note: StoredClaim) => {
      const value = mask(note.value);
      const situation = note.situation !== undefined ? mask(note.situation) : undefined;
      if (value !== note.value || situation !== note.situation) masked += 1;
      return {
        area: note.area,
        type: note.type,
        value,
        ...(situation !== undefined ? { situation } : {}),
        purposes: [...note.purposes],
        sensitivity: note.sensitivity,
        confidence: note.confidence,
        acquisition: note.acquisition,
        state: note.state,
        at: note.at,
      };
    };
    const chosen = notes
      .filter((note) => note.state !== "superseded")
      .filter((note) => areas === undefined || areas.includes(note.area))
      .filter((note) => purposes === undefined || note.purposes.some((p) => purposes.includes(p)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const kept: ReturnType<typeof shape>[] = [];
    const rejected: ReturnType<typeof shape>[] = [];
    for (const note of chosen) {
      if (SENSITIVE.includes(note.sensitivity) && !includeSensitive) {
        leftOut += 1;
        continue;
      }
      if (note.state === "rejected") {
        if (includeRejected) rejected.push(shape(note));
        continue;
      }
      kept.push(shape(note));
    }
    const label = mask(data.label);
    const audience =
      data.audience === undefined ? undefined : { ...data.audience, who: mask(data.audience.who) };
    const document = {
      format: PEOPLE_EXPORT_FORMAT,
      asOf,
      person: {
        kind: data.kind,
        label,
        ...(data.describes !== undefined ? { describes: data.describes } : {}),
        ...(audience !== undefined ? { audience } : {}),
        offLimits: [...data.offLimits],
      },
      notes: kept,
      rejected,
    };
    const text = `${canonicalJson(document)}\n`;
    const bytes = new TextEncoder().encode(text);
    const preview: ExportPreview = {
      format: PEOPLE_EXPORT_FORMAT,
      counts: { notes: kept.length, rejected: rejected.length, masked, leftOut },
      sha256: await sha256Hex(bytes),
      bytes: bytes.length,
    };
    const summary = [
      `${label} (${data.kind === "audience" ? "group" : data.kind === "synthetic" ? "made-up persona" : "personal"})`,
      `As of ${asOf.slice(0, 10)}.`,
      "",
      ...(kept.length === 0
        ? ["No notes."]
        : kept.map(
            (n) =>
              `- [${n.area}] ${n.value}${n.situation !== undefined ? ` (when ${n.situation})` : ""}`,
          )),
      ...(rejected.length > 0
        ? [
            "",
            "Rejected, kept so they stay rejected:",
            ...rejected.map((n) => `- [${n.area}] ${n.value}`),
          ]
        : []),
      "",
    ].join("\n");
    return { preview, text, summary };
  };

  const exportChecks = (opts: ExportOptions): Refused | undefined => {
    if ((opts.areas ?? []).some((area) => !NOTE_AREA_RE.test(area))) {
      return refused("invalid", "area", "An area is a short lowercase word, like communication.");
    }
    if ((opts.purposes ?? []).some((p) => !oneOf(PEOPLE_PURPOSES, p))) {
      return refused("invalid", "purpose", `A purpose is one of: ${PEOPLE_PURPOSES.join(", ")}.`);
    }
    return undefined;
  };

  const previewExport = (person: string, opts: ExportOptions = {}): Promise<Answer<ExportBuilt>> =>
    guarded(async () => {
      const status = await ready();
      if (!("state" in status)) return status;
      const row = rowFor(person, "people.export");
      if ("ok" in row) return row;
      if (row.state === "erasing") return erasing(row);
      const bad = exportChecks(opts);
      if (bad !== undefined) return bad;
      return { ok: true, value: await buildExport(person, opts) };
    });

  const writeExport = (
    person: string,
    opts: ExportOptions = {},
    out: { readonly path?: string; readonly force?: boolean } = {},
  ): Promise<Answer<ExportBuilt & { readonly written?: readonly string[] }>> =>
    guarded(async () => {
      const status = await ready();
      if (!("state" in status)) return status;
      const row = rowFor(person, "people.export");
      if ("ok" in row) return row;
      if (row.state === "erasing") return erasing(row);
      const bad = exportChecks(opts);
      if (bad !== undefined) return bad;
      const targets: string[] = [];
      if (out.path !== undefined) {
        const path = resolve(out.path);
        targets.push(path);
        if (opts.summary === true) targets.push(`${path}.txt`);
        for (const file of targets) {
          if (!existsSync(dirname(file))) {
            return refused("invalid", "out", `The folder ${dirname(file)} does not exist.`);
          }
          let present = false;
          try {
            lstatSync(file);
            present = true;
          } catch {
            // Nothing there.
          }
          if (present && out.force !== true) {
            return refused(
              "conflict",
              "exists",
              `${file} already exists. Add --force to replace it.`,
            );
          }
        }
      }
      const built = await buildExport(person, opts);
      const counts = {
        notes: built.preview.counts.notes,
        rejected: built.preview.counts.rejected,
        masked: built.preview.counts.masked,
      };
      return command(
        {
          kind: "people.exports.create",
          target: target(person),
          body: { ...opts },
          secretFields: ["areas"],
        },
        async () => {
          const contents = [built.text, built.summary];
          for (const [i, file] of targets.entries()) {
            const written = writeFileSafe(dirname(file), basename(file), contents[i] as string, {
              overwrite: out.force === true,
              mode: 0o600,
            });
            if (!written.ok) return refused("invalid", "out", written.reason);
          }
          await vault.write(async (w) => {
            w.appendExport(person, {
              pex: mintId("pex"),
              at: iso(now()),
              by: actor,
              counts,
              sha256: built.preview.sha256,
            });
            w.appendActivity(person, activity("export.created", counts));
          });
          return {
            value: { ...built, ...(targets.length > 0 ? { written: targets } : {}) },
            effects: [
              { kind: "export", ref: target(person), status: "done", observed: countsText(counts) },
            ],
          };
        },
      );
    });

  // -------------------------------------------------------------------------
  // Activity
  // -------------------------------------------------------------------------

  const activityOf = (
    person: string,
    opts: { readonly limit?: number } = {},
  ): Promise<Answer<{ readonly items: readonly PersonActivityRow[]; readonly more: boolean }>> =>
    guarded(async () => {
      const status = await ready();
      if (!("state" in status)) return status;
      const row = rowFor(person, "people.activity.read");
      if ("ok" in row) return row;
      if (row.state === "erasing") return erasing(row);
      const limit = Math.max(1, Math.min(opts.limit ?? 20, 500));
      const read = vault.readActivity(person, limit);
      const items = read.rows.map(
        (r): PersonActivityRow => ({
          at: r.at,
          actor: r.actor,
          event: r.event as PersonActivityEvent,
          counts: r.counts,
        }),
      );
      return { ok: true, value: { items, more: read.more } };
    });

  // -------------------------------------------------------------------------
  // Erasure
  // -------------------------------------------------------------------------

  const residueOf = (
    person: string,
    custody: VaultCustody,
    days: number | undefined,
  ): ErasureResidue[] => {
    const out: ErasureResidue[] = vault
      .readExports(person)
      .map((row) => ({ code: "downloaded-export" as const, at: row.at }));
    out.push(
      days !== undefined
        ? { code: "backups", until: dayOf(now() + days * 86_400_000) }
        : { code: "backups-unknown" },
    );
    if (custody === "environment") out.push({ code: "space-key-not-rotated" });
    return out;
  };

  const planErasure = (
    person: string,
  ): Promise<Answer<ErasurePlanView & { readonly resuming: boolean }>> =>
    guarded<ErasurePlanView & { readonly resuming: boolean }>(async () => {
      const status = await ready();
      if (!("state" in status)) return status;
      const row = rowFor(person, "people.erase");
      if ("ok" in row) return row;
      const expiresAt = now() + ERASURE_NONCE_TTL_MS;
      if (row.state === "erasing" && row.erasure !== undefined) {
        return {
          ok: true,
          value: {
            person,
            counts: row.erasure.removed,
            residue: row.erasure.residue,
            nonce: await vault.erasureNonce(person, row.erasure.inventoryDigest, expiresAt),
            expiresAt: iso(expiresAt),
            resuming: true,
          },
        };
      }
      const inventory = await vault.inventory(person);
      const counts: ErasureCounts = {
        notes: inventory.notes,
        revisions: inventory.revisions,
        rejected: inventory.rejected,
        exports: inventory.exports,
      };
      return {
        ok: true,
        value: {
          person,
          counts,
          residue: residueOf(person, status.custody, status.backupDays),
          nonce: await vault.erasureNonce(person, inventory.digest, expiresAt),
          expiresAt: iso(expiresAt),
          resuming: false,
        },
      };
    });

  const runErasure = (
    person: string,
    input: { readonly nonce: string; readonly confirm: string },
  ): Promise<
    Answer<{
      readonly per: string;
      readonly removed: ErasureCounts;
      readonly residue: readonly ErasureResidue[];
      readonly rotated: boolean;
    }>
  > =>
    guarded(async () => {
      const status = await ready();
      if (!("state" in status)) return status;
      const row = rowFor(person, "people.erase");
      if ("ok" in row) return row;
      const body = { nonce: input.nonce, confirm: input.confirm };
      const run = (mark: NonNullable<IndexRow["erasure"]>, fresh: boolean) =>
        command(
          { kind: "people.erasure.run", target: target(person), body, secretFields: ["confirm"] },
          async () => {
            const outcome = await vault.write(async (w) => {
              if (fresh) {
                const again = await vault.inventory(person);
                if (again.digest !== mark.inventoryDigest) return "changed" as const;
                w.markErasing(person, mark);
              }
              return w.eraseMarked(person);
            });
            if (outcome === "changed") {
              return refused(
                "precondition_failed",
                "inventory-changed",
                "The profile changed since the dry run. Nothing was erased; run the dry run again.",
              );
            }
            const rotated = outcome.rotation !== "skipped" && outcome.rotation.rotated;
            return {
              value: { per: mark.per, removed: mark.removed, residue: mark.residue, rotated },
              effects: [
                {
                  kind: "vault",
                  ref: target(person),
                  status: "done",
                  observed: countsText(mark.removed),
                },
                { kind: "space-key", status: rotated ? "done" : "skipped" },
                ...mark.residue.map((r) => ({
                  kind: "residue",
                  status: "skipped" as const,
                  note: r.code,
                })),
              ],
            };
          },
        );
      if (row.state === "erasing" && row.erasure !== undefined) return run(row.erasure, false);
      const inventory = await vault.inventory(person);
      const check = await vault.checkErasureNonce(person, inventory.digest, input.nonce);
      if (check === "expired") {
        return refused(
          "precondition_failed",
          "expired",
          "The dry run is more than 10 minutes old. Nothing was erased; run it again.",
        );
      }
      if (check === "changed") {
        return refused(
          "precondition_failed",
          "inventory-changed",
          "The profile changed since the dry run. Nothing was erased; run the dry run again.",
        );
      }
      const { data } = await vault.readPerson<PersonData>(person);
      if (input.confirm.normalize("NFC").trim() !== data.label.normalize("NFC").trim()) {
        return refused(
          "precondition_failed",
          "wrong-name",
          "That isn't the profile's name. Nothing was erased.",
        );
      }
      const mark = {
        per: mintId("per"),
        by: actor,
        at: iso(now()),
        kekTarget: status.custody === "environment" ? status.kekVersion : status.kekVersion + 1,
        inventoryDigest: inventory.digest,
        removed: {
          notes: inventory.notes,
          revisions: inventory.revisions,
          rejected: inventory.rejected,
          exports: inventory.exports,
        },
        residue: residueOf(person, status.custody, status.backupDays),
      };
      return run(mark, true);
    });

  return {
    actor,
    setup,
    vaultState,
    rotateKeys,
    listPersons,
    createPerson,
    getPerson,
    updatePerson,
    listClaims,
    addClaim,
    reviseClaim,
    reviewClaim,
    reviewList,
    previewExport,
    writeExport,
    activity: activityOf,
    planErasure,
    runErasure,
  };
}
