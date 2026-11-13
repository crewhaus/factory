/**
 * CLI twins: the exact command that does what an operation does, from a closed
 * vocabulary, never manufactured. A template's `argv` starts at the noun; a flag
 * is a `--flag {param}` pair. `renderTwin` fills a template in and `parseTwin` maps
 * a command line back to its params, so one type serves both directions.
 */
import { OPERATOR_SUPERSEDE_REASONS } from "./areas/core.js";
import type { CliTwin } from "./areas/types.js";
import { APPROVAL_ID_RE, DEPLOYMENT_ID_RE, HARNESS_ID_RE } from "./ids.js";
import { deepFreeze } from "./util.js";

export type { CliTwin } from "./areas/types.js";

/** Only the verbs a twin uses. */
export const CLI_VERBS = deepFreeze({
  harness: ["list", "show"],
  daemon: ["start", "stop", "restart", "drain"],
  approvals: ["show", "grant", "deny", "supersede", "rules", "revoke"],
  deploy: ["activate", "list"],
  people: [
    "init",
    "keys",
    "list",
    "add",
    "show",
    "note",
    "edit",
    "review",
    "export",
    "activity",
    "erase",
  ],
} as const);

/**
 * What each placeholder accepts.
 *
 * `{hrn}` is a harness id, never a slug. `{dir}` is a directory D whose
 * `D/.crewhaus/sessions` holds the decision, so a moved session root shows no twin.
 * It is non-empty, has no control character and no leading `-`, so it can never
 * read as a flag. `{psn}` and `{pcl}` are a profile's and a note's ids, `{kind}` a
 * profile kind, `{area}` a note's area and `{verdict}` a review that needs no
 * further argument. `{supersedeReason}` is one of the reasons a person may give to
 * supersede a decision, and `{rule}` a standing rule's id.
 */
export const TWIN_PLACEHOLDERS = deepFreeze({
  "{hrn}": HARNESS_ID_RE,
  "{appr}": APPROVAL_ID_RE,
  "{choice}": /^(?:grant|deny)$/,
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  "{dir}": /^[^\x00-\x1f\x7f-][^\x00-\x1f\x7f]*$/,
  "{dep}": DEPLOYMENT_ID_RE,
  "{psn}": /^psn_[0-9a-hjkmnp-tv-z]{26}$/,
  "{pcl}": /^pcl_[0-9a-hjkmnp-tv-z]{26}$/,
  "{kind}": /^(?:personal|audience|synthetic)$/,
  "{area}": /^[a-z][a-z0-9-]{0,39}$/,
  "{verdict}": /^(?:keep|reject|reopen)$/,
  "{supersedeReason}": new RegExp(`^(?:${OPERATOR_SUPERSEDE_REASONS.join("|")})$`),
  "{rule}": /^rule_[0-9a-hjkmnp-tv-z]{26}$/,
});

export type TwinParams = Readonly<Record<string, string>>;

export type RenderedTwin =
  | { readonly argv: readonly string[] }
  | { readonly missing: readonly string[] }
  | { readonly invalid: readonly string[] };

function placeholderName(token: string): string | null {
  return Object.hasOwn(TWIN_PLACEHOLDERS, token) ? token.slice(1, -1) : null;
}

function fits(token: string, value: unknown): boolean {
  const grammar = (TWIN_PLACEHOLDERS as Readonly<Record<string, RegExp>>)[token];
  return typeof value === "string" && grammar !== undefined && grammar.test(value);
}

/** Fill a template in. It reports what is missing or invalid; it never throws. */
export function renderTwin(twin: CliTwin, params: TwinParams): RenderedTwin {
  // No template renders to no command, never to a bare `crewhaus`.
  if (!Array.isArray(twin?.argv)) return { invalid: ["twin"] };
  const argv: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const token of twin.argv) {
    const name = placeholderName(token);
    if (name === null) {
      argv.push(token);
    } else if (!Object.hasOwn(params ?? {}, name) || params[name] === undefined) {
      missing.push(name);
    } else if (fits(token, params[name])) {
      argv.push(params[name] as string);
    } else {
      invalid.push(name);
    }
  }
  if (missing.length > 0) return { missing };
  if (invalid.length > 0) return { invalid };
  return { argv };
}

/**
 * Map a command line, as the CLI sees it after `crewhaus`, back to the params.
 * Positionals match in order; flag pairs match in any order. An unknown or
 * repeated flag, a wrong count or a value that does not fit answers `null`.
 */
export function parseTwin(twin: CliTwin, argv: readonly string[]): { params: TwinParams } | null {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  if (!Array.isArray(twin?.argv)) return null;
  const template: readonly string[] = twin.argv;
  for (let i = 0; i < template.length; i++) {
    const token = template[i] as string;
    if (token.startsWith("--")) {
      flags.set(token, template[i + 1] as string);
      i++;
    } else {
      positionals.push(token);
    }
  }

  const params: Record<string, string> = {};
  const seen = new Set<string>();
  let position = 0;
  const take = (token: string, value: string): boolean => {
    const name = placeholderName(token);
    if (name === null) return token === value;
    if (!fits(token, value)) return false;
    params[name] = value;
    return true;
  };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (typeof value !== "string") return null;
    if (value.startsWith("--")) {
      const token = flags.get(value);
      if (token === undefined || seen.has(value)) return null;
      seen.add(value);
      i++;
      const flagValue = argv[i];
      if (typeof flagValue !== "string" || !take(token, flagValue)) return null;
    } else {
      const token = positionals[position++];
      if (token === undefined || !take(token, value)) return null;
    }
  }
  if (position !== positionals.length || seen.size !== flags.size) return null;
  return { params };
}
