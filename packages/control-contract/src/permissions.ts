/**
 * The permission vocabulary and the role matrix, as data. Deciding whether a
 * principal holds a permission belongs to access-control; a role holds everything
 * the role below it holds, and a permission with floor `none` is in no role.
 */
import { MODULES, type ModuleField } from "./areas/index.js";
import type { PermissionDecl, Role } from "./areas/types.js";
import { deepFreeze } from "./util.js";

export type { PermissionDecl, Role } from "./areas/types.js";

export const ROLES = deepFreeze([
  "viewer",
  "operator",
  "maintainer",
  "owner",
] as const satisfies readonly Role[]);

type PermissionRow = ModuleField<"permissions"> extends readonly (infer Row)[] ? Row : never;

export type Permission = PermissionRow extends { readonly id: infer I } ? I : never;

const DECLS: readonly PermissionDecl[] = MODULES.flatMap((module) => module.permissions);

/** Every permission, the union of the composed modules. */
export const PERMISSIONS: readonly Permission[] = deepFreeze(
  DECLS.map((decl) => decl.id) as Permission[],
);

export const PERMISSION_DECLS: Readonly<Record<Permission, PermissionDecl>> = deepFreeze(
  Object.fromEntries(DECLS.map((decl) => [decl.id, decl])) as Record<Permission, PermissionDecl>,
);

export const PERMISSION_SCOPE: Readonly<Record<Permission, "home" | "harness">> = deepFreeze(
  Object.fromEntries(DECLS.map((decl) => [decl.id, decl.scope])) as Record<
    Permission,
    "home" | "harness"
  >,
);

function holdsFloor(role: Role, floor: PermissionDecl["floor"]): boolean {
  return floor !== "none" && ROLES.indexOf(role) >= ROLES.indexOf(floor);
}

/** What each role holds, cumulative from each permission's floor. */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = deepFreeze(
  Object.fromEntries(
    ROLES.map((role) => [
      role,
      DECLS.filter((decl) => holdsFloor(role, decl.floor)).map((decl) => decl.id),
    ]),
  ) as Record<Role, Permission[]>,
);

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
}
