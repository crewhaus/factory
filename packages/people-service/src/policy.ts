/**
 * Who may do what with a profile (#521, part 12): a pure function over one index row.
 * No workspace role implies anything here: a Home owner who is not a profile's owner,
 * custodian or named viewer holds nothing on it.
 */
import type { CustodialBasis } from "@crewhaus/control-contract";
import type { IndexRow } from "@crewhaus/people/vault";

/** The permissions decided on one profile. `people.space.use` is decided on the space. */
export const PERSON_PERMISSIONS = [
  "people.person.read",
  "people.person.write",
  "people.claim.review",
  "people.grant.manage",
  "people.export",
  "people.activity.read",
  "people.erase",
  "people.derived.read",
] as const;

export type PersonPermission = (typeof PERSON_PERMISSIONS)[number];

/**
 * What a custodian may not do, by the basis they keep the profile on. A guardian or carer
 * acts for the person. Someone keeping a profile with the person's agreement, or under an
 * agreement with them, keeps it, and makes no copy of it. Erasing is never withheld from
 * whoever keeps a profile: one nobody may remove is worse than one removed. A row with no
 * basis it can name withholds export and erasure both.
 */
export const CUSTODIAN_WITHHELD: Readonly<Record<CustodialBasis, readonly PersonPermission[]>> = {
  custodian: [],
  consent: ["people.export"],
  contract: ["people.export"],
};

const UNKNOWN_BASIS: readonly PersonPermission[] = ["people.export", "people.erase"];

export type PersonVerdict =
  | { readonly allow: true; readonly as: "owner" | "custodian" | "viewer" }
  | { readonly allow: false };

/** Whether `principal` holds `permission` on the profile `entry` describes. */
export function authorizePerson(
  entry: Pick<IndexRow, "owner" | "custodian" | "basisKind" | "viewers">,
  principal: string,
  permission: string,
): PersonVerdict {
  if (!(PERSON_PERMISSIONS as readonly string[]).includes(permission)) return { allow: false };
  const wanted = permission as PersonPermission;
  if (entry.custodian !== undefined && entry.custodian === principal) {
    const withheld =
      entry.basisKind !== undefined && Object.hasOwn(CUSTODIAN_WITHHELD, entry.basisKind)
        ? CUSTODIAN_WITHHELD[entry.basisKind]
        : UNKNOWN_BASIS;
    return withheld.includes(wanted) ? { allow: false } : { allow: true, as: "custodian" };
  }
  if (entry.owner === principal) return { allow: true, as: "owner" };
  if (entry.viewers.includes(principal) && wanted === "people.person.read") {
    return { allow: true, as: "viewer" };
  }
  return { allow: false };
}

/** Whether `principal` may add profiles to a space: only the space's owner, in this release. */
export function authorizeSpace(
  space: { readonly owner: string },
  principal: string,
  permission: string,
): boolean {
  return permission === "people.space.use" && space.owner === principal;
}

/** The role `principal` has on a profile, for listing; `undefined` when none. */
export function roleOn(
  entry: Pick<IndexRow, "owner" | "custodian" | "viewers">,
  principal: string,
): "owner" | "custodian" | "viewer" | undefined {
  if (entry.custodian === principal) return "custodian";
  if (entry.owner === principal) return "owner";
  if (entry.viewers.includes(principal)) return "viewer";
  return undefined;
}
