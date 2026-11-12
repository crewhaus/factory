/**
 * The grammar of every id that crosses a surface, and the minter of each new
 * one. Everywhere else an id is opaque: read it with `parseId` or `isId`, never
 * by its length, and never decode a time from it.
 */
import { MODULES, type ModuleField } from "./areas/index.js";
import type { IdGrammar, IdGrammarDecl } from "./areas/types.js";
import { type MintUlidOptions, mintUlid } from "./ulid.js";
import { deepFreeze } from "./util.js";

/** One Crockford character class, 26 times: a ULID body or a digest body. */
const CROCKFORD_26 = "[0-9a-hjkmnp-tv-z]{26}";
const HEX_16 = "[0-9a-f]{16}";

/** A session id's shape, unanchored, for building file-name grammars. */
export const SESSION_ID_PATTERN = `sess_${HEX_16}`;
/** A tool approval's id shape, unanchored. */
export const APPROVAL_ID_PATTERN = `appr_${HEX_16}`;

export const SESSION_ID_RE = /^sess_[0-9a-f]{16}$/;
export const APPROVAL_ID_RE = /^appr_[0-9a-f]{16}$/;
export const HARNESS_ID_RE = /^hrn_[0-9a-f]{16}$/;
/**
 * `run_<16 hex>`: an execution, an eval run, a research run or a job log. The
 * grammar alone never says which. See `classifyRunId`.
 */
export const EXECUTION_RUN_ID_RE = /^run_[0-9a-f]{16}$/;
export const GRAPH_RUN_ID_RE = /^grun_[0-9a-f]{16}$/;
/** A run id from `mintRunId()`. */
export const CANONICAL_RUN_ID_RE = /^run_[0-9a-hjkmnp-tv-z]{26}$/;
/** A deployment id, `dep_<ulid>`: the grammar `isId("dep", …)` accepts. */
export const DEPLOYMENT_ID_RE = /^dep_[0-9a-hjkmnp-tv-z]{26}$/;

/**
 * Issued secrets, as grammars only. Nothing here mints, stores or masks one:
 * `cha_` a session, `chp_` a personal token, `chs_` a service token, `chi_` an
 * invite code, `chx_` a scoped browser token.
 */
export const ISSUED_SECRET_RES = deepFreeze({
  session: /^cha_[A-Za-z0-9_-]{43}$/,
  personal: /^chp_[A-Za-z0-9_-]{43}$/,
  service: /^chs_[A-Za-z0-9_-]{43}$/,
  invite: /^chi_[A-Za-z0-9_-]{43}$/,
  scoped: /^chx_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
});

const GRAMMAR_BODY: Readonly<Record<IdGrammar, RegExp>> = deepFreeze({
  ulid: new RegExp(`^${CROCKFORD_26}$`),
  digest: new RegExp(`^${CROCKFORD_26}$`),
  hex16: new RegExp(`^${HEX_16}$`),
});

/** Every id form the composed modules declare. */
export const ID_GRAMMARS: readonly IdGrammarDecl[] = deepFreeze(
  MODULES.flatMap((module) => module.grammars ?? []),
);

type GrammarRow = ModuleField<"grammars"> extends readonly (infer Row)[] ? Row : never;

export type IdPrefix = GrammarRow extends { readonly prefix: infer P } ? P : never;

/** The prefixes `mintId` can mint: every `<prefix>_<ulid>` form. */
export type UlidPrefix = Extract<GrammarRow, { readonly grammar: "ulid" }>["prefix"];

/** The prefixes minted as ULIDs. */
export const ULID_PREFIXES: readonly UlidPrefix[] = deepFreeze(
  ID_GRAMMARS.filter((decl) => decl.grammar === "ulid").map((decl) => decl.prefix as UlidPrefix),
);

const GRAMMARS_BY_PREFIX: ReadonlyMap<string, readonly IdGrammar[]> = (() => {
  const map = new Map<string, IdGrammar[]>();
  for (const decl of ID_GRAMMARS) {
    const list = map.get(decl.prefix);
    if (list === undefined) map.set(decl.prefix, [decl.grammar]);
    else list.push(decl.grammar);
  }
  return map;
})();

export type ParsedId = {
  readonly prefix: string;
  readonly body: string;
  readonly grammar: IdGrammar;
};

/** Split an id into its parts, or `null` when no declared grammar fits it. */
export function parseId(id: unknown): ParsedId | null {
  if (typeof id !== "string") return null;
  const separator = id.indexOf("_");
  if (separator < 1) return null;
  const prefix = id.slice(0, separator);
  const body = id.slice(separator + 1);
  for (const grammar of GRAMMARS_BY_PREFIX.get(prefix) ?? []) {
    if (GRAMMAR_BODY[grammar].test(body)) return { prefix, body, grammar };
  }
  return null;
}

/** Whether `id` is a well-formed id with this prefix. */
export function isId(prefix: string, id: unknown): boolean {
  return parseId(id)?.prefix === prefix;
}

/** The id `parseId` split. */
export function formatId(parts: { readonly prefix: string; readonly body: string }): string {
  return `${parts.prefix}_${parts.body}`;
}

/** Mint `<prefix>_<ulid>`. A prefix with no ULID form throws. */
export function mintId(prefix: UlidPrefix, opts?: MintUlidOptions): string {
  if (!(ULID_PREFIXES as readonly string[]).includes(prefix)) {
    throw new TypeError(`control-contract: "${String(prefix)}" has no ULID form to mint`);
  }
  return `${prefix}_${mintUlid(opts)}`;
}

/** Mint a canonical run id. */
export function mintRunId(opts?: MintUlidOptions): string {
  return mintId("run", opts);
}
