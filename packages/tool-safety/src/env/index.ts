/**
 * `@crewhaus/tool-safety/env` — credential and environment discipline for
 * tools that read a secret out of the environment or report on it.
 *
 * - {@link resolveCredentialEnv}: read a credential only from a variable
 *   the operator listed in tool_config; the model may choose among the
 *   listed names and never add one.
 * - {@link checkEnvReveal}: whether a variable's VALUE may be shown; never
 *   for a credential-shaped name, listed or not.
 * - {@link isCredentialShapedName} / {@link credentialShapeOf}: the one
 *   heuristic for "this name holds a credential".
 * - {@link looksLikePastedSecret}: a "variable name" that is really a token,
 *   and must not be quoted back.
 * - {@link redactKnownSecrets} / {@link createSecretRedactor} /
 *   {@link redactKnownSecretsDeep}: known secret values out of text and
 *   results, in their encoded spellings too.
 * - {@link redactUrlCredentials} / {@link redactUrlCredentialsInText}:
 *   userinfo and credential-named parameters out of URLs.
 */
export {
  type CredentialEnvOptions,
  type CredentialEnvRefusal,
  type CredentialEnvResult,
  type EnvRevealDecision,
  type EnvRevealOptions,
  checkEnvReveal,
  resolveCredentialEnv,
} from "./credential";
export {
  ENV_NAME_RE,
  MAX_ENV_NAME_LENGTH,
  credentialShapeOf,
  isCredentialShapedName,
  isEnvName,
  looksLikePastedSecret,
  nameWords,
} from "./names";
export {
  REDACTED,
  REDACTED_URL_PART,
  type RedactOptions,
  createSecretRedactor,
  isCredentialParam,
  redactKnownSecrets,
  redactKnownSecretsDeep,
  redactUrlCredentials,
  redactUrlCredentialsInText,
  secretForms,
} from "./redact";
