/**
 * The shape of one row in the generated builtin-tool manifest.
 *
 * These are the fields a person needs to recognise a tool they are not
 * running: what it is called in a spec, what it is called in a session log,
 * what it does, and the flags that say how much it can reach. Nothing here
 * is a decision about whether a harness may have the tool — it is a
 * description of a tool that exists, so an operator can see what the agent
 * is missing.
 */
/**
 * One field a permission rule's argument pattern is checked against — a copy
 * of `OperativeArg` from `@crewhaus/tool-catalog`, repeated here so this
 * package stays dependency-free.
 */
export type RegistryOperativeArg = {
  readonly field: string;
  /** `path` | `url` | `command` | `recipient` | `text` | `id`. */
  readonly kind: string;
  readonly default?: string;
  readonly within?: string;
};

export type RegistryEntry = {
  /** The camelCase key a spec writes in `tools:`. */
  readonly key: string;
  /** The RegisteredTool's PascalCase `.name` — what session logs record. */
  readonly name: string;
  /** The tool's own description, verbatim from its `RegisteredTool`. */
  readonly description: string;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly scope: string;
  /** Absent when the tool declares no boundary crossing. */
  readonly ioCapability?: string;
  readonly requiresSandbox: boolean;
  readonly requireJustification: boolean;
  /**
   * The field(s) a permission rule's argument pattern is about. Absent when
   * the tool declares none; `[]` when it says no argument decides where it
   * acts.
   */
  readonly operativeArgs?: ReadonlyArray<RegistryOperativeArg>;
  /** Leaf category first, then every roll-up that reaches it. */
  readonly categories: ReadonlyArray<string>;
  /** The `@crewhaus/tool-*` package that exports it. */
  readonly package: string;
  /** The `tools suggest` keyword table's entry for this key. */
  readonly keywords: ReadonlyArray<string>;
};

/**
 * The one place a `RegistryEntry` is built.
 *
 * The generator and the staleness check in `apps/cli/src/tool-registry.test.ts`
 * both call this, which is the point: the check compares DATA against a fresh
 * projection rather than comparing two hand-written projections that could
 * drift apart and agree with each other while both were wrong.
 *
 * The tool is taken structurally so this file stays dependency-free — the
 * same posture `@crewhaus/tool-categories` keeps, and for the same reason:
 * the compiler reaches this package and codegen has to stay offline.
 */
export function projectRegistryEntry(args: {
  readonly key: string;
  readonly tool: {
    readonly name: string;
    readonly description: string;
    readonly readOnly: boolean;
    readonly destructive: boolean;
    readonly scope: string;
    readonly ioCapability?: string;
    readonly requiresSandbox: boolean;
    readonly requireJustification: boolean;
    readonly operativeArgs?: ReadonlyArray<RegistryOperativeArg>;
  };
  readonly categories: ReadonlyArray<string>;
  readonly package: string;
  readonly keywords: ReadonlyArray<string>;
}): RegistryEntry {
  const { key, tool, categories, keywords } = args;
  // Field order is fixed here so a JSON round-trip of two projections can be
  // compared byte for byte.
  return {
    key,
    name: tool.name,
    description: tool.description,
    readOnly: tool.readOnly,
    destructive: tool.destructive,
    scope: tool.scope,
    ...(tool.ioCapability !== undefined ? { ioCapability: tool.ioCapability } : {}),
    requiresSandbox: tool.requiresSandbox,
    requireJustification: tool.requireJustification,
    ...(tool.operativeArgs !== undefined
      ? { operativeArgs: tool.operativeArgs.map(projectOperativeArg) }
      : {}),
    categories: [...categories],
    package: args.package,
    keywords: [...keywords],
  };
}

/** Fixed field order, so two projections compare byte for byte. */
function projectOperativeArg(arg: RegistryOperativeArg): RegistryOperativeArg {
  return {
    field: arg.field,
    kind: arg.kind,
    ...(arg.default !== undefined ? { default: arg.default } : {}),
    ...(arg.within !== undefined ? { within: arg.within } : {}),
  };
}

/**
 * The part of a {@link RegistryEntry} that decides how a tool is gated: its
 * names, its flags and what a permission rule reads. No description, so a
 * bundle that only needs to reason about permissions (`PermissionAudit`,
 * `crewhaus permissions suggest`) carries a small table rather than every
 * tool's prose. `src/flags.ts` is generated from the same projection.
 */
export type ToolFlags = {
  readonly key: string;
  readonly name: string;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly scope: string;
  readonly ioCapability?: string;
  readonly requiresSandbox: boolean;
  readonly requireJustification: boolean;
  readonly operativeArgs?: ReadonlyArray<RegistryOperativeArg>;
};

/** The {@link ToolFlags} of one manifest row. */
export function projectToolFlags(entry: RegistryEntry): ToolFlags {
  return {
    key: entry.key,
    name: entry.name,
    readOnly: entry.readOnly,
    destructive: entry.destructive,
    scope: entry.scope,
    ...(entry.ioCapability !== undefined ? { ioCapability: entry.ioCapability } : {}),
    requiresSandbox: entry.requiresSandbox,
    requireJustification: entry.requireJustification,
    ...(entry.operativeArgs !== undefined ? { operativeArgs: entry.operativeArgs } : {}),
  };
}
