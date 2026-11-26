/**
 * `@crewhaus/tool-codehost/credentials`: where a caller outside the tools gets a code host
 * token, and the check a code host's origin passes before anything dials it.
 *
 * - {@link CredentialProvider} answers a token for one origin and repository, or
 *   `credential_unavailable` saying what to set. {@link tokenEnvProvider} reads the
 *   environment variable a spec names (`tool_config.codehost.token_env`); the variable's
 *   NAME is configuration, its value never is.
 * - {@link assertCodehostOrigin} is the tools' own SSRF check (`assertNotSsrf`): an
 *   `https:` origin with no userinfo that does not resolve to a private address. A
 *   loopback origin, `http:` included, is admitted only when the caller passes
 *   `allowLoopback` because the spec declared that host private; RFC1918, link-local and
 *   CGNAT addresses are refused whatever it says.
 */
import { assertNotSsrf, canonicalizeOrigin } from "./net";

export type CredentialAnswer =
  | { readonly ok: true; readonly token: string; readonly expiresAt?: string }
  | {
      readonly ok: false;
      readonly code: "credential_unavailable";
      readonly message: string;
    };

/** A token for `origin` (the API origin) and `repo` (`owner/name`). */
export type CredentialProvider = (query: {
  readonly origin: string;
  readonly repo: string;
}) => Promise<CredentialAnswer>;

/** Where a spec names the variable that holds the token. Every refusal names it. */
export const TOKEN_ENV_KEY = "tool_config.codehost.token_env";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * The default provider: the value of the variable `tokenEnv` names, read from `env` (a
 * harness's own environment, or the files its daemon is started with). An absent name, a
 * name that is not one, and an empty value each answer `credential_unavailable`, naming
 * the key and never a value.
 */
export function tokenEnvProvider(opts: {
  readonly tokenEnv: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}): CredentialProvider {
  return async () => {
    const name = opts.tokenEnv;
    if (name === undefined || name === "") {
      return {
        ok: false,
        code: "credential_unavailable",
        message: `No code host token is configured: set ${TOKEN_ENV_KEY} to the name of the environment variable that holds it.`,
      };
    }
    if (!ENV_NAME_RE.test(name)) {
      return {
        ok: false,
        code: "credential_unavailable",
        message: `${TOKEN_ENV_KEY} names an environment variable, written without a $; it is not one.`,
      };
    }
    const value = opts.env[name];
    if (value === undefined || value.trim() === "") {
      return {
        ok: false,
        code: "credential_unavailable",
        message: `The variable ${TOKEN_ENV_KEY} names (${name}) is not set for this harness.`,
      };
    }
    return { ok: true, token: value.trim() };
  };
}

/** A code host origin that may be dialled: its canonical form and whether it is a loopback one. */
export type CheckedOrigin = { readonly origin: string; readonly loopback: boolean };

/** Why an origin is refused. */
export class CodehostOriginError extends Error {
  override readonly name = "CodehostOriginError";
}

const LOOPBACK_NAME_RE = /^(?:localhost|[^.]+\.localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/**
 * Check a code host origin before git or an API request is pointed at it. Throws
 * {@link CodehostOriginError} naming what is wrong; never dials the host itself.
 */
export async function assertCodehostOrigin(
  raw: string | URL,
  opts: { readonly allowLoopback?: boolean; readonly signal?: AbortSignal } = {},
): Promise<CheckedOrigin> {
  let url: URL;
  try {
    url = typeof raw === "string" ? new URL(raw) : raw;
  } catch {
    throw new CodehostOriginError(
      "A code host origin is an absolute URL, such as https://github.com.",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new CodehostOriginError("A code host origin carries no user or password.");
  }
  if (url.search !== "" || url.hash !== "" || (url.pathname !== "/" && url.pathname !== "")) {
    throw new CodehostOriginError("A code host origin is a scheme, a host and a port only.");
  }
  const loopbackName = LOOPBACK_NAME_RE.test(url.hostname);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && opts.allowLoopback === true && loopbackName)
  ) {
    throw new CodehostOriginError(
      url.protocol === "http:"
        ? "A code host is reached over https; http is for a loopback host the spec declares private."
        : `A code host is reached over https, not ${url.protocol}.`,
    );
  }
  try {
    await assertNotSsrf(url.hostname, opts.signal, undefined, opts.allowLoopback === true);
  } catch (err) {
    throw new CodehostOriginError(
      opts.allowLoopback === true
        ? `${(err as Error).message}; only a loopback host may be declared private.`
        : `${(err as Error).message}; a private host needs allow_private_target on its binding, and only a loopback one is admitted.`,
    );
  }
  return { origin: canonicalizeOrigin(url.toString()), loopback: loopbackName };
}
