/**
 * What one area declares. A module is static data with no imports beyond this
 * package, so `@crewhaus/client` can bundle every area's operations.
 */

export type IdGrammar = "ulid" | "hex16" | "digest";

/** One id form: `<prefix>_<body>`, with the body's grammar. */
export type IdGrammarDecl = {
  readonly prefix: string;
  readonly grammar: IdGrammar;
};

/** Where a ref of some kind can live. */
export type RefScopeRule = "home" | "harness" | "either";

/**
 * What a ref of some kind may name: an id form, a legacy run family that
 * `classifyRunId` recognises, or an opaque segment shape.
 */
export type RefIdDecl =
  | IdGrammarDecl
  | { readonly family: "hex8" | "base36" }
  | { readonly pattern: string };

export type RefKindDecl = {
  readonly kind: string;
  readonly scope: RefScopeRule;
  readonly ids: readonly RefIdDecl[];
};

export type EventSensitivity = "internal" | "restricted" | "people";

export type EventFamilyDecl = {
  readonly family: string;
  readonly types: readonly {
    readonly type: string;
    readonly sensitivity: EventSensitivity;
  }[];
};

/** One object's lifecycle. `transitions` and `recoveryOwner` are total over `states`. */
export type MachineDef = {
  readonly states: readonly string[];
  readonly entry: readonly string[];
  readonly terminal: readonly string[];
  readonly transitions: Readonly<Record<string, readonly string[]>>;
  readonly recoveryOwner: Readonly<Record<string, string>>;
};

export type Role = "viewer" | "operator" | "maintainer" | "owner";

export type PermissionDecl = {
  readonly id: string;
  readonly scope: "home" | "harness";
  /** The lowest role that holds it, or `none` when no role implies it. */
  readonly floor: Role | "none";
  /** Whether a service principal may be granted it. */
  readonly service: "grantable" | "never";
};

/** `argv` starts at the noun, without the binary: what the CLI sees after `crewhaus`. */
export type CliTwin = { readonly argv: readonly string[] };

export type CommandKindDecl = {
  readonly id: string;
  readonly permission: string;
  /** Whether repeating the command after an unknown outcome is safe. */
  readonly idempotent: boolean;
  readonly effect: "local" | "external";
  readonly cliTwin: CliTwin | null;
};

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type Qualifier =
  | "filtered"
  | "content-fields"
  | "class"
  | "maintainer-or-above"
  | "subject-assert"
  | "creating-service"
  | "human-only"
  | "self"
  | "service-delegation"
  | "view-target"
  | "workspace-target";

export type ReceiptMode = "none" | "harness" | "workspace";

export type IdempotencyMode = "none" | "accepted" | "required-for-services" | "required";

/**
 * How one free-text request field reaches a model: through a classifying
 * boundary at a named origin, or not at all, with the reason.
 */
export type ModelBoundDecl =
  | { readonly origin: string; readonly at: "write" | "run-entry" }
  | { readonly none: true; readonly reason: string };

export type OperationRow = {
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: string;
  /** A permission id, `public` or `authenticated`. */
  readonly permission: string;
  readonly receipt: ReceiptMode;
  /** An id in `SCHEMAS`. */
  readonly request: string;
  /** An id in `SCHEMAS`. */
  readonly response: string;
  readonly cliTwin: CliTwin | null;
  readonly qualifiers: readonly Qualifier[];
  readonly noReceiptReason?: string;
  readonly idempotency: IdempotencyMode;
  readonly stream?: "sse";
  /** Request fields that hold a secret; a receipt's fingerprint never hashes them. */
  readonly secretFields?: readonly string[];
  readonly noTwinReason?: string;
  readonly modelBound?: Readonly<Record<string, ModelBoundDecl>>;
};

export type AreaModule = {
  readonly area: string;
  readonly operations: readonly OperationRow[];
  readonly refKinds: readonly RefKindDecl[];
  readonly eventFamilies: readonly EventFamilyDecl[];
  readonly machines: Readonly<Record<string, MachineDef>>;
  readonly commandKinds: readonly CommandKindDecl[];
  readonly permissions: readonly PermissionDecl[];
  readonly scopedActs?: readonly string[];
  /** Closed reason lists, by the log event they qualify. */
  readonly reasonCodes?: Readonly<Record<string, readonly string[]>>;
  readonly capabilityKeys?: readonly string[];
  readonly grammars?: readonly IdGrammarDecl[];
  /** Paths the raw file browser never serves. Declared here; composed by its enforcer. */
  readonly rawExclusions?: readonly string[];
};
