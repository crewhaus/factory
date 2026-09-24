import { credentialShapeOf, isEnvName, looksLikePastedSecret } from "./names";

/**
 * Which environment variables a tool may read as a credential, and who
 * decides.
 *
 * The defect, in seven packages: a tool input names an environment
 * variable (`auth.envVar`, `tokenEnv`, `keyEnvVar`, `secretEnvVar`) and the
 * tool reads `process.env[name]` for ANY name. The model — or whatever
 * injected text steers it — can then send `ANTHROPIC_API_KEY` as a bearer
 * token to an allow-listed origin, sign a forged JWT with the app's signing
 * secret, or override the operator's `token_env` (config-delivery#4,
 * flag-truth-3#1, flag-truth-4#2, flag-truth-2#0, security-8#4,
 * security-10#8, flag-truth-5#11, security-8#20). The egress classifier
 * sees only the variable's NAME, so it cannot help.
 *
 * The rule: the operator lists the names in tool_config; the model may
 * pick among them and nothing else. A name that is not listed is refused
 * with the same message whether or not the variable is set, so the call
 * is not an existence oracle either.
 */

export type CredentialEnvOptions = {
  /**
   * The operator's allow-list, from tool_config: the ONLY names this call
   * may read. Tool input must never add to it. Entries that are not legal
   * variable names are ignored.
   */
  readonly allowed: ReadonlyArray<string>;
  /** What the credential is for, as a noun phrase: "the HttpRequest auth profile". */
  readonly purpose: string;
  /** The tool_config key an operator edits to allow a name: "tool_config.http.auth_envs". */
  readonly configKey: string;
  /** The environment read (default `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
};

export type CredentialEnvRefusal = {
  readonly ok: false;
  /**
   * `missing-name`: no name given. `invalid-name`: not a variable name, or
   * a pasted secret (never quoted back). `not-allowed`: a name the operator
   * did not list. `unset`: listed, but unset or empty.
   */
  readonly code: "missing-name" | "invalid-name" | "not-allowed" | "unset";
  /** One sentence for the model and the operator, naming the config key to set. */
  readonly reason: string;
};

export type CredentialEnvResult =
  | { readonly ok: true; readonly name: string; readonly value: string }
  | CredentialEnvRefusal;

/** How many allowed names a refusal lists before it says "and N more". */
const LISTED = 10;

function allowedNames(allowed: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  for (const name of allowed) if (isEnvName(name) && !out.includes(name)) out.push(name);
  return out;
}

function describeAllowed(names: readonly string[], configKey: string): string {
  if (names.length === 0) return `${configKey} lists no variables, so none can be used`;
  const shown = names.slice(0, LISTED).map((n) => JSON.stringify(n));
  const more = names.length > LISTED ? ` and ${names.length - LISTED} more` : "";
  return `${configKey} allows ${shown.join(", ")}${more}`;
}

function read(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  // Strings only: `constructor`, `toString` and `__proto__` are legal names
  // that read the prototype's function or object. Inherited strings still
  // count, so an overlay made with `Object.create(process.env)` works.
  const value = env[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * Read the credential in environment variable `name`, if and only if the
 * operator listed exactly that name in `allowed`.
 *
 * Refusals never contain a variable's value, never quote a `name` that
 * looks like a pasted secret, and say which tool_config key to set. The
 * refusal for an unlisted name is identical whether the variable is set or
 * not.
 */
export function resolveCredentialEnv(
  name: string | undefined,
  options: CredentialEnvOptions,
): CredentialEnvResult {
  const { purpose, configKey } = options;
  const names = allowedNames(options.allowed);
  const allowedText = describeAllowed(names, configKey);
  if (name === undefined || name === "") {
    return {
      ok: false,
      code: "missing-name",
      reason: `${purpose} needs the NAME of an environment variable that holds the credential; ${allowedText}. The credential itself is never accepted as an argument`,
    };
  }
  if (!isEnvName(name)) {
    return {
      ok: false,
      code: "invalid-name",
      // Not quoted: a value that is not a name is most often the secret itself.
      reason: `${purpose} must name an environment variable (letters, digits and underscores, such as API_TOKEN), not carry the credential. The value given is not a variable name and has not been echoed back; if it was a secret, treat it as exposed. ${allowedText}`,
    };
  }
  if (!names.includes(name)) {
    if (looksLikePastedSecret(name)) {
      return {
        ok: false,
        code: "invalid-name",
        reason: `${purpose} was given what looks like a credential, not the name of a variable; it has not been echoed back, and if it is a secret, treat it as exposed. ${allowedText}`,
      };
    }
    return {
      ok: false,
      code: "not-allowed",
      reason: `${purpose} may only read an environment variable listed in ${configKey}, and ${JSON.stringify(name)} is not listed; ${allowedText}. A tool call cannot add a name: an operator allows one by adding ${JSON.stringify(name)} to ${configKey}`,
    };
  }
  const env = options.env ?? process.env;
  const value = read(env, name);
  if (value === undefined || value === "") {
    return {
      ok: false,
      code: "unset",
      reason: `${purpose} uses ${JSON.stringify(name)}, which ${configKey} allows, but it is unset or empty in this process`,
    };
  }
  return { ok: true, name, value };
}

export type EnvRevealOptions = {
  /** The operator's list of variables whose values may be shown, from tool_config. */
  readonly allowed: ReadonlyArray<string>;
  /** The tool_config key that holds that list: "tool_config.proc.env_reveal". */
  readonly configKey: string;
};

export type EnvRevealDecision =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** `credential-shaped` wins over the list: such a name is never shown, even when listed. */
      readonly code: "invalid-name" | "credential-shaped" | "not-allowed";
      readonly reason: string;
    };

/**
 * Whether a tool that reports on environment variables (EnvInspect) may
 * show `name`'s VALUE. Only when the operator listed the name, and never
 * when the name looks like a credential, listed or not: presence and
 * length are all a model learns about `ANTHROPIC_API_KEY`.
 */
export function checkEnvReveal(name: string, options: EnvRevealOptions): EnvRevealDecision {
  if (!isEnvName(name)) {
    return {
      ok: false,
      code: "invalid-name",
      reason: "the value given is not an environment variable name, so nothing is shown",
    };
  }
  const shape = credentialShapeOf(name);
  if (shape !== undefined) {
    return {
      ok: false,
      code: "credential-shaped",
      reason: `${JSON.stringify(name)} looks like it holds a credential (${shape}), so its value is never shown, whatever ${options.configKey} says; only whether it is set and its length are reported`,
    };
  }
  if (!allowedNames(options.allowed).includes(name)) {
    return {
      ok: false,
      code: "not-allowed",
      reason: `the value of ${JSON.stringify(name)} is shown only if an operator adds it to ${options.configKey}; only whether it is set and its length are reported`,
    };
  }
  return { ok: true };
}
