/**
 * Anthropic credential resolution. Moved verbatim from
 * `runtime-core/src/index.ts:155-165` (Section 17 refactor).
 *
 * Precedence: ANTHROPIC_AUTH_TOKEN > ANTHROPIC_API_KEY > none. Tokens
 * prefixed with `sk-ant-oat` are treated as OAuth (Claude Pro/Max
 * subscription routing); everything else is an API key.
 */

export type ResolvedAuth =
  | { readonly mode: "oauth"; readonly token: string }
  | { readonly mode: "api-key"; readonly token: string }
  | { readonly mode: "none" };

export function resolveAuth(env: NodeJS.ProcessEnv = process.env): ResolvedAuth {
  const authToken = env["ANTHROPIC_AUTH_TOKEN"];
  if (authToken) {
    return authToken.startsWith("sk-ant-oat")
      ? { mode: "oauth", token: authToken }
      : { mode: "api-key", token: authToken };
  }
  const apiKey = env["ANTHROPIC_API_KEY"];
  if (apiKey) return { mode: "api-key", token: apiKey };
  return { mode: "none" };
}
