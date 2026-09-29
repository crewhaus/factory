/**
 * `crewhaus permissions suggest` writes its proposals to
 * `.crewhaus/settings.json`. The engine reads rule sources in order — flag,
 * settings, spec (yaml), hooks, builtin — and the first rule that matches a
 * call decides it. So an allow added to settings decides every call it covers
 * before the spec's own deny and ask rules, or the builtin floor's asks, are
 * read: `alwaysAllow RemovePath` in settings turns off the spec's
 * `alwaysDeny RemovePath(.git/**)` (permission-integration#8).
 *
 * This finds, for one proposed allow, the lower-source deny and ask rules it
 * would decide ahead of, so the proposal can say so. Pure.
 */
import { join } from "node:path";
import type { PermissionRule } from "@crewhaus/permission-engine";
import {
  type OperativeValue,
  type OperativeValueKind,
  compilePattern,
  matchesPattern,
  matchesToolName,
} from "@crewhaus/tool-permission-matcher";

/** A proposed allow: the tool, and the one value it is scoped to, if any. */
export type ProposedAllow = {
  readonly toolName: string;
  /** Absent: the allow is bare, and covers every call of the tool. */
  readonly scopedValue?: string;
  /** The kind of `scopedValue`, when the tool declares one. */
  readonly valueKind?: OperativeValueKind;
  /**
   * The defaults of the tool's relocating fields (`relocates`: a store
   * directory, a fixed service). A scoped allow covers the calls that leave
   * those fields out, and such a call acts at the default — so a guard on
   * the default is overridden as well: settings `alwaysAllow KvDelete(prod/*)`
   * decides `{namespace: "prod", key}` before the spec's
   * `alwaysDeny KvDelete(.crewhaus/state/**)` is read.
   */
  readonly relocatingDefaults?: ReadonlyArray<{
    readonly kind: OperativeValueKind;
    readonly value: string;
  }>;
};

/** One value as a guard compares it, a relative path also resolved against `cwd`. */
function valueAt(kind: OperativeValueKind, value: string, cwd: string): OperativeValue {
  return {
    kind,
    canonical: kind === "path" && !value.startsWith("/") ? [value, join(cwd, value)] : [value],
  };
}

/**
 * The deny and ask rules in `lower` that a settings-layer allow would decide
 * ahead of, for some call it covers. A bare allow covers every call, so any
 * guard naming the tool is overridden. A scoped allow covers the calls that
 * act on its one value, so a guard is overridden when it fires on that value
 * — or on a relocating field's default, where those calls act when they
 * leave the field out.
 * A guard the matcher cannot read counts too: the engine treats it as
 * matching, and the allow would now be read before it.
 */
export function guardsOverridden(
  allow: ProposedAllow,
  lower: ReadonlyArray<PermissionRule>,
  cwd: string,
): PermissionRule[] {
  const out: PermissionRule[] = [];
  for (const rule of lower) {
    if (rule.type === "alwaysAllow") continue;
    let compiled: ReturnType<typeof compilePattern>;
    try {
      compiled = compilePattern(rule.pattern);
    } catch {
      out.push(rule);
      continue;
    }
    if (!matchesToolName(compiled, allow.toolName)) continue;
    if (allow.scopedValue === undefined) {
      out.push(rule);
      continue;
    }
    const value = allow.scopedValue;
    const operative: OperativeValue[] | undefined =
      allow.valueKind === undefined
        ? undefined
        : [
            valueAt(allow.valueKind, value, cwd),
            ...(allow.relocatingDefaults ?? []).map((d) => valueAt(d.kind, d.value, cwd)),
          ];
    const fires = matchesPattern(
      compiled,
      allow.toolName,
      { value },
      {
        polarity: "restrict",
        ...(operative !== undefined ? { operativeValues: operative } : {}),
      },
    );
    if (fires) out.push(rule);
  }
  return out;
}

/** The evidence line for one overridden guard. */
export function overrideNote(guard: PermissionRule, specLabel: string): string {
  const where = guard.source === "builtin" ? "the builtin floor" : specLabel;
  return `OVERRIDES ${guard.type} ${guard.pattern} (${where}): settings rules are read first, so the calls this allows would no longer reach that rule`;
}
