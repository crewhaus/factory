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
  /** For a `path` declared `within` a field: the directory the tool uses when the call leaves that field out. */
  readonly withinDefault?: string;
  /** For an `id` or `recipient`: the field holding the URL of the API a call may name instead of the tool's own. */
  readonly service?: string;
  /** For an `id` or `recipient`: the field naming whose own copy of the value a call acts on (a tenant's overlay). */
  readonly overlay?: string;
  /** Another field that, when a call names it, makes the tool ignore this one: read by a deny or ask only. */
  readonly ignoredWhen?: string;
  /** The field only moves the tool; its default is read by a deny or ask. */
  readonly relocates?: true;
  /** For a `command`: the field holding the environment its call sets. */
  readonly env?: string;
  /** For a `command`: the field holding the text its call hands it on standard input. */
  readonly stdin?: string;
  /** The value is a prefix: it stands for every value that starts with it. */
  readonly prefix?: true;
  /** For a `path`: the tool also acts beneath a directory it names (`all` or `visible`). */
  readonly beneath?: string;
  /** With `beneath: "visible"`: the boolean field that makes the walk open hidden names too. */
  readonly hiddenWhen?: string;
  /** With `beneath`: the boolean field without which the tool acts on the path alone. */
  readonly beneathWhen?: string;
  /** For a `path`: the fixed places inside the directory the tool opens, which a deny or ask reads. */
  readonly opens?: ReadonlyArray<{ readonly path: string; readonly beneath?: string }>;
  /** For a `path` declared `within` a field: its default is read from the workspace root. */
  readonly defaultAtRoot?: true;
  /** For a `path`: the value is a pattern that stands for every path it lists. */
  readonly glob?: true;
  /** For a `command`: a shell parses it, so a rule reads each simple command in it. */
  readonly shell?: true;
  /** For an `id`: a secret reference, whose `file:` and `envfile:` forms name a workspace file. */
  readonly secretRef?: true;
  /** Where the tool takes a value from: a deny or ask reads it, an allow need not. */
  readonly source?: true;
  /** For a `path`: the tool only reads it (the runtime-state floor leaves it out); every rule still reads it. */
  readonly reads?: true;
  /** For a `path`: the top-level field whose presence makes the tool only read this one. */
  readonly readsWhen?: string;
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
  /**
   * The leaf category that owns the tool first, then every roll-up that
   * reaches it, alphabetically — so `categories[0]` is the narrowest
   * `all-<category>` grant that includes it.
   */
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
    ...(arg.withinDefault !== undefined ? { withinDefault: arg.withinDefault } : {}),
    ...(arg.service !== undefined ? { service: arg.service } : {}),
    ...(arg.overlay !== undefined ? { overlay: arg.overlay } : {}),
    ...(arg.ignoredWhen !== undefined ? { ignoredWhen: arg.ignoredWhen } : {}),
    ...(arg.relocates === true ? { relocates: true as const } : {}),
    ...(arg.env !== undefined ? { env: arg.env } : {}),
    ...(arg.stdin !== undefined ? { stdin: arg.stdin } : {}),
    ...(arg.prefix === true ? { prefix: true as const } : {}),
    ...(arg.beneath !== undefined ? { beneath: arg.beneath } : {}),
    ...(arg.hiddenWhen !== undefined ? { hiddenWhen: arg.hiddenWhen } : {}),
    ...(arg.beneathWhen !== undefined ? { beneathWhen: arg.beneathWhen } : {}),
    ...(arg.opens !== undefined
      ? {
          opens: arg.opens.map((o) => ({
            path: o.path,
            ...(o.beneath !== undefined ? { beneath: o.beneath } : {}),
          })),
        }
      : {}),
    ...(arg.defaultAtRoot === true ? { defaultAtRoot: true as const } : {}),
    ...(arg.glob === true ? { glob: true as const } : {}),
    ...(arg.shell === true ? { shell: true as const } : {}),
    ...(arg.secretRef === true ? { secretRef: true as const } : {}),
    ...(arg.source === true ? { source: true as const } : {}),
    ...(arg.reads === true ? { reads: true as const } : {}),
    ...(arg.readsWhen !== undefined ? { readsWhen: arg.readsWhen } : {}),
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
